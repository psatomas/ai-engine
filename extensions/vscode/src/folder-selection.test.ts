import { describe, expect, it } from "vitest";
import { pickFolder } from "./folder-selection.js";

/**
 * Regression for the audit finding "multi-root workspace repository
 * selection is ambiguous and silent": the previous ExtensionState fell back
 * to workspaceFolders[0] whenever there was no active text editor, which in
 * a multi-root workspace could silently run a command against the wrong
 * repository. pickFolder() must never guess in that situation.
 */
describe("pickFolder", () => {
  it("returns undefined when no workspace is open", () => {
    expect(pickFolder({ workspaceFolders: [] })).toBeUndefined();
  });

  it("is unambiguous with a single folder, regardless of any other signal", () => {
    const only = { fsPath: "/repo" };
    expect(pickFolder({ workspaceFolders: [only] })).toBe(only);
    expect(pickFolder({ workspaceFolders: [only], activeEditorFolder: { fsPath: "/somewhere-else" } })).toBe(only);
  });

  it("multi-root with no disambiguating signal is reported as ambiguous, not silently defaulted to the first folder", () => {
    const a = { fsPath: "/repo-a" };
    const b = { fsPath: "/repo-b" };
    expect(pickFolder({ workspaceFolders: [a, b] })).toBe("ambiguous");
  });

  it("multi-root prefers the active editor's folder when available", () => {
    const a = { fsPath: "/repo-a" };
    const b = { fsPath: "/repo-b" };
    expect(pickFolder({ workspaceFolders: [a, b], activeEditorFolder: b })).toBe(b);
  });

  it("multi-root falls back to a remembered explicit choice when there is no active editor", () => {
    const a = { fsPath: "/repo-a" };
    const b = { fsPath: "/repo-b" };
    expect(pickFolder({ workspaceFolders: [a, b], rememberedFsPath: "/repo-b" })).toBe(b);
  });

  it("an active editor's folder wins over a stale remembered choice", () => {
    const a = { fsPath: "/repo-a" };
    const b = { fsPath: "/repo-b" };
    expect(pickFolder({ workspaceFolders: [a, b], activeEditorFolder: a, rememberedFsPath: "/repo-b" })).toBe(a);
  });

  it("a remembered choice that no longer matches any open folder is ignored, not silently mismatched", () => {
    const a = { fsPath: "/repo-a" };
    const b = { fsPath: "/repo-b" };
    expect(pickFolder({ workspaceFolders: [a, b], rememberedFsPath: "/repo-that-was-closed" })).toBe("ambiguous");
  });

  it("an active editor folder that isn't actually one of the open workspace folders is still trusted as-is (caller's responsibility to pass a real one)", () => {
    const a = { fsPath: "/repo-a" };
    const b = { fsPath: "/repo-b" };
    const outsider = { fsPath: "/not-a-workspace-folder" };
    expect(pickFolder({ workspaceFolders: [a, b], activeEditorFolder: outsider })).toBe(outsider);
  });
});
