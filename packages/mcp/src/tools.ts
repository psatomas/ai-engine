import { launchDetachedWorker } from "./worker-launch.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { DecisionOption, ManagedContext } from "@ai-engine/orchestrator";
import {
  TASK_VIEW_LIMITS,
  DECISION_ID_PATTERN,
  openDelegatedTaskInspection,
  submitDelegatedTask,
  submitDelegatedContinuation,
  SubmissionError,
  validateDecisionRequest,
  validSubmissionRequest,
  type SubmissionActivity,
  describeTask,
  detectManagedContext,
  summarizeTasks,
  type Orchestrator,
  type PendingDecisionOutcome
} from "@ai-engine/orchestrator";
import { guardNestedDelegation } from "./guard.js";
import { errorResult, successResult, ToolError, type ToolErrorCode } from "./results.js";
import { isSafeTaskId } from "./task-id.js";

/** `decision` is a client-facing field name; kept in sync with `DecisionOption` by hand (zod needs a literal tuple, not the type). */
const DECISION_OPTION_VALUES = ["approve", "reject", "retry", "resume", "cancel"] as const;

/**
 * Everything the tools may reach. It is a compile-time narrowing of the orchestrator to its
 * read-only accessors, and `defaultOpenTasks` narrows it again at runtime, so a tool cannot call a
 * mutating method (`run`, `createTask`, `decidePlan`, ...) even by mistake.
 */
export type ReadOnlyTaskApi = Pick<Orchestrator, "repoRoot" | "listTasks" | "getTask" | "pendingDecision"> & {
  currentActivity?: () => Promise<SubmissionActivity | undefined>;
  activity?: (taskId: string) => Promise<SubmissionActivity | undefined>;
};

/** What `decide_task` reserves and launches, once its own preflight has already validated the request. */
export type DecideFn = (
  taskId: string,
  decisionId: string,
  action: DecisionOption,
  checkId: string | undefined
) => Promise<SubmissionActivity>;

export interface TaskMcpDeps {
  /** The managed-context detector. Defaults to the shared `detectManagedContext` on this process's own cwd and environment. */
  submit?: (request: string) => Promise<SubmissionActivity>;
  decide?: DecideFn;
  detectContext?: () => Promise<ManagedContext>;
  /** Opens the task state of the repository this process runs in. Called only AFTER the guard has allowed a call. */
  openTasks?: () => Promise<ReadOnlyTaskApi>;
  /** Told the class name of an unexpected failure (never its message). Defaults to a one-line stderr note. */
  reportError?: (kind: string) => void;
}

export interface ResolvedDeps {
  submit: (request: string) => Promise<SubmissionActivity>;
  decide: DecideFn;
  detectContext: () => Promise<ManagedContext>;
  openTasks: () => Promise<ReadOnlyTaskApi>;
  reportError: (kind: string) => void;
}

export async function defaultOpenTasks(): Promise<ReadOnlyTaskApi> {
  return openDelegatedTaskInspection(process.cwd());
}

function defaultReportError(kind: string): void {
  process.stderr.write(`ai-engine-mcp: ${kind}\n`);
}

export function resolveDeps(deps: TaskMcpDeps = {}): ResolvedDeps {
  return {
    submit: deps.submit ?? ((request) => submitDelegatedTask(request, { launch: launchDetachedWorker })),
    decide:
      deps.decide ??
      ((taskId, decisionId, action, checkId) =>
        submitDelegatedContinuation(taskId, decisionId, action, { checkId, launch: launchDetachedWorker })),
    detectContext: deps.detectContext ?? (() => detectManagedContext()),
    openTasks: deps.openTasks ?? defaultOpenTasks,
    reportError: deps.reportError ?? defaultReportError
  };
}

interface ToolContext {
  submit: (request: string) => Promise<SubmissionActivity>;
  decide: DecideFn;
  /** Opens the task state; the first call is the first thing that touches AI Engine state. */
  api: () => Promise<ReadOnlyTaskApi>;
  /** Runs a read of persisted state, mapping any failure to a stable error that carries none of its detail. */
  read: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  mutates?: boolean;
  /**
   * The most UTF-8 bytes this tool's serialized result may occupy. The task-view budgets (which leave
   * headroom for the envelope) keep every result within it; this is the transport's own check that they did.
   */
  maxResponseBytes: number;
  title: string;
  description: string;
  inputSchema: S;
  run: (args: z.infer<S>, context: ToolContext) => Promise<Record<string, unknown>>;
}

/** A pending decision that could not be derived is `unavailable` — never reported as `none`. */
async function pendingOutcome(api: ReadOnlyTaskApi, taskId: string): Promise<PendingDecisionOutcome> {
  if (!isSafeTaskId(taskId)) return { status: "unavailable" };
  try {
    const decision = await api.pendingDecision(taskId);
    return decision ? { status: "pending", decision } : { status: "none" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Whole-result limits: `TASK_VIEW_BUDGET` (120 KiB / 60 KiB) plus room for the notice, wrapper and JSON-RPC envelope. */
export const MAX_GET_TASK_RESPONSE_BYTES = 128 * 1024;
export const MAX_LIST_TASKS_RESPONSE_BYTES = 64 * 1024;

export const listTasksTool: ToolDefinition<z.ZodObject<Record<string, never>>> = {
  name: "list_tasks",
  maxResponseBytes: MAX_LIST_TASKS_RESPONSE_BYTES,
  title: "List AI Engine tasks",
  description:
    "Read-only. Lists this repository's AI Engine tasks, newest first, as short bounded summaries: id, workflow state, " +
    "timestamps, the task branch, a short request summary, and whether a human decision is pending. Nothing is created or changed.",
  inputSchema: z.object({}),
  run: async (_args, { api, read }) => {
    const opened = await api();
    const tasks = await read(() => opened.listTasks());
    const outcomes = new Map<string, PendingDecisionOutcome>();
    for (const task of tasks.slice(0, TASK_VIEW_LIMITS.tasksPerList)) outcomes.set(task.id, await pendingOutcome(opened, task.id));
    const submission = opened.currentActivity ? await read(() => opened.currentActivity!()) : undefined;
    return { ...summarizeTasks(tasks, outcomes), ...(submission ? { submission } : {}) };
  }
};

export const getTaskTool: ToolDefinition<z.ZodObject<{ taskId: z.ZodString }>> = {
  name: "get_task",
  maxResponseBytes: MAX_GET_TASK_RESPONSE_BYTES,
  title: "Get an AI Engine task",
  description:
    "Read-only. Returns one task of this repository as a bounded view: state, request and specification summaries, the latest " +
    "verification and review summaries, the latest failure, and the pending human decision if any. Nothing is created or changed.",
  inputSchema: z.object({ taskId: z.string().describe("The task id, for example t-20260101000000-abcd.") }),
  run: async ({ taskId }, { api, read }) => {
    if (!isSafeTaskId(taskId)) throw new ToolError("INVALID_TASK_ID");
    const opened = await api();
    const task = await read(() => opened.getTask(taskId));
    // A task of another repository is not this caller's to see, and its existence is not revealed.
    if (task && (task.id !== taskId || task.repository?.root !== opened.repoRoot)) throw new ToolError("TASK_NOT_FOUND");
    const activity = opened.activity ? await read(() => opened.activity!(taskId)) : undefined;
    if (!task && !activity) throw new ToolError("TASK_NOT_FOUND");
    return { ...(task ? { task: describeTask(task, await pendingOutcome(opened, taskId)) } : {}), ...(activity ? { activity } : {}) };
  }
};

export const submitTaskTool: ToolDefinition<z.ZodObject<{ request: z.ZodString }>> = {
  name: "submit_task",
  mutates: true,
  maxResponseBytes: 4096,
  title: "Submit an AI Engine task",
  description:
    "Create a delegated task in a detached worker. Returns an id immediately after launch; inspect it with get_task. Requires a clean repository. No automatic stale-worker recovery.",
  inputSchema: z.object({ request: z.string().describe("Nonblank task request, at most 16 KiB UTF-8.") }),
  run: async ({ request }, { submit }) => {
    if (!validSubmissionRequest(request)) throw new ToolError("INVALID_REQUEST");
    return { activity: await submit(request) };
  }
};

export const decideTaskTool: ToolDefinition<
  z.ZodObject<{
    taskId: z.ZodString;
    decisionId: z.ZodString;
    decision: z.ZodEnum<{ [K in (typeof DECISION_OPTION_VALUES)[number]]: K }>;
    checkId: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "decide_task",
  mutates: true,
  maxResponseBytes: 4096,
  title: "Answer an AI Engine task's pending decision",
  description:
    "Relay one explicit, already-decided human answer (approve, reject, retry, resume, or cancel) to a task's CURRENT pending decision, " +
    "named by the decisionId and options get_task just returned. Continues in a detached worker; inspect progress with get_task. Does not " +
    "interpret natural language, and never approves content this interface could not show in full — get_task's pending decision then " +
    "explains why. For a verification_approval decision, checkId is required and answers exactly that one check, never another.",
  inputSchema: z.object({
    taskId: z.string().describe("The task id, for example t-20260101000000-abcd."),
    decisionId: z
      .string()
      .describe("The exact PendingDecision.id from a recent get_task call — binds this answer to that specific decision."),
    decision: z.enum(DECISION_OPTION_VALUES).describe("One of the options get_task's pendingDecision.decision.options actually offered."),
    checkId: z
      .string()
      .optional()
      .describe('Required, and only meaningful, for a verification_approval decision\'s "approve": which check.')
  }),
  run: async ({ taskId, decisionId, decision, checkId }, { api, read, decide }) => {
    if (!isSafeTaskId(taskId)) throw new ToolError("INVALID_TASK_ID");
    if (!DECISION_ID_PATTERN.test(decisionId)) throw new ToolError("INVALID_DECISION_ID");
    const opened = await api();
    const task = await read(() => opened.getTask(taskId));
    // A task of another repository is not this caller's to see or answer, and its existence is not revealed.
    if (!task || task.id !== taskId || task.repository?.root !== opened.repoRoot) throw new ToolError("TASK_NOT_FOUND");

    const live = await read(() => opened.pendingDecision(taskId));
    const invalid = validateDecisionRequest(live, decisionId, decision, checkId);
    if (invalid) throw new ToolError(invalid as ToolErrorCode);

    if (decision === "approve") {
      // The MCP presentation boundary, not the raw decision: never relay approval of content this
      // interface could not show in full (a tighter, transport-sized bound than Unit 1's own limits).
      const view = describeTask(task, { status: "pending", decision: live! });
      const presented = view.pendingDecision.status === "pending" ? view.pendingDecision.decision.options : [];
      if (!presented.includes("approve")) throw new ToolError("APPROVAL_WITHHELD");
    }

    return { activity: await decide(taskId, decisionId, decision, checkId) };
  }
};

/** Every tool the server exposes. Each one runs through `runGuarded`, and only through it. */
export const TOOLS = [listTasksTool, getTaskTool, submitTaskTool, decideTaskTool] as const;

function errorKind(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

/**
 * The one path every tool call takes. Order matters and is the point:
 *   1. the nested-delegation guard — before anything else;
 *   2. the tool's own input checks;
 *   3. only then, opening AI Engine's task state and reading it.
 * A refused call never constructs the orchestrator, so no configuration, task or repository is read.
 */
export async function runGuarded<S extends z.ZodObject>(
  deps: ResolvedDeps,
  tool: ToolDefinition<S>,
  args: z.infer<S>
): Promise<CallToolResult> {
  const verdict = await guardNestedDelegation(deps.detectContext);
  if (!verdict.allowed) return errorResult("NESTED_DELEGATION_REFUSED", { context: verdict.context });

  let opened: Promise<ReadOnlyTaskApi> | undefined;
  const context: ToolContext = {
    submit: deps.submit,
    decide: deps.decide,
    api: () =>
      (opened ??= deps.openTasks().catch((err: unknown) => {
        deps.reportError(errorKind(err));
        throw new ToolError("REPOSITORY_UNAVAILABLE");
      })),
    read: async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ToolError) throw err;
        deps.reportError(errorKind(err));
        throw new ToolError("TASK_STATE_UNAVAILABLE");
      }
    }
  };

  try {
    const result = successResult(await tool.run(args, context));
    // A backstop, never a truncator: the views are bounded by measurement, so this only fires if that ever fails,
    // and then nothing oversized is sent and nothing is cut mid-structure.
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > tool.maxResponseBytes) return errorResult("RESPONSE_TOO_LARGE");
    return result;
  } catch (err) {
    if (err instanceof SubmissionError) return errorResult(err.code, err.counts ? { counts: err.counts } : {});
    if (err instanceof ToolError) return errorResult(err.code);
    deps.reportError(errorKind(err));
    return errorResult("INTERNAL_ERROR");
  }
}
