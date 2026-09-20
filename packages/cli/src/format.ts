import type { ReviewFinding, TaskRecord, VerificationCheck, VerificationResult } from "@ai-engine/core";

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
      return `${c.id} (${origin}${c.requiredForReady ? ", required" : ""})${approval}\n    ${c.command}`;
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
