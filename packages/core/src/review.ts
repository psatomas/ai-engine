export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

export type ReviewDimension =
  "correctness" | "architecture" | "security" | "invariants" | "state_transitions" | "testing" | "maintainability";

export interface ReviewFinding {
  id: string;
  dimension: ReviewDimension;
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  summary: string;
  detail: string;
  suggestedFix?: string;
  /** Set by a later stage once a fix attempt has addressed (or explicitly rejected) this finding. */
  status: "open" | "fixed" | "wont_fix" | "disputed";
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
