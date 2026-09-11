# Workflow lifecycle

## States

```
IDLE  TASK_CREATED  ANALYZING  PLAN_READY  AWAITING_APPROVAL  IMPLEMENTING
TESTING  REVIEWING  FIXING  VERIFYING  READY  FAILED  PAUSED  CANCELLED  BLOCKED
```

`IDLE` is a transient pre-task state (a fresh `TaskRecord` starts here and immediately transitions to
`TASK_CREATED` via the `analyze` trigger inside `Orchestrator.createTask`, so it never appears in a
persisted record's `history` as anything but the very first `from`). `READY` and `CANCELLED` are true
terminal states. `FAILED` is recoverable via `retry` (see below) — it is not a dead end. `BLOCKED` is
reached only via an iteration-cap escalation (see below) and requires a human decision to leave.

## Transition table

Defined in `packages/workflow/src/default-workflow.ts`:

| From              | Trigger             | To                 | Notes                                       |
| ----------------- | ------------------- | ------------------ | ------------------------------------------- |
| IDLE              | analyze             | TASK_CREATED       | task creation                               |
| TASK_CREATED      | analyze             | ANALYZING          | `ai plan` / `ai analyze`                    |
| ANALYZING         | plan_ready          | PLAN_READY         | architect succeeded                         |
| ANALYZING         | fail                | FAILED             | architect invocation failed                 |
| PLAN_READY        | submit_for_approval | AWAITING_APPROVAL  | automatic                                   |
| AWAITING_APPROVAL | approve             | IMPLEMENTING       | human (or auto, if `approvals.plan: false`) |
| AWAITING_APPROVAL | reject              | PLAN_READY         | back for re-planning                        |
| IMPLEMENTING      | implemented         | TESTING            | implementer succeeded + committed           |
| IMPLEMENTING      | fail                | FAILED             | implementer invocation failed               |
| TESTING           | tests_passed        | REVIEWING          | all required checks PASS                    |
| TESTING           | tests_failed        | FIXING             | loop `test_fix`                             |
| REVIEWING         | review_approved     | VERIFYING          | no open blocker/major findings              |
| REVIEWING         | review_findings     | FIXING             | loop `review_fix`                           |
| FIXING            | fixed               | TESTING            | implementer addressed findings/failures     |
| FIXING            | escalate            | BLOCKED            | loop cap exceeded (automatic)               |
| VERIFYING         | verified_pass       | READY              | automated checks pass + verifier approves   |
| VERIFYING         | verified_fail       | FIXING             | loop `test_fix`                             |
| BLOCKED           | resume              | FIXING             | human decides to keep trying                |
| BLOCKED           | fail / cancel       | FAILED / CANCELLED | human gives up                              |
| any active state  | pause               | PAUSED             | stores `previousState`                      |
| PAUSED            | resume              | _previousState_    | special-cased in `WorkflowEngine.apply`     |
| PAUSED            | cancel              | CANCELLED          | a paused task is never a dead end           |
| PAUSED            | fail                | FAILED             |                                             |
| FAILED            | retry               | _previousState_    | special-cased, loop `failure_retry`         |
| any active state  | cancel              | CANCELLED          |                                             |
| any active state  | fail                | FAILED             |                                             |

"Active" states are everything except `IDLE`/`READY`/`FAILED`/`CANCELLED`/`PAUSED`/`BLOCKED`.

## Loop guarding

Three named loops are iteration-guarded independently (`workflow.maxIterations` in global config,
default 3 each): `test_fix` (TESTING/VERIFYING ⇄ FIXING), `review_fix` (REVIEWING ⇄ FIXING), and
`failure_retry` (FAILED → retry → wherever it failed). Every time a looping trigger fires,
`WorkflowEngine` increments that loop's counter on the `TaskRecord`; once the configured max is
exceeded, the _same trigger_ is redirected to `BLOCKED` instead, and a `FailureRecord` with
`code: "MAX_ITERATIONS"` is appended — so a stuck task always surfaces for human attention instead of
spinning (or burning provider budget) indefinitely, whether it's stuck failing review, failing tests,
or repeatedly erroring outright.

## Retrying a FAILED task

A raw provider error (a timeout, a rate limit, a dropped connection) previously left a task permanently
`FAILED` — the _only_ recoverable non-terminal control state was `BLOCKED`. `FAILED` now stores
`previousState` the same way `PAUSED` does, and `retry` (`Orchestrator.retry(taskId, by, note?)` / `ai
retry <taskId>` / "AI: Retry Failed Task") returns the task to exactly the state it failed from,
iteration-guarded by the `failure_retry` loop above.

One subtlety: `analyze()` transitions `TASK_CREATED → ANALYZING` _before_ invoking the architect, so a
failure during that call has `previousState = ANALYZING`, not `TASK_CREATED`. `analyze()` accepts
re-entry into `ANALYZING` (skipping the already-applied transition) specifically so `retry` lands
somewhere `run()`/`analyze()` know how to continue from — see the "H2" tests in
`orchestrator.hardening.test.ts`, including one that exercises exactly this case.

## Approval gates

Two of the three gates in the mission brief map directly onto workflow states; the third is
deliberately _not_ a state:

- **plan → approval required**: native to the state machine (`AWAITING_APPROVAL`). Disable with
  `approvals.plan: false` in global config to auto-approve (still recorded as an `ApprovalRecord`
  with `by: "system"`).
- **security_review → approval required**: `Orchestrator.review()` always runs both the `reviewer`
  and `security_reviewer` roles. If both approve and `approvals.security_review` is true (default),
  the task is `pause`d with `pendingGate: "security_review"` and `pendingDecisionTrigger:
"review_approved"` stashed on the record, instead of auto-advancing to `VERIFYING`. Resolve with
  `ai gate <task> security_review` (or the "AI: Security Review" command when a gate is pending) —
  approving replays the stashed trigger, rejecting forces `review_findings` (→ `FIXING`) instead.
- **final_merge → approval required**: **not** a workflow transition. `READY` already means
  "verified and reviewed; a human must now decide to merge." Merging the task's branch
  (`ai/<task-id>`) into your target branch is an ordinary manual `git merge`/pull-request step —
  baking a merge into the state machine would mean AI Engine deciding on its own to touch your
  default branch, which the mission brief explicitly rules out ("Do not make destructive autonomous
  behavior the default").

## Resumability & crash recovery

Every mutating `Orchestrator` method acquires a cross-process lock for the task id
(`TaskStore.withLock`, see [security.md](./security.md#persistence--cross-process-safety)), loads the
current `TaskRecord` fresh inside that lock, applies exactly the transition(s) that step is responsible
for, persists atomically, and releases. There is no in-memory-only state anywhere in the pipeline. If
the CLI process is killed mid-step, or VS Code is closed, the next call against the same task id picks
up from whatever was last durably persisted:

- If the process died _before_ committing any worktree changes, re-running the same step is safe and
  idempotent — nothing happened yet.
- If it died _after_ `implement`/`fix` committed to the worktree but _before_ the resulting
  `TaskRecord` was persisted, the next step detects this directly (the worktree's actual commit no
  longer matches the last persisted `lastKnownCommit`) and raises `GitStateDivergedError` instead of
  blindly re-invoking an agent on top of already-committed, forgotten work — see
  [security.md](./security.md#gittask-state-divergence-detection). A human inspects `ai diff` and runs
  `ai acknowledge-divergence <taskId>` to clear it.
- `analyze`/`review`/`finalVerify` are pure read/produce steps; their partial side effects are limited
  to `TaskRecord` fields, and `review()` specifically persists each reviewer's result immediately after
  that reviewer succeeds — a later reviewer's failure in the same round never discards an earlier one
  (see the "H3" test in `orchestrator.hardening.test.ts`).
- A task stuck `FAILED` from a transient error is not stuck at all — see "Retrying a FAILED task" above.

`ai run <task>` and the "AI: Run Workflow" command both re-load the record on every internal step (each
sub-step taking its own lock), so they are safe to interrupt and re-invoke at any point too — and safe
to run concurrently with a manual step command on the same task from another window/terminal, which
will simply wait for or be refused by the lock rather than racing it.
