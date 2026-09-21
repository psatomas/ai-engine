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
  ObservedUsage,
  ProviderAdapter,
  ProviderAvailability,
  ProviderCapacityInfo,
  SandboxLevel
} from "@ai-engine/core";
import { subtractObservedUsage } from "@ai-engine/core";
import type { Logger } from "@ai-engine/logging";
import { resolveProviderBinary } from "./resolve.js";
import { composeUserPrompt } from "./prompt.js";
import { AsyncQueue } from "./async-queue.js";
import { readCodexCapacity } from "./codex-capacity.js";

/**
 * FOUND BY INDEPENDENT REVIEW: provider JSON is an external, untrusted runtime boundary — the
 * `number` types below describe what a well-formed payload looks like, but nothing enforces that
 * the real value on the wire actually is one. A malformed or hostile payload could contain a
 * numeric string ("10"), a negative number, `null`, `NaN`, or `Infinity`; naively assigning it
 * straight through (the previous behavior) let a string silently concatenate into other sums, a
 * negative value silently corrupt totals, and `null` silently coerce to a fabricated `0` the
 * moment it reached arithmetic (`0 + null === 0` in JS — indistinguishable from a real, reported
 * zero).
 *
 * `validTokenCount` is the one place this boundary is enforced: only a genuine finite,
 * non-negative, integer `number` is accepted — anything else is omitted (stays `undefined`,
 * consistent with ObservedUsage's own "unknown, not zero" contract) rather than coerced.
 * Never `Number(...)`, `|| 0`, or plain truthiness here — all of those convert garbage into a
 * number that was never actually reported. Every real token count observed live (across both
 * `turn.completed` and `token_count` shapes) has been a non-negative integer; there is no
 * evidence Codex ever reports a fractional token count, so integers are required, not just
 * "finite numbers."
 */
function validTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined; // rejects NaN and +/-Infinity
  if (value < 0) return undefined;
  if (!Number.isInteger(value)) return undefined;
  return value;
}

/**
 * Validates every dimension independently — one malformed dimension (e.g. a corrupted
 * `cached_input_tokens`) never invalidates the other, genuinely valid dimensions in the same
 * usage record. If, after validation, *no* dimension is valid at all, this returns `undefined`
 * rather than an all-`undefined` `ObservedUsage` object — both are semantically "nothing was
 * reported," but returning `undefined` here specifically means a fully-malformed `turn.completed`
 * is never mistaken for a genuine (if all-zero) usage report.
 */
function toObservedUsage(usage: Record<string, unknown> | undefined): ObservedUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const observed: ObservedUsage = {
    inputTokens: validTokenCount(usage.input_tokens),
    cachedInputTokens: validTokenCount(usage.cached_input_tokens),
    cacheWriteInputTokens: validTokenCount(usage.cache_write_input_tokens),
    outputTokens: validTokenCount(usage.output_tokens),
    reasoningOutputTokens: validTokenCount(usage.reasoning_output_tokens)
  };
  return Object.values(observed).some((v) => v !== undefined) ? observed : undefined;
}

/**
 * Recognizes usage on Codex's `turn.completed` event — confirmed *live*
 * against real authenticated `codex exec --json` invocations (codex-cli
 * 0.154.0):
 * `{"type":"turn.completed","usage":{"input_tokens":...,
 * "cached_input_tokens":...,"cache_write_input_tokens":...,"output_tokens":...,
 * "reasoning_output_tokens":...}}`. This is the actual, current shape the
 * stream this adapter parses emits, no `event_msg` wrapper needed.
 *
 * CORRECTED BY INDEPENDENT REVIEW (twice): this adapter previously assumed
 * `turn.completed.usage` was a per-invocation delta ("turn is the delta
 * unit"). It is not. Confirmed live with a real, chained fresh -> resume
 * experiment against the same thread: turn 1 (fresh) reported
 * `cached_input_tokens: 12160`; turn 2 (resumed, a similarly trivial prompt)
 * reported `cached_input_tokens: 24320` — *exactly* double, not a fresh,
 * independent per-turn number — and `input_tokens` likewise roughly doubled
 * (16597 -> 33554). `turn.completed.usage` is the *cumulative* total for the
 * whole underlying thread as of that call (`ThreadTokenUsage.total`,
 * per independent review), not this call's own delta. `codex exec` still
 * emits exactly one `turn.completed` per process invocation (unchanged from
 * prior live testing), so this function returns that one cumulative
 * snapshot as-is — converting it into *this invocation's own* usage is a
 * separate concern that needs the caller's prior baseline; see
 * `codexInvocationUsage` below.
 */
function usageFromTurnCompleted(rec: Record<string, unknown>): ObservedUsage | undefined {
  if (rec.type !== "turn.completed") return undefined;
  const usage = rec.usage;
  if (!usage || typeof usage !== "object") return undefined;
  return toObservedUsage(usage as Record<string, unknown>);
}

/**
 * REMOVED BY INDEPENDENT REVIEW (compatibility `token_count` support): this adapter previously
 * also recognized Codex's internal `token_count` event (real, but only ever observed on Codex's
 * separate rollout-persistence file format, never on the live `codex exec --json` stream this
 * adapter actually reads) as a compatibility fallback. Two independent problems made it not
 * worth keeping: (1) Codex can emit repeated `token_count`-style notifications purely because
 * rate-limit information changed, with no new token consumption at all — summing (or even just
 * accepting) repeated snapshots as if each were a fresh delta risks double-counting real usage
 * for a family of events this adapter has *zero* live evidence it ever even receives; (2) with
 * `turn.completed.usage` now confirmed live as this stream's one real, authoritative telemetry
 * source, a compatibility path for an event shape that has never once been observed on this
 * stream is speculative complexity with no demonstrated benefit — "simpler and safer" (the
 * standard this correction was held to) means removing it, not making its (already unsound)
 * summation "safer." If a future Codex CLI version's `exec --json` stream is ever confirmed to
 * emit `token_count`, re-adding support for it — correctly, as a non-summed snapshot, exactly
 * like `turn.completed` — is a fresh, evidence-driven decision, not a default kept "just in
 * case." `turn.completed.usage` alone is the authoritative and only supported telemetry source.
 */
export function usageFromCodexEvent(rec: Record<string, unknown>): ObservedUsage | undefined {
  return usageFromTurnCompleted(rec);
}

/**
 * `codex exec` emits exactly one `turn.completed` per process invocation (confirmed live,
 * including with a multi-tool-call prompt: several `item.completed` events but a single
 * trailing `turn.completed`). If a stream ever contained more than one (not observed, but not
 * structurally impossible either), the LAST one is authoritative, never a sum of all of
 * them — `turn.completed.usage` is a cumulative snapshot, not a delta (see
 * usageFromTurnCompleted's doc comment), so summing multiple snapshots would multiply the
 * reported total rather than combine independent deltas the way the pre-cumulative-discovery
 * design (incorrectly) did.
 */
export function latestCodexUsage(records: Iterable<Record<string, unknown>>): ObservedUsage | undefined {
  let latest: ObservedUsage | undefined;
  for (const rec of records) {
    const usage = usageFromTurnCompleted(rec);
    if (usage) latest = usage;
  }
  return latest;
}

/**
 * Converts Codex's raw, cumulative-per-thread `turn.completed.usage` (see
 * usageFromTurnCompleted) into *this invocation's own* observed delta — the value every other
 * part of AI Engine (`UsageEvent`, `sumObservedUsage`, budget enforcement) already assumes
 * `AgentResult.usage` means.
 *
 * - Fresh invocation (not resuming): the cumulative total IS this invocation's own delta —
 *   there is nothing before it in the thread to subtract, so the raw snapshot is returned as-is.
 * - Resumed invocation with a known, reliable prior cumulative baseline for this exact session
 *   (`previousCumulativeUsage`, which the caller must supply only for the same provider+session
 *   that produced it): `current - previous`, via
 *   `subtractObservedUsage` (never negative, never fabricated — see its own doc comment).
 * - Resumed invocation with NO reliable baseline (none on record, a provider/session change, or
 *   Codex simply never having reported usage on the prior call):
 *   `undefined` — reporting "unknown" is correct here; reporting the raw cumulative number would
 *   silently and substantially overstate this single invocation's actual consumption.
 */
export function codexInvocationUsage(
  rawCumulativeUsage: ObservedUsage | undefined,
  isResuming: boolean,
  previousCumulativeUsage: ObservedUsage | undefined
): ObservedUsage | undefined {
  if (!isResuming) return rawCumulativeUsage;
  if (!rawCumulativeUsage || !previousCumulativeUsage) return undefined;
  return subtractObservedUsage(rawCumulativeUsage, previousCumulativeUsage);
}

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
 * BUG FOUND BY REAL END-TO-END EXECUTION: `codex exec` has no --ask-for-approval
 * flag (that's interactive-mode only); its non-interactive analog is
 * --approve-for-me, which routes would-be approval prompts through an
 * automatic review instead of failing outright. "never" needs no flag:
 * out-of-sandbox commands simply fail and are reported back to the model,
 * and an explicit `-s <mode>` is always safe alongside it.
 *
 * For any other `ApprovalPolicy`, `--approve-for-me` and an explicit `-s`
 * turn out to be mutually exclusive at the real CLI's own argument parser —
 * confirmed live against codex-cli 0.154.0 for *every* sandbox value, not
 * just a mismatched one: `error: the argument '--sandbox <SANDBOX_MODE>'
 * cannot be used with '--approve-for-me'`. `--approve-for-me` itself always
 * implies workspace-write sandboxing (confirmed against `codex exec
 * --help`: "Route approval requests through automatic review using the
 * workspace-write sandbox") — it cannot be told to route approvals under a
 * different sandbox level at all.
 *
 * So a non-"never" policy can only be represented when the requested
 * sandbox already IS workspace_write (the two then agree, and
 * --approve-for-me is sent alone, no redundant/conflicting -s). A
 * read_only or full_access sandbox combined with a non-"never" policy has
 * no safe representation on this CLI: silently sending --approve-for-me
 * anyway would grant workspace-write when read_only or
 * danger-full-access was actually requested (weakening — read_only — or
 * changing — full_access — the sandbox without being asked to), and
 * silently sending `-s` alone would drop the requested auto-approval
 * behavior without saying so (a silent reinterpretation of the policy).
 * Neither is a call this adapter makes on its own; see the "unsupported"
 * branch's caller in runProcess, which fails the invocation explicitly
 * instead of ever building a command the CLI would reject.
 */
export function codexApprovalAndSandboxArgs(sandbox: SandboxLevel, approval: ApprovalPolicy): { args: string[] } | { error: string } {
  if (approval === "never") return { args: ["-s", mapSandbox(sandbox)] };
  if (sandbox === "workspace_write") return { args: ["--approve-for-me"] };
  return {
    error:
      `Codex CLI cannot represent approval policy "${approval}" together with sandbox "${sandbox}": ` +
      `--approve-for-me always implies workspace-write sandboxing and cannot be combined with an explicit ` +
      `-s flag on this CLI. Only "never" is supported with a read_only or full_access sandbox.`
  };
}

export interface CodexArgsFiles {
  outputLastMessageFile: string;
  schemaFile?: string;
}

/**
 * The single source of truth for the real argv sent to `codex exec`/`codex exec resume` —
 * fresh and resumed invocations share the *same* approval/sandbox policy validation
 * (`codexApprovalAndSandboxArgs` above) before either one is allowed to build a command at all,
 * AND fresh and resumed invocations both actually carry the validated policy through to Codex.
 *
 * BUG FOUND BY REAL END-TO-END EXECUTION, found *again* by a first round of independent review
 * (which correctly identified that resume validation was being skipped entirely), then found
 * *again*, more precisely, by a second round: the first fix's claim that "`codex exec resume`
 * has no flags to carry sandbox/approval at all" was wrong. It was based only on `codex exec
 * resume --help` — the `resume` *subcommand's own* option list — without checking whether the
 * *parent* `exec` command's options (which include `-s`/`--approve-for-me`/`-C`/`--add-dir`,
 * confirmed present in `codex exec --help`, not just `codex exec resume --help`) can be
 * positioned *before* the `resume` subcommand on the same command line. They can — confirmed
 * live, for free, with no billed model call, against the installed CLI (codex-cli 0.154.0):
 * `codex exec -s read-only resume <id> -` and `codex exec --approve-for-me resume <id> -` both
 * pass argument parsing cleanly (failing only later, semantically, on "no rollout found for
 * thread id" for a deliberately bogus id — proof the flags were accepted, not proof of their
 * downstream effect on a *real* thread, which was not separately billed-call-verified). The
 * same `-s`/`--approve-for-me` mutual-exclusion conflict `codexApprovalAndSandboxArgs` already
 * enforces applies identically at this parent-level position (also confirmed live: `codex exec
 * -s read-only --approve-for-me resume <id> -` produces the identical "cannot be used with"
 * parser error as the fresh-invocation case).
 *
 * So: policy args are positioned at the `exec` parent level, BEFORE `resume <sessionId> -`, for
 * a resumed invocation — never omitted. A resumed invocation must not silently fall back to
 * whatever sandbox Codex's current default/config happens to be; the validated policy is sent
 * explicitly on every invocation, fresh or resumed, identically in kind (only the position in
 * the argv differs, because `resume` is itself a positional subcommand token that has to come
 * after any options meant for the parent `exec` command). `-C`/`--add-dir` positioning for
 * resume is intentionally NOT changed by this fix (out of scope for the policy-enforcement
 * finding this addresses) — working directory for a resumed invocation still goes through
 * execa's own `cwd` option, unchanged from before.
 */
export function buildCodexArgs(
  request: Pick<AgentInvocationRequest, "resumeSessionId" | "sandbox" | "approval" | "workingDirectory" | "additionalWritableDirs">,
  files: CodexArgsFiles,
  options: Pick<CodexAdapterOptions, "defaultModel" | "extraArgs"> = {}
): { args: string[] } | { error: string } {
  const approvalAndSandbox = codexApprovalAndSandboxArgs(request.sandbox, request.approval);
  if ("error" in approvalAndSandbox) return approvalAndSandbox;

  const args: string[] = ["exec"];
  if (request.resumeSessionId) {
    // Policy args are parent-`exec`-level options — they must be positioned before the `resume`
    // subcommand token, not after it (see this function's doc comment for the live confirmation).
    args.push(...approvalAndSandbox.args);
    args.push("resume", request.resumeSessionId, "-");
  } else {
    args.push("-");
    args.push(...approvalAndSandbox.args);
    args.push("-C", request.workingDirectory);
    for (const dir of request.additionalWritableDirs ?? []) args.push("--add-dir", dir);
  }
  args.push("--json");
  args.push("-o", files.outputLastMessageFile);
  if (files.schemaFile) args.push("--output-schema", files.schemaFile);
  if (options.defaultModel) args.push("-m", options.defaultModel);
  args.push(...(options.extraArgs ?? []));
  return { args };
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

  /**
   * Passive local acquisition only — see readCodexCapacity's own doc comment for the full
   * rationale. Never resolves/launches the Codex binary, never touches the network, never
   * consumes a model turn, and is entirely independent of invoke()/checkAvailability().
   */
  getCapacity(): Promise<ProviderCapacityInfo> {
    return readCodexCapacity();
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
    // EVERY invocation — fresh or resumed — is validated against the same approval/sandbox
    // policy before Codex is ever resolved or spawned. Checked here, first, with no I/O at all,
    // so an unsupported combination (fresh or resumed) fails identically and immediately; see
    // buildCodexArgs's own doc comment for exactly how the validated policy is then actually
    // carried through to a resumed invocation (positioned before the `resume` subcommand).
    const earlyCheck = codexApprovalAndSandboxArgs(request.sandbox, request.approval);
    if ("error" in earlyCheck) {
      const at = new Date().toISOString();
      queue.push({ type: "lifecycle", phase: "started", at });
      queue.push({ type: "lifecycle", phase: "failed", at });
      queue.close();
      return { status: "failure", error: { code: "CODEX_UNSUPPORTED_APPROVAL_SANDBOX", message: earlyCheck.error } };
    }

    const binary = await this.resolveBinary();
    const tmpDir = await mkdtemp(join(tmpdir(), "ai-engine-codex-"));
    const lastMessageFile = join(tmpDir, "last-message.txt");
    let schemaFile: string | undefined;

    try {
      if (request.outputSchema) {
        schemaFile = join(tmpDir, "schema.json");
        await writeFile(schemaFile, JSON.stringify(request.outputSchema), "utf8");
      }
      const built = buildCodexArgs(request, { outputLastMessageFile: lastMessageFile, schemaFile }, this.options);
      if ("error" in built) {
        // Unreachable in practice (earlyCheck above already validated the identical inputs) —
        // handled anyway because buildCodexArgs is a fully self-contained, independently-correct
        // function and its return type says this is possible; never silently ignored.
        const at = new Date().toISOString();
        queue.push({ type: "lifecycle", phase: "started", at });
        queue.push({ type: "lifecycle", phase: "failed", at });
        queue.close();
        return { status: "failure", error: { code: "CODEX_UNSUPPORTED_APPROVAL_SANDBOX", message: built.error } };
      }
      const args = built.args;

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
        cwd: request.workingDirectory,
        reject: false,
        timeout: request.timeoutMs,
        cancelSignal: controller.signal,
        env: { ...process.env }
      });

      const commandsRun: Array<{ command: string; exitCode: number | null }> = [];
      // Only usage-relevant records are kept (not the whole stream) — latestCodexUsage picks the
      // one authoritative (last, cumulative) snapshot at the end; see its doc comment for why
      // this must never be summed.
      const usageRecords: Record<string, unknown>[] = [];
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
          if (usageFromCodexEvent(rec)) usageRecords.push(rec);
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

      // rawCumulativeUsage is Codex's own raw, cumulative-per-thread snapshot (see
      // usageFromTurnCompleted). `usage` (this invocation's own delta) and
      // cumulativeUsageBaseline (the raw snapshot, returned so a caller can carry it forward as
      // the next resume's baseline) are deliberately different values — see codexInvocationUsage.
      const rawCumulativeUsage = latestCodexUsage(usageRecords);
      const resuming = Boolean(request.resumeSessionId);

      return {
        status,
        finalMessage,
        structuredOutput,
        providerSessionId,
        commandsRun,
        usage: codexInvocationUsage(rawCumulativeUsage, resuming, request.previousCumulativeUsage),
        cumulativeUsageBaseline: rawCumulativeUsage,
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
