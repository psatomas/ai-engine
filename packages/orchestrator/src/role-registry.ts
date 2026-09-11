import type { ProviderAdapter } from "@ai-engine/core";
import type { GlobalConfig, ProjectConfig, ProviderConfig } from "@ai-engine/config";
import { resolveRoleAssignment } from "@ai-engine/config";
import { CodexProvider, ClaudeProvider } from "@ai-engine/providers";

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

  adapterForRole(role: string): ProviderAdapter {
    const assignment = resolveRoleAssignment(role, this.global, this.project);
    if (!assignment) throw new UnassignedRoleError(role);
    const factory = this.factories.get(assignment.providerId);
    if (!factory) throw new UnknownProviderError(assignment.providerId);
    const providerConfig = this.global.providers[assignment.providerId] ?? { extraArgs: [] };
    return factory({ ...providerConfig, model: assignment.model ?? providerConfig.model });
  }
}
