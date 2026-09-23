import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { TaskRecord } from "@ai-engine/core";
import { TaskStore } from "@ai-engine/orchestrator";
import { connectStdio } from "./test-support/rpc.js";

/**
 * The whole decide_task round trip over the REAL stdio protocol, through the REAL detached worker,
 * a REAL TaskStore and a REAL task lock — no fake or mocked orchestrator anywhere. A plan decision's
 * reject/re-submit cycle needs no provider at all (decidePlan and submitForApproval are pure workflow
 * transitions), so this proves the whole path genuinely works without any risk of starting one.
 */
it("real MCP decide_task answers a live decision, continues through the real worker, and refuses the now-stale one", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ai-decide-stdio-"));
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
  const commit = git("rev-parse", "HEAD").trim();

  const taskId = "t-20260101000000-decd";
  const now = "2026-01-01T00:00:00.000Z";
  const seed: TaskRecord = {
    id: taskId,
    repository: { root: repo },
    workspaceFolder: repo,
    originalRequest: "Add a feature",
    specification: "Add a feature to the fixture.",
    plan: "1. Add the feature.\n2. Test it.",
    workflowState: "AWAITING_APPROVAL",
    agentsUsed: [],
    git: { branch: "main", commit, dirtyAtStart: false, untrackedAtStart: [] },
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
  };
  await new TaskStore(join(data, "tasks")).save(seed);

  const env = { ...process.env, AI_ENGINE_DATA_DIR: data, AI_ENGINE_CONFIG_DIR: config, CLAUDECODE: "entry", CLAUDE_CODE_TEST: "entry" };
  delete (env as NodeJS.ProcessEnv).AI_ENGINE_MANAGED_TASK;
  const spawnServer = () =>
    spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url))], {
      cwd: repo,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

  try {
    const first = await connectStdio(spawnServer());
    let decisionId: string;
    try {
      const tools = ((await first.request("tools/list")).result!.tools as Array<{ name: string }>).map((t) => t.name).sort();
      expect(tools).toEqual(["decide_task", "get_task", "list_tasks", "submit_task"]);

      // Real, repository-scoped inspection: the live decision, read exactly as get_task exposes it.
      const before = await first.callTool("get_task", { taskId });
      expect(before.result?.isError).toBeUndefined();
      const decision = before.result!.structuredContent.task.pendingDecision.decision;
      expect(decision).toMatchObject({ kind: "plan", options: ["approve", "reject", "cancel"] });
      decisionId = decision.id;

      // An unknown task is refused the same way a foreign-repository one is (see decide.test.ts for that equivalence directly).
      const unknown = await first.callTool("decide_task", { taskId: "t-20260101000000-xxxx", decisionId, decision: "reject" });
      expect(unknown.result!.structuredContent.error.code).toBe("TASK_NOT_FOUND");

      const reply = await first.callTool("decide_task", { taskId, decisionId, decision: "reject" });
      expect(reply.result?.isError).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(reply), "utf8")).toBeLessThanOrEqual(4096);
      const activity = reply.result!.structuredContent.activity;
      expect(activity).toMatchObject({ phase: "CREATING", worker: "starting" });
    } finally {
      // Close the initiating MCP process; the detached worker has no pipe or parent lifetime dependency.
      await first.close();
    }

    // The seed itself starts in AWAITING_APPROVAL, so the state name alone can't distinguish "not yet
    // processed" from "processed": poll until BOTH the reject's approval record exists AND run() has
    // carried the task all the way back around to AWAITING_APPROVAL, read together so neither can be stale.
    await expect
      .poll(
        async () => {
          const task = await new TaskStore(join(data, "tasks")).get(taskId);
          return task && task.approvals.length > 0 ? task.workflowState : undefined;
        },
        { timeout: 10000 }
      )
      .toBe("AWAITING_APPROVAL");

    const rejected = await new TaskStore(join(data, "tasks")).get(taskId);
    expect(rejected!.approvals.at(-1)).toMatchObject({ gate: "plan", decision: "rejected" });

    const second = await connectStdio(spawnServer());
    try {
      const after = await second.callTool("get_task", { taskId });
      const freshDecision = after.result!.structuredContent.task.pendingDecision.decision;
      expect(freshDecision.kind).toBe("plan");
      expect(freshDecision.id).not.toBe(decisionId); // a new decision: the old id is now stale

      // The now-stale decisionId (from BEFORE the reject) must never affect the newer decision.
      const stale = await second.callTool("decide_task", { taskId, decisionId, decision: "approve" });
      expect(stale.result!.structuredContent.error.code).toBe("STALE_DECISION");

      const finalTask = await new TaskStore(join(data, "tasks")).get(taskId);
      expect(finalTask!.workflowState).toBe("AWAITING_APPROVAL"); // the stale attempt changed nothing
      expect(finalTask!.approvals).toHaveLength(1); // still only the one real rejection

      const summary = await readFile(join(repo, ".ai", "tasks", `${taskId}.md`), "utf8");
      expect(summary).toContain(taskId);
      expect(git("diff", "--name-only")).toBe(""); // no repository mutation
    } finally {
      await second.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 15000);
