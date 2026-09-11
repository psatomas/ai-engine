import * as vscode from "vscode";
import {
  IllegalTaskStateError,
  GitStateDivergedError,
  BudgetExceededError,
  WorkspaceConfinementError,
  EmptyRepositoryError,
  type Orchestrator
} from "@ai-engine/orchestrator";
import { TaskLockedError } from "@ai-engine/security";
import type { TaskRecord } from "@ai-engine/core";
import type { ExtensionState } from "./state.js";

/** Turns a known error class into a message that actually tells the user what to do next, instead of a bare stack-trace message. Used by every command's catch handler (see reg() below) — this is the one place that mapping lives. */
function friendlyMessage(err: unknown): string {
  if (err instanceof IllegalTaskStateError) {
    return `${err.message}. Use "AI: Show Workflow Status" to see the task's current state and which command applies next.`;
  }
  if (err instanceof TaskLockedError) {
    return `${err.message} (another AI Engine process — the CLI, or another window — is currently working on this task).`;
  }
  if (err instanceof GitStateDivergedError) {
    return `${err.message} Run "ai acknowledge-divergence <taskId>" from a terminal (or inspect the worktree) before continuing.`;
  }
  if (err instanceof BudgetExceededError) {
    return `${err.message}`;
  }
  if (err instanceof WorkspaceConfinementError || err instanceof EmptyRepositoryError) {
    return `${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerCommands(context: vscode.ExtensionContext, state: ExtensionState, output: vscode.OutputChannel): void {
  const reg = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await fn();
        } catch (err) {
          const message = friendlyMessage(err);
          output.appendLine(`error: ${message}`);
          void vscode.window.showErrorMessage(`AI Engine: ${message}`);
        }
      })
    );

  const requireOrchestrator = async (): Promise<Orchestrator> => {
    const result = await state.currentOrchestrator();
    if (result === undefined) throw new Error("Open a folder that is a Git repository first.");
    if (result === "ambiguous") {
      const folders = state.listWorkspaceFolders();
      const picked = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath })),
        { placeHolder: "Multiple folders are open — which repository should this command act on?" }
      );
      if (!picked?.description) throw new Error("No repository selected — command cancelled.");
      await state.setSelectedFolder(picked.description);
      return requireOrchestrator(); // re-resolve now that a folder is remembered
    }
    return result;
  };

  const requireCurrentTaskId = (): string => {
    const id = state.getCurrentTaskId();
    if (!id) throw new Error('No active task. Run "AI: New Task" first.');
    return id;
  };

  const report = (task: TaskRecord): void => {
    output.appendLine(`[${task.workflowState}] ${task.id} — ${task.originalRequest}`);
    output.show(true);
    state.refresh();
  };

  reg("aiEngine.newTask", async () => {
    const orchestrator = await requireOrchestrator();
    const request = await vscode.window.showInputBox({ prompt: "Describe the engineering task", ignoreFocusOut: true });
    if (!request) return;
    const task = await orchestrator.createTask(request);
    await state.setCurrentTaskId(task.id);
    report(task);
  });

  reg("aiEngine.analyze", async () => {
    const orchestrator = await requireOrchestrator();
    const task = await orchestrator.analyze(requireCurrentTaskId());
    report(task);
  });

  reg("aiEngine.plan", async () => {
    // Analysis and planning are produced together by the architect role in one pass.
    const orchestrator = await requireOrchestrator();
    const task = await orchestrator.analyze(requireCurrentTaskId());
    report(task);
  });

  reg("aiEngine.approvePlan", async () => {
    const orchestrator = await requireOrchestrator();
    const choice = await vscode.window.showQuickPick(["Approve", "Reject"], { placeHolder: "Decision on the current plan" });
    if (!choice) return;
    const task = await orchestrator.decidePlan(requireCurrentTaskId(), choice === "Approve" ? "approved" : "rejected", currentUser());
    report(task);
  });

  reg("aiEngine.implement", async () => {
    const orchestrator = await requireOrchestrator();
    const task = await orchestrator.implement(requireCurrentTaskId());
    report(task);
  });

  reg("aiEngine.verify", async () => {
    const orchestrator = await requireOrchestrator();
    const taskId = requireCurrentTaskId();
    const current = await orchestrator.getTask(taskId);
    if (!current) throw new Error(`Unknown task "${taskId}"`);
    const task = current.workflowState === "VERIFYING" ? await orchestrator.finalVerify(taskId) : await orchestrator.test(taskId);
    report(task);
  });

  reg("aiEngine.approveVerificationCommand", async () => {
    const orchestrator = await requireOrchestrator();
    const taskId = requireCurrentTaskId();
    const checks = await orchestrator.listVerificationChecks(taskId);
    const pending = checks.filter((c) => c.origin === "repository_configured" && !c.approved);
    if (pending.length === 0) {
      void vscode.window.showInformationMessage("No repository-configured verification commands are waiting for approval.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      pending.map((c) => ({ label: c.id, description: c.command, detail: c.description })),
      { placeHolder: "Review the exact command before approving it — this is the same gate the CLI uses" }
    );
    if (!picked) return;
    const confirm = await vscode.window.showWarningMessage(
      `Approve this command to run automatically for this repository from now on?\n\n${picked.description}`,
      { modal: true },
      "Approve"
    );
    if (confirm !== "Approve") return;
    await orchestrator.approveVerificationCommand(taskId, picked.label, currentUser());
    void vscode.window.showInformationMessage(`Approved "${picked.label}".`);
    state.refresh();
  });

  reg("aiEngine.review", async () => {
    const orchestrator = await requireOrchestrator();
    const task = await orchestrator.review(requireCurrentTaskId());
    report(task);
  });

  reg("aiEngine.securityReview", async () => {
    const orchestrator = await requireOrchestrator();
    const taskId = requireCurrentTaskId();
    const current = await orchestrator.getTask(taskId);
    if (!current) throw new Error(`Unknown task "${taskId}"`);
    if (current.workflowState === "PAUSED" && current.pendingGate === "security_review") {
      const choice = await vscode.window.showQuickPick(["Approve", "Reject"], { placeHolder: "Security review sign-off" });
      if (!choice) return;
      const task = await orchestrator.decideGate(taskId, "security_review", choice === "Approve" ? "approved" : "rejected", currentUser());
      report(task);
      return;
    }
    const task = await orchestrator.review(taskId);
    report(task);
  });

  reg("aiEngine.fix", async () => {
    const orchestrator = await requireOrchestrator();
    const task = await orchestrator.fix(requireCurrentTaskId());
    report(task);
  });

  reg("aiEngine.resume", async () => {
    const orchestrator = await requireOrchestrator();
    const taskId = requireCurrentTaskId();
    const current = await orchestrator.getTask(taskId);
    if (current?.pendingGate) {
      const choice = await vscode.window.showQuickPick(["Approve", "Reject"], { placeHolder: `Pending gate: ${current.pendingGate}` });
      if (!choice) return;
      const task = await orchestrator.decideGate(
        taskId,
        current.pendingGate,
        choice === "Approve" ? "approved" : "rejected",
        currentUser()
      );
      report(task);
      return;
    }
    const task = await orchestrator.resume(taskId, currentUser());
    report(task);
  });

  reg("aiEngine.retry", async () => {
    const orchestrator = await requireOrchestrator();
    const taskId = requireCurrentTaskId();
    const note = await vscode.window.showInputBox({ prompt: "Why are you retrying? (optional)", ignoreFocusOut: true });
    const task = await orchestrator.retry(taskId, currentUser(), note || undefined);
    report(task);
  });

  reg("aiEngine.acknowledgeDivergence", async () => {
    const orchestrator = await requireOrchestrator();
    const taskId = requireCurrentTaskId();
    const confirm = await vscode.window.showWarningMessage(
      "This accepts the worktree's current state as correct after a detected git/task-state divergence. Have you inspected the diff?",
      { modal: true },
      "Yes, accept current state"
    );
    if (confirm !== "Yes, accept current state") return;
    const task = await orchestrator.acknowledgeDivergence(taskId, currentUser());
    report(task);
  });

  reg("aiEngine.run", async () => {
    const orchestrator = await requireOrchestrator();
    const task = await orchestrator.run(requireCurrentTaskId());
    report(task);
  });

  reg("aiEngine.cancel", async () => {
    const orchestrator = await requireOrchestrator();
    const confirm = await vscode.window.showWarningMessage("Cancel the current AI Engine task?", { modal: true }, "Cancel Task");
    if (confirm !== "Cancel Task") return;
    const task = await orchestrator.cancel(requireCurrentTaskId(), currentUser());
    report(task);
  });

  reg("aiEngine.status", async () => {
    const orchestrator = await requireOrchestrator();
    const tasks = await orchestrator.listTasks();
    if (tasks.length === 0) {
      void vscode.window.showInformationMessage("No AI Engine tasks yet in this repository.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.id, description: t.workflowState, detail: t.originalRequest })),
      { placeHolder: "Select a task to focus" }
    );
    if (!picked) return;
    await state.setCurrentTaskId(picked.label);
    const task = await orchestrator.getTask(picked.label);
    if (task) report(task);
  });

  reg("aiEngine.refresh", async () => {
    state.refresh();
  });
}

function currentUser(): string {
  return process.env.USER ?? process.env.USERNAME ?? "operator";
}
