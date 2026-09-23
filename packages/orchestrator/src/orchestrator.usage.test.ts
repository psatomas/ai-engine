import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalConfigSchema, type GlobalConfig, type ProjectConfig } from "@ai-engine/config";
import { buildDefaultWorkflow, WorkflowEngine } from "@ai-engine/workflow";
import { SecurityPolicy, CommandApprovalStore } from "@ai-engine/security";
import { GitRepository } from "@ai-engine/git";
import { createLogger } from "@ai-engine/logging";
import { groupUsageEvents, type AgentInvocationRequest, type AgentResult } from "@ai-engine/core";
import { TaskStore } from "./task-store.js";
import { RoleRegistry, type ProviderFactory } from "./role-registry.js";
import { Orchestrator } from "./orchestrator.js";
import { MockProvider } from "./test-support/mock-provider.js";

let repoDir: string;
let dataDir: string;

function mockResponder(request: AgentInvocationRequest): AgentResult {
  switch (request.role) {
    case "architect":
      return {
        status: "success",
        structuredOutput: { specification: "SPEC", plan: "PLAN", risks: [] },
        usage: { inputTokens: 100, outputTokens: 10 }
      };
    case "implementer":
      writeFileSync(join(request.workingDirectory, "feature.txt"), "content\n");
      // implement() vs fix() are distinguished by call count: the first implementer call is
      // implement(), a second is fix() — both use distinct usage so the test can tell them apart.
      return {
        status: "success",
        finalMessage: "done",
        usage: request.instructions.includes("Implement the specification")
          ? { inputTokens: 200, outputTokens: 50 }
          : { inputTokens: 30, outputTokens: 5 }
      };
    case "reviewer":
      return {
        status: "success",
        structuredOutput: {
          verdict: "changes_requested",
          summary: "needs work",
          findings: [{ dimension: "correctness", severity: "major", summary: "bug", detail: "d" }]
        }
      };
    case "security_reviewer":
      // No usage reported at all — proves a fully-unreported provider/role still gets an invocation record.
      return { status: "success", structuredOutput: { verdict: "approved", summary: "ok", findings: [] } };
    case "verifier":
      return {
        status: "success",
        structuredOutput: { verdict: "approved", summary: "confirmed", findings: [] },
        usage: { inputTokens: 40 }
      };
    default:
      return { status: "failure", error: { code: "UNKNOWN_ROLE", message: `no mock behavior for role ${request.role}` } };
  }
}

async function buildOrchestrator(
  opts: { configOverrides?: Partial<GlobalConfig>; provider?: MockProvider; projectConfig?: ProjectConfig } = {}
): Promise<Orchestrator> {
  const provider = opts.provider ?? new MockProvider("mock", mockResponder);
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
    approvals: { plan: true, security_review: false, final_merge: true },
    ...opts.configOverrides
  });
  const factories = new Map<string, ProviderFactory>([["mock", () => provider]]);
  const roleRegistry = new RoleRegistry(globalConfig, opts.projectConfig, factories);
  const securityPolicy = new SecurityPolicy(globalConfig.security);
  const commandApprovalStore = new CommandApprovalStore(join(dataDir, "approvals.json"));
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
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-usage-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-usage-data-"));
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

describe("usage telemetry, recorded end-to-end through a real Orchestrator", () => {
  it("distinguishes implement() from fix() invocations of the same 'implementer' role via the operation field", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    expect(task.workflowState).toBe("FIXING");
    task = await orchestrator.fix(task.id);

    const implementEvents = task.usageEvents.filter((e) => e.role === "implementer" && e.operation === "implement");
    const fixEvents = task.usageEvents.filter((e) => e.role === "implementer" && e.operation === "fix");
    expect(implementEvents).toHaveLength(1);
    expect(fixEvents).toHaveLength(1);
    expect(implementEvents[0]!.usage).toEqual({ inputTokens: 200, outputTokens: 50 });
    expect(fixEvents[0]!.usage).toEqual({ inputTokens: 30, outputTokens: 5 });

    // Grouping by role alone (ignoring operation) merges them, as expected for a coarser view.
    const byRole = groupUsageEvents(task.usageEvents, (e) => e.role);
    expect(byRole.implementer).toEqual({ invocations: 2, inputTokens: 230, outputTokens: 55 });
    // Grouping by role+operation keeps fixer distinguishable, as the CLI's "fixer" label relies on.
    const byRoleOp = groupUsageEvents(task.usageEvents, (e) => `${e.role}:${e.operation}`);
    expect(byRoleOp["implementer:implement"]).toEqual({ invocations: 1, inputTokens: 200, outputTokens: 50 });
    expect(byRoleOp["implementer:fix"]).toEqual({ invocations: 1, inputTokens: 30, outputTokens: 5 });
  });

  it("records an invocation for a provider/role that reports no usage at all — never a fabricated zero", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);

    const securityReviewerEvents = task.usageEvents.filter((e) => e.role === "security_reviewer");
    expect(securityReviewerEvents).toHaveLength(1);
    expect(securityReviewerEvents[0]!.usage).toEqual({});
    expect(securityReviewerEvents[0]!.providerId).toBe("mock");
  });

  it("persists byte-only prompt footprint beside, never inside, provider-reported token usage", async () => {
    const provider = new MockProvider("mock", (request) => ({
      status: "success",
      structuredOutput: { specification: "SPEC", plan: "PLAN", risks: [] },
      usage: { inputTokens: 100, cachedInputTokens: 70, outputTokens: 10 },
      promptFootprint: {
        explicitPromptBytes: 1036,
        systemPolicyBytes: 728,
        userPromptBytes: 220,
        contextBytes: 0,
        contextBlockCount: 0,
        resumedProviderSession: Boolean(request.resumeSessionId),
        structuredOutputSchemaBytes: 215
      }
    }));
    const orchestrator = await buildOrchestrator({ provider });
    const created = await orchestrator.createTask("request text");
    const task = await orchestrator.run(created.id);
    const event = task.usageEvents[0]!;

    expect(event.usage).toEqual({ inputTokens: 100, cachedInputTokens: 70, outputTokens: 10 });
    expect(event.promptFootprint).toEqual({
      explicitPromptBytes: 1036,
      systemPolicyBytes: 728,
      userPromptBytes: 220,
      contextBytes: 0,
      contextBlockCount: 0,
      resumedProviderSession: false,
      structuredOutputSchemaBytes: 215
    });
    const persisted = await readFile(join(dataDir, "tasks", `${task.id}.json`), "utf8");
    expect(persisted).toContain('"promptFootprint"');
    expect(JSON.stringify(event.promptFootprint)).not.toContain("request text");
  });

  it("loads a persisted usage event that predates prompt footprint observability", async () => {
    const orchestrator = await buildOrchestrator();
    const task = await orchestrator.createTask("Add a feature");
    const taskPath = join(dataDir, "tasks", `${task.id}.json`);
    const raw = JSON.parse(await readFile(taskPath, "utf8"));
    raw.usageEvents = [
      { at: "2026-01-01T00:00:00.000Z", providerId: "mock", role: "architect", operation: "analyze", usage: { inputTokens: 1 } }
    ];
    await writeFile(taskPath, JSON.stringify(raw, null, 2), "utf8");

    expect((await orchestrator.getTask(task.id))?.usageEvents).toEqual(raw.usageEvents);
  });

  it("a single provider filling multiple roles aggregates correctly per role and per provider", async () => {
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);

    const byRole = groupUsageEvents(task.usageEvents, (e) => e.role);
    expect(byRole.architect).toEqual({ invocations: 1, inputTokens: 100, outputTokens: 10 });
    expect(byRole.reviewer).toEqual({ invocations: 1 }); // reviewer mock reports no usage
    expect(byRole.security_reviewer).toEqual({ invocations: 1 });

    // Every role above is filled by the same "mock" provider — the per-provider total sums all of them.
    const byProvider = groupUsageEvents(task.usageEvents, (e) => e.providerId);
    expect(byProvider.mock!.invocations).toBe(task.usageEvents.length);
    expect(byProvider.mock!.inputTokens).toBe(100 + 200); // architect + implementer only report inputTokens so far
  });

  it("a resumed session's second invocation records its own independent usage delta — summed totals never double-count", async () => {
    // Two separate implementer calls (implement() then fix()) simulate resumed-session reinvocation:
    // each AgentResult.usage is this call's own reported delta, not a cumulative running total, so
    // summing task.usageEvents is correct by construction. Claude reports deltas natively; Codex
    // reports a cumulative-per-thread total and its adapter converts it to a delta itself before
    // ever setting AgentResult.usage (see codexInvocationUsage in packages/providers/src/codex.ts,
    // and the "cumulative-usage baseline persistence" describe block below for the orchestrator's
    // side of that conversion — the baseline round-trip, not the arithmetic).
    const orchestrator = await buildOrchestrator();
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    task = await orchestrator.fix(task.id);

    const implementerTotal = groupUsageEvents(
      task.usageEvents.filter((e) => e.role === "implementer"),
      () => "implementer"
    ).implementer;
    expect(implementerTotal).toEqual({ invocations: 2, inputTokens: 230, outputTokens: 55 });
  });

  it("a legacy persisted TaskRecord with no usageEvents key loads safely as an empty log", async () => {
    const orchestrator = await buildOrchestrator();
    const task = await orchestrator.createTask("Add a feature");
    const taskPath = join(dataDir, "tasks", `${task.id}.json`);
    const raw = JSON.parse(await readFile(taskPath, "utf8"));
    delete raw.usageEvents;
    await writeFile(taskPath, JSON.stringify(raw, null, 2), "utf8");

    const reloaded = await orchestrator.getTask(task.id);
    expect(reloaded?.usageEvents).toEqual([]);
  });
});

/**
 * FINDING 2: some providers (Codex, confirmed live) report usage as a cumulative running total
 * for the whole resumed thread, not a delta for one invocation — the *adapter* is responsible for
 * converting that into its own delta (see packages/providers/src/codex.ts's codexInvocationUsage),
 * but doing so correctly requires the *orchestrator* to persist and re-supply the right baseline
 * across invocations. These tests exercise that persistence/round-trip through a real Orchestrator
 * — not the conversion arithmetic itself, which is exhaustively unit-tested in
 * packages/providers/src/codex.test.ts against the exact same worked example (100 -> 150 -> 180).
 */
describe("cumulative-usage baseline persistence (Finding 2): the orchestrator supplies and updates a provider's previousCumulativeUsage/cumulativeUsageBaseline across resumed invocations", () => {
  it("fresh, resume, and another resume each receive the correct previousCumulativeUsage and persist the correct new baseline", async () => {
    let implementerCalls = 0;
    const provider = new MockProvider("mock", (request) => {
      switch (request.role) {
        case "architect":
          return { status: "success", structuredOutput: { specification: "SPEC", plan: "PLAN", risks: [] } };
        case "implementer": {
          writeFileSync(join(request.workingDirectory, "feature.txt"), `content ${implementerCalls}\n`);
          const call = implementerCalls++;
          if (call === 0) {
            return {
              status: "success",
              finalMessage: "done",
              providerSessionId: "sess-1",
              usage: { inputTokens: 100 },
              cumulativeUsageBaseline: { inputTokens: 100 }
            };
          }
          if (call === 1) {
            return {
              status: "success",
              finalMessage: "done",
              providerSessionId: "sess-1",
              usage: { inputTokens: 50 },
              cumulativeUsageBaseline: { inputTokens: 150 }
            };
          }
          return {
            status: "success",
            finalMessage: "done",
            providerSessionId: "sess-1",
            usage: { inputTokens: 30 },
            cumulativeUsageBaseline: { inputTokens: 180 }
          };
        }
        case "reviewer":
          return {
            status: "success",
            structuredOutput: {
              verdict: "changes_requested",
              summary: "needs work",
              findings: [{ dimension: "correctness", severity: "major", summary: "bug", detail: "d" }]
            }
          };
        case "security_reviewer":
          return { status: "success", structuredOutput: { verdict: "approved", summary: "ok", findings: [] } };
        default:
          return { status: "failure", error: { code: "UNKNOWN_ROLE", message: `no mock behavior for role ${request.role}` } };
      }
    });

    const orchestrator = await buildOrchestrator({ provider });
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");

    // provider.invocations records every role's calls (architect, implementer, reviewer,
    // security_reviewer), interleaved — filter to implementer-only to index by resume order.
    const implementerInvocations = () => provider.invocations.filter((inv) => inv.role === "implementer");

    // Call 1 (fresh): cumulative 100 -> observed invocation usage 100.
    task = await orchestrator.implement(task.id);
    expect(implementerInvocations()[0]!.request.previousCumulativeUsage).toBeUndefined();
    expect(task.usageEvents.find((e) => e.operation === "implement")?.usage).toEqual({ inputTokens: 100 });
    expect(task.providerSessions.implementer).toEqual({
      providerId: "mock",
      sessionId: "sess-1",
      cumulativeUsageBaseline: { inputTokens: 100 }
    });

    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    expect(task.workflowState).toBe("FIXING");

    // Call 2 (resume #1): previous cumulative 100, current cumulative 150 -> observed invocation usage 50.
    task = await orchestrator.fix(task.id);
    expect(implementerInvocations()[1]!.request.previousCumulativeUsage).toEqual({ inputTokens: 100 });
    const firstFix = task.usageEvents.filter((e) => e.role === "implementer" && e.operation === "fix")[0];
    expect(firstFix?.usage).toEqual({ inputTokens: 50 });
    expect(task.providerSessions.implementer).toEqual({
      providerId: "mock",
      sessionId: "sess-1",
      cumulativeUsageBaseline: { inputTokens: 150 }
    });

    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    expect(task.workflowState).toBe("FIXING");

    // Call 3 (another resume): previous cumulative 150, current cumulative 180 -> observed invocation usage 30.
    task = await orchestrator.fix(task.id);
    expect(implementerInvocations()[2]!.request.previousCumulativeUsage).toEqual({ inputTokens: 150 });
    const secondFix = task.usageEvents.filter((e) => e.role === "implementer" && e.operation === "fix")[1];
    expect(secondFix?.usage).toEqual({ inputTokens: 30 });
    expect(task.providerSessions.implementer).toEqual({
      providerId: "mock",
      sessionId: "sess-1",
      cumulativeUsageBaseline: { inputTokens: 180 }
    });

    // Real total consumption across all 3 calls: 100 + 50 + 30 = 180 — exactly the final cumulative
    // total, proving the persisted per-invocation deltas never double-count the resumed thread's usage.
    const implementerTotal = groupUsageEvents(
      task.usageEvents.filter((e) => e.role === "implementer"),
      () => "implementer"
    ).implementer;
    expect(implementerTotal).toEqual({ invocations: 3, inputTokens: 180 });
  });

  it("missing baseline on resume: the orchestrator supplies no previousCumulativeUsage at all (never a fabricated one) when the persisted session ref lacks it — e.g. a record predating this field", async () => {
    let implementerCalls = 0;
    const provider = new MockProvider("mock", (request) => {
      switch (request.role) {
        case "architect":
          return { status: "success", structuredOutput: { specification: "SPEC", plan: "PLAN", risks: [] } };
        case "implementer": {
          writeFileSync(join(request.workingDirectory, "feature.txt"), `content ${implementerCalls}\n`);
          const call = implementerCalls++;
          return call === 0
            ? {
                status: "success",
                finalMessage: "done",
                providerSessionId: "sess-1",
                usage: { inputTokens: 100 },
                cumulativeUsageBaseline: { inputTokens: 100 }
              }
            : { status: "success", finalMessage: "done", providerSessionId: "sess-1" };
        }
        case "reviewer":
          return {
            status: "success",
            structuredOutput: {
              verdict: "changes_requested",
              summary: "needs work",
              findings: [{ dimension: "correctness", severity: "major", summary: "bug", detail: "d" }]
            }
          };
        case "security_reviewer":
          return { status: "success", structuredOutput: { verdict: "approved", summary: "ok", findings: [] } };
        default:
          return { status: "failure", error: { code: "UNKNOWN_ROLE", message: `no mock behavior for role ${request.role}` } };
      }
    });

    const orchestrator = await buildOrchestrator({ provider });
    let task = await orchestrator.createTask("Add a feature");
    task = await orchestrator.run(task.id);
    task = await orchestrator.decidePlan(task.id, "approved", "alice");
    task = await orchestrator.implement(task.id);
    task = await orchestrator.test(task.id);
    task = await orchestrator.review(task.id);
    expect(task.workflowState).toBe("FIXING");

    // Simulate a persisted record with no cumulativeUsageBaseline for this session (e.g. written
    // before this field existed, or a provider that never reported one) — backward compatibility.
    const taskPath = join(dataDir, "tasks", `${task.id}.json`);
    const raw = JSON.parse(await readFile(taskPath, "utf8"));
    delete raw.providerSessions.implementer.cumulativeUsageBaseline;
    await writeFile(taskPath, JSON.stringify(raw, null, 2), "utf8");

    task = await orchestrator.fix(task.id);
    const implementerInvocations = provider.invocations.filter((inv) => inv.role === "implementer");
    expect(implementerInvocations[1]!.request.previousCumulativeUsage).toBeUndefined();
    // resumeSessionId is unaffected — only the usage baseline is missing, session continuity itself is unrelated.
    expect(implementerInvocations[1]!.request.resumeSessionId).toBe("sess-1");
  });
});
