import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { GlobalConfigSchema, ProjectConfigSchema, type GlobalConfig, type ProjectConfig } from "./schema.js";
import { resolveEnginePaths, projectAiDir, type EnginePaths } from "./paths.js";

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function loadGlobalConfig(paths: EnginePaths = resolveEnginePaths()): Promise<GlobalConfig> {
  const raw = await readIfExists(paths.configFile);
  const parsed = raw ? parseYaml(raw) : {};
  return GlobalConfigSchema.parse(parsed ?? {});
}

export async function saveGlobalConfig(config: GlobalConfig, paths: EnginePaths = resolveEnginePaths()): Promise<void> {
  const validated = GlobalConfigSchema.parse(config);
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, stringifyYaml(validated), "utf8");
}

export function projectConfigPath(repoRoot: string): string {
  return join(projectAiDir(repoRoot), "project.yaml");
}

export async function loadProjectConfig(repoRoot: string): Promise<ProjectConfig | undefined> {
  const raw = await readIfExists(projectConfigPath(repoRoot));
  if (!raw) return undefined;
  return ProjectConfigSchema.parse(parseYaml(raw) ?? {});
}

export async function saveProjectConfig(repoRoot: string, config: ProjectConfig): Promise<void> {
  const validated = ProjectConfigSchema.parse(config);
  const path = projectConfigPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(validated), "utf8");
}

/**
 * Resolves the effective role -> provider assignment for a task: project
 * config wins over global config, so a repo can pin e.g. `security_reviewer`
 * to a stricter provider without touching machine-wide defaults.
 */
export function resolveRoleAssignment(
  role: string,
  global: GlobalConfig,
  project: ProjectConfig | undefined
): { providerId: string; model?: string } | undefined {
  return project?.roles[role] ?? global.roles[role];
}
