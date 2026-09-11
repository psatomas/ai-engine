import type { TaskRecord, HistoryEvent } from "@ai-engine/core";
import { StateMachine, InvalidTransitionError, type Trigger } from "./statemachine.js";

export interface WorkflowLimits {
  /** Per-loop iteration cap, keyed by loop name (see default-workflow.ts). */
  maxIterations: Record<string, number>;
  defaultMaxIterations: number;
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxIterations: { test_fix: 3, review_fix: 3, failure_retry: 3 },
  defaultMaxIterations: 3
};

/** The iteration-guard loop name used for FAILED -> retry (see WorkflowEngine.apply). */
export const FAILURE_RETRY_LOOP = "failure_retry";

export class MaxIterationsExceededError extends Error {
  constructor(
    public readonly loop: string,
    public readonly limit: number
  ) {
    super(`Loop "${loop}" exceeded its configured limit of ${limit} iterations; task escalated to BLOCKED`);
    this.name = "MaxIterationsExceededError";
  }
}

/**
 * Applies triggers to a TaskRecord's workflowState using the supplied state
 * machine, enforcing loop iteration caps and recording an explicit,
 * append-only history. Never infers state from anything but the record
 * itself, so a task can be resumed correctly after a process restart purely
 * from what is on disk.
 */
export class WorkflowEngine {
  constructor(
    private readonly machine: StateMachine,
    private readonly limits: WorkflowLimits = DEFAULT_WORKFLOW_LIMITS
  ) {}

  canApply(task: TaskRecord, trigger: Trigger): boolean {
    if (trigger === "resume" && task.workflowState === "PAUSED") return Boolean(task.previousState);
    if (trigger === "retry" && task.workflowState === "FAILED") return Boolean(task.previousState);
    return this.machine.can(task.workflowState, trigger);
  }

  availableTriggers(task: TaskRecord): Trigger[] {
    return this.machine.availableTriggers(task.workflowState);
  }

  /**
   * Returns a new TaskRecord reflecting the transition. Throws
   * InvalidTransitionError for an illegal trigger and never mutates loop
   * counters or history on failure.
   */
  apply(task: TaskRecord, trigger: Trigger, actor: HistoryEvent["actor"], detail?: string): TaskRecord {
    const from = task.workflowState;

    if (trigger === "resume" && from === "PAUSED") {
      const to = task.previousState;
      if (!to) throw new InvalidTransitionError(from, trigger);
      return this.commit(task, to, trigger, actor, detail, undefined);
    }

    if (trigger === "retry" && from === "FAILED") {
      const to = task.previousState;
      if (!to) throw new InvalidTransitionError(from, trigger);
      const count = (task.iterationCounts[FAILURE_RETRY_LOOP] ?? 0) + 1;
      const max = this.limits.maxIterations[FAILURE_RETRY_LOOP] ?? this.limits.defaultMaxIterations;
      const iterationCounts = { ...task.iterationCounts, [FAILURE_RETRY_LOOP]: count };
      if (count > max) {
        const escalation = new MaxIterationsExceededError(FAILURE_RETRY_LOOP, max).message;
        return this.commit(task, "BLOCKED", trigger, actor, detail, iterationCounts, escalation);
      }
      return this.commit(task, to, trigger, actor, detail, iterationCounts);
    }

    const rule = this.machine.next(from, trigger);
    let to = rule.to;
    let iterationCounts = task.iterationCounts;
    let escalation: string | undefined;

    if (rule.loop) {
      const count = (task.iterationCounts[rule.loop] ?? 0) + 1;
      const max = this.limits.maxIterations[rule.loop] ?? this.limits.defaultMaxIterations;
      iterationCounts = { ...task.iterationCounts, [rule.loop]: count };
      if (count > max) {
        to = "BLOCKED";
        escalation = new MaxIterationsExceededError(rule.loop, max).message;
      }
    }

    return this.commit(task, to, trigger, actor, detail, iterationCounts, escalation);
  }

  private commit(
    task: TaskRecord,
    to: import("@ai-engine/core").WorkflowState,
    trigger: Trigger,
    actor: HistoryEvent["actor"],
    detail: string | undefined,
    iterationCounts: TaskRecord["iterationCounts"] | undefined,
    escalationNote?: string
  ): TaskRecord {
    const now = new Date().toISOString();
    const from = task.workflowState;
    const event: HistoryEvent = { at: now, from, to, trigger, actor, detail: escalationNote ?? detail };
    // PAUSED and FAILED both need to remember what was active immediately before them so their
    // one-level-deep "go back" trigger (resume / retry, respectively) has a dynamic target.
    const previousState = to === "PAUSED" || to === "FAILED" ? from : task.previousState;
    const next: TaskRecord = {
      ...task,
      workflowState: to,
      previousState,
      iterationCounts: iterationCounts ?? task.iterationCounts,
      history: [...task.history, event],
      updatedAt: now,
      // finalStatus only ever describes a terminal state; leaving one (e.g. FAILED -> retry ->
      // IMPLEMENTING) must clear a stale prior value, not carry it forward.
      finalStatus: to === "READY" ? "ready" : to === "FAILED" ? "failed" : to === "CANCELLED" ? "cancelled" : undefined
    };
    if (escalationNote) {
      next.failures = [...next.failures, { at: now, state: to, message: escalationNote, code: "MAX_ITERATIONS" }];
    }
    return next;
  }
}
