import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalConfigSchema, ProjectConfigSchema, type GlobalConfig, type ProjectConfig } from "@ai-engine/config";
import { buildDefaultWorkflow, WorkflowEngine } from "@ai-engine/workflow";
import { SecurityPolicy, CommandApprovalStore } from "@ai-engine/security";
import { GitRepository } from "@ai-engine/git";
import { createLogger } from "@ai-engine/logging";
import type { ProviderCapacityInfo } from "@ai-engine/core";
import { TaskStore } from "./task-store.js";
import { RoleRegistry, type ProviderFactory } from "./role-registry.js";
import { Orchestrator } from "./orchestrator.js";
import { MockProvider } from "./test-support/mock-provider.js";

let repoDir: string;
let dataDir: string;

async function buildOrchestrator(
  factories: Map<string, ProviderFactory>,
  configOverrides: Partial<GlobalConfig> = {},
  projectConfig?: ProjectConfig
): Promise<Orchestrator> {
  const gitRepo = await GitRepository.discover(repoDir);
  const paths = {
    configDir: dataDir,
    dataDir,
    configFile: join(dataDir, "config.yaml"),
    taskStoreDir: join(dataDir, "tasks"),
    worktreesDir: join(dataDir, "worktrees"),
    logsDir: join(dataDir, "logs"),
    cacheDir: join(dataDir, "cache")
  };
  const globalConfig = GlobalConfigSchema.parse({
    roles: {
      architect: { providerId: "acme" },
      implementer: { providerId: "zenith" },
      reviewer: { providerId: "acme" },
      security_reviewer: { providerId: "acme" },
      verifier: { providerId: "acme" }
    },
    ...configOverrides
  });
  const roleRegistry = new RoleRegistry(globalConfig, projectConfig, factories);
  const securityPolicy = new SecurityPolicy(globalConfig.security);
  const commandApprovalStore = new CommandApprovalStore(join(dataDir, "approvals.json"));
  const logger = createLogger([]);
  const workflow = new WorkflowEngine(buildDefaultWorkflow(), globalConfig.workflow);
  const taskStore = new TaskStore(paths.taskStoreDir);

  return new Orchestrator({
    gitRepo,
    paths,
    globalConfig,
    projectConfig,
    taskStore,
    roleRegistry,
    securityPolicy,
    commandApprovalStore,
    logger,
    workflow
  });
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-listproviders-repo-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-listproviders-data-"));
  const git = simpleGit(repoDir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  await git.add(".");
  await git.commit("initial commit");
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("Orchestrator.listProviders()", () => {
  it("enumerates arbitrary registered providers generically, with roles grouped by resolved assignment", async () => {
    const factories = new Map<string, ProviderFactory>([
      ["acme", () => new MockProvider("acme", () => ({ status: "success" }))],
      ["zenith", () => new MockProvider("zenith", () => ({ status: "success" }))]
    ]);
    const orchestrator = await buildOrchestrator(factories);
    const summaries = await orchestrator.listProviders();

    const byId = new Map(summaries.map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual(["acme", "zenith"]);
    expect(byId.get("acme")!.roles.sort()).toEqual(["architect", "reviewer", "security_reviewer", "verifier"]);
    expect(byId.get("zenith")!.roles).toEqual(["implementer"]);
    expect(byId.get("acme")!.availability.available).toBe(true);
  });

  it("attributes a role that exists only in project configuration to its effective provider (global roles ∪ project roles)", async () => {
    const factories = new Map<string, ProviderFactory>([
      ["acme", () => new MockProvider("acme", () => ({ status: "success" }))],
      ["zenith", () => new MockProvider("zenith", () => ({ status: "success" }))]
    ]);
    // "docs_writer" is assigned nowhere in the global config — only the project knows about it.
    const projectConfig = ProjectConfigSchema.parse({ name: "demo", roles: { docs_writer: { providerId: "zenith" } } });
    const orchestrator = await buildOrchestrator(factories, {}, projectConfig);
    const byId = new Map((await orchestrator.listProviders()).map((s) => [s.id, s]));
    expect(byId.get("zenith")!.roles.sort()).toEqual(["docs_writer", "implementer"]);
    expect(byId.get("acme")!.roles.sort()).toEqual(["architect", "reviewer", "security_reviewer", "verifier"]);
  });

  it("defaults capacity to unknown when an adapter has no getCapacity(), and never invents a number", async () => {
    const factories = new Map<string, ProviderFactory>([
      ["acme", () => new MockProvider("acme", () => ({ status: "success" }))],
      ["zenith", () => new MockProvider("zenith", () => ({ status: "success" }))]
    ]);
    const orchestrator = await buildOrchestrator(factories);
    const summaries = await orchestrator.listProviders();
    for (const s of summaries) expect(s.capacity).toEqual({ status: "unknown" });
  });

  it("reflects a real getCapacity() result when a provider implements it", async () => {
    class CapacityReportingProvider extends MockProvider {
      async getCapacity(): Promise<ProviderCapacityInfo> {
        return { status: "known", windows: [{ id: "a", usedFraction: 0.58 }, { id: "b" }], account: { planLabel: "Pro" } };
      }
    }
    const reporting = new CapacityReportingProvider("acme", () => ({ status: "success" }));
    const factories = new Map<string, ProviderFactory>([
      ["acme", () => reporting],
      ["zenith", () => new MockProvider("zenith", () => ({ status: "success" }))]
    ]);
    const orchestrator = await buildOrchestrator(factories);
    const summaries = await orchestrator.listProviders();
    const acme = summaries.find((s) => s.id === "acme")!;
    expect(acme.capacity).toEqual({
      status: "known",
      windows: [{ id: "a", usedFraction: 0.58 }, { id: "b" }],
      account: { planLabel: "Pro" }
    });
  });

  it("a provider whose getCapacity() rejects is still listed with unknown capacity and the failure detail, and the others are unaffected", async () => {
    class RejectingCapacityProvider extends MockProvider {
      getCapacity(): Promise<ProviderCapacityInfo> {
        return Promise.reject(new Error("capacity-boom"));
      }
    }
    const factories = new Map<string, ProviderFactory>([
      ["acme", () => new RejectingCapacityProvider("acme", () => ({ status: "success" }))],
      ["zenith", () => new MockProvider("zenith", () => ({ status: "success" }))]
    ]);
    const orchestrator = await buildOrchestrator(factories);
    const summaries = await orchestrator.listProviders();
    expect(summaries.map((s) => s.id).sort()).toEqual(["acme", "zenith"]);
    const acme = summaries.find((s) => s.id === "acme")!;
    const zenith = summaries.find((s) => s.id === "zenith")!;
    expect(acme.capacity).toEqual({ status: "unknown", detail: "capacity-boom" });
    expect(acme.availability.available).toBe(true);
    expect(zenith.capacity).toEqual({ status: "unknown" });
    expect(zenith.availability.available).toBe(true);
  });

  it("a provider whose checkAvailability() throws is reported unavailable, never breaking enumeration of the others", async () => {
    class ThrowingProvider extends MockProvider {
      async checkAvailability(): Promise<never> {
        throw new Error("boom");
      }
    }
    const factories = new Map<string, ProviderFactory>([
      ["acme", () => new ThrowingProvider("acme", () => ({ status: "success" }))],
      ["zenith", () => new MockProvider("zenith", () => ({ status: "success" }))]
    ]);
    const orchestrator = await buildOrchestrator(factories);
    const summaries = await orchestrator.listProviders();
    const acme = summaries.find((s) => s.id === "acme")!;
    const zenith = summaries.find((s) => s.id === "zenith")!;
    expect(acme.availability).toEqual({ available: false, detail: "boom" });
    expect(zenith.availability.available).toBe(true);
  });
});
