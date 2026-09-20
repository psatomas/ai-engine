import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  WellKnownRole,
  verificationPassed,
  type AgentInvocationRequest,
  type AgentResult,
  type ContextBlock,
  type ReviewFinding,
  type ReviewReport,
  type TaskRecord,
  type TaskUsage,
  type UsageEvent,
  type VerificationCheck,
  type VerificationReport,
  type WorkflowState
} from "@ai-engine/core";
import {
  resolveEnginePaths,
  loadGlobalConfig,
  loadProjectConfig,
  type EnginePaths,
  type GlobalConfig,
  type ProjectConfig
} from "@ai-engine/config";
import { WorkflowEngine, buildDefaultWorkflow, type Trigger } from "@ai-engine/workflow";
import { SecurityPolicy, sandboxDefaultsForRole, CommandApprovalStore } from "@ai-engine/security";
import { GitRepository } from "@ai-engine/git";
import { detectChecks, runVerification } from "@ai-engine/verification";
import { createLogger, FileSink, ConsoleSink, type Logger, type LogSink, type LogLevel } from "@ai-engine/logging";
import { TaskStore } from "./task-store.js";
import { RoleRegistry } from "./role-registry.js";
import { generateTaskId } from "./ids.js";
import { systemPromptForRole } from "./prompts.js";
import { loadProjectContext } from "./project-context.js";
import { writeTaskSummary } from "./task-summary.js";
import { ArchitectJsonSchema, ReviewJsonSchema, tryParseArchitectOutput, tryParseReviewOutput } from "./output-schemas.js";
import { prepareWorktreeDependencies } from "./dependency-setup.js";

const DIFF_CONTEXT_MAX_CHARS = 40_000;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n...[truncated]" : text;
}

export class IllegalTaskStateError extends Error {
  constructor(taskId: string, actual: WorkflowState, expected: WorkflowState[]) {
    super(`Task "${taskId}" is in state ${actual}, expected one of: ${expected.join(", ")}`);
    this.name = "IllegalTaskStateError";
  }
}

export class EmptyRepositoryError extends Error {
  constructor(repoRoot: string) {
    super(
      `"${repoRoot}" has no commits yet. AI Engine needs a baseline commit to create a task worktree from — run "git commit" (even an empty one) before "ai task".`
    );
    this.name = "EmptyRepositoryError";
  }
}

export class BudgetExceededError extends Error {
  constructor(taskId: string, detail: string) {
    super(`Task "${taskId}" cannot proceed: ${detail}`);
    this.name = "BudgetExceededError";
  }
}

export class WorkspaceConfinementError extends Error {
  constructor(taskId: string, path: string, reason?: string) {
    super(
      `Task "${taskId}"'s working directory failed a workspace-confinement check: ${reason ?? `"${path}" is not within an allowed root`}`
    );
    this.name = "WorkspaceConfinementError";
  }
}

/**
 * Raised when a mutating step is about to run against a worktree whose
 * actual current commit no longer matches what the last successfully
 * persisted TaskRecord recorded (see GitBaseline.lastKnownCommit in
 * @ai-engine/core). This is the concrete, detectable signal that something
 * changed the worktree without a corresponding persisted state update —
 * most commonly a process killed between a git commit and the following
 * persist() call. The system refuses to blindly proceed (which would
 * re-invoke an agent on top of already-committed, "forgotten" work) until a
 * human calls Orchestrator.acknowledgeDivergence().
 */
export class GitStateDivergedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly expectedCommit: string,
    public readonly actualCommit: string
  ) {
    super(
      `Task "${taskId}"'s worktree is at commit ${actualCommit.slice(0, 12)}, but the last persisted state expected ${expectedCommit.slice(0, 12)}. ` +
        `The worktree changed without a matching recorded state update (commonly: a process was killed between a git commit and saving task state). ` +
        `Inspect the worktree/diff, then run \`ai acknowledge-divergence <taskId>\` to accept the current worktree state before retrying.`
    );
    this.name = "GitStateDivergedError";
  }
}

export interface OrchestratorDeps {
  gitRepo: GitRepository;
  paths: EnginePaths;
  globalConfig: GlobalConfig;
  projectConfig: ProjectConfig | undefined;
  taskStore: TaskStore;
  roleRegistry: RoleRegistry;
  securityPolicy: SecurityPolicy;
  commandApprovalStore: CommandApprovalStore;
  logger: Logger;
  workflow: WorkflowEngine;
}

function repoApprovalsFileName(repoRoot: string): string {
  return `${createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)}.json`;
}

export async function createOrchestrator(
  startDir: string,
  overrides: { paths?: EnginePaths; consoleLogLevel?: LogLevel } = {}
): Promise<Orchestrator> {
  const gitRepo = await GitRepository.discover(startDir);
  const paths = overrides.paths ?? resolveEnginePaths();
  const globalConfig = await loadGlobalConfig(paths);
  const projectConfig = await loadProjectConfig(gitRepo.root);
  const taskStore = new TaskStore(paths.taskStoreDir);
  const roleRegistry = new RoleRegistry(globalConfig, projectConfig);
  const securityPolicy = new SecurityPolicy(globalConfig.security);
  const commandApprovalStore = new CommandApprovalStore(join(paths.dataDir, "approvals", repoApprovalsFileName(gitRepo.root)));
  const sinks: LogSink[] = [new FileSink(join(paths.logsDir, "engine.log"))];
  // consoleLogLevel is an optional per-invocation override (used by `ai start`'s guided mode
  // to show concise progress instead of raw debug/agent-event JSON) — the file sink above
  // always receives every entry regardless, so nothing is ever lost from the durable log,
  // only the console's share of it is reduced. Omitting it (every existing caller) preserves
  // exactly today's behavior: everything, at "debug".
  if (globalConfig.logging.toConsole) sinks.push(new ConsoleSink(overrides.consoleLogLevel));
  const logger = createLogger(sinks, { repository: gitRepo.root });
  const workflow = new WorkflowEngine(buildDefaultWorkflow(), globalConfig.workflow);

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

/**
 * The single object both the CLI and the VS Code extension drive. Each
 * public mutating method acquires a cross-process lock for its task id
 * (TaskStore.withLock — see task-store.ts), loads the current TaskRecord
 * *inside* that lock, applies exactly the transitions its step is
 * responsible for, persists, and releases — so every call is safe against
 * both a crash (atomic persistence) and a second, independent process
 * touching the same task concurrently (the lock), and every state change is
 * auditable from the task's `history`.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  get repoRoot(): string {
    return this.deps.gitRepo.root;
  }

  // ---- read-only accessors (no lock: atomic writes make unlocked reads safe) -----------------

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    return this.deps.taskStore.get(taskId);
  }

  async listTasks(): Promise<TaskRecord[]> {
    return this.deps.taskStore.list({ repositoryRoot: this.repoRoot });
  }

  async currentDiff(taskId: string) {
    const task = await this.deps.taskStore.requireTask(taskId);
    return this.deps.gitRepo.diff(task.git.commit, "HEAD", task.git.worktreePath ?? task.workspaceFolder);
  }

  /**
   * Which provider currently fills a role, per the same global/project config resolution
   * every actual invocation uses (`RoleRegistry.resolveProviderId`) — exposed publicly so a
   * caller (guided-mode CLI output, an editor extension, ...) can render "Claude is
   * planning..." from the real effective mapping instead of hardcoding a provider name.
   * Throws the same `UnassignedRoleError` an actual invocation would if the role has no
   * assignment, for the same reason: better to fail here than render a wrong label.
   */
  providerIdForRole(role: string): string {
    return this.deps.roleRegistry.resolveProviderId(role);
  }

  // ---- task lifecycle -------------------------------------------------------

  async createTask(originalRequest: string): Promise<TaskRecord> {
    const status = await this.deps.gitRepo.status();
    if (status.dirty) {
      this.deps.logger.warn(
        "Main working tree has uncommitted changes; they are NOT included in the task's worktree baseline (a git worktree is created from a commit, not the dirty working tree). Commit or stash first if the agent needs to see them.",
        { operation: "createTask" }
      );
    }
    const baseline = await this.deps.gitRepo.captureBaseline();
    if (!baseline.commit) {
      throw new EmptyRepositoryError(this.repoRoot);
    }
    const id = generateTaskId();

    return this.withTaskLock(id, async () => {
      const { path, branch } = await this.deps.gitRepo.createTaskWorktree(id, this.deps.paths.worktreesDir, baseline.commit);
      baseline.worktreePath = path;
      baseline.taskBranch = branch;
      baseline.lastKnownCommit = baseline.commit;

      // Best-effort, never blocks task creation: a fresh git worktree only checks out tracked
      // files, so a Node project's node_modules never exists yet. See dependency-setup.ts for
      // why this is intentionally narrow (fixed install commands only, never anything from the
      // repository) and docs/architecture.md for the incident this fixes.
      const dependencySetup = await prepareWorktreeDependencies(path, { securityPolicy: this.deps.securityPolicy });
      this.deps.logger.info("dependency_setup", { taskId: id, ...dependencySetup });

      const now = new Date().toISOString();
      const seed: TaskRecord = {
        id,
        repository: { root: this.repoRoot },
        workspaceFolder: path,
        originalRequest,
        workflowState: "IDLE",
        agentsUsed: [],
        dependencySetup,
        git: baseline,
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
      const task = this.deps.workflow.apply(seed, "analyze", "human", originalRequest);
      return this.persist(task);
    });
  }

  async analyze(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.loadAndCheckDivergence(taskId);
      // TASK_CREATED: fresh entry. ANALYZING: re-entry after `retry` recovered a FAILED task
      // whose architect invocation didn't complete last time — resume without re-applying the
      // (already-applied) TASK_CREATED -> ANALYZING transition, which has no self-loop rule.
      this.assertState(task, ["TASK_CREATED", "ANALYZING"]);
      if (task.workflowState === "TASK_CREATED") {
        task = this.deps.workflow.apply(task, "analyze", "system");
        task = await this.persist(task);
      }

      const context = await loadProjectContext(this.repoRoot);
      const request = await this.buildRequest(task, WellKnownRole.Architect, {
        instructions: `Original request from the operator:\n\n${task.originalRequest}\n\nAnalyze this against the repository and produce a specification and plan.`,
        context,
        outputSchema: ArchitectJsonSchema
      });
      const { result, providerId } = await this.invokeRole(task, WellKnownRole.Architect, request);
      task = this.recordAgentUsage(task, WellKnownRole.Architect, providerId, result, "analyze");

      if (result.status !== "success") {
        task = this.deps.workflow.apply(task, "fail", { role: WellKnownRole.Architect, providerId }, this.describeFailure(result));
        return this.persist(task);
      }

      const parsed = tryParseArchitectOutput(result.structuredOutput, result.finalMessage);
      task = { ...task, specification: parsed?.specification ?? result.finalMessage ?? "", plan: parsed?.plan ?? "" };
      task = this.deps.workflow.apply(task, "plan_ready", { role: WellKnownRole.Architect, providerId });
      task = this.deps.workflow.apply(task, "submit_for_approval", "system");

      if (!this.deps.globalConfig.approvals.plan) {
        task = this.deps.workflow.apply(task, "approve", "system", "auto-approved: approvals.plan is disabled in config");
        task = {
          ...task,
          approvals: [
            ...task.approvals,
            { gate: "plan", decision: "approved", by: "system", at: new Date().toISOString(), note: "auto-approved by config" }
          ]
        };
      }
      return this.persist(task);
    });
  }

  async decidePlan(taskId: string, decision: "approved" | "rejected", by: string, note?: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      this.assertState(task, ["AWAITING_APPROVAL"]);
      task = this.deps.workflow.apply(task, decision === "approved" ? "approve" : "reject", "human", this.attribute(by, note));
      task = { ...task, approvals: [...task.approvals, { gate: "plan", decision, by, at: new Date().toISOString(), note }] };
      return this.persist(task);
    });
  }

  async implement(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.loadAndCheckDivergence(taskId);
      this.assertState(task, ["IMPLEMENTING"]);

      const projectContext = await loadProjectContext(this.repoRoot);
      const request = await this.buildRequest(task, WellKnownRole.Implementer, {
        instructions: `Original request:\n${task.originalRequest}\n\nImplement the specification and plan provided in context below. Do not make unrelated changes.`,
        context: [...this.planContextBlocks(task), ...projectContext]
      });
      const { result, providerId } = await this.invokeRole(task, WellKnownRole.Implementer, request);
      task = this.recordAgentUsage(task, WellKnownRole.Implementer, providerId, result, "implement");

      if (result.status !== "success") {
        task = this.deps.workflow.apply(task, "fail", { role: WellKnownRole.Implementer, providerId }, this.describeFailure(result));
        return this.persist(task);
      }

      await this.deps.gitRepo.commitAllIfChanged(task.git.worktreePath ?? task.workspaceFolder, `ai-engine(${task.id}): implement`);
      task = this.deps.workflow.apply(task, "implemented", { role: WellKnownRole.Implementer, providerId }, result.finalMessage);
      return this.persist(task);
    });
  }

  async test(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.loadAndCheckDivergence(taskId);
      this.assertState(task, ["TESTING"]);

      const cwd = task.git.worktreePath ?? task.workspaceFolder;
      const { checks: autoChecks, notConfigured } = await detectChecks(cwd);
      const { checks: allChecks, disabledIds } = this.applyVerificationOverrides(autoChecks, cwd);
      const report = await runVerification(task.id, allChecks, notConfigured, {
        skip: disabledIds,
        approvals: this.deps.commandApprovalStore,
        denylist: this.deps.securityPolicy,
        repoRoot: cwd
      });

      task = { ...task, verification: [...task.verification, report] };
      const passed = verificationPassed(report, allChecks);
      if (!passed) {
        // See requiredChecksAwaitingApproval's doc comment: this must be checked, and must stop
        // the pipeline here, BEFORE `tests_failed` ever gets applied — a second independent
        // review found that checking for this only *after* `run()` had already driven the task
        // through `tests_failed` -> FIXING -> (fixer can't do anything) -> ... -> BLOCKED was too
        // late: by the time any caller could react, a test_fix iteration was already spent and
        // the fixer had already been invoked for something it has no authority to resolve.
        const awaiting = await this.requiredChecksAwaitingApproval(report, allChecks);
        if (awaiting.length > 0) {
          task = this.deps.workflow.apply(
            task,
            "pause",
            "system",
            `awaiting human approval for required verification check(s): ${awaiting.join(", ")} — this is not an implementation failure; approve with \`ai approve-check\``
          );
          return this.persist(task);
        }
      }
      task = this.deps.workflow.apply(task, passed ? "tests_passed" : "tests_failed", "system");
      return this.persist(task);
    });
  }

  async review(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.loadAndCheckDivergence(taskId);
      this.assertState(task, ["REVIEWING"]);

      const cwd = task.git.worktreePath ?? task.workspaceFolder;
      const diff = await this.deps.gitRepo.diff(task.git.commit, "HEAD", cwd);
      const latestVerification = task.verification.at(-1);
      const projectContext = await loadProjectContext(this.repoRoot);

      const diffContext: ContextBlock[] = [
        { trust: "command_output", label: "implementation diff", content: truncate(diff.raw, DIFF_CONTEXT_MAX_CHARS) },
        {
          trust: "command_output",
          label: "changed files",
          content: diff.files.map((f) => `${f.status}\t${f.path}`).join("\n") || "(no changes)"
        },
        ...(latestVerification
          ? [
              {
                trust: "command_output" as const,
                label: "latest verification results",
                content: JSON.stringify(latestVerification, null, 2)
              }
            ]
          : [])
      ];
      const reviewConfig = this.deps.projectConfig?.review;
      const reviewConfigContext: ContextBlock[] = [];
      if (reviewConfig?.protocolSecurityReview) {
        reviewConfigContext.push({
          trust: "repository_configuration",
          label: ".ai/project.yaml: review.protocolSecurityReview",
          content:
            "true — apply deeper protocol-security scrutiny (reentrancy, access control, integer overflow/precision loss, oracle manipulation, invariant violations) in addition to the usual review dimensions."
        });
      }
      if (reviewConfig?.focusAreas?.length) {
        reviewConfigContext.push({
          trust: "repository_configuration",
          label: ".ai/project.yaml: review.focusAreas",
          content: reviewConfig.focusAreas.join(", ")
        });
      }

      const instructions = `Original request:\n${task.originalRequest}\n\nReview the implementation diff and context provided below against the request, specification, and plan.`;
      const allContext = [...this.planContextBlocks(task), ...diffContext, ...reviewConfigContext, ...projectContext];

      for (const role of [WellKnownRole.Reviewer, WellKnownRole.SecurityReviewer]) {
        const request = await this.buildRequest(task, role, { instructions, context: allContext, outputSchema: ReviewJsonSchema });
        const { result, providerId } = await this.invokeRole(task, role, request);
        task = this.recordAgentUsage(task, role, providerId, result, "review");

        if (result.status !== "success") {
          task = this.deps.workflow.apply(task, "fail", { role, providerId }, this.describeFailure(result));
          return this.persist(task);
        }
        const parsed = tryParseReviewOutput(result.structuredOutput, result.finalMessage);
        const now = new Date().toISOString();
        const report: ReviewReport = {
          id: `${task.id}-${role}-${task.reviews.length}`,
          taskId: task.id,
          role,
          providerId,
          createdAt: now,
          verdict: parsed?.verdict ?? "changes_requested",
          summary: parsed?.summary ?? result.finalMessage ?? "(reviewer returned no summary)",
          findings: (parsed?.findings ?? []).map((f, i) => ({ id: `${task.id}-${role}-f${i}`, status: "open" as const, ...f }))
        };
        // H3: persist this reviewer's result immediately, independently of whether the next
        // reviewer succeeds — a subsequent failure can never silently discard it.
        task = { ...task, reviews: [...task.reviews, report] };
        task = await this.persist(task);
      }

      const roundReports = task.reviews.slice(-2);
      const hasBlockingOpenFindings = roundReports.some((r) =>
        r.findings.some((f) => (f.severity === "blocker" || f.severity === "major") && f.status === "open")
      );
      const allApproved = roundReports.length === 2 && roundReports.every((r) => r.verdict === "approved") && !hasBlockingOpenFindings;

      if (allApproved && this.deps.globalConfig.approvals.security_review) {
        task = this.deps.workflow.apply(task, "pause", "system", "awaiting human sign-off on security_review gate");
        task = { ...task, pendingGate: "security_review", pendingDecisionTrigger: "review_approved" satisfies Trigger };
      } else {
        task = this.deps.workflow.apply(task, allApproved ? "review_approved" : "review_findings", "system");
      }
      return this.persist(task);
    });
  }

  /** Resolves a gate opened by `review()` (currently: security_review). */
  async decideGate(taskId: string, gate: string, decision: "approved" | "rejected", by: string, note?: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      if (task.workflowState !== "PAUSED" || task.pendingGate !== gate) {
        throw new Error(
          `Task "${taskId}" has no pending "${gate}" gate (state=${task.workflowState}, pendingGate=${task.pendingGate ?? "none"})`
        );
      }
      task = this.deps.workflow.apply(task, "resume", "human", this.attribute(by));
      if (decision === "approved" && task.pendingDecisionTrigger) {
        task = this.deps.workflow.apply(task, task.pendingDecisionTrigger as Trigger, "human", this.attribute(by, note));
      } else {
        task = this.deps.workflow.apply(task, "review_findings", "human", this.attribute(by, note ?? `${gate} gate rejected`));
      }
      task = {
        ...task,
        pendingGate: undefined,
        pendingDecisionTrigger: undefined,
        approvals: [...task.approvals, { gate, decision, by, at: new Date().toISOString(), note }]
      };
      return this.persist(task);
    });
  }

  async fix(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.loadAndCheckDivergence(taskId);
      this.assertState(task, ["FIXING"]);

      const projectContext = await loadProjectContext(this.repoRoot);
      const openFindingCount = task.reviews.flatMap((r) => r.findings).filter((f) => f.status === "open").length;
      const instructions = `Original request:\n${task.originalRequest}\n\nAddress the failing checks and/or open review findings provided in context below. Do not make unrelated changes.${
        openFindingCount > 1
          ? ` There are ${openFindingCount} separate open findings listed below (numbered) — address every one of them individually, not just the first; do not stop early.`
          : ""
      }`;
      const request = await this.buildRequest(task, WellKnownRole.Implementer, {
        instructions,
        context: [...this.buildFixContext(task), ...projectContext]
      });
      const { result, providerId } = await this.invokeRole(task, WellKnownRole.Implementer, request);
      task = this.recordAgentUsage(task, WellKnownRole.Implementer, providerId, result, "fix");

      if (result.status !== "success") {
        task = this.deps.workflow.apply(task, "fail", { role: WellKnownRole.Implementer, providerId }, this.describeFailure(result));
        return this.persist(task);
      }

      await this.deps.gitRepo.commitAllIfChanged(task.git.worktreePath ?? task.workspaceFolder, `ai-engine(${task.id}): fix`);
      // Optimistic but honest: fix() ran and reported success, so every finding that was open
      // when this call started is marked "fix_attempted" — NOT "fixed". That distinction is the
      // whole point: an audit found that a single fix() call which only actually addressed one of
      // two given findings still left the workflow claiming both were "fixed", which is a false
      // claim of verified correctness. "fix_attempted" makes no claim about whether the
      // implementer actually looked at any specific finding, only that a fix pass ran while it was
      // open. The next review/verification pass is what actually re-validates: it re-examines the
      // real diff from scratch and reports a fresh "open" finding for anything still wrong,
      // independent of what any past finding's status says (see Orchestrator.review()) — this is
      // what genuinely closes a finding, not this optimistic mark.
      task = {
        ...task,
        reviews: task.reviews.map((r) => ({
          ...r,
          findings: r.findings.map((f) => (f.status === "open" ? { ...f, status: "fix_attempted" as const } : f))
        }))
      };
      task = this.deps.workflow.apply(task, "fixed", { role: WellKnownRole.Implementer, providerId }, result.finalMessage);
      return this.persist(task);
    });
  }

  async finalVerify(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.loadAndCheckDivergence(taskId);
      this.assertState(task, ["VERIFYING"]);

      const cwd = task.git.worktreePath ?? task.workspaceFolder;
      const { checks: autoChecks, notConfigured } = await detectChecks(cwd);
      const { checks: allChecks, disabledIds } = this.applyVerificationOverrides(autoChecks, cwd);
      const report = await runVerification(task.id, allChecks, notConfigured, {
        skip: disabledIds,
        approvals: this.deps.commandApprovalStore,
        denylist: this.deps.securityPolicy,
        repoRoot: cwd
      });
      task = { ...task, verification: [...task.verification, report] };
      task = await this.persist(task); // durable even if the verifier role call below fails
      const automatedPass = verificationPassed(report, allChecks);
      if (!automatedPass) {
        // Same approval boundary as test() above, applied at final verification for the same
        // reason: an unapproved required check is a pending human decision, not a verifier-level
        // failure, and must stop here — before the (costly, and ultimately pointless — its
        // verdict would be discarded regardless) verifier role invocation below, let alone
        // `verified_fail` -> FIXING.
        const awaiting = await this.requiredChecksAwaitingApproval(report, allChecks);
        if (awaiting.length > 0) {
          task = this.deps.workflow.apply(
            task,
            "pause",
            "system",
            `awaiting human approval for required verification check(s): ${awaiting.join(", ")} — this is not an implementation failure; approve with \`ai approve-check\``
          );
          return this.persist(task);
        }
      }

      const diff = await this.deps.gitRepo.diff(task.git.commit, "HEAD", cwd);
      const context: ContextBlock[] = [
        { trust: "command_output", label: "final diff", content: truncate(diff.raw, DIFF_CONTEXT_MAX_CHARS) },
        { trust: "command_output", label: "all verification reports", content: JSON.stringify(task.verification, null, 2) },
        { trust: "agent_generated", label: "all review reports", content: JSON.stringify(task.reviews, null, 2) },
        ...this.planContextBlocks(task)
      ];
      const instructions = `Original request:\n${task.originalRequest}\n\nConfirm the task is genuinely complete, using the context provided below.`;
      const request = await this.buildRequest(task, WellKnownRole.Verifier, { instructions, context, outputSchema: ReviewJsonSchema });
      const { result, providerId } = await this.invokeRole(task, WellKnownRole.Verifier, request);
      task = this.recordAgentUsage(task, WellKnownRole.Verifier, providerId, result, "verify");

      if (result.status !== "success") {
        task = this.deps.workflow.apply(task, "fail", { role: WellKnownRole.Verifier, providerId }, this.describeFailure(result));
        return this.persist(task);
      }
      const parsed = tryParseReviewOutput(result.structuredOutput, result.finalMessage);
      const verifierApproved = parsed?.verdict === "approved";

      task = this.deps.workflow.apply(
        task,
        automatedPass && verifierApproved ? "verified_pass" : "verified_fail",
        { role: WellKnownRole.Verifier, providerId },
        parsed?.summary
      );
      return this.persist(task);
    });
  }

  /** Explicitly approves a repository-configured verification command (see docs/security.md#c1). CLI and VS Code both call this — there is exactly one approval mechanism. */
  async approveVerificationCommand(
    taskId: string,
    checkId: string,
    by: string,
    note?: string
  ): Promise<{ task: TaskRecord; command: string }> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      const cwd = task.git.worktreePath ?? task.workspaceFolder;
      const { checks: autoChecks } = await detectChecks(cwd);
      const { checks: allChecks } = this.applyVerificationOverrides(autoChecks, cwd);
      const check = allChecks.find((c) => c.id === checkId);
      if (!check) {
        throw new Error(`No verification check named "${checkId}" is currently configured for this task's repository.`);
      }
      if (check.origin !== "repository_configured") {
        throw new Error(`Check "${checkId}" is auto-detected, not repository-configured, and never requires approval.`);
      }
      await this.deps.commandApprovalStore.approve(check.command, by);
      task = {
        ...task,
        approvals: [...task.approvals, { gate: `verification:${checkId}`, decision: "approved", by, at: new Date().toISOString(), note }]
      };
      task = await this.persist(task);
      return { task, command: check.command };
    });
  }

  /** Lists the verification checks currently configured for a task, including approval status for repository-configured ones. */
  async listVerificationChecks(taskId: string): Promise<Array<VerificationCheck & { approved: boolean }>> {
    const task = await this.deps.taskStore.requireTask(taskId);
    const cwd = task.git.worktreePath ?? task.workspaceFolder;
    const { checks: autoChecks } = await detectChecks(cwd);
    const { checks: allChecks } = this.applyVerificationOverrides(autoChecks, cwd);
    return Promise.all(
      allChecks.map(async (c) => ({
        ...c,
        approved: c.origin === "repository_configured" ? await this.deps.commandApprovalStore.isApproved(c.command) : true
      }))
    );
  }

  async pause(taskId: string, by: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      task = this.deps.workflow.apply(task, "pause", "human", this.attribute(by));
      return this.persist(task);
    });
  }

  async resume(taskId: string, by: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      if (task.pendingGate) {
        throw new Error(`Task "${taskId}" is paused on the "${task.pendingGate}" approval gate; use decideGate(), not resume().`);
      }
      task = this.deps.workflow.apply(task, "resume", "human", this.attribute(by));
      return this.persist(task);
    });
  }

  /** Recovers a FAILED task back to whatever state it failed from (e.g. after a transient provider error). Itself iteration-guarded — see WorkflowEngine. */
  async retry(taskId: string, by: string, note?: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      task = this.deps.workflow.apply(task, "retry", "human", this.attribute(by, note));
      return this.persist(task);
    });
  }

  async cancel(taskId: string, by: string, note?: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      task = this.deps.workflow.apply(task, "cancel", "human", this.attribute(by, note));
      return this.persist(task);
    });
  }

  /**
   * Accepts the worktree's current commit as the new known-good baseline
   * after a GitStateDivergedError, without attempting to guess what
   * happened. Does not change workflowState — the operator should inspect
   * `ai diff <taskId>` first and decide whether the divergent work is worth
   * keeping (in which case just acknowledge and continue) or should be
   * discarded (reset the worktree by hand first).
   */
  async acknowledgeDivergence(taskId: string, by: string, note?: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      const cwd = task.git.worktreePath ?? task.workspaceFolder;
      const actual = await this.deps.gitRepo.currentCommit(cwd);
      const at = new Date().toISOString();
      task = {
        ...task,
        git: { ...task.git, lastKnownCommit: actual },
        failures: [
          ...task.failures,
          {
            at,
            state: task.workflowState,
            message: `git/task state divergence acknowledged by ${by}${note ? `: ${note}` : ""} (worktree now recorded at ${actual})`,
            code: "DIVERGENCE_ACKNOWLEDGED"
          }
        ]
      };
      return this.persist(task);
    });
  }

  /**
   * Drives the task forward automatically, stopping at any approval gate, PAUSED, FAILED, or
   * a terminal state. Never auto-retries a FAILED task — that is always an explicit human
   * decision (see retry()).
   *
   * `onBeforeStep`/`onAfterStep`, if given, are called immediately before and after the step
   * for the current state runs — e.g. `onBeforeStep("IMPLEMENTING")` right before `implement()`
   * is called, then `onAfterStep("IMPLEMENTING", <resulting task>)` right after. This exists so
   * a caller (guided-mode CLI output) can narrate live progress ("Codex is implementing...",
   * "✓ Implementation complete") for each step *inside* a single `run()` call, without this
   * method's dispatch table — the actual state-machine/orchestration logic — being duplicated
   * anywhere else: both callbacks are pure observers of a state transition that already
   * happened here, never a second decision point. Optional and a no-op by default: every
   * existing caller is unaffected.
   *
   * Observer failures can never affect workflow progression: both callbacks run through
   * `invokeObserver`, which catches anything they throw, logs it, and continues — a second,
   * independent review found that letting an observer's exception propagate out of `run()`
   * would mean a caller sees an error *after* the actual mutating step already persisted its
   * transition, which is exactly the kind of "did it happen or not" confusion this codebase
   * works hard to avoid everywhere else (see e.g. H3 in orchestrator.hardening.test.ts). A CLI
   * presentation bug must never become a workflow-correctness bug.
   *
   * `onAfterStep` is handed a `structuredClone()` snapshot of `task`, never the live object this
   * loop itself goes on to use — a third independent review found that passing the live,
   * mutable `TaskRecord` let a misbehaving observer mutate it (e.g. `task.workflowState =
   * "READY"`) before throwing, and since the exception is caught (by design, see above), that
   * mutation would otherwise silently leak into what `run()` returns even though it was never
   * actually persisted — a real in-memory/persisted-state divergence, not just a cosmetic one.
   * Cloning is the smallest fix that keeps observers genuinely presentation-only: whatever an
   * observer does to its copy, orchestration never sees it. `onBeforeStep` needs no equivalent
   * treatment — it's only ever given a `WorkflowState` string, which is already immutable.
   */
  async run(
    taskId: string,
    opts: { onBeforeStep?: (state: WorkflowState) => void; onAfterStep?: (from: WorkflowState, task: TaskRecord) => void } = {}
  ): Promise<TaskRecord> {
    let task = await this.deps.taskStore.requireTask(taskId);
    const maxSteps = 50;
    for (let i = 0; i < maxSteps; i++) {
      const fromState = task.workflowState;
      this.invokeObserver(opts.onBeforeStep, fromState, "onBeforeStep");
      switch (fromState) {
        case "TASK_CREATED":
        case "ANALYZING": // ANALYZING only appears here after `retry` recovers a FAILED task — see analyze()
          task = await this.analyze(task.id);
          break;
        case "IMPLEMENTING":
          task = await this.implement(task.id);
          break;
        case "TESTING":
          task = await this.test(task.id);
          break;
        case "REVIEWING":
          task = await this.review(task.id);
          break;
        case "FIXING":
          task = await this.fix(task.id);
          break;
        case "VERIFYING":
          task = await this.finalVerify(task.id);
          break;
        case "PLAN_READY":
          task = await this.submitForApproval(task.id);
          break;
        default:
          return task; // AWAITING_APPROVAL, PAUSED, READY, FAILED, CANCELLED, BLOCKED, IDLE
      }
      this.invokeObserverWithTask(opts.onAfterStep, fromState, task, "onAfterStep");
    }
    return task;
  }

  // ---- internals --------------------------------------------------------

  /** Runs a `run()` observer callback, catching (and logging, never silently swallowing) anything
   *  it throws — see `run()`'s doc comment for why this must never affect workflow progression. */
  private invokeObserver(fn: ((state: WorkflowState) => void) | undefined, state: WorkflowState, label: string): void {
    if (!fn) return;
    try {
      fn(state);
    } catch (err) {
      this.deps.logger.warn("run() observer callback threw and was ignored", {
        operation: label,
        workflowState: state,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /** Same contract as `invokeObserver`, for the `onAfterStep(from, task)` shape — see `run()`'s
   *  doc comment for why `task` is cloned before the observer ever sees it. */
  private invokeObserverWithTask(
    fn: ((from: WorkflowState, task: TaskRecord) => void) | undefined,
    from: WorkflowState,
    task: TaskRecord,
    label: string
  ): void {
    if (!fn) return;
    try {
      fn(from, structuredClone(task));
    } catch (err) {
      this.deps.logger.warn("run() observer callback threw and was ignored", {
        operation: label,
        workflowState: from,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async submitForApproval(taskId: string): Promise<TaskRecord> {
    return this.withTaskLock(taskId, async () => {
      let task = await this.deps.taskStore.requireTask(taskId);
      if (task.workflowState !== "PLAN_READY") return task; // already moved on by a concurrent caller
      task = this.deps.workflow.apply(task, "submit_for_approval", "system");
      return this.persist(task);
    });
  }

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.deps.taskStore.withLock(taskId, fn);
  }

  private async loadAndCheckDivergence(taskId: string): Promise<TaskRecord> {
    const task = await this.deps.taskStore.requireTask(taskId);
    if (!task.git.lastKnownCommit) return task;
    const cwd = task.git.worktreePath ?? task.workspaceFolder;
    let actual: string;
    try {
      actual = await this.deps.gitRepo.currentCommit(cwd);
    } catch {
      return task; // worktree missing entirely is a different failure mode; let the step itself surface it
    }
    if (actual !== task.git.lastKnownCommit) {
      throw new GitStateDivergedError(taskId, task.git.lastKnownCommit, actual);
    }
    return task;
  }

  private assertState(task: TaskRecord, allowed: WorkflowState[]): void {
    if (!allowed.includes(task.workflowState)) throw new IllegalTaskStateError(task.id, task.workflowState, allowed);
  }

  /** Persists the task and returns the (possibly lastKnownCommit-refreshed) record — always reassign `task = await this.persist(task)`. */
  private async persist(task: TaskRecord): Promise<TaskRecord> {
    let toSave = task;
    const cwd = task.git.worktreePath ?? task.workspaceFolder;
    try {
      const actual = await this.deps.gitRepo.currentCommit(cwd);
      if (actual !== task.git.lastKnownCommit) {
        toSave = { ...task, git: { ...task.git, lastKnownCommit: actual } };
      }
    } catch {
      // Worktree may not exist (pre-creation) or may have been removed; don't block persistence on it.
    }
    await this.deps.taskStore.save(toSave);
    this.deps.logger.info("task_state", { taskId: toSave.id, workflowState: toSave.workflowState, operation: "persist" });
    if (this.deps.projectConfig?.writeTaskSummaries !== false) {
      await writeTaskSummary(toSave).catch((err) =>
        this.deps.logger.warn("failed to write .ai/tasks summary", { taskId: toSave.id, error: String(err) })
      );
    }
    return toSave;
  }

  /** HistoryEvent.actor only distinguishes "human" from "system"/a provider role; the actual identity goes into detail text. */
  private attribute(by: string, note?: string): string {
    return note ? `${by}: ${note}` : by;
  }

  private describeFailure(result: AgentResult): string {
    return result.error?.message ?? `agent run ended with status "${result.status}"`;
  }

  /**
   * Distinguishes "genuinely failing" from "a required repository-configured check is simply
   * waiting on the one-time human approval it hasn't received yet" (see docs/security.md#c1 and
   * CommandApprovalStore) — used by both test() and finalVerify() immediately after computing
   * `verificationPassed()`, and deliberately BEFORE either one applies its failure trigger
   * (`tests_failed`/`verified_fail`). A second independent review found that checking for this
   * only after the fact (once `run()` had already driven the task through FIXING, possibly all
   * the way to BLOCKED) was too late: a test_fix iteration was already spent and the fixer/
   * verifier had already been invoked for something neither has any authority to resolve.
   *
   * A verification report's `NOT_APPROVED` status alone conflates two different situations:
   *   - a check that has genuinely never been approved (the common case — a human just needs to
   *     run `ai approve-check`), and
   *   - a check that IS approved (the approval store says so) but is still blocked for another
   *     reason — e.g. it also matches the security denylist (see @ai-engine/verification's
   *     runner.ts, which checks the denylist *before* ever consulting the approval store, so an
   *     approved-but-denylisted command stays `NOT_APPROVED` forever; `approveVerificationCommand`
   *     cannot and does not override the denylist).
   *
   * Only the first is something a one-time approval can resolve, so only the first pauses here.
   * The second is a genuine, permanent failure and must fall through to the ordinary
   * `tests_failed`/`verified_fail` -> FIXING -> ... -> BLOCKED path exactly like any other
   * failing check — otherwise a check a human already (mistakenly) tried to approve would just
   * pause again forever. Consulting the approval store's CURRENT state here, rather than trusting
   * the historical report result alone, is what makes that distinction possible, and is also
   * what stops an already-approved check from ever being flagged a second time (see guided.ts's
   * matching fix in its own, independent detection layer).
   */
  private async requiredChecksAwaitingApproval(report: VerificationReport, checks: VerificationCheck[]): Promise<string[]> {
    const requiredIds = new Set(checks.filter((c) => c.requiredForReady).map((c) => c.id));
    const awaiting: string[] = [];
    for (const r of report.results) {
      if (r.status !== "NOT_APPROVED" || !requiredIds.has(r.checkId)) continue;
      const check = checks.find((c) => c.id === r.checkId);
      if (check && !(await this.deps.commandApprovalStore.isApproved(check.command))) awaiting.push(r.checkId);
    }
    return awaiting;
  }

  /** additionalChecks from .ai/project.yaml (repository_configured, gated by explicit approval) merged with disabled-check exemption (see docs/troubleshooting.md — verification.disable). */
  private applyVerificationOverrides(autoChecks: VerificationCheck[], cwd: string): { checks: VerificationCheck[]; disabledIds: string[] } {
    const disabledIds = this.deps.projectConfig?.verification.disable ?? [];
    const extra: VerificationCheck[] = (this.deps.projectConfig?.verification.additionalChecks ?? []).map((c) => ({
      ...c,
      cwd: c.cwd ?? cwd,
      origin: "repository_configured" as const
    }));
    const checks = [...autoChecks, ...extra].map((c) => (disabledIds.includes(c.id) ? { ...c, requiredForReady: false } : c));
    return { checks, disabledIds };
  }

  private planContextBlocks(task: TaskRecord): ContextBlock[] {
    const blocks: ContextBlock[] = [];
    if (task.specification)
      blocks.push({ trust: "agent_generated", label: "specification (produced by architect)", content: task.specification });
    if (task.plan)
      blocks.push({ trust: "agent_generated", label: "plan (produced by architect, approved by operator)", content: task.plan });
    return blocks;
  }

  private buildFixContext(task: TaskRecord): ContextBlock[] {
    const blocks: ContextBlock[] = [];
    const latestVerification = task.verification.at(-1);
    if (latestVerification) {
      const failing = latestVerification.results.filter((r) => r.status === "FAIL");
      if (failing.length > 0) {
        blocks.push({
          trust: "command_output",
          label: "failing verification checks",
          content: failing.map((f) => `# ${f.checkId}${f.reason ? `: ${f.reason}` : ""}\n${truncate(f.output ?? "", 2000)}`).join("\n\n")
        });
      }
    }
    const openFindings: ReviewFinding[] = task.reviews.flatMap((r) => r.findings.filter((f) => f.status === "open"));
    if (openFindings.length > 0) {
      // Numbered and explicitly counted so the implementer can't lose track of how many there
      // are — an audit found a fix() pass silently addressing only one of several open findings
      // while still reporting overall success. Numbering doesn't guarantee every one gets
      // addressed (that's an agent-behavior question, not something this context block can force),
      // but it removes "I didn't realize there was more than one" as a possible cause.
      blocks.push({
        trust: "agent_generated",
        label: `open review findings (${openFindings.length} total — address every one)`,
        content: openFindings
          .map(
            (f, i) =>
              `${i + 1}/${openFindings.length}. [${f.severity}] ${f.summary}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}\n${f.detail}${
                f.suggestedFix ? `\nSuggested fix: ${f.suggestedFix}` : ""
              }`
          )
          .join("\n\n")
      });
    }
    if (blocks.length === 0) {
      blocks.push({
        trust: "trusted_system",
        label: "note",
        content: "No specific failing checks or open findings were recorded; re-examine the implementation for correctness."
      });
    }
    return blocks;
  }

  private async buildRequest(
    task: TaskRecord,
    role: string,
    opts: { instructions: string; context: ContextBlock[]; outputSchema?: Record<string, unknown> }
  ): Promise<AgentInvocationRequest> {
    const defaults = sandboxDefaultsForRole(role);
    const workingDirectory = task.git.worktreePath ?? task.workspaceFolder;

    // checkPath is genuinely wired into the execution path here (not merely unit-tested in
    // isolation): it confirms the worktree we're about to hand a provider still *resolves* to
    // itself and stays within known roots, catching e.g. a worktree directory (or a path
    // component of it) having been replaced by a symlink between task creation and this
    // invocation. See docs/security.md.
    const pathCheck = await this.deps.securityPolicy.checkPath(workingDirectory, [this.deps.paths.worktreesDir, this.repoRoot]);
    if (!pathCheck.allowed) {
      throw new WorkspaceConfinementError(task.id, workingDirectory, pathCheck.reason);
    }

    // The resume session recorded for this role is only ever handed back to the provider that
    // created it — if the role's provider assignment has since changed (edited config, a project
    // override, a future remapping), the new provider must start a fresh session rather than be
    // handed a native session id it never created. See ProviderSessionRef in @ai-engine/core.
    const providerId = this.deps.roleRegistry.resolveProviderId(role);
    const session = task.providerSessions[role];
    const sameProviderSession = session?.providerId === providerId;
    const resumeSessionId = sameProviderSession ? session.sessionId : undefined;
    // The cumulative-usage baseline is tied to the exact same (provider, session) pair as the
    // resume itself — never carried forward across a provider reassignment or a fresh session,
    // for the identical reason resumeSessionId isn't (see ProviderSessionRef in @ai-engine/core).
    const previousCumulativeUsage = sameProviderSession ? session.cumulativeUsageBaseline : undefined;

    return {
      taskId: task.id,
      role,
      systemPrompt: systemPromptForRole(role),
      instructions: opts.instructions,
      context: opts.context,
      workingDirectory,
      sandbox: defaults.sandbox,
      approval: defaults.approval,
      outputSchema: opts.outputSchema,
      resumeSessionId,
      previousCumulativeUsage,
      timeoutMs: this.deps.globalConfig.workflow.roleTimeoutMs,
      maxCostUsd: this.deps.globalConfig.budgets.maxCostUsdPerTask
    };
  }

  private checkBudget(task: TaskRecord, role: string): void {
    const maxPerRole = this.deps.globalConfig.budgets.maxInvocationsPerRolePerTask[role];
    if (maxPerRole !== undefined && (task.roleInvocationCounts[role] ?? 0) >= maxPerRole) {
      throw new BudgetExceededError(
        task.id,
        `role "${role}" has already been invoked ${task.roleInvocationCounts[role] ?? 0} time(s), at or above the configured limit of ${maxPerRole} (budgets.maxInvocationsPerRolePerTask)`
      );
    }
    const maxCost = this.deps.globalConfig.budgets.maxCostUsdPerTask;
    if (maxCost !== undefined && (task.usage.totalCostUsd ?? 0) >= maxCost) {
      throw new BudgetExceededError(
        task.id,
        `task has already spent $${(task.usage.totalCostUsd ?? 0).toFixed(4)} (as reported by cost-tracking providers), at or above the configured limit of $${maxCost} (budgets.maxCostUsdPerTask). Note: only providers that report cost (currently Claude) contribute to this total.`
      );
    }
  }

  private async invokeRole(
    task: TaskRecord,
    role: string,
    request: AgentInvocationRequest
  ): Promise<{ result: AgentResult; providerId: string }> {
    this.checkBudget(task, role);
    const adapter = this.deps.roleRegistry.adapterForRole(role);
    const roleLogger = this.deps.logger.child({ taskId: task.id, role, providerId: adapter.id, workflowState: task.workflowState });
    const run = adapter.invoke(request);

    (async () => {
      for await (const event of run.events) {
        roleLogger.debug("agent_event", { event });
        const verdict = this.deps.securityPolicy.evaluateEvent(event, request.approval);
        if (verdict.action === "terminate") {
          roleLogger.error("security policy terminated the run", { reason: verdict.reason });
          run.cancel(verdict.reason);
        } else if (verdict.action === "warn") {
          roleLogger.warn('security policy flagged a denied-pattern command but continued (approval policy is not "never")', {
            reason: verdict.reason
          });
        }
      }
    })().catch((err) => roleLogger.error("error while consuming agent event stream", { error: String(err) }));

    const result = await run.result;
    roleLogger.info("agent_run_completed", { status: result.status, usage: result.usage });
    return { result, providerId: adapter.id };
  }

  /**
   * `operation` distinguishes invocations that share a role but mean
   * something different for telemetry purposes — concretely, fix() invokes
   * the same "implementer" role as implement() (see UsageEvent in
   * @ai-engine/core for why this exists instead of a dedicated workflow
   * role). `usage`/`agentsUsed`/`roleInvocationCounts` below are pre-existing
   * task-level bookkeeping (used for budget enforcement) and are untouched;
   * `usageEvents` is the new, fully-attributed, append-only log that
   * provider/role/operation breakdowns are derived from. `result.usage` is
   * always "what this invocation alone consumed" (already converted from any
   * provider-native cumulative reporting by the adapter itself — see
   * ObservedUsage/`cumulativeUsageBaseline` — never the raw cumulative number),
   * so it's safe to log verbatim into `usageEvents` and accumulate into
   * `usage` below without any further conversion here. `cumulativeUsageBaseline`
   * is separate, orchestrator-only bookkeeping (persisted onto the session
   * ref, not into `usageEvents`) so the *next* resume of this exact session
   * can perform that same conversion correctly.
   */
  private recordAgentUsage(task: TaskRecord, role: string, providerId: string, result: AgentResult, operation: string): TaskRecord {
    const alreadyUsed = task.agentsUsed.some((a) => a.role === role && a.providerId === providerId);
    const usage: TaskUsage = { ...task.usage };
    if (result.usage?.costUsd !== undefined) usage.totalCostUsd = (usage.totalCostUsd ?? 0) + result.usage.costUsd;
    if (result.usage?.inputTokens !== undefined) usage.totalInputTokens = (usage.totalInputTokens ?? 0) + result.usage.inputTokens;
    if (result.usage?.outputTokens !== undefined) usage.totalOutputTokens = (usage.totalOutputTokens ?? 0) + result.usage.outputTokens;

    const usageEvent: UsageEvent = { at: new Date().toISOString(), providerId, role, operation, usage: result.usage ?? {} };

    return {
      ...task,
      agentsUsed: alreadyUsed ? task.agentsUsed : [...task.agentsUsed, { role, providerId }],
      providerSessions: result.providerSessionId
        ? {
            ...task.providerSessions,
            [role]: { providerId, sessionId: result.providerSessionId, cumulativeUsageBaseline: result.cumulativeUsageBaseline }
          }
        : task.providerSessions,
      roleInvocationCounts: { ...task.roleInvocationCounts, [role]: (task.roleInvocationCounts[role] ?? 0) + 1 },
      usage,
      usageEvents: [...task.usageEvents, usageEvent]
    };
  }
}
