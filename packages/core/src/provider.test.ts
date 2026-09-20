import { describe, expect, expectTypeOf, it } from "vitest";
import { remainingCapacityFraction, UNKNOWN_PROVIDER_CAPACITY, type ProviderCapacityInfo } from "./provider.js";

describe("remainingCapacityFraction", () => {
  it("excludes aggregate fractions and resets from the provider contract", () => {
    expectTypeOf<Extract<"remainingFraction" | "usedFraction" | "resetsAt", keyof ProviderCapacityInfo>>().toEqualTypeOf<never>();
  });

  it.each([
    [undefined, undefined],
    [0, 1],
    [0.25, 0.75],
    [1, 0],
    [1.25, 0],
    [-0.1, undefined],
    [NaN, undefined],
    [Infinity, undefined],
    [-Infinity, undefined]
  ])("derives remaining from %s as %s", (used, remaining) => {
    expect(remainingCapacityFraction(used)).toBe(remaining);
  });

  it("preserves independent historical windows without clamping utilization or replenishing after reset", () => {
    const capacity: ProviderCapacityInfo = {
      status: "known",
      windows: [
        { id: "a", usedFraction: 0, durationSeconds: 18000 },
        { id: "b", usedFraction: 1, durationSeconds: 604800 },
        { id: "c", usedFraction: 1.25, observedAt: "2000-01-01T00:00:00Z", resetsAt: "2000-01-02T00:00:00Z" },
        { id: "d" }
      ]
    };
    const before = structuredClone(capacity);
    expect(capacity.windows.map((window) => remainingCapacityFraction(window.usedFraction))).toEqual([1, 0, 0, undefined]);
    expect(capacity).toEqual(before);
    expect(UNKNOWN_PROVIDER_CAPACITY).toEqual({ status: "unknown" });
  });
});
