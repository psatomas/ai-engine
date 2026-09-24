#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import {
  createOrchestrator,
  initProject,
  DelegatedRunStore,
  IllegalTaskStateError,
  EmptyRepositoryError,
  GitStateDivergedError,
  BudgetExceededError,
  WorkspaceConfinementError
} from "@ai-engine/orchestrator";
import type { CapacityFreshnessPolicy } from "@ai-engine/core";
import { resolveEnginePaths, loadGlobalConfig } from "@ai-engine/config";
import { TaskLockedError } from "@ai-engine/security";
import {
  formatDelegatedRunStatus,
  formatFindings,
  formatProviderSummaries,
  formatStaleReleaseOutcome,
  formatTaskDetail,
  formatTaskLine,
  formatTaskUsage,
  formatVerificationChecks,
  formatVerificationResults
} from "./format.js";
import { runGuided, createRealIO, NonInteractiveApprovalRequiredError } from "./guided.js";
import { parseMaxAge } from "./max-age.js";

const program = new Command();
program.name("ai").description("AI Engine — provider-independent AI software-engineering orchestration control plane.").version("0.1.0");

/**
 * Exit codes are meaningful, not uniformly 1, so scripts driving `ai` can
 * distinguish "there's nothing to do" from "something is actively wrong":
 *   1 generic/unexpected error
 *   2 unknown task id
 *   3 illegal workflow state for the requested step
 *   4 task locked by another process (try again shortly)
 *   5 git/task-state divergence detected (needs acknowledge-divergence)
 *   6 budget (cost/invocation-count) exceeded
 *   7 workspace-confinement check failed
 *   8 repository has no commits yet
 */
function exitCodeFor(err: unknown): number {
  if (err instanceof IllegalTaskStateError) return 3;
  if (err instanceof TaskLockedError) return 4;
  if (err instanceof GitStateDivergedError) return 5;
  if (err instanceof BudgetExceededError) return 6;
  if (err instanceof WorkspaceConfinementError) return 7;
  if (err instanceof EmptyRepositoryError) return 8;
  if (err instanceof Error && /^Unknown task /.test(err.message)) return 2;
  return 1;
}

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = exitCodeFor(err);
  process.exit(process.exitCode);
}

program
  .command("init")
  .description("Initialize the .ai/ project structure in the current repository")
  .option("--name <name>", "project name (defaults to the directory name)")
  .option("--description <description>", "short project description")
  .action(async (opts: { name?: string; description?: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const name = opts.name ?? orchestrator.repoRoot.split("/").filter(Boolean).at(-1) ?? "project";
      const result = await initProject(orchestrator.repoRoot, { name, description: opts.description });
      console.log(result.created ? `Initialized .ai/ at ${result.path}` : `.ai/project.yaml already exists at ${result.path}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("start <request...>")
  .description(
    "Guided mode (recommended): create a task and drive it to a terminal state automatically, prompting only for the human decisions that actually require judgment (plan approval, security review, a FAILED retry). Everything below this command still works standalone for scripting, debugging, recovery, and advanced control."
  )
  .option("--by <name>", "identity recorded for any approvals made during this run", "operator")
  .option(
    "--verbose",
    "show full structured debug/provider-event logging on the console (the default is concise progress only; nothing is ever omitted from the log file either way)"
  )
  .action(async (requestParts: string[], opts: { by: string; verbose?: boolean }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd(), opts.verbose ? {} : { consoleLogLevel: "warn" });
      const io = createRealIO();
      await runGuided(orchestrator, requestParts.join(" "), io, opts.by);
    } catch (err) {
      if (err instanceof NonInteractiveApprovalRequiredError) {
        process.stderr.write(`error: ${err.message}\n`);
        process.exitCode = 1;
        process.exit(1);
      }
      fail(err);
    }
  });

program
  .command("task <request...>")
  .description("Create a new task from a natural-language request (manual/low-level — see `ai start` for the guided equivalent)")
  .action(async (requestParts: string[]) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.createTask(requestParts.join(" "));
      console.log(formatTaskLine(task));
      console.log(`worktree: ${task.git.worktreePath}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("plan <taskId>")
  .description("Run analysis + planning (architect role); submits for approval unless disabled")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.analyze(taskId);
      console.log(formatTaskDetail(task));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("approve <taskId>")
  .description("Approve or reject a task's plan (AWAITING_APPROVAL)")
  .option("--reject", "reject the plan instead of approving it")
  .option("--by <name>", "identity recorded as the approver", "operator")
  .option("--note <note>", "optional note")
  .action(async (taskId: string, opts: { reject?: boolean; by: string; note?: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.decidePlan(taskId, opts.reject ? "rejected" : "approved", opts.by, opts.note);
      console.log(formatTaskDetail(task));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("gate <taskId> <gate>")
  .description('Resolve a pending approval gate (e.g. "security_review")')
  .option("--reject", "reject instead of approve")
  .option("--by <name>", "identity recorded as the approver", "operator")
  .option("--note <note>", "optional note")
  .action(async (taskId: string, gate: string, opts: { reject?: boolean; by: string; note?: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.decideGate(taskId, gate, opts.reject ? "rejected" : "approved", opts.by, opts.note);
      console.log(formatTaskDetail(task));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("implement <taskId>")
  .description("Run the implementer role (IMPLEMENTING -> TESTING)")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.implement(taskId);
      console.log(formatTaskDetail(task));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("verify <taskId>")
  .description("Run verification for the task's current stage (post-implementation tests, or final verification)")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.getTask(taskId);
      if (!task) throw new Error(`Unknown task "${taskId}"`);
      const updated = task.workflowState === "VERIFYING" ? await orchestrator.finalVerify(taskId) : await orchestrator.test(taskId);
      console.log(formatTaskDetail(updated));
      console.log("");
      console.log(formatVerificationResults(updated.verification.at(-1)?.results ?? []));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("checks <taskId>")
  .description("List verification checks configured for a task, including approval status for repository-configured ones")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      console.log(formatVerificationChecks(await orchestrator.listVerificationChecks(taskId)));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("approve-check <taskId> <checkId>")
  .description(
    "Explicitly approve a repository-configured verification command (.ai/project.yaml) before it is ever allowed to run — the same mechanism the VS Code extension uses"
  )
  .option("--by <name>", "identity recorded as the approver", "operator")
  .option("--note <note>", "optional note (e.g. why you reviewed and trust this command)")
  .action(async (taskId: string, checkId: string, opts: { by: string; note?: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const { command, cwd } = await orchestrator.approveVerificationCommand(taskId, checkId, opts.by, opts.note);
      // cwd is bound into this approval's identity (see docs/security.md) — always shown, not
      // just when non-default, so the confirmation reflects exactly what was authorized.
      console.log(`Approved "${checkId}": ${command}${cwd ? ` (cwd: ${cwd})` : ""}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("review <taskId>")
  .description("Run independent review + security review (REVIEWING)")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.review(taskId);
      console.log(formatTaskDetail(task));
      console.log("");
      console.log(formatFindings(task.reviews.flatMap((r) => r.findings)));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("fix <taskId>")
  .description("Address open findings / failing checks (FIXING -> TESTING)")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.fix(taskId);
      console.log(formatTaskDetail(task));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("run <taskId>")
  .description("Drive the task forward automatically until it needs a human (approval gate) or reaches a terminal state")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.run(taskId);
      console.log(formatTaskDetail(task));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("pause <taskId>")
  .option("--by <name>", "identity", "operator")
  .action(async (taskId: string, opts: { by: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      console.log(formatTaskDetail(await orchestrator.pause(taskId, opts.by)));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("resume <taskId>")
  .option("--by <name>", "identity", "operator")
  .action(async (taskId: string, opts: { by: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      console.log(formatTaskDetail(await orchestrator.resume(taskId, opts.by)));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("retry <taskId>")
  .description("Recover a FAILED task back to the step it failed at (e.g. after a transient provider error) — itself iteration-guarded")
  .option("--by <name>", "identity", "operator")
  .option("--note <note>", "optional note (e.g. why this looked transient)")
  .action(async (taskId: string, opts: { by: string; note?: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      console.log(formatTaskDetail(await orchestrator.retry(taskId, opts.by, opts.note)));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("cancel <taskId>")
  .option("--by <name>", "identity", "operator")
  .option("--note <note>")
  .action(async (taskId: string, opts: { by: string; note?: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      console.log(formatTaskDetail(await orchestrator.cancel(taskId, opts.by, opts.note)));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("acknowledge-divergence <taskId>")
  .description(
    "Accept the worktree's current commit as the new known-good state after a git/task-state divergence error. Inspect `ai diff <taskId>` first."
  )
  .option("--by <name>", "identity", "operator")
  .option("--note <note>", "optional note")
  .action(async (taskId: string, opts: { by: string; note?: string }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      console.log(formatTaskDetail(await orchestrator.acknowledgeDivergence(taskId, opts.by, opts.note)));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status [taskId]")
  .description("Show a single task's status, or list all tasks for the current repository")
  .action(async (taskId?: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      if (taskId) {
        const task = await orchestrator.getTask(taskId);
        if (!task) throw new Error(`Unknown task "${taskId}"`);
        console.log(formatTaskDetail(task));
      } else {
        const tasks = await orchestrator.listTasks();
        if (tasks.length === 0) console.log('(no tasks yet — try `ai task "<request>"`)');
        for (const t of tasks) console.log(formatTaskLine(t));
      }
    } catch (err) {
      fail(err);
    }
  });

const delegatedRun = program
  .command("delegated-run")
  .description("Inspect and recover MCP-delegated (submit_task/decide_task) work for the current repository");
delegatedRun
  .command("status")
  .description("Show this repository's current delegated-run activity, if any (read-only — never changes anything)")
  .action(async () => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const store = new DelegatedRunStore(orchestrator.repoRoot, resolveEnginePaths().dataDir);
      console.log(formatDelegatedRunStatus(await store.currentActivity()));
    } catch (err) {
      fail(err);
    }
  });
delegatedRun
  .command("release-stale")
  .description(
    "Recover a delegated-run lock left behind by a worker that died before it could release ownership (a killed " +
      "terminal, a crash, a reboot). Releases ONLY when the recorded worker is conclusively confirmed no longer " +
      "running on this machine; a live or indeterminate (e.g. different-host) owner is always refused. Never kills " +
      "any process — this only ever removes AI Engine's own bookkeeping of an already-dead worker. Automatic " +
      "stale-lock stealing remains deliberately disabled; this is the explicit, human-initiated alternative."
  )
  .action(async () => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const store = new DelegatedRunStore(orchestrator.repoRoot, resolveEnginePaths().dataDir);
      console.log(formatStaleReleaseOutcome(await store.releaseStale()));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("usage <taskId>")
  .description(
    "Show observed usage for a task, broken down by provider and role (fixer invocations shown separately from implementer) — derived from persisted per-invocation telemetry, never reconstructed from logs"
  )
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const task = await orchestrator.getTask(taskId);
      if (!task) throw new Error(`Unknown task "${taskId}"`);
      console.log(formatTaskUsage(task));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("diff <taskId>")
  .description("Show the task's current diff against its baseline commit")
  .action(async (taskId: string) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const diff = await orchestrator.currentDiff(taskId);
      console.log(diff.raw || "(no changes)");
      if (diff.suspiciousFiles.length) {
        console.error(`\n⚠ suspicious paths touched: ${diff.suspiciousFiles.join(", ")}`);
      }
    } catch (err) {
      fail(err);
    }
  });

/** Commander parses `--max-age` at option-parse time, so a bad value is a usage error before any provider is probed. */
function maxAgeOption(text: string): CapacityFreshnessPolicy {
  try {
    return parseMaxAge(text);
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
  }
}

program
  .command("providers")
  .description(
    "List every registered provider generically (id, capabilities, currently-assigned roles, live availability, capacity windows) — never hardcodes which providers exist"
  )
  .option(
    "--max-age <duration>",
    "also judge each capacity window's observation age against this explicit limit, <int><s|m|h|d> (e.g. 15m); without it no freshness verdict is shown",
    maxAgeOption
  )
  .action(async (opts: { maxAge?: CapacityFreshnessPolicy }) => {
    try {
      const orchestrator = await createOrchestrator(process.cwd());
      const summaries = await orchestrator.listProviders();
      // The one clock reading for this run: every provider and window is presented at this same instant.
      const nowMs = Date.now();
      console.log(formatProviderSummaries(summaries, { nowMs, freshnessPolicy: opts.maxAge }));
    } catch (err) {
      fail(err);
    }
  });

const config = program.command("config").description("Inspect the global AI Engine configuration");
config
  .command("path")
  .description("Print resolved global config/data paths")
  .action(() => {
    const paths = resolveEnginePaths();
    for (const [k, v] of Object.entries(paths)) console.log(`${k}: ${v}`);
  });
config
  .command("show")
  .description("Print the effective global configuration (YAML defaults merged with your config file)")
  .action(async () => {
    const cfg = await loadGlobalConfig();
    console.log(JSON.stringify(cfg, null, 2));
  });

program.parseAsync(process.argv).catch(fail);
