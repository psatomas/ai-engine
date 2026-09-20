import { remainingCapacityFraction, type CapacityWindow } from "./provider.js";

export interface CapacityFreshnessPolicy {
  /** Required finite positive observation-age limit in milliseconds; equality is stale. */
  maxAgeMs: number;
}

export interface EvaluatedCapacityWindow {
  /** Original historical evidence, never mutated by evaluation. */
  window: CapacityWindow;
  utilization: "valid" | "unknown" | "invalid";
  /** Historical remainder, even when unusable now; never a replenishment prediction. */
  remainingFraction?: number;
  /** Signed age at the supplied clock; negative age makes freshness invalid. */
  observationAgeMs?: number;
  freshness: "fresh" | "stale" | "unknown" | "invalid";
  reset: "future" | "passed" | "unknown" | "invalid";
  /** Valid utilization and fresh evidence, with no passed/invalid reset. Not an execution verdict. */
  usable: boolean;
}

/**
 * Accept full ISO timestamps with seconds and an explicit Z/numeric offset. Reject local-time,
 * date-only, and calendar-invalid values rather than relying on Date.parse's permissive rollover.
 * Fractional seconds are evaluated at JavaScript millisecond precision.
 */
function timestampMs(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHour, offsetMinute] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  )
    return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Pure evaluation at an explicit Unix-millisecond clock. Invalid clock/policy inputs throw
 * RangeError; missing or malformed evidence is represented in the result. No clock-skew grace
 * is assumed. Window duration never supplies a freshness threshold.
 *
 * Missing reset information remains unknown and does not invalidate otherwise fresh evidence.
 * Only a passed or invalid reset prevents usability; unknown does not assert that no reset
 * occurred. Freshness, utilization, and historical remainder are reported independently.
 * "Usable" includes observed zero remaining and does not imply that a provider is available,
 * unblocked, or appropriate for any role.
 */
export function evaluateCapacityWindow(window: CapacityWindow, nowMs: number, policy: CapacityFreshnessPolicy): EvaluatedCapacityWindow {
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new RangeError("nowMs must be a finite representable Unix-millisecond timestamp");
  }
  if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0) {
    throw new RangeError("maxAgeMs must be finite and greater than zero");
  }

  const remainingFraction = remainingCapacityFraction(window.usedFraction);
  const utilization = window.usedFraction === undefined ? "unknown" : remainingFraction === undefined ? "invalid" : "valid";

  let observationAgeMs: number | undefined;
  let freshness: EvaluatedCapacityWindow["freshness"] = "unknown";
  if (window.observedAt !== undefined) {
    const observedMs = timestampMs(window.observedAt);
    if (observedMs === undefined) freshness = "invalid";
    else {
      observationAgeMs = nowMs - observedMs;
      freshness = observationAgeMs < 0 ? "invalid" : observationAgeMs < policy.maxAgeMs ? "fresh" : "stale";
    }
  }

  let reset: EvaluatedCapacityWindow["reset"] = "unknown";
  if (window.resetsAt !== undefined) {
    const resetMs = timestampMs(window.resetsAt);
    reset = resetMs === undefined ? "invalid" : resetMs <= nowMs ? "passed" : "future";
  }

  return {
    window,
    utilization,
    remainingFraction,
    observationAgeMs,
    freshness,
    reset,
    usable: utilization === "valid" && freshness === "fresh" && reset !== "passed" && reset !== "invalid"
  };
}
