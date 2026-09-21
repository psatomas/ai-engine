import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalConfigSchema, type GlobalConfig, type ProjectConfig } from "@ai-engine/config";
import { buildDefaultWorkflow, WorkflowEngine } from "@ai-engine/workflow";
import { SecurityPolicy, CommandApprovalStore } from "@ai-engine/security";
import { GitRepository } from "@ai-engine/git";
import { createLogger } from "@ai-engine/logging";
import type { AgentInvocationRequest, AgentResult } from "@ai-engine/core";
import { TaskStore } from "./task-store.js";
import { RoleRegistry, type ProviderFactory } from "./role-registry.js";
import { Orchestrator } from "./orchestrator.js";
import { MockProvider } from "./test-support/mock-provider.js";

let repoDir: string;
let dataDir: string;

function happyResponder(request: AgentInvocationRequest): AgentResult {
  switch (request.role) {
    case "architect":
      return { status: "success", structuredOutput: { specification: "Add a feature.", plan: "1. Add feature.txt", risks: [] } };
    case "implementer":
      writeFileSync(join(request.workingDirectory, "feature.txt"), "feature content\n");
      return { status: "success", finalMessage: "Added feature.txt" };
    case "reviewer":
    case "security_reviewer":
      return { status: "success", structuredOutput: { verdict: "approved", summary: `${request.role} looks good.`, findings: [] } };
    case "verifier":
      return { status: "success", structuredOutput: { verdict: "approved", summary: "Confirmed complete.", findings: [] } };
    default:
      return { status: "failure", error: { code: "UNKNOWN_ROLE", message: `no mock behavior for role ${request.role}` } };
  }
}

async function build(
  provider: MockProvider,
  configOverrides: Partial<GlobalConfig> = {},
  projectConfig?: ProjectConfig
): Promise<Orchestrator> {
  const gitRepo = await GitRepository.discover(repoDir);
  const paths = {
    configDir: dataDir,
    dataDir,
    configFile: join(dataDir, "config.yaml"),
    taskStoreDir: join(dataDir, "tasks"),
    worktreesDir: join(dataDir, "worktrees"),
    logsDir: join(dataDir, "logs"),
    cacheDir: join(dataDir, "cache")
  };
  const globalConfig = GlobalConfigSchema.parse({
    roles: {
      architect: { providerId: "mock" },
      implementer: { providerId: "mock" },
      reviewer: { providerId: "mock" },
      security_reviewer: { providerId: "mock" },
      verifier: { providerId: "mock" }
    },
    ...configOverrides
  });
  const factories = new Map<string, ProviderFactory>([["mock", () => provider]]);
  return new Orchestrator({
    gitRepo,
    paths,
    globalConfig,
    projectConfig,
    taskStore: new TaskStore(paths.taskStoreDir),
    roleRegistry: new RoleRegistry(globalConfig, projectConfig, factories),
    securityPolicy: new SecurityPolicy(globalConfig.security),
    commandApprovalStore: new CommandApprovalStore(join(dataDir, "approvals.json")),
    logger: createLogger([]),
    workflow: new WorkflowEngine(buildDefaultWorkflow(), globalConfig.workflow)
  });
}

/** Names, sizes, mtimes and content hashes of every file under a directory (skipping git internals), to prove nothing was written. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = statSync(full);
        out[full] = `${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
      }
    }
  };
  walk(dir);
  return out;
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-pending-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-pending-data-"));
  const git = simpleGit(repoDir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  await git.add(".");
  await git.commit("initial commit");
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("Orchestrator.pendingDecision() against a real task lifecycle", () => {
  it("follows the whole pipeline: nothing pending, plan, nothing, security gate, nothing, READY", async () => {
    const provider = new MockProvider("mock", happyResponder);
    const orchestrator = await build(provider);

    let task = await orchestrator.createTask("Add a feature");
    expect(await orchestrator.pendingDecision(task.id)).toBeUndefined();

    task = await orchestrator.analyze(task.id);
    expect(task.workflowState).toBe("AWAITING_APPROVAL");
    const plan = (await orchestrator.pendingDecision(task.id))!;
    expect(plan).toMatchObject({
      kind: "plan",
      options: ["approve", "reject", "cancel"],
      specification: "Add a feature.",
      plan: "1. Add feature.txt",
      truncated: false
    });

    await orchestrator.decidePlan(task.id, "approved", "tester");
    expect(await orchestrator.pendingDecision(task.id)).toBeUndefined();

    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("PAUSED");
    const gate = (await orchestrator.pendingDecision(task.id))!;
    expect(gate).toMatchObject({ kind: "gate", gate: "security_review", options: ["approve", "reject", "cancel"] });
    expect(gate.reviews!.map((r) => [r.role, r.verdict, r.summary])).toEqual([
      ["reviewer", "approved", "reviewer looks good."],
      ["security_reviewer", "approved", "security_reviewer looks good."]
    ]);
    expect(gate.id).not.toBe(plan.id);

    await orchestrator.decideGate(task.id, "security_review", "approved", "tester");
    expect(await orchestrator.pendingDecision(task.id)).toBeUndefined();

    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("READY");
    expect(await orchestrator.pendingDecision(task.id)).toBeUndefined();
  });

  it("is read-only: it invokes no provider, changes no task state, and is stable across calls", async () => {
    const provider = new MockProvider("mock", happyResponder);
    const orchestrator = await build(provider);
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const before = await orchestrator.getTask(created.id);
    const invocations = provider.invocations.length;

    const first = await orchestrator.pendingDecision(created.id);
    const second = await orchestrator.pendingDecision(created.id);

    expect(second).toEqual(first);
    expect(provider.invocations.length).toBe(invocations);
    expect(await orchestrator.getTask(created.id)).toEqual(before);
  });

  it("rejects an unknown task rather than reporting nothing pending", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    await expect(orchestrator.pendingDecision("t-19990101000000-0000")).rejects.toThrow(/Unknown task|not found/i);
  });

  it("gives the same plan a new decision id once it has been rejected and resubmitted, so an old answer cannot be replayed", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const first = (await orchestrator.pendingDecision(created.id))!;

    await orchestrator.decidePlan(created.id, "rejected", "tester");
    expect(await orchestrator.pendingDecision(created.id)).toBeUndefined(); // PLAN_READY: the orchestrator's move
    await orchestrator.run(created.id); // resubmits for approval
    const second = (await orchestrator.pendingDecision(created.id))!;

    expect(second.kind).toBe("plan");
    expect(second.plan).toBe(first.plan);
    expect(second.id).not.toBe(first.id);
  });

  it("reports a failed step as a retry decision with only retry offered", async () => {
    const provider = new MockProvider("mock", (request) =>
      request.role === "architect" ? { status: "failure", error: { code: "BOOM", message: "architect exploded" } } : happyResponder(request)
    );
    const orchestrator = await build(provider);
    const created = await orchestrator.createTask("Add a feature");
    const failed = await orchestrator.analyze(created.id);
    expect(failed.workflowState).toBe("FAILED");

    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision).toMatchObject({ kind: "retry", options: ["retry"], previousState: "ANALYZING" });
    expect(decision.failure!.message).toContain("architect exploded");
    expect(decision.failure).toMatchObject({ state: "ANALYZING", role: "architect", providerId: "mock" });
  });

  it("takes option legality from the real workflow engine: a stuck record with no previous state offers nothing it cannot honour", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    const store = new TaskStore(join(dataDir, "tasks"));

    await store.save({ ...created, workflowState: "FAILED", previousState: undefined });
    expect(await orchestrator.pendingDecision(created.id)).toMatchObject({ kind: "retry", options: [] });

    await store.save({ ...created, workflowState: "PAUSED", previousState: undefined });
    expect(await orchestrator.pendingDecision(created.id)).toMatchObject({ kind: "resume", options: ["cancel"] });
  });

  it("reports an approval-gated verification command with its exact text, then a plain resume once it is approved", async () => {
    const marker = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const projectConfig: ProjectConfig = {
      name: "demo",
      roles: {},
      verification: {
        additionalChecks: [
          { id: "repo.deploy-check", description: "a repository-configured check", command: `touch "${marker}"`, requiredForReady: true }
        ],
        disable: []
      },
      review: { focusAreas: [], protocolSecurityReview: false },
      writeTaskSummaries: false
    };
    const orchestrator = await build(
      new MockProvider("mock", happyResponder),
      { approvals: { plan: false, security_review: true, final_merge: true } },
      projectConfig
    );

    const created = await orchestrator.createTask("Add a feature");
    const paused = await orchestrator.run(created.id);
    expect(paused.workflowState).toBe("PAUSED");
    expect(paused.pendingGate).toBeUndefined();

    const waiting = (await orchestrator.pendingDecision(created.id))!;
    expect(waiting).toMatchObject({ kind: "verification_approval", options: ["approve", "cancel"] });
    expect(waiting.checks).toHaveLength(1);
    expect(waiting.checks![0]).toMatchObject({ id: "repo.deploy-check", command: `touch "${marker}"` });

    await orchestrator.approveVerificationCommand(created.id, "repo.deploy-check", "tester");
    const resumable = (await orchestrator.pendingDecision(created.id))!;
    expect(resumable).toMatchObject({ kind: "resume", options: ["resume", "cancel"] });
    expect(resumable.id).not.toBe(waiting.id);

    await orchestrator.resume(created.id, "tester");
    expect(await orchestrator.pendingDecision(created.id)).toBeUndefined();
  });

  it("asks the real workflow engine about BOTH steps of a gate answer: a gate that paused from the wrong state offers only cancel", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    const store = new TaskStore(join(dataDir, "tasks"));
    await store.save({
      ...created,
      workflowState: "PAUSED",
      previousState: "TESTING",
      pendingGate: "security_review",
      pendingDecisionTrigger: "review_approved"
    });
    expect(await orchestrator.pendingDecision(created.id)).toMatchObject({
      kind: "gate",
      options: ["cancel"],
      approvalWithheld: "gate_transition_unavailable"
    });
  });

  it("acquires no task lock: it answers immediately while another process holds the lock, which refuses a mutating call", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const store = new TaskStore(join(dataDir, "tasks"));

    await store.withLock(created.id, async () => {
      // Control: the lock really is held — a mutating call cannot get it and gives up.
      await expect(orchestrator.cancel(created.id, "tester")).rejects.toThrow(/lock/i);
      const started = Date.now();
      const decision = await orchestrator.pendingDecision(created.id);
      expect(decision?.kind).toBe("plan");
      // Lock acquisition alone retries for about a second before refusing; a read must not wait on it.
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  it("writes nothing anywhere: no task record, lock, approval, log or repository file changes, for any decision kind", async () => {
    const marker = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const projectConfig: ProjectConfig = {
      name: "demo",
      roles: {},
      verification: {
        additionalChecks: [
          { id: "repo.deploy-check", description: "a repository-configured check", command: `touch "${marker}"`, requiredForReady: true }
        ],
        disable: []
      },
      review: { focusAreas: [], protocolSecurityReview: false },
      writeTaskSummaries: true
    };
    const orchestrator = await build(
      new MockProvider("mock", happyResponder),
      { approvals: { plan: false, security_review: true, final_merge: true } },
      projectConfig
    );
    const created = await orchestrator.createTask("Add a feature");
    const paused = await orchestrator.run(created.id);
    expect(paused.workflowState).toBe("PAUSED");

    const before = { data: snapshot(dataDir), repo: snapshot(repoDir) };
    const first = await orchestrator.pendingDecision(created.id);
    const second = await orchestrator.pendingDecision(created.id);
    expect(first?.kind).toBe("verification_approval");
    expect(second).toEqual(first);
    expect({ data: snapshot(dataDir), repo: snapshot(repoDir) }).toEqual(before);
    // The command itself was only ever displayed, never run.
    expect(() => statSync(marker)).toThrow();
  });
});
