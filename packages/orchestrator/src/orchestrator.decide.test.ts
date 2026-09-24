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
import type { AgentInvocationRequest, AgentResult } from "@ai-engine/core";
import { TaskStore } from "./task-store.js";
import { RoleRegistry, type ProviderFactory } from "./role-registry.js";
import { DecisionApplicationError, Orchestrator, StaleDecisionError } from "./orchestrator.js";
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

async function buildFor(
  repo: string,
  provider: MockProvider,
  configOverrides: Partial<GlobalConfig> = {},
  projectConfig?: ProjectConfig
): Promise<Orchestrator> {
  const gitRepo = await GitRepository.discover(repo);
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

/** The default, single-repository harness every earlier test in this file uses. */
async function build(
  provider: MockProvider,
  configOverrides: Partial<GlobalConfig> = {},
  projectConfig?: ProjectConfig
): Promise<Orchestrator> {
  return buildFor(repoDir, provider, configOverrides, projectConfig);
}

async function initGitRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git.add(".");
  await git.commit("initial commit");
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-decide-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-decide-data-"));
  await initGitRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const verificationProjectConfig = (marker: string): ProjectConfig => ({
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
});

describe("Orchestrator.applyDecision — mapping actions onto the real APIs", () => {
  it('plan: approve maps to decidePlan("approved") and continues via run()', async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision.kind).toBe("plan");

    const applied = await orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester" });
    expect(applied.workflowState).toBe("IMPLEMENTING");
    expect(applied.approvals.at(-1)).toMatchObject({ gate: "plan", decision: "approved", by: "tester" });

    const finished = await orchestrator.run(created.id);
    expect(finished.workflowState).toBe("PAUSED"); // the security_review gate
  });

  it('plan: reject maps to decidePlan("rejected")', async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;

    const applied = await orchestrator.applyDecision(created.id, decision.id, "reject", { by: "tester" });
    expect(applied.workflowState).toBe("PLAN_READY");
    expect(applied.approvals.at(-1)).toMatchObject({ gate: "plan", decision: "rejected" });
  });

  it("plan: cancel maps to cancel()", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;

    const applied = await orchestrator.applyDecision(created.id, decision.id, "cancel", { by: "tester" });
    expect(applied.workflowState).toBe("CANCELLED");
  });

  it('gate: approve maps to decideGate(gate, "approved") using the LIVE gate name, never a client-supplied one', async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    await orchestrator.decidePlan(created.id, "approved", "tester");
    const paused = await orchestrator.run(created.id);
    expect(paused.workflowState).toBe("PAUSED");
    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision).toMatchObject({ kind: "gate", gate: "security_review" });

    const applied = await orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester" });
    expect(applied.workflowState).toBe("VERIFYING");
    expect(applied.pendingGate).toBeUndefined();
  });

  it('gate: reject maps to decideGate(gate, "rejected")', async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    await orchestrator.decidePlan(created.id, "approved", "tester");
    await orchestrator.run(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;

    const applied = await orchestrator.applyDecision(created.id, decision.id, "reject", { by: "tester" });
    expect(applied.workflowState).toBe("FIXING");
  });

  it("verification_approval: approve requires checkId, approves only that check, and does not itself resume", async () => {
    const marker = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const orchestrator = await build(
      new MockProvider("mock", happyResponder),
      { approvals: { plan: false, security_review: true, final_merge: true } },
      verificationProjectConfig(marker)
    );
    const created = await orchestrator.createTask("Add a feature");
    const paused = await orchestrator.run(created.id);
    expect(paused.workflowState).toBe("PAUSED");
    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision.kind).toBe("verification_approval");

    const applied = await orchestrator.applyDecision(created.id, decision.id, "approve", { checkId: "repo.deploy-check", by: "tester" });
    expect(applied.workflowState).toBe("PAUSED"); // approving a check does not itself resume
    expect(applied.approvals.at(-1)).toMatchObject({ gate: "verification:repo.deploy-check", decision: "approved" });

    const next = (await orchestrator.pendingDecision(created.id))!;
    expect(next.kind).toBe("resume"); // the one check is now approved; resuming is its own, separate decision
  });

  it("resume: resume maps to resume()", async () => {
    const marker = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const orchestrator = await build(
      new MockProvider("mock", happyResponder),
      { approvals: { plan: false, security_review: true, final_merge: true } },
      verificationProjectConfig(marker)
    );
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.run(created.id);
    await orchestrator.approveVerificationCommand(created.id, "repo.deploy-check", "tester");
    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision.kind).toBe("resume");

    const applied = await orchestrator.applyDecision(created.id, decision.id, "resume", { by: "tester" });
    expect(applied.workflowState).not.toBe("PAUSED");
  });

  it("retry: retry maps to retry()", async () => {
    const provider = new MockProvider("mock", (request) =>
      request.role === "architect" ? { status: "failure", error: { code: "BOOM", message: "architect exploded" } } : happyResponder(request)
    );
    const orchestrator = await build(provider);
    const created = await orchestrator.createTask("Add a feature");
    const failed = await orchestrator.analyze(created.id);
    expect(failed.workflowState).toBe("FAILED");
    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision.kind).toBe("retry");

    const applied = await orchestrator.applyDecision(created.id, decision.id, "retry", { by: "tester" });
    expect(applied.workflowState).toBe("ANALYZING");
  });
});

/** An out-of-band commit in the task's own worktree — nobody told the task store about it, exactly H4's own technique. */
async function outOfBandCommit(worktree: string, filename: string, message: string): Promise<void> {
  writeFileSync(join(worktree, filename), "diverged\n");
  const wtGit = simpleGit(worktree);
  await wtGit.add(".");
  await wtGit.commit(message);
}

describe("Orchestrator.applyDecision — git-state divergence is a real pending decision (Issue #9)", () => {
  it("B. a genuinely diverged task produces a divergence decision with the right shape, and none before divergence", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    expect(created.workflowState).toBe("TASK_CREATED");
    expect(await orchestrator.pendingDecision(created.id)).toBeUndefined(); // no decision before divergence

    const worktree = created.git.worktreePath!;
    writeFileSync(join(worktree, "out-of-band.txt"), "diverged\n");
    const wtGit = simpleGit(worktree);
    await wtGit.add(".");
    await wtGit.commit("out-of-band commit the orchestrator never recorded");

    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision.kind).toBe("divergence");
    expect(decision.options).toEqual(["approve", "cancel"]);
    expect(decision.id).toMatch(/^pd1_[a-f0-9]{32}$/);
    expect(decision.divergence?.expectedCommit).toBe(created.git.lastKnownCommit);
    expect(decision.divergence?.actualCommit).not.toBe(created.git.lastKnownCommit);
    expect(decision.untrusted).toEqual([]); // commit hashes only — nothing repository-authored

    const applied = await orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester" });
    // The decision disappears once acknowledged — the task is unstuck, still in TASK_CREATED, ready
    // for a normal next step (analyze), not a new pending decision.
    expect(applied.workflowState).toBe("TASK_CREATED");
    expect(await orchestrator.pendingDecision(created.id)).toBeUndefined();
  });

  it("C. approve routes through the real acknowledgeDivergence(), updating the real git baseline — not a mock or a duplicated transition", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    const worktree = created.git.worktreePath!;
    await outOfBandCommit(worktree, "out-of-band.txt", "out-of-band commit");
    const wtGit = simpleGit(worktree);
    const actualCommit = (await wtGit.revparse(["HEAD"])).trim();

    const decision = (await orchestrator.pendingDecision(created.id))!;
    const applied = await orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester", note: "reviewed, keeping it" });

    // The real acknowledgeDivergence() behavior: baseline updated to the actual commit, a
    // DIVERGENCE_ACKNOWLEDGED failure-log entry recorded, workflowState untouched.
    expect(applied.git.lastKnownCommit).toBe(actualCommit);
    expect(applied.failures.at(-1)).toMatchObject({ code: "DIVERGENCE_ACKNOWLEDGED" });
    expect(applied.workflowState).toBe("TASK_CREATED");
    // And the task genuinely proceeds normally afterward — not a permanently special state.
    const analyzed = await orchestrator.analyze(created.id);
    expect(analyzed.workflowState).not.toBe("FAILED");
  });

  it("D. cancel on a diverged task uses the existing cancel() path, exactly like every other decision kind", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await outOfBandCommit(created.git.worktreePath!, "out-of-band.txt", "out-of-band commit");
    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision.options).toContain("cancel");

    const applied = await orchestrator.applyDecision(created.id, decision.id, "cancel", { by: "tester" });
    expect(applied.workflowState).toBe("CANCELLED");
  });

  it("E. a stale divergence decisionId cannot acknowledge a newer divergence state", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    const worktree = created.git.worktreePath!;
    await outOfBandCommit(worktree, "first.txt", "first out-of-band commit");
    const stale = (await orchestrator.pendingDecision(created.id))!;

    // The repository state changes again before the stale decision is ever answered.
    await outOfBandCommit(worktree, "second.txt", "second out-of-band commit");
    const live = (await orchestrator.pendingDecision(created.id))!;
    expect(live.id).not.toBe(stale.id); // a materially different divergence, a different id
    expect(live.divergence?.actualCommit).not.toBe(stale.divergence?.actualCommit);

    await expect(orchestrator.applyDecision(created.id, stale.id, "approve", { by: "tester" })).rejects.toMatchObject({
      code: "STALE_DECISION"
    });
    // Fails closed: the baseline was never touched by the rejected, stale attempt.
    expect((await orchestrator.getTask(created.id))!.git.lastKnownCommit).toBe(created.git.lastKnownCommit);

    // The live one still works normally.
    const applied = await orchestrator.applyDecision(created.id, live.id, "approve", { by: "tester" });
    expect(applied.git.lastKnownCommit).toBe(live.divergence?.actualCommit);
  });
});

describe("Orchestrator.applyDecision — validation", () => {
  it("refuses an action absent from the live decision's own options", async () => {
    const provider = new MockProvider("mock", (request) =>
      request.role === "architect" ? { status: "failure", error: { code: "BOOM", message: "x" } } : happyResponder(request)
    );
    const orchestrator = await build(provider);
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id); // FAILED, only "retry" is legal
    const decision = (await orchestrator.pendingDecision(created.id))!;

    await expect(orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester" })).rejects.toMatchObject({
      name: "DecisionApplicationError",
      code: "ACTION_NOT_AVAILABLE"
    });
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("FAILED"); // nothing was applied
  });

  it("refuses a decisionId that does not match the live decision", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);

    await expect(orchestrator.applyDecision(created.id, "pd1_" + "0".repeat(32), "approve", { by: "tester" })).rejects.toMatchObject({
      name: "DecisionApplicationError",
      code: "STALE_DECISION"
    });
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("AWAITING_APPROVAL");
  });

  it("refuses a real but now-superseded decisionId: an earlier answer cannot apply to a newer decision", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const first = (await orchestrator.pendingDecision(created.id))!;

    await orchestrator.decidePlan(created.id, "rejected", "someone-else");
    await orchestrator.run(created.id); // resubmits for approval: a NEW plan decision, different id
    const second = (await orchestrator.pendingDecision(created.id))!;
    expect(second.id).not.toBe(first.id);

    await expect(orchestrator.applyDecision(created.id, first.id, "approve", { by: "tester" })).rejects.toMatchObject({
      code: "STALE_DECISION"
    });
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("AWAITING_APPROVAL"); // still the SECOND decision, untouched
    expect((await orchestrator.pendingDecision(created.id))!.id).toBe(second.id);
  });

  it("verification_approval: approve without checkId is refused, and nothing is approved", async () => {
    const marker = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const orchestrator = await build(
      new MockProvider("mock", happyResponder),
      { approvals: { plan: false, security_review: true, final_merge: true } },
      verificationProjectConfig(marker)
    );
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.run(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;
    const before = (await orchestrator.getTask(created.id))!.approvals;

    await expect(orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester" })).rejects.toMatchObject({
      code: "CHECK_ID_REQUIRED"
    });
    expect((await orchestrator.getTask(created.id))!.approvals).toEqual(before); // no new approval was recorded
  });

  it("verification_approval: an unknown/wrong checkId is refused, never falling back to the first pending check", async () => {
    const marker = join(repoDir, "SHOULD_NOT_EXIST_UNTIL_APPROVED");
    const projectConfig: ProjectConfig = {
      ...verificationProjectConfig(marker),
      verification: {
        additionalChecks: [
          { id: "repo.deploy-check", description: "d", command: `touch "${marker}"`, requiredForReady: true },
          { id: "repo.other-check", description: "d2", command: "true", requiredForReady: true }
        ],
        disable: []
      }
    };
    const orchestrator = await build(
      new MockProvider("mock", happyResponder),
      { approvals: { plan: false, security_review: true, final_merge: true } },
      projectConfig
    );
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.run(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;
    expect(decision.checks!.map((c) => c.id).sort()).toEqual(["repo.deploy-check", "repo.other-check"]);
    const before = (await orchestrator.getTask(created.id))!.approvals;

    await expect(
      orchestrator.applyDecision(created.id, decision.id, "approve", { checkId: "repo.no-such-check", by: "tester" })
    ).rejects.toMatchObject({ code: "CHECK_ID_INVALID" });
    expect((await orchestrator.getTask(created.id))!.approvals).toEqual(before); // no new approval was recorded
    // Confirm no silent fallback to the first check either.
    const after = (await orchestrator.pendingDecision(created.id))!;
    expect(after.checks!.map((c) => c.id).sort()).toEqual(["repo.deploy-check", "repo.other-check"]);
  });

  it("refuses a checkId supplied where it is not semantically valid, rather than silently ignoring it", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id); // a "plan" decision: checkId makes no sense here
    const decision = (await orchestrator.pendingDecision(created.id))!;

    await expect(
      orchestrator.applyDecision(created.id, decision.id, "approve", { checkId: "repo.deploy-check", by: "tester" })
    ).rejects.toMatchObject({ code: "CHECK_ID_NOT_APPLICABLE" });
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("AWAITING_APPROVAL");
  });

  it("StaleDecisionError and DecisionApplicationError are real, distinguishable error classes", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);

    try {
      await orchestrator.applyDecision(created.id, "pd1_" + "1".repeat(32), "approve", { by: "tester" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionApplicationError);
      expect(err).not.toBeInstanceOf(StaleDecisionError);
    }
  });
});

describe("expectedDecisionId — the authoritative, lock-protected revalidation", () => {
  it("decidePlan rejects a mismatched expectedDecisionId and applies nothing", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);

    await expect(orchestrator.decidePlan(created.id, "approved", "tester", undefined, "pd1_" + "2".repeat(32))).rejects.toBeInstanceOf(
      StaleDecisionError
    );
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("AWAITING_APPROVAL");
  });

  it("decidePlan applies normally when expectedDecisionId matches the live decision", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;

    const applied = await orchestrator.decidePlan(created.id, "approved", "tester", undefined, decision.id);
    expect(applied.workflowState).toBe("IMPLEMENTING");
  });

  it("every existing caller omitting expectedDecisionId is completely unaffected (backward compatibility)", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const applied = await orchestrator.decidePlan(created.id, "approved", "tester"); // exactly the pre-existing call shape
    expect(applied.workflowState).toBe("IMPLEMENTING");
  });

  it("protects against the MCP-check/worker-run race: a decision answered between validation and application is never double-applied", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const readEarly = (await orchestrator.pendingDecision(created.id))!; // simulates an MCP-side preflight read

    // Something else answers the SAME decision first (simulates a second, faster worker/caller).
    await orchestrator.applyDecision(created.id, readEarly.id, "reject", { by: "someone-else" });
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("PLAN_READY");

    // The (now stale) first read's answer must never apply, even though its decisionId was valid at read time.
    await expect(orchestrator.applyDecision(created.id, readEarly.id, "approve", { by: "tester" })).rejects.toMatchObject({
      code: "STALE_DECISION"
    });
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("PLAN_READY"); // the reject stands, untouched
  });
});

describe("Orchestrator.applyDecision — repository ownership is an intrinsic, authoritative invariant", () => {
  it("refuses a task whose stored repository is a different real repository, before applying anything or calling any decision method", async () => {
    const otherRepo = await mkdtemp(join(tmpdir(), "ai-engine-decide-other-"));
    try {
      await initGitRepo(otherRepo);
      // The task genuinely belongs to `otherRepo` — created there, by an orchestrator for that repo.
      const other = await buildFor(otherRepo, new MockProvider("mock", happyResponder));
      const created = await other.createTask("Add a feature");
      await other.analyze(created.id);
      const decision = (await other.pendingDecision(created.id))!;
      const before = await other.getTask(created.id);

      // A SECOND orchestrator, for a DIFFERENT repository, sharing the SAME task store (as the
      // worker's `createOrchestrator(repoRoot)` would for any taskId it is handed).
      const here = await build(new MockProvider("mock", happyResponder));
      await expect(here.applyDecision(created.id, decision.id, "approve", { by: "tester" })).rejects.toMatchObject({
        name: "DecisionApplicationError",
        code: "STALE_DECISION" // indistinguishable from a genuinely stale decision — no repository detail leaks
      });

      // Nothing changed: same workflow state, same history length, same approvals — no decision method ran.
      expect(await other.getTask(created.id)).toEqual(before);
      // And the SAME task, read from the repository it actually belongs to, is completely unaffected.
      expect((await other.pendingDecision(created.id))!.id).toBe(decision.id);
    } finally {
      await rm(otherRepo, { recursive: true, force: true });
    }
  });

  it("does not leak either repository's path in the refusal", async () => {
    const otherRepo = await mkdtemp(join(tmpdir(), "ai-engine-decide-other-"));
    try {
      await initGitRepo(otherRepo);
      const other = await buildFor(otherRepo, new MockProvider("mock", happyResponder));
      const created = await other.createTask("Add a feature");
      await other.analyze(created.id);
      const decision = (await other.pendingDecision(created.id))!;

      const here = await build(new MockProvider("mock", happyResponder));
      try {
        await here.applyDecision(created.id, decision.id, "approve", { by: "tester" });
        expect.unreachable();
      } catch (err) {
        const text = JSON.stringify({ message: (err as Error).message, code: (err as { code?: string }).code });
        expect(text).not.toContain(otherRepo);
        expect(text).not.toContain(repoDir);
      }
    } finally {
      await rm(otherRepo, { recursive: true, force: true });
    }
  });

  it("still refuses a stale/replayed decisionId for a task that genuinely belongs to this repository (unaffected by the new check)", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    await expect(orchestrator.applyDecision(created.id, "pd1_" + "0".repeat(32), "approve", { by: "tester" })).rejects.toMatchObject({
      code: "STALE_DECISION"
    });
    expect((await orchestrator.getTask(created.id))!.workflowState).toBe("AWAITING_APPROVAL");
  });

  it("a genuine same-repository continuation still succeeds normally", async () => {
    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;
    const applied = await orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester" });
    expect(applied.workflowState).toBe("IMPLEMENTING");
  });

  it("treats a canonically equivalent (symlinked) spelling of the same repository as the SAME repository, not a mismatch", async () => {
    const alias = join(dataDir, "repo-alias");
    const { symlink } = await import("node:fs/promises");
    await symlink(repoDir, alias);

    const orchestrator = await build(new MockProvider("mock", happyResponder));
    const created = await orchestrator.createTask("Add a feature");
    await orchestrator.analyze(created.id);
    const decision = (await orchestrator.pendingDecision(created.id))!;

    // The task's stored root is rewritten to the symlinked spelling — same real repository, different string.
    const store = new TaskStore(join(dataDir, "tasks"));
    const task = (await store.get(created.id))!;
    await store.save({ ...task, repository: { root: alias } });

    const applied = await orchestrator.applyDecision(created.id, decision.id, "approve", { by: "tester" });
    expect(applied.workflowState).toBe("IMPLEMENTING"); // not refused: realpath(alias) === realpath(repoDir)
  });

  it("calling applyDecision directly (bypassing any delegated-run/MCP plumbing entirely) still enforces the invariant", async () => {
    // No submitDelegatedContinuation, no worker, no MCP preflight anywhere in this test — a direct,
    // hypothetical internal caller of the authoritative method itself.
    const otherRepo = await mkdtemp(join(tmpdir(), "ai-engine-decide-direct-"));
    try {
      await initGitRepo(otherRepo);
      const other = await buildFor(otherRepo, new MockProvider("mock", happyResponder));
      const created = await other.createTask("Add a feature");
      await other.analyze(created.id);
      const decision = (await other.pendingDecision(created.id))!;

      const here = await build(new MockProvider("mock", happyResponder));
      await expect(here.applyDecision(created.id, decision.id, "cancel", { by: "direct-caller" })).rejects.toMatchObject({
        code: "STALE_DECISION"
      });
      expect((await other.getTask(created.id))!.workflowState).toBe("AWAITING_APPROVAL"); // not cancelled
    } finally {
      await rm(otherRepo, { recursive: true, force: true });
    }
  });
});
