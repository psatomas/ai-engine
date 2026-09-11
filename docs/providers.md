# Provider integration

## What was actually inspected

This machine (Arch Linux, Node v26.4.0, npm 11.16, git 2.54, VS Code 1.125.1) has neither the Codex
CLI nor the Claude Code CLI on `PATH`. Both are, however, bundled inside their respective VS Code
extensions:

|                 | version found                 | location                                                                          |
| --------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| Codex CLI       | `codex-cli 0.154.0-alpha.6.1` | `~/.vscode/extensions/openai.chatgpt-<ver>/bin/<platform>/codex`                  |
| Claude Code CLI | `2.1.268`                     | `~/.vscode/extensions/anthropic.claude-code-<ver>/resources/native-binary/claude` |

`@ai-engine/providers`' `resolveProviderBinary` (see `packages/providers/src/resolve.ts`) checks, in
order: an explicit `providers.<id>.binaryPath` in global config → `PATH` → the newest matching
install under `~/.vscode*/extensions`, `~/.vscode-server*/extensions`, `~/.cursor/extensions`,
`~/.windsurf/extensions`. This means AI Engine works out of the box on a machine that only has the
VS Code extensions installed, with no separate CLI install step — verified live in this repo's own
test suite (`packages/providers/src/adapters.integration.test.ts` resolves and runs `--version` /
`login status` / `auth status` against the real bundled binaries).

**For a stable, production install, prefer the standalone CLIs on `PATH`** (`npm install -g
@openai/codex` / follow `https://developers.openai.com/codex/cli` for Codex; `npm install -g
@anthropic-ai/claude-code` for Claude Code) — the VS Code-bundled path is a convenience fallback,
not a stable contract (its layout is versioned by each extension release and could change).

## Why CLI subprocess, not the app-server / MCP-serve protocols

Both products expose more than a plain CLI:

- **Codex** has an `app-server` subcommand: an experimental (its own `--help` says
  `[experimental]`) JSON-RPC-shaped protocol over stdio/websocket, with `generate-ts` /
  `generate-json-schema` commands to (re)generate its own bindings — i.e. explicitly signaled as an
  unstable, evolving contract, primarily built to power OpenAI's own IDE extension. Codex's `mcp`
  subcommand is a **client** (`codex mcp add/list/...` manages _external_ MCP servers Codex can call)
  — Codex does not expose itself as an MCP server in this version.
- **Claude Code** has `claude mcp serve`, which does expose Claude Code itself as an MCP server.

We chose **CLI subprocess invocation in non-interactive mode** (`codex exec --json`, `claude -p
--output-format stream-json`) as the one integration mechanism for both, because:

1. It is the officially documented, stable automation surface for both products — the only one
   explicitly _not_ marked experimental.
2. It gives a **symmetric** integration shape for both providers, which is what makes the
   `ProviderAdapter` abstraction honest rather than papering over two fundamentally different
   protocols.
3. Both CLIs already provide everything the core's capability list asks for in this mode: structured
   JSONL/stream-json events (**streaming**), a final exit code + `-o`/`--output-format json`
   (**structured results**), non-zero exit / stderr (**errors**), process `kill()`
   (**cancellation**), `resume`/`--resume`/`--session-id` (**resume**), and `login status`/`auth
status` (**status**, specifically auth status, without ever touching credentials ourselves).

`app-server`/`mcp serve` are noted here as a **documented future upgrade path** behind the same
`ProviderAdapter` interface — nothing in `orchestrator/`, `workflow/`, or the CLI/extension would need
to change if `CodexProvider`/`ClaudeProvider` were later reimplemented against them; see
[adding-a-provider.md](./adding-a-provider.md).

## Command mapping (what actually gets run)

### Codex (`packages/providers/src/codex.ts`)

```
# fresh invocation
codex exec - --json -s <read-only|workspace-write|danger-full-access> [--approve-for-me]
  -C <worktree> [--add-dir <dir> ...] -o <tmpfile> [--output-schema <tmpfile>] [-m <model>]

# resuming a prior session for this task/role — a deliberately smaller flag set, see below
codex exec resume <sessionId> - --json -o <tmpfile> [--output-schema <tmpfile>] [-m <model>]
```

Prompt (system + instructions + trust-labelled context) is piped over stdin (`-` as the prompt
argument) rather than passed as an argv string, to avoid shell/argv length limits.

**`codex exec resume` has a materially narrower flag surface than a fresh `codex exec`** —
confirmed directly against `codex exec resume --help` on a live install, and the hard way, in the
first real end-to-end run: a retried Codex role (which resumes rather than starts fresh) crashed
outright with `unexpected argument '-s' found`. `resume` does not accept `-s` (sandbox), the
approval flags, `-C` (working directory), or `--add-dir` — `CodexProvider` used to build the same
argument list for both cases. It's now two branches; since `-C` isn't available on resume either
way, the working directory is set via the subprocess's own `cwd` instead (matching what
`ClaudeProvider` already did) — this also closes a latent gap where a resumed session previously had
no reliable way to be pointed at the task's worktree at all. See `packages/providers/src/codex.ts`.

Notes learned by actually running the bundled binary:

- `codex exec` has **no** `-a/--ask-for-approval` flag (that's interactive-mode only); its
  non-interactive analog is `--approve-for-me`, which routes would-be approval prompts through an
  automatic secondary review. `approval: "never"` passes no flag at all — an out-of-sandbox command
  simply fails and is reported back to the model, which is what we want for fully unattended roles.
- `codex exec --json` streams `{"type":"thread.started","thread_id":...}`,
  `{"type":"turn.started"}`, `{"type":"item.completed","item":{"type":"agent_message"|"reasoning"|
"command_execution"|"error", ...}}`, and bare `{"type":"error","message":...}` lines — confirmed
  directly against the installed binary (see the session transcript that produced this repo; an
  unauthenticated run reliably surfaces `401 Unauthorized` reconnect errors on this shape, which is
  how `checkAvailability()` and failure reporting were validated without spending any quota).
  Unrecognized shapes are forwarded as a `raw` event rather than dropped, since this surface is not
  a versioned public schema and may evolve.
- `codex login status` exits `0` with a login summary when authenticated, `1` with `"Not logged
in"` otherwise — this (not a model call) is what `checkAvailability()` uses to report
  `authenticated`.
- `codex exec` refuses to run at all outside a git repository ("Not inside a trusted directory and
  --skip-git-repo-check was not specified") unless `--skip-git-repo-check` is passed, which this
  adapter never does. Not a bug to fix — AI Engine only ever invokes providers inside a real task
  worktree, which is always a git repository — but worth knowing if you ever point a provider at a
  bare directory outside the normal workflow.

### Claude Code (`packages/providers/src/claude.ts`)

```
claude -p --output-format stream-json --verbose --permission-mode auto
  --permission-prompts none [--tools Read,Grep,Glob] [--disallowedTools WebFetch,WebSearch]
  [--add-dir <dir> ...] --append-system-prompt <system> [--session-id <uuid> | --resume <id>]
  [--max-budget-usd <n>] [--model <model>]
```

run with `cwd` set to the task's worktree, and the composed instructions+context piped over stdin.

- Claude Code has no OS-level "sandbox level" flag of its own; a read-only role
  (`architect`/`reviewer`/`security_reviewer`/`verifier`) is enforced by **restricting the tool set**
  (`--tools Read,Grep,Glob` — no `Edit`/`Write`/`Bash`), independent of permission mode.
- **`--permission-mode auto`, not `acceptEdits`** — changed after a real end-to-end fixer run
  proved the previous assumption wrong. `acceptEdits` only auto-accepts Edit/Write prompts; a real
  Bash call (`npm run typecheck 2>&1 | tail -50`) was auto-denied outright ("no approval surface in
  this session"), because Claude Code's own internal command-risk classifier treats "run an
  arbitrary package.json script" as a distinct, higher-risk category `acceptEdits` doesn't cover.
  Real testing against this exact CLI build across all six documented `--permission-mode` values
  found: `dontAsk`/`manual` deny Bash/Write outright in this headless setup; `auto` and
  `bypassPermissions` both let it through. The difference between those two: `auto` keeps Claude
  Code's own internal safety classifier active as an extra, best-effort layer (observed directly —
  it declined an agent-spawning action mid-test with a named reason); `bypassPermissions` skips
  that layer for no additional capability this workflow needs. Neither adds real path confinement
  once Bash is allowed at all (verified: an explicit absolute-path write outside the project
  directory succeeded under both) — that was never going to be permission-mode's job; the real
  boundary is (and always was) the dedicated task worktree plus this engine's own reactive
  command-deny-list monitor (`SecurityPolicy.evaluateEvent`), both of which apply regardless of this
  choice. `auto` is inert for read-only roles either way — their tool list already excludes Bash.
  See the extensive doc comment on `permissionModeForSandbox` in `claude.ts` and
  `claude.test.ts` for the full investigation and regression coverage.
- `--permission-prompts none` is always passed: these are headless subprocess invocations with
  nobody present to answer an interactive permission prompt, so anything that would still prompt
  under `auto` is denied outright rather than hanging forever — a direct instance of "protected
  against infinite loops." This is also why true per-tool-call human approval is out of scope for
  v1 (documented limitation below); approval happens at the workflow-gate level instead.
- `claude auth status` prints JSON (`{"loggedIn": true, ...}`) with exit `0` regardless of login
  state — `checkAvailability()` parses `loggedIn` rather than relying on the exit code.

## What was verified — including, since, a real authenticated end-to-end run

While building this system, only diagnostic, non-billed commands were run against the real bundled
CLIs (`--version`, `--help`, `doctor`, `login status`/`auth status`) — real completions were
deliberately not invoked, since this machine's Claude Code CLI was authenticated and doing so would
have billed the user's subscription without asking, and Codex was not yet authenticated at all.
Adapter event parsing was implemented from Codex's real (credential-free) JSONL output plus Claude
Code's documented `stream-json` shape, defensively: any event shape neither adapter recognizes
becomes a `type: "raw"` event rather than crashing the run or silently vanishing.

**That gap has since been closed.** With the user's explicit go-ahead and both CLIs authenticated,
a real end-to-end task ran through this exact pipeline — Codex as architect/reviewer/
security_reviewer/verifier, Claude Code as implementer/fixer — against a separate real repository
(`execution-kernel-protocol`), driven entirely through `ai <command>`, no mocking. It found and this
project fixed two genuine defects on the very first run (the Codex `--output-schema` strict-mode
incompatibility and the `codex exec resume` flag mismatch, both above), then completed the full
pipeline — plan → approval → implement → verify → review → fix → re-review → security_review gate →
final verify → `READY` — with a real, reviewer-caught, fixer-corrected bug along the way. The
mocked-provider tests (`orchestrator.test.ts`, `orchestrator.hardening.test.ts`) still cover the
wiring every invocation flows through; this real run is what actually exercised the two adapters'
subprocess/JSON-parsing layer end-to-end. If Claude Code or Codex change their `stream-json`/`--json`
event shapes in a future release, re-running a real task like this is the fastest way to notice.

## Sandbox level → provider flag mapping

| `SandboxLevel`    | Codex `-s`           | Claude tool policy                                        |
| ----------------- | -------------------- | --------------------------------------------------------- |
| `read_only`       | `read-only`          | `--tools Read,Grep,Glob` (tool list is the real boundary) |
| `workspace_write` | `workspace-write`    | default tools, `--permission-mode auto`                   |
| `full_access`     | `danger-full-access` | _(not used by any built-in role default)_                 |

Role defaults live in `packages/security/src/role-defaults.ts` — every read-oriented role
(`architect`, `reviewer`, `security_reviewer`, `verifier`) is `read_only`; only `implementer` gets
`workspace_write`, always scoped to the task's dedicated worktree (see
[architecture.md](./architecture.md#git-worktree-behavior)).
