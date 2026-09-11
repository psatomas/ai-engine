import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  AgentInvocationRequest,
  AgentResult,
  AgentRun,
  Capability,
  ProviderAdapter,
  ProviderAvailability,
  SandboxLevel
} from "@ai-engine/core";
import type { Logger } from "@ai-engine/logging";
import { resolveProviderBinary } from "./resolve.js";
import { composeUserPrompt } from "./prompt.js";
import { AsyncQueue } from "./async-queue.js";

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
 * roles are enforced by restricting the tool set (no Edit/Write/Bash-write)
 * rather than an OS-level flag. workspace_write roles get the default tool
 * set plus --permission-mode acceptEdits so file edits don't block on a
 * prompt nobody is present to answer.
 */
function toolsForSandbox(level: SandboxLevel): string[] | undefined {
  if (level === "read_only") return ["Read", "Grep", "Glob"];
  return undefined; // default tool set
}

/**
 * Every role uses "acceptEdits" (auto-accept file-edit prompts; nothing
 * else needs an interactive answer with --permission-prompts none already
 * set). A read-only role's actual enforcement comes entirely from
 * `toolsForSandbox` excluding Edit/Write/Bash — "acceptEdits" is then
 * inert for it (there is nothing left in its tool set that mode would ever
 * apply to).
 *
 * This deliberately does NOT use Claude Code's "plan" permission mode for
 * read-only roles, even though it reads as a natural fit. Per the hardening
 * audit ("verify Claude headless plan-mode behavior rather than assuming it
 * works"): plan mode is designed around an interactive human confirming a
 * plan before execution, and its exact behavior under `-p
 * --output-format stream-json` (headless, nobody present to confirm) was
 * never exercised against a live invocation — see docs/providers.md. Tool
 * restriction is a mechanical guarantee that doesn't depend on that
 * unverified behavior, so it — not permission mode — is the real boundary
 * here.
 */
function permissionModeForSandbox(_level: SandboxLevel): string {
  return "acceptEdits";
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
  usage?: { input_tokens?: number; output_tokens?: number };
  is_error?: boolean;
}

export class ClaudeProvider implements ProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code CLI";

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  capabilities(): Capability[] {
    return CAPABILITIES;
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

    const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
    args.push("--permission-mode", permissionModeForSandbox(request.sandbox));
    args.push("--permission-prompts", "none"); // headless: nobody is present to answer a prompt
    const tools = toolsForSandbox(request.sandbox);
    if (tools) args.push("--tools", tools.join(","));
    if (this.options.denyNetworkTools) args.push("--disallowedTools", "WebFetch,WebSearch");
    for (const dir of request.additionalWritableDirs ?? []) args.push("--add-dir", dir);
    if (request.systemPrompt.trim()) args.push("--append-system-prompt", request.systemPrompt.trim());
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    else args.push("--session-id", sessionId);
    if (request.maxCostUsd) args.push("--max-budget-usd", String(request.maxCostUsd));
    if (request.outputSchema) args.push("--json-schema", JSON.stringify(request.outputSchema));
    const model = this.options.defaultModel;
    if (model) args.push("--model", model);
    args.push(...(this.options.extraArgs ?? []));

    const prompt = composeUserPrompt(request);

    queue.push({ type: "lifecycle", phase: "started", at: new Date().toISOString() });

    const subprocess = execa(binary, args, {
      input: prompt,
      cwd: request.workingDirectory,
      reject: false,
      timeout: request.timeoutMs,
      cancelSignal: controller.signal,
      env: { ...process.env }
    });

    let providerSessionId: string | undefined;
    let finalMessage: string | undefined;
    let costUsd: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
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
          costUsd = parsed.total_cost_usd;
          inputTokens = parsed.usage?.input_tokens;
          outputTokens = parsed.usage?.output_tokens;
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
      usage: { inputTokens, outputTokens, costUsd },
      error:
        status === "failure"
          ? { code: "CLAUDE_EXEC_FAILED", message: execResult.stderr?.trim() || finalMessage || "claude -p exited with an error" }
          : undefined
    };
  }
}
