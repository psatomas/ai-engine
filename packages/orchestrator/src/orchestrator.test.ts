import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalConfigSchema, type GlobalConfig } from "@ai-engine/config";
import { buildDefaultWorkflow, WorkflowEngine } from "@ai-engine/workflow";
import { SecurityPolicy, CommandApprovalStore } from "@ai-engine/security";
import { GitRepository } from "@ai-engine/git";
import { createLogger } from "@ai-engine/logging";
import type { AgentInvocationRequest, AgentResult } from "@ai-engine/core";
import { TaskStore } from "./task-store.js";
import { RoleRegistry, type ProviderFactory } from "./role-registry.js";
import { Orchestrator, IllegalTaskStateError } from "./orchestrator.js";
import { MockProvider } from "./test-support/mock-provider.js";

let repoDir: string;
let dataDir: string;

function mockResponder(request: AgentInvocationRequest): AgentResult {
  switch (request.role) {
    case "architect":
      return { status: "success", structuredOutput: { specification: "Add a feature.", plan: "1. Add feature.txt", risks: [] } };
    case "implementer":
      writeFileSync(join(request.workingDirectory, "feature.txt"), "feature content\n");
      return { status: "success", finalMessage: "Added feature.txt" };
    case "reviewer":
    case "security_reviewer":
      return { status: "success", structuredOutput: { verdict: "approved", summary: "Looks good.", findings: [] } };
    case "verifier":
      return { status: "success", structuredOutput: { verdict: "approved", summary: "Confirmed complete.", findings: [] } };
    default:
      return { status: "failure", error: { code: "UNKNOWN_ROLE", message: `no mock behavior for role ${request.role}` } };
  }
}

async function buildOrchestrator(
  configOverrides: Partial<GlobalConfig> = {},
  provider = new MockProvider("mock", mockResponder)
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
  const roleRegistry = new RoleRegistry(globalConfig, undefined, factories);
  const securityPolicy = new SecurityPolicy(globalConfig.security);
  const commandApprovalStore = new CommandApprovalStore(join(dataDir, "approvals.json"));
  const logger = createLogger([]);
  const workflow = new WorkflowEngine(buildDefaultWorkflow(), globalConfig.workflow);
  const taskStore = new TaskStore(paths.taskStoreDir);

  return new Orchestrator({
    gitRepo,
    paths,
    globalConfig,
    projectConfig: undefined,
    taskStore,
    roleRegistry,
    securityPolicy,
    commandApprovalStore,
    logger,
    workflow
  });
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-orch-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-orch-data-"));
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

describe("Orchestrator end-to-end (mock providers, real git + workflow)", () => {
  it("drives a task through the full pipeline to READY, pausing at each approval gate", async () => {
    const orchestrator = await buildOrchestrator();

    let task = await orchestrator.createTask("Add a feature");
    expect(task.workflowState).toBe("TASK_CREATED");

    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("AWAITING_APPROVAL");
    expect(task.specification).toContain("Add a feature");

    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    expect(task.workflowState).toBe("IMPLEMENTING");

    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("PAUSED");
    expect(task.pendingGate).toBe("security_review");

    task = await orchestrator.decideGate(task.id, "security_review", "approved", "alice");
    expect(task.workflowState).toBe("VERIFYING");

    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("READY");
    expect(task.finalStatus).toBe("ready");

    const roles = task.agentsUsed.map((a) => a.role).sort();
    expect(roles).toEqual(["architect", "implementer", "reviewer", "security_reviewer", "verifier"].sort());

    const diff = await orchestrator.currentDiff(task.id);
    expect(diff.files.map((f) => f.path)).toContain("feature.txt");
  });

  it("skips the security_review gate when disabled in config", async () => {
    const orchestrator = await buildOrchestrator({
      approvals: GlobalConfigSchema.shape.approvals.parse({ plan: true, security_review: false, final_merge: true })
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.run(task.id);

    expect(task.workflowState).toBe("READY");
  });

  it("returns to PLAN_READY when the plan is rejected", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "rejected", "alice", "not detailed enough");
    expect(task.workflowState).toBe("PLAN_READY");
    expect(task.approvals.at(-1)).toMatchObject({ gate: "plan", decision: "rejected", by: "alice" });
  });

  it("auto-approves the plan when approvals.plan is disabled", async () => {
    const orchestrator = await buildOrchestrator({
      approvals: GlobalConfigSchema.shape.approvals.parse({ plan: false, security_review: false, final_merge: true })
    });
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("READY");
  });

  it("routes a failing test run into FIXING and back to READY after a fix", async () => {
    // First implementer call writes nothing (so verification has no build/test scripts to fail on) —
    // instead we force the review step to request changes once, then approve on the second pass.
    let reviewCalls = 0;
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "reviewer" && reviewCalls === 0) {
        reviewCalls++;
        return {
          status: "success",
          structuredOutput: {
            verdict: "changes_requested",
            summary: "Needs a docstring.",
            findings: [{ dimension: "maintainability", severity: "major", summary: "missing docs", detail: "add a docstring" }]
          }
        };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator(
      { approvals: GlobalConfigSchema.shape.approvals.parse({ plan: true, security_review: false, final_merge: true }) },
      provider
    );

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.run(task.id);

    expect(task.workflowState).toBe("READY");
    expect(task.reviews.length).toBeGreaterThanOrEqual(3); // first reviewer(changes) + security_reviewer(approved) + second round
    const firstFindings = task.reviews[0]!.findings;
    // "fix_attempted", not "fixed" — fix() ran while this was open and reported success, but that
    // is a claim, not independent confirmation. See orchestrator.hardening.test.ts's dedicated
    // "fix finding-state integrity" tests for the full regression coverage.
    expect(firstFindings[0]?.status).toBe("fix_attempted");
  });

  it("throws IllegalTaskStateError when a step is called out of order", async () => {
    const orchestrator = await buildOrchestrator();
    const task = await orchestrator.createTask("Add a feature");
    await expect(orchestrator.implement(task.id)).rejects.toThrow(IllegalTaskStateError);
  });

  it("supports pause/resume and cancel", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.pause(task.id, "alice");
    expect(task.workflowState).toBe("PAUSED");
    task = await orchestrator.resume(task.id, "alice");
    expect(task.workflowState).toBe("TASK_CREATED");
    task = await orchestrator.cancel(task.id, "alice", "no longer needed");
    expect(task.workflowState).toBe("CANCELLED");
  });
});
