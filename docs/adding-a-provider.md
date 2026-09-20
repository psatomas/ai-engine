# Adding a new provider (e.g. Gemini, a local model)

Nothing in `core/`, `workflow/`, `security/`, `verification/`, the CLI, or the VS Code extension
knows that Codex or Claude exist. Adding a provider touches exactly two places.

## 1. Implement `ProviderAdapter`

Create `packages/providers/src/<yourprovider>.ts` implementing the interface from
`packages/core/src/provider.ts`:

```ts
export interface ProviderAdapter {
  readonly id: ProviderId; // opaque string, e.g. "gemini"
  readonly displayName: string;
  capabilities(): Capability[]; // which of analyze/plan/implement/review/shell_execution/
  // file_modification/streaming/cancellation/status/resume/
  // structured_output this product actually supports — don't
  // claim one it doesn't have.
  checkAvailability(): Promise<ProviderAvailability>; // binary resolution + a credential-free
  // auth-status probe; never touch the
  // credential itself.
  invoke(request: AgentInvocationRequest): AgentRun; // spawn, stream AgentEvents, resolve AgentResult
  getCapacity?(): Promise<ProviderCapacityInfo>; // OPTIONAL — see "Usage & capacity" below.
}
```

### Usage & capacity

Two separate concerns — see [providers.md](./providers.md#usage--capacity) for the full behavior.

**Usage (every adapter).** Report what an invocation consumed on `AgentResult.usage` as an
`ObservedUsage`: set a dimension only when the provider actually reported it, validate it (finite and
non-negative; integers for token counts), and leave anything missing or malformed `undefined` — never
`0`. The orchestrator records one `UsageEvent` per invocation from it. If your provider reports a
_cumulative_ running total for a resumed session rather than a per-invocation figure (Codex does), return
the invocation's own delta as `usage` — computed from `AgentInvocationRequest.previousCumulativeUsage`,
and `undefined` when there is no reliable baseline — and the raw total as `cumulativeUsageBaseline`. The
orchestrator persists that baseline with the session and re-supplies it only to the same provider's same
session, so the adapter never has to.

**Capacity (optional).** `getCapacity()` is how a provider reports account-level capacity/quota (e.g.
"62% of this billing period's usage remaining"), separately from per-invocation usage. It's optional, and
you should only implement it if the product has a real, credential-free surface that reliably reports
quota — **never derive or guess it from observed token counts, and never invent a subscription tier**.
Neither `ClaudeProvider` nor `CodexProvider` implements it today; `Orchestrator.listProviders()` reports
`{ status: "unknown" }` for both of them, honestly, rather than fabricating a number. If your provider's
status surface does report a plan/tier label directly (e.g. an auth-status JSON field named something like
`"plan"`), that's the _only_ legitimate source for `ProviderCapacityInfo.account.planLabel` — a
subscription tier is account/capacity metadata, never a separate provider id.

Use `packages/providers/src/codex.ts` or `claude.ts` as a template — both follow the same shape:
resolve a binary (`resolve.ts`'s `resolveProviderBinary` is reusable for any CLI-shaped product),
compose the prompt from `systemPrompt` + `instructions` + trust-labelled `context` (via
`composeUserPrompt` from `prompt.ts`), spawn with `execa`, translate whatever structured/streaming
output the product emits into `AgentEvent`s (falling back to a `{ type: "raw", data }` event for
anything unrecognized rather than crashing), and resolve an `AgentResult` from the exit code +
captured output.

If the product has no CLI at all (e.g. a local model served over HTTP), `invoke()` can just as well
drive a fetch/streaming-HTTP client instead of a subprocess — nothing about `ProviderAdapter` assumes
a subprocess; that's an implementation detail of the two adapters that happen to exist today. This is
also where the Codex `app-server` / Claude `mcp serve` upgrade path from
[providers.md](./providers.md#why-cli-subprocess-not-the-app-server--mcp-serve-protocols) would land,
without changing this interface.

Do not invent capabilities the product doesn't have. If it can't stream, don't return `"streaming"`
from `capabilities()` — the orchestrator degrades to consuming `run.result` directly when it needs
to; there is no requirement that every capability be present.

## 2. Register it

In `packages/orchestrator/src/role-registry.ts`, add one line to `defaultProviderFactories()`:

```ts
["gemini", (cfg) => new GeminiProvider({ configuredBinaryPath: cfg.binaryPath, defaultModel: cfg.model, extraArgs: cfg.extraArgs })];
```

That's the entire integration. A user can now write, in their global config:

```yaml
roles:
  security_reviewer:
    providerId: gemini
```

and the workflow engine, the CLI, and the VS Code extension all pick it up with no further changes —
`RoleRegistry.adapterForRole()` is the only place a role name is resolved to a live adapter instance,
and it goes through the same factory map regardless of which role or which provider.

This one line is also everything needed for `gemini` to show up in **generic** enumeration:
`RoleRegistry.describeProviders()` and `Orchestrator.listProviders()` (used by `ai providers`) iterate
`defaultProviderFactories()`'s keys — neither hardcodes "claude"/"codex", so a newly registered `gemini`
appears in both with no further code change. Session/provider binding (`TaskRecord.providerSessions`, see
docs/providers.md) is also handled entirely by the orchestrator layer: `GeminiProvider` doesn't need to do
anything special for a resume session it creates (or a cumulative-usage baseline it returns) to never be
handed to a different provider by mistake.

**Concretely, adding Gemini touches exactly:**

1. A new file, `packages/providers/src/gemini.ts` (the adapter itself).
2. One line in `packages/orchestrator/src/role-registry.ts`'s `defaultProviderFactories()`.

Nothing in `core/`, `workflow/`, `orchestrator/orchestrator.ts`, `config/`, the CLI, or the VS Code
extension changes. If Gemini's status surface ever reports real quota, `GeminiProvider` can also
implement the optional `getCapacity()` — still no changes anywhere else, since `listProviders()`
already calls it generically when present.

## 3. Test it the same way the existing adapters are tested

- Unit-test binary resolution and event/result parsing directly (see
  `packages/providers/src/resolve.test.ts`) — pure functions/fixtures, no network or credentials.
- Unit-test usage extraction the way `packages/providers/src/claude.test.ts` and `codex.test.ts` do: a valid
  payload, an absent one, and malformed dimensions (numeric string, negative, `NaN`, fractional token
  count) that must be omitted individually rather than coerced to `0`.
- Add a `checkAvailability()`-only smoke test to
  `packages/providers/src/adapters.integration.test.ts`, guarded to skip (not fail) when the binary
  isn't present on the machine running the tests, exactly like the existing Codex/Claude entries —
  this is what "integration tests for real provider adapters without requiring credentials in CI"
  means in practice: exercise the real binary's diagnostic surface, never a billed completion.
- The orchestrator's own pipeline logic (approval gates, loop guarding, review/fix wiring) is already
  fully covered against a `MockProvider` (`packages/orchestrator/src/test-support/mock-provider.ts`)
  and doesn't need to be re-tested per provider — that's the point of the abstraction.
