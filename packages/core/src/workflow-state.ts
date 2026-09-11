/**
 * The full set of states a task can occupy. This is intentionally the
 * smallest model that lets us represent the default pipeline plus the
 * control states (pause/cancel/fail/block) every workflow needs — see
 * docs/workflow.md for the transition table and rationale.
 */
export type WorkflowState =
  | "IDLE"
  | "TASK_CREATED"
  | "ANALYZING"
  | "PLAN_READY"
  | "AWAITING_APPROVAL"
  | "IMPLEMENTING"
  | "TESTING"
  | "REVIEWING"
  | "FIXING"
  | "VERIFYING"
  | "READY"
  | "FAILED"
  | "PAUSED"
  | "CANCELLED"
  | "BLOCKED";

export const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set(["READY", "FAILED", "CANCELLED"]);

export const ACTIVE_STATES: ReadonlySet<WorkflowState> = new Set([
  "TASK_CREATED",
  "ANALYZING",
  "PLAN_READY",
  "AWAITING_APPROVAL",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "FIXING",
  "VERIFYING"
]);
