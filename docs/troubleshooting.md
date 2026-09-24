# Troubleshooting

## "Codex CLI not found" / "Claude Code CLI not found"

`ai config path` shows where AI Engine looked. Resolution order (see
[providers.md](./providers.md)): `providers.<id>.binaryPath` in global config → `PATH` → the newest
matching install under `~/.vscode*/extensions` (and Cursor/Windsurf equivalents). Fixes, in order of
preference:

1. Install the real CLI and make sure it's on `PATH` (`npm install -g @openai/codex` /
   `npm install -g @anthropic-ai/claude-code`, then `codex --version` / `claude --version`).
2. If you only have the VS Code extension and it still isn't found, the bundled binary's path may
   have changed shape in a newer extension version — set an explicit override:
   ```yaml
   # ~/.config/ai-engine/config.yaml
   providers:
     codex:
       binaryPath: /path/to/codex
   ```

## A task step fails with an authentication error

AI Engine never manages provider credentials. Run the provider's own login flow directly
(`codex login`, `claude auth login` or `claude setup-token`), then re-run the failed step — every
`Orchestrator` step is safe to re-run against the same task id (see
[workflow.md](./workflow.md#resumability--crash-recovery)).

## A task is stuck in `BLOCKED`

This means a fix/test, review/fix, or failure-retry loop exceeded its configured iteration cap
(`workflow.maxIterations`, default 3 per loop — see [workflow.md](./workflow.md#loop-guarding)).
Check `ai status <taskId>` for the failure history, fix the underlying issue by hand if needed
(the task's worktree is a normal git checkout you can edit directly), then `ai resume <taskId>` to
send it back into `FIXING` for another attempt, or `ai cancel <taskId>` to give up.

## A task failed and I want to try again

`ai retry <taskId>` (or "AI: Retry Failed Task" in VS Code) — a `FAILED` task is not a dead end; retry
returns it to whatever step it failed at (see [workflow.md](./workflow.md#retrying-a-failed-task)).
This is exactly what you want for a transient provider error (timeout, rate limit, dropped connection).
If the same step keeps failing, `retry` itself is iteration-guarded and will eventually escalate to
`BLOCKED` instead of retrying forever.

## `error: Task "..." is locked by another process` / a command hangs briefly then fails

Another `ai` invocation (a different terminal, or the VS Code extension) is currently working on the
same task — this is the cross-process lock doing its job, not a bug (see
[security.md](./security.md#persistence--cross-process-safety)). Wait for the other operation to
finish and try again. If the error names a PID that you know is no longer running (e.g. after a crash),
the lock will be detected as stale and automatically reclaimed on the next attempt within a few
minutes; there is no manual "break the lock" command in this version — if you need to force it
immediately, the lock is a plain file at `<dataDir>/tasks/.locks/<taskId>.lock` you can delete by hand.

## `submit_task`/`decide_task` (or `DELEGATED_RUN_EXISTS`) keeps failing after a worker died

AI Engine allows only one delegated (MCP-submitted) run per repository at a time. If the detached
worker handling one dies before it can hand ownership back — a killed terminal, an OS sleep/wake
cycle, an OOM kill, a host reboot — that ownership is never automatically reclaimed, by design (see
[security.md](./security.md#persistence--cross-process-safety)): a liveness check that turned out
to be wrong would risk two workers touching the same repository at once, which is worse than a
manual recovery step. Every later `submit_task`/`decide_task` for that repository fails with
`DELEGATED_RUN_EXISTS` until it's cleared.

1. **Diagnose**: `ai delegated-run status` — read-only, shows the current owner (task id, phase,
   and worker state). `worker: stale` means AI Engine has already confirmed, on this machine, that
   the recorded process no longer exists.
2. **Recover**: `ai delegated-run release-stale` — only succeeds when the recorded worker is
   confirmed dead on this machine; a live worker, or one AI Engine can't conclusively rule out (a
   different host, or a liveness check it couldn't complete) is always refused, and nothing is ever
   killed — this only clears AI Engine's own bookkeeping for a worker that has already died.

Automatic stale-lock stealing remains deliberately disabled; this command is the explicit,
human-initiated alternative — there is no other way to clear it in this version.

## `error: Task "..." cannot proceed: ...` (budget exceeded)

The task (or one of its roles) hit a configured `budgets.maxCostUsdPerTask` or
`budgets.maxInvocationsPerRolePerTask` limit (see [security.md](./security.md#budgets)). Raise the
limit in `~/.config/ai-engine/config.yaml` if the task genuinely needs more, or treat it as a signal
the task's scope may be too large / stuck in an expensive loop.

## A verification check shows `NOT_APPROVED`

The check is defined in `.ai/project.yaml`'s `verification.additionalChecks` (repository-tracked,
therefore untrusted by default) and has not been explicitly approved on this machine yet — see
[security.md](./security.md#repository-controlled-verification-commands). Review the exact command
with `ai checks <taskId>`, then `ai approve-check <taskId> <checkId>` (or "AI: Approve Verification
Command" in VS Code) once you've confirmed it's safe. If the command was matched against the security
deny-list, it can never be approved as-is — edit or remove it in `.ai/project.yaml`.

## `error: Task "..."'s worktree is at commit ..., but the last persisted state expected ...`

A git/task-state divergence was detected — the worktree changed without a matching persisted state
update, most commonly because a process was killed between a git commit and saving task state (see
[security.md](./security.md#gittask-state-divergence-detection)). Run `ai diff <taskId>` to see what's
actually in the worktree, decide whether it's worth keeping, then `ai acknowledge-divergence <taskId>`
to accept the current state and continue.

## Cleaning up worktrees

Cancelled, failed, or long-finished tasks leave their worktree and `ai/<task-id>` branch in place
(see [architecture.md](./architecture.md#git-worktree-behavior)) — there is no automatic garbage
collection in this version. To remove one by hand:

```sh
git worktree remove <path from `ai status <taskId>`> --force
git branch -D ai/<task-id>
```

A dedicated `ai gc` command that does this for every terminal task older than N days is a natural
follow-up (see [Known limitations](../README.md#known-limitations)).

## Two `ai`/VS Code operations on the same task at once

This is now safe by design, not just "don't do that": a cross-process file lock
(`@ai-engine/security`'s `TaskLock`) means the second operation either waits briefly or fails cleanly
with a `TaskLockedError` naming the process holding it — see [security.md](./security.md#persistence--cross-process-safety)
and the "locked by another process" entry above. What's still true: running two operations against the
same task from two terminals at once is not a _useful_ thing to do (the second one just fails or waits),
so there's no reason to do it deliberately — but it can no longer corrupt or silently race the task's
state if it happens by accident.

## Verification says `NOT_CONFIGURED` for something I expected to run

The verification engine only proposes checks it can actually detect are configured — an npm script
that doesn't exist in `package.json`, or a tool (`slither`) not found on `PATH`, shows up as
`NOT_CONFIGURED` rather than being silently skipped or, worse, invented. Add the missing script/tool,
or add a check explicitly via `.ai/project.yaml`'s `verification.additionalChecks`.

## Logs

Structured JSONL logs live under `<data dir>/logs/engine.log` (`ai config path` shows `logsDir`).
Every line is a single JSON object with `ts`, `level`, `msg`, and context fields (`taskId`, `role`,
`providerId`, `workflowState`, ...) run through secret redaction — safe to `grep`/`jq` and safe to
paste when asking for help.
