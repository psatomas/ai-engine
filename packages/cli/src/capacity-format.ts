import { describeCapacityWindow, evaluateCapacityWindow } from "@ai-engine/core";
import type { CapacityFreshnessPolicy, CapacityWindow, CapacityWindowFacts, ProviderCapacityInfo } from "@ai-engine/core";
import { DETAIL_MAX_CHARS, LABEL_MAX_CHARS, sanitizeDisplayText } from "./sanitize.js";

export interface CapacityFormatOptions {
  /** The single clock reading for this whole run, supplied by the caller; this module never reads a clock. */
  nowMs: number;
  /** Explicit caller policy. Absent means no freshness or evidence-usability verdict is produced or shown. */
  freshnessPolicy?: CapacityFreshnessPolicy;
}

export interface FormattedCapacity {
  lines: string[];
  /** How many windows were evaluated against a freshness policy (always 0 without one). */
  evaluatedWindows: number;
}

/** Printed once per command run, and only when at least one window was evaluated against a policy. */
export const USABLE_EVIDENCE_LEGEND = "usable evidence = passes the supplied freshness policy; not an execution or routing verdict";

const label = (text: string): string => sanitizeDisplayText(text, LABEL_MAX_CHARS);

// Beyond this a percentage stops being a useful diagnostic and could print as "Infinity".
const MAX_DISPLAYED_PERCENT = 1_000_000_000;

/**
 * One-decimal percentage of a fraction, without float noise (0.29 → "29%"). A value that is not
 * exactly zero never rounds to "0%", one below 100% never rounds to "100%", and one above 100%
 * never rounds down to "100%" — those extremes would misstate the evidence. Overage is not clamped.
 */
function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent === 0) return "0%";
  if (!Number.isFinite(percent) || percent > MAX_DISPLAYED_PERCENT) return `>${MAX_DISPLAYED_PERCENT}%`;
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return "<0.1%";
  if (percent < 100 && rounded >= 100) return ">99.9%";
  if (percent > 100 && rounded <= 100) return ">100%";
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** The two most significant non-zero units of a span, e.g. "10m", "2h 5m", "3d 12h", "1m 30s". Sign is the caller's concern. */
function formatSpan(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: Array<[number, string]> =
    days > 0
      ? [
          [days, "d"],
          [hours, "h"]
        ]
      : hours > 0
        ? [
            [hours, "h"],
            [minutes, "m"]
          ]
        : minutes > 0
          ? [
              [minutes, "m"],
              [seconds, "s"]
            ]
          : [[seconds, "s"]];
  return parts
    .filter(([value], index) => index === 0 || value > 0)
    .map(([value, unit]) => `${value}${unit}`)
    .join(" ");
}

/** A reported window length in its largest exact unit; a value that is not a finite positive number is flagged, never guessed at. */
function formatWindowLength(durationSeconds: number): string | undefined {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return undefined;
  for (const [size, unit] of [
    [86_400, "d"],
    [3600, "h"],
    [60, "m"]
  ] as const) {
    if (durationSeconds % size === 0) return `${durationSeconds / size}${unit}`;
  }
  return `${durationSeconds}s`;
}

function usageLine(window: CapacityWindow, facts: CapacityWindowFacts): string {
  // Raw utilization is presented from the window's own reported usedFraction, never from the derived
  // remainder, so an over-limit value stays visible as reported (117% used, 0% remaining).
  if (facts.utilization === "valid" && window.usedFraction !== undefined && facts.remainingFraction !== undefined) {
    return `usage:     ${formatPercent(window.usedFraction)} used, ${formatPercent(facts.remainingFraction)} remaining (as observed)`;
  }
  return `usage:     ${facts.utilization}`;
}

function observedLine(window: CapacityWindow, facts: CapacityWindowFacts): string {
  if (facts.observation === "absent") return "observed:  not reported";
  if (facts.observation === "invalid" || facts.observationAgeMs === undefined) return "observed:  invalid timestamp";
  const when = label(window.observedAt ?? "");
  return facts.observationAgeMs < 0
    ? `observed:  ${when} (${formatSpan(facts.observationAgeMs)} in the future)`
    : `observed:  ${when} (${formatSpan(facts.observationAgeMs)} ago)`;
}

function freshnessLine(
  freshness: "fresh" | "stale" | "unknown" | "invalid",
  facts: CapacityWindowFacts,
  policy: CapacityFreshnessPolicy
): string {
  const limit = `max age ${formatSpan(policy.maxAgeMs)}`;
  if (freshness === "fresh" || freshness === "stale") return `freshness: ${freshness} (${limit})`;
  if (freshness === "unknown") return "freshness: unknown (no observation time reported)";
  return facts.observation === "invalid"
    ? "freshness: invalid (observation time is malformed)"
    : "freshness: invalid (observation time is in the future)";
}

function resetLine(window: CapacityWindow, facts: CapacityWindowFacts): string {
  if (facts.reset === "unknown") return "resets:    not reported";
  if (facts.reset === "invalid" || facts.msUntilReset === undefined) return "resets:    invalid timestamp";
  const when = label(window.resetsAt ?? "");
  return facts.reset === "future"
    ? `resets:    ${when} (in ${formatSpan(facts.msUntilReset)})`
    : `resets:    ${when} (passed ${formatSpan(facts.msUntilReset)} ago)`;
}

function windowLines(window: CapacityWindow, options: CapacityFormatOptions): string[] {
  const facts = describeCapacityWindow(window, options.nowMs);
  const policy = options.freshnessPolicy;
  const evaluated = policy ? evaluateCapacityWindow(window, options.nowMs, policy) : undefined;

  const id = label(window.id) || "(empty id)";
  const name = window.label !== undefined && label(window.label) ? `${label(window.label)}  [${id}]` : id;
  const length = window.durationSeconds === undefined ? undefined : (formatWindowLength(window.durationSeconds) ?? "invalid");
  const lines = [
    `      ${name}${length === undefined ? "" : length === "invalid" ? "  window length invalid" : `  window ${length}`}`,
    `        ${usageLine(window, facts)}`,
    `        ${observedLine(window, facts)}`
  ];
  if (evaluated && policy) lines.push(`        ${freshnessLine(evaluated.freshness, facts, policy)}`);
  lines.push(`        ${resetLine(window, facts)}`);
  if (evaluated) lines.push(`        usable evidence: ${evaluated.usable ? "yes" : "no"}`);
  return lines;
}

/**
 * The capacity portion of one provider's block: a header line, then one independent group of lines
 * per window in the provider's own order. Windows are never aggregated, ranked, or summarized into a
 * provider-wide figure, and window ids are opaque — nothing here recognizes any provider or window name.
 * Unknown capacity keeps its existing one-line form and is never turned into windows or zeros.
 */
export function formatCapacity(capacity: ProviderCapacityInfo, options: CapacityFormatOptions): FormattedCapacity {
  if (capacity.status === "unknown") {
    return {
      lines: [`    capacity:  unknown${capacity.detail ? ` (${sanitizeDisplayText(capacity.detail, DETAIL_MAX_CHARS)})` : ""}`],
      evaluatedWindows: 0
    };
  }
  const count = capacity.windows.length;
  const header = [count === 0 ? "known, no windows reported" : `known, ${count} window${count === 1 ? "" : "s"}`];
  if (capacity.account?.planLabel) header.push(`plan: ${label(capacity.account.planLabel)}`);
  return {
    lines: [`    capacity:  ${header.join(", ")}`, ...capacity.windows.flatMap((window) => windowLines(window, options))],
    evaluatedWindows: options.freshnessPolicy ? count : 0
  };
}
