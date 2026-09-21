import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@ai-engine/core";
import type { CapacityWindow, ProviderCapacityInfo } from "@ai-engine/core";
import type { ProviderSummary } from "@ai-engine/orchestrator";
import { formatCapacity, USABLE_EVIDENCE_LEGEND } from "./capacity-format.js";
import { formatProviderSummaries } from "./format.js";

vi.mock("@ai-engine/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-engine/core")>();
  return {
    ...actual,
    describeCapacityWindow: vi.fn(actual.describeCapacityWindow),
    evaluateCapacityWindow: vi.fn(actual.evaluateCapacityWindow)
  };
});

const now = Date.parse("2026-09-21T12:00:00.000Z");
const minutes = (n: number): number => n * 60_000;
const hours = (n: number): number => n * 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const policy = { maxAgeMs: minutes(15) };

const win = (overrides: Partial<CapacityWindow> = {}): CapacityWindow => ({
  id: "w",
  usedFraction: 0.42,
  observedAt: iso(now - minutes(10)),
  resetsAt: iso(now + hours(2)),
  ...overrides
});
const known = (...windows: CapacityWindow[]): ProviderCapacityInfo => ({ status: "known", windows });
const render = (capacity: ProviderCapacityInfo, options: { freshnessPolicy?: { maxAgeMs: number } } = {}): string =>
  formatCapacity(capacity, { nowMs: now, ...options }).lines.join("\n");
const provider = (id: string, capacity: ProviderCapacityInfo): ProviderSummary => ({
  id,
  displayName: `${id} agent`,
  capabilities: ["implement"],
  roles: [],
  availability: { available: true },
  capacity
});

beforeEach(() => {
  vi.mocked(core.describeCapacityWindow).mockClear();
  vi.mocked(core.evaluateCapacityWindow).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("capacity windows without a freshness policy", () => {
  it("shows a Claude-like observed window's policy-independent facts and nothing else", () => {
    const window = win({ id: "five_hour", label: "5-hour", durationSeconds: 18000 });
    expect(render(known(window))).toBe(
      [
        "    capacity:  known, 1 window",
        "      5-hour  [five_hour]  window 5h",
        "        usage:     42% used, 58% remaining (as observed)",
        "        observed:  2026-09-21T11:50:00.000Z (10m ago)",
        "        resets:    2026-09-21T14:00:00.000Z (in 2h)"
      ].join("\n")
    );
  });

  it("shows a Codex-like window without an observation time, with no verdict of any kind", () => {
    const window = win({ id: "codex:primary", durationSeconds: 18000, usedFraction: 0.31, observedAt: undefined });
    expect(render(known(window))).toBe(
      [
        "    capacity:  known, 1 window",
        "      codex:primary  window 5h",
        "        usage:     31% used, 69% remaining (as observed)",
        "        observed:  not reported",
        "        resets:    2026-09-21T14:00:00.000Z (in 2h)"
      ].join("\n")
    );
  });

  it("renders every window independently, in the provider's own order, with no aggregate", () => {
    const out = render(
      known(
        win({ id: "z-last-alphabetically", usedFraction: 0.1, durationSeconds: 18000 }),
        win({ id: "a-first-alphabetically", usedFraction: 0.9, durationSeconds: 604800 }),
        win({ id: "m", usedFraction: 0.5 })
      )
    );
    const order = ["z-last-alphabetically", "a-first-alphabetically", "  m"].map((id) => out.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(out).toContain("known, 3 windows");
    expect(out).toContain("10% used, 90% remaining");
    expect(out).toContain("90% used, 10% remaining");
    expect(out).toContain("50% used, 50% remaining");
    expect(out).toContain("window 5h");
    expect(out).toContain("window 7d");
    expect(out).not.toMatch(/overall|total|worst|binding|combined|average/i);
  });

  it("never uses the window id or its shape to decide what to show", () => {
    const named = render(known(win({ id: "five_hour" })));
    const opaque = render(known(win({ id: "xyzzy" })));
    expect(named.replace("five_hour", "ID")).toBe(opaque.replace("xyzzy", "ID"));
  });

  it("omits the window length when none is reported and flags one that is not a usable number", () => {
    expect(render(known(win({ durationSeconds: undefined })))).not.toContain("window ");
    for (const durationSeconds of [0, -60, NaN, Infinity]) {
      expect(render(known(win({ durationSeconds })))).toContain("window length invalid");
    }
  });

  it.each([
    [18000, "5h"],
    [604800, "7d"],
    [2_592_000, "30d"],
    [3600, "1h"],
    [300, "5m"],
    [90, "90s"],
    [5400, "90m"],
    [1, "1s"]
  ])("renders a window length of %s seconds as %s", (durationSeconds, text) => {
    expect(render(known(win({ durationSeconds })))).toContain(`window ${text}`);
  });

  describe("utilization", () => {
    it.each([
      [0, "0% used, 100% remaining"],
      [0.29, "29% used, 71% remaining"],
      [0.57, "57% used, 43% remaining"],
      [0.255, "25.5% used, 74.5% remaining"],
      [1, "100% used, 0% remaining"]
    ])("presents reported utilization %s as %s without float noise", (usedFraction, text) => {
      expect(render(known(win({ usedFraction })))).toContain(`usage:     ${text} (as observed)`);
    });

    it("keeps an over-limit value visible as reported while its derived remainder is zero", () => {
      const out = render(known(win({ usedFraction: 1.17 })));
      expect(out).toContain("usage:     117% used, 0% remaining (as observed)");
      expect(out).not.toContain("100% used");
    });

    it.each([
      [0.0004, "<0.1% used, >99.9% remaining"],
      [0.9996, ">99.9% used, <0.1% remaining"],
      [1.0004, ">100% used, 0% remaining"],
      [1e12, ">1000000000% used, 0% remaining"]
    ])("never rounds the extreme %s to a misleading 0%% or 100%%", (usedFraction, text) => {
      expect(render(known(win({ usedFraction })))).toContain(`usage:     ${text} (as observed)`);
    });

    it("presents genuinely unknown utilization as unknown, never as zero", () => {
      const out = render(known(win({ usedFraction: undefined })));
      expect(out).toContain("usage:     unknown");
      expect(out).not.toMatch(/\d+% used/);
      expect(out).not.toContain("remaining");
    });

    it.each([-0.1, NaN, Infinity, -Infinity])("presents invalid utilization %s as invalid without printing the value", (usedFraction) => {
      const out = render(known(win({ usedFraction })));
      expect(out).toContain("usage:     invalid");
      expect(out).not.toMatch(/NaN|Infinity|-10%|\d+% used/);
    });
  });

  describe("observation", () => {
    it("says so when no observation time is reported", () => {
      expect(render(known(win({ observedAt: undefined })))).toContain("observed:  not reported");
    });

    it.each(["garbage", "", "2026-02-30T12:00:00Z", "2026-09-21"])(
      "flags a malformed observation time %j without echoing it",
      (observedAt) => {
        const out = render(known(win({ observedAt })));
        expect(out).toContain("observed:  invalid timestamp");
        const line = out.split("\n").find((candidate) => candidate.includes("observed:"))!;
        if (observedAt) expect(line).not.toContain(observedAt);
      }
    );

    it("keeps a future observation reported, showing how far ahead it is", () => {
      expect(render(known(win({ observedAt: iso(now + minutes(10)) })))).toContain(
        "observed:  2026-09-21T12:10:00.000Z (10m in the future)"
      );
    });

    it.each([
      [0, "0s ago"],
      [999, "0s ago"],
      [1000, "1s ago"],
      [minutes(1) + 30_000, "1m 30s ago"],
      [minutes(10), "10m ago"],
      [hours(2) + minutes(5), "2h 5m ago"],
      [hours(3), "3h ago"],
      [hours(84), "3d 12h ago"]
    ])("renders an observation age of %sms as %s", (age, text) => {
      expect(render(known(win({ observedAt: iso(now - age) })))).toContain(`(${text})`);
    });
  });

  describe("reset", () => {
    it("says so when no reset is reported", () => {
      expect(render(known(win({ resetsAt: undefined })))).toContain("resets:    not reported");
    });

    it("shows time until a future reset", () => {
      expect(render(known(win({ resetsAt: iso(now + hours(3) + minutes(48)) })))).toContain("(in 3h 48m)");
    });

    it("shows time since a passed reset, without predicting replenishment", () => {
      const out = render(known(win({ resetsAt: iso(now - hours(1)) })));
      expect(out).toContain("resets:    2026-09-21T11:00:00.000Z (passed 1h ago)");
      expect(out).toContain("42% used, 58% remaining (as observed)");
    });

    it("treats a reset at exactly the clock as passed", () => {
      expect(render(known(win({ resetsAt: iso(now) })))).toContain("(passed 0s ago)");
      expect(render(known(win({ resetsAt: iso(now + 1000) })))).toContain("(in 1s)");
    });

    it.each(["garbage", "", "2026-02-30T12:00:00Z"])("flags a malformed reset %j without echoing it", (resetsAt) => {
      const out = render(known(win({ resetsAt })));
      expect(out).toContain("resets:    invalid timestamp");
      const line = out.split("\n").find((candidate) => candidate.includes("resets:"))!;
      if (resetsAt) expect(line).not.toContain(resetsAt);
    });
  });

  it("produces no freshness or evidence-usability verdict, and never even evaluates a window", () => {
    const everything = known(
      win({ id: "recent", observedAt: iso(now - minutes(1)) }),
      win({ id: "old", observedAt: iso(now - hours(72)) }),
      win({ id: "no-observation", observedAt: undefined }),
      win({ id: "malformed", observedAt: "garbage" }),
      win({ id: "future", observedAt: iso(now + hours(1)) }),
      win({ id: "exhausted", usedFraction: 1.3 }),
      win({ id: "unknown-use", usedFraction: undefined }),
      win({ id: "passed", resetsAt: iso(now - minutes(5)) })
    );
    const out = formatProviderSummaries([provider("acme", everything)], { nowMs: now });
    expect(out).not.toMatch(/fresh|stale|usable|evidence|verdict/i);
    expect(out).not.toContain(USABLE_EVIDENCE_LEGEND);
    expect(core.evaluateCapacityWindow).not.toHaveBeenCalled();
    expect(core.describeCapacityWindow).toHaveBeenCalledTimes(8);
  });
});

describe("capacity windows with an explicit freshness policy", () => {
  it("adds freshness and evidence usability to a Claude-like observed window", () => {
    const window = win({ id: "five_hour", label: "5-hour", durationSeconds: 18000 });
    expect(render(known(window), { freshnessPolicy: policy })).toBe(
      [
        "    capacity:  known, 1 window",
        "      5-hour  [five_hour]  window 5h",
        "        usage:     42% used, 58% remaining (as observed)",
        "        observed:  2026-09-21T11:50:00.000Z (10m ago)",
        "        freshness: fresh (max age 15m)",
        "        resets:    2026-09-21T14:00:00.000Z (in 2h)",
        "        usable evidence: yes"
      ].join("\n")
    );
  });

  it("reports a Codex-like window with no observation time as unknown freshness and no usable evidence", () => {
    const window = win({ id: "codex:primary", durationSeconds: 18000, usedFraction: 0.31, observedAt: undefined });
    expect(render(known(window), { freshnessPolicy: policy })).toBe(
      [
        "    capacity:  known, 1 window",
        "      codex:primary  window 5h",
        "        usage:     31% used, 69% remaining (as observed)",
        "        observed:  not reported",
        "        freshness: unknown (no observation time reported)",
        "        resets:    2026-09-21T14:00:00.000Z (in 2h)",
        "        usable evidence: no"
      ].join("\n")
    );
  });

  it("never supplies a substitute observation time for a window that has none", () => {
    const out = render(known(win({ observedAt: undefined })), { freshnessPolicy: { maxAgeMs: 1e15 } });
    expect(out).toContain("freshness: unknown");
    expect(out).toContain("usable evidence: no");
    expect(out).not.toMatch(/fresh \(/);
    expect(out).not.toContain(iso(now));
  });

  it.each([
    [minutes(15) - 1, "fresh", "yes"],
    [minutes(15), "stale", "no"],
    [minutes(15) + 1, "stale", "no"],
    [0, "fresh", "yes"],
    [hours(3), "stale", "no"]
  ])("judges an observation %sms old as %s at the exact policy boundary", (age, freshness, usable) => {
    const out = render(known(win({ observedAt: iso(now - age) })), { freshnessPolicy: policy });
    expect(out).toContain(`freshness: ${freshness} (max age 15m)`);
    expect(out).toContain(`usable evidence: ${usable}`);
  });

  it("reports an unparseable observation time as invalid freshness, and a future one distinctly", () => {
    const malformed = render(known(win({ observedAt: "garbage" })), { freshnessPolicy: policy });
    expect(malformed).toContain("freshness: invalid (observation time is malformed)");
    expect(malformed).toContain("usable evidence: no");
    const future = render(known(win({ observedAt: iso(now + minutes(10)) })), { freshnessPolicy: policy });
    expect(future).toContain("freshness: invalid (observation time is in the future)");
    expect(future).toContain("usable evidence: no");
  });

  it.each([
    ["exhausted", 1],
    ["over the limit", 1.17]
  ])("keeps %s but fresh evidence usable: usable evidence is not available capacity", (_name, usedFraction) => {
    const out = render(known(win({ usedFraction })), { freshnessPolicy: policy });
    expect(out).toContain("0% remaining");
    expect(out).toContain("freshness: fresh");
    expect(out).toContain("usable evidence: yes");
  });

  it("keeps unused but stale evidence unusable: usable evidence does not follow remaining capacity", () => {
    const out = render(known(win({ usedFraction: 0, observedAt: iso(now - hours(3)) })), { freshnessPolicy: policy });
    expect(out).toContain("100% remaining");
    expect(out).toContain("usable evidence: no");
  });

  it.each([
    ["a passed reset", { resetsAt: iso(now - minutes(1)) }, "no"],
    ["a malformed reset", { resetsAt: "garbage" }, "no"],
    ["no reported reset", { resetsAt: undefined }, "yes"],
    ["unknown utilization", { usedFraction: undefined }, "no"],
    ["invalid utilization", { usedFraction: -1 }, "no"]
  ])("delegates the verdict for %s to the evaluator (usable evidence: %s)", (_name, overrides, usable) => {
    expect(render(known(win(overrides)), { freshnessPolicy: policy })).toContain(`usable evidence: ${usable}`);
  });

  it("uses only the caller's limit, never the window's duration or reset horizon", () => {
    const short = render(known(win({ durationSeconds: 1, resetsAt: iso(now + 1000) })), { freshnessPolicy: policy });
    const long = render(known(win({ durationSeconds: 604800, resetsAt: iso(now + hours(24 * 7)) })), { freshnessPolicy: policy });
    for (const out of [short, long]) expect(out).toContain("freshness: fresh (max age 15m)");
    expect(render(known(win()), { freshnessPolicy: { maxAgeMs: hours(2) } })).toContain("max age 2h");
  });

  it("evaluates each window with the supplied policy and still shows the policy-independent facts", () => {
    const out = render(known(win({ id: "a" }), win({ id: "b", observedAt: iso(now - hours(1)), usedFraction: 0.9 })), {
      freshnessPolicy: policy
    });
    expect(out).toContain("freshness: fresh");
    expect(out).toContain("freshness: stale");
    expect(out).toContain("42% used, 58% remaining");
    expect(out).toContain("90% used, 10% remaining");
    expect(vi.mocked(core.evaluateCapacityWindow).mock.calls.map((call) => call[2])).toEqual([policy, policy]);
  });

  describe("the usable-evidence legend", () => {
    it("appears exactly once per run, after every provider, however many windows are shown", () => {
      const out = formatProviderSummaries(
        [provider("one", known(win({ id: "a" }), win({ id: "b" }))), provider("two", known(win({ id: "c" }), win({ id: "d" })))],
        { nowMs: now, freshnessPolicy: policy }
      );
      expect(out.split(USABLE_EVIDENCE_LEGEND)).toHaveLength(2);
      expect(out.endsWith(`\n\n${USABLE_EVIDENCE_LEGEND}`)).toBe(true);
      expect(USABLE_EVIDENCE_LEGEND).toBe("usable evidence = passes the supplied freshness policy; not an execution or routing verdict");
    });

    it("is not printed without a policy, nor when there was nothing to evaluate", () => {
      expect(formatProviderSummaries([provider("one", known(win()))], { nowMs: now })).not.toContain("usable evidence =");
      expect(formatProviderSummaries([provider("one", { status: "unknown" })], { nowMs: now, freshnessPolicy: policy })).not.toContain(
        "usable evidence"
      );
      expect(formatProviderSummaries([provider("one", known())], { nowMs: now, freshnessPolicy: policy })).not.toContain("usable evidence");
    });
  });
});

describe("unknown provider capacity", () => {
  it("keeps the existing one-line form and never invents windows or zero capacity", () => {
    for (const freshnessPolicy of [undefined, policy]) {
      const formatted = formatCapacity({ status: "unknown" }, { nowMs: now, freshnessPolicy });
      expect(formatted).toEqual({ lines: ["    capacity:  unknown"], evaluatedWindows: 0 });
    }
  });

  it("preserves the diagnostic detail, with or without a policy", () => {
    for (const freshnessPolicy of [undefined, policy]) {
      expect(render({ status: "unknown", detail: "Codex capacity source is absent" }, { freshnessPolicy })).toBe(
        "    capacity:  unknown (Codex capacity source is absent)"
      );
    }
  });

  it("does not become known, evaluated, or zero because a policy was supplied", () => {
    const out = formatProviderSummaries([provider("acme", { status: "unknown", detail: "capacity-boom" })], {
      nowMs: now,
      freshnessPolicy: policy
    });
    expect(out).toContain("capacity:  unknown (capacity-boom)");
    expect(out).not.toMatch(/known,|window|\d+%|freshness|usable/);
    expect(core.evaluateCapacityWindow).not.toHaveBeenCalled();
    expect(core.describeCapacityWindow).not.toHaveBeenCalled();
  });

  it("reports a known provider that lists no windows as such, not as unknown or empty capacity", () => {
    expect(render(known())).toBe("    capacity:  known, no windows reported");
  });

  it("pluralizes the window count", () => {
    expect(render(known(win()))).toContain("known, 1 window\n");
    expect(render(known(win({ id: "a" }), win({ id: "b" })))).toContain("known, 2 windows");
  });

  it("shows the provider-stated plan label on the capacity line", () => {
    expect(render({ status: "known", windows: [win()], account: { planLabel: "plus" } })).toContain(
      "capacity:  known, 1 window, plan: plus"
    );
  });
});

describe("a single explicit clock for the whole run", () => {
  const providers = [
    provider("one", known(win({ id: "a" }), win({ id: "b", observedAt: undefined }), win({ id: "c", resetsAt: "garbage" }))),
    provider("two", known(win({ id: "d" }), win({ id: "e", usedFraction: undefined }))),
    provider("three", { status: "unknown" })
  ];

  it("hands every window of every provider the same supplied nowMs, for facts and for evaluation", () => {
    formatProviderSummaries(providers, { nowMs: now, freshnessPolicy: policy });
    const described = vi.mocked(core.describeCapacityWindow).mock.calls;
    const evaluated = vi.mocked(core.evaluateCapacityWindow).mock.calls;
    expect(described).toHaveLength(5);
    expect(evaluated).toHaveLength(5);
    expect(new Set([...described, ...evaluated].map((call) => call[1]))).toEqual(new Set([now]));
  });

  it("never reads the system clock while formatting", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("formatter read the system clock");
    });
    expect(() => formatProviderSummaries(providers, { nowMs: now, freshnessPolicy: policy })).not.toThrow();
    expect(() => formatProviderSummaries(providers, { nowMs: now })).not.toThrow();
    expect(clock).not.toHaveBeenCalled();
  });

  it("produces identical output whatever the system time is, and shifts ages only with the supplied nowMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    const early = formatProviderSummaries(providers, { nowMs: now, freshnessPolicy: policy });
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    const late = formatProviderSummaries(providers, { nowMs: now, freshnessPolicy: policy });
    expect(late).toBe(early);
    const later = formatProviderSummaries(providers, { nowMs: now + minutes(20), freshnessPolicy: policy });
    expect(later).not.toBe(early);
    expect(later).toContain("(30m ago)");
  });
});
