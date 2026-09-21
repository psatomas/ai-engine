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

**A second real end-to-end run has since happened**, against a different, disposable external
repository, re-exercising the same pipeline after the three fixes above. It confirmed all three
hold under a fresh task: dependency bootstrap ran `npm ci` correctly in a genuinely fresh worktree;
the implementer and fixer both executed real Bash (build/test/lint, and installing new
devDependencies) under the `"auto"` permission mode; and a real review round produced two genuine
findings that `fix()` marked `fix_attempted` (never `fixed`), which a subsequent independent review
round then confirmed resolved on its own — not by trusting the earlier mark. No new AI Engine
defects were found on this run.

## Session/provider binding

`TaskRecord.providerSessions` (`packages/core/src/task.ts`) stores, per role, a
`ProviderSessionRef { providerId, sessionId, cumulativeUsageBaseline? }` — never a bare session id.
`Orchestrator.buildRequest` only forwards `resumeSessionId` (and the usage baseline — see
[Observed usage](#observed-usage) below) when the role's _currently resolved_ provider id matches the one
recorded on the session. This matters because a role's provider assignment can change between two
invocations of the same task (an edited global/project config, an override introduced mid-task): without
the binding, the newly-assigned provider would be handed a native resume/session id created by a
completely different product, which is meaningless (and potentially unsafe) input to that product's own
`--resume`/`--session-id` flag. See `packages/orchestrator/src/orchestrator.hardening.test.ts`'s "H5"
block for a reproduction across two providers sharing a task, and "H6" for the same isolation applied to
the usage baseline.

Persisted sessions are validated when a task is loaded (`TaskStore.get()`). A record written before this
binding existed had a bare string there; that entry is dropped rather than guessed at, because there is no
way to know which provider created it. So is any entry whose `providerId` or `sessionId` is not a non-empty
string (values are never coerced into shape), and a record whose `providerSessions` is missing or not an
object is given an empty one. In every case the next invocation of that role simply starts a fresh
session instead of resuming, which is always the safe direction.

## Usage & capacity

Two genuinely different things are both called "usage" and are kept separate on purpose: what an
invocation _reported consuming_ (observed usage), and how much of an account's allowance _remains_
(capacity).

### Observed usage

- **Shape.** `AgentResult.usage` is an `ObservedUsage` (`packages/core/src/usage.ts`), every dimension
  optional: `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`,
  `reasoningOutputTokens`, `costUsd`. A dimension a provider doesn't report is `undefined` — never `0` — so
  "unknown" and "genuinely zero" are never conflated; a reported `0` is a real, known value.
- **Validation.** Provider JSON is untrusted. Token counts must be finite, non-negative integers and cost
  finite and non-negative; a malformed dimension is omitted on its own (never coerced to `0`), and a result
  with no valid dimension reports `usage` as `undefined`.
- **Per-invocation record.** Every provider invocation — including one whose usage is unknown — appends one
  `UsageEvent { at, providerId, role, operation, usage }` to the append-only `TaskRecord.usageEvents`.
  `operation` is `analyze`, `implement`, `review`, `fix` or `verify`, which is what distinguishes `fix()`
  from `implement()` on the same `implementer` role. An invocation with unknown usage is recorded with
  `usage: {}`, so invocation counts are complete. Totals by provider, role or task are always derived from
  these events (`summarizeUsageEvents`, `groupUsageEvents`), never stored separately. A task record written
  before the log existed loads with an empty one; no history is invented. `TaskRecord.usage` (`TaskUsage` —
  cost/input/output totals) is a separate, older tally, is what budget enforcement reads, and is unchanged.
- **Claude** reports usage on the stream's `result` message: input, output, cache-read and cache-write
  tokens, and `total_cost_usd`. These are per-invocation values. Claude does not report reasoning tokens
  separately, so that dimension is never set.
- **Codex** reports usage only on `turn.completed`, as a _cumulative_ per-thread snapshot rather than a
  per-invocation delta (confirmed live with a chained fresh → resume run: cached input tokens exactly
  doubled). The last snapshot is authoritative and snapshots are never summed; the compatibility
  `token_count` events are ignored, so repeated rate-limit notifications can't double-count. On a fresh
  invocation the snapshot _is_ the invocation's usage; on a resumed one it is the difference from the
  previous snapshot (`AgentInvocationRequest.previousCumulativeUsage`), and is left unknown when there is
  no reliable baseline. The raw snapshot is returned as `AgentResult.cumulativeUsageBaseline`; the
  orchestrator stores it on that role's `ProviderSessionRef` and passes it back only to the same provider's
  same session. If a call returns a session but no usage snapshot, the stored baseline is cleared rather
  than left stale, so the next resume reports unknown usage instead of an inflated number. Codex reports no
  cost.
- `ai usage <taskId>` presents this — see [cli.md](./cli.md).

### Provider capacity

`ProviderAdapter.getCapacity?(): Promise<ProviderCapacityInfo>` (`packages/core/src/provider.ts`)
is optional. A known report has `{ status: "known", windows: CapacityWindow[], account?, detail? }`;
an unknown report has `{ status: "unknown", account?, detail? }` and no windows.
`UNKNOWN_PROVIDER_CAPACITY` is a first-class, expected result, including for adapters without
`getCapacity()`. The generic contract permits a known report with zero windows; the shipped readers
require at least one surviving reliable window to return known capacity.

Each quota window is independent:

```ts
interface CapacityWindow {
  id: string;
  label?: string;
  durationSeconds?: number;
  usedFraction?: number;
  observedAt?: string;
  resetsAt?: string;
}
```

`id` is opaque and unique within the report; consumers do not infer duration or policy from it.
`usedFraction` is utilization as observed: absent means unknown, `0` means unused, `1` means fully
used, and finite non-negative values above `1` preserve overage. `remainingCapacityFraction` derives
`max(0, 1 - usedFraction)` for valid utilization and returns `undefined` for missing or invalid values.
There is no provider-wide utilization, remaining fraction, or reset timestamp, and windows are not
aggregated. `observedAt` and `resetsAt` are optional ISO timestamps with different meanings: when the
evidence was observed and when a reset was reported. A passed reset never rewrites utilization or
implies replenishment. Capacity is never inferred from invocation token counts. `account.planLabel`
may only reflect a provider-stated label; a subscription tier is metadata, not a provider id.

#### Observation facts and explicit freshness

`describeCapacityWindow(window, nowMs)` (`packages/core/src/capacity.ts`) interprets reported facts
at an explicit Unix-millisecond clock, without reading a clock itself:

- `utilization`: `valid`, `unknown`, or `invalid`, with a derived `remainingFraction` when valid.
- `observation`: `reported`, `absent`, or `invalid`, with signed `observationAgeMs = nowMs - observedAtMs`
  for a valid timestamp. A future observation stays `reported` with a negative age at this layer.
- `reset`: `future`, `passed`, `unknown`, or `invalid`, with signed `msUntilReset = resetsAtMs - nowMs`
  for a valid timestamp. Equality is `passed`, with zero time until reset.

This helper decides neither freshness nor usability, availability, routing, scheduling,
replenishment, or execution permission.

`evaluateCapacityWindow(window, nowMs, { maxAgeMs })` adds a caller-supplied freshness policy.
There is no implicit clock, default TTL, or provider-specific freshness limit. `maxAgeMs` must be
finite and positive. For a valid, non-future observation:

```text
age < maxAgeMs  => fresh
age >= maxAgeMs => stale
```

Missing observation time yields `freshness: "unknown"`; malformed or future observation time yields
`"invalid"`. Neither `durationSeconds` nor `resetsAt` determines freshness. `usable` requires valid
utilization, fresh evidence, and no passed or invalid reset. An unknown reset does not itself prevent
usability, and zero remaining capacity can still be usable evidence. This is an evidence-quality
verdict, not permission to execute or a routing verdict. Historical utilization and remaining
fraction are still reported even when evidence is unusable.

#### Passive Claude acquisition

`ClaudeProvider.getCapacity()` delegates to `readClaudeCapacity` in
`packages/providers/src/claude-capacity.ts`. It reads the bounded local `~/.claude.json` source,
projecting `cachedUsageUtilization.fetchedAtMs` and `cachedUsageUtilization.utilization`.
Claude's own `fetchedAtMs` supplies observation provenance, converted to `observedAt`; filesystem
mtime and AI Engine's read time do not. A missing or malformed cache timestamp makes capacity unknown.

Supported entries under `utilization` are `five_hour`, `seven_day`, `seven_day_opus`,
`seven_day_sonnet`, and `seven_day_oauth_apps`. Each entry's `utilization` percentage becomes
`usedFraction`; its optional `resets_at` becomes `resetsAt`. Missing, null, or malformed individual
windows are omitted independently, preserving valid siblings. Known capacity requires at least one
surviving reliable window. The reader supplies no plan label and establishes no current-account
binding: cached evidence may belong to a previously authenticated account.

Acquisition does not invoke Claude, make a network request, refresh the cache, or evaluate freshness.
It reports historical evidence for the caller to interpret.

#### Passive Codex acquisition

`CodexProvider.getCapacity()` delegates to `readCodexCapacity` in
`packages/providers/src/codex-capacity.ts`. It scans bounded local rollout JSONL evidence under
`~/.codex/sessions`: traversal, candidate files, file reads, tail bytes, and processed records all
have finite limits. It extracts only capacity fields from `event_msg` / `token_count` records'
`rate_limits`. Capacity output does not include transcript messages, prompts, or session contents.
No Codex process, network request, model call, or app-server connection is used for acquisition.

Each `limit_id` bucket is resolved independently. Candidate file names are traversed in descending
order; within a file's processed tail the last valid bucket snapshot wins, and a bucket resolved
from an earlier-processed file is not overridden by a later file. Its `primary` and `secondary`
windows always come from the same selected record, with IDs `<limit_id>:primary` and
`<limit_id>:secondary`. Missing or malformed siblings are not backfilled from other records.
There is no cross-record backfill or cross-bucket merging; different buckets can come from different
records. `used_percent` becomes `usedFraction`, `window_minutes` supplies optional duration, and
`resets_at` in Unix seconds becomes an optional ISO reset timestamp. A validated provider-stated
`plan_type` is surfaced as `account.planLabel` only when the collected valid plan labels do not
conflict; no tier is inferred. With no reliable windows, capacity is unknown.

**Codex capacity windows deliberately have no `observedAt`.** Investigation did not establish that
the rollout event timestamp, reset timestamp, or another locally available field provides defensible
observation-time provenance. File ordering, mtime, and read time are not substitutes. These windows
can expose utilization and reset facts, but the evaluator reports `freshness: "unknown"` and
`usable: false`; supplying `--max-age` cannot make them usable evidence. Passive rollout evidence is
not verified as belonging to the currently authenticated account.

#### Enumeration and presentation

- **Enumeration.** `RoleRegistry.describeProviders()` and `Orchestrator.listProviders()` iterate the factory
  map `adapterForRole()` uses, never a hardcoded id list, and return one
  `ProviderSummary { id, displayName, capabilities, roles, availability, capacity }` per registered
  provider. `roles` lists the configured roles (global and project) whose _effective_ assignment — a project
  override wins — resolves to that provider; a role assigned to a provider id that isn't registered appears
  under no provider.
- **Failures.** If a provider's `checkAvailability()` rejects, it is listed as unavailable; if its
  `getCapacity()` rejects, its capacity is listed as unknown — each with the error message as `detail` —
  and the other providers are still listed. Only asynchronous (rejected-promise) failures are contained: a
  synchronous throw from either method, or a provider factory that throws, rejects the whole call.
- `ai providers` shows policy-independent window facts; `ai providers --max-age <duration>` also
  evaluates freshness and usable evidence. See [cli.md](./cli.md#provider-capacity-display) for syntax
  and limitations. Provider-derived display strings are sanitized and bounded before terminal
  rendering; this is a presentation safeguard, not a broader security guarantee.
- This is passive reporting only. It adds no capacity-based selection, adaptive routing, load
  balancing, quota-based fallback, rate-limit-aware scheduling, execution blocking, automatic
  replenishment, background monitoring, or VS Code capacity UI.

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
