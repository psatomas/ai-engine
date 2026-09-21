import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  AgentInvocationRequest,
  AgentResult,
  AgentRun,
  Capability,
  ObservedUsage,
  ProviderAdapter,
  ProviderAvailability,
  ProviderCapacityInfo,
  SandboxLevel
} from "@ai-engine/core";
import { withManagedTaskMarker } from "@ai-engine/core";
import type { Logger } from "@ai-engine/logging";
import { resolveProviderBinary } from "./resolve.js";
import { composeUserPrompt } from "./prompt.js";
import { AsyncQueue } from "./async-queue.js";
import { readClaudeCapacity } from "./claude-capacity.js";

const CAPABILITIES: Capability[] = [
  "analyze",
  "plan",
  "implement",
  "review",
  "shell_execution",
  "file_modification",
  "streaming",
  "cancellation",
  "status",
  "resume",
  "structured_output"
];

/**
 * Claude Code has no notion of a disk sandbox level of its own; read-only
 * roles are enforced by restricting the tool set (no Edit/Write/Bash)
 * rather than an OS-level flag. workspace_write roles get the default tool
 * set; see permissionModeForSandbox below for how their Bash access is
 * actually authorized headlessly.
 */
function toolsForSandbox(level: SandboxLevel): string[] | undefined {
  if (level === "read_only") return ["Read", "Grep", "Glob"];
  return undefined; // default tool set
}

/**
 * BUG FOUND BY REAL END-TO-END EXECUTION: this used to return "acceptEdits" for every role,
 * on the assumption (stated in the previous version of this comment, never actually verified
 * against a live invocation) that "acceptEdits" plus --permission-prompts none was sufficient
 * for full headless operation. A real fixer run proved that wrong: Read/Edit worked, but a
 * Bash call was auto-denied ("no approval surface in this session").
 *
 * Real testing against this exact CLI build (claude-code 2.1.268, every one of the six documented
 * `--permission-mode` values: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan) found:
 *   - "acceptEdits" only ever auto-accepts Edit/Write prompts. A *simple* Bash command (cat, a
 *     plain `echo >file`) turned out to pass too, but the actual real-world failure —
 *     `npm run <script> 2>&1 | tail -N` — was denied outright: Claude Code's own internal
 *     command-risk classifier treats "run an arbitrary package.json script" as a distinct,
 *     higher-risk category that "acceptEdits" does not cover, and with nobody present to answer
 *     the resulting prompt (--permission-prompts none), it fails closed.
 *   - "dontAsk" and "manual" denied Bash/Write outright in this headless setup — not viable here.
 *   - "auto" and "bypassPermissions" both let the same npm-script Bash call through successfully.
 *   - The difference between them: "auto" keeps Claude Code's own internal safety classifier
 *     active as an additional, best-effort layer (observed firsthand: it declined an
 *     agent-spawning action mid-test with a specific, named reason) — "bypassPermissions" skips
 *     that layer entirely, for no additional capability this workflow needs.
 *   - Neither mode adds real path confinement once Bash is allowed at all: a Bash command can
 *     write outside the working directory regardless of "auto" vs "bypassPermissions" (verified
 *     directly — an explicit absolute-path write outside the project directory succeeded under
 *     both). That is not a new gap this change introduces: it is the same "provider sandbox is
 *     the real boundary, this engine cannot enforce one from outside the provider process"
 *     limitation already documented in @ai-engine/security's SecurityPolicy — permission mode was
 *     never going to be that boundary either way. What actually still applies regardless of this
 *     choice: the dedicated git worktree Claude is invoked in, this engine's own reactive
 *     command-deny-list monitor (SecurityPolicy.evaluateEvent, checked against every event this
 *     adapter emits), and — for read-only roles — `toolsForSandbox` excluding Bash from the tool
 *     set entirely, independent of permission mode.
 *
 * So: "auto" for workspace_write/full_access roles (implementer, fixer) — the smallest change
 * that makes headless Bash actually work, while keeping Claude Code's own classifier as an extra
 * layer "bypassPermissions" would throw away for nothing gained. "read_only" roles keep whatever
 * mode is set here too, but it is inert for them either way: `toolsForSandbox` already excludes
 * Bash/Edit/Write from their tool set, so no permission mode grants them anything.
 */
function permissionModeForSandbox(_level: SandboxLevel): string {
  return "auto";
}

/**
 * Pure and exported specifically so the invocation configuration itself (permission mode, tool
 * restriction, headless flags) can be asserted against directly in a unit test without spawning
 * the real CLI — see claude.test.ts. Kept free of any I/O.
 */
export function buildInvocationArgs(
  request: AgentInvocationRequest,
  options: Pick<ClaudeAdapterOptions, "denyNetworkTools" | "extraArgs" | "defaultModel">,
  sessionId: string
): string[] {
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
  args.push("--permission-mode", permissionModeForSandbox(request.sandbox));
  args.push("--permission-prompts", "none"); // headless: nobody is present to answer a prompt
  const tools = toolsForSandbox(request.sandbox);
  if (tools) args.push("--tools", tools.join(","));
  if (options.denyNetworkTools) args.push("--disallowedTools", "WebFetch,WebSearch");
  for (const dir of request.additionalWritableDirs ?? []) args.push("--add-dir", dir);
  if (request.systemPrompt.trim()) args.push("--append-system-prompt", request.systemPrompt.trim());
  if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
  else args.push("--session-id", sessionId);
  if (request.maxCostUsd) args.push("--max-budget-usd", String(request.maxCostUsd));
  if (request.outputSchema) args.push("--json-schema", JSON.stringify(request.outputSchema));
  if (options.defaultModel) args.push("--model", options.defaultModel);
  args.push(...(options.extraArgs ?? []));
  return args;
}

export interface ClaudeAdapterOptions {
  configuredBinaryPath?: string;
  defaultModel?: string;
  extraArgs?: string[];
  denyNetworkTools?: boolean;
  logger?: Logger;
}

interface ClaudeStreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { role?: string; content?: Array<Record<string, unknown>> };
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /** Tokens served from Anthropic's prompt cache — a cache hit, cheaper than a fresh input token. */
    cache_read_input_tokens?: number;
    /** Tokens written to the prompt cache for future reuse. */
    cache_creation_input_tokens?: number;
  };
  is_error?: boolean;
}

/**
 * FOUND BY INDEPENDENT REVIEW: provider JSON is an external, untrusted runtime boundary here too
 * (see the identical hardening in packages/providers/src/codex.ts) — `parsed = JSON.parse(line)
 * as ClaudeStreamMessage` is an unchecked type assertion; the real runtime value can be anything
 * regardless of what `ClaudeStreamMessage`'s declared field types claim. A malformed or hostile
 * payload could contain a numeric string, a negative number, `null`, `NaN`, or `Infinity` for any
 * token dimension — `validTokenCount` accepts only a genuine finite, non-negative, integer
 * `number`, never coercing with `Number(...)`, `|| 0`, or truthiness. Never observed to be
 * fractional for a real Claude Code token count.
 */
function validTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined; // rejects NaN and +/-Infinity
  if (value < 0) return undefined;
  if (!Number.isInteger(value)) return undefined;
  return value;
}

/**
 * Same untrusted-boundary reasoning as `validTokenCount`, but cost is genuinely fractional
 * (dollars, not a token count) — `total_cost_usd` is real-world observed as e.g. `0.0234` — so
 * this deliberately does NOT require an integer, only finite and non-negative.
 */
function validCost(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return value;
}

/**
 * Maps Claude Code's `result` stream-json message onto the normalized
 * ObservedUsage contract. Anthropic's Messages API (which Claude Code's CLI
 * passes usage through from) has no separate "reasoning tokens" dimension
 * today — extended-thinking tokens are counted inside `output_tokens`, not
 * reported on their own — so `reasoningOutputTokens` is never set here;
 * that's an honest "this provider doesn't report this metric," not an
 * oversight. Exported and pure so it's directly unit-testable without
 * spawning a process.
 *
 * Every dimension is validated independently — one malformed dimension never invalidates the
 * other, genuinely valid dimensions in the same result message. If, after validation, no
 * dimension is valid or present at all, this returns `undefined` (not an all-undefined object),
 * consistent with ObservedUsage's own "unknown, not zero" contract and with the identical choice
 * made for Codex's `toObservedUsage`.
 */
export function usageFromClaudeResult(msg: ClaudeStreamMessage): ObservedUsage | undefined {
  const observed: ObservedUsage = {
    inputTokens: validTokenCount(msg.usage?.input_tokens),
    cachedInputTokens: validTokenCount(msg.usage?.cache_read_input_tokens),
    cacheWriteInputTokens: validTokenCount(msg.usage?.cache_creation_input_tokens),
    outputTokens: validTokenCount(msg.usage?.output_tokens),
    costUsd: validCost(msg.total_cost_usd)
  };
  return Object.values(observed).some((v) => v !== undefined) ? observed : undefined;
}

export class ClaudeProvider implements ProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code CLI";

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  capabilities(): Capability[] {
    return CAPABILITIES;
  }

  getCapacity(): Promise<ProviderCapacityInfo> {
    return readClaudeCapacity();
  }

  private async resolveBinary(): Promise<string> {
    const resolved = await resolveProviderBinary({
      configuredPath: this.options.configuredBinaryPath,
      pathExecutableName: "claude",
      vscodeExtensionIdPrefix: "anthropic.claude-code-",
      vscodeExecutableBasename: "claude"
    });
    if (!resolved) {
      throw new Error(
        "Claude Code CLI not found. Install it (see docs/providers.md) or set providers.claude.binaryPath in the AI Engine config."
      );
    }
    return resolved.path;
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    let binaryPath: string;
    try {
      binaryPath = await this.resolveBinary();
    } catch (err) {
      return { available: false, detail: err instanceof Error ? err.message : String(err) };
    }
    const version = await execa(binaryPath, ["--version"], { reject: false }).then((r) => r.stdout.trim());
    const status = await execa(binaryPath, ["auth", "status"], { reject: false, timeout: 15_000 });
    let authenticated = false;
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(status.stdout) as { loggedIn?: boolean };
      authenticated = Boolean(parsed.loggedIn);
    } catch {
      detail = (status.stdout || status.stderr || "").trim() || undefined;
    }
    return { available: true, binaryPath, version, authenticated, detail };
  }

  invoke(request: AgentInvocationRequest): AgentRun {
    const queue = new AsyncQueue<AgentEvent>();
    const controller = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const result = this.runProcess(request, queue, controller);

    return {
      events: queue,
      result,
      cancel: (reason?: string) => {
        queue.push({ type: "lifecycle", phase: "cancelled", at: new Date().toISOString() });
        if (reason) queue.push({ type: "error", code: "CANCELLED", message: reason });
        controller.abort();
      }
    };
  }

  private async runProcess(
    request: AgentInvocationRequest,
    queue: AsyncQueue<AgentEvent>,
    controller: AbortController
  ): Promise<AgentResult> {
    const binary = await this.resolveBinary();
    const sessionId = request.resumeSessionId ?? randomUUID();
    const args = buildInvocationArgs(request, this.options, sessionId);
    const prompt = composeUserPrompt(request);

    queue.push({ type: "lifecycle", phase: "started", at: new Date().toISOString() });

    const subprocess = execa(binary, args, {
      input: prompt,
      cwd: request.workingDirectory,
      reject: false,
      timeout: request.timeoutMs,
      cancelSignal: controller.signal,
      env: withManagedTaskMarker(process.env, request.taskId)
    });

    let providerSessionId: string | undefined;
    let finalMessage: string | undefined;
    let usage: ObservedUsage | undefined;
    let resultIsError = false;

    if (subprocess.stdout) {
      const rl = createInterface({ input: subprocess.stdout });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let parsed: ClaudeStreamMessage;
        try {
          parsed = JSON.parse(line) as ClaudeStreamMessage;
        } catch {
          queue.push({ type: "raw", data: line });
          continue;
        }
        if (parsed.session_id) providerSessionId = parsed.session_id;

        if (parsed.type === "assistant" || parsed.type === "user") {
          for (const block of parsed.message?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") {
              queue.push({ type: "message", channel: "assistant", text: block.text });
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
              queue.push({ type: "message", channel: "reasoning", text: block.thinking as string });
            } else if (block.type === "tool_use") {
              queue.push({ type: "tool_use", tool: String(block.name ?? "unknown"), input: block.input });
            } else if (block.type === "tool_result") {
              const content = block.content;
              queue.push({
                type: "tool_result",
                tool: String(block.tool_use_id ?? "unknown"),
                isError: Boolean(block.is_error),
                output: typeof content === "string" ? content : JSON.stringify(content)
              });
            }
          }
        } else if (parsed.type === "result") {
          finalMessage = parsed.result;
          usage = usageFromClaudeResult(parsed);
          resultIsError = Boolean(parsed.is_error) || parsed.subtype !== "success";
        } else {
          queue.push({ type: "raw", data: parsed });
        }
      }
    }

    let execResult: { exitCode?: number; timedOut?: boolean; stderr?: string };
    try {
      execResult = await subprocess;
    } catch (err) {
      const e = err as { exitCode?: number; timedOut?: boolean; stderr?: string };
      execResult = { exitCode: e.exitCode, timedOut: Boolean(e.timedOut), stderr: e.stderr ?? String(err) };
    }

    let structuredOutput: unknown;
    if (request.outputSchema && finalMessage) {
      try {
        structuredOutput = JSON.parse(finalMessage);
      } catch {
        // Not valid JSON; leave structuredOutput unset.
      }
    }

    const cancelled = controller.signal.aborted;
    const status: AgentResult["status"] = cancelled
      ? "cancelled"
      : execResult.timedOut
        ? "timeout"
        : execResult.exitCode === 0 && !resultIsError
          ? "success"
          : "failure";

    queue.push({ type: "lifecycle", phase: status === "success" ? "completed" : "failed", at: new Date().toISOString() });
    queue.close();

    return {
      status,
      finalMessage,
      structuredOutput,
      providerSessionId: providerSessionId ?? sessionId,
      usage,
      error:
        status === "failure"
          ? { code: "CLAUDE_EXEC_FAILED", message: execResult.stderr?.trim() || finalMessage || "claude -p exited with an error" }
          : undefined
    };
  }
}
