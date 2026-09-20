import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@ai-engine/core";
import { buildDefaultWorkflow } from "./default-workflow.js";
import { WorkflowEngine, DEFAULT_WORKFLOW_LIMITS } from "./engine.js";
import { InvalidTransitionError } from "./statemachine.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    repository: { root: "/tmp/repo" },
    workspaceFolder: "/tmp/repo",
    originalRequest: "do the thing",
    workflowState: "TASK_CREATED",
    agentsUsed: [],
    git: { branch: "main", commit: "abc123", dirtyAtStart: false, untrackedAtStart: [] },
    verification: [],
    reviews: [],
    approvals: [],
    history: [],
    failures: [],
    iterationCounts: {},
    createdAt: now,
    updatedAt: now,
    providerSessions: {},
    usage: {},
    roleInvocationCounts: {},
    usageEvents: [],
    ...overrides
  };
}

describe("WorkflowEngine", () => {
  it("walks the happy path from TASK_CREATED to READY", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    let task = makeTask();

    task = engine.apply(task, "analyze", "system");
    expect(task.workflowState).toBe("ANALYZING");

    task = engine.apply(task, "plan_ready", "system");
    expect(task.workflowState).toBe("PLAN_READY");

    task = engine.apply(task, "submit_for_approval", "system");
    expect(task.workflowState).toBe("AWAITING_APPROVAL");

    task = engine.apply(task, "approve", "human");
    expect(task.workflowState).toBe("IMPLEMENTING");

    task = engine.apply(task, "implemented", "system");
    expect(task.workflowState).toBe("TESTING");

    task = engine.apply(task, "tests_passed", "system");
    expect(task.workflowState).toBe("REVIEWING");

    task = engine.apply(task, "review_approved", "system");
    expect(task.workflowState).toBe("VERIFYING");

    task = engine.apply(task, "verified_pass", "system");
    expect(task.workflowState).toBe("READY");
    expect(task.finalStatus).toBe("ready");
    expect(task.history).toHaveLength(8);
  });

  it("rejects an illegal transition", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    const task = makeTask({ workflowState: "TASK_CREATED" });
    expect(() => engine.apply(task, "approve", "human")).toThrow(InvalidTransitionError);
  });

  it("escalates to BLOCKED after exceeding the fix/test loop iteration cap", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow(), {
      maxIterations: { test_fix: 2 },
      defaultMaxIterations: 2
    });
    let task = makeTask({ workflowState: "TESTING" });

    task = engine.apply(task, "tests_failed", "system"); // 1
    expect(task.workflowState).toBe("FIXING");
    task = engine.apply(task, "fixed", "system");
    expect(task.workflowState).toBe("TESTING");

    task = engine.apply(task, "tests_failed", "system"); // 2
    expect(task.workflowState).toBe("FIXING");
    task = engine.apply(task, "fixed", "system");

    task = engine.apply(task, "tests_failed", "system"); // 3rd -> exceeds cap of 2
    expect(task.workflowState).toBe("BLOCKED");
    expect(task.failures.at(-1)?.code).toBe("MAX_ITERATIONS");
  });

  it("supports pause and resume back to the exact prior state", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    let task = makeTask({ workflowState: "IMPLEMENTING" });

    task = engine.apply(task, "pause", "human");
    expect(task.workflowState).toBe("PAUSED");
    expect(task.previousState).toBe("IMPLEMENTING");

    task = engine.apply(task, "resume", "human");
    expect(task.workflowState).toBe("IMPLEMENTING");
  });

  it("allows cancel from any active state", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    const task = makeTask({ workflowState: "REVIEWING" });
    const cancelled = engine.apply(task, "cancel", "human");
    expect(cancelled.workflowState).toBe("CANCELLED");
    expect(cancelled.finalStatus).toBe("cancelled");
  });

  it("reports available triggers for the current state", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    const task = makeTask({ workflowState: "AWAITING_APPROVAL" });
    expect(engine.availableTriggers(task).sort()).toEqual(["approve", "cancel", "fail", "pause", "reject"].sort());
  });

  // Regression for audit finding H1: a PAUSED task (e.g. one sitting on the security_review
  // approval gate) previously had no `cancel`/`fail` transition at all — only ACTIVE_STATES got
  // them. Confirmed failing before the fix with InvalidTransitionError.
  it("H1 regression: a PAUSED task can be cancelled directly, without resuming first", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    let task = makeTask({ workflowState: "REVIEWING" });
    task = engine.apply(task, "pause", "system", "awaiting security_review gate");
    expect(task.workflowState).toBe("PAUSED");

    const cancelled = engine.apply(task, "cancel", "human");
    expect(cancelled.workflowState).toBe("CANCELLED");
    expect(cancelled.finalStatus).toBe("cancelled");
  });

  it("H1 regression: a PAUSED task can also be failed directly", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    let task = makeTask({ workflowState: "IMPLEMENTING" });
    task = engine.apply(task, "pause", "human");
    task = engine.apply(task, "fail", "human", "operator gave up");
    expect(task.workflowState).toBe("FAILED");
  });

  it("PAUSED exposes cancel/fail (in addition to resume) as available triggers", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    const task = makeTask({ workflowState: "PAUSED", previousState: "REVIEWING" });
    const triggers = engine.availableTriggers(task);
    expect(triggers).toContain("cancel");
    expect(triggers).toContain("fail");
  });

  // Regression for audit finding H2: FAILED had no outgoing transition at all — any transient
  // provider error (a timeout, a rate limit) permanently killed the task. Confirmed failing
  // before the fix: engine.apply(failedTask, "retry", ...) threw InvalidTransitionError because
  // "retry" didn't even exist as a trigger.
  it("H2 regression: a FAILED task can retry back to exactly the state it failed from", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    let task = makeTask({ workflowState: "IMPLEMENTING" });
    task = engine.apply(task, "fail", { role: "implementer", providerId: "codex" }, "ECONNRESET");
    expect(task.workflowState).toBe("FAILED");
    expect(task.previousState).toBe("IMPLEMENTING");
    expect(task.finalStatus).toBe("failed");

    const retried = engine.apply(task, "retry", "human", "transient network error, retrying");
    expect(retried.workflowState).toBe("IMPLEMENTING");
    // finalStatus must not still claim "failed" once the task is active again.
    expect(retried.finalStatus).toBeUndefined();
  });

  it("H2 regression: retry is itself iteration-guarded and escalates to BLOCKED, not an infinite loop", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow(), {
      maxIterations: { failure_retry: 2 },
      defaultMaxIterations: 2
    });
    let task = makeTask({ workflowState: "IMPLEMENTING" });

    task = engine.apply(task, "fail", "system"); // failure 1
    task = engine.apply(task, "retry", "human"); // retry 1 -> IMPLEMENTING
    expect(task.workflowState).toBe("IMPLEMENTING");

    task = engine.apply(task, "fail", "system"); // failure 2
    task = engine.apply(task, "retry", "human"); // retry 2 -> IMPLEMENTING
    expect(task.workflowState).toBe("IMPLEMENTING");

    task = engine.apply(task, "fail", "system"); // failure 3
    const blocked = engine.apply(task, "retry", "human"); // retry 3 exceeds cap of 2 -> BLOCKED
    expect(blocked.workflowState).toBe("BLOCKED");
    expect(blocked.failures.at(-1)?.code).toBe("MAX_ITERATIONS");
  });

  it("retry from FAILED with no recorded previousState throws rather than silently no-op-ing", () => {
    const engine = new WorkflowEngine(buildDefaultWorkflow());
    const task = makeTask({ workflowState: "FAILED" }); // no previousState set
    expect(() => engine.apply(task, "retry", "human")).toThrow(InvalidTransitionError);
  });
});

describe("DEFAULT_WORKFLOW_LIMITS", () => {
  it("caps both retry loops and failure-retry at 3 by default", () => {
    expect(DEFAULT_WORKFLOW_LIMITS.maxIterations.test_fix).toBe(3);
    expect(DEFAULT_WORKFLOW_LIMITS.maxIterations.review_fix).toBe(3);
    expect(DEFAULT_WORKFLOW_LIMITS.maxIterations.failure_retry).toBe(3);
  });
});
