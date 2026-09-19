import { describe, expect, it } from "vitest";
import type { AgentInvocationRequest } from "@ai-engine/core";
import { buildInvocationArgs, usageFromClaudeResult } from "./claude.js";

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

describe("usageFromClaudeResult", () => {
  it("maps input/output/cost, and cache tokens onto the normalized dimensions", () => {
    const usage = usageFromClaudeResult({
      type: "result",
      total_cost_usd: 0.0234,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 }
    });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 40, costUsd: 0.0234, cachedInputTokens: 8000, cacheWriteInputTokens: 500 });
  });

  it("leaves cache/reasoning dimensions undefined when the result message doesn't report them — never a fabricated 0", () => {
    const usage = usageFromClaudeResult({ type: "result", usage: { input_tokens: 10, output_tokens: 3 } });
    expect(usage?.cachedInputTokens).toBeUndefined();
    expect(usage?.cacheWriteInputTokens).toBeUndefined();
    expect(usage?.reasoningOutputTokens).toBeUndefined();
    expect(usage && "reasoningOutputTokens" in usage).toBe(false);
  });

  it("Claude never reports reasoning tokens separately — always undefined, documenting an unavailable metric rather than guessing", () => {
    const usage = usageFromClaudeResult({
      type: "result",
      usage: { input_tokens: 10, output_tokens: 3 },
      total_cost_usd: 0.01
    });
    expect(usage?.reasoningOutputTokens).toBeUndefined();
  });

  describe("malformed individual fields (provider JSON is an untrusted external boundary — this exercises the actual adapter result path, `usageFromClaudeResult`, not a lower-level parser)", () => {
    it("omits a numeric-string token dimension rather than string-concatenating it — other valid dimensions unaffected", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { input_tokens: "10" as any, output_tokens: 5 } });
      expect(usage?.inputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(5);
    });

    it("omits a null token dimension rather than letting it coerce to a fabricated 0", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { input_tokens: 7, output_tokens: null as any } });
      expect(usage?.inputTokens).toBe(7);
      expect(usage?.outputTokens).toBeUndefined();
    });

    it("omits a negative token dimension", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { cache_read_input_tokens: -5 as any, output_tokens: 5 } });
      expect(usage?.cachedInputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(5);
    });

    it("omits a NaN token dimension", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { input_tokens: NaN, output_tokens: 5 } });
      expect(usage?.inputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(5);
    });

    it("omits an Infinity token dimension", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { input_tokens: Infinity, output_tokens: 5 } });
      expect(usage?.inputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(5);
    });

    it("preserves a genuinely valid 0 token count", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { output_tokens: 0 } });
      expect(usage).toEqual({ outputTokens: 0 });
    });

    it("preserves a valid positive integer token count", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { output_tokens: 42 } });
      expect(usage).toEqual({ outputTokens: 42 });
    });

    it("omits a fractional (non-integer) token dimension — no evidence Claude ever reports fractional tokens", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { input_tokens: 10.5, output_tokens: 5 } });
      expect(usage?.inputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(5);
    });

    it("cost is allowed to be a valid, genuinely fractional non-negative number — never required to be an integer", () => {
      const usage = usageFromClaudeResult({ type: "result", total_cost_usd: 0.0234 });
      expect(usage).toEqual({ costUsd: 0.0234 });
    });

    it("omits a malformed cost (numeric string, negative, NaN, Infinity) exactly like a token dimension, but never requires it to be an integer", () => {
      expect(usageFromClaudeResult({ type: "result", total_cost_usd: "0.01" as any })?.costUsd).toBeUndefined();
      expect(usageFromClaudeResult({ type: "result", total_cost_usd: -0.01 })?.costUsd).toBeUndefined();
      expect(usageFromClaudeResult({ type: "result", total_cost_usd: NaN })?.costUsd).toBeUndefined();
      expect(usageFromClaudeResult({ type: "result", total_cost_usd: Infinity })?.costUsd).toBeUndefined();
    });

    it("when every dimension is invalid/missing, returns undefined — never a fabricated empty/zero usage object", () => {
      const usage = usageFromClaudeResult({ type: "result", usage: { input_tokens: "bad" as any, output_tokens: null as any } });
      expect(usage).toBeUndefined();
    });
  });
});
