import { describe, expect, it } from "vitest";
import type { AgentInvocationRequest } from "@ai-engine/core";
import { buildInvocationArgs } from "./claude.js";

function baseRequest(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    taskId: "t-1",
    role: "implementer",
    systemPrompt: "system policy text",
    instructions: "do the thing",
    context: [],
    workingDirectory: "/tmp/some-worktree",
    sandbox: "workspace_write",
    approval: "on_request",
    ...overrides
  };
}

describe("ClaudeProvider invocation args (regression: headless Bash actually needs to work)", () => {
  /**
   * Regression test for a real end-to-end finding: a fixer invocation with `--permission-mode
   * acceptEdits --permission-prompts none` (the configuration this file used before) let Read/Edit
   * through but auto-denied a Bash call ("no approval surface in this session") — verified against
   * the real CLI (claude-code 2.1.268) that this was specifically about `acceptEdits` not covering
   * a Bash-classified-as-risky action (running an npm script), not a fluke. See the extensive doc
   * comment on permissionModeForSandbox in claude.ts for the full real-CLI investigation across all
   * six documented permission modes.
   */
  it('uses "auto" (not "acceptEdits" and not "bypassPermissions") for a workspace_write role', () => {
    const args = buildInvocationArgs(baseRequest({ sandbox: "workspace_write" }), {}, "session-1");
    const modeIndex = args.indexOf("--permission-mode");
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(args[modeIndex + 1]).toBe("auto");
  });

  it('also uses "auto" for a read_only role (inert there — toolsForSandbox is the real boundary)', () => {
    const args = buildInvocationArgs(baseRequest({ sandbox: "read_only" }), {}, "session-1");
    const modeIndex = args.indexOf("--permission-mode");
    expect(args[modeIndex + 1]).toBe("auto");
  });

  it("always runs fully headless: nobody is ever left to answer a permission prompt", () => {
    const args = buildInvocationArgs(baseRequest(), {}, "session-1");
    const promptsIndex = args.indexOf("--permission-prompts");
    expect(promptsIndex).toBeGreaterThanOrEqual(0);
    expect(args[promptsIndex + 1]).toBe("none");
  });

  it("restricts a read_only role to Read/Grep/Glob — the real, mechanical boundary, independent of permission mode", () => {
    const args = buildInvocationArgs(baseRequest({ sandbox: "read_only" }), {}, "session-1");
    const toolsIndex = args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(args[toolsIndex + 1]).toBe("Read,Grep,Glob");
  });

  it("does not restrict tools for a workspace_write role (Bash/Edit/Write all need to be available)", () => {
    const args = buildInvocationArgs(baseRequest({ sandbox: "workspace_write" }), {}, "session-1");
    expect(args).not.toContain("--tools");
  });

  it("passes the system prompt via --append-system-prompt, not concatenated into instructions", () => {
    const args = buildInvocationArgs(baseRequest({ systemPrompt: "SYSTEM-MARKER" }), {}, "session-1");
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("SYSTEM-MARKER");
  });

  it("resumes a prior session by id instead of minting a new --session-id when resumeSessionId is set", () => {
    const args = buildInvocationArgs(baseRequest({ resumeSessionId: "prior-session" }), {}, "session-1");
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("prior-session");
    expect(args).not.toContain("--session-id");
  });
});
