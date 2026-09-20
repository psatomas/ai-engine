import { describe, expect, it } from "vitest";
import type { TaskRecord, UsageEvent, VerificationCheck } from "@ai-engine/core";
import type { ProviderSummary } from "@ai-engine/orchestrator";
import { formatProviderSummaries, formatTaskDetail, formatTaskUsage, formatVerificationChecks } from "./format.js";

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

describe("formatProviderSummaries", () => {
  it.each([
    [],
    [{ id: "a" }],
    [
      { id: "a", usedFraction: 0 },
      { id: "b", usedFraction: 1.25 }
    ]
  ])("summarizes independent windows without inventing current utilization or blocking", (...windows) => {
    const summary: ProviderSummary = {
      id: "acme",
      displayName: "Acme Agent",
      capabilities: [],
      roles: [],
      availability: { available: true },
      capacity: { status: "known", windows }
    };
    const out = formatProviderSummaries([summary]);
    expect(out).toContain(`known (${windows.length} quota windows reported)`);
    expect(out).not.toContain("% remaining");
    expect(out).not.toContain("blocked");
    expect(out).toContain("available: true");
  });

  it("renders an empty registry without error", () => {
    expect(formatProviderSummaries([])).toMatch(/no providers registered/);
  });

  it("renders unknown capacity explicitly rather than omitting it", () => {
    const summary: ProviderSummary = {
      id: "acme",
      displayName: "Acme Agent",
      capabilities: ["implement", "file_modification"],
      roles: ["implementer"],
      availability: { available: true, authenticated: true, version: "1.2.3" },
      capacity: { status: "unknown" }
    };
    const out = formatProviderSummaries([summary]);
    expect(out).toContain("acme");
    expect(out).toContain("capacity:  unknown");
    expect(out).toContain("roles:     implementer");
  });

  it("renders known capacity details, including a plan label reported by the provider itself", () => {
    const summary: ProviderSummary = {
      id: "acme",
      displayName: "Acme Agent",
      capabilities: ["implement"],
      roles: [],
      availability: { available: true },
      capacity: {
        status: "known",
        windows: [{ id: "a", usedFraction: 0.5, resetsAt: "2026-01-01T00:00:00.000Z" }],
        account: { planLabel: "Pro" }
      }
    };
    const out = formatProviderSummaries([summary]);
    expect(out).toContain("known (1 quota windows reported)");
    expect(out).not.toContain("% remaining");
    expect(out).not.toContain("resets:");
    expect(out).toContain("plan: Pro");
    expect(out).toContain("roles:     (none configured)");
  });

  it("surfaces an availability failure detail instead of hiding it", () => {
    const summary: ProviderSummary = {
      id: "acme",
      displayName: "Acme Agent",
      capabilities: [],
      roles: [],
      availability: { available: false, detail: "binary not found" },
      capacity: { status: "unknown" }
    };
    const out = formatProviderSummaries([summary]);
    expect(out).toContain("available: false");
    expect(out).toContain("detail:    binary not found");
  });

  it("renders every provider with its own roles, and omits optional metadata the provider did not supply", () => {
    const acme: ProviderSummary = {
      id: "acme",
      displayName: "Acme Agent",
      capabilities: ["implement"],
      roles: ["implementer"],
      availability: { available: true, authenticated: true, version: "1.2.3" },
      capacity: { status: "known", windows: [{ id: "a", usedFraction: 0.5 }], account: { planLabel: "Pro" } }
    };
    const zenith: ProviderSummary = {
      id: "zenith",
      displayName: "Zenith Agent",
      capabilities: ["review"],
      roles: ["reviewer", "verifier"],
      availability: { available: true },
      capacity: { status: "known", windows: [{ id: "b", usedFraction: 0.75 }] }
    };
    // Each provider's block starts at a header line (no indentation); everything else is indented.
    const blocks = formatProviderSummaries([acme, zenith]).split(/\n(?=\S)/);
    expect(blocks).toHaveLength(2);
    const [acmeBlock, zenithBlock] = blocks as [string, string];

    expect(acmeBlock).toMatch(/^acme /);
    expect(acmeBlock).toContain("roles:     implementer");
    expect(acmeBlock).not.toContain("reviewer");
    expect(acmeBlock).not.toContain("verifier");
    expect(acmeBlock).toContain("authenticated: true");
    expect(acmeBlock).toContain("plan: Pro");

    expect(zenithBlock).toMatch(/^zenith /);
    expect(zenithBlock).toContain("roles:     reviewer, verifier");
    expect(zenithBlock).not.toContain("implementer");
    expect(zenithBlock).not.toContain("authenticated:");
    expect(zenithBlock).not.toContain("version:");
    expect(zenithBlock).not.toContain("plan:");
  });

  it("keeps a report containing full utilization distinct from unknown without claiming current capacity", () => {
    const exhausted: ProviderSummary = {
      id: "acme",
      displayName: "Acme Agent",
      capabilities: ["implement"],
      roles: [],
      availability: { available: true },
      capacity: { status: "known", windows: [{ id: "a", usedFraction: 1 }] }
    };
    const unknown: ProviderSummary = {
      id: "zenith",
      displayName: "Zenith Agent",
      capabilities: ["implement"],
      roles: [],
      availability: { available: true },
      capacity: { status: "unknown" }
    };
    const [exhaustedBlock, unknownBlock] = formatProviderSummaries([exhausted, unknown]).split(/\n(?=\S)/) as [string, string];

    expect(exhaustedBlock).toContain("known (1 quota windows reported)");
    expect(exhaustedBlock).not.toContain("% remaining");
    expect(exhaustedBlock).not.toContain("unknown");
    expect(unknownBlock).toContain("capacity:  unknown");
    expect(unknownBlock).not.toContain("0% remaining");
  });

  it("preserves the failure detail of an unknown capacity", () => {
    const summary: ProviderSummary = {
      id: "acme",
      displayName: "Acme Agent",
      capabilities: ["implement"],
      roles: [],
      availability: { available: true },
      capacity: { status: "unknown", detail: "capacity-boom" }
    };
    expect(formatProviderSummaries([summary])).toContain("capacity:  unknown (capacity-boom)");
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
