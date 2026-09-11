import * as vscode from "vscode";
import type { TaskRecord } from "@ai-engine/core";
import type { ExtensionState } from "./state.js";

class Row extends vscode.TreeItem {
  constructor(label: string, description?: string, icon?: vscode.ThemeIcon, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = icon;
    this.tooltip = tooltip ?? description;
  }
}

async function getTask(state: ExtensionState): Promise<TaskRecord | undefined> {
  const orchestrator = await state.currentOrchestrator();
  const taskId = state.getCurrentTaskId();
  // "ambiguous" (multi-root, nothing disambiguates yet) is display-only here — views never
  // prompt on their own; running a command is what resolves it (see commands.ts).
  if (!orchestrator || orchestrator === "ambiguous" || !taskId) return undefined;
  return orchestrator.getTask(taskId);
}

/** Built with a closure over ExtensionState so we don't need DI plumbing through vscode's TreeDataProvider contract. */
export function createTaskTreeProvider(state: ExtensionState): vscode.TreeDataProvider<Row> {
  const emitter = new vscode.EventEmitter<void>();
  state.onDidChange.event(() => emitter.fire());
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (element) => element,
    getChildren: async () => {
      const task = await getTask(state);
      if (!task) return [new Row("No active task", "Run “AI: New Task” to get started")];
      const rows = [
        new Row("Task", task.id),
        new Row("State", task.workflowState + (task.pendingGate ? ` (pending: ${task.pendingGate})` : "")),
        new Row("Request", task.originalRequest),
        new Row("Branch", task.git.taskBranch ?? task.git.branch),
        new Row("Worktree", task.git.worktreePath ?? "(none)")
      ];
      if (task.specification) rows.push(new Row("Specification", truncate(task.specification)));
      if (task.plan) rows.push(new Row("Plan", truncate(task.plan)));
      if (task.agentsUsed.length) rows.push(new Row("Agents used", task.agentsUsed.map((a) => `${a.role}=${a.providerId}`).join(", ")));
      if (task.failures.length) rows.push(new Row("Last failure", truncate(task.failures.at(-1)!.message), new vscode.ThemeIcon("error")));
      return rows;
    }
  };
}

export function createVerificationTreeProvider(state: ExtensionState): vscode.TreeDataProvider<Row> {
  const emitter = new vscode.EventEmitter<void>();
  state.onDidChange.event(() => emitter.fire());
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (element) => element,
    getChildren: async () => {
      const task = await getTask(state);
      const report = task?.verification.at(-1);
      if (!report) return [new Row("No verification results yet")];
      return report.results.map((r) => new Row(r.checkId, r.status, iconFor(r.status), r.reason ?? r.output?.slice(0, 500)));
    }
  };
}

export function createReviewTreeProvider(state: ExtensionState): vscode.TreeDataProvider<Row> {
  const emitter = new vscode.EventEmitter<void>();
  state.onDidChange.event(() => emitter.fire());
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (element) => element,
    getChildren: async () => {
      const task = await getTask(state);
      if (!task || task.reviews.length === 0) return [new Row("No review findings yet")];
      const rows: Row[] = [];
      for (const review of task.reviews) {
        rows.push(
          new Row(
            `${review.role} (${review.providerId})`,
            review.verdict,
            review.verdict === "approved" ? new vscode.ThemeIcon("check") : new vscode.ThemeIcon("warning")
          )
        );
        for (const f of review.findings) {
          rows.push(new Row(`  [${f.severity}] ${f.summary}`, f.status, severityIcon(f.severity), f.detail));
        }
      }
      return rows;
    }
  };
}

function iconFor(status: string): vscode.ThemeIcon {
  switch (status) {
    case "PASS":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "FAIL":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "SKIPPED":
      return new vscode.ThemeIcon("debug-step-over");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function severityIcon(severity: string): vscode.ThemeIcon {
  switch (severity) {
    case "blocker":
    case "major":
      return new vscode.ThemeIcon("error");
    case "minor":
      return new vscode.ThemeIcon("warning");
    default:
      return new vscode.ThemeIcon("info");
  }
}

function truncate(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
