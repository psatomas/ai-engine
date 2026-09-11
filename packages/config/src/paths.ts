import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Global, per-machine directories. AI Engine is installed once; these paths
 * are where its configuration and durable state live, independent of any
 * repository. Resolution follows the XDG Base Directory spec on Linux,
 * platform conventions on macOS/Windows, with env var overrides so tests and
 * power users can relocate everything.
 */
export interface EnginePaths {
  /** Configuration: providers.yaml/config.yaml, policies. Safe to back up, never secret. */
  configDir: string;
  /** Durable state: task store, worktrees, logs, caches. Can grow large. */
  dataDir: string;
  configFile: string;
  taskStoreDir: string;
  worktreesDir: string;
  logsDir: string;
  cacheDir: string;
}

export function resolveEnginePaths(env: NodeJS.ProcessEnv = process.env): EnginePaths {
  const home = homedir();
  const appName = "ai-engine";

  const configDir =
    env.AI_ENGINE_CONFIG_DIR ??
    (platform() === "darwin"
      ? join(home, "Library", "Application Support", appName)
      : platform() === "win32"
        ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), appName)
        : join(env.XDG_CONFIG_HOME ?? join(home, ".config"), appName));

  const dataDir =
    env.AI_ENGINE_DATA_DIR ??
    (platform() === "darwin"
      ? join(home, "Library", "Application Support", appName)
      : platform() === "win32"
        ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), appName)
        : join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), appName));

  return {
    configDir,
    dataDir,
    configFile: join(configDir, "config.yaml"),
    taskStoreDir: join(dataDir, "tasks"),
    worktreesDir: join(dataDir, "worktrees"),
    logsDir: join(dataDir, "logs"),
    cacheDir: join(dataDir, "cache")
  };
}

/** Convention for project-local knowledge/state. Created lazily by `ai init` and as content is written. */
export function projectAiDir(repoRoot: string): string {
  return join(repoRoot, ".ai");
}
