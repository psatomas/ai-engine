import type { WorkflowState } from "./workflow-state.js";
import type { VerificationReport } from "./verification.js";
import type { ReviewReport } from "./review.js";
import type { DependencySetupResult } from "./dependency-setup.js";

export interface GitBaseline {
  branch: string;
  commit: string;
  worktreePath?: string;
  taskBranch?: string;
  dirtyAtStart: boolean;
  untrackedAtStart: string[];
  /**
   * The worktree commit as of the last successfully persisted TaskRecord.
   * Refreshed on every persist(). Compared against the worktree's actual
   * current commit at the start of every mutating step (see
   * Orchestrator's git/task divergence detection) — a mismatch means the
   * worktree changed since the last time we durably recorded what state we
   * thought the task was in (e.g. a step committed but the process was
   * killed before the resulting state was persisted), and the step refuses
   * to silently proceed until a human acknowledges it.
   */
  lastKnownCommit?: string;
}

export interface TaskUsage {
  /** Only providers that report cost (currently: Claude) contribute here — see docs/security.md#budgets. */
  totalCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface ApprovalRecord {
  gate: string;
  decision: "approved" | "rejected";
  by: string;
  at: string;
  note?: string;
}

export interface FailureRecord {
  at: string;
  state: WorkflowState;
  message: string;
  code?: string;
}

export interface HistoryEvent {
  at: string;
  from: WorkflowState;
  to: WorkflowState;
  trigger: string;
  actor: "system" | "human" | ProviderRoleActor;
  detail?: string;
}

export interface ProviderRoleActor {
  role: string;
  providerId: string;
}

export interface RoleAssignment {
  role: string;
  providerId: string;
}

/**
 * A provider-native resume/session id, tagged with the provider that
 * created it. The tag is load-bearing, not decorative: without it, a role
 * whose provider assignment changes between invocations (edited config, a
 * project override, a future remapping) could have a *different* provider
 * handed a resume session id it never created. `Orchestrator.buildRequest`
 * only ever forwards `sessionId` as `resumeSessionId` when the role's
 * currently-resolved provider id matches `providerId` here.
 */
export interface ProviderSessionRef {
  providerId: string;
  sessionId: string;
}

/**
 * The persistent identity of a single unit of engineering work. This is the
 * source of truth for workflow state — never chat history. See docs/workflow.md.
 */
export interface TaskRecord {
  id: string;
  repository: {
    root: string;
    remoteUrl?: string;
  };
  workspaceFolder: string;
  originalRequest: string;
  specification?: string;
  plan?: string;
  workflowState: WorkflowState;
  previousState?: WorkflowState;
  /** Name of an approval gate (e.g. "security_review") currently blocking progress while PAUSED. */
  pendingGate?: string;
  /** The forward trigger to apply once `pendingGate` is approved (see Orchestrator.approveGate). */
  pendingDecisionTrigger?: string;
  agentsUsed: RoleAssignment[];
  /** Result of the one-time best-effort dependency install attempted when the worktree was created — see @ai-engine/core's DependencySetupResult. Undefined for tasks created before this existed. */
  dependencySetup?: DependencySetupResult;
  git: GitBaseline;
  verification: VerificationReport[];
  reviews: ReviewReport[];
  approvals: ApprovalRecord[];
  history: HistoryEvent[];
  failures: FailureRecord[];
  iterationCounts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  finalStatus?: "ready" | "failed" | "cancelled";
  /** Keyed by role. See ProviderSessionRef for why the provider id is bound alongside the session id. */
  providerSessions: Record<string, ProviderSessionRef>;
  usage: TaskUsage;
  roleInvocationCounts: Record<string, number>;
}
