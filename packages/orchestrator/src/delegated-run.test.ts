import { openSync, closeSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepository } from "@ai-engine/git";
import { createOrchestrator, DirtyWorkingTreeError } from "./orchestrator.js";
import { resolveEnginePaths } from "@ai-engine/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionApplicationError } from "./orchestrator.js";
import type { DecisionOption } from "./pending-decision.js";
import {
  DELEGATED_DECISION_ACTOR,
  DelegatedRunStore,
  executeDelegatedTask,
  submitDelegatedContinuation,
  submitDelegatedTask,
  workerEnvironment,
  type WorkerLaunch
} from "./delegated-run.js";

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
      }),
      applyDecision: vi.fn()
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
  const broken = { createTask: vi.fn().mockRejectedValue(new Error("secret")), run: vi.fn(), applyDecision: vi.fn() };
  await executeDelegatedTask(reservation.taskId, reservation.nonce, { cwd: repo, dataDir: data, open: async () => broken });
  expect(broken.run).not.toHaveBeenCalled();
  expect(await store().activity(reservation.taskId)).toMatchObject({ error: "TASK_CREATION_FAILED", worker: "finished" });
  const next = await store().reserve("t-execution", "work");
  await executeDelegatedTask(next.taskId, next.nonce, {
    cwd: repo,
    dataDir: data,
    open: async () => ({
      createTask: vi.fn().mockResolvedValue({}),
      run: vi.fn().mockRejectedValue(new Error("provider secret")),
      applyDecision: vi.fn()
    })
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
    open: async () => ({ createTask: async () => pending, run: vi.fn(), applyDecision: vi.fn() })
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

describe("continuation intent — extends delegated runs without overloading submission", () => {
  const decisionId = "pd1_" + "a".repeat(32);

  it("reserves and returns durable CREATING activity, exactly like submission", async () => {
    let launched!: WorkerLaunch;
    const result = await submitDelegatedContinuation("t-continue", decisionId, "approve", {
      checkId: "repo.deploy-check",
      cwd: repo,
      env: env(),
      launch: async (input) => {
        launched = input;
      }
    });
    expect(result).toEqual({ taskId: "t-continue", phase: "CREATING", worker: "starting" });
    expect(launched.taskId).toBe("t-continue");
    expect(await store().activity("t-continue")).toEqual(result);
  });

  it.each([
    ["malformed decisionId", "not-a-decision-id", "approve", undefined],
    ["unknown action", decisionId, "explode", undefined],
    ["overlong checkId", decisionId, "approve", "x".repeat(201)],
    ["empty checkId", decisionId, "approve", ""]
  ])("refuses %s before discovering a repository or launching", async (_label, id, action, checkId) => {
    const launch = vi.fn();
    await expect(
      submitDelegatedContinuation("t-bad", id, action as DecisionOption, { checkId, cwd: "/does-not-exist", launch })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("a submission reservation excludes a continuation, and vice versa — one active run per repository regardless of kind", async () => {
    await submitDelegatedTask("work", { cwd: repo, env: env(), launch: vi.fn() });
    await expect(
      submitDelegatedContinuation("t-continue", decisionId, "approve", { checkId: "c", cwd: repo, env: env(), launch: vi.fn() })
    ).rejects.toMatchObject({ code: "DELEGATED_RUN_EXISTS" });
  });

  it("does not require a clean working tree (unlike submission)", async () => {
    await writeFile(join(repo, "file"), "dirty, on purpose");
    const launch = vi.fn();
    await expect(submitDelegatedContinuation("t-continue", decisionId, "resume", { cwd: repo, env: env(), launch })).resolves.toMatchObject(
      { phase: "CREATING" }
    );
    expect(launch).toHaveBeenCalledOnce();
  });

  it("the worker applies exactly the persisted decision, with the fixed system actor, then continues via run()", async () => {
    const reservation = await store().reserve("t-apply", { kind: "continuation", decisionId, action: "approve", checkId: "repo.check" });
    const applyDecision = vi.fn().mockResolvedValue({});
    const run = vi.fn().mockResolvedValue({ workflowState: "READY" });
    await executeDelegatedTask(reservation.taskId, reservation.nonce, {
      cwd: repo,
      dataDir: data,
      open: async () => ({ createTask: vi.fn(), run, applyDecision })
    });
    expect(applyDecision).toHaveBeenCalledWith("t-apply", decisionId, "approve", { checkId: "repo.check", by: DELEGATED_DECISION_ACTOR });
    expect(run).toHaveBeenCalledWith("t-apply");
    expect(await store().activity("t-apply")).toMatchObject({ phase: "FINISHED", worker: "finished" });
  });

  it("a decision without a checkId applies with checkId undefined — never a fabricated or guessed one", async () => {
    const reservation = await store().reserve("t-apply-none", { kind: "continuation", decisionId, action: "resume" });
    const applyDecision = vi.fn().mockResolvedValue({});
    await executeDelegatedTask(reservation.taskId, reservation.nonce, {
      cwd: repo,
      dataDir: data,
      open: async () => ({ createTask: vi.fn(), run: vi.fn().mockResolvedValue({ workflowState: "READY" }), applyDecision })
    });
    expect(applyDecision).toHaveBeenCalledWith("t-apply-none", decisionId, "resume", { checkId: undefined, by: DELEGATED_DECISION_ACTOR });
  });

  it.each(["STALE_DECISION", "ACTION_NOT_AVAILABLE", "CHECK_ID_REQUIRED", "CHECK_ID_INVALID", "CHECK_ID_NOT_APPLICABLE"] as const)(
    "surfaces a %s validation failure as durable, bounded activity and never calls run()",
    async (code) => {
      const taskId = "t-invalid-" + code.toLowerCase().replace(/_/g, "-");
      const reservation = await store().reserve(taskId, { kind: "continuation", decisionId, action: "approve" });
      const run = vi.fn();
      await executeDelegatedTask(reservation.taskId, reservation.nonce, {
        cwd: repo,
        dataDir: data,
        open: async () => ({
          createTask: vi.fn(),
          run,
          applyDecision: vi.fn().mockRejectedValue(new DecisionApplicationError(code, reservation.taskId))
        })
      });
      expect(run).not.toHaveBeenCalled();
      expect(await store().activity(reservation.taskId)).toMatchObject({ phase: "FAILED", worker: "finished", error: code });
      // Fully settled and released: a fresh reservation is possible right away.
      await expect(store().reserve("t-next-after-" + code.toLowerCase().replace(/_/g, "-"), "next")).resolves.toBeDefined();
    }
  );

  it("an unexpected (non-DecisionApplicationError) failure applying the decision is bounded as DECISION_APPLICATION_FAILED", async () => {
    const reservation = await store().reserve("t-unexpected", { kind: "continuation", decisionId, action: "approve", checkId: "c" });
    const run = vi.fn();
    await executeDelegatedTask(reservation.taskId, reservation.nonce, {
      cwd: repo,
      dataDir: data,
      open: async () => ({ createTask: vi.fn(), run, applyDecision: vi.fn().mockRejectedValue(new Error("filesystem secret /etc/passwd")) })
    });
    expect(run).not.toHaveBeenCalled();
    const activity = await store().activity(reservation.taskId);
    expect(activity).toMatchObject({ phase: "FAILED", error: "DECISION_APPLICATION_FAILED" });
    expect(JSON.stringify(activity)).not.toMatch(/secret|passwd/);
  });

  it("a failure once running (inside run()) is EXECUTION_FAILED, exactly like submission", async () => {
    const reservation = await store().reserve("t-exec-fail", { kind: "continuation", decisionId, action: "retry" });
    await executeDelegatedTask(reservation.taskId, reservation.nonce, {
      cwd: repo,
      dataDir: data,
      open: async () => ({
        createTask: vi.fn(),
        applyDecision: vi.fn().mockResolvedValue({}),
        run: vi.fn().mockRejectedValue(new Error("boom"))
      })
    });
    expect(await store().activity(reservation.taskId)).toMatchObject({ phase: "FAILED", error: "EXECUTION_FAILED" });
  });

  it("a run that ends in FAILED workflow state is reported the same way for a continuation as for a submission", async () => {
    const reservation = await store().reserve("t-workflow-failed", { kind: "continuation", decisionId, action: "cancel" });
    await executeDelegatedTask(reservation.taskId, reservation.nonce, {
      cwd: repo,
      dataDir: data,
      open: async () => ({
        createTask: vi.fn(),
        applyDecision: vi.fn().mockResolvedValue({}),
        run: vi.fn().mockResolvedValue({ workflowState: "FAILED" })
      })
    });
    expect(await store().activity(reservation.taskId)).toMatchObject({ phase: "FAILED", error: "EXECUTION_FAILED" });
  });

  it("a stored continuation record round-trips exactly through read()/reserve(), including checkId's absence", async () => {
    await store().reserve("t-roundtrip", { kind: "continuation", decisionId, action: "cancel" });
    const record = await store().record("t-roundtrip");
    expect(record).toMatchObject({ taskId: "t-roundtrip", intent: { kind: "continuation", decisionId, action: "cancel" } });
    expect(record!.intent).not.toHaveProperty("checkId");
  });
});

describe("continuation — repository ownership is enforced authoritatively, not just by the MCP caller", () => {
  const foreignDecisionId = "pd1_" + "b".repeat(32);

  it("a direct continuation reservation for a foreign-repository task reserves and launches, but the real worker refuses before applying anything, and releases ownership", async () => {
    const otherRepo = join(scratch, "other-repo");
    await mkdir(otherRepo);
    const otherGit = (...args: string[]) => execFileSync("git", args, { cwd: otherRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();
    otherGit("init", "-q");
    otherGit("config", "user.email", "test@example.com");
    otherGit("config", "user.name", "Test");
    await writeFile(join(otherRepo, "file"), "initial");
    otherGit("add", ".");
    otherGit("commit", "-qm", "initial");

    // A real task that genuinely belongs to otherRepo, stored in the data dir the continuation below will share.
    const { TaskStore } = await import("./task-store.js");
    const foreignTaskId = "t-foreign-0000000-aaaa";
    const now = new Date().toISOString();
    await new TaskStore(join(data, "tasks")).save({
      id: foreignTaskId,
      repository: { root: otherRepo },
      workspaceFolder: otherRepo,
      originalRequest: "work elsewhere",
      workflowState: "AWAITING_APPROVAL",
      specification: "spec",
      plan: "1. do it",
      agentsUsed: [],
      git: { branch: "main", commit: otherGit("rev-parse", "HEAD").trim(), dirtyAtStart: false, untrackedAtStart: [] },
      verification: [],
      reviews: [],
      approvals: [],
      history: [{ at: now, from: "PLAN_READY", to: "AWAITING_APPROVAL", trigger: "submit_for_approval", actor: "system" }],
      failures: [],
      iterationCounts: {},
      createdAt: now,
      updatedAt: now,
      providerSessions: {},
      usage: {},
      roleInvocationCounts: {},
      usageEvents: []
    });
    const before = await new TaskStore(join(data, "tasks")).get(foreignTaskId);

    // A direct, internal continuation attempt against `repo` (NOT otherRepo) for that foreign task —
    // no MCP preflight anywhere in this test. Reservation is scoped to `repo`, so it succeeds; only
    // the worker, opening an orchestrator FOR `repo`, is positioned to know the task doesn't belong to it.
    const activity = await submitDelegatedContinuation(foreignTaskId, foreignDecisionId, "approve", {
      checkId: undefined,
      cwd: repo,
      env: env(),
      launch: vi.fn()
    });
    expect(activity).toMatchObject({ phase: "CREATING", worker: "starting" });

    const reservation = (await store().record(foreignTaskId))!;
    // The worker opens a REAL orchestrator for `repo` (not `otherRepo`) — exactly what the detached
    // worker process does for whatever repository it was actually launched into.
    await executeDelegatedTask(reservation.taskId, reservation.nonce, { cwd: repo, dataDir: data, open: api });

    const finalActivity = await store().activity(foreignTaskId);
    expect(finalActivity).toMatchObject({ phase: "FAILED", worker: "finished", error: "STALE_DECISION" });
    expect(JSON.stringify(finalActivity)).not.toContain(otherRepo);
    expect(JSON.stringify(finalActivity)).not.toContain(repo);
    // No decision method ran: the foreign task is byte-for-byte unchanged.
    expect(await new TaskStore(join(data, "tasks")).get(foreignTaskId)).toEqual(before);
    // Ownership was released: ordinary submission/continuation work against `repo` is not blocked by this.
    await expect(store().reserve("t-next", "next")).resolves.toBeDefined();
  });
});
