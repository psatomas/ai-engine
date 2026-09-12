import { describe, expect, it, vi } from "vitest";
import type { DiffSummary } from "@ai-engine/git";
import type { ReviewFinding, ReviewReport, TaskRecord, VerificationCheck, WorkflowState } from "@ai-engine/core";
import { runGuided, createRealIO, NonInteractiveApprovalRequiredError, type GuidedIO, type GuidedOrchestrator } from "./guided.js";

// ---- fixtures ---------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "t-test-0001",
    repository: { root: "/repo" },
    workspaceFolder: "/repo",
    originalRequest: "Fix ModuleRegistry.removeModule and add regression tests",
    workflowState: "TASK_CREATED",
    agentsUsed: [],
    git: {
      branch: "main",
      commit: "abc123def456",
      worktreePath: "/data/worktrees/t-test-0001",
      taskBranch: "ai/t-test-0001",
      dirtyAtStart: false,
      untrackedAtStart: []
    },
    verification: [],
    reviews: [],
    approvals: [],
    history: [],
    failures: [],
    iterationCounts: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    providerSessions: {},
    usage: {},
    roleInvocationCounts: {},
    ...overrides
  };
}

function review(role: string, verdict: "approved" | "changes_requested", findings: ReviewFinding[] = []): ReviewReport {
  return {
    id: `r-${role}`,
    taskId: "t-test-0001",
    role,
    providerId: "mock",
    createdAt: "2026-01-01T00:00:00.000Z",
    verdict,
    summary: "summary",
    findings
  };
}

function check(overrides: Partial<VerificationCheck & { approved: boolean }>): VerificationCheck & { approved: boolean } {
  return {
    id: "npm.test",
    description: "npm test",
    command: "npm test",
    requiredForReady: true,
    origin: "auto_detected",
    approved: true,
    ...overrides
  };
}

interface RunStep {
  from: WorkflowState;
  task: TaskRecord;
}

interface RunCallScript {
  steps: RunStep[];
  final: TaskRecord;
}

interface MockScript {
  initialTask: TaskRecord;
  runs: RunCallScript[];
  decidePlanResults?: TaskRecord[];
  decideGateResults?: TaskRecord[];
  retryResults?: TaskRecord[];
  resumeResults?: TaskRecord[];
  diff?: DiffSummary;
  providers?: Record<string, string>;
  /** Keyed by taskId call order — simplest is one shared list, since these tests only ever have one task in flight. */
  verificationChecks?: Array<VerificationCheck & { approved: boolean }>;
}

interface Recorded {
  runCalls: number;
  decidePlanCalls: Array<{ decision: string }>;
  decideGateCalls: Array<{ gate: string; decision: string }>;
  retryCalls: number;
  resumeCalls: number;
  approveVerificationCommandCalls: Array<{ checkId: string }>;
}

function makeMockOrchestrator(script: MockScript): { orchestrator: GuidedOrchestrator; recorded: Recorded } {
  let runIdx = 0;
  let planIdx = 0;
  let gateIdx = 0;
  let retryIdx = 0;
  let resumeIdx = 0;
  const recorded: Recorded = {
    runCalls: 0,
    decidePlanCalls: [],
    decideGateCalls: [],
    retryCalls: 0,
    resumeCalls: 0,
    approveVerificationCommandCalls: []
  };

  const orchestrator: GuidedOrchestrator = {
    async createTask() {
      return script.initialTask;
    },
    async run(_taskId, opts) {
      const call = script.runs[runIdx++];
      if (!call) throw new Error("mock orchestrator: run() called more times than scripted");
      for (const step of call.steps) {
        opts?.onBeforeStep?.(step.from);
        opts?.onAfterStep?.(step.from, step.task);
      }
      recorded.runCalls++;
      return call.final;
    },
    async decidePlan(_taskId, decision) {
      recorded.decidePlanCalls.push({ decision });
      const t = script.decidePlanResults?.[planIdx++];
      if (!t) throw new Error("mock orchestrator: decidePlan() called more times than scripted");
      return t;
    },
    async decideGate(_taskId, gate, decision) {
      recorded.decideGateCalls.push({ gate, decision });
      const t = script.decideGateResults?.[gateIdx++];
      if (!t) throw new Error("mock orchestrator: decideGate() called more times than scripted");
      return t;
    },
    async retry() {
      recorded.retryCalls++;
      const t = script.retryResults?.[retryIdx++];
      if (!t) throw new Error("mock orchestrator: retry() called more times than scripted");
      return t;
    },
    async resume() {
      recorded.resumeCalls++;
      const t = script.resumeResults?.[resumeIdx++];
      if (!t) throw new Error("mock orchestrator: resume() called more times than scripted");
      return t;
    },
    async currentDiff() {
      return script.diff ?? { files: [], raw: "", suspiciousFiles: [] };
    },
    providerIdForRole(role) {
      return script.providers?.[role] ?? "mock";
    },
    async listVerificationChecks() {
      return script.verificationChecks ?? [];
    },
    async approveVerificationCommand(_taskId, checkId) {
      recorded.approveVerificationCommandCalls.push({ checkId });
      return { command: "npm test" };
    }
  };

  return { orchestrator, recorded };
}

/**
 * `isInteractive` now defaults to `true` — with `requireInteractiveConfirmation` enforcing
 * interactivity inside guided mode itself (see Finding #3), a fake that claims to be
 * interactive is what actually exercises the approval flows under test. The one dedicated test
 * for non-interactive refusal below sets `isInteractive: false` explicitly, with a `confirm`
 * that would (wrongly) return `true` if ever reached, to prove guided mode never calls it.
 * `promptLine` (used only by the optional READY "Next actions" menu) defaults to returning "q"
 * immediately so that menu never blocks a test that reaches READY.
 */
function fakeIO(
  answers: boolean[],
  opts: { isInteractive?: boolean; promptLineAnswers?: string[] } = {}
): { io: GuidedIO; lines: string[] } {
  const lines: string[] = [];
  let i = 0;
  let p = 0;
  const promptLineAnswers = opts.promptLineAnswers ?? ["q"];
  const io: GuidedIO = {
    isInteractive: opts.isInteractive ?? true,
    write(line = "") {
      lines.push(line);
    },
    async confirm() {
      if (i >= answers.length) throw new Error("fakeIO: confirm() called more times than scripted answers");
      return answers[i++]!;
    },
    async promptLine() {
      return promptLineAnswers[Math.min(p++, promptLineAnswers.length - 1)] ?? "q";
    }
  };
  return { io, lines };
}

// ---- tests ------------------------------------------------------------------

describe("runGuided", () => {
  it("1-6: creates a task, advances automatically to plan approval, approves, advances through implement/test/review to the security_review gate, approves it, advances to READY with a completion summary", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const awaitingApproval = makeTask({ workflowState: "AWAITING_APPROVAL", plan: "1. Fix removeModule\n2. Add tests" });
    const implementing = makeTask({ workflowState: "IMPLEMENTING" });
    const paused = makeTask({
      workflowState: "PAUSED",
      pendingGate: "security_review",
      reviews: [review("reviewer", "approved"), review("security_reviewer", "approved")]
    });
    const verifying = makeTask({ workflowState: "VERIFYING" });
    const ready = makeTask({ workflowState: "READY" });

    const { orchestrator, recorded } = makeMockOrchestrator({
      initialTask: initial,
      runs: [
        { steps: [{ from: "TASK_CREATED", task: awaitingApproval }], final: awaitingApproval },
        {
          steps: [
            { from: "IMPLEMENTING", task: makeTask({ workflowState: "TESTING" }) },
            { from: "TESTING", task: makeTask({ workflowState: "REVIEWING" }) },
            { from: "REVIEWING", task: paused }
          ],
          final: paused
        },
        { steps: [{ from: "VERIFYING", task: ready }], final: ready }
      ],
      decidePlanResults: [implementing],
      decideGateResults: [verifying],
      diff: {
        files: [{ path: "packages/contracts/src/registry/ModuleRegistry.sol", status: "M", suspicious: false }],
        raw: "diff --git ...",
        suspiciousFiles: []
      }
    });

    const { io, lines } = fakeIO([true, true]); // approve plan, approve security review
    const result = await runGuided(orchestrator, "Fix ModuleRegistry.removeModule and add regression tests", io);

    expect(result.workflowState).toBe("READY");
    expect(recorded.decidePlanCalls).toEqual([{ decision: "approved" }]);
    expect(recorded.decideGateCalls).toEqual([{ gate: "security_review", decision: "approved" }]);

    const out = lines.join("\n");
    expect(out).toContain("PLAN READY");
    expect(out).toContain("✓ Plan approved");
    expect(out).toContain("✓ Security review approved");
    expect(out).toContain("✓ READY");
    expect(out).toContain("packages/contracts/src/registry/ModuleRegistry.sol");
    expect(out).toContain("Branch:");
    expect(out).toContain("Worktree:");
  });

  it("7: plan rejection calls decidePlan with 'rejected' (existing rejection semantics, not a new mechanism)", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const awaitingApproval = makeTask({ workflowState: "AWAITING_APPROVAL", plan: "a plan" });
    const backToPlanning = makeTask({ workflowState: "PLAN_READY" });
    const cancelled = makeTask({ workflowState: "CANCELLED" });

    const { orchestrator, recorded } = makeMockOrchestrator({
      initialTask: initial,
      runs: [
        { steps: [{ from: "TASK_CREATED", task: awaitingApproval }], final: awaitingApproval },
        { steps: [], final: cancelled }
      ],
      decidePlanResults: [backToPlanning]
    });

    const { io, lines } = fakeIO([false]); // reject
    const result = await runGuided(orchestrator, "request", io);

    expect(recorded.decidePlanCalls).toEqual([{ decision: "rejected" }]);
    expect(result.workflowState).toBe("CANCELLED");
    expect(lines.join("\n")).toContain("Plan rejected");
  });

  it("8: security-review rejection calls decideGate with 'rejected'", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const paused = makeTask({
      workflowState: "PAUSED",
      pendingGate: "security_review",
      reviews: [review("reviewer", "approved"), review("security_reviewer", "approved")]
    });
    const backToFixing = makeTask({ workflowState: "FIXING" });
    const cancelled = makeTask({ workflowState: "CANCELLED" });

    const { orchestrator, recorded } = makeMockOrchestrator({
      initialTask: initial,
      runs: [
        { steps: [{ from: "TASK_CREATED", task: paused }], final: paused },
        { steps: [], final: cancelled }
      ],
      decideGateResults: [backToFixing]
    });

    const { io, lines } = fakeIO([false]); // reject security review
    const result = await runGuided(orchestrator, "request", io);

    expect(recorded.decideGateCalls).toEqual([{ gate: "security_review", decision: "rejected" }]);
    expect(result.workflowState).toBe("CANCELLED");
    expect(lines.join("\n")).toContain("Security review rejected");
  });

  it("9a: a FAILED task offers retry, and retry() is called when the user accepts", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const failed = makeTask({
      workflowState: "FAILED",
      failures: [{ at: "2026-01-01T00:00:00.000Z", state: "IMPLEMENTING", message: "provider timed out" }]
    });
    const ready = makeTask({ workflowState: "READY" });

    const { orchestrator, recorded } = makeMockOrchestrator({
      initialTask: initial,
      runs: [
        { steps: [{ from: "TASK_CREATED", task: failed }], final: failed },
        { steps: [{ from: "VERIFYING", task: ready }], final: ready }
      ],
      retryResults: [makeTask({ workflowState: "IMPLEMENTING" })]
    });

    const { io, lines } = fakeIO([true]); // retry
    const result = await runGuided(orchestrator, "request", io);

    expect(recorded.retryCalls).toBe(1);
    expect(result.workflowState).toBe("READY");
    expect(lines.join("\n")).toContain("provider timed out");
  });

  it("9b: declining retry on a FAILED task stops immediately without calling retry()", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const failed = makeTask({
      workflowState: "FAILED",
      failures: [{ at: "2026-01-01T00:00:00.000Z", state: "IMPLEMENTING", message: "boom" }]
    });

    const { orchestrator, recorded } = makeMockOrchestrator({
      initialTask: initial,
      runs: [{ steps: [{ from: "TASK_CREATED", task: failed }], final: failed }]
    });

    const { io } = fakeIO([false]); // decline retry
    const result = await runGuided(orchestrator, "request", io);

    expect(recorded.retryCalls).toBe(0);
    expect(result.workflowState).toBe("FAILED");
  });

  it("BLOCKED explains and stops without looping or prompting, and never suggests `ai retry` (illegal from BLOCKED)", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const blocked = makeTask({
      workflowState: "BLOCKED",
      failures: [{ at: "2026-01-01T00:00:00.000Z", state: "FIXING", message: "exceeded max iterations", code: "MAX_ITERATIONS" }]
    });

    const { orchestrator } = makeMockOrchestrator({
      initialTask: initial,
      runs: [{ steps: [{ from: "TASK_CREATED", task: blocked }], final: blocked }]
    });

    const { io, lines } = fakeIO([]); // no prompts should occur at all
    const result = await runGuided(orchestrator, "request", io);

    expect(result.workflowState).toBe("BLOCKED");
    const out = lines.join("\n");
    expect(out).toContain("BLOCKED");
    expect(out).toContain("exceeded max iterations");
    expect(out).toContain(`ai resume ${initial.id}`);
    expect(out).toContain(`ai cancel ${initial.id}`);
    expect(out).not.toMatch(/ai retry/);
  });

  it("10: non-interactive stdin can never silently approve — createRealIO refuses to confirm", async () => {
    const originalIsTTY = process.stdin.isTTY;
    // Simulating a piped/non-terminal stdin for this one assertion.
    process.stdin.isTTY = false;
    try {
      const io = createRealIO();
      expect(io.isInteractive).toBe(false);
      await expect(io.confirm("Approve this plan?", true)).rejects.toThrow(NonInteractiveApprovalRequiredError);
    } finally {
      process.stdin.isTTY = originalIsTTY;
    }
  });

  it("10b: a GuidedIO that reports isInteractive === false is refused by guided mode itself, even if its own confirm() would return true", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const awaitingApproval = makeTask({ workflowState: "AWAITING_APPROVAL", plan: "a plan" });

    const { orchestrator } = makeMockOrchestrator({
      initialTask: initial,
      runs: [{ steps: [{ from: "TASK_CREATED", task: awaitingApproval }], final: awaitingApproval }]
    });

    // A deliberately "misbehaving" GuidedIO: isInteractive is false, but confirm() would still
    // happily return true if ever called. Proves enforcement lives in guided mode itself
    // (requireInteractiveConfirmation), not just in a well-behaved GuidedIO implementation.
    let confirmWasCalled = false;
    const io: GuidedIO = {
      isInteractive: false,
      write() {},
      async confirm() {
        confirmWasCalled = true;
        return true;
      },
      async promptLine() {
        return "q";
      }
    };

    await expect(runGuided(orchestrator, "request", io)).rejects.toThrow(NonInteractiveApprovalRequiredError);
    expect(confirmWasCalled).toBe(false);
  });

  it("11: provider labels in progress narration come from providerIdForRole, never a hardcoded name", async () => {
    const initial = makeTask({ workflowState: "TASK_CREATED" });
    const awaitingApproval = makeTask({ workflowState: "AWAITING_APPROVAL", plan: "a plan" });

    const { orchestrator } = makeMockOrchestrator({
      initialTask: initial,
      runs: [
        { steps: [{ from: "TASK_CREATED", task: awaitingApproval }], final: awaitingApproval },
        { steps: [], final: makeTask({ workflowState: "CANCELLED" }) }
      ],
      decidePlanResults: [makeTask({ workflowState: "CANCELLED" })],
      // Deliberately the *reverse* of the "obvious" hardcoded guess, to prove the labels are
      // not just "Claude" for architect / "Codex" for implementer by coincidence.
      providers: { architect: "codex", implementer: "claude", reviewer: "codex", security_reviewer: "codex", verifier: "codex" }
    });

    const { io, lines } = fakeIO([false]);
    await runGuided(orchestrator, "request", io);

    const out = lines.join("\n");
    expect(out).toContain("Codex is analyzing the repository...");
    expect(out).not.toContain("Claude is analyzing");
  });

  it("12: the user is never asked to provide or re-enter the task id after ai start", async () => {
    const initial = makeTask({ id: "t-opaque-id-xyz", workflowState: "TASK_CREATED" });
    const ready = makeTask({ id: "t-opaque-id-xyz", workflowState: "READY" });
    const createTask = vi.fn(async () => initial);

    const { orchestrator } = makeMockOrchestrator({
      initialTask: initial,
      runs: [{ steps: [], final: ready }]
    });
    orchestrator.createTask = createTask;

    const { io } = fakeIO([]);
    await runGuided(orchestrator, "some request", io);

    // createTask is called exactly once, with only the request text — never a task id supplied
    // by the caller, since none exists yet; every subsequent call in runGuided threads the id
    // through internally (task.id captured from createTask's own return value).
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith("some request");
  });

  describe("Finding 1: an unapproved required verification check must never be routed into FIXING/BLOCKED as if code were broken", () => {
    it("stops guided progression and shows the exact ai checks / ai approve-check guidance when non-interactive", async () => {
      const initial = makeTask({ workflowState: "TASK_CREATED" });
      // Orchestrator.test()/finalVerify() now pause (a gate-less PAUSED, exactly like a manual
      // `ai pause`) for exactly this situation, before ever applying tests_failed/verified_fail —
      // see their doc comments — so the real orchestrator never reaches FIXING/BLOCKED over this
      // in the first place. Guided mode's job here is purely to recognize it from the persisted
      // verification report and narrate it accurately, not to make it stop.
      const pausedForApproval = makeTask({
        workflowState: "PAUSED",
        verification: [
          {
            taskId: "t-test-0001",
            createdAt: "2026-01-01T00:00:00.000Z",
            results: [{ checkId: "repo.deploy-check", status: "NOT_APPROVED", durationMs: 0, reason: "not yet approved" }]
          }
        ]
      });

      const { orchestrator, recorded } = makeMockOrchestrator({
        initialTask: initial,
        runs: [{ steps: [{ from: "TASK_CREATED", task: pausedForApproval }], final: pausedForApproval }],
        verificationChecks: [
          check({ id: "repo.deploy-check", description: "deploy check", command: "./deploy.sh", requiredForReady: true, approved: false })
        ]
      });

      const { io, lines } = fakeIO([], { isInteractive: false });
      const result = await runGuided(orchestrator, "request", io);

      const out = lines.join("\n");
      expect(out).toContain("not an implementation problem");
      expect(out).toContain("repo.deploy-check");
      expect(out).toContain(`ai checks ${initial.id}`);
      expect(out).toContain(`ai approve-check ${initial.id}`);
      // Never presented as a code/implementation failure or a BLOCKED explanation:
      expect(out).not.toMatch(/BLOCKED/);
      // Guided mode stopped here — it never tried to drive the task any further, and never
      // resumed anything (there was nothing approved to resume for).
      expect(recorded.runCalls).toBe(1);
      expect(recorded.resumeCalls).toBe(0);
      expect(result).toBe(pausedForApproval);
    });

    it("a NOT_APPROVED check that is NOT requiredForReady is not treated as blocking (normal PAUSED/security_review handling proceeds)", async () => {
      const initial = makeTask({ workflowState: "TASK_CREATED" });
      const paused = makeTask({
        workflowState: "PAUSED",
        pendingGate: "security_review",
        reviews: [review("reviewer", "approved"), review("security_reviewer", "approved")],
        verification: [
          {
            taskId: "t-test-0001",
            createdAt: "2026-01-01T00:00:00.000Z",
            results: [{ checkId: "optional.check", status: "NOT_APPROVED", durationMs: 0 }]
          }
        ]
      });

      const { orchestrator, recorded } = makeMockOrchestrator({
        initialTask: initial,
        runs: [
          { steps: [{ from: "TASK_CREATED", task: paused }], final: paused },
          { steps: [{ from: "VERIFYING", task: makeTask({ workflowState: "READY" }) }], final: makeTask({ workflowState: "READY" }) }
        ],
        decideGateResults: [makeTask({ workflowState: "VERIFYING" })],
        verificationChecks: [check({ id: "optional.check", requiredForReady: false, approved: false })]
      });

      const { io } = fakeIO([true]);
      const result = await runGuided(orchestrator, "request", io);

      // The non-required NOT_APPROVED result never triggered guided mode's interception — the
      // normal PAUSED + security_review handling ran, exactly as if that result weren't there,
      // and the task proceeded all the way to READY.
      expect(recorded.decideGateCalls).toEqual([{ gate: "security_review", decision: "approved" }]);
      expect(result.workflowState).toBe("READY");
    });

    it("interactively offers to approve the required check now, via the existing approveVerificationCommand API, resumes (the only legal continuation from a gate-less PAUSED), and continues once approved", async () => {
      const initial = makeTask({ workflowState: "TASK_CREATED" });
      const pausedForApproval = makeTask({
        workflowState: "PAUSED",
        verification: [
          {
            taskId: "t-test-0001",
            createdAt: "2026-01-01T00:00:00.000Z",
            results: [{ checkId: "repo.deploy-check", status: "NOT_APPROVED", durationMs: 0 }]
          }
        ]
      });
      const resumedToTesting = makeTask({ workflowState: "TESTING" });
      const ready = makeTask({ workflowState: "READY" });

      const { orchestrator, recorded } = makeMockOrchestrator({
        initialTask: initial,
        runs: [
          { steps: [{ from: "TASK_CREATED", task: pausedForApproval }], final: pausedForApproval },
          { steps: [{ from: "TESTING", task: ready }], final: ready }
        ],
        resumeResults: [resumedToTesting],
        verificationChecks: [check({ id: "repo.deploy-check", command: "./deploy.sh", requiredForReady: true, approved: false })]
      });

      const { io } = fakeIO([true]); // approve the check now
      const result = await runGuided(orchestrator, "request", io);

      expect(recorded.approveVerificationCommandCalls).toEqual([{ checkId: "repo.deploy-check" }]);
      // run() itself never advances a PAUSED task on its own (by design) — resume() is what makes
      // the next run() call meaningful. A third independent review found a previous version of
      // this skipped straight to a second run() call, relying on a mock that could (unlike the
      // real workflow engine) pretend that jumped BLOCKED straight to READY.
      expect(recorded.resumeCalls).toBe(1);
      expect(recorded.runCalls).toBe(2); // guided mode re-ran after resuming, exactly like any other continuation
      expect(result.workflowState).toBe("READY");
    });

    it("Finding 2 regression: a required check the approval store already reports approved is never re-flagged, re-prompted, or re-approved, even though the historical report still says NOT_APPROVED", async () => {
      const initial = makeTask({ workflowState: "TASK_CREATED" });
      const paused = makeTask({
        workflowState: "PAUSED",
        pendingGate: "security_review",
        reviews: [review("reviewer", "approved"), review("security_reviewer", "approved")],
        verification: [
          {
            taskId: "t-test-0001",
            createdAt: "2026-01-01T00:00:00.000Z",
            // Stale/historical result — this report entry never changes retroactively once
            // written, even after a human approves the check. Only the CURRENT approval-store
            // state (reflected in `verificationChecks` below as `approved: true`) may be trusted.
            results: [{ checkId: "repo.deploy-check", status: "NOT_APPROVED", durationMs: 0, reason: "stale historical result" }]
          }
        ]
      });

      const { orchestrator, recorded } = makeMockOrchestrator({
        initialTask: initial,
        runs: [
          { steps: [{ from: "TASK_CREATED", task: paused }], final: paused },
          { steps: [{ from: "VERIFYING", task: makeTask({ workflowState: "READY" }) }], final: makeTask({ workflowState: "READY" }) }
        ],
        decideGateResults: [makeTask({ workflowState: "VERIFYING" })],
        verificationChecks: [check({ id: "repo.deploy-check", requiredForReady: true, approved: true })] // already approved
      });

      const { io } = fakeIO([true]); // approve the (unrelated) security_review gate
      const result = await runGuided(orchestrator, "request", io);

      // Never re-flagged, so the security_review PAUSED handling ran normally instead — exactly
      // as if the stale NOT_APPROVED result weren't there at all.
      expect(recorded.approveVerificationCommandCalls).toEqual([]);
      expect(recorded.resumeCalls).toBe(0);
      expect(recorded.decideGateCalls).toEqual([{ gate: "security_review", decision: "approved" }]);
      expect(result.workflowState).toBe("READY");
    });
  });

  describe("Finding 2: a manually paused task (PAUSED with no pendingGate) must not be treated as a gate", () => {
    it("does not call decideGate, and offers resume as the only mutating action", async () => {
      const initial = makeTask({ workflowState: "TASK_CREATED" });
      const manuallyPaused = makeTask({ workflowState: "PAUSED", pendingGate: undefined });
      const resumed = makeTask({ workflowState: "READY" });

      const { orchestrator, recorded } = makeMockOrchestrator({
        initialTask: initial,
        runs: [
          { steps: [{ from: "TASK_CREATED", task: manuallyPaused }], final: manuallyPaused },
          { steps: [{ from: "VERIFYING", task: resumed }], final: resumed }
        ],
        resumeResults: [makeTask({ workflowState: "TASK_CREATED" })]
      });

      const { io, lines } = fakeIO([true]); // resume
      const result = await runGuided(orchestrator, "request", io);

      expect(recorded.decideGateCalls).toEqual([]);
      expect(recorded.resumeCalls).toBe(1);
      expect(result.workflowState).toBe("READY");
      expect(lines.join("\n")).not.toContain("Approve ");
    });

    it("declining to resume exits without calling resume or decideGate (no mutation)", async () => {
      const initial = makeTask({ workflowState: "TASK_CREATED" });
      const manuallyPaused = makeTask({ workflowState: "PAUSED", pendingGate: undefined });

      const { orchestrator, recorded } = makeMockOrchestrator({
        initialTask: initial,
        runs: [{ steps: [{ from: "TASK_CREATED", task: manuallyPaused }], final: manuallyPaused }]
      });

      const { io } = fakeIO([false]); // decline to resume
      const result = await runGuided(orchestrator, "request", io);

      expect(recorded.resumeCalls).toBe(0);
      expect(recorded.decideGateCalls).toEqual([]);
      expect(result.workflowState).toBe("PAUSED");
    });
  });
});

describe("createRealIO", () => {
  it("is interactive when both stdin and stdout are TTYs", () => {
    const io = createRealIO();
    // In this test environment stdin/stdout are not real TTYs either, so just assert the
    // computed flag matches what process.stdin/stdout actually report — the meaningful
    // guarantee (never confirm() when false) is covered by the dedicated tests above.
    expect(io.isInteractive).toBe(Boolean(process.stdin.isTTY && process.stdout.isTTY));
  });
});
