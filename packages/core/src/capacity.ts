import { remainingCapacityFraction, type CapacityWindow } from "./provider.js";

export interface CapacityFreshnessPolicy {
  /** Required finite positive observation-age limit in milliseconds; equality is stale. */
  maxAgeMs: number;
}

/**
 * Policy-independent interpretation of one capacity window at an explicit clock. Deliberately
 * contains no freshness, acceptable-age, or usability concept: those exist only once a caller
 * supplies a freshness policy (see `evaluateCapacityWindow`). Nothing here is an execution,
 * routing, or availability verdict.
 */
export interface CapacityWindowFacts {
  utilization: "valid" | "unknown" | "invalid";
  /** Historical remainder derived from valid utilization; never a replenishment prediction. */
  remainingFraction?: number;
  /** Whether the window reports a syntactically valid observation time, none, or a malformed one. */
  observation: "reported" | "absent" | "invalid";
  /** `nowMs - observedAtMs`, signed and unclamped; negative means the observation time is in the future. */
  observationAgeMs?: number;
  reset: "future" | "passed" | "unknown" | "invalid";
  /** `resetsAtMs - nowMs`, signed and unclamped; zero (like any non-positive value) corresponds to `passed`. */
  msUntilReset?: number;
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

function assertRepresentableClock(nowMs: number): void {
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new RangeError("nowMs must be a finite representable Unix-millisecond timestamp");
  }
}

/**
 * Pure, policy-independent interpretation of a window at an explicit Unix-millisecond clock.
 * Invalid `nowMs` throws RangeError; missing or malformed evidence is represented in the result,
 * never thrown. There is no implicit clock.
 *
 * A syntactically valid observation time in the future stays `reported` with a negative signed
 * age — declaring that evidence invalid is a freshness judgement and belongs to the evaluator.
 * Both signed offsets are unclamped. A reset at exactly `nowMs` is `passed` with `msUntilReset`
 * of zero. Window duration and reset time never feed any observation judgement here.
 */
export function describeCapacityWindow(window: CapacityWindow, nowMs: number): CapacityWindowFacts {
  assertRepresentableClock(nowMs);

  const remainingFraction = remainingCapacityFraction(window.usedFraction);
  const utilization = window.usedFraction === undefined ? "unknown" : remainingFraction === undefined ? "invalid" : "valid";

  let observation: CapacityWindowFacts["observation"] = "absent";
  let observationAgeMs: number | undefined;
  if (window.observedAt !== undefined) {
    const observedMs = timestampMs(window.observedAt);
    if (observedMs === undefined) observation = "invalid";
    else {
      observation = "reported";
      observationAgeMs = nowMs - observedMs;
    }
  }

  let reset: CapacityWindowFacts["reset"] = "unknown";
  let msUntilReset: number | undefined;
  if (window.resetsAt !== undefined) {
    const resetMs = timestampMs(window.resetsAt);
    if (resetMs === undefined) reset = "invalid";
    else {
      msUntilReset = resetMs - nowMs;
      reset = resetMs <= nowMs ? "passed" : "future";
    }
  }

  return { utilization, remainingFraction, observation, observationAgeMs, reset, msUntilReset };
}

/**
 * Pure evaluation at an explicit Unix-millisecond clock. Invalid clock/policy inputs throw
 * RangeError; missing or malformed evidence is represented in the result. No clock-skew grace
 * is assumed. Window duration never supplies a freshness threshold.
 *
 * Policy-independent interpretation comes from `describeCapacityWindow`; this function only
 * layers the caller's freshness policy and the resulting `usable` verdict on top of those facts.
 *
 * Missing reset information remains unknown and does not invalidate otherwise fresh evidence.
 * Only a passed or invalid reset prevents usability; unknown does not assert that no reset
 * occurred. Freshness, utilization, and historical remainder are reported independently.
 * "Usable" includes observed zero remaining and does not imply that a provider is available,
 * unblocked, or appropriate for any role.
 */
export function evaluateCapacityWindow(window: CapacityWindow, nowMs: number, policy: CapacityFreshnessPolicy): EvaluatedCapacityWindow {
  assertRepresentableClock(nowMs);
  if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0) {
    throw new RangeError("maxAgeMs must be finite and greater than zero");
  }

  const { utilization, remainingFraction, observation, observationAgeMs, reset } = describeCapacityWindow(window, nowMs);

  let freshness: EvaluatedCapacityWindow["freshness"] = "unknown";
  if (observation === "invalid") freshness = "invalid";
  else if (observation === "reported") {
    freshness = observationAgeMs! < 0 ? "invalid" : observationAgeMs! < policy.maxAgeMs ? "fresh" : "stale";
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
