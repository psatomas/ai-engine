import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderSessionRef, TaskRecord } from "@ai-engine/core";
import { TaskLock } from "@ai-engine/security";

function isValidProviderSessionRef(value: unknown): value is ProviderSessionRef {
  if (!value || typeof value !== "object") return false;
  const { providerId, sessionId } = value as { providerId?: unknown; sessionId?: unknown };
  return typeof providerId === "string" && providerId !== "" && typeof sessionId === "string" && sessionId !== "";
}

/**
 * `TaskRecord.providerSessions` used to be `Record<role, sessionId>` (a bare
 * string, with no record of which provider created it). A record written by
 * that older shape is tolerated, not trusted: since we cannot know which
 * provider actually created a bare-string session id, the only safe move is
 * to drop it — the next invocation of that role simply starts a fresh
 * session instead of resuming, rather than risking a resume handed to the
 * wrong provider. See ProviderSessionRef in @ai-engine/core. A record with no
 * usable map at all (missing, null, or not an object) is backfilled with an
 * empty one — no session is fabricated — so the next buildRequest doesn't
 * crash reading `providerSessions[role]`.
 *
 * An entry is a valid ProviderSessionRef only if `providerId` and `sessionId`
 * are both non-empty strings. Anything else is dropped as malformed — never
 * coerced into shape (a numeric session id, or an empty provider id, would
 * otherwise be handed to a provider CLI as if it were real).
 */
function normalizeProviderSessions(task: TaskRecord): TaskRecord {
  const sessions = task.providerSessions as unknown;
  if (!sessions || typeof sessions !== "object") return { ...task, providerSessions: {} };
  let sawLegacyEntry = false;
  const normalized: TaskRecord["providerSessions"] = {};
  for (const [role, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (isValidProviderSessionRef(value)) {
      normalized[role] = value;
    } else {
      sawLegacyEntry = true;
    }
  }
  return sawLegacyEntry ? { ...task, providerSessions: normalized } : task;
}

/** A record persisted before usage telemetry existed has no `usageEvents` at all — backfill an empty log rather than crash. No history is fabricated; the task simply has no recorded invocations before this field existed. */
function normalizeUsageEvents(task: TaskRecord): TaskRecord {
  return Array.isArray(task.usageEvents) ? task : { ...task, usageEvents: [] };
}

function normalizeLegacyTaskRecord(task: TaskRecord): TaskRecord {
  return normalizeUsageEvents(normalizeProviderSessions(task));
}

export class TaskRecordCorruptedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly path: string,
    cause: unknown
  ) {
    super(
      `Task "${taskId}"'s persisted record at ${path} is not valid JSON and could not be read. ` +
        `This should only happen after an external edit or a very unlucky crash predating atomic writes; ` +
        `inspect/repair the file by hand, or discard it if the task is not recoverable.`
    );
    this.name = "TaskRecordCorruptedError";
    this.cause = cause;
  }
}

/**
 * The global task store is the single source of truth for workflow state —
 * never chat history. One JSON file per task under the machine-wide data
 * directory, so a task survives the repository being deleted and re-cloned.
 *
 * Two independent safety properties, both load-bearing (see
 * docs/security.md#persistence--cross-process-safety):
 *
 *   1. Atomic writes: `save()` always writes to a unique temp file and
 *      `rename()`s it over the target. `rename` is atomic on every
 *      filesystem Node supports — a reader (`get()`) can only ever observe
 *      the complete old file or the complete new file, never a partial
 *      write, regardless of when the writing process is killed.
 *   2. Cross-process locking: `withLock()` wraps a whole read-modify-write
 *      cycle in an advisory file lock (`@ai-engine/security`'s TaskLock)
 *      keyed by task id. Unlike the in-memory queue this replaced, the lock
 *      lives on disk, so it protects against two *independent processes*
 *      (two `ai` invocations, or the CLI racing the VS Code extension)
 *      mutating the same task concurrently — not just two calls within one
 *      process.
 */
export class TaskStore {
  constructor(private readonly dir: string) {}

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private lockPathFor(id: string): string {
    return join(this.dir, ".locks", `${id}.lock`);
  }

  lockFor(id: string): TaskLock {
    return new TaskLock(this.lockPathFor(id));
  }

  /** Runs `fn` while holding the cross-process lock for `id`. Use this to wrap every read-modify-write cycle. */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(join(this.dir, ".locks"), { recursive: true });
    return this.lockFor(id).withLock(fn);
  }

  async save(task: TaskRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.pathFor(task.id);
    const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(task, null, 2), "utf8");
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let parsed: TaskRecord;
    try {
      parsed = JSON.parse(raw) as TaskRecord;
    } catch (err) {
      throw new TaskRecordCorruptedError(id, this.pathFor(id), err);
    }
    return normalizeLegacyTaskRecord(parsed);
  }

  async requireTask(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (!task) throw new Error(`Unknown task "${id}"`);
    return task;
  }

  async list(filter?: { repositoryRoot?: string }): Promise<TaskRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const tasks: TaskRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      let task: TaskRecord;
      try {
        task = await this.requireTask(id);
      } catch (err) {
        if (err instanceof TaskRecordCorruptedError) continue; // don't let one corrupt file break listing every task
        throw err;
      }
      if (!filter?.repositoryRoot || task.repository.root === filter.repositoryRoot) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
