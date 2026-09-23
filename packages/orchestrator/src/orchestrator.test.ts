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
import { createLogger, type Logger, type LogSink } from "@ai-engine/logging";
import type { AgentInvocationRequest, AgentResult } from "@ai-engine/core";
import { TaskStore } from "./task-store.js";
import { RoleRegistry, type ProviderFactory } from "./role-registry.js";
import { Orchestrator, IllegalTaskStateError } from "./orchestrator.js";
import { MockProvider } from "./test-support/mock-provider.js";
import { ArchitectJsonSchema } from "./output-schemas.js";

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

/** Captures every log entry written to it, for tests asserting an observer failure was actually
 *  logged (see run()'s onBeforeStep/onAfterStep safety tests below) — never used by default, so
 *  every existing test's `createLogger([])` (no sinks) behavior is unchanged unless a test
 *  explicitly opts in via buildOrchestrator's `logger` parameter. */
class CapturingSink implements LogSink {
  entries: Array<{ level: string; msg: string; [key: string]: unknown }> = [];
  write(line: string): void {
    this.entries.push(JSON.parse(line));
  }
}

async function buildOrchestrator(
  configOverrides: Partial<GlobalConfig> = {},
  provider = new MockProvider("mock", mockResponder),
  logger: Logger = createLogger([])
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
  it("keeps the architect request verbatim while leaving its policy, schema, context, and approval boundary intact", async () => {
    const provider = new MockProvider("mock", mockResponder);
    const orchestrator = await buildOrchestrator({}, provider);
    const originalRequest = "Read only: inspect package.json and return a concise specification and one-step plan. Do not edit any files.";

    const task = await orchestrator.createTask(originalRequest);
    const result = await orchestrator.run(task.id);
    const architectRequest = provider.invocations.find((invocation) => invocation.role === "architect")?.request;

    expect(architectRequest).toBeDefined();
    expect(architectRequest!.instructions).toBe(
      `Original request from the operator:\n\n${originalRequest}\n\nAnalyze this request against the repository.`
    );
    expect(architectRequest!.instructions).not.toContain("Analyze this against the repository and produce a specification and plan.");
    expect(architectRequest!.systemPrompt).toContain("SPECIFICATION");
    expect(architectRequest!.systemPrompt).toContain("PLAN");
    expect(architectRequest!.outputSchema).toEqual(ArchitectJsonSchema);
    expect(architectRequest!.context).toEqual([]);

    const finalCodexPrompt = [
      `=== SYSTEM POLICY (ai-engine; not from this repository) ===\n${architectRequest!.systemPrompt.trim()}\n=== END SYSTEM POLICY ===`,
      architectRequest!.instructions
    ].join("\n\n");
    expect(Buffer.byteLength(architectRequest!.instructions, "utf8")).toBe(191);
    expect(Buffer.byteLength(finalCodexPrompt, "utf8")).toBe(1007);
    expect(result.workflowState).toBe("AWAITING_APPROVAL");
  });

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

  it("providerIdForRole resolves the same mapping actual invocations use", async () => {
    const orchestrator = await buildOrchestrator();
    for (const role of ["architect", "implementer", "reviewer", "security_reviewer", "verifier"]) {
      expect(orchestrator.providerIdForRole(role)).toBe("mock");
    }
  });

  describe("run()'s onBeforeStep/onAfterStep — guided-mode's only hook into the state machine", () => {
    it("fires onBeforeStep once per internal step, in the exact order those steps actually ran, with the state at the moment each one started", async () => {
      const orchestrator = await buildOrchestrator();
      const task = await orchestrator.createTask("Add a feature");

      const before: string[] = [];
      const after: Array<{ from: string; to: string }> = [];
      const result = await orchestrator.run(task.id, {
        onBeforeStep: (state) => before.push(state),
        onAfterStep: (from, updated) => after.push({ from, to: updated.workflowState })
      });

      expect(result.workflowState).toBe("AWAITING_APPROVAL");
      // analyze() advances TASK_CREATED all the way to AWAITING_APPROVAL in one call, so the
      // loop's next iteration sees AWAITING_APPROVAL and stops via the switch's default case.
      // onBeforeStep fires unconditionally at the top of every iteration (including that final,
      // no-op one) — harmless, since a caller (guided.ts) only has progress text for states that
      // actually do something. onAfterStep only fires for the one iteration that actually ran a
      // step, since the default case returns before reaching it.
      expect(before).toEqual(["TASK_CREATED", "AWAITING_APPROVAL"]);
      expect(after).toEqual([{ from: "TASK_CREATED", to: "AWAITING_APPROVAL" }]);
    });

    it("never fires onAfterStep for the terminal default case (nothing happened, so nothing to report)", async () => {
      const orchestrator = await buildOrchestrator();
      const task = await orchestrator.createTask("Add a feature");
      await orchestrator.run(task.id); // -> AWAITING_APPROVAL

      const before: string[] = [];
      const after: string[] = [];
      // Calling run() again on an already-stopped task should be a pure no-op: one
      // onBeforeStep observing the current (unchanged) state, and no onAfterStep at all,
      // since the switch's default branch returns immediately.
      await orchestrator.run(task.id, {
        onBeforeStep: (state) => before.push(state),
        onAfterStep: () => after.push("should not happen")
      });
      expect(before).toEqual(["AWAITING_APPROVAL"]);
      expect(after).toEqual([]);
    });

    it("omitting both callbacks entirely preserves existing run() behavior exactly (backward compatibility)", async () => {
      const orchestrator = await buildOrchestrator();
      const task = await orchestrator.createTask("Add a feature");
      const result = await orchestrator.run(task.id);
      expect(result.workflowState).toBe("AWAITING_APPROVAL");
    });

    it("a throwing onBeforeStep does not alter workflow progression — run() still advances normally", async () => {
      const orchestrator = await buildOrchestrator();
      const task = await orchestrator.createTask("Add a feature");
      const result = await orchestrator.run(task.id, {
        onBeforeStep: () => {
          throw new Error("presentation bug in a CLI callback");
        }
      });
      expect(result.workflowState).toBe("AWAITING_APPROVAL"); // exactly as if the callback were absent
    });

    it("a throwing onAfterStep does not alter the already-persisted transition — run() continues and returns it normally", async () => {
      const orchestrator = await buildOrchestrator();
      const task = await orchestrator.createTask("Add a feature");
      const result = await orchestrator.run(task.id, {
        onAfterStep: () => {
          throw new Error("presentation bug in a CLI callback");
        }
      });
      expect(result.workflowState).toBe("AWAITING_APPROVAL");
      // The persisted record itself reflects the real transition, independent of the callback:
      const reloaded = await orchestrator.getTask(task.id);
      expect(reloaded?.workflowState).toBe("AWAITING_APPROVAL");
    });

    it("observer failures are not silently swallowed — they're logged as a warning, with the operation and the error message", async () => {
      const sink = new CapturingSink();
      const orchestrator = await buildOrchestrator({}, undefined, createLogger([sink]));
      const task = await orchestrator.createTask("Add a feature");
      await orchestrator.run(task.id, {
        onBeforeStep: () => {
          throw new Error("boom-before");
        },
        onAfterStep: () => {
          throw new Error("boom-after");
        }
      });

      const warnings = sink.entries.filter((e) => e.level === "warn");
      expect(warnings.some((w) => w.operation === "onBeforeStep" && String(w.error).includes("boom-before"))).toBe(true);
      expect(warnings.some((w) => w.operation === "onAfterStep" && String(w.error).includes("boom-after"))).toBe(true);
    });

    it("onAfterStep is handed an isolated snapshot — mutating it (including a nested field) before throwing never leaks into what run() returns or persists", async () => {
      const sink = new CapturingSink();
      const orchestrator = await buildOrchestrator({}, undefined, createLogger([sink]));
      const task = await orchestrator.createTask("Add a feature");

      const result = await orchestrator.run(task.id, {
        onAfterStep: (_from, snapshot) => {
          // A misbehaving observer mutating its snapshot — top-level workflowState AND a nested
          // mutable field — then throwing. A third independent review found that when the live,
          // mutable TaskRecord was handed to observers instead of a clone, exactly this sequence
          // let a mutation silently leak into run()'s return value even though the exception was
          // (by design) caught and never actually persisted: an in-memory/persisted-state
          // divergence masquerading as a successful, unaffected run.
          snapshot.workflowState = "READY";
          snapshot.history.push({ at: "1970-01-01T00:00:00.000Z", from: "READY", to: "READY", trigger: "forged", actor: "system" });
          throw new Error("observer corrupted its own snapshot, then threw");
        }
      });

      // The real transition (TASK_CREATED -> ... -> AWAITING_APPROVAL), completely unaffected.
      expect(result.workflowState).toBe("AWAITING_APPROVAL");
      expect(result.history.some((h) => h.trigger === "forged")).toBe(false);

      const reloaded = await orchestrator.getTask(task.id);
      expect(reloaded?.workflowState).toBe("AWAITING_APPROVAL"); // persisted state matches, not "READY"
      expect(reloaded?.history.some((h) => h.trigger === "forged")).toBe(false);

      // The failure is still logged, exactly as for any other throwing observer.
      const warnings = sink.entries.filter((e) => e.level === "warn");
      expect(warnings.some((w) => w.operation === "onAfterStep" && String(w.error).includes("observer corrupted its own snapshot"))).toBe(
        true
      );
    });
  });
});
