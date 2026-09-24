import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerCommands } from "./commands.js";

/**
 * A minimal fake of only the vscode surface `aiEngine.approveVerificationCommand` actually
 * touches — same rationale/tradeoff as state.test.ts's own fake (no @vscode/test-electron here;
 * see docs/vscode.md). Narrowly scoped to this one command handler, not a general test harness
 * for every command in commands.ts.
 */
const registered = new Map<string, () => Promise<void>>();

vi.mock("vscode", () => ({
  commands: {
    registerCommand: (id: string, fn: () => Promise<void>) => {
      registered.set(id, fn);
      return { dispose: () => undefined };
    }
  },
  window: {
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn()
  }
}));

beforeEach(() => {
  registered.clear();
  vi.mocked(vscode.window.showQuickPick).mockReset();
  vi.mocked(vscode.window.showWarningMessage).mockReset();
  vi.mocked(vscode.window.showInformationMessage).mockReset();
  vi.mocked(vscode.window.showErrorMessage).mockReset();
});

function buildHarness(checks: unknown[]) {
  const orchestrator = {
    listVerificationChecks: vi.fn().mockResolvedValue(checks),
    approveVerificationCommand: vi.fn().mockResolvedValue({ task: {}, command: "x", cwd: undefined })
  };
  const state = {
    currentOrchestrator: vi.fn().mockResolvedValue(orchestrator),
    getCurrentTaskId: () => "t-1",
    refresh: vi.fn(),
    listWorkspaceFolders: () => [],
    setSelectedFolder: vi.fn(),
    setCurrentTaskId: vi.fn()
  };
  const output = { appendLine: vi.fn(), show: vi.fn() };
  registerCommands(
    { subscriptions: [] } as unknown as vscode.ExtensionContext,
    state as unknown as Parameters<typeof registerCommands>[1],
    output as unknown as vscode.OutputChannel
  );
  return { orchestrator };
}

describe("aiEngine.approveVerificationCommand", () => {
  it("shows cwd in the QuickPick detail and the confirmation dialog when the check has one", async () => {
    const { orchestrator } = buildHarness([
      {
        id: "custom.marker",
        command: "npm test",
        description: "runs tests",
        cwd: "/repo/packages/foo",
        origin: "repository_configured",
        approved: false,
        requiredForReady: true
      }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "custom.marker",
      description: "npm test",
      cwd: "/repo/packages/foo"
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve" as unknown as vscode.MessageItem);

    await registered.get("aiEngine.approveVerificationCommand")!();

    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0]![0] as unknown as Array<{ detail?: string }>;
    expect(items[0]!.detail).toContain("cwd: /repo/packages/foo");

    const warningText = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]![0] as string;
    expect(warningText).toContain("cwd: /repo/packages/foo");
    expect(orchestrator.approveVerificationCommand).toHaveBeenCalledWith("t-1", "custom.marker", expect.any(String));
  });

  it("omits cwd from both the detail and the confirmation dialog when the check has none", async () => {
    buildHarness([
      {
        id: "npm.root",
        command: "npm test",
        description: "npm test",
        origin: "repository_configured",
        approved: false,
        requiredForReady: true
      }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "npm.root",
      description: "npm test",
      cwd: undefined
    } as unknown as vscode.QuickPickItem);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve" as unknown as vscode.MessageItem);

    await registered.get("aiEngine.approveVerificationCommand")!();

    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0]![0] as unknown as Array<{ detail?: string }>;
    expect(items[0]!.detail).not.toContain("cwd:");
    const warningText = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]![0] as string;
    expect(warningText).not.toContain("cwd:");
  });
});
