import { ACTIVE_STATES, type WorkflowState } from "@ai-engine/core";
import { StateMachine, type TransitionRule } from "./statemachine.js";

/**
 * The default pipeline:
 *
 *   TASK_CREATED -> ANALYZING -> PLAN_READY -> AWAITING_APPROVAL -> IMPLEMENTING
 *   -> TESTING -> REVIEWING -> VERIFYING -> READY
 *
 * with FIXING as the shared repair step reached from a failing TESTING,
 * REVIEWING, or VERIFYING, and back to TESTING once a fix is applied. Two
 * named loops ("test_fix" and "review_fix") are iteration-guarded by the
 * engine so a stuck task escalates to BLOCKED instead of spinning forever.
 *
 * FAILED is not a table entry with static outgoing rules: like PAUSED's
 * `resume`, FAILED's `retry` trigger is special-cased in WorkflowEngine.apply
 * to return to whatever state was active immediately before the failure
 * (stored as `previousState`, same mechanism PAUSED uses), so a transient
 * provider error (a timeout, a rate limit) is recoverable by re-attempting
 * the same step rather than being a permanent dead end. `retry` is itself
 * iteration-guarded (loop "failure_retry") and escalates to BLOCKED after
 * repeated failures, so a *persistently* broken task still surfaces for a
 * human instead of retrying forever.
 */
const PIPELINE_RULES: TransitionRule[] = [
  { from: "TASK_CREATED", trigger: "analyze", to: "ANALYZING" },
  { from: "ANALYZING", trigger: "plan_ready", to: "PLAN_READY" },
  { from: "ANALYZING", trigger: "fail", to: "FAILED" },
  { from: "PLAN_READY", trigger: "submit_for_approval", to: "AWAITING_APPROVAL" },
  { from: "AWAITING_APPROVAL", trigger: "approve", to: "IMPLEMENTING" },
  { from: "AWAITING_APPROVAL", trigger: "reject", to: "PLAN_READY" },
  { from: "IMPLEMENTING", trigger: "implemented", to: "TESTING" },
  { from: "IMPLEMENTING", trigger: "fail", to: "FAILED" },
  { from: "TESTING", trigger: "tests_passed", to: "REVIEWING" },
  { from: "TESTING", trigger: "tests_failed", to: "FIXING", loop: "test_fix" },
  { from: "REVIEWING", trigger: "review_approved", to: "VERIFYING" },
  { from: "REVIEWING", trigger: "review_findings", to: "FIXING", loop: "review_fix" },
  { from: "FIXING", trigger: "fixed", to: "TESTING" },
  { from: "FIXING", trigger: "escalate", to: "BLOCKED" },
  { from: "VERIFYING", trigger: "verified_pass", to: "READY" },
  { from: "VERIFYING", trigger: "verified_fail", to: "FIXING", loop: "test_fix" },
  { from: "BLOCKED", trigger: "resume", to: "FIXING" },
  { from: "BLOCKED", trigger: "fail", to: "FAILED" },
  { from: "BLOCKED", trigger: "cancel", to: "CANCELLED" },
  { from: "IDLE", trigger: "analyze", to: "TASK_CREATED" },
  // PAUSED must be as controllable as any active state: a human waiting on an approval gate
  // can still decide to abandon the task outright, or hit an unexpected error while paused.
  // (`resume` from PAUSED is special-cased in WorkflowEngine.apply because its target is
  // dynamic — whatever state was active before the pause — so it has no static table entry.)
  { from: "PAUSED", trigger: "cancel", to: "CANCELLED" },
  { from: "PAUSED", trigger: "fail", to: "FAILED" }
];

/** pause/cancel/fail are legal from every active (non-terminal, non-paused) state. */
function controlRules(): TransitionRule[] {
  const rules: TransitionRule[] = [];
  for (const state of ACTIVE_STATES) {
    rules.push({ from: state, trigger: "pause", to: "PAUSED" });
    rules.push({ from: state, trigger: "cancel", to: "CANCELLED" });
    rules.push({ from: state, trigger: "fail", to: "FAILED" });
  }
  return rules;
}

export function buildDefaultWorkflow(): StateMachine {
  return new StateMachine([...PIPELINE_RULES, ...controlRules()]);
}

/**
 * PAUSED does not appear as a `from` in the table because its one legal
 * exit (`resume`) must return to whatever state was active before pausing,
 * which is task-specific data, not a static rule. WorkflowEngine special-
 * cases resume-from-PAUSED using the stored `previousState`.
 */
export const PAUSABLE_STATES: ReadonlySet<WorkflowState> = ACTIVE_STATES;
