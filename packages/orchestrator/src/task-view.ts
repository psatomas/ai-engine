import type { ReviewReport, TaskRecord, VerificationReport, VerificationStatus } from "@ai-engine/core";
import type {
  DecisionOption,
  PendingCheckView,
  PendingDecision,
  PendingDecisionKind,
  PendingDecisionProvenance,
  PendingDivergenceView,
  PendingFailureView,
  PendingFindingView,
  PendingReviewView
} from "./pending-decision.js";

/**
 * Hard bounds on the read-only views of a task, so any caller (an MCP server relaying to a chat, an
 * editor, a CLI) gets a size-limited picture regardless of how large the persisted record is. Every
 * string copied out of the record — free text and identifiers alike — is bounded by Unicode code
 * point, ending in "…" when cut, and every collection is capped.
 */
export const TASK_VIEW_LIMITS = {
  /** Tasks in one list view; `total` still reports how many exist. */
  tasksPerList: 50,
  listRequestChars: 200,
  requestChars: 2_000,
  specificationChars: 2_000,
  verificationResults: 20,
  reviews: 2,
  reviewSummaryChars: 1_000,
  findingsPerReview: 10,
  findingSummaryChars: 300,
  findingLocationChars: 300,
  failureMessageChars: 1_000,
  /** Ids, roles, provider names, check ids, timestamps, state names and branch names. */
  identifierChars: 200
} as const;

/**
 * Presentation limits for the pending decision embedded in a task view. Unit 1's limits serve a human
 * deciding on the full material; these serve an agent's transport, so they are tighter. The decision
 * itself, and its `id`, are untouched: this only bounds how much of it a view shows (see `DecisionView`).
 */
export const DECISION_VIEW_LIMITS = {
  specificationChars: 12_000,
  planChars: 24_000,
  reviewSummaryChars: 1_000,
  findingsPerReview: 10,
  findingSummaryChars: 300,
  findingLocationChars: 200,
  checks: 10,
  checkCommandChars: 2_000,
  checkTextChars: 300,
  failureMessageChars: 1_000
} as const;

/**
 * Aggregate budgets, in UTF-8 bytes of `presentedBytes(view)`: the cost of presenting a view the way an
 * MCP tool result does, once as structured data and once as its JSON text mirror. They are enforced by
 * measurement, not estimated from per-field limits (which cannot bound bytes: one control character
 * serializes to 13 bytes across both copies), and leave 8 KiB / 4 KiB for the caller's own envelope, so
 * a `get_task` result stays within 128 KiB and a `list_tasks` result within 64 KiB.
 */
export const TASK_VIEW_BUDGET = { taskBytes: 120 * 1024, listBytes: 60 * 1024 } as const;

/** Text is never scaled below this many code points, identifiers never below `MIN_IDENT_CHARS` (a decision id is 36). */
const MIN_TEXT_CHARS = 16;
const MIN_IDENT_CHARS = 48;

/**
 * The compaction ladder for `describeTask`: every free-text limit, identifier limit and collection cap
 * is divided by the step until the measured size fits. The last step is small enough that the worst
 * possible record (every field at its cap, every character at its worst expansion) fits the budget;
 * the tests build exactly that record.
 */
export const COMPACTION_STEPS = [1, 2, 4, 8, 16, 32, 64] as const;

const ELLIPSIS = "…";

/** UTF-8 bytes of `value` serialized as JSON, plus the bytes of that JSON serialized again as a string (the text mirror). */
export function presentedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, "utf8") + Buffer.byteLength(JSON.stringify(json), "utf8");
}

/**
 * The outcome of asking the orchestrator what human decision a task is waiting on. Resolved by the
 * caller (`Orchestrator.pendingDecision` does the I/O); these views only embed it, unchanged.
 * `unavailable` means the question could not be answered — never that no decision is pending.
 */
export type PendingDecisionOutcome = { status: "none" } | { status: "pending"; decision: PendingDecision } | { status: "unavailable" };

/** What a list needs to know about a pending decision: that there is one, what kind, and what may be answered. */
export type PendingDecisionSummary =
  | { status: "none" }
  | {
      status: "pending";
      kind: PendingDecisionKind;
      decisionId: string;
      options: DecisionOption[];
      approvalWithheld?: PendingDecision["approvalWithheld"];
    }
  | { status: "unavailable" };

export interface TaskSummaryView {
  id: string;
  workflowState: string;
  createdAt: string;
  updatedAt: string;
  finalStatus?: string;
  /** The task's own git branch. Absent when the task has none yet — never a stand-in for another branch. */
  branch?: string;
  /** The operator's request, cut to a short summary. */
  request: string;
  requestTruncated: boolean;
  pendingDecision: PendingDecisionSummary;
}

/**
 * Why a decision's `approve` is not offered. Unit 1's reasons pass through unchanged; `presentation_truncated`
 * is added here: something the human would be approving was cut to fit this view, so this view must not
 * offer approval of content it did not show in full.
 */
export type DecisionViewApprovalWithheld = NonNullable<PendingDecision["approvalWithheld"]> | "presentation_truncated";

/**
 * A pending decision as a task view presents it: the same fields as Unit 1's `PendingDecision`, carrying
 * the same `id` (which still binds the FULL underlying material, not what is shown here), with each
 * bounded field cut to this view's limits. When it fits, the projection equals the original.
 */
export interface DecisionView extends Omit<PendingDecision, "approvalWithheld" | "reviews" | "checks" | "failure"> {
  approvalWithheld?: DecisionViewApprovalWithheld;
  reviews?: PendingReviewView[];
  checks?: PendingCheckView[];
  failure?: PendingFailureView;
  /** Present (true) only when this view cut something the decision carried; `truncated` still reports only Unit 1's own cuts. */
  presentationTruncated?: true;
  /** How many checks the decision has in total; present only when the list of `checks` was cut. */
  totalChecks?: number;
}

/** The outcome as a view presents it: the pending decision is the bounded `DecisionView`, never the raw model. */
export type PendingDecisionPresentation = { status: "none" } | { status: "pending"; decision: DecisionView } | { status: "unavailable" };

export interface TaskListView {
  tasks: TaskSummaryView[];
  /** How many tasks exist in the listed set; more than `tasks.length` means the list was cut (by count or by budget). */
  total: number;
  truncated: boolean;
}

export interface TaskFindingView {
  id: string;
  severity: string;
  status: string;
  summary: string;
  location?: string;
}

export interface TaskReviewView {
  role: string;
  providerId: string;
  verdict: string;
  summary: string;
  findings: TaskFindingView[];
  /** How many findings the report has in total; more than `findings.length` means the list was cut. */
  totalFindings: number;
}

export interface TaskVerificationResultView {
  checkId: string;
  status: string;
  exitCode?: number | null;
}

export interface TaskVerificationView {
  at: string;
  /** Result counts by status over ALL results, including any cut from `results`. */
  counts: Partial<Record<VerificationStatus, number>>;
  totalResults: number;
  results: TaskVerificationResultView[];
}

export interface TaskFailureView {
  at: string;
  state: string;
  message: string;
  code?: string;
}

export interface TaskView extends Omit<TaskSummaryView, "pendingDecision"> {
  specification?: string;
  specificationTruncated?: boolean;
  latestVerification?: TaskVerificationView;
  /** The most recent review reports (the latest round), oldest first. */
  latestReviews?: TaskReviewView[];
  /** The most recent recorded failure. A failed step's own message is on `pendingDecision.decision.failure`. */
  latestFailure?: TaskFailureView;
  /** The pending decision when one exists, projected to this view's limits. Its `id` is Unit 1's, unchanged. */
  pendingDecision: PendingDecisionPresentation;
  /** True when any bounded field of THIS view, or of the decision it shows, was cut. */
  truncated: boolean;
  /**
   * Fields of THIS view whose text is authored outside AI Engine, and how far to trust it: never as
   * instructions to whoever reads it. The embedded decision carries its own list.
   */
  untrusted: PendingDecisionProvenance[];
}

interface Clipped {
  /** Some bounded field was cut. */
  any: boolean;
  /** A cut field is something a human would be approving. */
  approvalRelevant: boolean;
}

const fresh = (): Clipped => ({ any: false, approvalRelevant: false });

/** Every limit in force at one compaction step. Step 1 is the ordinary limits. */
interface Limits {
  ident: number;
  listRequest: number;
  request: number;
  specification: number;
  verificationResults: number;
  reviewSummary: number;
  findingsPerReview: number;
  findingSummary: number;
  findingLocation: number;
  failureMessage: number;
  decision: {
    specification: number;
    plan: number;
    reviewSummary: number;
    findingsPerReview: number;
    findingSummary: number;
    findingLocation: number;
    checks: number;
    checkCommand: number;
    checkText: number;
    failureMessage: number;
  };
}

function limitsAt(step: number): Limits {
  const text = (max: number): number => Math.max(MIN_TEXT_CHARS, Math.floor(max / step));
  const count = (max: number): number => Math.max(1, Math.floor(max / step));
  const D = DECISION_VIEW_LIMITS;
  return {
    ident: Math.max(MIN_IDENT_CHARS, Math.floor(TASK_VIEW_LIMITS.identifierChars / step)),
    listRequest: text(TASK_VIEW_LIMITS.listRequestChars),
    request: text(TASK_VIEW_LIMITS.requestChars),
    specification: text(TASK_VIEW_LIMITS.specificationChars),
    verificationResults: count(TASK_VIEW_LIMITS.verificationResults),
    reviewSummary: text(TASK_VIEW_LIMITS.reviewSummaryChars),
    findingsPerReview: count(TASK_VIEW_LIMITS.findingsPerReview),
    findingSummary: text(TASK_VIEW_LIMITS.findingSummaryChars),
    findingLocation: text(TASK_VIEW_LIMITS.findingLocationChars),
    failureMessage: text(TASK_VIEW_LIMITS.failureMessageChars),
    decision: {
      specification: text(D.specificationChars),
      plan: text(D.planChars),
      reviewSummary: text(D.reviewSummaryChars),
      findingsPerReview: count(D.findingsPerReview),
      findingSummary: text(D.findingSummaryChars),
      findingLocation: text(D.findingLocationChars),
      checks: count(D.checks),
      checkCommand: text(D.checkCommandChars),
      checkText: text(D.checkTextChars),
      failureMessage: text(D.failureMessageChars)
    }
  };
}

/** Copies out a persisted value as text: anything that is not a string (a hand-edited or corrupt record) becomes empty. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: unknown, max: number, acc: Clipped, approvalRelevant = false): string {
  const text = asText(value);
  if (text.length <= max) return text; // UTF-16 length within the bound implies code points within it
  // Past twice the bound there are certainly more than `max` code points, so only the head is walked:
  // a hostile multi-megabyte value costs the same to bound as a merely long one. The kept `max - 1`
  // code points span at most 2 * (max - 1) units, so the cut can never fall inside a surrogate pair.
  const oversize = text.length > max * 2;
  const chars = Array.from(oversize ? text.slice(0, max * 2) : text);
  if (!oversize && chars.length <= max) return text;
  acc.any = true;
  if (approvalRelevant) acc.approvalRelevant = true;
  return chars.slice(0, max - 1).join("") + ELLIPSIS;
}

/** A short identifier-like value copied out of a record. For every well-formed value this is the identity function. */
function ident<T extends string>(value: T, max: number, acc: Clipped, approvalRelevant = false): T {
  return clip(value, max, acc, approvalRelevant) as T;
}

function arrayOf<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A list summary never advertises `approve`, whatever the underlying decision offers: it is a
 * discovery/triage surface that deliberately does not carry the approval-relevant material
 * `get_task` does, so it must never represent approving as an immediately available action here.
 * This is a capability restriction of THIS surface, not a truncation of the decision, so it invents
 * no `approvalWithheld` reason — `approvalWithheld` still only ever carries Unit 1's own reason,
 * unchanged. The decision itself (its `id`, its options, Unit 1's semantics) is never touched.
 */
function pendingSummary(outcome: PendingDecisionOutcome, L: Limits, acc: Clipped): PendingDecisionSummary {
  if (outcome.status !== "pending") return { status: outcome.status };
  const { decision } = outcome;
  return {
    status: "pending",
    kind: decision.kind,
    decisionId: ident(decision.id, L.ident, acc),
    options: decision.options.filter((option) => option !== "approve"),
    ...(decision.approvalWithheld ? { approvalWithheld: decision.approvalWithheld } : {})
  };
}

function summary(task: TaskRecord, outcome: PendingDecisionOutcome, L: Limits, requestChars: number, acc: Clipped): TaskSummaryView {
  const original = asText(task.originalRequest);
  const request = clip(original, requestChars, acc);
  return {
    id: ident(task.id, L.ident, acc),
    workflowState: ident(task.workflowState, L.ident, acc),
    createdAt: ident(task.createdAt, L.ident, acc),
    updatedAt: ident(task.updatedAt, L.ident, acc),
    ...(task.finalStatus ? { finalStatus: ident(task.finalStatus, L.ident, acc) } : {}),
    ...(task.git?.taskBranch ? { branch: ident(task.git.taskBranch, L.ident, acc) } : {}),
    request,
    requestTruncated: request !== original,
    pendingDecision: pendingSummary(outcome, L, acc)
  };
}

/**
 * A short, bounded, path-free summary of one task: enough to tell tasks apart and see whether any
 * needs a human. Pure — reads only the record and the supplied outcome, performs no I/O, and never
 * mutates either. The record's paths (worktree, workspace, repository root) are never copied out.
 */
export function summarizeTask(task: TaskRecord, outcome: PendingDecisionOutcome): TaskSummaryView {
  const L = limitsAt(1);
  return summary(task, outcome, L, L.listRequest, fresh());
}

/**
 * A bounded list of task summaries, in the order given. It is cut at `TASK_VIEW_LIMITS.tasksPerList`
 * AND by budget: whole summaries are added while `presentedBytes` of the list stays within
 * `TASK_VIEW_BUDGET.listBytes`, then it stops — never mid-summary. One summary is at most a few KiB
 * even when every field is hostile, so at least the first always fits. `outcomes` supplies the
 * pending-decision outcome for each task id; a task with none is reported `unavailable`, never `none`.
 */
export function summarizeTasks(tasks: readonly TaskRecord[], outcomes: ReadonlyMap<string, PendingDecisionOutcome>): TaskListView {
  const shown: TaskSummaryView[] = [];
  for (const task of tasks.slice(0, TASK_VIEW_LIMITS.tasksPerList)) {
    const next = [...shown, summarizeTask(task, outcomes.get(task.id) ?? { status: "unavailable" })];
    // Measured as if truncated, the longer literal, so the final flag can never push a list over budget.
    if (presentedBytes({ tasks: next, total: tasks.length, truncated: true }) > TASK_VIEW_BUDGET.listBytes) break;
    shown.push(next[next.length - 1]!);
  }
  return { tasks: shown, total: tasks.length, truncated: shown.length < tasks.length };
}

function reviewViews(reports: ReviewReport[], L: Limits, acc: Clipped): TaskReviewView[] {
  return reports.slice(-TASK_VIEW_LIMITS.reviews).map((report) => {
    const findings = arrayOf(report.findings);
    if (findings.length > L.findingsPerReview) acc.any = true;
    return {
      role: ident(report.role, L.ident, acc),
      providerId: ident(report.providerId, L.ident, acc),
      verdict: ident(report.verdict, L.ident, acc),
      summary: clip(report.summary, L.reviewSummary, acc),
      totalFindings: findings.length,
      findings: findings.slice(0, L.findingsPerReview).map((finding) => ({
        id: ident(finding.id, L.ident, acc),
        severity: ident(finding.severity, L.ident, acc),
        status: ident(finding.status, L.ident, acc),
        summary: clip(finding.summary, L.findingSummary, acc),
        ...(finding.file ? { location: clip(finding.line ? `${finding.file}:${finding.line}` : finding.file, L.findingLocation, acc) } : {})
      }))
    };
  });
}

/**
 * Deliberately omits each result's `reason` and `output`: the runner records raw error text there,
 * which can carry filesystem paths and command output. Status, exit code and the check id are
 * enough for an initiating agent to see what passed.
 */
function verificationView(report: VerificationReport, L: Limits, acc: Clipped): TaskVerificationView {
  const results = arrayOf(report.results);
  const counts: TaskVerificationView["counts"] = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  if (results.length > L.verificationResults) acc.any = true;
  return {
    at: ident(report.createdAt, L.ident, acc),
    counts,
    totalResults: results.length,
    results: results.slice(0, L.verificationResults).map((result) => ({
      checkId: ident(result.checkId, L.ident, acc),
      status: ident(result.status, L.ident, acc),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {})
    }))
  };
}

/**
 * Projects a pending decision to this view's limits WITHOUT changing it. `id` is copied verbatim (it
 * binds the full underlying material, not what is shown), legality is Unit 1's, and provenance labels
 * are kept. Which cuts matter for approval mirrors Unit 1: the specification, plan, gate, reviews,
 * and each check's id, description, command and cwd are what a human approves; a check's `reason`, a
 * failure, and `previousState` are not. If any approval-relevant field is cut, `approve` is removed
 * from `options` and `approvalWithheld` says why — unless Unit 1 had already withheld it, in which
 * case Unit 1's reason stands. Non-approval options (reject, cancel, resume, retry) are never touched.
 */
function projectDecision(decision: PendingDecision, L: Limits, acc: Clipped): DecisionView {
  const D = L.decision;
  const relevant = true;
  const reviews = decision.reviews
    ? decision.reviews.slice(0, TASK_VIEW_LIMITS.reviews).map((review): PendingReviewView => {
        if (review.findings.length > D.findingsPerReview) {
          acc.any = true;
          acc.approvalRelevant = true;
        }
        return {
          role: ident(review.role, L.ident, acc, relevant),
          providerId: ident(review.providerId, L.ident, acc, relevant),
          verdict: ident(review.verdict, L.ident, acc, relevant),
          summary: clip(review.summary, D.reviewSummary, acc, relevant),
          totalFindings: review.totalFindings,
          findings: review.findings.slice(0, D.findingsPerReview).map((finding): PendingFindingView => ({
            id: ident(finding.id, L.ident, acc, relevant),
            severity: ident(finding.severity, L.ident, acc, relevant),
            status: ident(finding.status, L.ident, acc, relevant),
            summary: clip(finding.summary, D.findingSummary, acc, relevant),
            ...(finding.location ? { location: clip(finding.location, D.findingLocation, acc, relevant) } : {})
          }))
        };
      })
    : undefined;
  if (decision.reviews && decision.reviews.length > TASK_VIEW_LIMITS.reviews) {
    acc.any = true;
    acc.approvalRelevant = true;
  }

  const checksCut = decision.checks !== undefined && decision.checks.length > D.checks;
  if (checksCut) {
    acc.any = true;
    acc.approvalRelevant = true;
  }
  const checks = decision.checks
    ? decision.checks.slice(0, D.checks).map((check): PendingCheckView => ({
        id: ident(check.id, L.ident, acc, relevant),
        description: clip(check.description, D.checkText, acc, relevant),
        command: clip(check.command, D.checkCommand, acc, relevant),
        ...(check.cwd ? { cwd: clip(check.cwd, D.checkText, acc, relevant) } : {}),
        ...(check.reason ? { reason: clip(check.reason, D.checkText, acc) } : {})
      }))
    : undefined;

  const failure = decision.failure
    ? {
        at: ident(decision.failure.at, L.ident, acc),
        state: ident(decision.failure.state, L.ident, acc),
        message: clip(decision.failure.message, D.failureMessage, acc),
        ...(decision.failure.code ? { code: ident(decision.failure.code, L.ident, acc) } : {}),
        ...(decision.failure.role ? { role: ident(decision.failure.role, L.ident, acc) } : {}),
        ...(decision.failure.providerId ? { providerId: ident(decision.failure.providerId, L.ident, acc) } : {})
      }
    : undefined;

  // Commit hashes only — fixed-length, orchestrator-derived, never repository-authored text — so a
  // plain ident() bound is correct here exactly as it is for `gate`/`previousState` below.
  const divergence: PendingDivergenceView | undefined = decision.divergence
    ? {
        expectedCommit: ident(decision.divergence.expectedCommit, L.ident, acc, relevant),
        actualCommit: ident(decision.divergence.actualCommit, L.ident, acc, relevant)
      }
    : undefined;

  const projected: DecisionView = {
    taskId: ident(decision.taskId, L.ident, acc, relevant),
    kind: decision.kind,
    id: ident(decision.id, L.ident, acc, relevant),
    workflowState: ident(decision.workflowState, L.ident, acc),
    summary: clip(decision.summary, 500, acc),
    ...(decision.gate !== undefined ? { gate: ident(decision.gate, L.ident, acc, relevant) } : {}),
    options: [...decision.options],
    truncated: decision.truncated,
    untrusted: decision.untrusted.map((entry) => ({ field: ident(entry.field, L.ident, acc), trust: entry.trust })),
    ...(decision.specification !== undefined ? { specification: clip(decision.specification, D.specification, acc, relevant) } : {}),
    ...(decision.plan !== undefined ? { plan: clip(decision.plan, D.plan, acc, relevant) } : {}),
    ...(reviews ? { reviews } : {}),
    ...(checks ? { checks } : {}),
    ...(checksCut ? { totalChecks: decision.checks!.length } : {}),
    ...(failure ? { failure } : {}),
    ...(decision.previousState !== undefined ? { previousState: ident(decision.previousState, L.ident, acc) } : {}),
    ...(divergence ? { divergence } : {})
  };

  // Unit 1's reason, when it has one, always stands; otherwise approval is withheld only if it WAS on offer.
  const approvalWithheld: DecisionViewApprovalWithheld | undefined =
    decision.approvalWithheld ?? (acc.approvalRelevant && decision.options.includes("approve") ? "presentation_truncated" : undefined);
  if (acc.approvalRelevant) projected.options = projected.options.filter((option) => option !== "approve");
  if (approvalWithheld) projected.approvalWithheld = approvalWithheld;
  if (acc.any) projected.presentationTruncated = true;
  return projected;
}

function buildTaskView(task: TaskRecord, outcome: PendingDecisionOutcome, L: Limits): TaskView {
  const acc = fresh();
  const { pendingDecision: _summarized, ...base } = summary(task, outcome, L, L.request, acc);
  const untrusted: PendingDecisionProvenance[] = [];

  const specification = asText(task.specification);
  const specificationView = specification ? clip(specification, L.specification, acc) : undefined;
  if (specificationView !== undefined) untrusted.push({ field: "specification", trust: "agent_generated" });

  const latestVerificationReport = arrayOf(task.verification).at(-1);
  const latestVerification = latestVerificationReport ? verificationView(latestVerificationReport, L, acc) : undefined;
  if (latestVerification) untrusted.push({ field: "latestVerification.results.checkId", trust: "repository_configuration" });

  const reviewReports = arrayOf(task.reviews);
  const latestReviews = reviewReports.length > 0 ? reviewViews(reviewReports, L, acc) : undefined;
  if (latestReviews) untrusted.push({ field: "latestReviews", trust: "agent_generated" });

  const failure = arrayOf(task.failures).at(-1);
  const latestFailure: TaskFailureView | undefined = failure
    ? {
        at: ident(failure.at, L.ident, acc),
        state: ident(failure.state, L.ident, acc),
        message: clip(failure.message, L.failureMessage, acc),
        ...(failure.code ? { code: ident(failure.code, L.ident, acc) } : {})
      }
    : undefined;
  if (latestFailure) untrusted.push({ field: "latestFailure.message", trust: "agent_generated" });

  const decisionAcc = fresh();
  const pendingDecision: PendingDecisionPresentation =
    outcome.status === "pending"
      ? { status: "pending", decision: projectDecision(outcome.decision, L, decisionAcc) }
      : { status: outcome.status };

  return {
    ...base,
    ...(specificationView !== undefined
      ? { specification: specificationView, specificationTruncated: specificationView !== specification }
      : {}),
    ...(latestVerification ? { latestVerification } : {}),
    ...(latestReviews ? { latestReviews } : {}),
    ...(latestFailure ? { latestFailure } : {}),
    pendingDecision,
    truncated: acc.any || decisionAcc.any,
    untrusted
  };
}

/**
 * A bounded, path-free picture of one task for an initiating agent: identity, state, the request and
 * specification in short form, the latest verification and review summaries, the latest recorded
 * failure, and the pending decision projected to this view's limits (see `projectDecision`). Pure,
 * like `summarizeTask`. Raw provider output, the task history, environment or configuration, and
 * every filesystem path are never copied.
 *
 * The result fits `TASK_VIEW_BUDGET.taskBytes` by measurement: the view is built at the ordinary
 * limits, and if it does not fit, again with every limit halved, and so on down `COMPACTION_STEPS`.
 * Everything is still cut by code point, and anything cut from the decision that a human would be
 * approving removes `approve` from what it offers.
 */
export function describeTask(task: TaskRecord, outcome: PendingDecisionOutcome): TaskView {
  let view: TaskView | undefined;
  for (const step of COMPACTION_STEPS) {
    view = describeTaskAtStep(task, outcome, step);
    if (presentedBytes(view) <= TASK_VIEW_BUDGET.taskBytes) break;
  }
  return view!;
}

/**
 * `describeTask` at ONE compaction step, without the budget loop. A test seam: it lets a test prove that
 * the last step fits the budget on its own, which is what makes the loop's guarantee unconditional.
 * @internal
 */
export function describeTaskAtStep(task: TaskRecord, outcome: PendingDecisionOutcome, step: number): TaskView {
  return buildTaskView(task, outcome, limitsAt(step));
}
