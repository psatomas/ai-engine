import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  AgentInvocationRequest,
  AgentResult,
  AgentRun,
  ApprovalPolicy,
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

function mapSandbox(level: SandboxLevel): string {
  switch (level) {
    case "read_only":
      return "read-only";
    case "workspace_write":
      return "workspace-write";
    case "full_access":
      return "danger-full-access";
  }
}

/**
 * `codex exec` has no --ask-for-approval flag (that's interactive-mode
 * only); its non-interactive analog is --approve-for-me, which routes
 * would-be approval prompts through an automatic review instead of failing
 * outright. "never" needs no flag: out-of-sandbox commands simply fail and
 * are reported back to the model.
 */
function approvalFlags(policy: ApprovalPolicy): string[] {
  return policy === "never" ? [] : ["--approve-for-me"];
}

export interface CodexAdapterOptions {
  configuredBinaryPath?: string;
  defaultModel?: string;
  extraArgs?: string[];
  logger?: Logger;
}

export class CodexProvider implements ProviderAdapter {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex CLI";

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  capabilities(): Capability[] {
    return CAPABILITIES;
  }

  private async resolveBinary(): Promise<string> {
    const resolved = await resolveProviderBinary({
      configuredPath: this.options.configuredBinaryPath,
      pathExecutableName: "codex",
      vscodeExtensionIdPrefix: "openai.chatgpt-",
      vscodeExecutableBasename: "codex"
    });
    if (!resolved) {
      throw new Error("Codex CLI not found. Install it (see docs/providers.md) or set providers.codex.binaryPath in the AI Engine config.");
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
    const status = await execa(binaryPath, ["login", "status"], { reject: false });
    const authenticated = status.exitCode === 0;
    return {
      available: true,
      binaryPath,
      version,
      authenticated,
      detail: authenticated ? undefined : (status.stdout || status.stderr || "not logged in").trim()
    };
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
    const tmpDir = await mkdtemp(join(tmpdir(), "ai-engine-codex-"));
    const lastMessageFile = join(tmpDir, "last-message.txt");
    let schemaFile: string | undefined;

    try {
      const args: string[] = ["exec"];
      if (request.resumeSessionId) {
        args.push("resume", request.resumeSessionId, "-");
      } else {
        args.push("-");
      }
      args.push("--json");
      args.push("-s", mapSandbox(request.sandbox));
      args.push(...approvalFlags(request.approval));
      args.push("-C", request.workingDirectory);
      for (const dir of request.additionalWritableDirs ?? []) args.push("--add-dir", dir);
      args.push("-o", lastMessageFile);
      if (request.outputSchema) {
        schemaFile = join(tmpDir, "schema.json");
        await writeFile(schemaFile, JSON.stringify(request.outputSchema), "utf8");
        args.push("--output-schema", schemaFile);
      }
      const model = this.options.defaultModel;
      if (model) args.push("-m", model);
      args.push(...(this.options.extraArgs ?? []));

      // `codex exec` has no separate system-prompt channel (confirmed against --help): unlike
      // Claude's --append-system-prompt, there is no API-level boundary to put the system policy
      // behind. The labelled headers below are an honest acknowledgment of that limitation, not a
      // claim of real separation — they make the (lack of a) boundary visible in the transcript
      // rather than silently concatenating two different authority levels with no marker at all.
      // See docs/providers.md and docs/security.md for why this is a known, accepted limitation
      // for Codex-filled roles rather than something this adapter can structurally fix.
      const prompt = [
        request.systemPrompt.trim()
          ? `=== SYSTEM POLICY (ai-engine; not from this repository) ===\n${request.systemPrompt.trim()}\n=== END SYSTEM POLICY ===`
          : "",
        composeUserPrompt(request)
      ]
        .filter(Boolean)
        .join("\n\n");

      queue.push({ type: "lifecycle", phase: "started", at: new Date().toISOString() });

      const subprocess = execa(binary, args, {
        input: prompt,
        reject: false,
        timeout: request.timeoutMs,
        cancelSignal: controller.signal,
        env: { ...process.env }
      });

      const commandsRun: Array<{ command: string; exitCode: number | null }> = [];
      let providerSessionId: string | undefined;
      let finalMessageFromStream: string | undefined;
      let structuredOutput: unknown;

      if (subprocess.stdout) {
        const rl = createInterface({ input: subprocess.stdout });
        for await (const line of rl) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            queue.push({ type: "raw", data: line });
            continue;
          }
          const evt = this.translateEvent(parsed as Record<string, unknown>);
          if (evt) queue.push(evt);

          const rec = parsed as Record<string, unknown>;
          if (rec.type === "thread.started" && typeof rec.thread_id === "string") {
            providerSessionId = rec.thread_id;
          }
          if (rec.type === "item.completed" && typeof rec.item === "object" && rec.item) {
            const item = rec.item as Record<string, unknown>;
            if (item.type === "command_execution") {
              commandsRun.push({
                command: String(item.command ?? ""),
                exitCode: typeof item.exit_code === "number" ? item.exit_code : null
              });
            }
            if (item.type === "agent_message" && typeof item.text === "string") {
              finalMessageFromStream = item.text;
            }
          }
        }
      }

      let execResult: { exitCode?: number; timedOut?: boolean; stderr?: string };
      try {
        execResult = await subprocess;
      } catch (err) {
        // A cancelSignal abort (or SIGTERM from timeout) rejects even with reject:false in some
        // execa versions; normalize to the same shape we use for a completed process.
        const e = err as { exitCode?: number; timedOut?: boolean; stderr?: string; isCanceled?: boolean };
        execResult = { exitCode: e.exitCode, timedOut: Boolean(e.timedOut), stderr: e.stderr ?? String(err) };
      }

      let finalMessage = finalMessageFromStream;
      try {
        const fromFile = await readFile(lastMessageFile, "utf8");
        if (fromFile.trim()) finalMessage = fromFile.trim();
      } catch {
        // -o file only exists if Codex actually produced a final message; absence is not an error.
      }
      if (request.outputSchema && finalMessage) {
        try {
          structuredOutput = JSON.parse(finalMessage);
        } catch {
          // Model did not return valid JSON for the requested schema; leave structuredOutput unset.
        }
      }

      const cancelled = controller.signal.aborted;
      const status: AgentResult["status"] = cancelled
        ? "cancelled"
        : execResult.timedOut
          ? "timeout"
          : execResult.exitCode === 0
            ? "success"
            : "failure";

      queue.push({ type: "lifecycle", phase: status === "success" ? "completed" : "failed", at: new Date().toISOString() });
      queue.close();

      return {
        status,
        finalMessage,
        structuredOutput,
        providerSessionId,
        commandsRun,
        error:
          status === "failure"
            ? { code: "CODEX_EXEC_FAILED", message: execResult.stderr?.trim() || `codex exec exited with code ${execResult.exitCode}` }
            : undefined
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  private translateEvent(rec: Record<string, unknown>): AgentEvent | undefined {
    const type = rec.type;
    if (type === "error") {
      return { type: "error", code: "CODEX_ERROR", message: String(rec.message ?? "unknown error") };
    }
    if (type === "item.completed" && typeof rec.item === "object" && rec.item) {
      const item = rec.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        return { type: "message", channel: "assistant", text: item.text };
      }
      if (item.type === "reasoning" && typeof item.text === "string") {
        return { type: "message", channel: "reasoning", text: item.text };
      }
      if (item.type === "command_execution") {
        return { type: "command", command: String(item.command ?? ""), cwd: String(item.cwd ?? "") };
      }
      if (item.type === "error") {
        return { type: "error", code: "CODEX_ITEM_ERROR", message: String(item.message ?? "") };
      }
    }
    // Unrecognized event shapes are preserved verbatim rather than dropped.
    return { type: "raw", data: rec };
  }
}
