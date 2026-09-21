import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { describeCapacityWindow, evaluateCapacityWindow, type CapacityWindowFacts } from "./capacity.js";
import { remainingCapacityFraction, type CapacityWindow } from "./provider.js";

const now = Date.parse("2026-01-02T12:00:00.000Z");
const policy = { maxAgeMs: 1000 };
const iso = (ms: number) => new Date(ms).toISOString();
const windowAt = (overrides: Partial<CapacityWindow> = {}): CapacityWindow => ({
  id: "opaque",
  usedFraction: 0.25,
  observedAt: iso(now),
  resetsAt: iso(now + 10000),
  ...overrides
});

describe("evaluateCapacityWindow", () => {
  it.each([
    [0, "fresh", true],
    [999, "fresh", true],
    [1000, "stale", false],
    [1001, "stale", false],
    [-1, "invalid", false]
  ] as const)("evaluates observation age %s at the exact freshness boundary", (age, freshness, usable) => {
    const result = evaluateCapacityWindow(windowAt({ observedAt: iso(now - age) }), now, policy);
    expect(result.observationAgeMs).toBe(age);
    expect(result.freshness).toBe(freshness);
    expect(result.usable).toBe(usable);
    expect(result.reset).toBe("future");
    expect(result.remainingFraction).toBe(0.75);
  });

  it.each([
    [-1, "passed", false],
    [0, "passed", false],
    [1, "future", true]
  ] as const)("evaluates reset offset %s at the exact reset boundary", (offset, reset, usable) => {
    const result = evaluateCapacityWindow(windowAt({ resetsAt: iso(now + offset) }), now, policy);
    expect(result.reset).toBe(reset);
    expect(result.usable).toBe(usable);
    expect(result.freshness).toBe("fresh");
  });

  it.each([
    [undefined, "unknown", undefined, false],
    [0, "valid", 1, true],
    [1, "valid", 0, true],
    [1.5, "valid", 0, true],
    [-0.1, "invalid", undefined, false],
    [NaN, "invalid", undefined, false],
    [Infinity, "invalid", undefined, false],
    [-Infinity, "invalid", undefined, false]
  ] as const)("keeps utilization %s independent of time validity", (usedFraction, utilization, remaining, usable) => {
    const result = evaluateCapacityWindow(windowAt({ usedFraction }), now, policy);
    expect(result.utilization).toBe(utilization);
    expect(result.remainingFraction).toBe(remaining);
    expect(result.usable).toBe(usable);
    expect(result.freshness).toBe("fresh");
    expect(result.reset).toBe("future");
    expect(result.window.usedFraction).toBe(usedFraction);
  });

  it.each([undefined, "garbage", ""])("distinguishes missing/malformed observation %s", (observedAt) => {
    const result = evaluateCapacityWindow(windowAt({ observedAt }), now, policy);
    expect(result.freshness).toBe(observedAt === undefined ? "unknown" : "invalid");
    expect(result.observationAgeMs).toBeUndefined();
    expect(result.usable).toBe(false);
    expect(result.utilization).toBe("valid");
    expect(result.remainingFraction).toBe(0.75);
  });

  it.each([undefined, "garbage", ""])("distinguishes missing/malformed reset %s", (resetsAt) => {
    const result = evaluateCapacityWindow(windowAt({ resetsAt }), now, policy);
    expect(result.reset).toBe(resetsAt === undefined ? "unknown" : "invalid");
    expect(result.usable).toBe(resetsAt === undefined);
    expect(result.freshness).toBe("fresh");
  });

  it.each([
    "2026-01-02",
    "2026-01-02T12:00:00",
    "2026-02-30T12:00:00Z",
    "2025-02-29T12:00:00Z",
    "1900-02-29T12:00:00Z",
    "2026-00-01T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-01-00T12:00:00Z",
    "2026-01-02T24:00:00Z",
    "2026-01-02T12:60:00Z",
    "2026-01-02T12:00:60Z",
    "2026-01-02T12:00:00+24:00",
    "2026-01-02T12:00:00+01:60"
  ])("rejects ambiguous/calendar-invalid timestamp %s without throwing", (timestamp) => {
    const result = evaluateCapacityWindow(windowAt({ observedAt: timestamp, resetsAt: timestamp }), now, policy);
    expect(result.freshness).toBe("invalid");
    expect(result.reset).toBe("invalid");
    expect(result.observationAgeMs).toBeUndefined();
    expect(result.usable).toBe(false);
  });

  it("handles explicit offsets, fractional seconds, and leap years deterministically", () => {
    const result = evaluateCapacityWindow(
      windowAt({
        observedAt: "2026-01-02T09:00:00.000123-03:00",
        resetsAt: "2026-01-02T15:00:00.001+03:00"
      }),
      now,
      policy
    );
    expect(result.observationAgeMs).toBe(0);
    expect(result.usable).toBe(true);
    for (const year of [2000, 2024]) {
      const observedAt = `${year}-02-29T12:00:00Z`;
      expect(evaluateCapacityWindow(windowAt({ observedAt }), Date.parse(observedAt), policy).freshness).toBe("fresh");
    }
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid maxAgeMs %s", (maxAgeMs) => {
    expect(() => evaluateCapacityWindow(windowAt(), now, { maxAgeMs })).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity, 8640000000000001])("rejects invalid nowMs %s", (nowMs) => {
    expect(() => evaluateCapacityWindow(windowAt(), nowMs, policy)).toThrow(RangeError);
  });

  it("uses only the caller's age limit, never duration or time remaining until reset", () => {
    for (const durationSeconds of [undefined, 1, 18000, 604800]) {
      const window = windowAt({ observedAt: iso(now - 1000), durationSeconds });
      expect(evaluateCapacityWindow(window, now, { maxAgeMs: 1000 }).freshness).toBe("stale");
      expect(evaluateCapacityWindow(window, now, { maxAgeMs: 1001 }).freshness).toBe("fresh");
    }
  });

  it("does not replenish or mutate evidence when a reset passes", () => {
    const window = Object.freeze(windowAt({ usedFraction: 1.5, resetsAt: iso(now) }));
    const before = evaluateCapacityWindow(window, now - 1, policy);
    const after = evaluateCapacityWindow(window, now, policy);
    expect(before.reset).toBe("future");
    expect(after.reset).toBe("passed");
    expect(after.usable).toBe(false);
    expect(after.remainingFraction).toBe(0);
    expect(after.window).toBe(window);
    expect(window.usedFraction).toBe(1.5);
    expect(evaluateCapacityWindow(window, now, policy)).toEqual(after);
  });

  it("preserves simultaneous unknown utilization, stale evidence, and a passed reset", () => {
    const result = evaluateCapacityWindow(
      windowAt({ usedFraction: undefined, observedAt: iso(now - 1000), resetsAt: iso(now) }),
      now,
      policy
    );
    expect(result).toMatchObject({ utilization: "unknown", freshness: "stale", reset: "passed", usable: false });
    expect(result.remainingFraction).toBeUndefined();
  });
});

describe("describeCapacityWindow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [undefined, "unknown", undefined],
    [0, "valid", 1],
    [0.25, "valid", 0.75],
    [1, "valid", 0],
    [1.5, "valid", 0],
    [-0.1, "invalid", undefined],
    [NaN, "invalid", undefined],
    [Infinity, "invalid", undefined],
    [-Infinity, "invalid", undefined]
  ] as const)("interprets utilization %s as %s with remaining %s, independent of time validity", (usedFraction, utilization, remaining) => {
    for (const times of [{}, { observedAt: "garbage", resetsAt: "garbage" }, { observedAt: undefined, resetsAt: undefined }]) {
      const facts = describeCapacityWindow(windowAt({ usedFraction, ...times }), now);
      expect(facts.utilization).toBe(utilization);
      expect(facts.remainingFraction).toBe(remaining);
      expect(facts.remainingFraction).toBe(remainingCapacityFraction(usedFraction));
    }
  });

  it("keeps a genuine zero utilization known and never fabricates zero for missing utilization", () => {
    expect(describeCapacityWindow(windowAt({ usedFraction: 0 }), now)).toMatchObject({ utilization: "valid", remainingFraction: 1 });
    expect(describeCapacityWindow(windowAt({ usedFraction: undefined }), now)).toMatchObject({ utilization: "unknown" });
  });

  it("reports a missing observation as absent with no age", () => {
    const facts = describeCapacityWindow(windowAt({ observedAt: undefined }), now);
    expect(facts.observation).toBe("absent");
    expect(facts.observationAgeMs).toBeUndefined();
  });

  it.each([0, 1, 999, 1000, 86_400_000])("reports a valid observation %sms old with its exact signed age", (age) => {
    const facts = describeCapacityWindow(windowAt({ observedAt: iso(now - age) }), now);
    expect(facts.observation).toBe("reported");
    expect(facts.observationAgeMs).toBe(age);
  });

  it.each([-1, -1000, -86_400_000])("keeps a future observation reported with unclamped negative age %s", (age) => {
    const facts = describeCapacityWindow(windowAt({ observedAt: iso(now - age) }), now);
    expect(facts.observation).toBe("reported");
    expect(facts.observationAgeMs).toBe(age);
  });

  it.each([
    "garbage",
    "",
    "2026-01-02",
    "2026-01-02T12:00:00",
    "2026-02-30T12:00:00Z",
    "2026-01-02T24:00:00Z",
    "2026-01-02T12:00:00+24:00"
  ])("reports malformed observation %j as invalid with no age", (observedAt) => {
    const facts = describeCapacityWindow(windowAt({ observedAt }), now);
    expect(facts.observation).toBe("invalid");
    expect(facts.observationAgeMs).toBeUndefined();
  });

  it("reports a missing reset as unknown with no offset", () => {
    const facts = describeCapacityWindow(windowAt({ resetsAt: undefined }), now);
    expect(facts.reset).toBe("unknown");
    expect(facts.msUntilReset).toBeUndefined();
  });

  it.each([
    [-86_400_000, "passed"],
    [-1000, "passed"],
    [-1, "passed"],
    [0, "passed"],
    [1, "future"],
    [1000, "future"],
    [86_400_000, "future"]
  ] as const)("classifies a reset %sms from now as %s with the exact signed offset", (offset, reset) => {
    const facts = describeCapacityWindow(windowAt({ resetsAt: iso(now + offset) }), now);
    expect(facts.reset).toBe(reset);
    expect(facts.msUntilReset).toBe(offset);
  });

  it("treats a reset at exactly the clock as passed with a valid zero offset", () => {
    const facts = describeCapacityWindow(windowAt({ resetsAt: iso(now) }), now);
    expect(facts.reset).toBe("passed");
    expect(facts.msUntilReset).toBe(0);
  });

  it.each(["garbage", "", "2026-01-02", "2026-02-30T12:00:00Z", "2026-01-02T12:60:00Z", "2026-01-02T12:00:00+01:60"])(
    "reports malformed reset %j as invalid with no offset, without throwing",
    (resetsAt) => {
      const facts = describeCapacityWindow(windowAt({ resetsAt }), now);
      expect(facts.reset).toBe("invalid");
      expect(facts.msUntilReset).toBeUndefined();
    }
  );

  it("interprets observation, reset, and utilization independently of each other", () => {
    expect(describeCapacityWindow(windowAt({ observedAt: "garbage" }), now)).toMatchObject({
      observation: "invalid",
      reset: "future",
      msUntilReset: 10000,
      utilization: "valid"
    });
    expect(describeCapacityWindow(windowAt({ resetsAt: "garbage" }), now)).toMatchObject({
      observation: "reported",
      observationAgeMs: 0,
      reset: "invalid",
      utilization: "valid"
    });
    expect(describeCapacityWindow(windowAt({ usedFraction: -1 }), now)).toMatchObject({
      observation: "reported",
      reset: "future",
      utilization: "invalid"
    });
  });

  it("handles explicit offsets, fractional seconds, and leap years like the evaluator", () => {
    const facts = describeCapacityWindow(
      windowAt({ observedAt: "2026-01-02T09:00:00.000123-03:00", resetsAt: "2026-01-02T15:00:00.001+03:00" }),
      now
    );
    expect(facts.observationAgeMs).toBe(0);
    expect(facts.msUntilReset).toBe(1);
    for (const year of [2000, 2024]) {
      const observedAt = `${year}-02-29T12:00:00Z`;
      expect(describeCapacityWindow(windowAt({ observedAt }), Date.parse(observedAt)).observation).toBe("reported");
    }
    expect(describeCapacityWindow(windowAt({ observedAt: "1900-02-29T12:00:00Z" }), now).observation).toBe("invalid");
  });

  it.each([NaN, Infinity, -Infinity, 8640000000000001, -8640000000000001])("rejects invalid nowMs %s", (nowMs) => {
    expect(() => describeCapacityWindow(windowAt(), nowMs)).toThrow(RangeError);
    expect(() => describeCapacityWindow(windowAt(), nowMs)).toThrow("nowMs must be a finite representable Unix-millisecond timestamp");
  });

  it.each([0, -1, 8640000000000000, -8640000000000000])("accepts the representable clock %s", (nowMs) => {
    expect(() => describeCapacityWindow(windowAt(), nowMs)).not.toThrow();
  });

  it("has no implicit clock: its result depends only on its arguments", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    const first = describeCapacityWindow(windowAt({ observedAt: iso(now - 500), resetsAt: iso(now + 500) }), now);
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    const second = describeCapacityWindow(windowAt({ observedAt: iso(now - 500), resetsAt: iso(now + 500) }), now);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ observationAgeMs: 500, msUntilReset: 500 });
  });

  it("never lets duration or other window fields influence any fact", () => {
    const baseline = describeCapacityWindow(windowAt(), now);
    for (const durationSeconds of [undefined, 1, 18000, 604800]) {
      expect(describeCapacityWindow(windowAt({ durationSeconds, label: "anything", id: "other" }), now)).toEqual(baseline);
    }
  });

  it("does not mutate the evidence it interprets", () => {
    const window = Object.freeze(windowAt({ usedFraction: 1.5, resetsAt: iso(now) }));
    const before = { ...window };
    describeCapacityWindow(window, now);
    expect(window).toEqual(before);
  });

  it("contains exactly the policy-independent facts: neither freshness nor usable, at runtime or in the type", () => {
    const facts = describeCapacityWindow(windowAt(), now);
    expect(facts).not.toHaveProperty("freshness");
    expect(facts).not.toHaveProperty("usable");
    expect(facts).not.toHaveProperty("window");
    expect(Object.keys(facts).sort()).toEqual([
      "msUntilReset",
      "observation",
      "observationAgeMs",
      "remainingFraction",
      "reset",
      "utilization"
    ]);
    expectTypeOf<Extract<"freshness" | "usable" | "window", keyof CapacityWindowFacts>>().toEqualTypeOf<never>();
  });

  it("agrees with every overlapping evaluator field, and the evaluator's freshness follows only from the facts and the policy", () => {
    const stamps = [
      undefined,
      "garbage",
      "",
      "2026-02-30T12:00:00Z",
      ...[-100_000, -1001, -1000, -999, -1, 0, 1, 999, 1000, 1001, 100_000].map((offset) => iso(now + offset))
    ];
    let compared = 0;
    for (const usedFraction of [undefined, 0, 0.5, 1, 1.5, -1, NaN]) {
      for (const observedAt of stamps) {
        for (const resetsAt of stamps) {
          const window = windowAt({ usedFraction, observedAt, resetsAt });
          const facts = describeCapacityWindow(window, now);
          const evaluated = evaluateCapacityWindow(window, now, policy);
          expect(evaluated.utilization).toBe(facts.utilization);
          expect(evaluated.remainingFraction).toBe(facts.remainingFraction);
          expect(evaluated.observationAgeMs).toBe(facts.observationAgeMs);
          expect(evaluated.reset).toBe(facts.reset);
          const expectedFreshness =
            facts.observation === "absent"
              ? "unknown"
              : facts.observation === "invalid" || facts.observationAgeMs! < 0
                ? "invalid"
                : facts.observationAgeMs! < policy.maxAgeMs
                  ? "fresh"
                  : "stale";
          expect(evaluated.freshness).toBe(expectedFreshness);
          compared++;
        }
      }
    }
    expect(compared).toBe(7 * stamps.length * stamps.length);
  });
});
