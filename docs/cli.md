# CLI reference

The `ai` CLI (`packages/cli`) is a thin wrapper over `@ai-engine/orchestrator` — every command below
is a one-to-one call into the same `Orchestrator` class the VS Code extension uses, so behavior
(state transitions, approval gates, logging) is identical between the two.

Every command operates on the git repository containing the current working directory
(`GitRepository.discover(process.cwd())`); there is no separate `--repo` flag in this version.

```
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

ai config path
    Print the resolved global config/data directories for this machine.

ai config show
    Print the effective global configuration (defaults merged with your config.yaml) as JSON.
```

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
