import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A minimal fake of the parts of the `vscode` module ExtensionState
 * actually touches. There is no real `vscode` module available outside the
 * extension host, so this is what lets state.ts (and, by extension, the
 * multi-root targeting fix) run under plain `vitest` instead of requiring
 * @vscode/test-electron (which needs to download a real VS Code binary —
 * impractical in this environment; see docs/vscode.md for the tradeoff).
 * The decision logic itself (pickFolder) has its own vscode-free tests in
 * folder-selection.test.ts; this file exists to prove ExtensionState wires
 * that logic to the real vscode.workspace/window shape correctly.
 */
class FakeEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const listener of this.listeners) listener(e);
  }
}

interface FakeFolder {
  uri: { fsPath: string };
  name: string;
}

const fakeWorkspace: { folders: FakeFolder[]; activeDocumentFsPath: string | undefined } = {
  folders: [],
  activeDocumentFsPath: undefined
};

vi.mock("vscode", () => ({
  EventEmitter: FakeEventEmitter,
  workspace: {
    get workspaceFolders() {
      return fakeWorkspace.folders;
    },
    getWorkspaceFolder: (uri: { fsPath: string }) => fakeWorkspace.folders.find((f) => f.uri.fsPath === uri.fsPath)
  },
  window: {
    get activeTextEditor() {
      return fakeWorkspace.activeDocumentFsPath ? { document: { uri: { fsPath: fakeWorkspace.activeDocumentFsPath } } } : undefined;
    }
  }
}));

function makeFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      }
    }
  } as unknown as import("vscode").ExtensionContext;
}

beforeEach(() => {
  fakeWorkspace.folders = [];
  fakeWorkspace.activeDocumentFsPath = undefined;
});

describe("ExtensionState.resolveFolder (multi-root targeting)", () => {
  it("resolves the single open folder unambiguously", async () => {
    const { ExtensionState } = await import("./state.js");
    fakeWorkspace.folders = [{ uri: { fsPath: "/repo" }, name: "repo" }];
    const state = new ExtensionState(makeFakeContext());
    expect(state.resolveFolder()).toEqual(fakeWorkspace.folders[0]);
  });

  it("returns undefined when no workspace is open", async () => {
    const { ExtensionState } = await import("./state.js");
    const state = new ExtensionState(makeFakeContext());
    expect(state.resolveFolder()).toBeUndefined();
  });

  it('multi-root with nothing to disambiguate returns "ambiguous", never silently the first folder', async () => {
    const { ExtensionState } = await import("./state.js");
    fakeWorkspace.folders = [
      { uri: { fsPath: "/repo-a" }, name: "a" },
      { uri: { fsPath: "/repo-b" }, name: "b" }
    ];
    const state = new ExtensionState(makeFakeContext());
    expect(state.resolveFolder()).toBe("ambiguous");
  });

  it("multi-root resolves via the active editor's folder", async () => {
    const { ExtensionState } = await import("./state.js");
    fakeWorkspace.folders = [
      { uri: { fsPath: "/repo-a" }, name: "a" },
      { uri: { fsPath: "/repo-b" }, name: "b" }
    ];
    fakeWorkspace.activeDocumentFsPath = "/repo-b";
    const state = new ExtensionState(makeFakeContext());
    expect(state.resolveFolder()).toEqual(fakeWorkspace.folders[1]);
  });

  it("setSelectedFolder remembers an explicit choice and later resolves unambiguously with no active editor", async () => {
    const { ExtensionState } = await import("./state.js");
    fakeWorkspace.folders = [
      { uri: { fsPath: "/repo-a" }, name: "a" },
      { uri: { fsPath: "/repo-b" }, name: "b" }
    ];
    const state = new ExtensionState(makeFakeContext());
    expect(state.resolveFolder()).toBe("ambiguous");

    await state.setSelectedFolder("/repo-b");
    expect(state.resolveFolder()).toEqual(fakeWorkspace.folders[1]);
  });

  it("per-folder task focus (getCurrentTaskId/setCurrentTaskId) is keyed by the resolved folder, not global", async () => {
    const { ExtensionState } = await import("./state.js");
    fakeWorkspace.folders = [{ uri: { fsPath: "/repo" }, name: "repo" }];
    const state = new ExtensionState(makeFakeContext());
    expect(state.getCurrentTaskId()).toBeUndefined();
    await state.setCurrentTaskId("t-1");
    expect(state.getCurrentTaskId()).toBe("t-1");
  });

  it("getCurrentTaskId returns undefined while ambiguous, rather than guessing which folder's task to show", async () => {
    const { ExtensionState } = await import("./state.js");
    fakeWorkspace.folders = [
      { uri: { fsPath: "/repo-a" }, name: "a" },
      { uri: { fsPath: "/repo-b" }, name: "b" }
    ];
    const state = new ExtensionState(makeFakeContext());
    expect(state.getCurrentTaskId()).toBeUndefined();
  });
});
