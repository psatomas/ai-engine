import { describe, expect, it } from "vitest";
import type { TaskRecord, UsageEvent, VerificationCheck } from "@ai-engine/core";
import { formatTaskDetail, formatTaskUsage, formatVerificationChecks } from "./format.js";

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

describe("formatVerificationChecks", () => {
  it("points an unapproved repository-configured check at the real `ai approve-check` command, not a nonexistent `ai checks ... approve`", () => {
    const check: VerificationCheck & { approved: boolean } = {
      id: "custom.integration",
      description: "custom integration check",
      command: "npm run test:integration",
      requiredForReady: true,
      origin: "repository_configured",
      approved: false
    };
    const out = formatVerificationChecks([check]);
    expect(out).toContain("ai approve-check <taskId> custom.integration");
    expect(out).not.toMatch(/ai checks .*approve/);
  });
});

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

describe("formatTaskUsage", () => {
  function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
    return { at: "2026-01-01T00:00:00.000Z", providerId: "claude", role: "implementer", operation: "implement", usage: {}, ...overrides };
  }

  it("says plainly when there is no recorded usage, rather than an empty table", () => {
    const task = makeTask({ usageEvents: [] });
    expect(formatTaskUsage(task)).toMatch(/no recorded usage/);
  });

  it("groups by provider, then role — with a distinct 'fixer' label for fix() invocations of the implementer role", () => {
    const task = makeTask({
      usageEvents: [
        usageEvent({
          providerId: "claude",
          role: "implementer",
          operation: "implement",
          usage: { inputTokens: 12345, outputTokens: 1200 }
        }),
        usageEvent({ providerId: "claude", role: "implementer", operation: "fix", usage: { inputTokens: 2001, outputTokens: 340 } }),
        usageEvent({ providerId: "codex", role: "architect", operation: "analyze", usage: {} }),
        usageEvent({ providerId: "codex", role: "reviewer", operation: "review", usage: {} })
      ]
    });
    const out = formatTaskUsage(task);
    expect(out).toContain("claude");
    expect(out).toContain("codex");
    expect(out).toContain("implementer");
    expect(out).toContain("fixer");
    expect(out).not.toMatch(/\bfix\b/); // the raw operation string never leaks into the label itself
    expect(out).toContain("input: 12,345");
    expect(out).toContain("output: 1,200");
  });

  it("never prints a fabricated 0 for an unreported metric — says so explicitly", () => {
    const task = makeTask({ usageEvents: [usageEvent({ providerId: "codex", role: "architect", usage: {} })] });
    const out = formatTaskUsage(task);
    expect(out).toContain("(no usage metrics reported)");
    expect(out).not.toMatch(/input: 0/);
  });

  it("renders a genuinely reported zero as a known metric — never as unknown", () => {
    const task = makeTask({
      usageEvents: [usageEvent({ providerId: "claude", role: "verifier", operation: "verify", usage: { inputTokens: 0, outputTokens: 0 } })]
    });
    const out = formatTaskUsage(task);
    expect(out).toContain("input: 0");
    expect(out).toContain("output: 0");
    expect(out).not.toContain("(no usage metrics reported)");
  });

  it("renders a task total derived from the events, including invocation count and provider count", () => {
    const task = makeTask({
      usageEvents: [
        usageEvent({ providerId: "claude", usage: { inputTokens: 10 } }),
        usageEvent({ providerId: "codex", role: "architect", usage: { inputTokens: 5 } })
      ]
    });
    const out = formatTaskUsage(task);
    expect(out).toContain("Task total: 2 invocations across 2 providers");
    expect(out).toContain("input: 15");
  });

  it("singularizes '1 invocation' and '1 provider'", () => {
    const task = makeTask({ usageEvents: [usageEvent({ usage: { inputTokens: 1 } })] });
    const out = formatTaskUsage(task);
    expect(out).toContain("Task total: 1 invocation across 1 provider —");
  });
});
