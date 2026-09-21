import { describe, expect, it } from "vitest";
import type { CapacityWindow, ProviderCapacityInfo, TaskRecord, UsageEvent, VerificationCheck } from "@ai-engine/core";
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
  const nowMs = Date.parse("2026-09-21T12:00:00.000Z");
  const iso = (ms: number): string => new Date(ms).toISOString();
  const chr = (code: number): string => String.fromCharCode(code);
  const ESC = chr(27);
  const hasControl = (text: string): boolean =>
    Array.from(text).some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    });
  const observed = (usedFraction: number | undefined, id = "w"): CapacityWindow => ({
    id,
    usedFraction,
    observedAt: iso(nowMs - 600_000),
    resetsAt: iso(nowMs + 7_200_000)
  });
  const summary = (overrides: Partial<ProviderSummary> = {}): ProviderSummary => ({
    id: "acme",
    displayName: "Acme Agent",
    capabilities: [],
    roles: [],
    availability: { available: true },
    capacity: { status: "unknown" },
    ...overrides
  });
  const format = (summaries: ProviderSummary[], freshnessPolicy?: { maxAgeMs: number }): string =>
    formatProviderSummaries(summaries, { nowMs, freshnessPolicy });

  it("renders an empty registry without error", () => {
    expect(format([])).toMatch(/no providers registered/);
    expect(format([], { maxAgeMs: 900_000 })).toBe("(no providers registered)");
  });

  it("renders unknown capacity explicitly rather than omitting it", () => {
    const out = format([
      summary({
        capabilities: ["implement", "file_modification"],
        roles: ["implementer"],
        availability: { available: true, authenticated: true, version: "1.2.3" }
      })
    ]);
    expect(out).toContain("acme");
    expect(out).toContain("capacity:  unknown");
    expect(out).toContain("roles:     implementer");
    expect(out).toContain("capabilities: implement, file_modification");
    expect(out).toContain("available: true, authenticated: true, version: 1.2.3");
  });

  it("renders known capacity as its windows, with the plan label the provider itself reported", () => {
    const out = format([
      summary({
        capacity: { status: "known", windows: [observed(0.5)], account: { planLabel: "Pro" } }
      })
    ]);
    expect(out).toContain("capacity:  known, 1 window, plan: Pro");
    expect(out).toContain("50% used, 50% remaining (as observed)");
    expect(out).toContain("roles:     (none configured)");
    expect(out).not.toContain("quota windows reported");
  });

  it("surfaces an availability failure detail instead of hiding it", () => {
    const out = format([summary({ availability: { available: false, detail: "binary not found" } })]);
    expect(out).toContain("available: false");
    expect(out).toContain("detail:    binary not found");
  });

  it("renders every provider with its own roles and windows, and omits optional metadata the provider did not supply", () => {
    const acme = summary({
      capabilities: ["implement"],
      roles: ["implementer"],
      availability: { available: true, authenticated: true, version: "1.2.3" },
      capacity: { status: "known", windows: [observed(0.5, "acme-window")], account: { planLabel: "Pro" } }
    });
    const zenith = summary({
      id: "zenith",
      displayName: "Zenith Agent",
      capabilities: ["review"],
      roles: ["reviewer", "verifier"],
      capacity: { status: "known", windows: [observed(0.75, "zenith-window")] }
    });
    // Each provider's block starts at a header line (no indentation); everything else is indented.
    const blocks = format([acme, zenith]).split(/\n(?=\S)/);
    expect(blocks).toHaveLength(2);
    const [acmeBlock, zenithBlock] = blocks as [string, string];

    expect(acmeBlock).toMatch(/^acme /);
    expect(acmeBlock).toContain("roles:     implementer");
    expect(acmeBlock).not.toContain("reviewer");
    expect(acmeBlock).not.toContain("verifier");
    expect(acmeBlock).toContain("authenticated: true");
    expect(acmeBlock).toContain("plan: Pro");
    expect(acmeBlock).toContain("acme-window");
    expect(acmeBlock).toContain("50% used");
    expect(acmeBlock).not.toContain("zenith-window");
    expect(acmeBlock).not.toContain("75%");

    expect(zenithBlock).toMatch(/^zenith /);
    expect(zenithBlock).toContain("roles:     reviewer, verifier");
    expect(zenithBlock).not.toContain("implementer");
    expect(zenithBlock).not.toContain("authenticated:");
    expect(zenithBlock).not.toContain("version:");
    expect(zenithBlock).not.toContain("plan:");
    expect(zenithBlock).toContain("zenith-window");
    expect(zenithBlock).toContain("75% used");
    expect(zenithBlock).not.toContain("acme-window");
    expect(zenithBlock).not.toContain("50%");
  });

  it("renders every provider, and every window of every provider, not just the first", () => {
    const out = format([
      summary({
        id: "one",
        capacity: { status: "known", windows: [observed(0.1, "one-a"), observed(0.2, "one-b"), observed(0.3, "one-c")] }
      }),
      summary({ id: "two", capacity: { status: "known", windows: [observed(0.4, "two-a"), observed(0.5, "two-b")] } }),
      summary({ id: "three", capacity: { status: "unknown" } })
    ]);
    for (const id of ["one-a", "one-b", "one-c", "two-a", "two-b"]) expect(out).toContain(id);
    expect(out.split("\n").filter((line) => /^\S/.test(line))).toEqual(["one  (Acme Agent)", "two  (Acme Agent)", "three  (Acme Agent)"]);
    expect(out).toContain("30% used");
    expect(out).toContain("50% used");
  });

  it("keeps a report of full utilization distinct from unknown capacity, without claiming current capacity", () => {
    const exhausted = summary({ capacity: { status: "known", windows: [observed(1)] } });
    const unknown = summary({ id: "zenith", displayName: "Zenith Agent", capacity: { status: "unknown" } });
    const [exhaustedBlock, unknownBlock] = format([exhausted, unknown]).split(/\n(?=\S)/) as [string, string];

    expect(exhaustedBlock).toContain("100% used, 0% remaining (as observed)");
    expect(exhaustedBlock).not.toContain("usage:     unknown");
    expect(unknownBlock).toContain("capacity:  unknown");
    expect(unknownBlock).not.toMatch(/\d+%|window/);
  });

  it("preserves the failure detail of an unknown capacity", () => {
    expect(format([summary({ capacity: { status: "unknown", detail: "capacity-boom" } })])).toContain("capacity:  unknown (capacity-boom)");
  });

  it("never lets capacity change availability, or turn exhausted quota into unavailability", () => {
    const availabilityLine = (out: string): string => out.split("\n").find((line) => line.startsWith("    available:"))!;
    const capacities: ProviderCapacityInfo[] = [
      { status: "unknown" },
      { status: "known", windows: [observed(0)] },
      { status: "known", windows: [observed(1), observed(1.5, "x")] },
      { status: "known", windows: [] }
    ];
    const lines = capacities.map((capacity) =>
      availabilityLine(
        format([summary({ availability: { available: true, authenticated: true, version: "9" }, capacity })], { maxAgeMs: 900_000 })
      )
    );
    expect(new Set(lines)).toEqual(new Set(["    available: true, authenticated: true, version: 9"]));
    const exhausted = format([summary({ capacity: { status: "known", windows: [observed(1.5)] } })], { maxAgeMs: 900_000 });
    expect(exhausted).not.toMatch(/blocked|unavailable|exhausted|disabled|cannot|do not use/i);
  });

  it("does not modify the summaries it formats", () => {
    const summaries = [
      summary({
        id: `evil${ESC}[31m`,
        capacity: { status: "known", windows: [{ ...observed(0.5), label: `L${ESC}[0m\nx` }], account: { planLabel: "p\nq" } },
        availability: { available: true, detail: `d\r\n${ESC}[0m` }
      })
    ];
    const before = structuredClone(summaries);
    format(summaries, { maxAgeMs: 900_000 });
    format(summaries);
    expect(summaries).toEqual(before);
  });

  describe("presentation-boundary sanitization", () => {
    const hostile = summary({
      id: `evil${ESC}[31m-id\ninjected`,
      displayName: `Evil\n    capacity:  known, 99 windows\n    roles:     admin`,
      roles: [`role${ESC}]0;title${chr(7)}x`, "ok\trole"],
      availability: { available: true, version: `1.0${ESC}[2J`, detail: `line1\r\n    available: true\n${ESC}[31mred` },
      capacity: {
        status: "known",
        account: { planLabel: `pro${ESC}[0m\nplan: hacked` },
        windows: [
          {
            ...observed(0.5),
            id: `w${ESC}[31m\n    fake-window`,
            label: `${ESC}[1mBold\nLabel${chr(0x202e)}`
          }
        ]
      }
    });

    it("reaches the terminal with no control characters and no injected output lines", () => {
      const out = format([hostile], { maxAgeMs: 900_000 });
      for (const line of out.split("\n")) expect(hasControl(line)).toBe(false);
      expect(out.split("\n").filter((line) => line.startsWith("    capacity:  "))).toHaveLength(1);
      expect(out.split("\n").filter((line) => line.startsWith("    roles:     "))).toHaveLength(1);
      expect(out.split("\n").filter((line) => line.startsWith("    available: "))).toHaveLength(1);
      expect(out.split("\n").filter((line) => line.startsWith("    detail:    "))).toHaveLength(1);
      expect(out.split("\n").some((line) => line.trim().startsWith("fake-window"))).toBe(false);
      expect(out.split("\n").filter((line) => /^\S/.test(line))).toHaveLength(2); // header + legend only
    });

    it("keeps the readable text of each hostile value", () => {
      const out = format([hostile]);
      expect(out).toContain("evil-id injected");
      expect(out).toContain("role");
      expect(out).toContain("version: 1.0");
      expect(out).toContain("plan: pro plan: hacked");
      expect(out).toContain("Bold Label");
    });

    it("sanitizes an unknown capacity's diagnostic detail, and the availability detail", () => {
      const out = format([
        summary({
          capacity: { status: "unknown", detail: `${ESC}[31mboom\nfake: line` },
          availability: { available: false, detail: `${ESC}]0;t${chr(7)}bad\r\nnews` }
        })
      ]);
      expect(out).toContain("capacity:  unknown (boom fake: line)");
      expect(out).toContain("detail:    bad news");
      expect(hasControl(out.replace(/\n/g, ""))).toBe(false);
    });

    it("bounds an overlong identifier, label and detail with a deterministic marker", () => {
      const out = format([
        summary({
          id: "i".repeat(500),
          availability: { available: false, detail: "d".repeat(1000) },
          capacity: { status: "known", windows: [{ ...observed(0.5), id: "x".repeat(500), label: "l".repeat(500) }] }
        })
      ]);
      const ellipsis = chr(0x2026);
      const header = out.split("\n")[0]!;
      expect(header).toContain(`${"i".repeat(79)}${ellipsis}`);
      expect(header).not.toContain("i".repeat(80));
      const detail = out.split("\n").find((line) => line.startsWith("    detail:"))!;
      expect(detail).toContain(`${"d".repeat(239)}${ellipsis}`);
      expect(detail).not.toContain("d".repeat(240));
      const name = out.split("\n").find((line) => line.startsWith("      ") && !line.startsWith("        "))!;
      expect(name).toContain(`${"l".repeat(79)}${ellipsis}  [${"x".repeat(79)}${ellipsis}]`);
    });

    it("leaves ordinary Unicode labels readable", () => {
      const out = format([
        summary({
          displayName: "Ünïcode Agent 日本語",
          capacity: { status: "known", windows: [{ ...observed(0.5), id: "ウィンドウ-1", label: "5時間 (café 🙂)" }] }
        })
      ]);
      expect(out).toContain("(Ünïcode Agent 日本語)");
      expect(out).toContain("5時間 (café 🙂)  [ウィンドウ-1]");
    });

    it("falls back to a visible placeholder when an identifier sanitizes to nothing", () => {
      const out = format([
        summary({ capacity: { status: "known", windows: [{ ...observed(0.5), id: `${ESC}[31m\n`, label: `${chr(0)}` }] } })
      ]);
      expect(out).toContain("(empty id)");
    });
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
