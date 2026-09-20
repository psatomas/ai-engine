import { describe, expect, it } from "vitest";
import { GlobalConfigSchema, type GlobalConfig } from "@ai-engine/config";
import { RoleRegistry, UnassignedRoleError, UnknownProviderError, type ProviderFactory } from "./role-registry.js";
import { MockProvider } from "./test-support/mock-provider.js";

/**
 * "acme" and "zenith" are deliberately not "claude"/"codex" — proving
 * RoleRegistry's enumeration/resolution primitives work for arbitrary
 * provider ids, not just the two shipped today.
 */
function fakeFactories(): Map<string, ProviderFactory> {
  return new Map<string, ProviderFactory>([
    ["acme", () => new MockProvider("acme", () => ({ status: "success" }))],
    ["zenith", () => new MockProvider("zenith", () => ({ status: "success" }))]
  ]);
}

describe("RoleRegistry generic provider enumeration", () => {
  it("describeProviders() lists every registered provider by identity/capabilities, independent of role assignment", () => {
    const global = GlobalConfigSchema.parse({ roles: {} });
    const registry = new RoleRegistry(global, undefined, fakeFactories());
    const descriptors = registry.describeProviders();
    expect(descriptors.map((d) => d.id).sort()).toEqual(["acme", "zenith"]);
    for (const d of descriptors) {
      expect(d.displayName).toBeTruthy();
      expect(d.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("adapterForId() instantiates a provider directly by id, with no role involved", () => {
    const global = GlobalConfigSchema.parse({ roles: {} });
    const registry = new RoleRegistry(global, undefined, fakeFactories());
    expect(registry.adapterForId("zenith").id).toBe("zenith");
  });

  it("adapterForId() throws UnknownProviderError for an unregistered id", () => {
    const global = GlobalConfigSchema.parse({ roles: {} });
    const registry = new RoleRegistry(global, undefined, fakeFactories());
    expect(() => registry.adapterForId("nonexistent")).toThrow(UnknownProviderError);
  });

  it("adapterForRole() resolves an arbitrary provider id through role config exactly like the built-in ones", () => {
    const global = GlobalConfigSchema.parse({ roles: { implementer: { providerId: "acme" } } });
    const registry = new RoleRegistry(global, undefined, fakeFactories());
    expect(registry.adapterForRole("implementer").id).toBe("acme");
    expect(registry.resolveProviderId("implementer")).toBe("acme");
  });

  it("a project-level role override still resolves to the correct arbitrary provider (existing override behavior preserved)", () => {
    const global = GlobalConfigSchema.parse({ roles: { implementer: { providerId: "acme" } } });
    const project = { name: "x", roles: { implementer: { providerId: "zenith" } }, verification: {}, review: {}, writeTaskSummaries: true };
    const registry = new RoleRegistry(global, project as never, fakeFactories());
    expect(registry.resolveProviderId("implementer")).toBe("zenith");
  });

  it("throws UnassignedRoleError for a role with no assignment in either config", () => {
    const global: GlobalConfig = GlobalConfigSchema.parse({ roles: {} });
    const registry = new RoleRegistry(global, undefined, fakeFactories());
    expect(() => registry.adapterForRole("implementer")).toThrow(UnassignedRoleError);
  });

  it("throws UnknownProviderError when a role is assigned to a provider id with no registered factory", () => {
    const global = GlobalConfigSchema.parse({ roles: { implementer: { providerId: "not-registered" } } });
    const registry = new RoleRegistry(global, undefined, fakeFactories());
    expect(() => registry.adapterForRole("implementer")).toThrow(UnknownProviderError);
  });
});
