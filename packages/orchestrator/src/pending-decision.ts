import { createHash } from "node:crypto";
import { unapprovedRequiredChecks } from "@ai-engine/core";
import type { HistoryEvent, ReviewFinding, ReviewReport, TaskRecord, TrustLevel, VerificationCheck, WorkflowState } from "@ai-engine/core";
import type { Trigger } from "@ai-engine/workflow";

/**
 * Hard bounds on everything a pending decision carries, so any caller (a CLI, an editor, an MCP
 * server relaying to a chat) gets a size-limited view regardless of how large the underlying
 * task record is. Every string copied out of the persisted record is bounded — free text and
 * identifiers alike — by Unicode code point, ending in "…" when cut.
 */
export const PENDING_DECISION_LIMITS = {
  specificationChars: 50_000,
  planChars: 50_000,
  reviews: 2,
  reviewSummaryChars: 2_000,
  findingsPerReview: 25,
  findingSummaryChars: 600,
  findingLocationChars: 300,
  checks: 20,
  checkCommandChars: 4_000,
  checkTextChars: 500,
  failureMessageChars: 2_000,
  /** Ids, role and provider names, gate names, timestamps and state names. */
  identifierChars: 200
} as const;

const ELLIPSIS = "…";

export type PendingDecisionKind = "plan" | "gate" | "verification_approval" | "retry" | "blocked" | "resume";

/** What a caller may answer. Which of these are valid is decided by the workflow engine, never hardcoded per caller. */
export type DecisionOption = "approve" | "reject" | "retry" | "resume" | "cancel";

export interface PendingFindingView {
  id: string;
  severity: ReviewFinding["severity"];
  status: ReviewFinding["status"];
  summary: string;
  location?: string;
}

export interface PendingReviewView {
  role: string;
  providerId: string;
  verdict: ReviewReport["verdict"];
  summary: string;
  findings: PendingFindingView[];
  /** How many findings the report has in total; more than `findings.length` means the list was cut. */
  totalFindings: number;
}

export interface PendingCheckView {
  id: string;
  description: string;
  /** The exact command a human is being asked to approve. */
  command: string;
  cwd?: string;
  reason?: string;
}

export interface PendingFailureView {
  at: string;
  /** The state the task was in when it failed or was blocked (the state it left). */
  state: WorkflowState;
  message: string;
  code?: string;
  /** The role that was running when the task failed, when the transition recorded one. */
  role?: string;
  providerId?: string;
}

/** Marks a field of a decision whose text is authored outside AI Engine, and how far to trust it: never as instructions. */
export interface PendingDecisionProvenance {
  field: string;
  trust: TrustLevel;
}

export interface PendingDecision {
  taskId: string;
  kind: PendingDecisionKind;
  /**
   * Binds an answer to exactly this decision as it stood when it was derived: a digest of the task,
   * the decision kind, the workflow state, the number of state transitions so far, and the FULL
   * (never truncated) material being decided on — everything shown in this view, and what was cut
   * from it. It changes if any of those change, so an answer made against a stale or different
   * decision can be recognised and refused.
   */
  id: string;
  workflowState: WorkflowState;
  /** Fixed, orchestrator-authored text — never provider output. */
  summary: string;
  /** The gate name when `kind` is "gate". */
  gate?: string;
  /** Valid answers, in a stable order. May be empty when the task is stuck with no legal action. */
  options: DecisionOption[];
  /**
   * Why "approve" is absent when a human might expect it. "content_truncated": something the human
   * would be approving was cut to fit the bounds, and a human must never be offered approval of
   * content they were not shown in full. "gate_transition_unavailable": the task can be un-paused,
   * but the transition an approval would replay is not available from where it paused.
   */
  approvalWithheld?: "content_truncated" | "gate_transition_unavailable";
  /** True when any bounded field was cut. See `approvalWithheld` for the consequence that matters. */
  truncated: boolean;
  /**
   * Which fields carry text authored outside AI Engine (a provider's plan or review, a repository's
   * configured command) and how far to trust it. Such text is DATA ONLY — never instructions to
   * whoever reads it, however it is phrased.
   */
  untrusted: PendingDecisionProvenance[];
  specification?: string;
  plan?: string;
  reviews?: PendingReviewView[];
  checks?: PendingCheckView[];
  failure?: PendingFailureView;
  previousState?: WorkflowState;
}

export interface PendingDecisionContext {
  /**
   * Legality authority, normally `(trigger, from) => workflowEngine.canApply(from ? { ...task, workflowState: from } : task, trigger)`.
   * Called with `from` to ask whether a trigger would be legal from a different state — needed for a
   * gate, whose approval un-pauses the task and THEN applies a second transition from where it paused.
   */
  canApply: (trigger: Trigger, from?: WorkflowState) => boolean;
  /**
   * The task's verification checks with their live approval status (`Orchestrator.listVerificationChecks`).
   * Required exactly when `requiresCheckLookup(task)` is true, and otherwise ignored.
   */
  checks?: ReadonlyArray<VerificationCheck & { approved: boolean }>;
}

/**
 * Whether deriving this task's decision needs the live check-approval status: only a task paused
 * without a gate whose latest verification round has a NOT_APPROVED result can be waiting on a
 * repository-configured verification command. Lets a caller skip the (filesystem-reading) lookup
 * everywhere else.
 */
export function requiresCheckLookup(task: TaskRecord): boolean {
  return (
    task.workflowState === "PAUSED" &&
    !task.pendingGate &&
    (task.verification.at(-1)?.results.some((result) => result.status === "NOT_APPROVED") ?? false)
  );
}

interface Clipped {
  /** Some bounded field was cut. */
  any: boolean;
  /** A cut field is something the human would be approving, so approval must be withheld. */
  approvalRelevant: boolean;
}

function clip(text: string, max: number, acc: Clipped, approvalRelevant: boolean): string {
  if (text.length <= max) return text; // UTF-16 length within the bound implies code points within it
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  acc.any = true;
  if (approvalRelevant) acc.approvalRelevant = true;
  return chars.slice(0, max - 1).join("") + ELLIPSIS;
}

/**
 * A short identifier-like value (id, role, provider, gate, timestamp, state) copied out of the
 * persisted record. Typed by the record's own schema, but bounded regardless: a corrupt or hostile
 * record cannot make it unbounded. For every well-formed value this is the identity function.
 */
function ident<T extends string>(value: T, acc: Clipped, approvalRelevant: boolean): T {
  return clip(value, PENDING_DECISION_LIMITS.identifierChars, acc, approvalRelevant) as T;
}

function digest(taskId: string, kind: PendingDecisionKind, state: WorkflowState, transitions: number, content: unknown): string {
  const canonical = JSON.stringify({ v: 1, taskId, kind, state, transitions, content });
  return `pd1_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function optionsWhere(candidates: Array<[DecisionOption, boolean]>): DecisionOption[] {
  return candidates.filter(([, legal]) => legal).map(([option]) => option);
}

/**
 * Why a task is FAILED or BLOCKED. The authoritative source is the transition that entered the
 * current state: an ordinary provider failure is recorded only as that history event's `detail`
 * (task.failures holds just iteration-cap escalations and divergence acknowledgements), so the
 * failure log alone would miss the most common case. The last failure record is the fallback, and
 * contributes the `code` when it describes that same moment.
 */
function failureView(task: TaskRecord, acc: Clipped): { view?: PendingFailureView; full: unknown } {
  let entering: HistoryEvent | undefined;
  for (let i = task.history.length - 1; i >= 0; i--) {
    if (task.history[i]!.to === task.workflowState) {
      entering = task.history[i];
      break;
    }
  }
  const record = task.failures.at(-1);
  const at = entering?.at ?? record?.at;
  const message = entering?.detail ?? record?.message;
  const state = entering?.from ?? record?.state;
  if (at === undefined || message === undefined || state === undefined) return { full: null };
  const code = record && record.at === at ? record.code : undefined;
  const actor = entering && typeof entering.actor === "object" ? entering.actor : undefined;
  return {
    view: {
      at: ident(at, acc, false),
      state: ident(state, acc, false),
      message: clip(message, PENDING_DECISION_LIMITS.failureMessageChars, acc, false),
      ...(code ? { code: ident(code, acc, false) } : {}),
      ...(actor ? { role: ident(actor.role, acc, false), providerId: ident(actor.providerId, acc, false) } : {})
    },
    full: { at, state, message, code: code ?? null, role: actor?.role ?? null, providerId: actor?.providerId ?? null }
  };
}

function reviewViews(reports: ReviewReport[], acc: Clipped): PendingReviewView[] {
  return reports.map((report) => {
    if (report.findings.length > PENDING_DECISION_LIMITS.findingsPerReview) {
      acc.any = true;
      acc.approvalRelevant = true;
    }
    return {
      role: ident(report.role, acc, true),
      providerId: ident(report.providerId, acc, true),
      verdict: ident(report.verdict, acc, true),
      summary: clip(report.summary, PENDING_DECISION_LIMITS.reviewSummaryChars, acc, true),
      totalFindings: report.findings.length,
      findings: report.findings.slice(0, PENDING_DECISION_LIMITS.findingsPerReview).map((finding) => ({
        id: ident(finding.id, acc, true),
        severity: ident(finding.severity, acc, true),
        status: ident(finding.status, acc, true),
        summary: clip(finding.summary, PENDING_DECISION_LIMITS.findingSummaryChars, acc, true),
        ...(finding.file
          ? {
              location: clip(
                finding.line ? `${finding.file}:${finding.line}` : finding.file,
                PENDING_DECISION_LIMITS.findingLocationChars,
                acc,
                true
              )
            }
          : {})
      }))
    };
  });
}

/** Everything about a review round, shown or not — the material a gate approval actually covers. */
function reviewMaterial(reports: ReviewReport[]): unknown {
  return reports.map((report) => ({
    id: report.id,
    role: report.role,
    providerId: report.providerId,
    createdAt: report.createdAt,
    verdict: report.verdict,
    summary: report.summary,
    findings: report.findings.map((finding) => ({
      id: finding.id,
      dimension: finding.dimension,
      severity: finding.severity,
      file: finding.file ?? null,
      line: finding.line ?? null,
      summary: finding.summary,
      detail: finding.detail,
      suggestedFix: finding.suggestedFix ?? null,
      status: finding.status
    }))
  }));
}

/**
 * Derives what human decision, if any, a task is currently waiting on. Pure: it reads only the
 * task record and the supplied context, performs no I/O, reads no clock, and never mutates its
 * input. Returns `undefined` when no human decision is pending — the task is either advanceable
 * by the orchestrator, or terminal, or READY (merging a finished task is deliberately not a
 * workflow decision).
 *
 * Valid options come from the workflow engine's own legality (via `context.canApply`), so they
 * cannot drift from what the orchestrator will actually accept — in particular, a FAILED task can
 * only be retried, not cancelled, because the workflow has no such transition. A gate answer is
 * two transitions (`Orchestrator.decideGate` un-pauses, then replays the stashed trigger on
 * approval or applies `review_findings` on rejection), and both are checked.
 */
export function derivePendingDecision(task: TaskRecord, context: PendingDecisionContext): PendingDecision | undefined {
  const { canApply } = context;
  const acc: Clipped = { any: false, approvalRelevant: false };
  const transitions = task.history.length;
  // A caller answers by task id, so an id that had to be cut cannot be addressed: approval-relevant.
  const base = { taskId: ident(task.id, acc, true), workflowState: task.workflowState };

  const finish = (
    kind: PendingDecisionKind,
    summary: string,
    material: unknown,
    options: DecisionOption[],
    untrusted: PendingDecisionProvenance[],
    extra: Partial<PendingDecision> = {},
    unavailableReason?: "gate_transition_unavailable"
  ): PendingDecision => {
    // Truncation is the one thing that strips an otherwise-legal approval; everything else is
    // already reflected in `options`. `unavailableReason` only explains an approval that is absent.
    const withheld = acc.approvalRelevant ? "content_truncated" : unavailableReason;
    return {
      ...base,
      kind,
      id: digest(task.id, kind, task.workflowState, transitions, material),
      summary,
      options: acc.approvalRelevant ? options.filter((option) => option !== "approve") : options,
      ...(withheld ? { approvalWithheld: withheld } : {}),
      truncated: acc.any,
      untrusted,
      ...extra
    };
  };

  switch (task.workflowState) {
    case "AWAITING_APPROVAL": {
      const specification = clip(task.specification ?? "", PENDING_DECISION_LIMITS.specificationChars, acc, true);
      const plan = clip(task.plan ?? "", PENDING_DECISION_LIMITS.planChars, acc, true);
      return finish(
        "plan",
        "A plan is awaiting human approval before implementation begins.",
        { specification: task.specification ?? "", plan: task.plan ?? "" },
        optionsWhere([
          ["approve", canApply("approve")],
          ["reject", canApply("reject")],
          ["cancel", canApply("cancel")]
        ]),
        [
          { field: "specification", trust: "agent_generated" },
          { field: "plan", trust: "agent_generated" }
        ],
        { specification, plan }
      );
    }

    case "PAUSED": {
      const resumeLegal = canApply("resume");
      const cancelLegal = canApply("cancel");
      const previousState = task.previousState;
      const previous = previousState ? { previousState: ident(previousState, acc, false) } : {};

      if (task.pendingGate) {
        const reports = task.reviews.slice(-PENDING_DECISION_LIMITS.reviews);
        const reviews = reviewViews(reports, acc);
        const gate = ident(task.pendingGate, acc, true);
        // Mirrors Orchestrator.decideGate: un-pause, then replay the stashed trigger on approval or
        // apply `review_findings` on rejection — each checked from the state the task paused in.
        const secondStepLegal = (trigger: string | undefined): boolean =>
          resumeLegal && previousState !== undefined && trigger !== undefined && canApply(trigger as Trigger, previousState);
        const approveLegal = secondStepLegal(task.pendingDecisionTrigger);
        const rejectLegal = secondStepLegal("review_findings");
        return finish(
          "gate",
          "A review gate is awaiting human sign-off.",
          {
            gate: task.pendingGate,
            trigger: task.pendingDecisionTrigger ?? null,
            previousState: previousState ?? null,
            reviews: reviewMaterial(reports)
          },
          optionsWhere([
            ["approve", approveLegal],
            ["reject", rejectLegal],
            ["cancel", cancelLegal]
          ]),
          [{ field: "reviews", trust: "agent_generated" }],
          { gate, reviews, ...previous },
          resumeLegal && !approveLegal ? "gate_transition_unavailable" : undefined
        );
      }

      if (requiresCheckLookup(task)) {
        if (!context.checks) {
          throw new Error(
            `Task "${task.id}" is paused with a NOT_APPROVED verification result, so its live check-approval status is required (context.checks) to derive the pending decision.`
          );
        }
        const pending = unapprovedRequiredChecks(task.verification.at(-1), context.checks);
        if (pending.length > 0) {
          if (pending.length > PENDING_DECISION_LIMITS.checks) {
            acc.any = true;
            acc.approvalRelevant = true;
          }
          const checks: PendingCheckView[] = pending.slice(0, PENDING_DECISION_LIMITS.checks).map(({ result, check }) => ({
            // Answered by check id, so an id that had to be cut cannot be approved.
            id: ident(check.id, acc, true),
            description: clip(check.description, PENDING_DECISION_LIMITS.checkTextChars, acc, true),
            command: clip(check.command, PENDING_DECISION_LIMITS.checkCommandChars, acc, true),
            ...(check.cwd ? { cwd: clip(check.cwd, PENDING_DECISION_LIMITS.checkTextChars, acc, true) } : {}),
            ...(result.reason ? { reason: clip(result.reason, PENDING_DECISION_LIMITS.checkTextChars, acc, false) } : {})
          }));
          return finish(
            "verification_approval",
            "A required repository-configured verification command needs explicit human approval before verification can proceed.",
            pending.map(({ result, check }) => ({
              id: check.id,
              description: check.description,
              command: check.command,
              cwd: check.cwd ?? null,
              reason: result.reason ?? null
            })),
            optionsWhere([
              ["approve", resumeLegal],
              ["cancel", cancelLegal]
            ]),
            [{ field: "checks", trust: "repository_configuration" }],
            { checks, ...previous }
          );
        }
      }

      return finish(
        "resume",
        "The task is paused and needs an explicit decision to resume.",
        { previousState: previousState ?? null },
        optionsWhere([
          ["resume", resumeLegal],
          ["cancel", cancelLegal]
        ]),
        [],
        previous
      );
    }

    case "FAILED": {
      const { view, full } = failureView(task, acc);
      return finish(
        "retry",
        "A step failed and needs a decision to retry.",
        { failure: full, previousState: task.previousState ?? null },
        optionsWhere([["retry", canApply("retry")]]),
        view ? [{ field: "failure.message", trust: "agent_generated" }] : [],
        { ...(view ? { failure: view } : {}), ...(task.previousState ? { previousState: ident(task.previousState, acc, false) } : {}) }
      );
    }

    case "BLOCKED": {
      const { view, full } = failureView(task, acc);
      return finish(
        "blocked",
        "Automatic progress stopped after repeated iterations; a human must decide whether to keep trying or cancel.",
        { failure: full },
        optionsWhere([
          ["resume", canApply("resume")],
          ["cancel", canApply("cancel")]
        ]),
        view ? [{ field: "failure.message", trust: "agent_generated" }] : [],
        view ? { failure: view } : {}
      );
    }

    default:
      return undefined;
  }
}
