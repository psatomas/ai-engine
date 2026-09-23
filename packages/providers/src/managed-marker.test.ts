import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInvocationRequest } from "@ai-engine/core";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";

type Call = { file: string; args: string[]; options: Record<string, unknown> };
const recorded = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }> }));

// No real provider process can ever start in this file: execa itself is replaced.
vi.mock("execa", () => ({
  execa: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
    recorded.calls.push({ file, args, options });
    const done = Promise.resolve({ exitCode: 0, stdout: "9.9.9-fake", stderr: "" }) as Promise<unknown> & { stdout: Readable };
    done.stdout = Readable.from([]);
    return done;
  })
}));

let dir: string;
let fakeBinary: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-engine-marker-test-"));
  fakeBinary = join(dir, "fake-provider");
  await writeFile(fakeBinary, "#!/bin/sh\nexit 0\n");
  await chmod(fakeBinary, 0o755);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  recorded.calls.length = 0;
  vi.unstubAllEnvs();
});

const request = (overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest => ({
  taskId: "t-20260101000000-abcd",
  role: "implementer",
  systemPrompt: "system policy",
  instructions: "do the thing",
  context: [],
  workingDirectory: "/tmp/some-worktree",
  sandbox: "workspace_write",
  approval: "never",
  timeoutMs: 1234,
  ...overrides
});

const providers = [
  ["Claude", () => new ClaudeProvider({ configuredBinaryPath: fakeBinary })],
  ["Codex", () => new CodexProvider({ configuredBinaryPath: fakeBinary })]
] as const;

async function invoke(make: (typeof providers)[number][1], req: AgentInvocationRequest): Promise<Call> {
  const run = make().invoke(req);
  await run.result;
  expect(recorded.calls).toHaveLength(1);
  return recorded.calls[0]!;
}

async function invokeResult(make: (typeof providers)[number][1], req: AgentInvocationRequest) {
  const run = make().invoke(req);
  const result = await run.result;
  expect(recorded.calls).toHaveLength(1);
  return { call: recorded.calls[0]!, result };
}

describe.each(providers)("%s managed invocation", (_name, make) => {
  it("launches the provider with the actual task id in AI_ENGINE_MANAGED_TASK", async () => {
    const call = await invoke(make, request({ taskId: "t-20260305123456-beef" }));
    expect((call.options.env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK).toBe("t-20260305123456-beef");
  });

  it("uses each invocation's own task id", async () => {
    const a = await invoke(make, request({ taskId: "t-20260101000000-aaaa" }));
    recorded.calls.length = 0;
    const b = await invoke(make, request({ taskId: "t-20260101000000-bbbb" }));
    expect((a.options.env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK).toBe("t-20260101000000-aaaa");
    expect((b.options.env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK).toBe("t-20260101000000-bbbb");
  });

  it("preserves the rest of the environment exactly, adding only the marker", async () => {
    vi.stubEnv("ZZ_UNRELATED_VARIABLE", "keep-me");
    vi.stubEnv("ZZ_EMPTY_VARIABLE", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-key-for-test");
    const call = await invoke(make, request());
    expect(call.options.env).toEqual({ ...process.env, AI_ENGINE_MANAGED_TASK: "t-20260101000000-abcd" });
    const env = call.options.env as NodeJS.ProcessEnv;
    expect(env.ZZ_UNRELATED_VARIABLE).toBe("keep-me");
    expect(env.ZZ_EMPTY_VARIABLE).toBe("");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("replaces an inherited marker with this task's own", async () => {
    vi.stubEnv("AI_ENGINE_MANAGED_TASK", "t-20200101000000-outer");
    const call = await invoke(make, request({ taskId: "t-20260101000000-inner" }));
    expect((call.options.env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK).toBe("t-20260101000000-inner");
  });

  it("still marks an invocation that has no usable task id, with a non-empty value", async () => {
    const call = await invoke(make, request({ taskId: "" }));
    expect((call.options.env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK).toBeTruthy();
  });

  it("does not modify the parent process's own environment", async () => {
    vi.stubEnv("AI_ENGINE_MANAGED_TASK", undefined as unknown as string);
    delete process.env.AI_ENGINE_MANAGED_TASK;
    await invoke(make, request());
    expect("AI_ENGINE_MANAGED_TASK" in process.env).toBe(false);
  });

  it("changes nothing else about the launch: same option set, working directory, timeout, and prompt", async () => {
    const call = await invoke(make, request());
    expect(Object.keys(call.options).sort()).toEqual(["cancelSignal", "cwd", "env", "input", "reject", "timeout"]);
    expect(call.options.cwd).toBe("/tmp/some-worktree");
    expect(call.options.timeout).toBe(1234);
    expect(call.options.reject).toBe(false);
    expect(call.options.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(call.file).toBe(fakeBinary);
  });

  it("keeps the marker out of the command line and the prompt", async () => {
    const call = await invoke(make, request());
    expect(call.args.join("\n")).not.toContain("AI_ENGINE_MANAGED_TASK");
    expect(String(call.options.input)).not.toContain("AI_ENGINE_MANAGED_TASK");
    expect(call.args.join("\n")).not.toContain("t-20260101000000-abcd");
  });
});

describe("Codex resumed invocation", () => {
  it("is marked too", async () => {
    const call = await invoke(providers[1][1], request({ resumeSessionId: "some-session", role: "reviewer", sandbox: "read_only" }));
    expect(call.args).toContain("resume");
    expect((call.options.env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK).toBe("t-20260101000000-abcd");
  });
});

describe("Claude resumed invocation", () => {
  it("is marked too", async () => {
    const call = await invoke(providers[0][1], request({ resumeSessionId: "some-session" }));
    expect(call.args).toContain("--resume");
    expect((call.options.env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK).toBe("t-20260101000000-abcd");
  });
});

describe.each(providers)("%s prompt footprint", (_name, make) => {
  it("returns byte-only prompt metadata for the exact prompt it supplies, separately from provider usage", async () => {
    const req = request({
      role: "architect",
      systemPrompt: "System 🧭",
      instructions: "Inspect café",
      context: [{ trust: "repository_content", label: "secret-label", content: "secret context 🐙" }],
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
      resumeSessionId: "prior-session"
    });
    const { call, result } = await invokeResult(make, req);
    const footprint = result.promptFootprint!;
    const sentUserPrompt = String(call.options.input);

    expect(footprint.systemPolicyBytes).toBe(Buffer.byteLength("System 🧭", "utf8"));
    expect(footprint.contextBlockCount).toBe(1);
    expect(footprint.contextBytes).toBeGreaterThan(Buffer.byteLength("secret context 🐙", "utf8"));
    expect(footprint.structuredOutputSchemaBytes).toBe(Buffer.byteLength(JSON.stringify(req.outputSchema), "utf8"));
    expect(footprint.resumedProviderSession).toBe(true);
    expect(result.usage).toBeUndefined();
    expect(JSON.stringify(footprint)).not.toContain("secret context 🐙");
    expect(JSON.stringify(footprint)).not.toContain("secret-label");

    if (_name === "Codex") {
      // Codex has one stdin channel: the actual final input includes its labelled system wrapper.
      expect(footprint.explicitPromptBytes).toBe(Buffer.byteLength(sentUserPrompt, "utf8"));
      expect(footprint.userPromptBytes).toBeLessThan(footprint.explicitPromptBytes);
    } else {
      // Claude receives the user body on stdin and the policy through a separate CLI argument.
      expect(footprint.userPromptBytes).toBe(Buffer.byteLength(sentUserPrompt, "utf8"));
      expect(footprint.explicitPromptBytes).toBe(Buffer.byteLength("System 🧭", "utf8") + Buffer.byteLength(sentUserPrompt, "utf8"));
    }
  });
});

describe("diagnostics are not task invocations", () => {
  it.each(providers)("%s availability checks carry no marker and no custom environment", async (_name, make) => {
    await make().checkAvailability();
    expect(recorded.calls.length).toBeGreaterThan(0);
    for (const call of recorded.calls) expect("env" in call.options).toBe(false);
  });
});
