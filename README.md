# AI Engine

A permanent, local, production-quality **AI software-engineering orchestration control plane**. It
coordinates OpenAI Codex and Claude Code (and, by design, any future provider — see below) through
an explicit, auditable workflow:

```
TASK → CONTEXT → PLAN → HUMAN APPROVAL → IMPLEMENTATION → VERIFICATION
     → INDEPENDENT REVIEW → CORRECTION → FINAL VERIFICATION → HUMAN APPROVAL
```

It is installed once per machine, works across arbitrary git repositories, and is driven equally by
a VS Code extension or a standalone `ai` CLI — both call the same orchestration engine, so there is
exactly one implementation of the workflow to keep correct.

This is not a chat interface. The unit of work is a **task**: a persisted record with an explicit
workflow state, a dedicated git worktree, structured verification/review results, and a full audit
history — never chat scrollback.

Full design rationale lives in [docs/](./docs); this README is the map + how-to.

## 1. Architecture

```
VS Code extension  ─┐
                     ├──>  Orchestrator ──> Workflow engine (state machine)
CLI (`ai`)         ──┘         │                    │
                                ├──> Security policy engine
                                ├──> Git safety (baseline, worktrees, diff)
                                ├──> Verification engine (build/test/lint discovery + runner)
                                ├──> Config (global + per-project .ai/)
                                ├──> Logging (structured, secret-redacted)
                                └──> Provider adapters ──> Codex CLI / Claude Code CLI subprocess
```

See [docs/architecture.md](./docs/architecture.md) for the full rationale, including why git
worktrees are owned by the orchestrator rather than delegated to each provider's own `--worktree`
flag.

## 2. Repository structure

```
packages/
  core/           domain types + ports (zero dependencies)
  workflow/       the state machine
  config/         global + project (.ai/) configuration
  logging/        structured logging with secret redaction
  security/       command/path policy engine, per-role sandbox defaults
  git/            baseline capture, worktree isolation, diff inspection
  verification/   check discovery (npm/Foundry/...) + runner
  providers/      CodexProvider, ClaudeProvider
  orchestrator/   wires everything into task-level operations
  cli/            the `ai` command-line tool
extensions/
  vscode/         the VS Code extension
docs/             architecture, security, workflow, providers, CLI, VS Code, troubleshooting, ...
```

## 3. Implemented components

- **Core domain model & ports** (`@ai-engine/core`): `TaskRecord`, `WorkflowState`, `ProviderAdapter`,
  trust-labelled context blocks, verification/review types. Zero dependencies, zero I/O.
- **Workflow engine** (`@ai-engine/workflow`): table-driven state machine, iteration-capped retry
  loops with automatic escalation to `BLOCKED`, pause/resume/cancel from any active state, full
  append-only history. See [docs/workflow.md](./docs/workflow.md).
- **Config** (`@ai-engine/config`): zod-validated global config (XDG-resolved) and per-project
  `.ai/project.yaml`, cleanly separated (see [§7](#7-configuration)).
- **Logging** (`@ai-engine/logging`): structured JSONL with secret redaction on every field of every
  log line.
- **Security** (`@ai-engine/security`): trust-level framing, command/path deny-list + streaming
  policy monitor, per-role sandbox defaults. See [docs/security.md](./docs/security.md).
- **Git safety** (`@ai-engine/git`): baseline capture, dedicated worktree + branch per task,
  structured diff with a suspicious-path detector, real integration tests against actual git repos.
- **Verification** (`@ai-engine/verification`): detects npm scripts / Foundry projects that actually
  exist in the repo and runs only those, with structured `PASS/FAIL/SKIPPED/NOT_CONFIGURED` results.
- **Provider adapters** (`@ai-engine/providers`): real CLI-subprocess adapters for Codex and Claude
  Code, including binary auto-discovery that falls back to each product's bundled VS Code extension
  install. See [§4](#4-provider-integration-approach).
- **Orchestrator** (`@ai-engine/orchestrator`): the task lifecycle — `createTask`, `analyze`,
  `decidePlan`, `implement`, `test`, `review`, `decideGate`, `fix`, `finalVerify`,
  `pause`/`resume`/`cancel`, `run` (drive-to-completion) — plus `.ai/` project scaffolding and
  human-readable task summaries.
- **CLI** (`@ai-engine/cli`, binary `ai`) and **VS Code extension** (`extensions/vscode`), both thin
  wrappers over the orchestrator.

## 4. Provider integration approach

Both providers are integrated via **non-interactive CLI subprocess invocation** (`codex exec --json`,
`claude -p --output-format stream-json`) — the one mechanism, on both products, that is officially
documented, stable (not marked experimental), and symmetric enough to sit behind one
`ProviderAdapter` interface. Codex's experimental `app-server` protocol and Claude Code's `mcp serve`
are documented as a future upgrade path behind the same interface, not used in v1.

Binary resolution: explicit config override → `PATH` → the CLI bundled inside each product's VS Code
extension (auto-discovered; this machine has neither CLI on `PATH`, only the bundled copies, and the
adapters find them there automatically — verified live, see `packages/providers/src/adapters.integration.test.ts`).

Full detail, including the exact flags used per role and what was verified against the real
(credential-free) CLI output while building this: [docs/providers.md](./docs/providers.md).

## 5. VS Code integration

Activity-bar view (Task / Verification / Review Findings), a status-bar indicator, and the full
command set from the mission brief (`AI: New Task`, `Analyze Repository`, `Plan Task`, `Approve
Plan`, `Implement Task`, `Run Verification`, `Review Changes`, `Security Review`, `Fix Findings`,
`Resume Workflow`, `Cancel Workflow`, `Show Workflow Status`, plus `Run Workflow`). Imports the
orchestrator directly (no subprocess to the CLI). See [docs/vscode.md](./docs/vscode.md) for install
instructions (a ready-to-install `.vsix` is built via `npm run package` in `extensions/vscode`).

## 6. CLI usage

### Guided mode (recommended)

```sh
ai init
ai start "Add rate limiting to the /login endpoint"
```

Creates the task and drives it to a terminal state automatically — analysis/planning, implementation,
verification, and review all happen without you touching another command. You're only ever prompted
for the decisions that are actually a human's to make: approving the plan, approving a required
repository-configured verification command the first time it's seen, approving the `security_review`
gate, and (if a step genuinely fails) deciding whether to retry. The task id is
handled internally for the rest of the run — no copying it between commands — and is only ever shown
for traceability (`ai status <taskId>` still works afterward). `ai start` never merges or pushes
anything; that remains a manual step once the task reaches `READY`. See [docs/cli.md](./docs/cli.md#guided-mode-ai-start)
for the full walkthrough, non-interactive behavior, and `--verbose`.

### Manual mode (scripting, debugging, recovery, advanced control)

Every state transition guided mode drives is also a standalone command — nothing below is replaced
or removed by `ai start`, and `ai status <taskId>` always shows a concrete "Next action" hint for
whichever command applies to a task's current state:

```sh
ai task "Add rate limiting to the /login endpoint"
ai plan <taskId>          # -> AWAITING_APPROVAL
ai approve <taskId>
ai run <taskId>           # drives implement -> test -> review -> fix loop -> pauses at security_review
ai gate <taskId> security_review
ai run <taskId>           # -> READY
ai diff <taskId>          # inspect before you merge yourself
```

Full command reference: [docs/cli.md](./docs/cli.md).

## 7. Configuration

Deliberately split in two, per the mission brief:

- **Global** (`~/.config/ai-engine/config.yaml` on Linux, resolved via `@ai-engine/config`'s
  `resolveEnginePaths`, overridable with `AI_ENGINE_CONFIG_DIR`/`AI_ENGINE_DATA_DIR`): which provider
  fills which role, approval gates, security policy, workflow iteration limits, budgets, logging.
  Defaults (`packages/config/src/schema.ts`):
  ```yaml
  roles:
    architect: { providerId: codex }
    implementer: { providerId: claude }
    reviewer: { providerId: codex }
    security_reviewer: { providerId: codex }
    verifier: { providerId: codex }
  approvals: { plan: true, security_review: true, final_merge: true }
  workflow: { maxIterations: { test_fix: 3, review_fix: 3 }, defaultMaxIterations: 3 }
  security: { restrictToWorkspace: true, network: provider_default, deniedCommandPatterns: [...] }
  ```
  Inspect with `ai config path` / `ai config show`.
- **Per-project** (`.ai/project.yaml`, git-tracked): name/description, per-project role overrides,
  verification overrides, review focus areas. Never holds credentials.

**Never a credential in either file.** Provider auth is entirely delegated to each CLI's own login
storage; AI Engine only ever runs a `login status`/`auth status` diagnostic. See
[docs/security.md](./docs/security.md#secrets--credentials).

## 8. `.ai/` project structure

```
.ai/
├── project.yaml       # created by `ai init`
├── context/           # created by `ai init`, with a starter README
├── architecture/ decisions/ invariants/   # create as needed; loaded automatically if present
└── tasks/             # written automatically, one human-readable summary per task
```

Full rationale: [docs/project-init.md](./docs/project-init.md).

## 9. Security model

Trust-labelled context (system / user / repository content / agent-generated) with repository
content always rendered as fenced, explicitly-non-authoritative data — even content a human on the
team wrote, since anyone who can land a PR can edit it. Command/path deny-list + streaming policy
monitor as defense-in-depth on top of each provider's own sandbox. Every task isolated to its own git
worktree + branch. Secrets never read, stored, or logged (structured logs run through pattern-based
redaction unconditionally). Full detail, including explicitly documented limitations (network egress
isn't independently sandboxed; the command monitor is advisory, not a kernel boundary):
[docs/security.md](./docs/security.md).

## 10. Git / worktree behavior

Every task gets a baseline commit capture, a dedicated worktree (`<data dir>/worktrees/<task-id>`) on
its own branch (`ai/<task-id>`), and a commit after every step that changes files — your primary
checkout is never touched, and merging a finished task's branch back is a manual, human step (see
[the final_merge gate discussion](./docs/workflow.md#approval-gates)). Full detail:
[docs/architecture.md](./docs/architecture.md#git-worktree-behavior).

## 11. Verification system

Discovers only checks that are actually configured in the repo (npm scripts that exist; Foundry
projects; `slither` if it's on `PATH`) — never invents or blindly runs commands. Results are
structured `PASS | FAIL | SKIPPED | NOT_CONFIGURED`; a task cannot reach `READY` while a
`requiredForReady` check is failing. See [docs/architecture.md](./docs/architecture.md) and
`packages/verification/src/detectors.ts`.

## 12. Testing results

```
Test Files  17 passed (17)
     Tests  140 passed (140)
```

A first independent audit found, and a hardening pass fixed — each with a regression test: repository-controlled arbitrary command execution in verification (now gated by explicit, hash-pinned approval —
`packages/verification/src/verification.test.ts`, `orchestrator.hardening.test.ts` "C1"); a spoofable
markdown-fence context renderer (now a nonce-delimited JSON encoding — `packages/core/src/trust.test.ts`);
agent-generated content losing its trust label when passed to the next pipeline stage (now routed
through labelled context blocks — "C4"); a `PAUSED` task that couldn't be cancelled and a `FAILED` task
that could never be retried (both fixed — "H1"/"H2"); a partially-failed review round silently
discarding a completed reviewer's result (now persisted immediately — "H3"); no detection of the
worktree diverging from persisted task state after a crash ("H4"); an unused `checkPath` safety check
now genuinely wired into request building; and budget/cost limits that were schema-only and never
enforced (now real, with tests).

**Non-atomic task persistence and cross-process locking took two rounds to actually fix, and that's
worth being honest about rather than smoothing over.** The first hardening pass replaced the in-memory
write queue with atomic temp+rename writes (still correct, unchanged) and a file-based advisory lock —
but a **second** independent audit found that lock's own exclusivity guarantee didn't hold under real
concurrent contention: two genuinely independent OS processes (not just two cooperating objects) could
both end up believing they held the same task lock, via two separate races in `TaskLock.acquire()`
(one in how the lock file was written, one in how a stale lock was reclaimed — see
[docs/security.md](./docs/security.md#persistence--cross-process-safety) for the exact mechanism of
each). Both are now fixed, and — because "tests pass" was exactly what missed this the first time —
the regression test for it (`packages/security/src/task-lock.test.ts`'s "true concurrency" test)
spawns 8 real `node` subprocesses hammering the same lock with no head start and asserts zero
violations, which is what it takes to actually exercise the race; two-participant, staggered tests
never triggered either bug. See [docs/security.md](./docs/security.md) for the full, re-verified
security model.

Coverage also includes: workflow transitions (happy path, illegal transitions, loop-cap escalation,
pause/resume/retry/cancel from every applicable state), config load/save round-trips and
role-resolution precedence, security command/path/event policy (including a real symlink-escape
check), git safety against **real** temporary git repositories, verification discovery + execution
against real temp projects (including the command-approval gate proven with a marker-file check that
genuinely never ran before approval), log redaction, provider binary resolution (including a
digit-count version-comparison regression), a real integration smoke test against this machine's
actual bundled Codex/Claude CLIs (credential-free diagnostic calls only), a full mock-provider-driven
end-to-end orchestrator run through the entire pipeline, and VS Code extension logic tests (multi-root
folder targeting) run under a minimal `vscode`-module mock.

Run it yourself: `npm install && npm run typecheck && npm test`.

**A real, authenticated end-to-end run has since happened, and it found real bugs.** With both CLIs
authenticated and the user's explicit go-ahead, a real task ran through this exact pipeline — Codex
as architect/reviewer/security_reviewer/verifier, Claude Code as implementer/fixer — against a
separate real repository, driven only through `ai <command>`, no mocking. It failed twice on the
very first run: `codex exec --output-schema` rejected AI Engine's hand-written JSON schemas
(OpenAI's Structured Outputs strict mode requires `additionalProperties: false` everywhere, which
this project had never actually sent to a live endpoint before), and retrying a failed Codex role
crashed outright because `codex exec resume` doesn't accept the same flags as a fresh `codex exec`.
Both were genuine, previously-unexercised defects, both now fixed with tests. Once fixed, the
pipeline completed for real: a genuine correctness bug in the implementer's output (a regex that
incorrectly matched a trailing newline) was caught by Codex's review, and fixed by Claude, and the
task reached `READY`. That run also found — and this repository then fixed — that a fresh git
worktree has no installed dependencies (verification failed with `tsc: command not found` until
addressed; see `prepareWorktreeDependencies` in [docs/architecture.md](./docs/architecture.md#git-worktree-behavior)),
that Claude Code's `acceptEdits` permission mode does not actually authorize headless Bash execution
the way this project had assumed (now `auto`, verified against the real CLI across all six
documented permission modes — see [docs/providers.md](./docs/providers.md)), and that a `fix()` pass
could optimistically mark a finding "fixed" without actually having addressed it (now a distinct,
honest `fix_attempted` status — see `ReviewFinding.status` in `packages/core/src/review.ts`). See
[docs/providers.md](./docs/providers.md#what-was-verified--including-since-a-real-authenticated-end-to-end-run)
for the full account.

**A second real, unmocked end-to-end run has since validated all three fixes above under a fresh
task against a different external repository** — same pipeline, same roles, no mocking. That run's
first review round produced two genuine, unforced findings (a lint regression and a real
safe-integer-overflow bug); `fix()` marked both `fix_attempted`, never `fixed`; and a fresh,
independent re-review round found nothing, reaching `READY`. No further AI Engine defects were
found. This is now a system validated by **two** independent real end-to-end runs — not a claim of
general production readiness beyond what those two runs actually exercised. See
[CHANGELOG.md](./CHANGELOG.md) for the full v0.1.0 scope: what's validated, what's a known
limitation, and what's explicitly out of scope.

## 13. Known limitations

- **No automatic worktree/branch garbage collection** for cancelled/failed/old tasks — cleanup is a
  manual `git worktree remove` today (documented in
  [docs/troubleshooting.md](./docs/troubleshooting.md)).
- **No independent network sandboxing.** Disk-access sandboxing is real (provider sandbox flags +
  worktree confinement); network egress relies on each provider's own controls. See
  [docs/security.md](./docs/security.md#what-is-not-enforced-here-documented-limitations).
- **No true per-tool-call human approval mid-invocation.** Both adapters run fully unattended once
  started (headless subprocesses deny rather than hang on anything that would need a live prompt);
  human control happens at workflow-gate granularity (plan, security review) plus the explicit
  verification-command approval gate — not per shell command a provider's own agent decides to run.
- **Codex has no system/user prompt channel to structurally separate.** `codex exec` takes one flat
  prompt; the system policy is labelled with plain-text headers as an honest acknowledgment of this,
  not a structural fix. Claude Code does get a real system-prompt channel. See
  [docs/security.md](./docs/security.md).
- **No `@vscode/test-electron` harness.** VS Code extension logic (multi-root folder targeting) is
  tested by mocking the `vscode` module under plain `vitest` rather than a real extension host — real,
  useful coverage of the decision logic, but not a substitute for manual verification of actual VS Code
  UI behavior (tree views, command palette). See [docs/vscode.md](./docs/vscode.md).
- **Only Codex and Claude Code are implemented.** Adding a third provider is intentionally small —
  see [§15](#15-how-to-add-a-future-provider-eg-gemini).
- **The verification-command approval UI doesn't show `cwd`.** A second independent audit found that
  `ai checks`/the VS Code approval prompt display a repository-configured check's `command` but not
  its `cwd`, which is unvalidated and can be set to anywhere on disk — a reviewer approving based on
  what they're shown wouldn't see that. Not yet fixed; treat the approval gate's information as
  incomplete until this is addressed.
- **The verification-command approval gate is scoped to AI Engine's own automated verification
  step**, not a comprehensive guarantee that no repository-configured command can ever execute — an
  implementer/fixer role already has real shell access inside its worktree and could in principle
  read `.ai/project.yaml` and run the same command directly through its own tool, outside
  `CommandApprovalStore`. Whether a provider's own OS-level sandbox would additionally block that
  agent from _writing_ to the (out-of-worktree) approval store if it tried to self-approve via the
  `ai` CLI was not conclusively verified (see [docs/security.md](./docs/security.md)) — this is a
  documented open question, not a confirmed hole, but the approval gate should not be read as "no
  repository-configured command can ever run."

## 14. How to install & use the system

```sh
npm install
npm run build
npm test              # optional but recommended: 140 tests, ~7s

# Install the `ai` CLI for your user (no root needed):
mkdir -p ~/.local/bin
ln -sf "$(pwd)/packages/cli/dist/bin.js" ~/.local/bin/ai
# make sure ~/.local/bin is on PATH (it already was on this machine)
ai --version

# Install the VS Code extension:
cd extensions/vscode && npm run package
code --install-extension ai-engine-vscode-0.1.0.vsix
```

Then, in any git repository: `ai init`, `ai task "..."`, and either drive it step by step or with
`ai run` — see [docs/cli.md](./docs/cli.md) for the full walkthrough, or use the VS Code commands
(see [docs/vscode.md](./docs/vscode.md)).

## 15. How to add a future provider (e.g. Gemini)

Implement `ProviderAdapter` (one file in `packages/providers/src`) and add one line to
`defaultProviderFactories()` in `packages/orchestrator/src/role-registry.ts`. Nothing else in the
system changes. Full walkthrough: [docs/adding-a-provider.md](./docs/adding-a-provider.md).

---

## Documentation index

- [docs/architecture.md](./docs/architecture.md) — full architecture & rationale
- [docs/workflow.md](./docs/workflow.md) — state machine, approval gates, loop guarding, resumability
- [docs/providers.md](./docs/providers.md) — Codex/Claude integration detail, what was verified live
- [docs/security.md](./docs/security.md) — trust model, sandboxing, secrets, documented limitations
- [docs/project-init.md](./docs/project-init.md) — `.ai/` structure and conventions
- [docs/cli.md](./docs/cli.md) — full `ai` command reference + walkthrough
- [docs/vscode.md](./docs/vscode.md) — extension install & command reference
- [docs/adding-a-provider.md](./docs/adding-a-provider.md) — how to add Gemini/local models/etc.
- [docs/troubleshooting.md](./docs/troubleshooting.md) — common issues
