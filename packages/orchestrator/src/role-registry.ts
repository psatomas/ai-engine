import type { Capability, ProviderAdapter } from "@ai-engine/core";
import type { GlobalConfig, ProjectConfig, ProviderConfig } from "@ai-engine/config";
import { resolveRoleAssignment } from "@ai-engine/config";
import { CodexProvider, ClaudeProvider } from "@ai-engine/providers";

/** A provider's identity and static capabilities, independent of any role. */
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  capabilities: Capability[];
}

export type ProviderFactory = (config: ProviderConfig) => ProviderAdapter;

/**
 * The only place in the whole system that maps a provider *id string* to a
 * concrete adapter class. Adding Gemini or a local model later means
 * registering one factory here (see docs/adding-a-provider.md) — nothing in
 * workflow/, security/, verification/, the CLI or the VS Code extension
 * needs to change.
 */
export function defaultProviderFactories(): Map<string, ProviderFactory> {
  return new Map<string, ProviderFactory>([
    ["codex", (cfg) => new CodexProvider({ configuredBinaryPath: cfg.binaryPath, defaultModel: cfg.model, extraArgs: cfg.extraArgs })],
    ["claude", (cfg) => new ClaudeProvider({ configuredBinaryPath: cfg.binaryPath, defaultModel: cfg.model, extraArgs: cfg.extraArgs })]
  ]);
}

export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`No provider factory registered for "${providerId}". Known providers: see docs/adding-a-provider.md`);
    this.name = "UnknownProviderError";
  }
}

export class UnassignedRoleError extends Error {
  constructor(role: string) {
    super(`No provider is assigned to role "${role}" in global or project config`);
    this.name = "UnassignedRoleError";
  }
}

export class RoleRegistry {
  constructor(
    private readonly global: GlobalConfig,
    private readonly project: ProjectConfig | undefined,
    private readonly factories: Map<string, ProviderFactory> = defaultProviderFactories()
  ) {}

  resolveProviderId(role: string): string {
    const assignment = resolveRoleAssignment(role, this.global, this.project);
    if (!assignment) throw new UnassignedRoleError(role);
    return assignment.providerId;
  }

  private configFor(providerId: string, modelOverride?: string): ProviderConfig {
    const providerConfig = this.global.providers[providerId] ?? { extraArgs: [] };
    return { ...providerConfig, model: modelOverride ?? providerConfig.model };
  }

  adapterForRole(role: string): ProviderAdapter {
    const assignment = resolveRoleAssignment(role, this.global, this.project);
    if (!assignment) throw new UnassignedRoleError(role);
    return this.adapterForId(assignment.providerId, assignment.model);
  }

  /** Instantiates a registered provider directly by id, independent of any role assignment. */
  adapterForId(providerId: string, modelOverride?: string): ProviderAdapter {
    const factory = this.factories.get(providerId);
    if (!factory) throw new UnknownProviderError(providerId);
    return factory(this.configFor(providerId, modelOverride));
  }

  /**
   * Every registered provider's identity/capabilities, independent of which
   * (if any) role currently uses it — the generic seed for enumerating
   * providers without the caller needing to already know provider ids like
   * "claude"/"codex".
   */
  describeProviders(): ProviderDescriptor[] {
    return Array.from(this.factories.keys()).map((id) => {
      const adapter = this.adapterForId(id);
      return { id: adapter.id, displayName: adapter.displayName, capabilities: adapter.capabilities() };
    });
  }
}
