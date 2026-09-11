import * as vscode from "vscode";
import { createOrchestrator, type Orchestrator } from "@ai-engine/orchestrator";
import { pickFolder } from "./folder-selection.js";

const REMEMBERED_FOLDER_KEY = "aiEngine.selectedFolder";

/**
 * One Orchestrator per workspace folder (each owns its own git repo,
 * project config, and task store view), plus which task the UI is
 * currently focused on for that folder.
 *
 * Multi-root targeting: see folder-selection.ts. `resolveFolder()` never
 * silently guesses — it returns "ambiguous" when the workspace has more
 * than one folder and nothing (active editor, a prior explicit choice)
 * disambiguates it, so commands.ts can prompt instead of risking acting on
 * the wrong repository.
 */
export class ExtensionState {
  private readonly orchestrators = new Map<string, Orchestrator>();
  public readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  listWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  private activeEditorFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
  }

  resolveFolder(): vscode.WorkspaceFolder | "ambiguous" | undefined {
    const folders = [...this.listWorkspaceFolders()];
    const refs = folders.map((f) => ({ fsPath: f.uri.fsPath }));
    const activeEditor = this.activeEditorFolder();
    const picked = pickFolder({
      workspaceFolders: refs,
      activeEditorFolder: activeEditor ? { fsPath: activeEditor.uri.fsPath } : undefined,
      rememberedFsPath: this.context.workspaceState.get<string>(REMEMBERED_FOLDER_KEY)
    });
    if (picked === undefined || picked === "ambiguous") return picked;
    return folders.find((f) => f.uri.fsPath === picked.fsPath);
  }

  /** Records an explicit user choice from the ambiguous-folder prompt (commands.ts) so subsequent commands don't ask again until the workspace changes. */
  async setSelectedFolder(fsPath: string): Promise<void> {
    await this.context.workspaceState.update(REMEMBERED_FOLDER_KEY, fsPath);
    this.onDidChange.fire();
  }

  /** "ambiguous" means the caller must prompt (see commands.ts's requireOrchestrator). */
  async currentOrchestrator(): Promise<Orchestrator | "ambiguous" | undefined> {
    const folder = this.resolveFolder();
    if (folder === undefined || folder === "ambiguous") return folder;
    const key = folder.uri.fsPath;
    let orchestrator = this.orchestrators.get(key);
    if (!orchestrator) {
      orchestrator = await createOrchestrator(key);
      this.orchestrators.set(key, orchestrator);
    }
    return orchestrator;
  }

  getCurrentTaskId(): string | undefined {
    const folder = this.resolveFolder();
    if (!folder || folder === "ambiguous") return undefined;
    return this.context.workspaceState.get<string>(`aiEngine.currentTask.${folder.uri.fsPath}`);
  }

  async setCurrentTaskId(taskId: string): Promise<void> {
    const folder = this.resolveFolder();
    if (!folder || folder === "ambiguous") return;
    await this.context.workspaceState.update(`aiEngine.currentTask.${folder.uri.fsPath}`, taskId);
    this.onDidChange.fire();
  }

  refresh(): void {
    this.onDidChange.fire();
  }
}
