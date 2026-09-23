import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { resolveEnginePaths } from "@ai-engine/config";
import { GitRepository } from "@ai-engine/git";
import { TaskStore } from "./task-store.js";
import { generateTaskId, isSafeTaskId } from "./ids.js";
import { DECISION_ID_PATTERN, DECISION_OPTIONS, type DecisionOption } from "./pending-decision.js";
import {
  createOrchestrator,
  DecisionApplicationError,
  DirtyWorkingTreeError,
  requireCleanTaskTree,
  type Orchestrator
} from "./orchestrator.js";

export const MAX_SUBMISSION_REQUEST_BYTES = 16 * 1024;
/** Bound on a caller-supplied `checkId`: matches the identifier bound the pending-decision model already uses. */
export const MAX_CHECK_ID_CHARS = 200;

export type SubmissionErrorCode =
  | "INVALID_REQUEST"
  | "DIRTY_WORKING_TREE"
  | "DELEGATED_RUN_EXISTS"
  | "WORKER_LAUNCH_FAILED"
  | "TASK_NOT_FOUND"
  | "STALE_DECISION"
  | "ACTION_NOT_AVAILABLE"
  | "CHECK_ID_REQUIRED"
  | "CHECK_ID_INVALID"
  | "CHECK_ID_NOT_APPLICABLE"
  | "APPROVAL_WITHHELD";
export class SubmissionError extends Error {
  constructor(
    public readonly code: SubmissionErrorCode,
    public readonly counts?: { staged: number; tracked: number; untracked: number }
  ) {
    super(code);
    this.name = "SubmissionError";
  }
}
export type RunPhase = "CREATING" | "RUNNING" | "FINISHED" | "FAILED";
export interface SubmissionActivity {
  taskId: string;
  phase: RunPhase;
  worker: "starting" | "active" | "finished" | "stale" | "indeterminate";
  error?:
    | "DIRTY_WORKING_TREE"
    | "TASK_CREATION_FAILED"
    | "DECISION_APPLICATION_FAILED"
    | "EXECUTION_FAILED"
    | "WORKER_LAUNCH_FAILED"
    | "STALE_DECISION"
    | "ACTION_NOT_AVAILABLE"
    | "CHECK_ID_REQUIRED"
    | "CHECK_ID_INVALID"
    | "CHECK_ID_NOT_APPLICABLE";
}

/**
 * What a delegated run is FOR — an explicit, persisted discriminant the worker reads to decide what
 * to do, rather than guessing from which fields happen to be present. `"submission"` is the original
 * shape (a free-form request that becomes a brand-new task); `"continuation"` answers one existing
 * task's pending decision — see `Orchestrator.applyDecision` for exactly how `action`/`checkId` map
 * onto the real decision APIs.
 */
export type DelegatedIntent =
  { kind: "submission"; request: string } | { kind: "continuation"; decisionId: string; action: DecisionOption; checkId?: string };

interface RunRecord {
  taskId: string;
  repoRoot: string;
  nonce: string;
  intent: DelegatedIntent;
  pid: number;
  host: string;
  started: boolean;
  phase: RunPhase;
  error?: SubmissionActivity["error"];
  settled: boolean;
}

export function validSubmissionRequest(request: unknown): request is string {
  return typeof request === "string" && request.trim().length > 0 && Buffer.byteLength(request, "utf8") <= MAX_SUBMISSION_REQUEST_BYTES;
}

/** Structural soundness only (bounded shape/type) — never a claim that the decision is still live; the worker re-validates that against real state. */
function validDelegatedIntent(value: unknown): value is DelegatedIntent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "submission") return validSubmissionRequest(v.request);
  if (v.kind === "continuation") {
    return (
      typeof v.decisionId === "string" &&
      DECISION_ID_PATTERN.test(v.decisionId) &&
      typeof v.action === "string" &&
      (DECISION_OPTIONS as readonly string[]).includes(v.action) &&
      (v.checkId === undefined || (typeof v.checkId === "string" && v.checkId.length > 0 && v.checkId.length <= MAX_CHECK_ID_CHARS))
    );
  }
  return false;
}

export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_")));
}

/** One reservation per canonical repository and data directory; never stolen by age or PID death. */
export class DelegatedRunStore {
  private readonly dir: string;
  private readonly active: string;
  constructor(
    private readonly repoRoot: string,
    dataDir: string
  ) {
    this.dir = join(dataDir, "delegated-runs", createHash("sha256").update(repoRoot).digest("hex"));
    this.active = join(this.dir, "active.json");
  }
  private recordPath(id: string): string {
    if (!isSafeTaskId(id)) throw new Error("INVALID_TASK_ID");
    return join(this.dir, `${id}.json`);
  }
  private async read(path: string): Promise<RunRecord | undefined> {
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(128 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 128 * 1024) throw new Error("INVALID_RUN_RECORD");
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as RunRecord;
      if (
        !isSafeTaskId(value.taskId) ||
        value.repoRoot !== this.repoRoot ||
        !/^[a-f0-9]{32}$/.test(value.nonce) ||
        !validDelegatedIntent(value.intent) ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.host !== "string" ||
        typeof value.started !== "boolean" ||
        typeof value.settled !== "boolean" ||
        !["CREATING", "RUNNING", "FINISHED", "FAILED"].includes(value.phase) ||
        (value.error !== undefined &&
          ![
            "DIRTY_WORKING_TREE",
            "TASK_CREATION_FAILED",
            "DECISION_APPLICATION_FAILED",
            "EXECUTION_FAILED",
            "WORKER_LAUNCH_FAILED",
            "STALE_DECISION",
            "ACTION_NOT_AVAILABLE",
            "CHECK_ID_REQUIRED",
            "CHECK_ID_INVALID",
            "CHECK_ID_NOT_APPLICABLE"
          ].includes(value.error))
      ) {
        throw new Error("INVALID_RUN_RECORD");
      }
      return value;
    } finally {
      await handle.close();
    }
  }
  async record(id: string): Promise<RunRecord | undefined> {
    const record = await this.read(this.recordPath(id));
    if (record && record.taskId !== id) throw new Error("INVALID_RUN_RECORD");
    return record;
  }
  /** A plain string is shorthand for `{ kind: "submission", request }` — every existing caller keeps working unchanged. */
  async reserve(taskId: string, requestOrIntent: string | DelegatedIntent): Promise<RunRecord> {
    const intent: DelegatedIntent =
      typeof requestOrIntent === "string" ? { kind: "submission", request: requestOrIntent } : requestOrIntent;
    if (!validDelegatedIntent(intent)) throw new SubmissionError("INVALID_REQUEST");
    const path = this.recordPath(taskId);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const record: RunRecord = {
      taskId,
      intent,
      repoRoot: this.repoRoot,
      nonce: randomBytes(16).toString("hex"),
      pid: process.pid,
      host: hostname(),
      started: false,
      phase: "CREATING",
      settled: false
    };
    const temp = join(this.dir, `.reservation-${record.nonce}`);
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    try {
      try {
        await link(temp, this.active);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SubmissionError("DELEGATED_RUN_EXISTS");
        throw error;
      }
      // Publish the durable activity before launch/response; never create a partial TaskRecord.
      try {
        await link(temp, path);
      } catch (error) {
        await this.release(record);
        throw error;
      }
      const latestTemp = `${temp}.latest`;
      await link(temp, latestTemp);
      try {
        await rename(latestTemp, join(this.dir, "latest.json"));
      } finally {
        await rm(latestTemp, { force: true });
      }
      return record;
    } finally {
      await rm(temp, { force: true });
    }
  }
  async owns(record: RunRecord): Promise<boolean> {
    const active = await this.read(this.active);
    return active?.nonce === record.nonce && active.taskId === record.taskId;
  }
  async update(record: RunRecord): Promise<void> {
    if (!(await this.owns(record))) throw new Error("RUN_OWNERSHIP_LOST");
    const path = this.recordPath(record.taskId);
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    try {
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async release(record: RunRecord): Promise<void> {
    if (await this.owns(record)) await rm(this.active);
  }
  async currentActivity(): Promise<SubmissionActivity | undefined> {
    const record = (await this.read(this.active)) ?? (await this.read(join(this.dir, "latest.json")));
    return record ? this.activity(record.taskId) : undefined;
  }
  async launched(record: RunRecord, pid: number): Promise<void> {
    // Separate immutable metadata: the launcher never overwrites the worker's newer activity.
    await writeFile(`${this.recordPath(record.taskId)}.launch`, JSON.stringify({ ...record, pid }), { flag: "wx", mode: 0o600 });
  }
  async activity(id: string): Promise<SubmissionActivity | undefined> {
    let record = await this.record(id);
    if (!record) {
      const active = await this.read(this.active);
      if (active?.taskId === id) record = active;
    }
    if (!record) return undefined;
    if (!record.started && !record.settled) {
      const launched = await this.read(`${this.recordPath(id)}.launch`);
      if (launched?.nonce === record.nonce) record = { ...record, pid: launched.pid };
    }
    let worker: SubmissionActivity["worker"];
    if (record.settled) worker = "finished";
    else if (record.host !== hostname()) worker = "indeterminate";
    else {
      try {
        process.kill(record.pid, 0);
        worker = record.started ? "active" : "starting";
      } catch (error) {
        worker = (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "indeterminate";
      }
    }
    return { taskId: id, phase: record.phase, worker, ...(record.error ? { error: record.error } : {}) };
  }
}

export interface WorkerLaunch {
  repoRoot: string;
  taskId: string;
  nonce: string;
  env: NodeJS.ProcessEnv;
}
interface ReserveAndLaunchOptions {
  env?: NodeJS.ProcessEnv;
  launch?: (input: WorkerLaunch) => Promise<number | void>;
}

/** The reservation/publish/launch mechanics `submitDelegatedTask` and `submitDelegatedContinuation` share — intent-agnostic: it never looks inside `intent`. */
async function reserveAndLaunch(
  taskId: string,
  repoRoot: string,
  intent: DelegatedIntent,
  options: ReserveAndLaunchOptions
): Promise<SubmissionActivity> {
  const env = workerEnvironment(options.env ?? process.env);
  const paths = resolveEnginePaths(env);
  env.AI_ENGINE_DATA_DIR = resolve(paths.dataDir);
  env.AI_ENGINE_CONFIG_DIR = resolve(paths.configDir);
  const store = new DelegatedRunStore(repoRoot, env.AI_ENGINE_DATA_DIR);
  const record = await store.reserve(taskId, intent);
  let pid: number | void;
  try {
    if (!options.launch) throw new SubmissionError("WORKER_LAUNCH_FAILED");
    pid = await options.launch({ repoRoot, taskId, nonce: record.nonce, env });
  } catch {
    await store.update({ ...record, phase: "FAILED", error: "WORKER_LAUNCH_FAILED", settled: true });
    await store.release(record);
    throw new SubmissionError("WORKER_LAUNCH_FAILED");
  }
  if (pid !== undefined) await store.launched(record, pid);
  return { taskId, phase: "CREATING", worker: "starting" };
}

/** Called only after the MCP managed-context guard. No orchestrator/model/dependency installation here. */
export async function submitDelegatedTask(
  request: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    launch?: (input: WorkerLaunch) => Promise<number | void>;
  } = {}
): Promise<SubmissionActivity> {
  if (!validSubmissionRequest(request)) throw new SubmissionError("INVALID_REQUEST");
  const taskId = generateTaskId();
  const repo = await GitRepository.discover(options.cwd ?? process.cwd());
  try {
    await requireCleanTaskTree(repo);
  } catch (error) {
    if (error instanceof DirtyWorkingTreeError) throw new SubmissionError("DIRTY_WORKING_TREE", error.counts);
    throw error;
  }
  const repoRoot = await realpath(repo.root);
  return reserveAndLaunch(taskId, repoRoot, { kind: "submission", request }, options);
}

/**
 * Reserves and launches the detached continuation of an EXISTING task's pending decision. Called
 * only after the MCP managed-context guard, and only after the caller has already validated
 * `decisionId`/`action`/`checkId` against a live `PendingDecision` and — for "approve" — confirmed
 * the MCP-safe task view actually exposes it (see `packages/mcp`'s `decide_task`). Neither of those
 * checks is repeated here: they are a best-effort preflight, not the authoritative gate. This
 * function only reserves exclusive ownership of the repository's one active delegated run and
 * publishes durable activity — the SAME mechanics `submitDelegatedTask` uses, so "a run is already
 * in progress" and "the worker could not be launched" behave identically for both. The worker
 * (`executeDelegatedTask`) re-validates the decision, under the task's own lock, before applying
 * anything — see `Orchestrator.applyDecision`.
 *
 * No clean-tree requirement: unlike a brand-new task's worktree (created fresh from the main
 * checkout), a continuation only ever touches the existing task's own, already-created worktree.
 */
export async function submitDelegatedContinuation(
  taskId: string,
  decisionId: string,
  action: DecisionOption,
  options: {
    checkId?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    launch?: (input: WorkerLaunch) => Promise<number | void>;
  } = {}
): Promise<SubmissionActivity> {
  const intent: DelegatedIntent = {
    kind: "continuation",
    decisionId,
    action,
    ...(options.checkId !== undefined ? { checkId: options.checkId } : {})
  };
  if (!validDelegatedIntent(intent)) throw new SubmissionError("INVALID_REQUEST");
  const repo = await GitRepository.discover(options.cwd ?? process.cwd());
  const repoRoot = await realpath(repo.root);
  return reserveAndLaunch(taskId, repoRoot, intent, options);
}

export async function delegatedActivity(repoRoot: string, taskId: string): Promise<SubmissionActivity | undefined> {
  return new DelegatedRunStore(await realpath(repoRoot), resolveEnginePaths().dataDir).activity(taskId);
}

/** The `by` attribution recorded for a decision applied through a detached continuation worker — never client-supplied (decide_task carries no identity). */
export const DELEGATED_DECISION_ACTOR = "ai-engine-mcp";

function classifyRunError(error: unknown, kind: DelegatedIntent["kind"], running: boolean): SubmissionActivity["error"] {
  if (error instanceof DirtyWorkingTreeError) return "DIRTY_WORKING_TREE";
  if (error instanceof DecisionApplicationError) return error.code;
  if (running) return "EXECUTION_FAILED";
  return kind === "submission" ? "TASK_CREATION_FAILED" : "DECISION_APPLICATION_FAILED";
}

/** Worker-only entry. No stale-run takeover: only the unpublished nonce permits the first start. */
export async function executeDelegatedTask(
  taskId: string,
  nonce: string,
  options: {
    cwd?: string;
    dataDir?: string;
    open?: (repoRoot: string) => Promise<Pick<Orchestrator, "createTask" | "run" | "applyDecision">>;
  } = {}
): Promise<void> {
  if (!isSafeTaskId(taskId) || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error("INVALID_WORKER_INPUT");
  const repoRoot = await realpath(options.cwd ?? process.cwd());
  const store = new DelegatedRunStore(repoRoot, options.dataDir ?? resolveEnginePaths().dataDir);
  let record = await store.record(taskId);
  if (!record || record.nonce !== nonce || record.started || record.settled || !(await store.owns(record)))
    throw new Error("RUN_OWNERSHIP_LOST");
  // An exclusive start claim also excludes simultaneous duplicate worker processes with the same nonce.
  const claim = join(options.dataDir ?? resolveEnginePaths().dataDir, "delegated-worker-claims");
  await mkdir(claim, { recursive: true, mode: 0o700 });
  const claimFile = join(claim, nonce);
  await writeFile(claimFile, "", { flag: "wx", mode: 0o600 });
  record = { ...record, pid: process.pid, host: hostname(), started: true };
  await store.update(record);
  let running = false;
  try {
    const api = await (options.open ?? ((cwd) => createOrchestrator(cwd)))(repoRoot);
    if (record.intent.kind === "submission") {
      await api.createTask(record.intent.request, { taskId, requireCleanTree: true });
    } else {
      const { decisionId, action, checkId } = record.intent;
      await api.applyDecision(taskId, decisionId, action, { checkId, by: DELEGATED_DECISION_ACTOR });
    }
    record = { ...record, phase: "RUNNING" };
    await store.update(record);
    running = true;
    const task = await api.run(taskId);
    record = {
      ...record,
      phase: task.workflowState === "FAILED" ? "FAILED" : "FINISHED",
      settled: true,
      error: task.workflowState === "FAILED" ? "EXECUTION_FAILED" : undefined
    };
  } catch (error) {
    record = { ...record, phase: "FAILED", settled: !running, error: classifyRunError(error, record.intent.kind, running) };
  }
  await store.update(record);
  // Unexpected execution errors may leave a provider alive. Retain ownership and fail closed.
  if (record.settled) await store.release(record);
}

/** Inspection must remain available even when malformed configuration prevented worker creation. */
export async function openDelegatedTaskInspection(cwd: string) {
  const repo = await GitRepository.discover(cwd);
  const repoRoot = await realpath(repo.root);
  const paths = resolveEnginePaths();
  const tasks = new TaskStore(paths.taskStoreDir);
  const runs = new DelegatedRunStore(repoRoot, paths.dataDir);
  let orchestrator: Promise<Orchestrator> | undefined;
  return {
    repoRoot,
    listTasks: () => tasks.list({ repositoryRoot: repoRoot }),
    getTask: (id: string) => tasks.get(id),
    pendingDecision: async (id: string) => (await (orchestrator ??= createOrchestrator(repoRoot))).pendingDecision(id),
    activity: (id: string) => runs.activity(id),
    currentActivity: () => runs.currentActivity()
  };
}
