import { openSync, closeSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitRepository } from "@ai-engine/git";
import { createOrchestrator, DirtyWorkingTreeError } from "./orchestrator.js";
import { resolveEnginePaths } from "@ai-engine/config";
import { DelegatedRunStore, executeDelegatedTask, submitDelegatedTask, workerEnvironment, type WorkerLaunch } from "./delegated-run.js";

let scratch: string, repo: string, data: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ai-delegated-"));
  repo = join(scratch, "repo");
  data = join(scratch, "data");
  await mkdir(repo);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(repo, "file"), "initial");
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  git("add", ".");
  git("commit", "-qm", "initial");
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});
const env = () => ({ ...process.env, AI_ENGINE_DATA_DIR: data, AI_ENGINE_CONFIG_DIR: join(scratch, "config") });
const api = async () => createOrchestrator(repo, { paths: resolveEnginePaths(env()) });
const store = () => new DelegatedRunStore(repo, data);

it.each(["../escape", "t-a/b", "t-a\\b", "t-a..b", "t-" + "x".repeat(64), "", null])(
  "refuses unsafe supplied id %s before mutation",
  async (taskId) => {
    const orchestrator = await api();
    await expect(orchestrator.createTask("work", { taskId: taskId as string })).rejects.toThrow("INVALID_TASK_ID");
    await expect(readdir(data)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }
);
it("preserves default creation and accepts a supplied safe id without overwriting a task", async () => {
  const orchestrator = await api();
  const task = await orchestrator.createTask("work", { taskId: "t-supplied", requireCleanTree: true });
  expect(task.id).toBe("t-supplied");
  await expect(orchestrator.createTask("overwrite", { taskId: task.id })).rejects.toThrow("TASK_ALREADY_EXISTS");
  expect((await orchestrator.getTask(task.id))!.originalRequest).toBe("work");
  expect((await orchestrator.createTask("default")).id).toMatch(/^t-\d{14}-[a-f0-9]{4}$/);
});
it.each(["staged", "tracked", "untracked", "ai-config", "rename", "conflict"])(
  "refuses %s before submission marker/spawn",
  async (kind) => {
    if (kind === "staged") {
      await writeFile(join(repo, "file"), "changed");
      git("add", "file");
    }
    if (kind === "tracked") await writeFile(join(repo, "file"), "changed");
    if (kind === "untracked") await writeFile(join(repo, "new\nfile"), "changed");
    if (kind === "ai-config") {
      await mkdir(join(repo, ".ai"));
      await writeFile(join(repo, ".ai", "project.yaml"), "name: test\nroles: {}");
    }
    if (kind === "rename") git("mv", "file", "renamed");
    if (kind === "conflict") {
      const hash = git("rev-parse", "HEAD:file").trim();
      const infoPath = join(scratch, "index-info");
      writeFileSync(infoPath, `0 ${"0".repeat(40)}\tfile\n100644 ${hash} 1\tfile\n100644 ${hash} 2\tfile\n100644 ${hash} 3\tfile\n`);
      const fd = openSync(infoPath, "r");
      try {
        execFileSync("git", ["update-index", "--index-info"], { cwd: repo, stdio: [fd, "pipe", "pipe"] });
      } finally {
        closeSync(fd);
      }
    }
    const before = git("status", "--porcelain=v1");
    const launch = vi.fn();
    await expect(submitDelegatedTask("work", { cwd: repo, env: env(), launch })).rejects.toMatchObject({ code: "DIRTY_WORKING_TREE" });
    expect(launch).not.toHaveBeenCalled();
    await expect(readdir(data)).rejects.toMatchObject({ code: "ENOENT" });
    await expect((await api()).createTask("work", { requireCleanTree: true })).rejects.toBeInstanceOf(DirtyWorkingTreeError);
    expect(git("status", "--porcelain=v1")).toBe(before);
  }
);
it("exempts only untracked task mirrors and ignored files", async () => {
  await mkdir(join(repo, ".ai", "tasks"), { recursive: true });
  await writeFile(join(repo, ".ai", "tasks", "t-x.md"), "mirror");
  await mkdir(join(repo, "ignored"));
  await writeFile(join(repo, "ignored", "file"), "ignored");
  expect(await (await GitRepository.discover(repo)).delegationDirtyCounts()).toEqual({ staged: 0, tracked: 0, untracked: 0 });
  git("add", ".ai/tasks");
  git("commit", "-qm", "track mirror");
  await writeFile(join(repo, ".ai", "tasks", "t-x.md"), "changed");
  expect((await (await GitRepository.discover(repo)).delegationDirtyCounts()).tracked).toBe(1);
});
it("returns a durable CREATING id, scrubs entry variables, and excludes a second reservation", async () => {
  let launched!: WorkerLaunch;
  const result = await submitDelegatedTask("work", {
    cwd: repo,
    env: { ...env(), CLAUDECODE: "1", CLAUDE_CODE_X: "secret", KEEP: "yes" },
    launch: async (input) => {
      launched = input;
    }
  });
  expect(result).toEqual({ taskId: launched.taskId, phase: "CREATING", worker: "starting" });
  expect(launched.env).not.toHaveProperty("CLAUDECODE");
  expect(launched.env).not.toHaveProperty("CLAUDE_CODE_X");
  expect(launched.env.KEEP).toBe("yes");
  expect(await store().activity(result.taskId)).toEqual(result);
  expect(await store().currentActivity()).toEqual(result);
  await expect(submitDelegatedTask("another", { cwd: repo, env: env(), launch: vi.fn() })).rejects.toMatchObject({
    code: "DELEGATED_RUN_EXISTS"
  });
});
it("preserves managed marker and custom provider configuration while scrubbing", () => {
  expect(
    workerEnvironment({ CLAUDECODE: "1", CLAUDE_CODE_FOO: "x", AI_ENGINE_MANAGED_TASK: "t-a", AI_ENGINE_DATA_DIR: data, PATH: "path" })
  ).toEqual({ AI_ENGINE_MANAGED_TASK: "t-a", AI_ENGINE_DATA_DIR: data, PATH: "path" });
});
it("only one concurrent reservation wins, including independent store instances", async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store().reserve(`t-${i}`, "work")));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
});
it("launch failure is durable, bounded, and releases only this reservation", async () => {
  let id = "";
  await expect(
    submitDelegatedTask("work", {
      cwd: repo,
      env: env(),
      launch: async (input) => {
        id = input.taskId;
        throw new Error("secret/path");
      }
    })
  ).rejects.toMatchObject({ code: "WORKER_LAUNCH_FAILED" });
  expect(await store().activity(id)).toMatchObject({ phase: "FAILED", worker: "finished", error: "WORKER_LAUNCH_FAILED" });
  await expect(store().reserve("t-next", "next")).resolves.toBeDefined();
});
it("worker creates then runs sequentially and keeps the reservation through both", async () => {
  const reservation = await store().reserve("t-worker", "work");
  const calls: string[] = [];
  await executeDelegatedTask(reservation.taskId, reservation.nonce, {
    cwd: repo,
    dataDir: data,
    open: async () => ({
      createTask: vi.fn(async (_request, opts) => {
        calls.push("create");
        expect(opts).toEqual({ taskId: reservation.taskId, requireCleanTree: true });
        expect(await store().activity(reservation.taskId)).toMatchObject({ phase: "CREATING", worker: "active" });
        await expect(store().reserve("t-other", "other")).rejects.toMatchObject({ code: "DELEGATED_RUN_EXISTS" });
        return {} as never;
      }),
      run: vi.fn(async (id) => {
        calls.push("run");
        expect(id).toBe(reservation.taskId);
        expect(await store().activity(id)).toMatchObject({ phase: "RUNNING" });
        return { workflowState: "AWAITING_APPROVAL" } as never;
      })
    })
  });
  expect(calls).toEqual(["create", "run"]);
  expect(await store().activity(reservation.taskId)).toMatchObject({ phase: "FINISHED", worker: "finished" });
  await expect(store().reserve("t-next", "next")).resolves.toBeDefined();
});
it("rechecks dirty state after launch before task creation", async () => {
  const reservation = await store().reserve("t-dirty", "work");
  await writeFile(join(repo, "file"), "later edit");
  await executeDelegatedTask(reservation.taskId, reservation.nonce, { cwd: repo, dataDir: data, open: api });
  expect(await store().activity(reservation.taskId)).toMatchObject({ phase: "FAILED", error: "DIRTY_WORKING_TREE" });
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
});
it("failed creation is observable; unexpected execution failure keeps ownership", async () => {
  const reservation = await store().reserve("t-creation", "work");
  const broken = { createTask: vi.fn().mockRejectedValue(new Error("secret")), run: vi.fn() };
  await executeDelegatedTask(reservation.taskId, reservation.nonce, { cwd: repo, dataDir: data, open: async () => broken });
  expect(broken.run).not.toHaveBeenCalled();
  expect(await store().activity(reservation.taskId)).toMatchObject({ error: "TASK_CREATION_FAILED", worker: "finished" });
  const next = await store().reserve("t-execution", "work");
  await executeDelegatedTask(next.taskId, next.nonce, {
    cwd: repo,
    dataDir: data,
    open: async () => ({ createTask: vi.fn().mockResolvedValue({}), run: vi.fn().mockRejectedValue(new Error("provider secret")) })
  });
  expect(await store().activity(next.taskId)).toMatchObject({ error: "EXECUTION_FAILED", phase: "FAILED" });
  await expect(store().reserve("t-next", "next")).rejects.toMatchObject({ code: "DELEGATED_RUN_EXISTS" });
});
it("stale worker is observable but its reservation cannot be stolen", async () => {
  const reservation = await store().reserve("t-stale", "work");
  await store().update({ ...reservation, pid: 2147483647, started: true });
  expect(await store().activity(reservation.taskId)).toMatchObject({ worker: "stale" });
  await expect(store().reserve("t-next", "work")).rejects.toMatchObject({ code: "DELEGATED_RUN_EXISTS" });
});
it("rejects wrong nonce and duplicate worker starts without opening the orchestrator", async () => {
  const record = await store().reserve("t-once", "work");
  const open = vi.fn();
  await expect(executeDelegatedTask(record.taskId, "a".repeat(32), { cwd: repo, dataDir: data, open })).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  const pending = new Promise<never>(() => {});
  const first = executeDelegatedTask(record.taskId, record.nonce, {
    cwd: repo,
    dataDir: data,
    open: async () => ({ createTask: async () => pending, run: vi.fn() })
  });
  void first;
  await vi.waitFor(async () => expect((await store().record(record.taskId))!.started).toBe(true));
  await expect(executeDelegatedTask(record.taskId, record.nonce, { cwd: repo, dataDir: data, open })).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});
it("invalid requests do not discover repositories or launch", async () => {
  for (const request of ["", " \n", "🙂".repeat(5000)])
    await expect(submitDelegatedTask(request, { cwd: "/does-not-exist" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
