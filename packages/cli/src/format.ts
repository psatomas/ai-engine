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
  return lines.join("\n");
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
            : " [NOT APPROVED — run `ai checks <taskId> approve " + c.id + "`]"
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
