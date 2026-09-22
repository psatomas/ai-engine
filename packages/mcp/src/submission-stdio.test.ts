import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DelegatedRunStore, TaskStore } from "@ai-engine/orchestrator";
import { connectStdio } from "./test-support/rpc.js";

it.each(["creation", "execution"])(
  "real MCP submission survives server exit and exposes %s failure without invoking a provider",
  async (kind) => {
    const scratch = await mkdtemp(join(tmpdir(), "ai-submit-stdio-"));
    const repo = join(scratch, "repo"),
      data = join(scratch, "data"),
      config = join(scratch, "config");
    await mkdir(repo);
    await mkdir(config);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(repo, "README.md"), "fixture");
    git("add", ".");
    git("commit", "-qm", "fixture");
    // No registered provider matches this id: failure occurs in role resolution before any provider subprocess.
    await writeFile(
      join(config, "config.yaml"),
      kind === "creation"
        ? "roles: [invalid]"
        : "roles:\n  architect:\n    providerId: unit4-no-such-provider\nlogging:\n  toConsole: false\n"
    );
    const env = { ...process.env, AI_ENGINE_DATA_DIR: data, AI_ENGINE_CONFIG_DIR: config, CLAUDECODE: "entry", CLAUDE_CODE_TEST: "entry" };
    delete (env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url))], {
      cwd: repo,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = await connectStdio(child);
    const store = new DelegatedRunStore(repo, data);
    let id: string | undefined;
    try {
      const reply = await client.callTool("submit_task", { request: "Inspect the fixture" });
      expect(reply.result?.isError).toBeUndefined();
      const activity = reply.result!.structuredContent.activity;
      id = activity.taskId;
      expect(activity).toMatchObject({ phase: "CREATING", worker: "starting" });
      const immediate = await client.callTool("get_task", { taskId: id });
      expect(immediate.result?.isError).toBeUndefined();
      expect(immediate.result!.structuredContent.activity.taskId).toBe(id);
      // Close the initiating MCP process; the detached worker has no pipe or parent lifetime dependency.
      await client.close();
      await expect.poll(async () => (await store.activity(id!))?.phase, { timeout: 10000 }).toBe("FAILED");
      const task = await new TaskStore(join(data, "tasks")).get(id!);
      if (kind === "execution") {
        expect(task?.id).toBe(id);
        expect(task?.usageEvents).toEqual([]);
        expect(await readFile(join(repo, ".ai", "tasks", `${id}.md`), "utf8")).toContain(id!);
      } else {
        expect(task).toBeUndefined();
      }
      const inspector = spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url))], {
        cwd: repo,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const reconnected = await connectStdio(inspector);
      try {
        const observed = await reconnected.callTool("get_task", { taskId: id });
        expect(observed.result?.isError).toBeUndefined();
        expect(observed.result!.structuredContent.activity.error).toBe(kind === "creation" ? "TASK_CREATION_FAILED" : "EXECUTION_FAILED");
      } finally {
        await reconnected.close();
      }
      expect(git("diff", "--name-only")).toBe("");
    } finally {
      await client.close();
      // The worker finished or failed before cleanup; no model or real provider was ever started.
      await rm(scratch, { recursive: true, force: true });
    }
  },
  15000
);
