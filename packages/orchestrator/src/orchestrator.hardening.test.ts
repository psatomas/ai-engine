import { writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalConfigSchema, type GlobalConfig, type ProjectConfig } from "@ai-engine/config";
import { buildDefaultWorkflow, WorkflowEngine } from "@ai-engine/workflow";
import { SecurityPolicy, CommandApprovalStore } from "@ai-engine/security";
import { GitRepository } from "@ai-engine/git";
import { createLogger } from "@ai-engine/logging";
import type { AgentInvocationRequest, AgentResult, TaskRecord } from "@ai-engine/core";
import { TaskStore } from "./task-store.js";
import { RoleRegistry, type ProviderFactory } from "./role-registry.js";
import {
  Orchestrator,
  EmptyRepositoryError,
  GitStateDivergedError,
  BudgetExceededError,
  WorkspaceConfinementError
} from "./orchestrator.js";
import { MockProvider } from "./test-support/mock-provider.js";

let repoDir: string;
let dataDir: string;

function mockResponder(request: AgentInvocationRequest): AgentResult {
  switch (request.role) {
    case "architect":
      return { status: "success", structuredOutput: { specification: "SPEC_MARKER_TEXT", plan: "PLAN_MARKER_TEXT", risks: [] } };
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
  opts: {
    configOverrides?: Partial<GlobalConfig>;
    provider?: MockProvider;
    projectConfig?: ProjectConfig;
    sharedDataDir?: string;
    /** Overrides the default single-"mock"-provider factory map, e.g. to register several distinct providers by id. */
    factories?: Map<string, ProviderFactory>;
  } = {}
): Promise<Orchestrator> {
  const provider = opts.provider ?? new MockProvider("mock", mockResponder);
  const thisDataDir = opts.sharedDataDir ?? dataDir;
  const gitRepo = await GitRepository.discover(repoDir);
  const paths = {
    configDir: thisDataDir,
    dataDir: thisDataDir,
    configFile: join(thisDataDir, "config.yaml"),
    taskStoreDir: join(thisDataDir, "tasks"),
    worktreesDir: join(thisDataDir, "worktrees"),
    logsDir: join(thisDataDir, "logs"),
    cacheDir: join(thisDataDir, "cache")
  };
  const globalConfig = GlobalConfigSchema.parse({
    roles: {
      architect: { providerId: "mock" },
      implementer: { providerId: "mock" },
      reviewer: { providerId: "mock" },
      security_reviewer: { providerId: "mock" },
      verifier: { providerId: "mock" }
    },
    ...opts.configOverrides
  });
  const factories = opts.factories ?? new Map<string, ProviderFactory>([["mock", () => provider]]);
  const roleRegistry = new RoleRegistry(globalConfig, opts.projectConfig, factories);
  const securityPolicy = new SecurityPolicy(globalConfig.security);
  const commandApprovalStore = new CommandApprovalStore(join(thisDataDir, "approvals.json"));
  const logger = createLogger([]);
  const workflow = new WorkflowEngine(buildDefaultWorkflow(), globalConfig.workflow);
  const taskStore = new TaskStore(paths.taskStoreDir);

  return new Orchestrator({
    gitRepo,
    paths,
    globalConfig,
    projectConfig: opts.projectConfig,
    taskStore,
    roleRegistry,
    securityPolicy,
    commandApprovalStore,
    logger,
    workflow
  });
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-hard-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-hard-data-"));
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

describe("H1: a PAUSED task can be cancelled through the full orchestrator, not just the state machine", () => {
  it("cancels a task paused on the security_review gate", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.run(task.id); // -> PAUSED, pendingGate security_review
    expect(task.workflowState).toBe("PAUSED");

    task = await orchestrator.cancel(task.id, "alice", "changed my mind");
    expect(task.workflowState).toBe("CANCELLED");
  });
});

describe("H2: a FAILED task is recoverable via retry(), not a permanent dead end", () => {
  it("retries a failed implementer step and completes the task", async () => {
    let implementCalls = 0;
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "implementer") {
        implementCalls++;
        if (implementCalls === 1) return { status: "failure", error: { code: "ECONNRESET", message: "transient network error" } };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({ provider });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id); // -> AWAITING_APPROVAL
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id); // fails
    expect(task.workflowState).toBe("FAILED");
    expect(task.failures.at(-1)?.message ?? task.history.at(-1)?.detail).toContain("transient network error");

    task = await orchestrator.retry(task.id, "alice", "retrying after transient error");
    expect(task.workflowState).toBe("IMPLEMENTING");
    expect(task.finalStatus).toBeUndefined();

    task = await orchestrator.run(task.id); // second implement call succeeds, pipeline continues
    // may pause on the security_review gate depending on config default (true) — drive it through
    if (task.workflowState === "PAUSED") task = await orchestrator.decideGate(task.id, "security_review", "approved", "alice");
    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("READY");
    expect(implementCalls).toBe(2);
  });

  it("retries a failed analyze() step (which pre-transitions before invoking) without getting stuck in ANALYZING", async () => {
    let architectCalls = 0;
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "architect") {
        architectCalls++;
        if (architectCalls === 1) return { status: "failure", error: { code: "TIMEOUT", message: "architect call timed out" } };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({ provider });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.analyze(task.id);
    expect(task.workflowState).toBe("FAILED");
    expect(task.previousState).toBe("ANALYZING");

    task = await orchestrator.retry(task.id, "alice");
    expect(task.workflowState).toBe("ANALYZING");

    // run() must know how to continue from ANALYZING, and analyze() must accept re-entry into it.
    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("AWAITING_APPROVAL");
    expect(architectCalls).toBe(2);
  });
});

describe("H3: a partially-failed review round never silently discards the reviewer that already succeeded", () => {
  it("keeps the first reviewer's report when the security_reviewer call fails", async () => {
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "security_reviewer") {
        return { status: "failure", error: { code: "RATE_LIMIT", message: "provider rate-limited" } };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({ provider });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id); // -> AWAITING_APPROVAL
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    expect(task.workflowState).toBe("REVIEWING");
    task = await orchestrator.review(task.id);

    // The reviewer role's report must be present even though the round overall failed.
    expect(task.workflowState).toBe("FAILED");
    expect(task.reviews).toHaveLength(1);
    expect(task.reviews[0]?.role).toBe("reviewer");
    expect(task.reviews[0]?.verdict).toBe("approved");

    // And the workflow is recoverable — retry re-enters REVIEWING and can complete.
    task = await orchestrator.retry(task.id, "alice");
    expect(task.workflowState).toBe("REVIEWING");
  });
});

describe("H4: git/task-state divergence is detected and blocks silent re-work until acknowledged", () => {
  it("throws GitStateDivergedError when the worktree changed without a matching persisted state, and recovers after acknowledgement", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    expect(task.workflowState).toBe("IMPLEMENTING");

    // Simulate a crash: something commits into the worktree (as implement() itself would after a
    // successful run) WITHOUT the corresponding TaskRecord ever being persisted — i.e. exactly the
    // "killed between commit and persist" window.
    const worktree = task.git.worktreePath!;
    writeFileSync(join(worktree, "out-of-band.txt"), "nobody told the task store about this\n");
    const wtGit = simpleGit(worktree);
    await wtGit.add(".");
    await wtGit.commit("out-of-band commit the orchestrator never recorded");

    await expect(orchestrator.implement(task.id)).rejects.toThrow(GitStateDivergedError);

    // Still stuck until acknowledged — a second attempt fails the same way, not silently proceeding.
    await expect(orchestrator.implement(task.id)).rejects.toThrow(GitStateDivergedError);

    task = await orchestrator.acknowledgeDivergence(task.id, "alice", "reviewed the out-of-band commit, keeping it");
    expect(task.failures.at(-1)?.code).toBe("DIVERGENCE_ACKNOWLEDGED");

    // Now a normal step proceeds.
    task = await orchestrator.implement(task.id);
    expect(task.workflowState).toBe("TESTING");
  });
});

describe("C1: repository-configured verification commands require explicit approval end-to-end", () => {
  it("pauses TESTING (never routes into FIXING) until the command is approved, spending no fixer invocation or test_fix iteration, then lets it through once approved and resumed", async () => {
    const markerFile = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const projectConfig: ProjectConfig = {
      name: "demo",
      roles: {},
      verification: {
        additionalChecks: [
          {
            id: "custom.marker",
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
    const provider = new MockProvider("mock", mockResponder);
    const orchestrator = await buildOrchestrator({ projectConfig, provider });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);

    // An unapproved required check is a pending human decision, not a code/test failure: it must
    // pause here, never route into FIXING (let alone escalate to BLOCKED) — see
    // Orchestrator.requiredChecksAwaitingApproval's doc comment. A second independent review
    // found an earlier version of this only detected/reacted to this situation from guided.ts,
    // *after* run() had already driven the task all the way through tests_failed -> FIXING ->
    // ... -> BLOCKED, which had already spent a real fixer invocation and a real test_fix
    // iteration on something the fixer has no authority to resolve.
    expect(task.workflowState).toBe("PAUSED");
    expect(task.workflowState).not.toBe("FIXING");
    expect(task.pendingGate).toBeUndefined(); // not a decideGate()-style gate — see guided.ts
    expect(task.iterationCounts.test_fix ?? 0).toBe(0); // no test_fix iteration consumed
    expect(provider.invocations.filter((i) => i.role === "implementer")).toHaveLength(1); // implement() only, fixer never ran

    const notApproved = task.verification.at(-1)?.results.find((r) => r.checkId === "custom.marker");
    expect(notApproved?.status).toBe("NOT_APPROVED");
    const fs = await import("node:fs/promises");
    await expect(fs.access(markerFile)).rejects.toThrow(); // the command never ran

    const checks = await orchestrator.listVerificationChecks(task.id);
    expect(checks.find((c) => c.id === "custom.marker")?.approved).toBe(false);

    const { command } = await orchestrator.approveVerificationCommand(task.id, "custom.marker", "alice", "reviewed, it's fine");
    expect(command).toContain("SHOULD_NOT_EXIST_UNTIL_APPROVED");

    const checksAfter = await orchestrator.listVerificationChecks(task.id);
    expect(checksAfter.find((c) => c.id === "custom.marker")?.approved).toBe(true);

    // resume() — not fix() — is the only legal continuation from a gate-less PAUSED task.
    task = await orchestrator.resume(task.id, "alice");
    expect(task.workflowState).toBe("TESTING");
    task = await orchestrator.test(task.id);
    expect(task.verification.at(-1)?.results.find((r) => r.checkId === "custom.marker")?.status).toBe("PASS");
    expect(task.workflowState).toBe("REVIEWING");
    await expect(fs.access(markerFile)).resolves.toBeUndefined(); // now it did run
    expect(provider.invocations.filter((i) => i.role === "implementer")).toHaveLength(1); // still just the one — fix() was never called
  });
});

describe("C1b: finalVerify() applies the identical approval boundary at VERIFYING", () => {
  it("pauses instead of routing into FIXING when a required check's approval is no longer current by final verification, and never invokes the verifier role for it", async () => {
    const markerFile = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_FINAL_APPROVAL");
    const projectConfig: ProjectConfig = {
      name: "demo",
      roles: {},
      verification: {
        additionalChecks: [
          {
            id: "custom.marker",
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
    const provider = new MockProvider("mock", mockResponder);
    const orchestrator = await buildOrchestrator({
      projectConfig,
      provider,
      configOverrides: { approvals: GlobalConfigSchema.shape.approvals.parse({ plan: false, security_review: false, final_merge: true }) }
    });

    let task = await orchestrator.createTask("Add a feature");
    // plan approval is auto-approved by config, so a single run() call drives all the way
    // through analyze/implement and stops at the first genuine stopping point: the pause.
    task = await orchestrator.run(task.id);
    expect(task.workflowState).toBe("PAUSED"); // unapproved — see C1 above

    await orchestrator.approveVerificationCommand(task.id, "custom.marker", "alice");
    task = await orchestrator.resume(task.id, "alice");
    task = await orchestrator.test(task.id); // approved now — runs for real, passes
    expect(task.workflowState).toBe("REVIEWING");
    task = await orchestrator.review(task.id); // security_review gate disabled -> straight through
    expect(task.workflowState).toBe("VERIFYING");

    // Simulate the approval no longer being current by the time of final verification (e.g. a
    // human revoked it, or a different machine performs final verification) — same store, same
    // file, a fresh independent instance so this test never reaches into Orchestrator internals.
    const approvalStore = new CommandApprovalStore(join(dataDir, "approvals.json"));
    // This check's cwd was never configured, so its canonical identity is "" (the worktree root)
    // regardless of which task's absolute worktree it actually ran in — see canonicalCwd().
    await approvalStore.revoke(`touch "${markerFile}"`, undefined, undefined);

    task = await orchestrator.finalVerify(task.id);

    expect(task.workflowState).toBe("PAUSED");
    expect(task.workflowState).not.toBe("FIXING");
    expect(task.iterationCounts.test_fix ?? 0).toBe(0);
    // The (costly, and ultimately pointless — its verdict would be discarded regardless) verifier
    // role invocation never happens for a pending-approval pause.
    expect(provider.invocations.filter((i) => i.role === "verifier")).toHaveLength(0);
  });
});

describe("C1c: an approval does not survive the SAME check's configured cwd changing to a different directory (Issue #3)", () => {
  it("proves the substitution attack is closed: approve command X at cwd A, retain X, change configured cwd to B — the old approval does not authorize execution at B", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repoDir, "package-a"), { recursive: true });
    mkdirSync(join(repoDir, "package-b"), { recursive: true });
    writeFileSync(join(repoDir, "package-a", ".gitkeep"), "");
    writeFileSync(join(repoDir, "package-b", ".gitkeep"), "");
    const git = simpleGit(repoDir);
    await git.add(".");
    await git.commit("add package-a and package-b");

    // A minimal orchestrator, just to create the task and learn its real worktree path — every
    // task's worktree mirrors the same committed layout, so package-a/package-b exist in it too.
    const bootstrap = await buildOrchestrator();
    let task = await bootstrap.createTask("Add a feature");
    const worktree = task.git.worktreePath!;
    const cwdA = join(worktree, "package-a");
    const cwdB = join(worktree, "package-b");
    const command = "touch RAN_HERE"; // same command text throughout — only cwd ever changes

    const configAtCwd = (cwd: string): ProjectConfig => ({
      name: "demo",
      roles: {},
      verification: {
        additionalChecks: [
          { id: "custom.marker", description: "runs somewhere repository-configured", command, cwd, requiredForReady: true }
        ],
        disable: []
      },
      review: { focusAreas: [], protocolSecurityReview: false },
      writeTaskSummaries: false
    });
    const approvalConfig = {
      approvals: GlobalConfigSchema.shape.approvals.parse({ plan: false, security_review: false, final_merge: true })
    };

    // Drive the SAME task to REVIEWING via an orchestrator configured for cwd A, approving there.
    const orchestratorA = await buildOrchestrator({ projectConfig: configAtCwd(cwdA), configOverrides: approvalConfig });
    task = await orchestratorA.run(task.id); // plan auto-approved by config -> drives straight to the TESTING pause
    expect(task.workflowState).toBe("PAUSED"); // NOT_APPROVED at cwd A — nothing has run yet
    await orchestratorA.approveVerificationCommand(task.id, "custom.marker", "alice", "reviewed at package-a");
    task = await orchestratorA.resume(task.id, "alice");
    task = await orchestratorA.test(task.id);
    expect(task.verification.at(-1)?.results.find((r) => r.checkId === "custom.marker")?.status).toBe("PASS");
    task = await orchestratorA.review(task.id); // security_review disabled -> straight to VERIFYING
    expect(task.workflowState).toBe("VERIFYING");

    const fs = await import("node:fs/promises");
    await expect(fs.access(join(cwdA, "RAN_HERE"))).resolves.toBeUndefined(); // it genuinely ran, at A
    await expect(fs.access(join(cwdB, "RAN_HERE"))).rejects.toThrow(); // never at B

    // The repository's configuration changes: the SAME check id and command, but cwd now points at
    // B — exactly the reproduction from the investigation. No new approval is granted anywhere.
    const orchestratorB = await buildOrchestrator({ projectConfig: configAtCwd(cwdB), configOverrides: approvalConfig });
    task = await orchestratorB.finalVerify(task.id);

    // The old approval (granted for A) must not authorize this — same pause behavior as C1b, not a
    // silent PASS and not a route into FIXING.
    expect(task.workflowState).toBe("PAUSED");
    expect(task.workflowState).not.toBe("FIXING");
    expect(task.verification.at(-1)?.results.find((r) => r.checkId === "custom.marker")?.status).toBe("NOT_APPROVED");
    const checks = await orchestratorB.listVerificationChecks(task.id);
    expect(checks.find((c) => c.id === "custom.marker")?.approved).toBe(false);

    // The proof: it never actually executed at B under the stale approval.
    await expect(fs.access(join(cwdB, "RAN_HERE"))).rejects.toThrow();
    // The original run at A is untouched.
    await expect(fs.access(join(cwdA, "RAN_HERE"))).resolves.toBeUndefined();

    // A fresh, explicit approval at B is still possible and still works normally.
    await orchestratorB.approveVerificationCommand(task.id, "custom.marker", "alice", "reviewed at package-b too");
    task = await orchestratorB.resume(task.id, "alice");
    expect(task.workflowState).toBe("VERIFYING");
    task = await orchestratorB.finalVerify(task.id);
    expect(task.verification.at(-1)?.results.find((r) => r.checkId === "custom.marker")?.status).toBe("PASS");
    await expect(fs.access(join(cwdB, "RAN_HERE"))).resolves.toBeUndefined();
  });
});

describe("C2: cross-process locking prevents two independent Orchestrator instances from racing the same task", () => {
  it("a second instance cannot mutate a task while the first is mid-step", async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (resolveFirst = resolve));
    const slowProvider = new MockProvider("mock", async (request) => {
      if (request.role === "architect") {
        await gate; // hold the lock open until the test releases it
      }
      return mockResponder(request);
    });

    const orchestratorA = await buildOrchestrator({ provider: slowProvider, sharedDataDir: dataDir });
    const orchestratorB = await buildOrchestrator({ provider: slowProvider, sharedDataDir: dataDir });

    const task = await orchestratorA.createTask("Add a feature");
    const slowAnalyze = orchestratorA.analyze(task.id); // acquires the lock, then awaits `gate`

    // Give A's call a moment to actually acquire the lock before B races it.
    await new Promise((r) => setTimeout(r, 30));
    await expect(orchestratorB.pause(task.id, "bob")).rejects.toThrow(/locked/i);

    resolveFirst?.();
    const finished = await slowAnalyze;
    expect(finished.workflowState).toBe("AWAITING_APPROVAL");

    // Now that A released the lock, B can act.
    const paused = await orchestratorB.pause(task.id, "bob");
    expect(paused.workflowState).toBe("PAUSED");
  });
});

describe("C4: agent-generated content keeps its provenance instead of laundering into unlabeled instructions", () => {
  it("the implementer's request carries specification/plan as labelled context, never in raw instructions", async () => {
    const provider = new MockProvider("mock", mockResponder);
    const orchestrator = await buildOrchestrator({ provider });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    await orchestrator.implement(task.id);

    const implementCall = provider.invocations.find((i) => i.role === "implementer");
    expect(implementCall).toBeTruthy();
    // The marker text produced by the architect must NOT appear in the raw instructions string...
    expect(implementCall!.request.instructions).not.toContain("SPEC_MARKER_TEXT");
    expect(implementCall!.request.instructions).not.toContain("PLAN_MARKER_TEXT");
    // ...it must appear in a context block explicitly labelled agent_generated instead.
    const specBlock = implementCall!.request.context.find((b) => b.content.includes("SPEC_MARKER_TEXT"));
    expect(specBlock?.trust).toBe("agent_generated");
    const planBlock = implementCall!.request.context.find((b) => b.content.includes("PLAN_MARKER_TEXT"));
    expect(planBlock?.trust).toBe("agent_generated");
  });

  it("review findings and verification output reaching fix() are labelled command_output/agent_generated, not raw instructions", async () => {
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "reviewer") {
        return {
          status: "success",
          structuredOutput: {
            verdict: "changes_requested",
            summary: "needs work",
            findings: [{ dimension: "correctness", severity: "major", summary: "FINDING_MARKER_TEXT", detail: "detail text" }]
          }
        };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({
      provider,
      configOverrides: { approvals: GlobalConfigSchema.shape.approvals.parse({ plan: true, security_review: false, final_merge: true }) }
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    expect(task.workflowState).toBe("FIXING");
    await orchestrator.fix(task.id);

    const fixCall = provider.invocations.filter((i) => i.role === "implementer").at(-1);
    expect(fixCall!.request.instructions).not.toContain("FINDING_MARKER_TEXT");
    const findingBlock = fixCall!.request.context.find((b) => b.content.includes("FINDING_MARKER_TEXT"));
    expect(findingBlock?.trust).toBe("agent_generated");
  });
});

describe("Budget enforcement actually blocks further invocations", () => {
  it("refuses to invoke a role again once maxInvocationsPerRolePerTask is reached", async () => {
    let architectCalls = 0;
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "architect") {
        architectCalls++;
        if (architectCalls === 1) return { status: "failure", error: { code: "TIMEOUT", message: "timed out" } };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({
      provider,
      configOverrides: { budgets: { maxInvocationsPerRolePerTask: { architect: 1 } } }
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.analyze(task.id); // 1st architect call: fails, count -> 1
    expect(task.workflowState).toBe("FAILED");
    task = await orchestrator.retry(task.id, "alice"); // -> ANALYZING

    await expect(orchestrator.analyze(task.id)).rejects.toThrow(BudgetExceededError);
  });

  it("accumulates reported cost across invocations and refuses once the per-task cap is reached", async () => {
    const provider = new MockProvider("mock", (request) => {
      const base = mockResponder(request);
      return { ...base, usage: { costUsd: 0.6 } };
    });
    const orchestrator = await buildOrchestrator({
      provider,
      configOverrides: { budgets: { maxCostUsdPerTask: 1, maxInvocationsPerRolePerTask: {} } }
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.analyze(task.id); // architect call reports $0.60 -> total $0.60, still under $1
    expect(task.workflowState).toBe("AWAITING_APPROVAL");
    expect(task.usage.totalCostUsd).toBeCloseTo(0.6);

    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id); // allowed: 0.6 < 1 before this call starts; total becomes $1.20
    expect(task.usage.totalCostUsd).toBeCloseTo(1.2);
    task = await orchestrator.test(task.id); // pure verification, no role invocation, no budget check

    // Now at/over the cap — the next role invocation (reviewer) must be refused before it runs.
    await expect(orchestrator.review(task.id)).rejects.toThrow(BudgetExceededError);
  });
});

describe("Empty repository is handled with a clear error, not a raw git failure", () => {
  it("throws EmptyRepositoryError instead of a raw GitError when there are no commits yet", async () => {
    const emptyRepoDir = await mkdtemp(join(tmpdir(), "ai-engine-empty-repo-"));
    try {
      await simpleGit(emptyRepoDir).init(["--initial-branch=main"]);
      const gitRepo = await GitRepository.discover(emptyRepoDir);
      const paths = {
        configDir: dataDir,
        dataDir,
        configFile: join(dataDir, "config.yaml"),
        taskStoreDir: join(dataDir, "tasks"),
        worktreesDir: join(dataDir, "worktrees"),
        logsDir: join(dataDir, "logs"),
        cacheDir: join(dataDir, "cache")
      };
      const globalConfig = GlobalConfigSchema.parse({});
      const roleRegistry = new RoleRegistry(globalConfig, undefined, new Map([["mock", () => new MockProvider("mock", mockResponder)]]));
      const orchestrator = new Orchestrator({
        gitRepo,
        paths,
        globalConfig,
        projectConfig: undefined,
        taskStore: new TaskStore(paths.taskStoreDir),
        roleRegistry,
        securityPolicy: new SecurityPolicy(globalConfig.security),
        commandApprovalStore: new CommandApprovalStore(join(dataDir, "approvals2.json")),
        logger: createLogger([]),
        workflow: new WorkflowEngine(buildDefaultWorkflow(), globalConfig.workflow)
      });

      await expect(orchestrator.createTask("do something")).rejects.toThrow(EmptyRepositoryError);
    } finally {
      await rm(emptyRepoDir, { recursive: true, force: true });
    }
  });
});

/**
 * Regression coverage for a real end-to-end finding: a fix() pass that only actually addressed
 * one of two open findings still left the workflow record claiming both were resolved, because
 * the old behavior unconditionally marked every then-open finding "fixed" once fix() reported
 * overall success. The record should never claim more certainty than the system actually has —
 * see the doc comment on Orchestrator.fix() and ReviewFinding.status in @ai-engine/core.
 */
describe("Fix finding-state integrity", () => {
  it('fix() marks findings that were open "fix_attempted", never "fixed" — "fixed" is not a claim this system can make', async () => {
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "reviewer") {
        return {
          status: "success",
          structuredOutput: {
            verdict: "changes_requested",
            summary: "needs work",
            findings: [{ dimension: "correctness", severity: "major", summary: "bug", detail: "detail" }]
          }
        };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({
      provider,
      configOverrides: { approvals: GlobalConfigSchema.shape.approvals.parse({ plan: true, security_review: false, final_merge: true }) }
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    expect(task.workflowState).toBe("FIXING");

    task = await orchestrator.fix(task.id);

    const findingStatuses = task.reviews.flatMap((r) => r.findings).map((f) => f.status);
    expect(findingStatuses).toContain("fix_attempted");
    expect(findingStatuses).not.toContain("fixed");
  });

  it("numbers every open finding and tells the implementer explicitly to address all of them, not just the first", async () => {
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "reviewer") {
        return {
          status: "success",
          structuredOutput: {
            verdict: "changes_requested",
            summary: "two issues",
            findings: [
              { dimension: "correctness", severity: "major", summary: "FINDING_ONE", detail: "first issue" },
              { dimension: "scope", severity: "major", summary: "FINDING_TWO", detail: "second issue" }
            ]
          }
        };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({
      provider,
      configOverrides: { approvals: GlobalConfigSchema.shape.approvals.parse({ plan: true, security_review: false, final_merge: true }) }
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    expect(task.workflowState).toBe("FIXING");

    await orchestrator.fix(task.id);

    const fixCall = provider.invocations.filter((i) => i.role === "implementer").at(-1)!;
    expect(fixCall.request.instructions).toMatch(/2 separate open findings/);
    const findingsBlock = fixCall.request.context.find((b) => b.content.includes("FINDING_ONE"));
    expect(findingsBlock?.label).toMatch(/2 total/);
    expect(findingsBlock?.content).toContain("1/2.");
    expect(findingsBlock?.content).toContain("2/2.");
  });

  /**
   * The actual real-world scenario, reproduced end-to-end: fix() runs and optimistically marks a
   * finding "fix_attempted" even though the implementer here does not really address it (the mock
   * makes no change related to the finding, matching what a real agent that silently skips a
   * finding looks like from the workflow's perspective). The genuine safety net is the next review
   * round: it re-examines the situation from scratch and reports a fresh "open" finding for the
   * same underlying issue, completely independent of the stale "fix_attempted" mark on the old
   * finding object — and that fresh "open" finding, not the old record, is what
   * hasBlockingOpenFindings actually gates on. This is what a real Codex review pass did in
   * practice when a Claude fix() pass left a finding unaddressed.
   */
  it("a finding left unaddressed by fix() is independently re-caught as a fresh open finding by the next review round", async () => {
    let reviewRound = 0;
    const provider = new MockProvider("mock", (request) => {
      if (request.role === "reviewer") {
        reviewRound++;
        // Both rounds report the exact same unresolved issue — simulating a fix() pass that
        // didn't actually change anything relevant.
        return {
          status: "success",
          structuredOutput: {
            verdict: "changes_requested",
            summary: `round ${reviewRound}`,
            findings: [{ dimension: "correctness", severity: "major", summary: "STILL_BROKEN", detail: "still not fixed" }]
          }
        };
      }
      if (request.role === "security_reviewer") {
        return { status: "success", structuredOutput: { verdict: "approved", summary: "no security concerns", findings: [] } };
      }
      return mockResponder(request);
    });
    const orchestrator = await buildOrchestrator({
      provider,
      configOverrides: { approvals: GlobalConfigSchema.shape.approvals.parse({ plan: true, security_review: false, final_merge: true }) }
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);

    task = await orchestrator.review(task.id); // round 1: reviewer reports STILL_BROKEN (open)
    expect(task.workflowState).toBe("FIXING");
    task = await orchestrator.fix(task.id); // marks it fix_attempted; does not really fix anything
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id); // round 2: reviewer reports STILL_BROKEN again, fresh

    // Still blocked — the second round's fresh finding is what matters, not the first round's
    // now-stale "fix_attempted" one. (task.reviews interleaves reviewer/security_reviewer reports
    // in call order, so pick the reviewer role's latest report specifically rather than assuming
    // it's last.)
    expect(task.workflowState).toBe("FIXING");
    const secondRoundFindings = task.reviews.filter((r) => r.role === "reviewer").at(-1)!.findings;
    expect(secondRoundFindings.some((f) => f.summary === "STILL_BROKEN" && f.status === "open")).toBe(true);
  });
});

describe("checkPath is genuinely wired into request building", () => {
  it("refuses to build a request when the worktree path has been replaced by a symlink escaping known roots", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");

    const outside = await mkdtemp(join(tmpdir(), "ai-engine-outside-"));
    try {
      const worktree = task.git.worktreePath!;
      await rm(worktree, { recursive: true, force: true });
      await symlink(outside, worktree, "dir");

      await expect(orchestrator.implement(task.id)).rejects.toThrow(WorkspaceConfinementError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("H5: a resume session is never handed to a different provider than the one that created it", () => {
  it("does not leak provider A's session id to provider B after the implementer role's provider assignment changes mid-task", async () => {
    const providerA = new MockProvider("providerA", (request) => {
      if (request.role === "reviewer" || request.role === "security_reviewer") {
        return {
          status: "success",
          structuredOutput: {
            verdict: "changes_requested",
            summary: "needs work",
            findings: [{ dimension: "correctness", severity: "major", summary: "bug", detail: "detail" }]
          }
        };
      }
      if (request.role === "implementer") {
        return { status: "success", finalMessage: "Added feature.txt", providerSessionId: "providerA-session-123" };
      }
      return mockResponder(request);
    });
    const providerB = new MockProvider("providerB", () => ({ status: "success", finalMessage: "Fixed" }));

    const sharedDataDir = dataDir;
    const orchestrator1 = await buildOrchestrator({
      sharedDataDir,
      factories: new Map<string, ProviderFactory>([
        ["providerA", () => providerA],
        ["providerB", () => providerB]
      ]),
      configOverrides: {
        roles: {
          architect: { providerId: "providerA" },
          implementer: { providerId: "providerA" },
          reviewer: { providerId: "providerA" },
          security_reviewer: { providerId: "providerA" },
          verifier: { providerId: "providerA" }
        }
      }
    });

    let task = await orchestrator1.createTask("Add a feature");
    task = await orchestrator1.run(task.id);
    task = await orchestrator1.decidePlan(task.id, "approved", "alice");
    task = await orchestrator1.implement(task.id);
    task = await orchestrator1.test(task.id);
    task = await orchestrator1.review(task.id);
    expect(task.workflowState).toBe("FIXING");
    expect(task.providerSessions.implementer).toEqual({ providerId: "providerA", sessionId: "providerA-session-123" });

    // Simulates the implementer role's provider assignment changing between invocations of the
    // same task (an edited config, a project override introduced mid-task, ...): a second
    // Orchestrator sharing the same data dir whose RoleRegistry resolves "implementer" to a
    // completely different provider.
    const orchestrator2 = await buildOrchestrator({
      sharedDataDir,
      factories: new Map<string, ProviderFactory>([
        ["providerA", () => providerA],
        ["providerB", () => providerB]
      ]),
      configOverrides: { roles: { implementer: { providerId: "providerB" } } }
    });

    task = await orchestrator2.fix(task.id);

    expect(providerB.invocations).toHaveLength(1);
    expect(providerB.invocations[0]!.request.resumeSessionId).toBeUndefined();
    // providerA's own recorded session is untouched by the switch, and providerB's own (absent)
    // result leaves it that way — providerSessions must never end up attributing providerA's
    // session id to providerB, or vice versa.
    expect(task.providerSessions.implementer).toEqual({ providerId: "providerA", sessionId: "providerA-session-123" });
  });
});

describe("H5 (persistence): legacy or malformed provider sessions on disk are normalized on load — never trusted, never a crash", () => {
  // Persists `providerSessions` exactly as given — bypassing the type system on purpose, since these
  // are shapes an older version, an external edit, or corruption could have left on disk — and hands
  // back an Orchestrator whose store reads it (the real TaskStore.get() normalization path).
  async function persistWithSessions(providerSessions: unknown): Promise<{ orchestrator: Orchestrator; taskId: string }> {
    const orchestrator = await buildOrchestrator();
    const created = await orchestrator.createTask("Add a feature");
    await new TaskStore(join(dataDir, "tasks")).save({ ...created, providerSessions } as unknown as TaskRecord);
    return { orchestrator, taskId: created.id };
  }

  it("drops a legacy bare-string session (its creating provider is unknowable) and keeps a valid { providerId, sessionId } entry", async () => {
    const { orchestrator, taskId } = await persistWithSessions({
      implementer: "legacy-bare-session-id",
      reviewer: { providerId: "codex", sessionId: "reviewer-session-1" }
    });

    const reloaded = await orchestrator.getTask(taskId);
    expect(reloaded?.providerSessions).toEqual({ reviewer: { providerId: "codex", sessionId: "reviewer-session-1" } });
  });

  it("leaves a fully valid set of sessions untouched", async () => {
    const sessions = {
      implementer: { providerId: "claude", sessionId: "implementer-session-1" },
      reviewer: { providerId: "codex", sessionId: "reviewer-session-1" }
    };
    const { orchestrator, taskId } = await persistWithSessions(sessions);

    expect((await orchestrator.getTask(taskId))?.providerSessions).toEqual(sessions);
  });

  it("drops malformed or junk entries (null, a number, an empty string, arrays, an object missing providerId or sessionId) and keeps only the valid one", async () => {
    const { orchestrator, taskId } = await persistWithSessions({
      a: null,
      b: 7,
      c: "",
      d: { providerId: "claude" },
      e: { sessionId: "orphan-session" },
      g: [],
      h: ["claude", "array-session"],
      f: { providerId: "claude", sessionId: "valid-session" }
    });

    expect((await orchestrator.getTask(taskId))?.providerSessions).toEqual({ f: { providerId: "claude", sessionId: "valid-session" } });
  });

  it("drops entries whose providerId or sessionId is not a non-empty string — values are never coerced", async () => {
    const { orchestrator, taskId } = await persistWithSessions({
      numericSession: { providerId: "claude", sessionId: 123 },
      numericProvider: { providerId: 123, sessionId: "abc" },
      emptyProvider: { providerId: "", sessionId: "abc" },
      emptySession: { providerId: "claude", sessionId: "" },
      nullSession: { providerId: "claude", sessionId: null },
      valid: { providerId: "claude", sessionId: "valid-session" }
    });

    expect((await orchestrator.getTask(taskId))?.providerSessions).toEqual({ valid: { providerId: "claude", sessionId: "valid-session" } });
  });

  it.each([
    ["missing", undefined],
    ["null", null]
  ])("tolerates a %s providerSessions map: loads as an empty map and the next invocation still runs", async (_label, persisted) => {
    const { orchestrator, taskId } = await persistWithSessions(persisted);

    expect((await orchestrator.getTask(taskId))?.providerSessions).toEqual({});

    // buildRequest reads task.providerSessions[role] — a missing map must not turn into a TypeError there.
    const task = await orchestrator.run(taskId);
    expect(task.workflowState).toBe("AWAITING_APPROVAL");
  });
});

describe("H6: a cumulative-usage baseline is never handed to a different provider than the one that created it", () => {
  it("does not leak provider A's cumulative usage baseline to provider B after the implementer role's provider assignment changes mid-task", async () => {
    const providerA = new MockProvider("providerA", (request) => {
      if (request.role === "reviewer" || request.role === "security_reviewer") {
        return {
          status: "success",
          structuredOutput: {
            verdict: "changes_requested",
            summary: "needs work",
            findings: [{ dimension: "correctness", severity: "major", summary: "bug", detail: "detail" }]
          }
        };
      }
      if (request.role === "implementer") {
        return {
          status: "success",
          finalMessage: "Added feature.txt",
          providerSessionId: "providerA-session-123",
          usage: { inputTokens: 100 },
          cumulativeUsageBaseline: { inputTokens: 100 }
        };
      }
      return mockResponder(request);
    });
    const providerB = new MockProvider("providerB", () => ({ status: "success", finalMessage: "Fixed" }));

    const sharedDataDir = dataDir;
    const orchestrator1 = await buildOrchestrator({
      sharedDataDir,
      factories: new Map<string, ProviderFactory>([
        ["providerA", () => providerA],
        ["providerB", () => providerB]
      ]),
      configOverrides: {
        roles: {
          architect: { providerId: "providerA" },
          implementer: { providerId: "providerA" },
          reviewer: { providerId: "providerA" },
          security_reviewer: { providerId: "providerA" },
          verifier: { providerId: "providerA" }
        }
      }
    });

    let task = await orchestrator1.createTask("Add a feature");
    task = await orchestrator1.run(task.id);
    task = await orchestrator1.decidePlan(task.id, "approved", "alice");
    task = await orchestrator1.implement(task.id);
    task = await orchestrator1.test(task.id);
    task = await orchestrator1.review(task.id);
    expect(task.workflowState).toBe("FIXING");
    expect(task.providerSessions.implementer).toEqual({
      providerId: "providerA",
      sessionId: "providerA-session-123",
      cumulativeUsageBaseline: { inputTokens: 100 }
    });

    // Simulates the implementer role's provider assignment changing between invocations of the
    // same task, exactly like H5 — but this time asserting the cumulative-usage baseline (not
    // just the resume session id) is never carried across the switch.
    const orchestrator2 = await buildOrchestrator({
      sharedDataDir,
      factories: new Map<string, ProviderFactory>([
        ["providerA", () => providerA],
        ["providerB", () => providerB]
      ]),
      configOverrides: { roles: { implementer: { providerId: "providerB" } } }
    });

    task = await orchestrator2.fix(task.id);

    expect(providerB.invocations).toHaveLength(1);
    expect(providerB.invocations[0]!.request.resumeSessionId).toBeUndefined();
    // The core Finding 2 isolation requirement: providerB must never receive providerA's baseline.
    expect(providerB.invocations[0]!.request.previousCumulativeUsage).toBeUndefined();
    // providerA's own recorded session+baseline are untouched by the switch (providerB's result
    // carries no providerSessionId, so providerSessions is left exactly as it was).
    expect(task.providerSessions.implementer).toEqual({
      providerId: "providerA",
      sessionId: "providerA-session-123",
      cumulativeUsageBaseline: { inputTokens: 100 }
    });
  });
});

describe("C1d: a relative repository-configured cwd is approved and executed under the same identity (Issue #5)", () => {
  it("approves under canonicalCwd's repository-relative identity (Issue #3), then genuinely executes inside the corresponding directory of the task's own worktree — never wherever this test process happens to be running from", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repoDir, "packages", "foo"), { recursive: true });
    writeFileSync(join(repoDir, "packages", "foo", ".gitkeep"), "");
    const git = simpleGit(repoDir);
    await git.add(".");
    await git.commit("add packages/foo");

    const projectConfig: ProjectConfig = {
      name: "demo",
      roles: {},
      verification: {
        additionalChecks: [
          {
            id: "custom.marker",
            description: "runs inside packages/foo",
            // A relative cwd, exactly as a repository author would plausibly write it — this test's
            // own process.cwd() is wherever `npm test` was invoked from (this repository's own
            // checkout), which is never the task's worktree, so this exercises the real defect
            // scenario without any explicit process.chdir() gymnastics.
            command: "touch RAN_HERE",
            cwd: "packages/foo",
            requiredForReady: true
          }
        ],
        disable: []
      },
      review: { focusAreas: [], protocolSecurityReview: false },
      writeTaskSummaries: false
    };
    const orchestrator = await buildOrchestrator({
      projectConfig,
      configOverrides: { approvals: GlobalConfigSchema.shape.approvals.parse({ plan: false, security_review: false, final_merge: true }) }
    });

    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id); // plan auto-approved by config -> drives straight to the TESTING pause
    expect(task.workflowState).toBe("PAUSED"); // NOT_APPROVED — nothing has run yet

    // Approval goes through canonicalCwd's repository-relative identity (Issue #3) — never the
    // task's absolute, transient worktree path.
    const approval = await orchestrator.approveVerificationCommand(task.id, "custom.marker", "alice", "reviewed");
    expect(approval.cwd).toBe("packages/foo");

    task = await orchestrator.resume(task.id, "alice");
    task = await orchestrator.test(task.id);

    expect(task.verification.at(-1)?.results.find((r) => r.checkId === "custom.marker")?.status).toBe("PASS");
    // The proof: it genuinely executed inside packages/foo of THIS task's own worktree — a
    // completely different absolute path from this test process's own cwd — not merely that
    // containment allowed it in the abstract.
    const fs = await import("node:fs/promises");
    await expect(fs.access(join(task.git.worktreePath!, "packages", "foo", "RAN_HERE"))).resolves.toBeUndefined();
  });
});
