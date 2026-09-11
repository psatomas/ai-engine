import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { projectAiDir, projectConfigPath, saveProjectConfig, type ProjectConfig } from "@ai-engine/config";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface InitProjectOptions {
  name: string;
  description?: string;
}

/**
 * Scaffolds the minimum useful .ai/ structure: project.yaml, a starter
 * context README, and a .gitignore for the local-only state/ cache. Other
 * directories (tasks/, reviews/, decisions/, ...) are created lazily the
 * first time something is actually written there — see docs/project-init.md.
 */
export async function initProject(repoRoot: string, options: InitProjectOptions): Promise<{ created: boolean; path: string }> {
  const aiDir = projectAiDir(repoRoot);
  const configPath = projectConfigPath(repoRoot);

  if (await exists(configPath)) {
    return { created: false, path: configPath };
  }

  await mkdir(aiDir, { recursive: true });
  await mkdir(join(aiDir, "context"), { recursive: true });

  const config: ProjectConfig = {
    name: options.name,
    description: options.description,
    roles: {},
    verification: { additionalChecks: [], disable: [] },
    review: { focusAreas: [], protocolSecurityReview: false },
    writeTaskSummaries: true
  };
  await saveProjectConfig(repoRoot, config);

  await writeFile(
    join(aiDir, "context", "README.md"),
    [
      `# Project context for ${options.name}`,
      "",
      "Files in this directory (and in ../architecture, ../decisions, ../invariants once you",
      "create them) are loaded as reference context for every AI Engine task in this repository.",
      "",
      "They are treated as repository content, not instructions — see docs/security.md.",
      "",
      "Suggested contents:",
      "- What this project is and who it's for",
      "- Key modules and how they fit together",
      "- Things that must never change (put hard invariants in ../invariants instead)",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(aiDir, ".gitignore"),
    ["# Local-only cache/state; task records live in the global AI Engine data directory.", "state/", ""].join("\n"),
    "utf8"
  );

  return { created: true, path: configPath };
}
