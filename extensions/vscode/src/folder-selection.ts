/**
 * Pure, vscode-API-free repository-targeting logic for multi-root
 * workspaces (see docs/vscode.md and the hardening-pass audit finding on
 * silent wrong-repository targeting). Kept separate from state.ts so it can
 * be unit-tested directly, without mocking the `vscode` module.
 *
 * The previous implementation fell back to `workspaceFolders[0]` any time
 * there was no active text editor (Command Palette invoked with focus in
 * the terminal, a webview, etc.) — in a multi-root workspace that silently
 * ran a command against whichever folder happened to be first, with no
 * indication to the user. This function never guesses in that situation: it
 * returns "ambiguous" so the caller (ExtensionState/commands.ts) can prompt
 * instead.
 */
export interface FolderRef {
  fsPath: string;
}

export type FolderResolution<F extends FolderRef> = F | "ambiguous" | undefined;

export interface PickFolderInput<F extends FolderRef> {
  workspaceFolders: F[];
  /** The folder containing the currently active editor's document, if any. */
  activeEditorFolder?: F;
  /** A folder the user explicitly picked in an earlier ambiguous prompt, remembered per-window. */
  rememberedFsPath?: string;
}

export function pickFolder<F extends FolderRef>(input: PickFolderInput<F>): FolderResolution<F> {
  const { workspaceFolders, activeEditorFolder, rememberedFsPath } = input;

  if (workspaceFolders.length === 0) return undefined; // no workspace open at all
  if (workspaceFolders.length === 1) return workspaceFolders[0]; // unambiguous regardless of anything else

  // Multi-root from here on: prefer signals that reflect an explicit, current choice over a
  // remembered past one, so switching which editor tab you're looking at actually re-targets.
  if (activeEditorFolder) return activeEditorFolder;

  if (rememberedFsPath) {
    const remembered = workspaceFolders.find((f) => f.fsPath === rememberedFsPath);
    if (remembered) return remembered;
  }

  return "ambiguous";
}
