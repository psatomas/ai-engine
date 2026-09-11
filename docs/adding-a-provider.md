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
}
```

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

## 3. Test it the same way the existing adapters are tested

- Unit-test binary resolution and event/result parsing directly (see
  `packages/providers/src/resolve.test.ts`) — pure functions/fixtures, no network or credentials.
- Add a `checkAvailability()`-only smoke test to
  `packages/providers/src/adapters.integration.test.ts`, guarded to skip (not fail) when the binary
  isn't present on the machine running the tests, exactly like the existing Codex/Claude entries —
  this is what "integration tests for real provider adapters without requiring credentials in CI"
  means in practice: exercise the real binary's diagnostic surface, never a billed completion.
- The orchestrator's own pipeline logic (approval gates, loop guarding, review/fix wiring) is already
  fully covered against a `MockProvider` (`packages/orchestrator/src/test-support/mock-provider.ts`)
  and doesn't need to be re-tested per provider — that's the point of the abstraction.
