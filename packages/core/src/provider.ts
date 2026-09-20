import type { Capability } from "./roles.js";
import type { ContextBlock } from "./trust.js";
import type { ObservedUsage } from "./usage.js";

/**
 * A provider is an external coding-agent product (Codex, Claude Code,
 * tomorrow maybe Gemini or a local model). Providers are identified by an
 * opaque string id; the core and workflow packages never switch on this
 * value, they only consult capabilities and the ProviderAdapter port.
 */
export type ProviderId = string;

export type SandboxLevel = "read_only" | "workspace_write" | "full_access";

export type ApprovalPolicy = "never" | "on_request" | "untrusted_only";

export interface AgentInvocationRequest {
  taskId: string;
  role: string;
  /** Provider-independent instructions for this invocation. */
  systemPrompt: string;
  instructions: string;
  /** Reference material, each block explicitly trust-labelled. See trust.ts. */
  context: ContextBlock[];
  /** Absolute path the agent should treat as its working root (normally a task worktree). */
  workingDirectory: string;
  /** Extra directories the agent may read/write besides workingDirectory. */
  additionalWritableDirs?: string[];
  sandbox: SandboxLevel;
  approval: ApprovalPolicy;
  /** Resume a prior provider-native session for this task/role, if supported. */
  resumeSessionId?: string;
  /**
   * For a provider whose native usage reporting is cumulative-per-thread rather than
   * per-invocation (see `cumulativeUsageBaseline` on `AgentResult`), the last cumulative total
   * observed for the exact session being resumed, if AI Engine has a reliable one on record.
   * Ignored by providers that report usage as a natural per-invocation delta (e.g. Claude) or on
   * a fresh (non-resumed) invocation, where there is nothing to subtract from. Never carried over
   * across a provider or session change — see ProviderSessionRef in task.ts.
   */
  previousCumulativeUsage?: ObservedUsage;
  /** Ask the provider to validate/shape its final answer, if it supports structured output. */
  outputSchema?: Record<string, unknown>;
  /** Hard wall-clock budget for this single invocation. */
  timeoutMs?: number;
  /** Optional dollar budget, honored only by providers that support native cost limits. */
  maxCostUsd?: number;
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: "lifecycle"; phase: "started" | "completed" | "failed" | "cancelled"; at: string }
  | { type: "message"; channel: "assistant" | "reasoning"; text: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; isError: boolean; output: string }
  | { type: "command"; command: string; cwd: string }
  | { type: "file_change"; path: string; changeType: "created" | "modified" | "deleted" }
  | ({ type: "usage" } & ObservedUsage)
  | { type: "error"; code: string; message: string }
  | { type: "raw"; data: unknown };

export type AgentResultStatus = "success" | "failure" | "cancelled" | "timeout";

export interface AgentResult {
  status: AgentResultStatus;
  finalMessage?: string;
  structuredOutput?: unknown;
  providerSessionId?: string;
  filesChanged?: string[];
  commandsRun?: Array<{ command: string; exitCode: number | null }>;
  /** Observed usage for this single invocation — see ObservedUsage in usage.ts for the "unknown, not zero" contract. */
  usage?: ObservedUsage;
  /**
   * For a provider whose native usage reporting is cumulative-per-thread (see
   * `previousCumulativeUsage` on `AgentInvocationRequest`), the raw new cumulative total observed
   * this call — bookkeeping only, for the orchestrator to persist as the next invocation's
   * baseline. This is never "what happened this call" (that's `usage` above) and is never itself
   * fed into `UsageEvent`/summarization/display. A provider that reports natural per-invocation
   * deltas (e.g. Claude) never sets this.
   */
  cumulativeUsageBaseline?: ObservedUsage;
  error?: { code: string; message: string };
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  result: Promise<AgentResult>;
  cancel(reason?: string): void;
}

export interface ProviderAvailability {
  available: boolean;
  binaryPath?: string;
  version?: string;
  authenticated?: boolean;
  detail?: string;
}

/**
 * Account/plan metadata a provider's own status surface reports directly.
 * `planLabel` must only ever be set from something the provider itself
 * states (e.g. a field in its auth-status output) — never inferred or
 * guessed from observed token counts or invocation behavior.
 */
export interface ProviderAccountInfo {
  accountLabel?: string;
  planLabel?: string;
}

/** A single independently reported quota window, not an execution/availability verdict. */
export interface CapacityWindow {
  /** Opaque identity unique within this provider's report; consumers must not infer duration from it. */
  id: string;
  /** Optional human-readable name, separate from identity. */
  label?: string;
  /** Reported window length in seconds, when known; never inferred from id. */
  durationSeconds?: number;
  /**
   * Historical observed utilization: undefined is unknown, 0 is genuinely unused, and 1 is
   * fully used. Finite nonnegative values above 1 preserve reported overage. Producers must
   * validate external values; TypeScript's number type alone does not enforce this contract.
   * Utilization does not establish execution blocking, authentication, or availability.
   */
  usedFraction?: number;
  /** ISO 8601 time the evidence was observed/recorded, NOT the time AI Engine read it. */
  observedAt?: string;
  /** Reported ISO 8601 reset time; its passage never changes the observed utilization. */
  resetsAt?: string;
}

/**
 * A known report describes zero or more independent windows; individual utilization may still
 * be unknown. Neither "known" nor a timestamp asserts freshness or current usable allowance.
 * Unknown capacity remains an expected result for adapters with no capacity information.
 * There is deliberately no provider-wide aggregate fraction or reset timestamp.
 */
export type ProviderCapacityInfo = {
  account?: ProviderAccountInfo;
  detail?: string;
} & ({ status: "known"; windows: CapacityWindow[] } | { status: "unknown"; windows?: never });

/**
 * Derives remaining quota from a single observed utilization, not current capacity. Invalid
 * utilization stays unknown; overage remains intact on the observation but has zero remainder.
 * No clock, reset, window aggregation, or execution-blocking policy is involved.
 */
export function remainingCapacityFraction(usedFraction: number | undefined): number | undefined {
  if (usedFraction === undefined || !Number.isFinite(usedFraction) || usedFraction < 0) return undefined;
  return Math.max(0, 1 - usedFraction);
}

export const UNKNOWN_PROVIDER_CAPACITY: ProviderCapacityInfo = { status: "unknown" };

/**
 * The single seam between the provider-independent core and a real product.
 * Everything the workflow engine needs from an external coding agent is
 * expressed here; nothing outside a provider package may import a
 * provider-specific module.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  capabilities(): Capability[];
  checkAvailability(): Promise<ProviderAvailability>;
  invoke(request: AgentInvocationRequest): AgentRun;
  /**
   * Provider-account capacity/quota, only for adapters whose product can
   * reliably report it. Optional and expected to be absent for most
   * adapters today — callers must treat a missing method identically to one
   * that resolves `{ status: "unknown" }`, never as an error.
   */
  getCapacity?(): Promise<ProviderCapacityInfo>;
}
