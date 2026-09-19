import { describe, expect, it } from "vitest";
import type { AgentInvocationRequest } from "@ai-engine/core";
import {
  buildCodexArgs,
  CodexProvider,
  codexApprovalAndSandboxArgs,
  codexInvocationUsage,
  latestCodexUsage,
  usageFromCodexEvent
} from "./codex.js";

function baseRequest(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    taskId: "t-1",
    role: "implementer",
    systemPrompt: "system policy text",
    instructions: "do the thing",
    context: [],
    workingDirectory: "/tmp/some-worktree",
    sandbox: "read_only",
    approval: "never",
    ...overrides
  };
}

/**
 * Transcribed verbatim from real, live, authenticated `codex exec --json` invocations
 * (codex-cli 0.154.0) — this is the actual, confirmed shape usage arrives in on the stream this
 * adapter parses. IMPORTANT: this is a CUMULATIVE
 * per-thread snapshot, not a per-invocation delta (see usageFromTurnCompleted's doc comment for
 * the real chained fresh->resume experiment that proved this) — these exact numbers are Codex's
 * raw report, not "what this one invocation consumed."
 */
function realTurnCompletedUsage() {
  return {
    input_tokens: 33388,
    cached_input_tokens: 28544,
    cache_write_input_tokens: 0,
    output_tokens: 92,
    reasoning_output_tokens: 42
  };
}

describe("usageFromCodexEvent", () => {
  it("reads usage from the real, live turn.completed shape this adapter's stream actually emits", () => {
    const usage = usageFromCodexEvent({ type: "turn.completed", usage: realTurnCompletedUsage() });
    expect(usage).toEqual({
      inputTokens: 33388,
      cachedInputTokens: 28544,
      cacheWriteInputTokens: 0,
      outputTokens: 92,
      reasoningOutputTokens: 42
    });
  });

  it("returns undefined for an unrelated event — never fabricates usage for a shape it doesn't recognize", () => {
    expect(usageFromCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "hi" } })).toBeUndefined();
    expect(usageFromCodexEvent({ type: "thread.started", thread_id: "t-1" })).toBeUndefined();
  });

  it("REMOVED BY FINDING 3: token_count is no longer recognized at all — repeated rate-limit-only notifications could double-count if it were", () => {
    expect(usageFromCodexEvent({ type: "token_count", info: { last_token_usage: { input_tokens: 100 } } })).toBeUndefined();
    expect(
      usageFromCodexEvent({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100 } } } })
    ).toBeUndefined();
  });

  it("degrades safely (undefined, never throws) when turn.completed's usage is missing or malformed", () => {
    expect(usageFromCodexEvent({ type: "turn.completed" })).toBeUndefined();
    expect(usageFromCodexEvent({ type: "turn.completed", usage: null })).toBeUndefined();
    expect(usageFromCodexEvent({ type: "turn.completed", usage: "not-an-object" })).toBeUndefined();
  });

  describe("malformed individual numeric fields (provider JSON is an untrusted external boundary)", () => {
    it("omits a numeric-string dimension rather than string-concatenating it — other valid dimensions in the same event are unaffected", () => {
      const usage = usageFromCodexEvent({ type: "turn.completed", usage: { input_tokens: "10", output_tokens: 5 } });
      expect(usage?.inputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(5);
    });

    it("omits a negative dimension rather than letting it corrupt accounting", () => {
      const usage = usageFromCodexEvent({ type: "turn.completed", usage: { cached_input_tokens: -5, output_tokens: 5 } });
      expect(usage?.cachedInputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(5);
    });

    it("omits a null dimension rather than letting it coerce to a fabricated 0 (0 + null === 0 in JS)", () => {
      const usage = usageFromCodexEvent({ type: "turn.completed", usage: { output_tokens: null, input_tokens: 7 } });
      expect(usage?.outputTokens).toBeUndefined();
      expect(usage?.inputTokens).toBe(7);
    });

    it("omits a NaN dimension", () => {
      const usage = usageFromCodexEvent({ type: "turn.completed", usage: { reasoning_output_tokens: NaN, input_tokens: 7 } });
      expect(usage?.reasoningOutputTokens).toBeUndefined();
      expect(usage?.inputTokens).toBe(7);
    });

    it("omits an Infinity (or -Infinity) dimension", () => {
      const usage = usageFromCodexEvent({
        type: "turn.completed",
        usage: { input_tokens: Infinity, cache_write_input_tokens: -Infinity, output_tokens: 7 }
      });
      expect(usage?.inputTokens).toBeUndefined();
      expect(usage?.cacheWriteInputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(7);
    });

    it("preserves a genuinely valid 0 — a real reported zero is never confused with a missing/invalid field", () => {
      const usage = usageFromCodexEvent({ type: "turn.completed", usage: { cache_write_input_tokens: 0 } });
      expect(usage).toEqual({ cacheWriteInputTokens: 0 });
    });

    it("preserves a valid positive integer", () => {
      const usage = usageFromCodexEvent({ type: "turn.completed", usage: { output_tokens: 42 } });
      expect(usage).toEqual({ outputTokens: 42 });
    });

    it("omits a fractional (non-integer) dimension — no real Codex evidence supports fractional token counts", () => {
      const usage = usageFromCodexEvent({ type: "turn.completed", usage: { input_tokens: 10.5, output_tokens: 7 } });
      expect(usage?.inputTokens).toBeUndefined();
      expect(usage?.outputTokens).toBe(7);
    });

    it("through the complete stream-aggregation path: when every dimension in the only observed event is malformed, usage becomes undefined — never a fabricated-zero AgentResult.usage", () => {
      const usage = latestCodexUsage([
        {
          type: "turn.completed",
          usage: { input_tokens: "10", cached_input_tokens: -5, output_tokens: null, reasoning_output_tokens: NaN }
        }
      ]);
      expect(usage).toBeUndefined();
    });
  });
});

describe("latestCodexUsage — turn.completed is a CUMULATIVE snapshot, never summed across records", () => {
  it("a single turn.completed record: returned as-is", () => {
    const usage = latestCodexUsage([{ type: "turn.completed", usage: realTurnCompletedUsage() }]);
    expect(usage).toEqual({
      inputTokens: 33388,
      cachedInputTokens: 28544,
      cacheWriteInputTokens: 0,
      outputTokens: 92,
      reasoningOutputTokens: 42
    });
  });

  it("FINDING 3 REGRESSION: multiple turn.completed records are NEVER summed — the LAST one is authoritative, since each is a cumulative total, not an independent delta", () => {
    const usage = latestCodexUsage([
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } },
      { type: "turn.completed", usage: { input_tokens: 150, output_tokens: 15 } }
    ]);
    // Must be exactly the last snapshot (150), never the sum (100 + 150 = 250).
    expect(usage).toEqual({ inputTokens: 150, outputTokens: 15 });
  });

  it("token_count records are never recognized at all (Finding 3: removed entirely) — ignored, not summed, not used as a fallback", () => {
    const usage = latestCodexUsage([
      { type: "token_count", info: { last_token_usage: { input_tokens: 999 } } },
      { type: "turn.completed", usage: { input_tokens: 50 } }
    ]);
    expect(usage).toEqual({ inputTokens: 50 });
  });

  it("repeated compatibility-shaped notifications never produce any usage now that token_count is unsupported", () => {
    const usage = latestCodexUsage([
      { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } },
      { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } },
      { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } }
    ]);
    expect(usage).toBeUndefined();
  });

  it("returns undefined for an empty or entirely unrelated stream — never fabricates usage", () => {
    expect(latestCodexUsage([])).toBeUndefined();
    expect(latestCodexUsage([{ type: "thread.started", thread_id: "t-1" }, { type: "turn.started" }])).toBeUndefined();
  });
});

describe("codexInvocationUsage — converting Codex's raw cumulative-per-thread usage into this invocation's own delta (Finding 2)", () => {
  it("fresh: cumulative 100 -> observed invocation usage 100 (the cumulative total IS the delta when nothing precedes it)", () => {
    const usage = codexInvocationUsage({ inputTokens: 100 }, false, undefined);
    expect(usage).toEqual({ inputTokens: 100 });
  });

  it("fresh: previousCumulativeUsage is ignored entirely, even if (incorrectly) provided — there is nothing to subtract on a fresh invocation", () => {
    const usage = codexInvocationUsage({ inputTokens: 100 }, false, { inputTokens: 40 });
    expect(usage).toEqual({ inputTokens: 100 });
  });

  it("resume same provider session: previous cumulative 100, current cumulative 150 -> observed invocation usage 50", () => {
    const usage = codexInvocationUsage({ inputTokens: 150 }, true, { inputTokens: 100 });
    expect(usage).toEqual({ inputTokens: 50 });
  });

  it("another resume of the same session: previous cumulative 150, current cumulative 180 -> observed invocation usage 30", () => {
    const usage = codexInvocationUsage({ inputTokens: 180 }, true, { inputTokens: 150 });
    expect(usage).toEqual({ inputTokens: 30 });
  });

  it("missing baseline on resume: usage is unknown/undefined, NOT the raw cumulative 150 — never fabricates a delta from nothing", () => {
    const usage = codexInvocationUsage({ inputTokens: 150 }, true, undefined);
    expect(usage).toBeUndefined();
  });

  it("resuming but Codex reported no usage at all this call: undefined, not the stale previous baseline", () => {
    const usage = codexInvocationUsage(undefined, true, { inputTokens: 100 });
    expect(usage).toBeUndefined();
  });

  it("never derives a negative delta — a baseline larger than the current cumulative total is treated as unreliable for that dimension", () => {
    const usage = codexInvocationUsage({ inputTokens: 80 }, true, { inputTokens: 100 });
    expect(usage?.inputTokens).toBeUndefined();
  });

  it("handles cached/reasoning/cache-write dimensions consistently with input/output under subtraction", () => {
    const usage = codexInvocationUsage(
      { inputTokens: 150, cachedInputTokens: 90, cacheWriteInputTokens: 10, outputTokens: 40, reasoningOutputTokens: 8 },
      true,
      { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 10, outputTokens: 25, reasoningOutputTokens: 3 }
    );
    expect(usage).toEqual({ inputTokens: 50, cachedInputTokens: 30, cacheWriteInputTokens: 0, outputTokens: 15, reasoningOutputTokens: 5 });
  });
});

describe("codexApprovalAndSandboxArgs", () => {
  it('"never" is always safe and sends an explicit -s for every sandbox level, never --approve-for-me', () => {
    expect(codexApprovalAndSandboxArgs("read_only", "never")).toEqual({ args: ["-s", "read-only"] });
    expect(codexApprovalAndSandboxArgs("workspace_write", "never")).toEqual({ args: ["-s", "workspace-write"] });
    expect(codexApprovalAndSandboxArgs("full_access", "never")).toEqual({ args: ["-s", "danger-full-access"] });
  });

  it('a non-"never" policy with workspace_write sends --approve-for-me alone — it already implies workspace-write, so no explicit -s is added (the real CLI rejects combining the two)', () => {
    expect(codexApprovalAndSandboxArgs("workspace_write", "on_request")).toEqual({ args: ["--approve-for-me"] });
    expect(codexApprovalAndSandboxArgs("workspace_write", "untrusted_only")).toEqual({ args: ["--approve-for-me"] });
  });

  it('a non-"never" policy with read_only or full_access has no safe representation on the real Codex CLI and fails explicitly instead of silently weakening the sandbox or dropping the approval policy', () => {
    for (const policy of ["on_request", "untrusted_only"] as const) {
      for (const sandbox of ["read_only", "full_access"] as const) {
        const result = codexApprovalAndSandboxArgs(sandbox, policy);
        expect(result).toHaveProperty("error");
        if ("error" in result) {
          expect(result.error).toContain(policy);
          expect(result.error).toContain(sandbox);
        }
      }
    }
  });
});

describe("buildCodexArgs — the real argv sent to `codex exec`/`codex exec resume`, for fresh AND resumed requests", () => {
  const files = { outputLastMessageFile: "/tmp/last-message.txt" };
  const SESSION = "session-123";

  describe("fresh invocations — policy args positioned right after the leading '-' prompt marker", () => {
    it("never + read_only", () => {
      const result = buildCodexArgs(
        { resumeSessionId: undefined, sandbox: "read_only", approval: "never", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({ args: ["exec", "-", "-s", "read-only", "-C", "/tmp/worktree", "--json", "-o", "/tmp/last-message.txt"] });
    });

    it("never + workspace_write", () => {
      const result = buildCodexArgs(
        { resumeSessionId: undefined, sandbox: "workspace_write", approval: "never", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({
        args: ["exec", "-", "-s", "workspace-write", "-C", "/tmp/worktree", "--json", "-o", "/tmp/last-message.txt"]
      });
    });

    it("never + full_access", () => {
      const result = buildCodexArgs(
        { resumeSessionId: undefined, sandbox: "full_access", approval: "never", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({
        args: ["exec", "-", "-s", "danger-full-access", "-C", "/tmp/worktree", "--json", "-o", "/tmp/last-message.txt"]
      });
    });

    it("supported non-never combination: workspace_write + on_request sends --approve-for-me alone, no -s", () => {
      const result = buildCodexArgs(
        { resumeSessionId: undefined, sandbox: "workspace_write", approval: "on_request", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({ args: ["exec", "-", "--approve-for-me", "-C", "/tmp/worktree", "--json", "-o", "/tmp/last-message.txt"] });
    });

    it("unsupported combination: read_only + on_request fails, no argv produced, matching codexApprovalAndSandboxArgs directly", () => {
      const result = buildCodexArgs(
        { resumeSessionId: undefined, sandbox: "read_only", approval: "on_request", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual(codexApprovalAndSandboxArgs("read_only", "on_request"));
      expect(result).toHaveProperty("error");
    });
  });

  describe("resumed invocations — the SAME policy args, positioned at the parent `exec` level BEFORE the `resume` subcommand (confirmed live against the installed CLI's argument parser: `codex exec -s <mode> resume <id> -` parses cleanly, failing only later on a semantic 'no rollout found' for a bogus id)", () => {
    it("never + read_only: -s IS present in the real argv, positioned before 'resume'", () => {
      const result = buildCodexArgs(
        { resumeSessionId: SESSION, sandbox: "read_only", approval: "never", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({
        args: ["exec", "-s", "read-only", "resume", SESSION, "-", "--json", "-o", "/tmp/last-message.txt"]
      });
    });

    it("never + workspace_write: -s IS present, positioned before 'resume'", () => {
      const result = buildCodexArgs(
        { resumeSessionId: SESSION, sandbox: "workspace_write", approval: "never", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({
        args: ["exec", "-s", "workspace-write", "resume", SESSION, "-", "--json", "-o", "/tmp/last-message.txt"]
      });
    });

    it("never + full_access: -s IS present, positioned before 'resume'", () => {
      const result = buildCodexArgs(
        { resumeSessionId: SESSION, sandbox: "full_access", approval: "never", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({
        args: ["exec", "-s", "danger-full-access", "resume", SESSION, "-", "--json", "-o", "/tmp/last-message.txt"]
      });
    });

    it("supported non-never combination: workspace_write + on_request sends --approve-for-me BEFORE 'resume', not omitted", () => {
      const result = buildCodexArgs(
        { resumeSessionId: SESSION, sandbox: "workspace_write", approval: "on_request", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toEqual({ args: ["exec", "--approve-for-me", "resume", SESSION, "-", "--json", "-o", "/tmp/last-message.txt"] });
    });

    it("THE BUG THIS FIXES: unsupported combination read_only + on_request fails identically on resume as on fresh — never silently falls back to Codex's current/default sandbox", () => {
      const resumed = buildCodexArgs(
        { resumeSessionId: SESSION, sandbox: "read_only", approval: "on_request", workingDirectory: "/tmp/worktree" },
        files
      );
      const fresh = buildCodexArgs(
        { resumeSessionId: undefined, sandbox: "read_only", approval: "on_request", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(resumed).toHaveProperty("error");
      expect(resumed).not.toHaveProperty("args");
      // Byte-identical normalized error on both paths — the "same normalized unsupported-policy error" requirement.
      expect(resumed).toEqual(fresh);
    });

    it("unsupported full_access + untrusted_only also fails on resume — the same rule applies to every unsupported sandbox, not just read_only", () => {
      const result = buildCodexArgs(
        { resumeSessionId: SESSION, sandbox: "full_access", approval: "untrusted_only", workingDirectory: "/tmp/worktree" },
        files
      );
      expect(result).toHaveProperty("error");
    });

    it("-C and --add-dir remain fresh-only (out of scope for this policy-enforcement fix) — unchanged, working directory for resume still goes through execa's own cwd option", () => {
      const resumed = buildCodexArgs(
        {
          resumeSessionId: SESSION,
          sandbox: "read_only",
          approval: "never",
          workingDirectory: "/tmp/worktree",
          additionalWritableDirs: ["/tmp/extra"]
        },
        files
      );
      expect(resumed).toEqual({ args: ["exec", "-s", "read-only", "resume", SESSION, "-", "--json", "-o", "/tmp/last-message.txt"] });
      if ("args" in resumed) {
        expect(resumed.args).not.toContain("-C");
        expect(resumed.args).not.toContain("--add-dir");
      }
    });
  });
});

describe("CodexProvider.invoke() end-to-end for an unrepresentable approval/sandbox combination", () => {
  it("fails fast with a normalized error — never resolves a binary, never spawns codex, never hangs the event stream — for a conflicting FRESH combination", async () => {
    // No configuredBinaryPath, and this must never fall through to a real PATH lookup: the
    // approval/sandbox check runs and fails before resolveBinary() is ever called, so this test
    // is hermetic regardless of whether a real `codex` binary happens to be installed.
    const provider = new CodexProvider({});
    const run = provider.invoke(baseRequest({ sandbox: "read_only", approval: "on_request" }));

    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["lifecycle", "lifecycle"]);

    const result = await run.result;
    expect(result.status).toBe("failure");
    expect(result.error?.code).toBe("CODEX_UNSUPPORTED_APPROVAL_SANDBOX");
    expect(result.error?.message).toContain("on_request");
    expect(result.error?.message).toContain("read_only");
  });

  it("FINDING 1 REGRESSION: fails fast identically for a conflicting RESUMED combination — resume must never bypass the same policy validation a fresh invocation gets", async () => {
    const provider = new CodexProvider({});
    const run = provider.invoke(baseRequest({ sandbox: "read_only", approval: "on_request", resumeSessionId: "session-123" }));

    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["lifecycle", "lifecycle"]);

    const result = await run.result;
    expect(result.status).toBe("failure");
    expect(result.error?.code).toBe("CODEX_UNSUPPORTED_APPROVAL_SANDBOX");
    expect(result.error?.message).toContain("on_request");
    expect(result.error?.message).toContain("read_only");
  });
});
