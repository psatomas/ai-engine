import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnginePaths } from "./paths.js";
import { loadGlobalConfig, saveGlobalConfig, loadProjectConfig, saveProjectConfig, resolveRoleAssignment } from "./load.js";
import { GlobalConfigSchema } from "./schema.js";

let configDir: string;
let dataDir: string;
let repoRoot: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "ai-engine-config-"));
  dataDir = await mkdtemp(join(tmpdir(), "ai-engine-data-"));
  repoRoot = await mkdtemp(join(tmpdir(), "ai-engine-repo-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

describe("resolveEnginePaths", () => {
  it("honors explicit env overrides", () => {
    const paths = resolveEnginePaths({ AI_ENGINE_CONFIG_DIR: configDir, AI_ENGINE_DATA_DIR: dataDir });
    expect(paths.configDir).toBe(configDir);
    expect(paths.dataDir).toBe(dataDir);
    expect(paths.configFile).toBe(join(configDir, "config.yaml"));
    expect(paths.taskStoreDir).toBe(join(dataDir, "tasks"));
  });
});

describe("global config", () => {
  it("returns schema defaults when no config file exists", async () => {
    const paths = resolveEnginePaths({ AI_ENGINE_CONFIG_DIR: configDir, AI_ENGINE_DATA_DIR: dataDir });
    const config = await loadGlobalConfig(paths);
    expect(config).toEqual(GlobalConfigSchema.parse({}));
    expect(config.roles.implementer?.providerId).toBe("claude");
    expect(config.roles.architect?.providerId).toBe("codex");
  });

  it("round-trips a saved config", async () => {
    const paths = resolveEnginePaths({ AI_ENGINE_CONFIG_DIR: configDir, AI_ENGINE_DATA_DIR: dataDir });
    const config = GlobalConfigSchema.parse({ roles: { implementer: { providerId: "gemini" } } });
    await saveGlobalConfig(config, paths);
    const reloaded = await loadGlobalConfig(paths);
    expect(reloaded.roles.implementer?.providerId).toBe("gemini");
  });
});

describe("project config", () => {
  it("returns undefined when .ai/project.yaml does not exist", async () => {
    expect(await loadProjectConfig(repoRoot)).toBeUndefined();
  });

  it("round-trips a saved project config", async () => {
    await saveProjectConfig(repoRoot, {
      name: "demo",
      roles: { security_reviewer: { providerId: "codex" } },
      verification: { additionalChecks: [], disable: ["npm.lint"] },
      review: { focusAreas: ["reentrancy"], protocolSecurityReview: true },
      writeTaskSummaries: true
    });
    const reloaded = await loadProjectConfig(repoRoot);
    expect(reloaded?.name).toBe("demo");
    expect(reloaded?.verification.disable).toEqual(["npm.lint"]);
    expect(reloaded?.review.protocolSecurityReview).toBe(true);
  });
});

describe("resolveRoleAssignment", () => {
  it("prefers the project override over the global default", () => {
    const global = GlobalConfigSchema.parse({});
    const project = { name: "x", roles: { implementer: { providerId: "gemini" } }, verification: {}, review: {}, writeTaskSummaries: true };
    expect(resolveRoleAssignment("implementer", global, project as never)?.providerId).toBe("gemini");
    expect(resolveRoleAssignment("architect", global, project as never)?.providerId).toBe("codex");
  });

  it("falls back to the global default when there is no project config", () => {
    const global = GlobalConfigSchema.parse({});
    expect(resolveRoleAssignment("implementer", global, undefined)?.providerId).toBe("claude");
  });
});
