import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { TaskRecord } from "@ai-engine/core";
import { TaskStore } from "@ai-engine/orchestrator";
import { connectStdio } from "./test-support/rpc.js";

/**
 * Issue #9's full acceptance path over the REAL stdio protocol, through the REAL detached worker —
 * no fake or mocked orchestrator anywhere: a real repository, a real out-of-band commit, a real
 * git-state divergence, a real get_task exposing it as a pending decision, and a real decide_task
 * acknowledgement that resolves it via the real acknowledgeDivergence(). Divergence detection and
 * acknowledgement are both pure orchestration/git operations — neither needs a provider — so this
 * proves the whole recovery loop genuinely works without any risk of invoking Claude or Codex.
 */
it("real MCP get_task exposes a live git-state divergence, and decide_task's acknowledgement resolves it through the real detached worker", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ai-decide-divergence-stdio-"));
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

  const taskId = "t-20260101000000-dvrg";
  const now = "2026-01-01T00:00:00.000Z";
  const seed: TaskRecord = {
    id: taskId,
    repository: { root: repo },
    workspaceFolder: repo,
    originalRequest: "Add a feature",
    specification: "Add a feature to the fixture.",
    plan: "1. Add the feature.\n2. Test it.",
    workflowState: "IMPLEMENTING",
    agentsUsed: [],
    git: { branch: "main", commit, worktreePath: repo, lastKnownCommit: commit, dirtyAtStart: false, untrackedAtStart: [] },
    verification: [],
    reviews: [],
    approvals: [],
    history: [],
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

  // The real out-of-band commit: nobody told the task store about it — exactly H4's own technique,
  // constructed here before any MCP server ever starts, so the divergence is already live from the
  // very first get_task call.
  await writeFile(join(repo, "out-of-band.txt"), "diverged\n");
  git("add", ".");
  git("commit", "-qm", "out-of-band commit the orchestrator never recorded");
  const actualCommit = git("rev-parse", "HEAD").trim();

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
      // Real, repository-scoped inspection: the live divergence, read exactly as get_task exposes it.
      const before = await first.callTool("get_task", { taskId });
      expect(before.result?.isError).toBeUndefined();
      const decision = before.result!.structuredContent.task.pendingDecision.decision;
      expect(decision).toMatchObject({
        kind: "divergence",
        options: ["approve", "cancel"],
        divergence: { expectedCommit: commit, actualCommit }
      });
      decisionId = decision.id;

      const reply = await first.callTool("decide_task", { taskId, decisionId, decision: "approve" });
      expect(reply.result?.isError).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(reply), "utf8")).toBeLessThanOrEqual(4096);
      const activity = reply.result!.structuredContent.activity;
      expect(activity).toMatchObject({ phase: "CREATING", worker: "starting" });
    } finally {
      await first.close();
    }

    // The seed's own workflowState (IMPLEMENTING) never changes across acknowledgement, so poll on
    // the DIVERGENCE_ACKNOWLEDGED failure entry actually landing — the unambiguous signal that the
    // real detached worker really called the real acknowledgeDivergence(), not merely that some
    // activity settled.
    await expect
      .poll(
        async () => {
          const task = await new TaskStore(join(data, "tasks")).get(taskId);
          return task?.failures.at(-1)?.code;
        },
        { timeout: 10000 }
      )
      .toBe("DIVERGENCE_ACKNOWLEDGED");

    const acknowledged = await new TaskStore(join(data, "tasks")).get(taskId);
    // The real git baseline was genuinely updated — not a mock, not a duplicated transition.
    expect(acknowledged!.git.lastKnownCommit).toBe(actualCommit);
    expect(acknowledged!.workflowState).toBe("IMPLEMENTING"); // unstuck, not terminal — ready for a normal next step

    // Past the divergence boundary: a fresh get_task no longer reports it as a pending decision.
    const second = await connectStdio(spawnServer());
    try {
      const after = await second.callTool("get_task", { taskId });
      expect(after.result!.structuredContent.task.pendingDecision).toEqual({ status: "none" });
    } finally {
      await second.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 15000);
