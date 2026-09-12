import { writeFileSync } from "node:fs";
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
import { Orchestrator, RoleRegistry, TaskStore, type ProviderFactory } from "@ai-engine/orchestrator";
import type { AgentInvocationRequest, AgentResult, AgentRun, Capability, ProviderAdapter, ProviderAvailability } from "@ai-engine/core";
import { runGuided, type GuidedIO } from "./guided.js";

/**
 * These tests exist specifically because a review of the mock-based tests in guided.test.ts
 * found them insufficient proof for blockers #1/#2: a mocked `GuidedOrchestrator.run()` can be
 * scripted to return whatever a test wants, including a transition (`BLOCKED` straight to
 * `READY`) the real workflow engine has no rule for at all. Only a REAL `Orchestrator` — real
 * git repo, real `WorkflowEngine`, real `CommandApprovalStore` — can actually prove that
 * `runGuided()` never routes an unapproved required verification check through the fixer, never
 * spends a `test_fix` iteration on it, never reaches `BLOCKED`, and correctly resumes through the
 * real state machine once approved. `@ai-engine/orchestrator`'s own MockProvider (used by
 * orchestrator.hardening.test.ts's identical-in-spirit C1 test) lives under that package's
 * private `test-support/`, not its public exports, and packages/cli correctly depends on
 * @ai-engine/orchestrator rather than the reverse — so this file defines its own minimal
 * equivalent below instead of reaching into another package's test internals.
 */

let repoDir: string;
let dataDir: string;

class MockProvider implements ProviderAdapter {
  public readonly displayName = "Mock Provider";
  public readonly invocations: Array<{ role: string; request: AgentInvocationRequest }> = [];

  constructor(
    public readonly id: string,
    private readonly responder: (request: AgentInvocationRequest) => AgentResult | Promise<AgentResult>
  ) {}

  capabilities(): Capability[] {
    return [
      "analyze",
      "plan",
      "implement",
      "review",
      "shell_execution",
      "file_modification",
      "streaming",
      "cancellation",
      "status",
      "resume",
      "structured_output"
    ];
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    return { available: true, authenticated: true, version: "mock" };
  }

  invoke(request: AgentInvocationRequest): AgentRun {
    this.invocations.push({ role: request.role, request });
    const resultPromise = Promise.resolve(this.responder(request));
    async function* events() {
      yield { type: "lifecycle" as const, phase: "started" as const, at: new Date().toISOString() };
      const response = await resultPromise;
      if (response.finalMessage) yield { type: "message" as const, channel: "assistant" as const, text: response.finalMessage };
      yield {
        type: "lifecycle" as const,
        phase: response.status === "success" ? ("completed" as const) : ("failed" as const),
        at: new Date().toISOString()
      };
    }
    return { events: events(), result: resultPromise, cancel: () => undefined };
  }
}

function mockResponder(request: AgentInvocationRequest): AgentResult {
  switch (request.role) {
    case "architect":
      return { status: "success", structuredOutput: { specification: "spec", plan: "plan", risks: [] } };
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

async function buildOrchestrator(projectConfig: ProjectConfig, provider: MockProvider): Promise<Orchestrator> {
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
  const globalConfig: GlobalConfig = GlobalConfigSchema.parse({
    roles: {
      architect: { providerId: "mock" },
      implementer: { providerId: "mock" },
      reviewer: { providerId: "mock" },
      security_reviewer: { providerId: "mock" },
      verifier: { providerId: "mock" }
    },
    // Plan approval is auto-approved (analyze() handles that internally, entirely before
    // run()'s dispatch loop ever stops) so the non-interactive test below can reach the
    // verification-approval pause purely automatically, with no human decision preceding it.
    approvals: { plan: false, security_review: true, final_merge: true }
  });
  const factories = new Map<string, ProviderFactory>([["mock", () => provider]]);
  const roleRegistry = new RoleRegistry(globalConfig, projectConfig, factories);
  const securityPolicy = new SecurityPolicy(globalConfig.security);
  const commandApprovalStore = new CommandApprovalStore(join(dataDir, "approvals.json"));
  const logger = createLogger([]);
  const workflow = new WorkflowEngine(buildDefaultWorkflow(), globalConfig.workflow);
  const taskStore = new TaskStore(paths.taskStoreDir);

  return new Orchestrator({
    gitRepo,
    paths,
    globalConfig,
    projectConfig,
    taskStore,
    roleRegistry,
    securityPolicy,
    commandApprovalStore,
    logger,
    workflow
  });
}

function projectConfigWithRequiredCheck(markerFile: string): ProjectConfig {
  return {
    name: "demo",
    roles: {},
    verification: {
      additionalChecks: [
        {
          id: "repo.deploy-check",
          description: "attacker- or maintainer-defined check",
          command: `touch "${markerFile}"`,
          requiredForReady: true
        }
      ],
      disable: []
    },
    review: { focusAreas: [], protocolSecurityReview: false },
    writeTaskSummaries: false
  };
}

/** Same shape as guided.test.ts's local fakeIO, duplicated rather than imported to keep this
 *  file (and its heavier real-orchestrator setup) independently readable. */
function fakeIO(answers: boolean[], isInteractive: boolean): { io: GuidedIO; lines: string[] } {
  const lines: string[] = [];
  let i = 0;
  const io: GuidedIO = {
    isInteractive,
    write(line = "") {
      lines.push(line);
    },
    async confirm() {
      if (i >= answers.length) throw new Error("fakeIO: confirm() called more times than scripted answers");
      return answers[i++]!;
    },
    async promptLine() {
      return "q";
    }
  };
  return { io, lines };
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-guided-va-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-guided-va-data-"));
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

describe("runGuided against a REAL Orchestrator — required verification approval (blockers #1 and #2)", () => {
  it("stops for approval BEFORE any fixer invocation, spends no test_fix iteration, and never reaches BLOCKED; non-interactive guidance names the exact task and check id", async () => {
    const markerFile = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const provider = new MockProvider("mock", mockResponder);
    const orchestrator = await buildOrchestrator(projectConfigWithRequiredCheck(markerFile), provider);

    const { io, lines } = fakeIO([], false); // non-interactive: no prompt should ever be reached
    const result = await runGuided(orchestrator, "Add a feature", io, "alice");

    expect(result.workflowState).toBe("PAUSED");
    expect(result.workflowState).not.toBe("BLOCKED");
    expect(result.pendingGate).toBeUndefined(); // never a manufactured decideGate()-style gate
    expect(result.iterationCounts.test_fix ?? 0).toBe(0); // no fix/test loop iteration consumed
    // implement() ran exactly once (IMPLEMENTING); fix() was never invoked for the pending approval.
    expect(provider.invocations.filter((i) => i.role === "implementer")).toHaveLength(1);

    const out = lines.join("\n");
    expect(out).toContain(result.id);
    expect(out).toContain("repo.deploy-check");
    expect(out).toContain(`ai checks ${result.id}`);
    expect(out).toContain(`ai approve-check ${result.id}`);
    expect(out).not.toMatch(/BLOCKED/);

    const fs = await import("node:fs/promises");
    await expect(fs.access(markerFile)).rejects.toThrow(); // the command genuinely never ran
  });

  it("interactive approval resumes through the real state machine, re-runs verification for real, and completes the task with exactly one approval record (no duplicate, no fixer)", async () => {
    const markerFile = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const provider = new MockProvider("mock", mockResponder);
    const orchestrator = await buildOrchestrator(projectConfigWithRequiredCheck(markerFile), provider);

    // plan approval is auto-approved by config (see buildOrchestrator) — approve the pending
    // check, then approve the security_review gate
    const { io } = fakeIO([true, true], true);
    const result = await runGuided(orchestrator, "Add a feature", io, "alice");

    expect(result.workflowState).toBe("READY");
    const fs = await import("node:fs/promises");
    await expect(fs.access(markerFile)).resolves.toBeUndefined(); // now it genuinely ran, once approved

    const checkApprovals = result.approvals.filter((a) => a.gate === "verification:repo.deploy-check");
    expect(checkApprovals).toHaveLength(1); // exactly one — never re-approved on the next loop iteration
    expect(provider.invocations.filter((i) => i.role === "implementer")).toHaveLength(1); // implement() only, fix() never ran
  });
});
