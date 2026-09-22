import { buildDefaultWorkflow, WorkflowEngine } from "@ai-engine/workflow";
import type { TaskRecord } from "@ai-engine/core";
import { derivePendingDecision } from "@ai-engine/orchestrator";
import type { ReadOnlyTaskApi } from "../tools.js";

export const REPO_ROOT = "/home/someone/projects/repo";
export const OTHER_REPO_ROOT = "/home/someone/projects/other-repo";
export const WORKTREE = "/home/someone/.local/share/ai-engine/worktrees/t-20260101000000-abcd";

const engine = new WorkflowEngine(buildDefaultWorkflow());

export function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t-20260101000000-abcd",
    repository: { root: REPO_ROOT },
    workspaceFolder: REPO_ROOT,
    originalRequest: "Add a login page",
    workflowState: "IMPLEMENTING",
    agentsUsed: [],
    git: {
      branch: "main",
      commit: "abc123",
      worktreePath: WORKTREE,
      taskBranch: "ai/t-20260101000000-abcd",
      dirtyAtStart: false,
      untrackedAtStart: []
    },
    verification: [],
    reviews: [],
    approvals: [],
    history: [],
    failures: [],
    iterationCounts: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    providerSessions: {},
    usage: {},
    roleInvocationCounts: {},
    usageEvents: [],
    ...overrides
  };
}

export const planTask = (overrides: Partial<TaskRecord> = {}): TaskRecord =>
  makeTask({ workflowState: "AWAITING_APPROVAL", specification: "the spec", plan: "1. do the thing", ...overrides });

export interface FakeApi {
  api: ReadOnlyTaskApi;
  /** Every property of the API that anything read, so a test can prove nothing reached beyond the read-only set. */
  accessed: Set<string>;
  calls: { listTasks: number; getTask: string[]; pendingDecision: string[] };
}

/** A read-only task API over fixed records, deriving decisions with the real Unit 1 model. */
export function fakeApi(tasks: TaskRecord[], options: { repoRoot?: string; failPendingFor?: string[] } = {}): FakeApi {
  const accessed = new Set<string>();
  const calls = { listTasks: 0, getTask: [] as string[], pendingDecision: [] as string[] };
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const base: ReadOnlyTaskApi = {
    repoRoot,
    listTasks: async () => {
      calls.listTasks++;
      return tasks.filter((task) => task.repository.root === repoRoot);
    },
    getTask: async (id) => {
      calls.getTask.push(id);
      return tasks.find((task) => task.id === id);
    },
    pendingDecision: async (id) => {
      calls.pendingDecision.push(id);
      if (options.failPendingFor?.includes(id)) throw new Error(`cannot derive ${WORKTREE}`);
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`Unknown task "${id}"`);
      return derivePendingDecision(task, {
        canApply: (trigger, from) => engine.canApply(from ? { ...task, workflowState: from } : task, trigger)
      });
    }
  };
  const api = new Proxy(base, {
    get(target, property, receiver) {
      // `then` is only the thenable probe made when the API is returned from an async function.
      if (property !== "then") accessed.add(String(property));
      return Reflect.get(target, property, receiver);
    }
  });
  return { api, accessed, calls };
}
