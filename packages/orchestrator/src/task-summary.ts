import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "@ai-engine/core";
import { projectAiDir } from "@ai-engine/config";

/**
 * Writes a human-readable, git-trackable snapshot of a task under
 * .ai/tasks/<id>.md. This is a convenience mirror for code review / PR
 * context — the global TaskStore JSON record remains the authoritative
 * state (see docs/workflow.md).
 */
export async function writeTaskSummary(task: TaskRecord): Promise<void> {
  const dir = join(projectAiDir(task.repository.root), "tasks");
  await mkdir(dir, { recursive: true });

  const lines: string[] = [
    `# Task ${task.id}`,
    "",
    `- State: **${task.workflowState}**`,
    `- Branch: \`${task.git.taskBranch ?? task.git.branch}\` (baseline \`${task.git.commit.slice(0, 12)}\`)`,
    `- Created: ${task.createdAt}`,
    `- Updated: ${task.updatedAt}`,
    "",
    "## Request",
    "",
    task.originalRequest,
    ""
  ];

  if (task.specification) lines.push("## Specification", "", task.specification, "");
  if (task.plan) lines.push("## Plan", "", task.plan, "");

  if (task.verification.length > 0) {
    lines.push("## Verification", "");
    const latest = task.verification.at(-1)!;
    for (const r of latest.results) {
      lines.push(`- ${statusIcon(r.status)} \`${r.checkId}\`: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`);
    }
    lines.push("");
  }

  if (task.reviews.length > 0) {
    lines.push("## Reviews", "");
    for (const review of task.reviews) {
      lines.push(`### ${review.role} (${review.providerId}) — ${review.verdict}`, "", review.summary, "");
      for (const f of review.findings) {
        lines.push(`- [${f.severity}] (${f.status}) ${f.summary}${f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""}`);
      }
      lines.push("");
    }
  }

  if (task.failures.length > 0) {
    lines.push("## Failures", "");
    for (const f of task.failures) lines.push(`- ${f.at} [${f.state}] ${f.message}`);
    lines.push("");
  }

  lines.push("## History", "");
  for (const h of task.history) {
    const actor = typeof h.actor === "string" ? h.actor : `${h.actor.role}:${h.actor.providerId}`;
    lines.push(`- ${h.at} — ${h.from} → ${h.to} (${h.trigger}, by ${actor})`);
  }

  await writeFile(join(dir, `${task.id}.md`), lines.join("\n") + "\n", "utf8");
}

function statusIcon(status: string): string {
  switch (status) {
    case "PASS":
      return "✅";
    case "FAIL":
      return "❌";
    case "SKIPPED":
      return "⏭";
    default:
      return "⚪";
  }
}
