import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskLock, TaskLockedError } from "./task-lock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STRESS_WORKER = join(__dirname, "test-support", "lock-stress-worker.mjs");

function runWorker(lockPath: string, counterPath: string, workerId: number, iterations: number, holdMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STRESS_WORKER, lockPath, counterPath, String(workerId), String(iterations), String(holdMs)], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${workerId} exited ${code}: ${stderr}`))));
    child.on("error", reject);
  });
}

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-engine-lock-"));
  lockPath = join(dir, "task-1.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TaskLock", () => {
  it("acquires and releases a lock with no contention", async () => {
    const lock = new TaskLock(lockPath);
    const release = await lock.acquire();
    await expect(stat(lockPath)).resolves.toBeTruthy();
    await release();
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("withLock releases even if the wrapped function throws", async () => {
    const lock = new TaskLock(lockPath);
    await expect(
      lock.withLock(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(stat(lockPath)).rejects.toThrow(); // released, not left behind
  });

  /**
   * The core cross-process claim: this uses two *independent* TaskLock
   * instances (no shared in-memory state at all — each constructs its own
   * object) pointed at the same file on disk. Because the mechanism is
   * `open(path, "wx")` (atomic exclusive file creation, enforced by the
   * filesystem/OS, not by any in-process bookkeeping), this is a faithful
   * simulation of two independent CLI processes racing on the same task —
   * the previous in-memory `Map`-based "queue" in TaskStore could not have
   * been tested this way at all, because it provided no protection between
   * two separate instances in the first place.
   */
  it("a second independent lock instance cannot acquire while the first holds it", async () => {
    const lockA = new TaskLock(lockPath, { retries: 1, retryDelayMs: 20 });
    const lockB = new TaskLock(lockPath, { retries: 1, retryDelayMs: 20 });

    const releaseA = await lockA.acquire();
    await expect(lockB.acquire()).rejects.toThrow(TaskLockedError);
    await releaseA();

    // Now that A released, B (a still-independent instance) can acquire.
    const releaseB = await lockB.acquire();
    await releaseB();
  });

  it("TaskLockedError reports the holder's pid when available", async () => {
    const lockA = new TaskLock(lockPath, { retries: 0 });
    const lockB = new TaskLock(lockPath, { retries: 0 });
    await lockA.acquire();
    try {
      await lockB.acquire();
      expect.unreachable("expected TaskLockedError");
    } catch (err) {
      expect(err).toBeInstanceOf(TaskLockedError);
      expect((err as TaskLockedError).holder?.pid).toBe(process.pid);
    }
  });

  it("steals a stale lock whose owning process is no longer running (fast path, no waiting on age)", async () => {
    await mkdir(dir, { recursive: true });
    // A lock file that is fresh (mtime just now) but claims a PID that (almost certainly) does
    // not exist — proves staleness detection isn't solely age-based.
    const deadPid = 999999;
    await writeFile(lockPath, JSON.stringify({ pid: deadPid, host: hostname(), acquiredAt: new Date().toISOString() }), "utf8");

    const lock = new TaskLock(lockPath, { staleMs: 60 * 60 * 1000 }); // 1h — would never expire by age alone
    const release = await lock.acquire();
    await release();
  });

  it("steals a lock that has simply expired by age, even with a live-looking pid on another host", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: "some-other-machine", acquiredAt: new Date(0).toISOString() }),
      "utf8"
    );
    const past = new Date(Date.now() - 1000);
    await utimes(lockPath, past, past);

    const lock = new TaskLock(lockPath, { staleMs: 10 }); // 10ms — the file is already older than that
    const release = await lock.acquire();
    await release();
  });

  it("does NOT steal a lock held by a live process on this host within the stale window", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }), "utf8");

    const lock = new TaskLock(lockPath, { staleMs: 60 * 60 * 1000, retries: 0 });
    await expect(lock.acquire()).rejects.toThrow(TaskLockedError);
  });

  it("release only removes the lock if it still belongs to the releaser (does not clobber a re-acquired lock)", async () => {
    const lockA = new TaskLock(lockPath, { staleMs: 1 }); // stale almost immediately
    const releaseA = await lockA.acquire();

    // Simulate time passing until A's lock looks stale, then someone else steals it.
    const past = new Date(Date.now() - 1000);
    await utimes(lockPath, past, past);
    const lockC = new TaskLock(lockPath, { staleMs: 1 });
    const releaseC = await lockC.acquire(); // steals A's now-stale lock

    // A's (now-outdated) release must NOT delete C's freshly-acquired lock.
    await releaseA();
    await expect(stat(lockPath)).resolves.toBeTruthy();

    await releaseC();
  });

  /**
   * Regression test for a CRITICAL bug found by an independent audit: two real, independent OS
   * processes (not just two objects in one process — this spawns actual `node` subprocesses, the
   * same way a second `ai` invocation or the VS Code extension would contend for a task) could
   * both end up believing they held the same lock simultaneously.
   *
   * Two distinct bugs combined to cause this, both now fixed:
   *   1. acquire() used to create the lock file and write its JSON content in two separate steps;
   *      a concurrent process observing the file mid-write saw it as empty/corrupt and wrongly
   *      concluded it was stale.
   *   2. Even after fixing (1), stale-lock reclamation deleted whatever was at the lock path
   *      unconditionally once judged stale, with no check that a third process hadn't already
   *      replaced it with a fresh, valid lock in the meantime.
   *
   * Neither bug reproduced with only two participants given any head start at all (which is what
   * every other test in this file uses) — both required many processes hammering the lock with no
   * head start whatsoever. This test does that: it must show zero mutual-exclusion violations
   * across real concurrent contention, not just "the API looks right."
   */
  it("true concurrency: many independent OS processes never simultaneously believe they hold the lock", async () => {
    const counterPath = join(dir, "counter.json");
    await writeFile(counterPath, JSON.stringify({ inside: 0, violations: 0 }));

    const workerCount = 8;
    const iterationsPerWorker = 15;
    const holdMs = 5;

    await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(lockPath, counterPath, i + 1, iterationsPerWorker, holdMs)));

    const finalCounter = JSON.parse(await readFile(counterPath, "utf8")) as { inside: number; violations: number };
    expect(finalCounter.violations).toBe(0);
    expect(finalCounter.inside).toBe(0); // every increment was matched by a decrement — no lost/duplicated critical sections
  }, 20_000);
});
