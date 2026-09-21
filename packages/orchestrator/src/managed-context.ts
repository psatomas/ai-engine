import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { resolveEnginePaths } from "@ai-engine/config";
import { MANAGED_TASK_ENV } from "@ai-engine/core";
import { inspectCheckout, TASK_BRANCH_PREFIX, type CheckoutTopology } from "@ai-engine/git";
import { TASK_ID_PREFIX } from "./ids.js";

/** The independent pieces of evidence that a caller is running inside an AI Engine-managed task. */
export type ManagedSignal = "marker" | "worktree_path" | "task_worktree_topology";

/** A signal that could not be evaluated. `code` is a short machine-readable token, never a message, path, or output. */
export interface ManagedContextFailure {
  signal: Exclude<ManagedSignal, "marker">;
  reason: "cwd_unresolvable" | "worktrees_root_unresolvable" | "git_inspection_failed";
  code: string;
}

/**
 * - `unmanaged`: every signal was evaluated and none found evidence of a managed context.
 * - `managed`: at least one signal positively did (all positive signals are listed).
 * - `indeterminate`: no signal was positive, but at least one could not be evaluated, so unmanaged
 *   cannot be claimed. A caller that must refuse nested delegation refuses this exactly like `managed`.
 */
export type ManagedContext =
  | { status: "unmanaged" }
  | { status: "managed"; signals: ManagedSignal[] }
  | { status: "indeterminate"; failures: ManagedContextFailure[] };

export interface DetectManagedContextOptions {
  /** Directory the caller is executing from (default: this process's working directory). */
  cwd?: string;
  /** Environment to read the marker and data-dir configuration from (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** @internal Replaceable collaborators, for tests that need a failure a real filesystem cannot produce on demand. */
  deps?: Partial<ManagedContextDeps>;
}

export interface ManagedContextDeps {
  realpath: (path: string) => Promise<string>;
  resolveWorktreesRoot: (env: NodeJS.ProcessEnv) => string;
  inspectCheckout: (cwd: string) => Promise<CheckoutTopology>;
}

const defaultDeps: ManagedContextDeps = {
  realpath: (path) => realpath(path),
  resolveWorktreesRoot: (env) => resolveEnginePaths(env).worktreesDir,
  inspectCheckout: (cwd) => inspectCheckout(cwd)
};

/** Error codes are surfaced only when they already look like a code (`EACCES`, `GIT_EXIT_128`); anything else is `UNKNOWN`. */
function boundedCode(err: unknown): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "UNKNOWN";
}

/** Component-boundary containment of real paths: equal to the root (empty relative path), or beneath it. Never a string-prefix test. */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The task-branch convention (`ai/t-...`), matched on the branch name Git reports. Deliberately keyed
 * on the shared prefixes rather than the exact generated-id shape: a task id that is a little
 * different from today's generator must still be recognised, since a miss here means "not managed".
 */
function isTaskBranch(branch: string): boolean {
  const prefix = `${TASK_BRANCH_PREFIX}${TASK_ID_PREFIX}`;
  return branch.startsWith(prefix) && branch.length > prefix.length;
}

type SignalOutcome = { result: "positive" } | { result: "negative" } | { result: "indeterminate"; failure: ManagedContextFailure };

const positive: SignalOutcome = { result: "positive" };
const negative: SignalOutcome = { result: "negative" };

/** Any non-empty value at all: no parsing, no validation. An absent or empty marker proves nothing. */
function markerSignal(env: NodeJS.ProcessEnv): SignalOutcome {
  const value = env[MANAGED_TASK_ENV];
  return typeof value === "string" && value.length > 0 ? positive : negative;
}

/** Is the canonical cwd equal to, or beneath, the canonical worktrees root? */
async function pathSignal(cwd: string, env: NodeJS.ProcessEnv, deps: ManagedContextDeps): Promise<SignalOutcome> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await deps.realpath(cwd);
  } catch (err) {
    return { result: "indeterminate", failure: { signal: "worktree_path", reason: "cwd_unresolvable", code: boundedCode(err) } };
  }

  let root: string;
  try {
    root = await deps.realpath(deps.resolveWorktreesRoot(env));
  } catch (err) {
    // A root that does not exist is a definite answer: no path can be beneath it. Any other failure is not.
    if (boundedCode(err) === "ENOENT") return negative;
    return { result: "indeterminate", failure: { signal: "worktree_path", reason: "worktrees_root_unresolvable", code: boundedCode(err) } };
  }

  return isWithin(root, canonicalCwd) ? positive : negative;
}

/** Does Git say this is a linked worktree on a task branch? Ordinary checkouts and unrelated worktrees do not qualify. */
async function topologySignal(cwd: string, deps: ManagedContextDeps): Promise<SignalOutcome> {
  let topology: CheckoutTopology;
  try {
    topology = await deps.inspectCheckout(cwd);
  } catch (err) {
    return {
      result: "indeterminate",
      failure: { signal: "task_worktree_topology", reason: "git_inspection_failed", code: boundedCode(err) }
    };
  }
  if (topology.kind !== "repository") return negative;
  return topology.linkedWorktree && topology.branch !== undefined && isTaskBranch(topology.branch) ? positive : negative;
}

/**
 * Answers "is this caller executing from an AI Engine-managed context?" from three independent
 * signals, and fails closed:
 *
 * 1. the `AI_ENGINE_MANAGED_TASK` marker is set to any non-empty value;
 * 2. the canonical cwd is the canonical worktrees root or beneath it;
 * 3. Git reports a linked worktree checked out on a task branch (`ai/t-...`), which holds even when a
 *    custom data dir defeats signal 2 and even without the marker.
 *
 * Any positive signal means `managed`. Otherwise, if any signal could not be evaluated, the answer is
 * `indeterminate` — never `unmanaged`. Only when every signal was evaluated and none was positive is
 * the answer `unmanaged`. No process names, parent pids, shells, models, terminal state or timing are consulted.
 *
 * Read-only, and never throws: an unexpected failure inside a signal becomes an `indeterminate`
 * result whose diagnostics are bounded codes only.
 */
export async function detectManagedContext(options: DetectManagedContextOptions = {}): Promise<ManagedContext> {
  const env = options.env ?? process.env;
  const deps: ManagedContextDeps = { ...defaultDeps, ...options.deps };

  let cwd: string;
  try {
    cwd = options.cwd ?? process.cwd();
  } catch (err) {
    // The working directory itself cannot be read (e.g. it was deleted): neither filesystem-based signal can run.
    const cwdFailure = (signal: ManagedContextFailure["signal"]): SignalOutcome => ({
      result: "indeterminate",
      failure: { signal, reason: "cwd_unresolvable", code: boundedCode(err) }
    });
    return combine(markerSignal(env), cwdFailure("worktree_path"), cwdFailure("task_worktree_topology"));
  }

  const guarded = async (signal: Exclude<ManagedSignal, "marker">, run: () => Promise<SignalOutcome>): Promise<SignalOutcome> => {
    try {
      return await run();
    } catch {
      return {
        result: "indeterminate",
        failure: {
          signal,
          reason: signal === "worktree_path" ? "worktrees_root_unresolvable" : "git_inspection_failed",
          code: "UNEXPECTED"
        }
      };
    }
  };

  return combine(
    markerSignal(env),
    await guarded("worktree_path", () => pathSignal(cwd, env, deps)),
    await guarded("task_worktree_topology", () => topologySignal(cwd, deps))
  );
}

function combine(marker: SignalOutcome, path: SignalOutcome, topology: SignalOutcome): ManagedContext {
  const signals: ManagedSignal[] = [];
  if (marker.result === "positive") signals.push("marker");
  if (path.result === "positive") signals.push("worktree_path");
  if (topology.result === "positive") signals.push("task_worktree_topology");
  if (signals.length > 0) return { status: "managed", signals };

  const failures = [path, topology].flatMap((outcome) => (outcome.result === "indeterminate" ? [outcome.failure] : []));
  return failures.length > 0 ? { status: "indeterminate", failures } : { status: "unmanaged" };
}
