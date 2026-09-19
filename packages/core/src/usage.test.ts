import { describe, expect, it } from "vitest";
import { groupUsageEvents, subtractObservedUsage, summarizeUsageEvents, sumObservedUsage, type UsageEvent } from "./usage.js";

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { at: "2026-01-01T00:00:00.000Z", providerId: "acme", role: "implementer", operation: "implement", usage: {}, ...overrides };
}

describe("sumObservedUsage", () => {
  it("sums each dimension independently across multiple usages", () => {
    const result = sumObservedUsage([
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 20, outputTokens: 3, costUsd: 0.01 }
    ]);
    expect(result).toEqual({ inputTokens: 30, outputTokens: 8, costUsd: 0.01 });
  });

  it("leaves a dimension undefined — never a fabricated 0 — when nothing reported it", () => {
    const result = sumObservedUsage([{ inputTokens: 10 }, { inputTokens: 5 }]);
    expect(result.outputTokens).toBeUndefined();
    expect(result.reasoningOutputTokens).toBeUndefined();
    expect(result.cachedInputTokens).toBeUndefined();
    expect(result.cacheWriteInputTokens).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
    expect("outputTokens" in result).toBe(false);
  });

  it("sums only the entries that reported a dimension when others didn't (partial reporting)", () => {
    const result = sumObservedUsage([{ inputTokens: 10, outputTokens: 4 }, { inputTokens: 5 }, {}]);
    expect(result).toEqual({ inputTokens: 15, outputTokens: 4 });
  });

  it("returns an all-undefined object for an empty list, not a thrown error or a zeroed object", () => {
    expect(sumObservedUsage([])).toEqual({});
  });
});

describe("subtractObservedUsage — converting a cumulative-per-thread provider report into this invocation's own delta", () => {
  it("computes current - previous independently per dimension (the core fresh/resume worked example)", () => {
    // Matches the exact worked example: previous cumulative 100, current cumulative 150 -> 50.
    expect(subtractObservedUsage({ inputTokens: 150 }, { inputTokens: 100 })).toEqual({ inputTokens: 50 });
    // A second resume: previous cumulative 150, current cumulative 180 -> 30.
    expect(subtractObservedUsage({ inputTokens: 180 }, { inputTokens: 150 })).toEqual({ inputTokens: 30 });
  });

  it("computes every reported dimension consistently — tokens and cost alike", () => {
    const result = subtractObservedUsage(
      { inputTokens: 150, cachedInputTokens: 90, cacheWriteInputTokens: 10, outputTokens: 40, reasoningOutputTokens: 5, costUsd: 0.5 },
      { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 10, outputTokens: 25, reasoningOutputTokens: 2, costUsd: 0.2 }
    );
    expect(result).toEqual({
      inputTokens: 50,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 0,
      outputTokens: 15,
      reasoningOutputTokens: 3,
      costUsd: 0.3
    });
  });

  it("never derives a negative delta — omits the dimension instead of reporting a negative number", () => {
    // A "previous" baseline larger than "current" (a stale/mismatched baseline) must never produce -50.
    const result = subtractObservedUsage({ inputTokens: 100 }, { inputTokens: 150 });
    expect(result?.inputTokens).toBeUndefined();
  });

  it("omits a dimension present on only one side rather than treating the missing side as 0", () => {
    const result = subtractObservedUsage({ inputTokens: 150, outputTokens: 40 }, { inputTokens: 100 });
    expect(result).toEqual({ inputTokens: 50 });
    expect(result?.outputTokens).toBeUndefined();
  });

  it("a genuinely zero delta (identical cumulative totals) is preserved, not omitted — a real 0 is not 'unknown'", () => {
    expect(subtractObservedUsage({ inputTokens: 100 }, { inputTokens: 100 })).toEqual({ inputTokens: 0 });
  });

  it("returns undefined, not an all-undefined object, when nothing could be computed at all", () => {
    expect(subtractObservedUsage({}, {})).toBeUndefined();
    expect(subtractObservedUsage({ inputTokens: 100 }, {})).toBeUndefined();
  });
});

describe("summarizeUsageEvents", () => {
  it("counts invocations and sums usage across events", () => {
    const events = [event({ usage: { inputTokens: 10 } }), event({ usage: { inputTokens: 20, outputTokens: 5 } })];
    expect(summarizeUsageEvents(events)).toEqual({ invocations: 2, inputTokens: 30, outputTokens: 5 });
  });

  it("an event with a fully-empty usage object still counts as an invocation with no metrics", () => {
    const events = [event({ usage: {} })];
    const summary = summarizeUsageEvents(events);
    expect(summary.invocations).toBe(1);
    expect(summary.inputTokens).toBeUndefined();
  });
});

describe("groupUsageEvents", () => {
  it("groups generically by an arbitrary key function — no Claude/Codex/role-specific knowledge required", () => {
    const events = [
      event({ providerId: "acme", role: "implementer", operation: "implement", usage: { inputTokens: 10 } }),
      event({ providerId: "acme", role: "implementer", operation: "fix", usage: { inputTokens: 5 } }),
      event({ providerId: "zenith", role: "architect", operation: "analyze", usage: { inputTokens: 7 } })
    ];

    const byProvider = groupUsageEvents(events, (e) => e.providerId);
    expect(Object.keys(byProvider).sort()).toEqual(["acme", "zenith"]);
    expect(byProvider.acme).toEqual({ invocations: 2, inputTokens: 15 });
    expect(byProvider.zenith).toEqual({ invocations: 1, inputTokens: 7 });

    const byRoleOperation = groupUsageEvents(events, (e) => `${e.role}:${e.operation}`);
    expect(byRoleOperation["implementer:implement"]).toEqual({ invocations: 1, inputTokens: 10 });
    expect(byRoleOperation["implementer:fix"]).toEqual({ invocations: 1, inputTokens: 5 });
  });

  it("returns an empty record for an empty event list", () => {
    expect(groupUsageEvents([], (e) => e.role)).toEqual({});
  });
});
