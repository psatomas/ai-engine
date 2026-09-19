import { describe, expect, it } from "vitest";
import type { AgentInvocationRequest } from "@ai-engine/core";
import { buildCodexArgs, CodexProvider, codexApprovalAndSandboxArgs } from "./codex.js";

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
