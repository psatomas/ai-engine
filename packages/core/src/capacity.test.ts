import { describe, expect, it } from "vitest";
import { evaluateCapacityWindow } from "./capacity.js";
import type { CapacityWindow } from "./provider.js";

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
