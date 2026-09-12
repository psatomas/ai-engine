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

## Verification check discovery

`@ai-engine/verification`'s `detectChecks(repoRoot)` (`packages/verification/src/detectors.ts`) never
invents or blindly runs a command — it only proposes checks whose trigger condition (a script, a
config file, an installed tool) actually exists in the repository. Two independent detectors run in
parallel: `detectNodeChecks` (npm scripts: `build`/`test`/`typecheck`/`lint`/`format:check`) and
`detectFoundryChecks` (`forge build`/`forge test`/`forge fmt --check`, plus `slither` if it's on
`PATH`).

**Discovery is bounded, not just root-level.** A real end-to-end run against a monorepo with its
Foundry project at `packages/contracts/foundry.toml` — not the repository root — exposed that
detection originally only ever looked at `repoRoot` itself, silently missing any nested project
entirely. `discoverProjects(repoRoot)` now runs **one** bounded, deterministic traversal that finds
both manifest types (`foundry.toml`, `package.json`) at once — not two separate walks of the same
tree — with four fixed bounds:

- **Maximum depth 3** below `repoRoot` (which is depth 0) — enough to reach a real observed case
  (`packages/contracts`, depth 2) with headroom, not an unbounded tree walk.
- **A hard cap on total directories visited** (`MAX_VISITED_DIRECTORIES`, 400) and **on entries read
  per directory** (`MAX_ENTRIES_PER_DIRECTORY`, 2000) — depth alone doesn't bound cost against a
  repository that is merely very _wide_. The per-directory bound is enforced by streaming
  (`opendir()`'s async iterator, stopping as soon as the count is exceeded) rather than by reading a
  directory's full listing and trimming it afterward — a later review found the original
  `readdir()`-based version checked the bound only after already paying the cost it was meant to cap.
  If either bound is hit, discovery stops safely (no throw, no hang) — and, since some required nested
  project's checks may never have been generated at all when this happens, `detectChecks` adds a real,
  `requiredForReady: true` check (`discovery.bounded`) that deterministically fails, rather than only a
  `notConfigured` note. A second independent review found that a `notConfigured`-only signal is never
  consulted by `verificationPassed()` (`packages/core/src/verification.ts`), so a task could reach
  `READY` having silently discovered less than it appeared to; a real, failing, required check is the
  smallest change that actually blocks it.
- **Never descends into** `.git`, `node_modules`, `lib`, `out`, `cache`, `dist`, or `build`, at any
  depth — dependency trees, build output, and VCS metadata are never treated as candidate projects.
- **Never follows symlinked directories** — `Dirent.isDirectory()` (from `opendir`'s own streamed
  entry metadata) is false for a symlink regardless of what it points to, so this is excluded for free
  at discovery time without a `realpath` call.

A directory that is real at discovery time but gets replaced by a symlink before a discovered check
actually runs is a separate, later-stage race that discovery-time exclusion alone cannot close — see
"Execution-time containment" below for the narrower, precisely-scoped guarantee that section actually
provides against it.

Each discovered directory produces the same fixed set of checks as the root always has, with `cwd`
set to that directory — always the directory the manifest was found in, never a path read from the
manifest's own content, so a hostile `foundry.toml`/`package.json` cannot redirect a check elsewhere.
**Root-level check ids never change** (`forge.test`, `npm.build`, ...) — a nested project's checks
get a path-qualified id instead: `forge.test:packages/contracts`, `npm.test:packages/sdk`. This keeps
the change fully backward compatible and keeps ids collision-free across multiple discovered
projects.

**Trust boundary, precisely.** A later review found the previous wording here overclaimed this —
discovery does **not** avoid reading or executing repository content; be precise about what actually
stays fixed and what doesn't:

- Discovery **does read** repository-controlled `package.json` files, to see which of the known,
  fixed script names (`build`/`test`/`typecheck`/`lint`/`format:check`) the repository has defined.
- The **shell command text** AI Engine constructs for a check is fixed and static —
  `` `npm run ${script}` `` for a script name from that fixed list, never a string read from the
  manifest's own content. This is the part that stays fully AI-Engine-controlled.
- `npm run <script>` then **executes whatever the repository defined that script to do** —
  entirely repository-authored behavior, exactly as it would be if a human ran `npm run build`
  themselves. AI Engine controls _which script name_ gets invoked and _that_ the command string
  invoking it is fixed; it does not control, and makes no claim to control, what that script actually
  does once npm hands it off.
- This is still meaningfully narrower than the separate, higher-risk `"repository_configured"` +
  `CommandApprovalStore` path (see
  [docs/security.md](./security.md#repository-controlled-verification-commands)): there, the full
  command _string itself_ is repository-authored and requires explicit human approval before ever
  running. Here, only the script's _name_ is repository-controlled (from a small fixed set), and only
  in service of npm running whatever that named script already does — not a materially different
  trust level from a developer already choosing to run `npm test` themselves.

**npm de-duplication is workspace-aware, not a text-substring guess.** An earlier version of this
suppressed a nested package's script whenever the corresponding root script's command merely
_contained the text_ `--workspaces` — a first independent review correctly flagged that as unsound:
`"echo --workspaces"` would have matched, and a genuine `--workspaces` script would have suppressed
packages it doesn't actually reach. A **second** independent review then found the immediate fix for
that still wasn't tight enough: checking only "root's script contains `--workspaces` somewhere" has
no tie back to _which_ script it actually runs, so a root script that genuinely invokes
`npm run <some other script> --workspaces` would have been accepted as covering a completely
unrelated one. A nested package's script is now skipped only when **all three** hold: (1) root's
script for that same name is a genuine `npm run <that same script> --workspaces` invocation — checked
by tokenizing the command and requiring the token immediately after `run` to equal the script name
being evaluated, not substring-matching it; (2) root's parsed `workspaces` configuration (array form,
`["packages/*"]`, or object form, `{"packages": ["packages/*"]}` — npm's own two supported shapes)
actually includes that package's path, via minimal, deterministic single-segment `*` glob matching (no
`**`/recursive globs, no full minimatch). Failing to prove genuine coverage — including a wrapper
prefix like `cross-env FOO=bar npm run build --workspaces`, deliberately left unrecognized rather than
adding a general shell parser — always resolves to **adding** the nested check, never to skipping it:
a possibly-redundant extra check is the safe direction, a silently-missing one is not. Where this still
isn't enough, `.ai/project.yaml`'s `verification.additionalChecks` / `disable` remain the human
override, exactly as for every other detection edge case.

**Malformed manifests: nested is lenient, root is loud.** A malformed or unreadable nested
`package.json` is treated as "nothing to detect here" (`readPkgJson`) — one bad vendored, generated, or
otherwise unrelated nested file must never halt discovery of everything else. The repository root gets
different treatment (`readRootPkgJson`, three distinct states: absent / malformed / ok): a malformed
root `package.json` produces a real, `requiredForReady: true` check (`npm.root`) that deterministically
fails with the parse error, rather than being silently collapsed into "no package.json here" the way it
briefly was — a second independent review found that regression by comparing against this project's own
git history, where the original, pre-nested-discovery code let a malformed root manifest throw visibly
instead. The root manifest is a file the user directly owns and relies on; a nested one, found
incidentally, is not.

**Execution-time containment — what it guarantees, precisely.** Discovery-time symlink exclusion
(above) only reflects the filesystem's state at detection time — a directory could be replaced by a
symlink pointing outside the repository between discovery and actual execution (TOCTOU). `runner.ts`'s
`runOne` re-resolves the check's `cwd` and the task's repository root via `realpath` immediately before
`execa` runs (reflecting the filesystem's _current_ state, not the one discovery observed), refuses to
execute — reporting `FAIL` with a clear reason — if the resolved path is no longer contained within the
resolved root, and executes using that resolved path, not the original `check.cwd`. A second, later
review found the wording that used to be here overclaimed what this achieves — stated precisely:

- Resolving and validating `realCwd` prevents execution through a symlink redirection that already
  existed at the moment `realpath` resolved it — that's the pre-existing-redirection case, and it's
  genuinely rejected.
- Executing with that validated, resolved pathname (not the original `check.cwd`) avoids re-resolving
  `check.cwd`'s own symlink a second, independent time at spawn — the specific issue an earlier version
  of this same fix had: it validated a resolved path and then still executed with the original,
  unresolved `check.cwd`, so `execa` re-resolved that symlink itself at spawn time, independently,
  reopening exactly the redirection the check was meant to catch.
- It does **not** eliminate pathname-based TOCTOU races in general. `realCwd` is still only a pathname,
  not an opened directory descriptor — the path it names can still, in principle, be removed, renamed,
  or replaced by something else (including a new symlink) after this check validates it and before
  `execa`'s spawn actually opens it. Nothing here prevents that specific window; closing it would need
  file-descriptor-relative execution (opening the directory once and executing relative to that open
  handle, `openat`-style) rather than validating and re-passing a path string — a materially larger
  change this fix does not make. **This is not a claim of complete TOCTOU elimination** — it reduces
  and avoids the specific re-resolution issue described above, it does not close every pathname-based
  race.

This is opt-in via `RunVerificationOptions.repoRoot`, which the orchestrator always supplies; omitting
it (existing tests/callers that construct checks directly) preserves prior behavior exactly.

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
