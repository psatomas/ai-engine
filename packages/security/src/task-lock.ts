import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

/**
 * A small, dependency-free, cross-process advisory lock backed by exclusive
 * file *linking* (`link(tempPath, lockPath)` fails with EEXIST iff lockPath
 * already exists — atomic at the filesystem level on every platform Node
 * supports, same guarantee class as O_CREAT|O_EXCL). This is the primitive
 * TaskStore uses to make sure two independent `ai` invocations (or the CLI
 * and the VS Code extension) never concurrently mutate the same task — see
 * docs/security.md#cross-process-task-locking.
 *
 * CRITICAL FIX (found by an independent audit, reproduced with real
 * concurrent OS processes): the previous implementation created the lock
 * file with `open(path, "wx")` and then wrote its JSON content in a
 * *separate* subsequent step. Between those two steps, the file existed but
 * was empty — a concurrent process that got EEXIST and immediately called
 * `isStale()` would fail to parse that empty content, conclude the lock was
 * "unreadable/corrupt", delete it, and successfully create its own lock
 * while the true holder still believed it held the original one. Two
 * processes could then both be inside a "locked" critical section at once.
 *
 * The fix: write the full lock content to a private, uniquely-named temp
 * file first (no exclusivity needed there — the name is unique per
 * attempt), then atomically publish it at `lockPath` with a single `link()`
 * call. `link()` either creates `lockPath` fully populated in one step, or
 * fails outright (EEXIST) — there is no window where `lockPath` exists with
 * incomplete content, because the content was already complete before the
 * name was ever exposed at that path.
 *
 * That alone was still not sufficient — the *second*, more subtle bug this
 * fix also closes: the stale-lock reclamation path deleted `lockPath`
 * unconditionally once it judged the lock stale, with no check that the
 * file at that path was still the same one it had just judged. A process
 * could correctly determine generation N was stale, then — before its own
 * `rm()` ran — observe generation N being legitimately released and
 * generation N+1 (a brand new, valid lock from a third process) created in
 * its place, and delete *that* instead, letting both the N+1 holder and the
 * reclaiming process believe they held the lock simultaneously. The
 * reclaim path now mirrors `release()`: it only deletes `lockPath` if the
 * content there still matches the exact generation (`nonce`) it judged
 * stale. See task-lock.test.ts's "true concurrency" stress test, which
 * spawns real independent OS processes hammering the same lock and asserts
 * zero mutual-exclusion violations — this is the regression test for both
 * bugs; it reliably reproduced each one before its respective fix.
 */
export interface LockInfo {
  pid: number;
  host: string;
  acquiredAt: string;
  /** Random per-acquisition identity, so release() can tell two acquisitions apart even when they share a pid+host+millisecond (e.g. two locks taken back-to-back in one process). */
  nonce: string;
}

export class TaskLockedError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder?: LockInfo
  ) {
    super(
      holder
        ? `Task is locked by another process (pid ${holder.pid} on ${holder.host}, held since ${holder.acquiredAt}). Try again shortly, or check whether that process is still running.`
        : `Task is locked by another process. Try again shortly.`
    );
    this.name = "TaskLockedError";
  }
}

export interface TaskLockOptions {
  /** A held lock older than this (and whose owning process is no longer running, if on this host) is considered abandoned and stolen. Default 30 minutes — comfortably above the default single-invocation timeout. */
  staleMs?: number;
  /** How many times to retry acquisition before giving up. Default 5. */
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskLock {
  constructor(
    private readonly lockPath: string,
    private readonly opts: TaskLockOptions = {}
  ) {}

  /** Acquires the lock, returning a release function. Throws TaskLockedError if it cannot be acquired. */
  async acquire(): Promise<() => Promise<void>> {
    const retries = this.opts.retries ?? 5;
    const delay = this.opts.retryDelayMs ?? 200;
    await mkdir(dirname(this.lockPath), { recursive: true });

    for (let attempt = 0; attempt <= retries; attempt++) {
      const info: LockInfo = {
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        nonce: randomBytes(8).toString("hex")
      };
      // Unique per attempt — never contended, so no exclusivity is needed for this step itself.
      const tempPath = `${this.lockPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        await writeFile(tempPath, JSON.stringify(info), "utf8");
        // The one exclusive, atomic step: lockPath is created fully-populated or not at all.
        await link(tempPath, this.lockPath);
        return () => this.release(info);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        if (await this.reclaimIfStale()) {
          continue; // immediately retry acquisition now that the stale lock is gone
        }
        if (attempt === retries) {
          throw new TaskLockedError(this.lockPath, await this.readInfo());
        }
        await sleep(delay);
      } finally {
        // Whether link() succeeded (lockPath now holds a second reference to the same content —
        // removing this name doesn't touch it) or failed (nothing to clean up but this name),
        // the temp file itself is never needed again.
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
    throw new TaskLockedError(this.lockPath, await this.readInfo());
  }

  /** Runs `fn` while holding the lock, always releasing afterward. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async readInfo(): Promise<LockInfo | undefined> {
    try {
      return JSON.parse(await readFile(this.lockPath, "utf8")) as LockInfo;
    } catch {
      return undefined;
    }
  }

  /**
   * Judges whether the lock currently at `lockPath` is stale (abandoned),
   * and — only if so — reclaims it by deleting it, guarded so it can never
   * delete a *different*, valid generation that appeared after the
   * judgment was made (see the class doc comment). Returns whether a
   * reclaim happened (i.e. whether the caller should retry acquisition).
   */
  private async reclaimIfStale(): Promise<boolean> {
    const staleMs = this.opts.staleMs ?? 30 * 60 * 1000;

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.lockPath)).mtimeMs;
    } catch {
      return true; // lock file already vanished — nothing to guard, caller just retries
    }

    const info = await this.readInfo();
    if (!info) {
      // Unreadable/corrupt content. With content always fully written before lockPath is
      // published (see acquire()), this should only happen if the file vanished between stat()
      // and readFile() — again nothing identifiable to guard against clobbering.
      return true;
    }

    const stale =
      Date.now() - mtimeMs > staleMs || // abandoned by age
      (info.host === hostname() && (await this.isPidDead(info.pid))); // or: same host, holder process gone
    if (!stale) return false;

    // Guarded delete: only remove lockPath if it is still exactly the generation we just judged
    // stale (by nonce), so a fresh, valid lock a third process created in the meantime is never
    // clobbered — the same protection release() already gives its own lock.
    const current = await this.readInfo();
    if (!current || current.nonce === info.nonce) {
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
    return true;
  }

  private async isPidDead(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0); // signal 0: existence check, does not actually signal the process
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH"; // no such process -> the holder is gone
    }
  }

  private async release(ownInfo: LockInfo): Promise<void> {
    // Only remove the lock if it's still the exact one we created (guards against releasing a
    // lock someone else already stole from us after staleness — compared by nonce, not just
    // pid+host+timestamp, since two acquisitions in the same process can share all three).
    const current = await this.readInfo();
    if (current && current.nonce === ownInfo.nonce) {
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }
}
