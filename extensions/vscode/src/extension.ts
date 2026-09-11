import * as vscode from "vscode";
import { ExtensionState } from "./state.js";
import { registerCommands } from "./commands.js";
import { createReviewTreeProvider, createTaskTreeProvider, createVerificationTreeProvider } from "./views.js";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("AI Engine");
  const state = new ExtensionState(context);

  context.subscriptions.push(vscode.window.registerTreeDataProvider("aiEngine.taskView", createTaskTreeProvider(state)));
  context.subscriptions.push(vscode.window.registerTreeDataProvider("aiEngine.verificationView", createVerificationTreeProvider(state)));
  context.subscriptions.push(vscode.window.registerTreeDataProvider("aiEngine.reviewView", createReviewTreeProvider(state)));

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "aiEngine.status";
  context.subscriptions.push(statusBar);

  const refreshStatusBar = async () => {
    const orchestrator = await state.currentOrchestrator().catch(() => undefined);
    const taskId = state.getCurrentTaskId();
    const task = orchestrator && orchestrator !== "ambiguous" && taskId ? await orchestrator.getTask(taskId) : undefined;
    statusBar.text = task ? `$(rocket) AI Engine: ${task.workflowState}` : "$(rocket) AI Engine";
    statusBar.tooltip = task ? `${task.id} — ${task.originalRequest}` : "No active AI Engine task";
    statusBar.show();
  };
  state.onDidChange.event(() => void refreshStatusBar());
  void refreshStatusBar();

  registerCommands(context, state, output);

  context.subscriptions.push(output);
  output.appendLine("AI Engine activated.");
}

export function deactivate(): void {
  // Orchestrators hold no open handles beyond file writes already awaited by each call; nothing to tear down.
}
