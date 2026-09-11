import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityConfigSchema } from "@ai-engine/config";
import { SecurityPolicy } from "./policy.js";
import { sandboxDefaultsForRole } from "./role-defaults.js";

const config = SecurityConfigSchema.parse({});
const policy = new SecurityPolicy(config);

describe("SecurityPolicy.checkCommand", () => {
  it("denies configured destructive patterns", () => {
    expect(policy.checkCommand("git push --force origin main").denied).toBe(true);
    expect(policy.checkCommand("git reset --hard HEAD~1").denied).toBe(true);
    expect(policy.checkCommand("rm -rf /").denied).toBe(true);
  });

  it("allows ordinary commands", () => {
    expect(policy.checkCommand("npm test").denied).toBe(false);
    expect(policy.checkCommand("git status").denied).toBe(false);
  });
});

describe("SecurityPolicy.evaluateEvent", () => {
  it("terminates on a denied command event", () => {
    const verdict = policy.evaluateEvent({ type: "command", command: "git push --force origin main", cwd: "/tmp" });
    expect(verdict.action).toBe("terminate");
  });

  it("terminates on a denied shell tool_use event", () => {
    const verdict = policy.evaluateEvent({ type: "tool_use", tool: "Bash", input: { command: "rm -rf /" } });
    expect(verdict.action).toBe("terminate");
  });

  it("allows a benign tool_use event", () => {
    const verdict = policy.evaluateEvent({ type: "tool_use", tool: "Read", input: { file_path: "src/index.ts" } });
    expect(verdict.action).toBe("allow");
  });

  it("allows non-command events", () => {
    const verdict = policy.evaluateEvent({ type: "message", channel: "assistant", text: "hello" });
    expect(verdict.action).toBe("allow");
  });
});

describe("SecurityPolicy.checkPath", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-engine-sec-root-"));
    outside = await mkdtemp(join(tmpdir(), "ai-engine-sec-outside-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("allows a path inside the allowed root", async () => {
    const file = join(root, "a.txt");
    await writeFile(file, "x");
    const result = await policy.checkPath(file, [root]);
    expect(result.allowed).toBe(true);
  });

  it("rejects a path outside every allowed root", async () => {
    const file = join(outside, "a.txt");
    await writeFile(file, "x");
    const result = await policy.checkPath(file, [root]);
    expect(result.allowed).toBe(false);
  });

  it("rejects a symlink that escapes the allowed root", async () => {
    const target = join(outside, "secret.txt");
    await writeFile(target, "secret");
    const link = join(root, "escape.txt");
    await symlink(target, link);
    const result = await policy.checkPath(link, [root]);
    expect(result.allowed).toBe(false);
  });
});

describe("sandboxDefaultsForRole", () => {
  it("gives read-only roles no write access", () => {
    expect(sandboxDefaultsForRole("architect").sandbox).toBe("read_only");
    expect(sandboxDefaultsForRole("reviewer").sandbox).toBe("read_only");
    expect(sandboxDefaultsForRole("security_reviewer").sandbox).toBe("read_only");
  });

  it("gives the implementer workspace write access", () => {
    expect(sandboxDefaultsForRole("implementer").sandbox).toBe("workspace_write");
  });

  it("falls back to a conservative default for unknown roles", () => {
    expect(sandboxDefaultsForRole("some_future_role")).toEqual({ sandbox: "read_only", approval: "on_request" });
  });
});
