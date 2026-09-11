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
codex exec [resume <sessionId>] - --json -s <read-only|workspace-write|danger-full-access>
  [--approve-for-me] -C <worktree> [--add-dir <dir> ...] -o <tmpfile> [--output-schema <tmpfile>]
  [-m <model>]
```

Prompt (system + instructions + trust-labelled context) is piped over stdin (`-` as the prompt
argument) rather than passed as an argv string, to avoid shell/argv length limits. Notes learned by
actually running the bundled binary (safe, credential-free calls only — see below):

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

### Claude Code (`packages/providers/src/claude.ts`)

```
claude -p --output-format stream-json --verbose --permission-mode acceptEdits
  --permission-prompts none [--tools Read,Grep,Glob] [--disallowedTools WebFetch,WebSearch]
  [--add-dir <dir> ...] --append-system-prompt <system> [--session-id <uuid> | --resume <id>]
  [--max-budget-usd <n>] [--model <model>]
```

run with `cwd` set to the task's worktree, and the composed instructions+context piped over stdin.

- Claude Code has no OS-level "sandbox level" flag of its own; a read-only role
  (`architect`/`reviewer`/`security_reviewer`/`verifier`) is enforced by **restricting the tool set**
  (`--tools Read,Grep,Glob` — no `Edit`/`Write`/`Bash`). `--permission-mode` is set to `acceptEdits`
  **uniformly**, for every role, rather than using the interactive-oriented `plan` mode for read-only
  roles as an earlier version did: `plan` mode's behavior under headless `-p --output-format
stream-json` (no human present to confirm a plan) was never exercised against a live invocation, and
  the hardening pass deliberately removed that dependency — `acceptEdits` is inert for a role whose
  tool list already excludes Edit/Write/Bash, so read-only enforcement rests entirely on the mechanical
  tool-list restriction, not on unverified permission-mode semantics.
- `--permission-prompts none` is always passed: these are headless subprocess invocations with
  nobody present to answer an interactive permission prompt, so anything that would prompt is denied
  outright rather than hanging forever — a direct instance of "protected against infinite loops."
  This is also why true per-tool-call human approval is out of scope for v1 (documented limitation
  below); approval happens at the workflow-gate level instead.
- `claude auth status` prints JSON (`{"loggedIn": true, ...}`) with exit `0` regardless of login
  state — `checkAvailability()` parses `loggedIn` rather than relying on the exit code. Verified
  directly against the installed binary; this machine's Claude Code CLI is authenticated (Pro
  subscription), which is exactly why **no real `claude -p` completion was ever invoked** while
  building this system — see below.

## What was verified without spending API quota

Per the instruction to treat agent execution as privileged and to avoid unnecessary provider calls:
only diagnostic, non-billed commands were ever run against the real bundled CLIs while building this
system — `--version`, `--help`, `doctor`, `login status` (Codex; confirmed _not_ authenticated on
this machine, so its one `codex exec` probe below made no model call either), and `auth status`
(Claude Code; confirmed authenticated, so **no** `claude -p`/`claude exec`-equivalent call was ever
made here — doing so would have billed the user's Pro subscription without asking). Adapter event
parsing was implemented from Codex's real (credential-free) JSONL output plus Claude Code's
documented `stream-json` shape, and is defensive by construction: any event shape neither adapter
recognizes becomes a `type: "raw"` event rather than crashing the run or silently vanishing.

**Actually exercising a real `claude -p` or authenticated `codex exec` completion end-to-end is the
one integration path this project could not verify live**, precisely because doing so would consume
the user's paid quota without explicit permission. Real end-to-end runs are covered by:
`packages/orchestrator/src/orchestrator.test.ts`, which drives the entire pipeline through a
deterministic in-memory `MockProvider` implementing the exact same `ProviderAdapter` interface — so
the wiring the real adapters plug into is fully tested, only the two adapters' subprocess/JSON
parsing layer is unverified against a live authenticated call. If Claude Code or Codex change their
`stream-json`/`--json` event shapes in a future release, this is the first place to check.

## Sandbox level → provider flag mapping

| `SandboxLevel`    | Codex `-s`           | Claude tool policy                                        |
| ----------------- | -------------------- | --------------------------------------------------------- |
| `read_only`       | `read-only`          | `--tools Read,Grep,Glob` (tool list is the real boundary) |
| `workspace_write` | `workspace-write`    | default tools, `--permission-mode acceptEdits`            |
| `full_access`     | `danger-full-access` | _(not used by any built-in role default)_                 |

Role defaults live in `packages/security/src/role-defaults.ts` — every read-oriented role
(`architect`, `reviewer`, `security_reviewer`, `verifier`) is `read_only`; only `implementer` gets
`workspace_write`, always scoped to the task's dedicated worktree (see
[architecture.md](./architecture.md#git-worktree-behavior)).
