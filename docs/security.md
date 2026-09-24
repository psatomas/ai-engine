# Security model

Agent execution is treated as privileged throughout this system. This document maps the mission's
security boundaries to what is actually implemented, and is explicit about what is _not_ enforced by
AI Engine itself versus what is delegated to the provider's own sandbox.

> This document was substantially revised after an independent audit found that the previous version
> overstated several of these boundaries (a fixed markdown-fence context renderer that untrusted
> content could break out of; a command monitor described as preventive when it can only react after
> the fact; a path-confinement check that was implemented and tested but never actually called; a
> repository-controlled command-execution surface with no approval gate at all). Every claim below was
> re-verified against the current code and backed by an executable regression test — see the file
> reference next to each one.

## Trust levels

`packages/core/src/trust.ts` defines six levels, and every piece of text that reaches a provider
prompt is tagged with one:

| Level                      | What it is                                                                    | Treated as                 |
| -------------------------- | ----------------------------------------------------------------------------- | -------------------------- |
| `trusted_system`           | Role framing authored by AI Engine (`prompts.ts`)                             | Authoritative              |
| `trusted_user`             | The operator's verbatim task request                                          | Authoritative for intent   |
| `repository_content`       | Anything read from the repo: source, docs, comments, `.ai/context/*`          | **Data only**              |
| `repository_configuration` | Repository-tracked config that can influence _what runs_ (`.ai/project.yaml`) | **Data only, higher-risk** |
| `agent_generated`          | A prior agent's own output: specifications, plans, review findings            | Data, not a command        |
| `command_output`           | Raw stdout/stderr of an executed command (build/test/verification)            | Data, least trustworthy    |

`repository_configuration` and `command_output` are split out from `repository_content`/
`agent_generated` deliberately: configuration can drive _execution_ (see the verification-command
approval gate below), and command output is the category most likely to carry adversarial content
completely unrelated to what the repository's source looks like (a compromised dependency's test
runner can print anything).

### How untrusted content is rendered (structural, not just textual)

`renderContextBlocks()` (`packages/core/src/trust.ts`) encodes every context block as a JSON array
entry, delimited by a **random token generated fresh on every render**, instead of a fixed markdown
fence:

```
The following is a JSON array of context entries, delimited by the random token "<nonce>"...
===CONTEXT-<nonce>-BEGIN===
[ { "trust": "repository_content", "label": "...", "content": "..." }, ... ]
===CONTEXT-<nonce>-END===
```

This closes a concrete vulnerability the previous version had: content is JSON-string-escaped, so it
cannot contain an unescaped quote or a literal ` ``` ` that breaks out of its own boundary the way it
could against a fixed markdown fence, and because the boundary token is unpredictable per render,
content authored in advance (i.e. anything already sitting in a repository) cannot pre-forge a closing
boundary followed by a fake `trusted_system` sibling block. See the adversarial regression tests in
`packages/core/src/trust.test.ts` — including one that literally attempts the fence-breakout-and-forge
attack and asserts it lands as inert data.

This is a meaningfully harder target, not a claim of unspoofability: it is still text handed to a
text-completion model, and Codex's `codex exec` has no separate system/user channel at all (confirmed
against `--help`) — the system policy and the rendered context are one flat string on stdin, labelled
with plain-text section headers as an honest acknowledgment of that limitation, not a structural fix
(see `packages/providers/src/codex.ts` and [providers.md](./providers.md)). Claude Code does have a
real system-prompt channel (`--append-system-prompt`), which is used for the system policy.

### Provenance is preserved between pipeline stages

A second, related defect the audit found: a specification/plan produced by the architect role (itself
correctly exposed to repository content as labelled context) was being interpolated **unlabeled**
directly into the next role's `instructions` string — indistinguishable from the operator's own
trusted request. `Orchestrator` (`packages/orchestrator/src/orchestrator.ts`) now routes all of this
through labelled `context` blocks instead: `planContextBlocks()` (specification/plan, `agent_generated`),
`buildFixContext()` (failing-check output as `command_output`, open findings as `agent_generated`), and
the review step's diff/verification context (`command_output`) and `.ai/project.yaml` review settings
(`repository_configuration`). `instructions` is reserved for AI-engine-authored directive text plus the
operator's own verbatim request — nothing agent-generated or repository-derived ever lands there
unlabelled. See `packages/orchestrator/src/orchestrator.hardening.test.ts`'s "C4" tests, which inspect
the actual `AgentInvocationRequest` a mock provider receives and assert marker text from a generated
plan/finding appears only inside a correctly-labelled context block, never in `instructions`.

## Repository-controlled verification commands

`.ai/project.yaml`'s `verification.additionalChecks` lets a repository define its own verification
commands — and that file is git-tracked, so anyone who can land a PR can edit it. Previously, such a
command executed automatically and unconditionally the first time anyone ran `ai verify`/`ai test`/
`ai run`. That is now gated by an explicit, machine-local approval store:

- `@ai-engine/security`'s `CommandApprovalStore` (`packages/security/src/command-approval.ts`) records
  approvals keyed by a SHA-256 hash of the **exact command text and the exact working directory it
  runs in** — `cwd` is execution-relevant (a different `package.json`, config, or relative-path file
  per directory), so an approval binds both, not the command text alone. The `cwd` half of that
  identity is the check's _canonical, repository-relative_ location (`canonicalCwd()`), not an
  absolute path — a single approval stays valid across every future task for the same repository
  even though each task gets its own, transient, absolute worktree path; it does not survive the
  check's _configured_ `cwd` actually changing. The record lives in a file under the global data
  directory (`<dataDir>/approvals/<repo-hash>.json`) — never git-tracked, so a malicious PR cannot
  also grant itself approval.
- `@ai-engine/verification`'s `runVerification()` checks this store (plus, as a secondary floor, the
  same command deny-list used elsewhere — an approved-but-denylisted command is still refused, e.g.
  `git push --force`) before ever executing a check whose `origin` is `"repository_configured"`. An
  unapproved or denylisted command is reported as a new `NOT_APPROVED` status and never runs.
  `origin: "auto_detected"` checks (an npm script that exists in `package.json`, a Foundry command) are
  unaffected — AI Engine constructs those command strings itself (`npm run <script>`); only the free-form
  text from `additionalChecks` requires this gate.
- **CLI and VS Code use the same mechanism**: `Orchestrator.approveVerificationCommand()` is the one
  approval path both `ai checks`/`ai approve-check` and the "AI: Approve Verification Command" VS Code
  command call.

See `packages/verification/src/verification.test.ts`'s "repository_configured commands require
explicit approval" tests (which prove, via a command that touches a marker file, that an unapproved
command genuinely never runs) and `orchestrator.hardening.test.ts`'s "C1" end-to-end test (drives a
task through `TESTING` → blocked as `NOT_APPROVED` → `ai approve-check` → passes → `READY`).

The one-time dependency-install attempt made when a task's worktree is created
(`prepareWorktreeDependencies`, see [architecture.md](./architecture.md#git-worktree-behavior))
sits in the same trust category as `auto_detected` checks, for the same reason: the command that
runs is always one of four fixed, hardcoded package-manager install commands AI Engine chooses
itself from which lockfile is present, never anything read from the repository — so it does not go
through `CommandApprovalStore` either, but it is still checked against the security policy's
command deny-list first, for defense-in-depth.

## Command & path guards (`@ai-engine/security`)

`SecurityPolicy` (`packages/security/src/policy.ts`) is defense-in-depth for commands a provider's own
agent decides to run mid-invocation (as opposed to the approval gate above, which is the primary
boundary for repository-configured verification commands specifically). What it adds:

1. **A deny-list checked before any run starts** (`security.deniedCommandPatterns`, defaults include
   `rm -rf /`, `git push --force`, `git reset --hard`, fork bombs, `mkfs`, `dd if=`), matched after
   whitespace/case normalization so trivial spacing/case variation doesn't defeat an otherwise-matching
   pattern. This is still a substring heuristic, not a parser — treat a match as a strong signal, not a
   guarantee nothing worse slipped through unmatched.
2. **A streaming monitor** (`evaluateEvent`) that reacts to a denied command as soon as it is
   _reported_. Depending on the provider's event protocol this can be after the command already ran
   (confirmed for Codex: its JSON events report `command_execution` only once complete) — this stops a
   run from continuing, it does not guarantee the triggering command never executed. Its behavior is
   also now genuinely governed by the role's `ApprovalPolicy`, not just forwarded to the provider and
   otherwise ignored: `"never"` terminates the run on a match; `"on_request"`/`"untrusted_only"`
   downgrade to a logged warning that the run continues past (an operator who assigned a role one of
   those policies has already accepted a more permissive, reviewed posture).
3. **Path confinement checks** (`checkPath`) with a real `fs.realpath` resolution. This is genuinely
   wired into the request-building path now (`Orchestrator.buildRequest()` calls it for every
   invocation's working directory, not just unit-tested in isolation) — it catches a worktree directory
   (or a path component of it) having been replaced by a symlink pointing outside the known worktree/
   repo roots between task creation and this invocation. See `orchestrator.hardening.test.ts`'s
   "checkPath is genuinely wired into request building" test, which replaces a live worktree with a
   symlink and asserts the next step refuses to proceed.

## Persistence & cross-process safety

Two independent properties, both backed by executable tests, not just a design description:

- **Atomic writes.** `TaskStore.save()` (`packages/orchestrator/src/task-store.ts`) always writes to a
  unique temp file and `rename()`s it over the target — atomic on every filesystem Node supports, so a
  reader can only ever observe the complete old record or the complete new one, never a torn write,
  regardless of when the writing process is killed. A record that somehow still fails to parse raises a
  distinct `TaskRecordCorruptedError` (naming the file) instead of a bare `SyntaxError`, and
  `listTasks()` skips a corrupted file rather than failing the whole listing.
- **Cross-process locking.** `@ai-engine/security`'s `TaskLock` (`packages/security/src/task-lock.ts`)
  is a dependency-free advisory lock backed by exclusive file _linking_ (`link(tempPath, lockPath)`,
  atomic at the OS level on every platform Node supports — same guarantee class as `O_CREAT|O_EXCL`)
  with stale-lock detection (age, and — on the same host — liveness-checking the holding PID). Every
  mutating `Orchestrator` method acquires this lock for the whole read-modify-write cycle, not just the
  final write, so a second process attempting the same step on the same task fails fast with a clear
  `TaskLockedError` (naming the holder's PID) instead of racing it. Read-only accessors (`getTask`,
  `listTasks`, `currentDiff`) never take the lock — atomic writes alone make unlocked reads safe.

  This mechanism went through two rounds of hardening after a second independent audit found the
  first version's exclusivity guarantee didn't actually hold under real concurrent contention — worth
  recording honestly rather than glossing over, since it's exactly the kind of bug "the tests pass"
  can hide:
  1. The original `acquire()` created the lock file with `open(path, "wx")` and wrote its JSON
     content in a _separate_ subsequent step. A concurrent process that got `EEXIST` and immediately
     checked staleness could observe the file mid-write (empty/partial), conclude it was corrupt, and
     steal it while the true holder still believed it held the original — closed by writing the full
     content to a private temp file first and _atomically publishing_ it at `lockPath` with one
     `link()` call, so the path never becomes observable with incomplete content.
  2. Even after (1), stale-lock reclamation deleted whatever was at `lockPath` unconditionally once
     judged stale, without checking it was still the same generation — a process could correctly judge
     generation N stale, then delete generation N+1 (a fresh, valid lock a third process created in
     the meantime) instead. Closed by guarding the reclaim delete with the same nonce-comparison
     `release()` already used.

  Both bugs required many independent processes racing with **no head start** to reproduce — two
  participants with any stagger at all never triggered either one. The regression test
  (`packages/security/src/task-lock.test.ts`'s "true concurrency" test) reflects that: it spawns 8
  real `node` subprocesses (`test-support/lock-stress-worker.mjs`) hammering the same lock with no
  stagger and asserts zero mutual-exclusion violations across all of them — not just that the public
  API "looks right" from two cooperating objects. See `orchestrator.hardening.test.ts`'s "C2" test for
  the same property at the `Orchestrator` level.

## Git/task-state divergence detection

A separate, related risk: if a process is killed after a step commits into the worktree but before the
resulting `TaskRecord` is persisted, re-running the step would blindly re-invoke an agent on top of
already-committed, "forgotten" work. Every mutating step now compares the worktree's actual current
commit against `GitBaseline.lastKnownCommit` (refreshed on every successful `persist()`) before doing
anything else, and raises `GitStateDivergedError` if they don't match — the task stays blocked until a
human runs `ai acknowledge-divergence <taskId>` (after inspecting `ai diff`) to accept the current
worktree state. See `orchestrator.hardening.test.ts`'s "H4" test, which simulates exactly this crash
window by committing into a task's worktree out-of-band and asserting the next step refuses to proceed
silently.

## Git as the safety boundary

Every task runs in its own git worktree + branch, created from a captured baseline commit — see
[architecture.md](./architecture.md#git-worktree-behavior) for the full rationale. Concretely, this
means an agent physically cannot:

- touch files in your primary checkout (a different directory entirely);
- lose in-progress uncommitted work in your primary checkout (it isn't checked out into the worktree
  at all);
- rewrite history on any branch other than its own `ai/<task-id>`.

`GitRepository.diff()` also flags a fixed list of security-sensitive paths
(`packages/git/src/suspicious.ts`: `.github/workflows/`, `.env*`, `.ssh/`, `id_rsa`, `credentials.*`,
`.npmrc`, `.git/hooks/`, `Dockerfile`, `docker-compose.yaml`) whenever a diff touches them, surfaced
in `ai diff` and the task summary — these are exactly the paths where a subtle unwanted change (a
modified CI workflow, a weakened `.npmrc`) is both plausible and disproportionately dangerous.

A repository with no commits yet is rejected up front with a clear `EmptyRepositoryError` rather than
a raw git failure partway through worktree creation.

## Approval gates

See [workflow.md](./workflow.md#approval-gates) for the mechanics. Destructive-by-default is
explicitly avoided: implementation only ever happens in an isolated worktree; nothing merges to a
real branch without a human running `git merge`/opening a PR; and both a security-relevant sign-off
(`security_review`) and the initial plan (`plan`) are human gates by default (`approvals.plan: true`,
`approvals.security_review: true` in `GlobalConfigSchema`'s defaults) — an operator has to explicitly
opt out per-machine, not opt in. A `PAUSED` task (including one sitting on the `security_review` gate)
can always be cancelled directly — it is not a dead end requiring a resume first.

## Budgets

`budgets.maxInvocationsPerRolePerTask` and `budgets.maxCostUsdPerTask` (global config) are enforced,
not merely schema fields: `Orchestrator.checkBudget()` refuses to start a further invocation once a
role's count, or the task's accumulated reported cost, is at or above the configured limit —
`BudgetExceededError` is raised _before_ the call, not after. Cost is tracked per-task, accumulated
across every invocation that reports it (`TaskRecord.usage.totalCostUsd`); only providers that report
cost (currently Claude) contribute — an invocation from a provider that doesn't report cost (Codex) adds
nothing to the total, which is disclosed rather than silently assumed to be zero-cost. See
`orchestrator.hardening.test.ts`'s "Budget enforcement" tests.

## Secrets & credentials

AI Engine never reads, stores, transmits, or logs API keys, tokens, or session credentials:

- Provider authentication is entirely delegated to each CLI's own login flow (`codex login`, `claude
auth login`) and storage (`~/.codex`, `~/.claude/.credentials.json`) — AI Engine only ever shells
  out to a `login status`/`auth status` diagnostic to report whether a provider is usable, and never
  parses or forwards the credential material itself.
- `@ai-engine/logging`'s `redact()` (`packages/logging/src/redact.ts`) runs over every structured log
  field: it masks any field whose _key_ looks secret-shaped (`apiKey`, `token`, `password`,
  `Authorization`, ...) and scrubs known secret _value_ shapes (`sk-...`, `ghp_...`, AWS access keys,
  JWTs) even when they show up somewhere unexpected (free-text agent output, a command line). This
  runs on every log line, unconditionally, in every sink.
- Global config (`~/.config/ai-engine/config.yaml` on Linux) never holds a credential — it holds at
  most a `binaryPath` override per provider. Nothing about this file needs to be kept out of git,
  though it isn't part of any project's repository either way (see [architecture.md](./architecture.md)
  on separating global config from project config).
- The command-approval store and task locks (above) live under the global data directory, never inside
  the repository, and are never git-tracked.

## What is _not_ enforced here (documented limitations)

- **Network egress** is not independently blocked by AI Engine. Codex's sandbox modes govern disk
  access, not network; Claude Code's tool-based restriction (`--disallowedTools WebFetch,WebSearch`)
  blocks the _built-in_ web tools but not arbitrary network calls a shell command could make under
  `workspace_write`. `security.network` exists in config as a documented intent, but true network
  isolation requires an OS-level sandbox (container, VM, firewall rule) outside this project's scope
  — see the provider's own sandboxing docs for that layer.
- **The command/path guard for provider-initiated commands is advisory once a subprocess is running**,
  not a kernel-enforced boundary: it reacts to _reported_ events, so a provider bug or a sufficiently
  obscure shell invocation that evades event reporting would not be caught. The real boundary remains
  the provider's own sandbox implementation. (The repository-configured _verification_ command surface
  above is different — that one is a hard gate: the command simply never runs without prior approval.)
- **Auto-detected verification commands** (`npm run <script>`, `forge build`, ...) still run with full
  host privileges and no sandboxing beyond `cwd` — this is the same trust a developer already extends by
  running `npm test` themselves, and is out of scope for the approval gate (which targets the
  _additional_, repository-freeform command surface AI Engine itself introduces).
- **Claude Code's headless permission-mode behavior has since been exercised against real, live
  invocations** — both during a real end-to-end task run and in dedicated testing across all six
  documented `--permission-mode` values on the actual installed CLI (see
  [providers.md](./providers.md)). That testing is _why_ `--permission-mode` is `auto`, not the
  previously assumed `acceptEdits` (which turned out not to cover Bash execution at all in headless
  mode) and not `bypassPermissions` (which works too, but throws away Claude Code's own internal
  safety classifier for no capability this workflow needs). Read-only role enforcement itself
  (`--tools Read,Grep,Glob`, excluding Edit/Write/Bash entirely) remains a mechanical guarantee that
  doesn't depend on permission mode at all — it's inert for read-only roles either way. What
  permission mode does **not** provide, confirmed directly: any additional path confinement once
  Bash is allowed — a Bash command can write outside the working directory under `auto` just as it
  can under `bypassPermissions`. That was never permission-mode's job; the real boundary for a
  workspace_write role remains the dedicated task worktree plus this engine's own reactive
  command-deny-list monitor (`SecurityPolicy.evaluateEvent`), both unaffected by this choice.
