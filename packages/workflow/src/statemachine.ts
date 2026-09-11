import type { WorkflowState } from "@ai-engine/core";

export type Trigger =
  | "analyze"
  | "plan_ready"
  | "submit_for_approval"
  | "approve"
  | "reject"
  | "implemented"
  | "tests_passed"
  | "tests_failed"
  | "review_approved"
  | "review_findings"
  | "fixed"
  | "verified_pass"
  | "verified_fail"
  | "pause"
  | "resume"
  | "retry"
  | "cancel"
  | "fail"
  | "escalate";

export interface TransitionRule {
  from: WorkflowState;
  trigger: Trigger;
  to: WorkflowState;
  /** Name of the retry loop this transition participates in, if any (for iteration guarding). */
  loop?: string;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: WorkflowState,
    public readonly trigger: Trigger
  ) {
    super(`Invalid transition: cannot apply trigger "${trigger}" from state "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * A minimal, table-driven finite state machine. It holds no task data of its
 * own; @ai-engine/workflow's WorkflowEngine wraps this with persistence,
 * iteration guarding, and history recording.
 */
export class StateMachine {
  private readonly table = new Map<string, TransitionRule>();

  constructor(rules: TransitionRule[]) {
    for (const rule of rules) {
      this.table.set(key(rule.from, rule.trigger), rule);
    }
  }

  can(from: WorkflowState, trigger: Trigger): boolean {
    return this.table.has(key(from, trigger));
  }

  next(from: WorkflowState, trigger: Trigger): TransitionRule {
    const rule = this.table.get(key(from, trigger));
    if (!rule) throw new InvalidTransitionError(from, trigger);
    return rule;
  }

  availableTriggers(from: WorkflowState): Trigger[] {
    const triggers: Trigger[] = [];
    for (const rule of this.table.values()) {
      if (rule.from === from) triggers.push(rule.trigger);
    }
    return triggers;
  }
}

function key(from: WorkflowState, trigger: Trigger): string {
  return `${from}::${trigger}`;
}
