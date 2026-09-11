export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

/** Well-known values, used in prompts as suggested categories — not an exhaustive/closed set, see ReviewDimension below for why. */
export const KNOWN_REVIEW_DIMENSIONS = [
  "correctness",
  "architecture",
  "security",
  "invariants",
  "state_transitions",
  "testing",
  "maintainability",
  "scope"
] as const;

/**
 * Deliberately `string`, not a closed union. This used to be a closed enum, and a real reviewer
 * invocation used "scope" — not in that enum — which zod-rejected. Because dimension sits inside
 * an array of findings, one finding with an unrecognized dimension failed validation for the
 * *entire* findings array, which failed the *entire* review output, silently discarding every
 * real finding from that round (degrading to raw text with zero structured findings, invisible in
 * normal operation since the pipeline just treated it as "changes requested, no specifics"). A
 * closed enum can never fully anticipate every label a model reasonably reaches for, so validating
 * dimension at all is a worse trade than not doing so: better to accept whatever the reviewer
 * calls it than to lose the entire finding. See ReviewFindingSchema in
 * @ai-engine/orchestrator/output-schemas.ts, which is the actual parse boundary this protects.
 */
export type ReviewDimension = string;

export interface ReviewFinding {
  id: string;
  dimension: ReviewDimension;
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  summary: string;
  detail: string;
  suggestedFix?: string;
  /**
   * "open": not yet addressed. "fix_attempted": the implementer ran a fix() pass while this was
   * open and reported success, but that is a claim, not independent confirmation — the same
   * fix() run also touches every other then-open finding across every past review round, whether
   * or not it actually looked at each one (see Orchestrator.fix()). Only a subsequent review
   * round, which re-examines the real diff from scratch, can upgrade a finding to genuinely
   * resolved — and it does that implicitly, by simply not reporting the same issue again, not by
   * ever flipping this field to some "confirmed_fixed" state. Treat "fix_attempted" as "unverified",
   * not "resolved". "wont_fix"/"disputed" are reserved for explicit human/agent dispute handling
   * (not currently set anywhere in this codebase).
   */
  status: "open" | "fix_attempted" | "fixed" | "wont_fix" | "disputed";
}

export interface ReviewReport {
  id: string;
  taskId: string;
  role: string;
  providerId: string;
  createdAt: string;
  verdict: "approved" | "changes_requested";
  findings: ReviewFinding[];
  summary: string;
}
