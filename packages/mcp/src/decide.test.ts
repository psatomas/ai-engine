import { expect, it, vi } from "vitest";
import type { TaskRecord } from "@ai-engine/core";
import { SubmissionError, type PendingDecision } from "@ai-engine/orchestrator";
import { TOOL_ERRORS } from "./results.js";
import { decideTaskTool, resolveDeps, runGuarded, type ReadOnlyTaskApi } from "./tools.js";
import { fakeApi, makeTask, planTask, REPO_ROOT, OTHER_REPO_ROOT } from "./test-support/fixtures.js";

const TASK_ID = "t-20260101000000-abcd";
const DECISION_ID = "pd1_" + "a".repeat(32);

const call = (deps: Parameters<typeof resolveDeps>[0], args: Record<string, unknown>) =>
  runGuarded(resolveDeps(deps), decideTaskTool, args as never);
const err = (result: Awaited<ReturnType<typeof call>>) => (result.structuredContent as { error: { code: string; message?: string } }).error;

/** A minimal read-only API returning one exact task and one exact (hand-built) decision — full control over shape, no Unit 1 derivation involved. */
function pinnedApi(task: TaskRecord | undefined, decision: PendingDecision | undefined, repoRoot = REPO_ROOT): ReadOnlyTaskApi {
  return {
    repoRoot,
    listTasks: async () => (task ? [task] : []),
    getTask: async (id) => (task && id === task.id ? task : undefined),
    pendingDecision: async (id) => (task && id === task.id ? decision : undefined)
  };
}

const verificationDecision = (overrides: Partial<PendingDecision> = {}): PendingDecision => ({
  taskId: TASK_ID,
  kind: "verification_approval",
  id: DECISION_ID,
  workflowState: "PAUSED",
  summary: "A required repository-configured verification command needs explicit human approval.",
  options: ["approve", "cancel"],
  truncated: false,
  untrusted: [{ field: "checks", trust: "repository_configuration" }],
  checks: [
    { id: "repo.deploy-check", description: "deploy", command: "deploy.sh" },
    { id: "repo.other-check", description: "other", command: "other.sh" }
  ],
  ...overrides
});

it.each(["managed", "indeterminate"] as const)("%s guard precedes decision access, reservation and any state opening", async (status) => {
  const decide = vi.fn();
  const openTasks = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status }) as never, decide, openTasks },
    { taskId: TASK_ID, decisionId: DECISION_ID, decision: "approve" }
  );
  expect(err(result)).toMatchObject({ code: "NESTED_DELEGATION_REFUSED" });
  expect(decide).not.toHaveBeenCalled();
  expect(openTasks).not.toHaveBeenCalled();
});

it.each(["", "t-", "../../etc/passwd", "t-1/2", "T-1"])("rejects invalid taskId %j before any state access", async (taskId) => {
  const decide = vi.fn();
  const openTasks = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks },
    { taskId, decisionId: DECISION_ID, decision: "approve" }
  );
  expect(err(result)).toMatchObject({ code: "INVALID_TASK_ID" });
  expect(decide).not.toHaveBeenCalled();
  expect(openTasks).not.toHaveBeenCalled();
});

it.each(["", "pd1_short", "pd1_" + "g".repeat(32), "pd1_" + "A".repeat(32), "not-a-decision-id", "pd2_" + "a".repeat(32)])(
  "rejects malformed decisionId %j before any state access",
  async (decisionId) => {
    const decide = vi.fn();
    const openTasks = vi.fn();
    const result = await call(
      { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks },
      { taskId: TASK_ID, decisionId, decision: "approve" }
    );
    expect(err(result)).toMatchObject({ code: "INVALID_DECISION_ID" });
    expect(decide).not.toHaveBeenCalled();
    expect(openTasks).not.toHaveBeenCalled();
  }
);

it("treats a task of another repository exactly like an unknown one — same code, no distinguishing detail", async () => {
  const foreign = makeTask({ id: TASK_ID, repository: { root: OTHER_REPO_ROOT } });
  const decide = vi.fn();
  const foreignResult = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => pinnedApi(foreign, undefined) },
    { taskId: TASK_ID, decisionId: DECISION_ID, decision: "approve" }
  );
  const unknownResult = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => pinnedApi(undefined, undefined) },
    { taskId: TASK_ID, decisionId: DECISION_ID, decision: "approve" }
  );
  expect(err(foreignResult)).toEqual({ code: "TASK_NOT_FOUND", message: TOOL_ERRORS.TASK_NOT_FOUND });
  expect(err(unknownResult)).toEqual(err(foreignResult));
  expect(decide).not.toHaveBeenCalled();
});

it("rejects a decisionId that does not match the task's live decision, without calling decide", async () => {
  const task = planTask({ id: TASK_ID });
  const fake = fakeApi([task]);
  const decide = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => fake.api },
    { taskId: TASK_ID, decisionId: DECISION_ID, decision: "approve" } // DECISION_ID never matches a freshly derived digest
  );
  expect(err(result)).toEqual({ code: "STALE_DECISION", message: TOOL_ERRORS.STALE_DECISION });
  expect(decide).not.toHaveBeenCalled();
});

it("rejects an action absent from the live decision's own options, without calling decide", async () => {
  const task = planTask({ id: TASK_ID });
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  const decide = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => fake.api },
    { taskId: TASK_ID, decisionId: live.id, decision: "retry" } // "plan" never offers "retry"
  );
  expect(err(result)).toEqual({ code: "ACTION_NOT_AVAILABLE", message: TOOL_ERRORS.ACTION_NOT_AVAILABLE });
  expect(decide).not.toHaveBeenCalled();
});

it("verification_approval + approve without checkId is refused before calling decide", async () => {
  const task = makeTask({ id: TASK_ID, workflowState: "PAUSED" });
  const decision = verificationDecision();
  const decide = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => pinnedApi(task, decision) },
    { taskId: TASK_ID, decisionId: DECISION_ID, decision: "approve" }
  );
  expect(err(result)).toEqual({ code: "CHECK_ID_REQUIRED", message: TOOL_ERRORS.CHECK_ID_REQUIRED });
  expect(decide).not.toHaveBeenCalled();
});

it("verification_approval + approve with an unknown checkId is refused, never falling back to the first check", async () => {
  const task = makeTask({ id: TASK_ID, workflowState: "PAUSED" });
  const decision = verificationDecision();
  const decide = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => pinnedApi(task, decision) },
    { taskId: TASK_ID, decisionId: DECISION_ID, decision: "approve", checkId: "repo.no-such-check" }
  );
  expect(err(result)).toEqual({ code: "CHECK_ID_INVALID", message: TOOL_ERRORS.CHECK_ID_INVALID });
  expect(decide).not.toHaveBeenCalled();
});

it("verification_approval + approve applies only the exact checkId named, never another pending check", async () => {
  const task = makeTask({ id: TASK_ID, workflowState: "PAUSED" });
  const decision = verificationDecision();
  const decide = vi.fn(async () => ({ taskId: TASK_ID, phase: "CREATING" as const, worker: "starting" as const }));
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => pinnedApi(task, decision) },
    { taskId: TASK_ID, decisionId: DECISION_ID, decision: "approve", checkId: "repo.other-check" }
  );
  expect(result.isError).toBeUndefined();
  expect(decide).toHaveBeenCalledWith(TASK_ID, DECISION_ID, "approve", "repo.other-check");
  expect(decide).toHaveBeenCalledOnce();
});

it("rejects a checkId supplied where the decision has no use for one, rather than silently ignoring it", async () => {
  const task = planTask({ id: TASK_ID }); // a "plan" decision: checkId never applies
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  const decide = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => fake.api },
    { taskId: TASK_ID, decisionId: live.id, decision: "approve", checkId: "repo.deploy-check" }
  );
  expect(err(result)).toEqual({ code: "CHECK_ID_NOT_APPLICABLE", message: TOOL_ERRORS.CHECK_ID_NOT_APPLICABLE });
  expect(decide).not.toHaveBeenCalled();
});

it("refuses approve when the MCP-safe projection withholds it, even though the raw decision still offers it", async () => {
  const task = planTask({ id: TASK_ID, plan: "p".repeat(30_000) }); // over the MCP presentation limit, not Unit 1's
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  expect(live.options).toContain("approve"); // Unit 1 itself still offers it
  const decide = vi.fn();
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => fake.api },
    { taskId: TASK_ID, decisionId: live.id, decision: "approve" }
  );
  expect(err(result)).toEqual({ code: "APPROVAL_WITHHELD", message: TOOL_ERRORS.APPROVAL_WITHHELD });
  expect(decide).not.toHaveBeenCalled();
});

it("permits approve when the MCP-safe projection exposes it, and relays exactly the validated request", async () => {
  const task = planTask({ id: TASK_ID });
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  const decide = vi.fn(async () => ({ taskId: TASK_ID, phase: "CREATING" as const, worker: "starting" as const }));
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => fake.api },
    { taskId: TASK_ID, decisionId: live.id, decision: "approve" }
  );
  expect(result.isError).toBeUndefined();
  expect((result.structuredContent as { activity: unknown }).activity).toEqual({ taskId: TASK_ID, phase: "CREATING", worker: "starting" });
  expect(decide).toHaveBeenCalledWith(TASK_ID, live.id, "approve", undefined);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4096);
});

it.each(["reject", "cancel"] as const)("does not apply the MCP-presentation check to non-approve action %s", async (action) => {
  const task = planTask({ id: TASK_ID, plan: "p".repeat(30_000) }); // would withhold approve, but not reject/cancel
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  expect(live.options).toContain(action);
  const decide = vi.fn(async () => ({ taskId: TASK_ID, phase: "CREATING" as const, worker: "starting" as const }));
  const result = await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => fake.api },
    { taskId: TASK_ID, decisionId: live.id, decision: action }
  );
  expect(result.isError).toBeUndefined();
  expect(decide).toHaveBeenCalledWith(TASK_ID, live.id, action, undefined);
});

it("resume/retry/cancel/reject each relay the live decisionId and the exact requested action", async () => {
  const failed = makeTask({ id: "t-20260101000000-fail1", workflowState: "FAILED", previousState: "IMPLEMENTING" });
  const paused = makeTask({ id: "t-20260101000000-paus2", workflowState: "PAUSED", previousState: "IMPLEMENTING" });
  for (const [task, action] of [
    [failed, "retry"],
    [paused, "resume"],
    [paused, "cancel"]
  ] as const) {
    const fake = fakeApi([task]);
    const live = (await fake.api.pendingDecision(task.id))!;
    expect(live.options).toContain(action);
    const decide = vi.fn(async () => ({ taskId: task.id, phase: "CREATING" as const, worker: "starting" as const }));
    const result = await call(
      { detectContext: async () => ({ status: "unmanaged" }), decide, openTasks: async () => fake.api },
      { taskId: task.id, decisionId: live.id, decision: action }
    );
    expect(result.isError).toBeUndefined();
    expect(decide).toHaveBeenCalledWith(task.id, live.id, action, undefined);
  }
});

it("maps a thrown SubmissionError (reservation/launch failure) to its stable code, same as submit_task", async () => {
  const task = planTask({ id: TASK_ID });
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  const result = await call(
    {
      detectContext: async () => ({ status: "unmanaged" }),
      openTasks: async () => fake.api,
      decide: async () => {
        throw new SubmissionError("DELEGATED_RUN_EXISTS");
      }
    },
    { taskId: TASK_ID, decisionId: live.id, decision: "reject" }
  );
  expect(err(result)).toMatchObject({ code: "DELEGATED_RUN_EXISTS" });
});

it("does not echo an unexpected internal failure's detail", async () => {
  const task = planTask({ id: TASK_ID });
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  const reported: string[] = [];
  const result = await call(
    {
      detectContext: async () => ({ status: "unmanaged" }),
      openTasks: async () => fake.api,
      reportError: (kind) => reported.push(kind),
      decide: async () => {
        throw new Error("secret /path API_KEY");
      }
    },
    { taskId: TASK_ID, decisionId: live.id, decision: "reject" }
  );
  expect(err(result)).toMatchObject({ code: "INTERNAL_ERROR" });
  expect(JSON.stringify(result)).not.toMatch(/secret|\/path|API_KEY/);
  expect(reported).toEqual(["Error"]);
});

it("never mutates the underlying decision or task while validating", async () => {
  const task = planTask({ id: TASK_ID });
  const frozenTask = structuredClone(task);
  const fake = fakeApi([task]);
  const live = (await fake.api.pendingDecision(TASK_ID))!;
  const liveSnapshot = structuredClone(live);
  await call(
    { detectContext: async () => ({ status: "unmanaged" }), decide: vi.fn(), openTasks: async () => fake.api },
    { taskId: TASK_ID, decisionId: "pd1_" + "0".repeat(32), decision: "approve" } // deliberately stale, refused
  );
  expect(task).toEqual(frozenTask);
  expect(await fake.api.pendingDecision(TASK_ID)).toEqual(liveSnapshot);
});
