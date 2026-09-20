# CLI reference

The `ai` CLI (`packages/cli`) is a thin wrapper over `@ai-engine/orchestrator` — every command below
is a one-to-one call into the same `Orchestrator` class the VS Code extension uses, so behavior
(state transitions, approval gates, logging) is identical between the two. `ai start` (guided mode,
see [below](#guided-mode-ai-start)) is the same story: it's a CLI-layer loop over these same
`Orchestrator` methods, not a second implementation of the workflow.

Every command operates on the git repository containing the current working directory
(`GitRepository.discover(process.cwd())`); there is no separate `--repo` flag in this version.

```
ai start "<request>" [--by <name>] [--verbose]
    Guided mode (recommended): create a task and drive it to a terminal state automatically,
    prompting only for the human decisions that actually require judgment. See "Guided mode" below.

ai init [--name <name>] [--description <desc>]
    Scaffold .ai/project.yaml (+ context/README.md) if it doesn't already exist.

ai task "<request>"
    Create a new task: captures a git baseline, creates a dedicated worktree + branch, persists a
    TaskRecord in TASK_CREATED. Prints the new task id and worktree path.

ai plan <taskId>
    Run the architect role (analysis + plan in one pass). Auto-submits for approval; auto-approves
    too if approvals.plan is disabled in config.

ai approve <taskId> [--reject] [--by <name>] [--note <text>]
    Approve or reject a plan sitting in AWAITING_APPROVAL.

ai implement <taskId>
    Run the implementer role, commit its changes in the task worktree, move to TESTING.

ai verify <taskId>
    Run verification for whatever stage the task is actually in: the post-implementation test pass
    (TESTING) or the final holistic pass (VERIFYING) — the command inspects current state so you
    don't have to remember which one applies.

ai review <taskId>
    Run the independent reviewer + security_reviewer roles against the current diff.

ai gate <taskId> <gate> [--reject] [--by <name>] [--note <text>]
    Resolve a pending approval gate opened by `review` (currently: "security_review"). Approving
    replays whatever transition the review step computed; rejecting routes to FIXING.

ai fix <taskId>
    Run the implementer role against the current open findings / failing checks, commit, move back
    to TESTING.

ai checks <taskId>
    List verification checks currently configured for the task's repository, including approval
    status for repository-configured ones (see docs/security.md).

ai approve-check <taskId> <checkId> [--by <name>] [--note <text>]
    Explicitly approve a repository-configured verification command (.ai/project.yaml) by its exact
    current text before it is ever allowed to run — the same mechanism the VS Code extension uses.
    An edited command loses its approval and must be re-approved.

ai run <taskId>
    Drive the task forward automatically (analyze → implement → test → review → fix loop → verify)
    until it needs a human (an approval gate, or PAUSED) or reaches a terminal state. Never
    auto-retries a FAILED task — see `ai retry` below.

ai pause <taskId> [--by <name>]
ai resume <taskId> [--by <name>]
ai retry <taskId> [--by <name>] [--note <text>]
ai cancel <taskId> [--by <name>] [--note <text>]
    Generic control triggers: pause/cancel are legal from any active state or PAUSED; resume is legal
    from PAUSED (a task paused by an approval gate is refused with a pointer to `ai gate` instead);
    retry is legal from FAILED and returns the task to exactly the step it failed at (iteration-guarded
    — see docs/workflow.md#retrying-a-failed-task).

ai acknowledge-divergence <taskId> [--by <name>] [--note <text>]
    Clears a detected git/task-state divergence (see docs/security.md) by accepting the worktree's
    current commit as the new known-good baseline. Inspect `ai diff <taskId>` first.

ai status [taskId]
    With a task id: full detail (state, plan, verification, reviews, failures, history). Without:
    list every task recorded for the current repository, most recent first.

ai diff <taskId>
    Print the task's current diff against its baseline commit; warns if any changed path matches
    the suspicious-path list (see docs/security.md).

ai usage <taskId>
    Show the usage the task's agent invocations reported, grouped by provider and then role (`fix`
    invocations of the implementer role are listed separately, as "fixer"), followed by a task total
    with invocation and provider counts. Read-only: it only reads the usage log persisted on the task.
    An invocation that reported no usage still counts as an invocation and is shown as
    "(no usage metrics reported)" — never as 0 — while a value a provider genuinely reported as 0 is
    shown as 0. A task with no recorded invocations prints "(no recorded usage for this task)". See
    docs/providers.md#usage--capacity.

ai config path
    Print the resolved global config/data directories for this machine.

ai config show
    Print the effective global configuration (defaults merged with your config.yaml) as JSON.

ai providers
    List every registered provider generically — id, display name, which configured roles currently
    resolve to it, availability (installed / authenticated / version, plus the detail of any failure),
    capabilities, and capacity. Capacity is "unknown" for every provider today: neither shipped provider
    reports it (see docs/providers.md#usage--capacity). Read-only: it runs each provider's availability
    diagnostics (version and auth-status probes) and nothing else — it never invokes an agent, creates a
    task, or opens a session. Never hardcodes which providers exist; reflects whatever's registered in
    RoleRegistry's factory map (see docs/adding-a-provider.md).
```

## Guided mode (`ai start`)

```sh
ai start "Fix ModuleRegistry.removeModule and add regression tests"
```

Creates a task, then repeatedly calls `Orchestrator.run()` — the exact same method `ai run` calls —
to drive it through every state that doesn't need a human, stopping only where one genuinely does:

- **`AWAITING_APPROVAL`** — the plan is printed in full, then `Approve this plan? [Y/n]`. A "no"
  calls `decidePlan(..., "rejected")` — the same rejection path `ai approve --reject` uses, not a
  separate mechanism — and the loop continues (the architect gets another turn).
- **`PAUSED` (`security_review`)** — both review verdicts and any findings are printed, then
  `Approve security review? [Y/n]`, resolved through the same `decideGate()` `ai gate` uses.
- **`PAUSED` (no pending gate)** — a manual pause (e.g. someone ran `ai pause`), not an approval gate.
  Guided mode never manufactures a fake gate for this: it offers only `Resume this task? [Y/n]`,
  resolved through the same `resume()` `ai resume` uses.
- **A required verification check awaiting approval (`NOT_APPROVED`)** — `Orchestrator.test()`/
  `finalVerify()` themselves stop here (a gate-less `PAUSED`, exactly like the case above) the
  moment they see a required check is still awaiting approval, _before_ ever applying
  `tests_failed`/`verified_fail` — so the fixer is genuinely never invoked for this and no
  `test_fix` iteration is ever spent on it; this isn't merely something guided mode notices and
  works around afterward. The check id, its command, and its description are printed;
  interactively, guided mode offers to approve it on the spot via the same
  `approveVerificationCommand()` `ai approve-check` uses, then calls the same `resume()` `ai
resume` uses to continue (re-running verification for real) — otherwise it prints `ai checks
<taskId>` / `ai approve-check <taskId> <checkId>` and stops. Approving twice never happens:
  guided mode checks the approval store's _current_ state, not the (unchanging) historical
  verification result, so an already-approved check is never re-flagged.
- **`FAILED`** — the failure reason is printed, then `Retry? [Y/n]`, resolved through the same
  `retry()` `ai retry` uses. Declining stops guided mode there — it never auto-retries silently.
- **`BLOCKED`** — explained and left alone. `retry` is legal only from `FAILED`, never from
  `BLOCKED`, so guided mode never suggests it here; resolve `BLOCKED` with `ai resume` (keep trying)
  or `ai cancel` (give up), as shown.
- **`READY`** — a completion summary (files changed, branch, worktree, verification/review summary,
  any unresolved non-blocking findings), then an optional `[d]iff` / `[s]tatus` / `[q]uit` menu.
  Guided mode never merges or pushes anything, at any point.

The task id is generated and threaded through internally — you're never asked to copy or re-enter it
during a normal guided run; it's only ever printed for traceability, and `ai status <taskId>` /
`ai diff <taskId>` still work with it afterward exactly as in manual mode.

**Provider names in progress lines are never hardcoded.** "Claude is planning..." / "Codex is
implementing..." are resolved live from whatever `roles:` mapping is actually in effect (project
config, then global config, then schema defaults — the same resolution `RoleRegistry` always uses),
via `Orchestrator.providerIdForRole(role)`. Swap providers in config and guided mode's narration
follows automatically, with no code change.

**Non-interactive stdin is refused, never silently approved.** `ai start` checks whether stdin/stdout
are a real terminal before ever prompting; if they aren't (piped input, a CI job, `< /dev/null`), it
throws a clear error the moment it would need to ask a human something, rather than defaulting either
way. There's no `--yes`/auto-approve flag — a human decision either gets asked for real or the run
stops; scripts that need to drive approvals unattended should compose the existing low-level commands
(`ai plan` / `ai approve` / `ai gate` / ...) instead, exactly as before guided mode existed.

**Console output is concise by default; nothing is lost from the log file either way.** Guided mode
suppresses routine debug/info-level provider-event logging on the console (raw JSON lines from every
agent turn) so the progress/outcome lines above are the only thing you see; the structured log file
(`~/.local/share/ai-engine/logs/engine.log` by default) always receives every entry regardless, at
every level. Pass `--verbose` to also see the full detail on the console, exactly like every other
`ai` command already does.

`--by <name>` (default `"operator"`) is recorded against any approvals guided mode makes on your
behalf, same as the `--by` flag on `ai approve`/`ai gate`/`ai retry`.

## Exit codes

Failures are not all reported as a generic exit code `1` — a script driving `ai` can distinguish what
kind of failure happened:

| Code | Meaning                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------- |
| 0    | success                                                                                           |
| 1    | generic/unexpected error                                                                          |
| 2    | unknown task id                                                                                   |
| 3    | illegal workflow state for the requested step (e.g. `ai implement` on a task not in IMPLEMENTING) |
| 4    | task locked by another process — try again shortly                                                |
| 5    | git/task-state divergence detected — run `ai acknowledge-divergence`                              |
| 6    | budget (cost or invocation-count) exceeded                                                        |
| 7    | workspace-confinement check failed                                                                |
| 8    | repository has no commits yet                                                                     |

## Example: full manual walkthrough

```sh
cd my-repo
ai init
ai task "Add rate limiting to the /login endpoint"
# -> t-20260910153000-a1b2  [TASK_CREATED]

ai plan t-20260910153000-a1b2
# -> AWAITING_APPROVAL; prints the architect's specification + plan

ai diff t-20260910153000-a1b2   # nothing yet — no code written during planning

ai approve t-20260910153000-a1b2
# -> IMPLEMENTING

ai implement t-20260910153000-a1b2
# -> TESTING (implementer's changes are committed on ai/t-20260910153000-a1b2)

ai verify t-20260910153000-a1b2
# -> REVIEWING (or FIXING, if the project's own build/test scripts failed)

ai review t-20260910153000-a1b2
# -> PAUSED, pendingGate: security_review   (or REVIEWING -> FIXING if findings were raised)

ai gate t-20260910153000-a1b2 security_review
# -> VERIFYING

ai verify t-20260910153000-a1b2
# -> READY

ai diff t-20260910153000-a1b2   # inspect the final diff before you merge it yourself
git log ai/t-20260910153000-a1b2   # or open a PR from that branch
```

Or, equivalently, run the whole thing with `ai run` in between the two approval gates:

```sh
ai task "Add rate limiting to the /login endpoint"
ai run <taskId>          # stops at AWAITING_APPROVAL
ai approve <taskId>
ai run <taskId>          # stops at the security_review gate
ai gate <taskId> security_review
ai run <taskId>          # -> READY
```
