import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@ai-engine/core";
import { formatTaskDetail } from "./format.js";

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "t-test-0001",
    repository: { root: "/repo" },
    workspaceFolder: "/repo",
    originalRequest: "Fix ModuleRegistry.removeModule",
    workflowState: "TASK_CREATED",
    agentsUsed: [],
    git: { branch: "main", commit: "abc123def456", dirtyAtStart: false, untrackedAtStart: [] },
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

describe("formatTaskDetail's 'Next action' rendering", () => {
  it("TASK_CREATED points at `ai plan`", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "TASK_CREATED" }));
    expect(out).toContain("Next action:");
    expect(out).toContain("ai plan t-test-0001");
  });

  it("AWAITING_APPROVAL points at `ai approve`", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "AWAITING_APPROVAL" }));
    expect(out).toContain("Review the plan and approve it.");
    expect(out).toContain("ai approve t-test-0001");
  });

  it("PAUSED with a pendingGate names the exact gate and points at `ai gate`", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "PAUSED", pendingGate: "security_review" }));
    expect(out).toContain("security_review requires human approval.");
    expect(out).toContain("ai gate t-test-0001 security_review");
  });

  it("FAILED points at `ai retry`", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "FAILED" }));
    expect(out).toContain("ai retry t-test-0001");
  });

  it("BLOCKED offers only resume/cancel — retry is illegal from BLOCKED (legal only from FAILED)", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "BLOCKED" }));
    expect(out).toContain("ai resume t-test-0001");
    expect(out).toContain("ai cancel t-test-0001");
    expect(out).not.toMatch(/ai retry/);
  });

  it("READY points at `ai diff`, not merge/push", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "READY" }));
    expect(out).toContain("Task is READY. Inspect the diff before merging.");
    expect(out).toContain("ai diff t-test-0001");
    expect(out).not.toMatch(/merge|push/i);
  });

  it("CANCELLED has no next-action suggestion", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "CANCELLED" }));
    expect(out).not.toContain("Next action:");
  });

  it("a mid-pipeline active state (e.g. IMPLEMENTING) points at `ai run`", () => {
    const out = formatTaskDetail(makeTask({ workflowState: "IMPLEMENTING" }));
    expect(out).toContain("ai run t-test-0001");
  });
});
