# Architecture

AI Engine is a local, permanent control plane for AI-assisted software engineering. It is installed
once per machine and works across arbitrary repositories opened in VS Code (or driven headlessly
from the `ai` CLI). It is not a chat interface: the unit of work is a **task** that moves through an
explicit, persisted **workflow state machine**, with **provider-independent agent roles** doing the
actual analysis/implementation/review work.

```
VS Code extension  ─┐
                     ├──>  @ai-engine/orchestrator  ──>  @ai-engine/workflow (state machine)
CLI (`ai`)         ──┘            │                              │
                                   ├──> @ai-engine/security (policy engine)
                                   ├──> @ai-engine/git (baseline, worktrees, diff)
                                   ├──> @ai-engine/verification (build/test/lint discovery+runner)
                                   ├──> @ai-engine/config (global + .ai/ project config)
                                   ├──> @ai-engine/logging (structured, redacted logs)
                                   └──> @ai-engine/providers (Codex CLI adapter, Claude Code CLI adapter)
                                                  │
                                                  ▼
                                     Codex CLI / Claude Code CLI subprocess
                                                  │
                                                  ▼
                                        the task's dedicated git worktree
```

This deviates from the mission brief's simple top-down diagram in one deliberate way: **the
orchestrator, not "the workflow engine" in isolation, is the thing both UIs call.** The workflow
engine is a pure state machine with no I/O; it's a dependency of the orchestrator, not a peer layer
between the UI and the agents. Keeping it pure is what makes it trivially unit-testable (see
`packages/workflow/src/engine.test.ts`) and independent of persistence, git, or providers.

## Repository layout

```
packages/
  core/           domain types + ports (ProviderAdapter, TaskRecord, WorkflowState, ...) — zero deps
  workflow/       the state machine + iteration-guarded transition engine
  config/         global (per-machine) config + project (.ai/) config, both zod-validated
  logging/        structured JSON logging with secret redaction
  security/       command/path policy engine, per-role sandbox defaults
  git/            baseline capture, worktree isolation, diff inspection, suspicious-path detection
  verification/   repo-aware check discovery (npm/Foundry/...) + a structured runner
  providers/      CodexProvider, ClaudeProvider — the only packages that know these products exist
  orchestrator/   wires everything above into task-level operations (analyze/implement/review/...)
  cli/            the `ai` command-line tool — a thin wrapper over @ai-engine/orchestrator
extensions/
  vscode/         the VS Code extension — also a thin wrapper over @ai-engine/orchestrator
docs/             this documentation
```

Dependency direction is strictly one-way: `core` depends on nothing of ours; `workflow`, `config`,
`logging`, `security`, `git`, `verification` depend only on `core`; `providers` depends on `core` +
`logging`; `orchestrator` depends on all of the above; `cli` and the VS Code extension depend only on
`orchestrator` (+ `core`/`config` for types). Nothing outside `providers/` imports `codex.ts` or
`claude.ts` directly — see [adding-a-provider.md](./adding-a-provider.md).

## Why this shape

- **Explicit state, not chat history.** A `TaskRecord` (see [workflow.md](./workflow.md)) is the
  single source of truth. Any process (CLI invocation, VS Code command, a crashed and restarted
  extension host) reconstructs exactly where a task is from the persisted record, never from
  scrollback.
- **Provider independence is structural, not a convention.** `@ai-engine/core`'s `ProviderAdapter`
  interface is the only thing `orchestrator/` programs against. `RoleRegistry`
  (`packages/orchestrator/src/role-registry.ts`) is the _only_ place a provider id string is mapped
  to a concrete class. See [adding-a-provider.md](./adding-a-provider.md).
- **Git is a safety boundary, not a side effect.** Every task gets its own worktree + branch, created
  from a captured baseline commit, before any agent runs. See [git behavior](./architecture.md#git-worktree-behavior)
  below and [security.md](./security.md).
- **Verification and review are independent of implementation.** The reviewer/security-reviewer
  roles receive the diff, not the implementer's narrative; verification runs the repo's own
  build/test/lint commands, not the model's opinion of whether they'd pass.

## Git & worktree behavior

Both Codex CLI and Claude Code CLI ship their own `--worktree` flag. AI Engine does **not** use
either — it creates and owns the worktree itself (`GitRepository.createTaskWorktree`, under
`<data dir>/worktrees/<task-id>`, on branch `ai/<task-id>`, rooted at a baseline commit captured
before anything runs) so that:

- the worktree's location and branch name are consistent regardless of which provider is filling
  which role in a given task (an implementer swap from Claude to Gemini shouldn't change where its
  work lands);
- the `TaskRecord.git` baseline (branch, commit, worktree path, dirty/untracked state at start) is
  something the orchestrator itself captured and can audit, not something a provider's CLI reported
  about itself.

Consequences:

- Uncommitted changes in your primary working tree are **not** visible inside a task's worktree — a
  linked worktree is checked out from a commit, not from a dirty index. `ai task` warns about this at
  creation time so you know to commit or stash first if the agent needs to see in-progress work.
- Every agent step that can modify files (`implement`, `fix`) commits its changes in the worktree
  immediately afterward (`ai-engine(<task-id>): implement` / `...: fix`), so every later diff,
  review, and verification pass has a clean, inspectable commit boundary.
- Nothing in the pipeline ever touches your primary checkout's `HEAD`, index, or branch. Merging a
  finished task's branch back is a manual `git merge`/PR step — see
  [Human control & the final_merge gate](./security.md#approval-gates).
- Cancelling or failing a task leaves its worktree and branch in place for forensic inspection; there
  is no automatic garbage collection in this version (see [Known limitations](../README.md#known-limitations)).
- Right after creating the worktree, `createTask()` makes a single best-effort attempt to install
  the target project's dependencies into it (`prepareWorktreeDependencies`,
  `packages/orchestrator/src/dependency-setup.ts`) — a real end-to-end run found that a fresh
  `git worktree` only checks out tracked files, so a Node project's `node_modules` never exists in
  a new one, and verification fails immediately with something like `tsc: command not found`. This
  is deliberately narrow, not a package-management framework: it detects the package manager from
  whichever lockfile is present (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` /
  `bun.lockb`) and runs only that manager's frozen/reproducible install variant (`npm ci`, never
  `npm install`) — never anything read from the repository itself. It also refuses to run at all
  unless `node_modules` is confirmed covered by the repository's own `.gitignore` (checked live via
  `git check-ignore`), specifically so an install can never leave something `commitAllIfChanged()`
  later sweeps into a task commit — which is exactly what happened during that same end-to-end run,
  when a manual `npm install` (before this mechanism existed) left a stray `package-lock.json` diff
  that got committed as part of an unrelated fix step. Never blocks task creation: an install
  failure or a project this doesn't recognize is recorded on the task
  (`dependencySetup`, visible via `ai status <taskId>`) and verification simply fails normally, now
  with a clearer upfront reason instead of a confusing downstream "command not found".

## Task pipeline (default workflow)

```
TASK_CREATED → ANALYZING → PLAN_READY → AWAITING_APPROVAL → IMPLEMENTING → TESTING
   → REVIEWING → (FIXING ⇄ TESTING/REVIEWING loop, iteration-capped) → VERIFYING → READY
```

With the default role assignment (`architect: codex`, `implementer: claude`, `reviewer: codex`,
`security_reviewer: codex`, `verifier: codex`) this realizes exactly the brief's default workflow:
Codex analyzes/architects/plans → human approval → Claude implements → automated tests →
Codex reviews independently (+ a dedicated security-reviewer pass) → Claude fixes valid findings →
re-verification → Codex final verification. See [workflow.md](./workflow.md) for the full state
table, including how review findings flow back into `FIXING` and are re-validated.

None of this is hard-coded to Codex/Claude: it is entirely a consequence of the default
`roles:` mapping in global config (see [configuration section of the README](../README.md#configuration)).
Changing `implementer: claude` to `implementer: gemini` (once a Gemini adapter is registered — see
[adding-a-provider.md](./adding-a-provider.md)) changes nothing else.
