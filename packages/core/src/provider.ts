import type { Capability } from "./roles.js";
import type { ContextBlock } from "./trust.js";

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
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
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
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
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
}
