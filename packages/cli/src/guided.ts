import { createInterface } from "node:readline/promises";
import type { DiffSummary } from "@ai-engine/git";
import type { ReviewFinding, ReviewReport, TaskRecord, VerificationCheck, VerificationResult, WorkflowState } from "@ai-engine/core";

/**
 * The exact subset of Orchestrator's public surface `runGuided` depends on — kept narrow and
 * structural (not `import type { Orchestrator }`) so a test can supply a plain mock object
 * without constructing a real Orchestrator (real git repo, real config, real provider
 * adapters). The real `ai start` command in bin.ts passes an actual Orchestrator, which
 * already satisfies this shape.
 */
export interface GuidedOrchestrator {
  createTask(request: string): Promise<TaskRecord>;
  run(
    taskId: string,
    opts?: { onBeforeStep?: (state: WorkflowState) => void; onAfterStep?: (from: WorkflowState, task: TaskRecord) => void }
  ): Promise<TaskRecord>;
  decidePlan(taskId: string, decision: "approved" | "rejected", by: string, note?: string): Promise<TaskRecord>;
  decideGate(taskId: string, gate: string, decision: "approved" | "rejected", by: string, note?: string): Promise<TaskRecord>;
  retry(taskId: string, by: string, note?: string): Promise<TaskRecord>;
  resume(taskId: string, by: string): Promise<TaskRecord>;
  currentDiff(taskId: string): Promise<DiffSummary>;
  providerIdForRole(role: string): string;
  listVerificationChecks(taskId: string): Promise<Array<VerificationCheck & { approved: boolean }>>;
  approveVerificationCommand(taskId: string, checkId: string, by: string, note?: string): Promise<{ command: string }>;
}

/**
 * The terminal I/O boundary `runGuided` talks to — real stdin/stdout in production
 * (`createRealIO`), a scripted fake in tests. Keeping this as an explicit, injectable
 * interface (rather than `runGuided` calling `console.log`/readline directly) is what makes
 * every one of the guided-flow tests possible without a real TTY or a real subprocess.
 *
 * `isInteractive` is advisory metadata about the underlying I/O, not an enforcement
 * mechanism — `confirm()` itself is not required to refuse when it's false. A second
 * independent review found that relying on each `GuidedIO` implementation to self-police this
 * meant a *different* implementation could set `isInteractive: false` and still have
 * `confirm()` return `true`. Enforcement now lives in guided mode itself — see
 * `requireInteractiveConfirmation` below, which every human-decision call site in this file
 * goes through instead of calling `io.confirm()` directly. `createRealIO()`'s own `confirm`
 * still refuses defensively too, as a second, redundant layer.
 */
export interface GuidedIO {
  write(line?: string): void;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** A single free-text line prompt — used only by the optional "Next actions" menu shown at
   *  READY, never for an approval decision (those always go through `confirm`, gated by
   *  `requireInteractiveConfirmation`). Kept separate from `confirm` so a test can fake this
   *  menu's input without needing a real readline interface. */
  promptLine(prompt: string): Promise<string>;
  readonly isInteractive: boolean;
}

/** Thrown instead of ever silently treating "no terminal to ask" as an answer. */
export class NonInteractiveApprovalRequiredError extends Error {
  constructor(question: string) {
    super(
      `"${question}" requires an interactive terminal to answer safely, and stdin/stdout here isn't one. ` +
        "Guided mode never auto-approves a human decision. Resolve this task with the low-level commands instead " +
        "(see `ai status <taskId>` for exactly which one)."
    );
    this.name = "NonInteractiveApprovalRequiredError";
  }
}

/**
 * The single gate every human-decision prompt in this file goes through. Refuses — rather than
 * ever forwarding to `io.confirm()` — when `io.isInteractive` is false, regardless of what a
 * given `GuidedIO` implementation's own `confirm()` would have returned. This is what makes
 * "guided mode never silently approves a human decision" a property of guided mode itself, not
 * something each `GuidedIO` implementation has to individually get right.
 */
async function requireInteractiveConfirmation(io: GuidedIO, question: string, defaultYes: boolean): Promise<boolean> {
  if (!io.isInteractive) throw new NonInteractiveApprovalRequiredError(question);
  return io.confirm(question, defaultYes);
}

export function createRealIO(): GuidedIO {
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    write(line = "") {
      console.log(line);
    },
    isInteractive,
    async confirm(question, defaultYes) {
      if (!isInteractive) throw new NonInteractiveApprovalRequiredError(question);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const suffix = defaultYes ? "[Y/n]" : "[y/N]";
        const raw = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
        if (raw === "") return defaultYes;
        return raw === "y" || raw === "yes";
      } finally {
        rl.close();
      }
    },
    async promptLine(prompt) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    }
  };
}

function displayProvider(providerId: string): string {
  return providerId.length ? providerId[0]!.toUpperCase() + providerId.slice(1) : providerId;
}

/** Progress narration shown *before* the step for that state runs — see Orchestrator.run's
 *  `onBeforeStep`. Only states that actually invoke a role get a line; a state with no entry
 *  here (e.g. PLAN_READY, an instant internal transition) is silently skipped. */
function progressLineFor(state: WorkflowState, orchestrator: GuidedOrchestrator): string | undefined {
  switch (state) {
    case "TASK_CREATED":
    case "ANALYZING":
      return `${displayProvider(orchestrator.providerIdForRole("architect"))} is analyzing the repository...`;
    case "IMPLEMENTING":
      return `${displayProvider(orchestrator.providerIdForRole("implementer"))} is implementing...`;
    case "TESTING":
      return "Running verification...";
    case "REVIEWING":
      return `${displayProvider(orchestrator.providerIdForRole("reviewer"))} is reviewing...`;
    case "FIXING":
      return `${displayProvider(orchestrator.providerIdForRole("implementer"))} is fixing review findings...`;
    case "VERIFYING":
      return `${displayProvider(orchestrator.providerIdForRole("verifier"))} is performing final verification...`;
    default:
      return undefined;
  }
}

function verificationIcon(status: VerificationResult["status"]): string {
  return status === "PASS" ? "✓" : status === "SKIPPED" || status === "NOT_CONFIGURED" ? "⏭" : status === "NOT_APPROVED" ? "🔒" : "✗";
}

/** Outcome line(s) shown *after* the step for `from` completes — derived from the fresh task,
 *  not tracked separately, so this can never drift from what actually happened. Only reports
 *  on the steps that have something worth a one-line outcome; states not listed print nothing
 *  extra (the next progress line, or the outer loop's own state handling, follows directly). */
function outcomeLinesFor(from: WorkflowState, task: TaskRecord, io: GuidedIO): void {
  switch (from) {
    case "IMPLEMENTING":
      if (task.workflowState === "TESTING") io.write("✓ Implementation complete");
      return;
    case "TESTING": {
      if (task.workflowState !== "REVIEWING") return;
      const latest = task.verification.at(-1);
      for (const r of latest?.results ?? []) {
        if (r.status === "NOT_CONFIGURED") continue; // nothing to report — never configured, not a result
        io.write(`${verificationIcon(r.status)} ${r.checkId}`);
      }
      return;
    }
    case "REVIEWING": {
      if (task.workflowState !== "PAUSED" && task.workflowState !== "VERIFYING") return;
      for (const r of task.reviews.slice(-2)) {
        const label = r.role === "security_reviewer" ? "Security review" : "Code review";
        io.write(`${r.verdict === "approved" ? "✓" : "✗"} ${label} ${r.verdict === "approved" ? "approved" : "requested changes"}`);
      }
      return;
    }
    default:
      return;
  }
}

function renderFindings(reviews: ReviewReport[], io: GuidedIO): void {
  const findings: ReviewFinding[] = reviews.flatMap((r) => r.findings);
  if (findings.length === 0) return;
  io.write("");
  for (const f of findings) {
    io.write(`  [${f.severity}] (${f.status}) ${f.summary}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`);
  }
}

async function nextActionsMenu(orchestrator: GuidedOrchestrator, taskId: string, io: GuidedIO): Promise<void> {
  if (!io.isInteractive) return; // nothing required here — READY is already a successful stop
  io.write("");
  io.write("Next actions:");
  io.write("  [d] View diff");
  io.write("  [s] Show status");
  io.write("  [q] Exit");
  for (;;) {
    const answer = (await io.promptLine("> ")).trim().toLowerCase();
    if (answer === "d") {
      const diff = await orchestrator.currentDiff(taskId);
      io.write(diff.raw || "(no changes)");
    } else if (answer === "s") {
      io.write(`Task ${taskId} — READY`);
    } else {
      return;
    }
  }
}

/**
 * If the task's latest verification round has a *required* check sitting at `NOT_APPROVED` that
 * is not *currently* approved, that is not an implementation problem — it's a repository-
 * configured command genuinely waiting on a human, and no amount of fixer/verifier looping can
 * resolve it. `Orchestrator.test()`/`finalVerify()` now stop for exactly this themselves, before
 * ever applying `tests_failed`/`verified_fail` (see their doc comments) — a third independent
 * review found that an earlier version of this detection ran only *after* `run()` returned,
 * which was too late: by then `run()`'s own loop had already driven the task through
 * `tests_failed` -> `FIXING` -> (the fixer can't do anything about an approval it has no
 * authority to grant) -> ... -> `BLOCKED`, spending a real `test_fix` iteration and a real fixer
 * invocation on something neither could ever resolve. This function's job now is purely to
 * *narrate* that stop accurately (never as a code/implementation failure) and, interactively,
 * offer the same one-time approval — it is not what makes the pipeline stop.
 *
 * The `!check.approved` condition is what stops an already-approved check from being flagged
 * (and re-prompted, and re-approved) a second time — a third independent review found the
 * previous version of this function looked only at the historical `NOT_APPROVED` report result,
 * which never changes retroactively once written, so a check a human had already approved kept
 * showing up here forever, and `handleUnapprovedRequiredChecks` kept calling
 * `approveVerificationCommand` again for it, appending a duplicate approval record every time.
 * `check.approved` reflects the approval store's CURRENT state (see `listVerificationChecks`),
 * exactly the same "ask again, don't trust history" fix `Orchestrator.requiredChecksAwaitingApproval`
 * makes independently at the orchestrator layer.
 *
 * Detected by reading the task's *persisted* verification history after `run()` returns —
 * deliberately not via `onBeforeStep`/`onAfterStep` — those are documented, enforced-safe
 * observers of `run()`'s internal loop (see `Orchestrator.run`) and must never be given a way
 * to influence which step runs next; this check only ever reads state that's already durably
 * true regardless of how many internal steps `run()` took to get there.
 *
 * Returns the list of required-and-still-unapproved checks (empty if none), so the caller can
 * also offer to approve them immediately using the existing `approveVerificationCommand` API —
 * never a new approval mechanism, the same one `ai approve-check` already uses.
 */
async function findUnapprovedRequiredChecks(
  orchestrator: GuidedOrchestrator,
  task: TaskRecord
): Promise<Array<{ result: VerificationResult; check: VerificationCheck & { approved: boolean } }>> {
  const latest = task.verification.at(-1);
  const notApproved = latest?.results.filter((r) => r.status === "NOT_APPROVED") ?? [];
  if (notApproved.length === 0) return [];
  const checks = await orchestrator.listVerificationChecks(task.id);
  const pairs: Array<{ result: VerificationResult; check: VerificationCheck & { approved: boolean } }> = [];
  for (const result of notApproved) {
    const check = checks.find((c) => c.id === result.checkId);
    if (check?.requiredForReady && !check.approved) pairs.push({ result, check });
  }
  return pairs;
}

/**
 * Handles the situation `findUnapprovedRequiredChecks` detects. Explains it accurately (never as
 * a code/implementation failure), shows the exact low-level commands, and — only when
 * interactive — offers to approve each command right now via the existing
 * `approveVerificationCommand` API.
 *
 * Returns the task to continue driving with once every pending check is approved, or `undefined`
 * if the caller should stop here (declined, or non-interactive). Because `test()`/`finalVerify()`
 * now stop via a plain `pause` (see their doc comments) — the exact same mechanism a manual
 * `ai pause` uses, never a manufactured gate — the task sitting here is genuinely `PAUSED` with
 * no `pendingGate`, and its only legal continuation is `resume()`, same as any other gate-less
 * PAUSED task (see the `PAUSED` case in `runGuided` below). A third independent review found the
 * previous version of this function just returned a boolean and let the caller call `run()`
 * again directly — but `run()` never advances a `PAUSED` task on its own (by design: `PAUSED` is
 * a stopping point), so that either did nothing or (worse) relied on a mocked test double that
 * pretended `run()` could jump straight from `BLOCKED` to `READY`, a transition the real
 * workflow engine has no rule for at all.
 */
async function handleUnapprovedRequiredChecks(
  orchestrator: GuidedOrchestrator,
  task: TaskRecord,
  pending: Array<{ result: VerificationResult; check: VerificationCheck & { approved: boolean } }>,
  io: GuidedIO,
  by: string
): Promise<TaskRecord | undefined> {
  io.write("");
  io.write("⚠ Verification cannot proceed: a required check needs explicit human approval first.");
  io.write("This is not an implementation problem — the implementer/fixer has no authority to grant this approval.");
  io.write("");
  for (const { result, check } of pending) {
    io.write(`  ${check.id}${check.description ? ` — ${check.description}` : ""}`);
    io.write(`    ${check.command}`);
    if (result.reason) io.write(`    ${result.reason}`);
  }
  io.write("");

  if (!io.isInteractive) {
    io.write(`  ai checks ${task.id}`);
    io.write(`  ai approve-check ${task.id} <checkId>`);
    return undefined;
  }

  let allApproved = true;
  for (const { check } of pending) {
    const approve = await requireInteractiveConfirmation(io, `Approve "${check.id}" (${check.command}) now?`, false);
    if (approve) {
      await orchestrator.approveVerificationCommand(task.id, check.id, by);
      io.write(`✓ Approved ${check.id}`);
    } else {
      allApproved = false;
    }
  }
  io.write("");
  if (!allApproved) {
    io.write(`  ai checks ${task.id}`);
    io.write(`  ai approve-check ${task.id} <checkId>`);
    return undefined;
  }

  // Every pending check is now approved. The task is PAUSED with no pendingGate (see doc comment
  // above) — resume() is the one legal continuation, same as any other gate-less PAUSED task.
  // Defensive fallback for any other state (shouldn't happen via test()/finalVerify()'s pause,
  // but never assume): hand the unchanged task back and let the normal state handling below
  // (and the next `run()` call) decide what, if anything, comes next — never a manufactured leap.
  if (task.workflowState === "PAUSED" && !task.pendingGate) {
    return orchestrator.resume(task.id, by);
  }
  return task;
}

/**
 * Drives a task from creation to a terminal state, prompting the user only at the points that
 * are actually a human decision (plan approval, the security_review gate, a FAILED retry
 * offer, an unapproved required verification command). Every state-machine transition is still
 * performed by `Orchestrator.run()` / `decidePlan()` / `decideGate()` / `retry()` / `resume()` —
 * this function contains no orchestration logic of its own, only narration and prompting around
 * calls to those same methods.
 */
export async function runGuided(orchestrator: GuidedOrchestrator, request: string, io: GuidedIO, by = "operator"): Promise<TaskRecord> {
  io.write("Creating task...");
  let task = await orchestrator.createTask(request);
  io.write(`✓ Task created (${task.id})`);
  io.write("");

  const onBeforeStep = (state: WorkflowState) => {
    const line = progressLineFor(state, orchestrator);
    if (line) io.write(line);
  };
  const onAfterStep = (from: WorkflowState, updated: TaskRecord) => outcomeLinesFor(from, updated, io);

  for (;;) {
    task = await orchestrator.run(task.id, { onBeforeStep, onAfterStep });

    const unapproved = await findUnapprovedRequiredChecks(orchestrator, task);
    if (unapproved.length > 0) {
      const resolved = await handleUnapprovedRequiredChecks(orchestrator, task, unapproved, io, by);
      if (!resolved) return task;
      task = resolved; // resumed (or otherwise legally advanced) — re-run to pick it up
      continue;
    }

    switch (task.workflowState) {
      case "AWAITING_APPROVAL": {
        io.write("");
        io.write("PLAN READY");
        io.write("");
        io.write(task.plan || task.specification || "(the architect returned no plan text)");
        io.write("");
        const approved = await requireInteractiveConfirmation(io, "Approve this plan?", true);
        task = await orchestrator.decidePlan(task.id, approved ? "approved" : "rejected", by);
        io.write(approved ? "✓ Plan approved" : "Plan rejected — back to planning.");
        io.write("");
        continue;
      }

      case "PAUSED": {
        io.write("");
        if (task.pendingGate === "security_review") {
          io.write("Independent review and security review both approved.");
          renderFindings(task.reviews.slice(-2), io);
          io.write("");
          const approved = await requireInteractiveConfirmation(io, "Approve security review?", true);
          task = await orchestrator.decideGate(task.id, "security_review", approved ? "approved" : "rejected", by);
          io.write(approved ? "✓ Security review approved" : "Security review rejected — back to fixing.");
          io.write("");
          continue;
        }
        if (task.pendingGate) {
          // Future-proofing for a gate name this file doesn't have specific rendering for yet —
          // still routed through the real decideGate(), never a manufactured mechanism.
          io.write(`Task is paused for human sign-off: ${task.pendingGate}.`);
          const approved = await requireInteractiveConfirmation(io, `Approve ${task.pendingGate}?`, true);
          task = await orchestrator.decideGate(task.id, task.pendingGate, approved ? "approved" : "rejected", by);
          io.write("");
          continue;
        }
        // No pendingGate at all: this is a generic/manual pause (e.g. someone ran `ai pause`),
        // not an approval gate. A second independent review found the previous version of this
        // code substituted the string "approval" as a fake gate name and called decideGate()
        // with it — an invalid transition this workflow has no such gate for. The only legal
        // continuation from a gate-less PAUSED is `resume` (back to whatever state it was
        // paused from); there is nothing to "approve" here, so nothing is manufactured.
        io.write("Task is paused (not waiting on an approval gate).");
        io.write("");
        const shouldResume = await requireInteractiveConfirmation(io, "Resume this task?", true);
        if (!shouldResume) return task; // exit without mutating anything
        task = await orchestrator.resume(task.id, by);
        io.write("");
        continue;
      }

      case "FAILED": {
        const last = task.failures.at(-1);
        io.write("");
        io.write(`✗ FAILED${last ? ` at ${last.state}` : ""}`);
        if (last) io.write(`  ${last.message}`);
        io.write("");
        const retry = await requireInteractiveConfirmation(io, "Retry?", true);
        if (!retry) return task;
        task = await orchestrator.retry(task.id, by);
        io.write("");
        continue;
      }

      case "BLOCKED": {
        const last = task.failures.at(-1);
        io.write("");
        io.write("⚠ BLOCKED — automatic progress was stopped to avoid looping indefinitely.");
        if (last) io.write(`  ${last.message}`);
        io.write("");
        // `retry` is legal only from FAILED, never from BLOCKED (see docs/workflow.md) — a
        // second independent review found this used to be suggested here regardless, a command
        // the workflow engine would simply reject. The only two legal actions from BLOCKED are
        // resuming (back to FIXING, i.e. "keep trying") or cancelling (giving up); there is no
        // CLI-exposed "fail" command, so it isn't offered either.
        io.write(`Next action: inspect with \`ai status ${task.id}\`, then \`ai resume ${task.id}\` or \`ai cancel ${task.id}\`.`);
        return task;
      }

      case "CANCELLED":
        io.write("");
        io.write("Task cancelled.");
        return task;

      case "READY": {
        const diff = await orchestrator.currentDiff(task.id);
        io.write("");
        io.write("✓ READY");
        io.write("");
        if (diff.files.length) {
          io.write("Files changed:");
          for (const f of diff.files) io.write(`  ${f.path}`);
          io.write("");
        }
        io.write("Branch:");
        io.write(`  ${task.git.taskBranch ?? task.git.branch}`);
        io.write("");
        io.write("Worktree:");
        io.write(`  ${task.git.worktreePath ?? "(none)"}`);
        const openFindings = task.reviews.slice(-2).flatMap((r) => r.findings.filter((f) => f.status === "open"));
        if (openFindings.length) {
          io.write("");
          io.write("Unresolved non-blocking findings:");
          for (const f of openFindings) io.write(`  [${f.severity}] ${f.summary}`);
        }
        await nextActionsMenu(orchestrator, task.id, io);
        return task;
      }

      default:
        // IDLE never persists this way; every other case is handled above.
        return task;
    }
  }
}
