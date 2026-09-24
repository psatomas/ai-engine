import type {
  CapacityFreshnessPolicy,
  ReviewFinding,
  TaskRecord,
  UsageEvent,
  UsageTotals,
  VerificationCheck,
  VerificationResult
} from "@ai-engine/core";
import { groupUsageEvents, summarizeUsageEvents } from "@ai-engine/core";
import type { ProviderSummary } from "@ai-engine/orchestrator";
import { formatCapacity, USABLE_EVIDENCE_LEGEND } from "./capacity-format.js";
import { DETAIL_MAX_CHARS, LABEL_MAX_CHARS, sanitizeDisplayText } from "./sanitize.js";

/**
 * `fix()` invokes the same "implementer" role as `implement()` (see
 * UsageEvent in @ai-engine/core) — this is the one place that distinction
 * becomes a human-readable "fixer" label. It's a presentation choice, not a
 * schema or workflow concept: no new role exists anywhere else.
 */
function usageDisplayLabel(role: string, operation: string): string {
  return role === "implementer" && operation === "fix" ? "fixer" : role;
}

function formatUsageMetrics(totals: UsageTotals): string {
  const metrics: string[] = [];
  if (totals.inputTokens !== undefined) metrics.push(`input: ${totals.inputTokens.toLocaleString()}`);
  if (totals.cachedInputTokens !== undefined) metrics.push(`cached: ${totals.cachedInputTokens.toLocaleString()}`);
  if (totals.cacheWriteInputTokens !== undefined) metrics.push(`cache-write: ${totals.cacheWriteInputTokens.toLocaleString()}`);
  if (totals.outputTokens !== undefined) metrics.push(`output: ${totals.outputTokens.toLocaleString()}`);
  if (totals.reasoningOutputTokens !== undefined) metrics.push(`reasoning: ${totals.reasoningOutputTokens.toLocaleString()}`);
  if (totals.costUsd !== undefined) metrics.push(`cost: $${totals.costUsd.toFixed(4)}`);
  return metrics.length ? metrics.join(", ") : "(no usage metrics reported)";
}

function formatInvocations(n: number): string {
  return `${n} invocation${n === 1 ? "" : "s"}`;
}

/**
 * The provider -> role/operation usage breakdown (`ai usage <taskId>`).
 * Never fabricates a `0` for an unreported metric — a bucket with
 * invocations but no numeric usage says so explicitly rather than printing
 * blanks or zeros (see ObservedUsage's "unknown, not zero" contract).
 * Totals/counts are derived from `task.usageEvents` via @ai-engine/core's
 * generic `groupUsageEvents`/`summarizeUsageEvents` — never recomputed from
 * logs, and with no Claude/Codex-specific knowledge beyond the one "fixer"
 * display label above.
 */
export function formatTaskUsage(task: TaskRecord): string {
  if (task.usageEvents.length === 0) return "(no recorded usage for this task)";

  const byProvider = new Map<string, UsageEvent[]>();
  for (const event of task.usageEvents) {
    const bucket = byProvider.get(event.providerId);
    if (bucket) bucket.push(event);
    else byProvider.set(event.providerId, [event]);
  }

  const lines: string[] = [];
  for (const providerId of [...byProvider.keys()].sort()) {
    const events = byProvider.get(providerId)!;
    lines.push(providerId);
    const byLabel = groupUsageEvents(events, (e) => usageDisplayLabel(e.role, e.operation));
    for (const label of Object.keys(byLabel).sort()) {
      const totals = byLabel[label]!;
      lines.push(`  ${label.padEnd(19)} ${formatInvocations(totals.invocations)} — ${formatUsageMetrics(totals)}`);
    }
    lines.push("");
  }

  const total = summarizeUsageEvents(task.usageEvents);
  lines.push(
    `Task total: ${formatInvocations(total.invocations)} across ${byProvider.size} provider${byProvider.size === 1 ? "" : "s"} — ${formatUsageMetrics(total)}`
  );
  return lines.join("\n").trimEnd();
}

export interface ProviderFormatOptions {
  /** The single clock reading for this whole run; taken once by the caller and never re-read while formatting. */
  nowMs: number;
  /** Explicit caller-supplied freshness policy. Without one, no freshness or evidence-usability verdict is shown. */
  freshnessPolicy?: CapacityFreshnessPolicy;
}

/**
 * `ai providers`: identity, availability, capacity windows, roles and capabilities per provider,
 * generically — no provider or window name is recognized. Every string that originates outside this
 * process (ids, labels, versions, roles, diagnostic details) is sanitized for terminal output at this
 * boundary, on a copy; the summaries themselves are never modified. Capacity is presentation only and
 * never feeds availability, selection, or any other behavior.
 */
export function formatProviderSummaries(summaries: ProviderSummary[], options: ProviderFormatOptions): string {
  if (summaries.length === 0) return "(no providers registered)";
  const label = (text: string): string => sanitizeDisplayText(text, LABEL_MAX_CHARS);
  const detail = (text: string): string => sanitizeDisplayText(text, DETAIL_MAX_CHARS);
  let evaluatedWindows = 0;
  const blocks = summaries.map((p) => {
    const capacity = formatCapacity(p.capacity, options);
    evaluatedWindows += capacity.evaluatedWindows;
    const lines = [
      `${label(p.id)}  (${label(p.displayName)})`,
      `    available: ${p.availability.available}${p.availability.authenticated !== undefined ? `, authenticated: ${p.availability.authenticated}` : ""}${p.availability.version ? `, version: ${label(p.availability.version)}` : ""}`,
      ...capacity.lines,
      `    roles:     ${p.roles.length ? p.roles.map(label).join(", ") : "(none configured)"}`,
      `    capabilities: ${p.capabilities.map(label).join(", ")}`
    ];
    if (p.availability.detail) lines.push(`    detail:    ${detail(p.availability.detail)}`);
    return lines.join("\n");
  });
  const output = blocks.join("\n");
  return evaluatedWindows > 0 ? `${output}\n\n${USABLE_EVIDENCE_LEGEND}` : output;
}

export function formatTaskLine(task: TaskRecord): string {
  return `${task.id}  [${task.workflowState}]  ${truncate(task.originalRequest, 60)}`;
}

export function formatTaskDetail(task: TaskRecord): string {
  const lines: string[] = [
    `Task:        ${task.id}`,
    `State:       ${task.workflowState}${task.pendingGate ? ` (pending gate: ${task.pendingGate})` : ""}`,
    `Repository:  ${task.repository.root}`,
    `Worktree:    ${task.git.worktreePath ?? "(none)"}`,
    `Branch:      ${task.git.taskBranch ?? task.git.branch} @ ${task.git.commit.slice(0, 12)}`,
    `Request:     ${task.originalRequest}`,
    `Created:     ${task.createdAt}`,
    `Updated:     ${task.updatedAt}`
  ];
  if (task.agentsUsed.length) {
    lines.push(`Agents used: ${task.agentsUsed.map((a) => `${a.role}=${a.providerId}`).join(", ")}`);
  }
  // Not shown when there's simply no package.json (the common case for non-Node repos) — only
  // when there was something a Node-project operator would actually want to know about.
  if (task.dependencySetup && task.dependencySetup.reason !== "no package.json in the repository root") {
    const d = task.dependencySetup;
    lines.push(
      `Dependencies: ${d.status}${d.packageManager ? ` (${d.packageManager}: ${d.command})` : ""}${d.reason ? ` — ${d.reason}` : ""}`
    );
  }
  if (task.verification.length) {
    lines.push("", "Latest verification:");
    for (const r of task.verification.at(-1)!.results)
      lines.push(`  ${verificationIcon(r.status)} ${r.checkId}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  }
  if (task.reviews.length) {
    lines.push("", "Reviews:");
    for (const review of task.reviews) {
      lines.push(`  ${review.role} (${review.providerId}): ${review.verdict} — ${review.summary}`);
      for (const f of review.findings) lines.push(`    - [${f.severity}] (${f.status}) ${f.summary}`);
    }
  }
  if (task.failures.length) {
    lines.push("", "Failures:");
    for (const f of task.failures) lines.push(`  ${f.at} [${f.state}] ${f.message}`);
  }
  const nextAction = formatNextAction(task);
  if (nextAction) lines.push("", "Next action:", ...nextAction.map((l) => `  ${l}`));
  return lines.join("\n");
}

/**
 * A short "what do I actually do next" hint for `ai status`, so a manual/low-level-mode user
 * doesn't have to re-derive which command applies to the current state from memory. Purely
 * advisory text over the same commands documented in docs/cli.md — never invents a new
 * capability, and guided mode (`ai start`) doesn't consult this at all; it already knows the
 * state semantically. Returns undefined for states with nothing actionable to suggest
 * (CANCELLED, or mid-pipeline states with no single obvious next command).
 */
function formatNextAction(task: TaskRecord): string[] | undefined {
  switch (task.workflowState) {
    case "TASK_CREATED":
      return ["Run analysis and planning.", "", `  ai plan ${task.id}`];
    case "AWAITING_APPROVAL":
      return ["Review the plan and approve it.", "", `  ai approve ${task.id}`];
    case "PAUSED":
      if (task.pendingGate) {
        return [`${task.pendingGate} requires human approval.`, "", `  ai gate ${task.id} ${task.pendingGate}`];
      }
      return ["Task is paused.", "", `  ai resume ${task.id}`];
    case "FAILED":
      return ["A step failed. Retry if this looks transient, otherwise inspect and cancel.", "", `  ai retry ${task.id}`];
    case "BLOCKED":
      // `retry` is legal only from FAILED, never from BLOCKED (see docs/workflow.md) — a second
      // independent review found it suggested here regardless, a command the workflow engine
      // would reject. Only `resume` (keep trying) and `cancel` (give up) are legal from BLOCKED.
      return ["Blocked after repeated failures — a human decision is needed.", "", `  ai resume ${task.id}  |  ai cancel ${task.id}`];
    case "READY":
      return ["Task is READY. Inspect the diff before merging.", "", `  ai diff ${task.id}`];
    case "CANCELLED":
      return undefined;
    default:
      // ANALYZING/IMPLEMENTING/TESTING/REVIEWING/FIXING/VERIFYING/PLAN_READY: mid-pipeline,
      // auto-advanceable — `ai run` (or `ai start`) is always the right next command.
      return ["Continue driving the task forward.", "", `  ai run ${task.id}`];
  }
}

export function formatVerificationResults(results: VerificationResult[]): string {
  return results.map((r) => `${verificationIcon(r.status)} ${r.checkId}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`).join("\n");
}

export function formatVerificationChecks(checks: Array<VerificationCheck & { approved: boolean }>): string {
  if (checks.length === 0) return "(no verification checks configured for this repository)";
  return checks
    .map((c) => {
      const origin = c.origin === "repository_configured" ? "repository-configured" : "auto-detected";
      const approval =
        c.origin === "repository_configured"
          ? c.approved
            ? " [approved]"
            : " [NOT APPROVED — run `ai approve-check <taskId> " + c.id + "`]"
          : "";
      // cwd is part of what a repository-configured approval authorizes (see docs/security.md) —
      // shown whenever set, for auto-detected checks too, so the display is uniform either way.
      const cwd = c.cwd ? `\n    cwd: ${c.cwd}` : "";
      return `${c.id} (${origin}${c.requiredForReady ? ", required" : ""})${approval}\n    ${c.command}${cwd}`;
    })
    .join("\n");
}

export function formatFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "(no findings)";
  return findings
    .map((f) => `[${f.severity}] (${f.status}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}\n    ${f.detail}`)
    .join("\n");
}

function verificationIcon(status: string): string {
  switch (status) {
    case "PASS":
      return "✅";
    case "FAIL":
      return "❌";
    case "SKIPPED":
      return "⏭ ";
    case "NOT_APPROVED":
      return "🔒";
    default:
      return "⚪";
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
