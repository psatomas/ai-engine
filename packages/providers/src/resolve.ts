import { access, constants, readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface BinaryResolution {
  path: string;
  source: "configured" | "path" | "vscode-extension";
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  const dirs = (process.env.PATH ?? "").split(platform() === "win32" ? ";" : ":").filter(Boolean);
  const names = platform() === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = join(dir, n);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** VS Code (and forks that share its extensions-dir layout) install roots we know to probe. */
function candidateExtensionsRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".vscode-server", "extensions"),
    join(home, ".vscode-server-insiders", "extensions"),
    join(home, ".cursor", "extensions"),
    join(home, ".windsurf", "extensions")
  ];
}

/**
 * Both Codex and Claude Code ship their CLI as a bundled binary inside their
 * respective VS Code extension. Those paths are version-suffixed and not a
 * stable public contract, so this is a *fallback* discovery mechanism only
 * — a configured path or a PATH-installed CLI always wins. See
 * docs/providers.md for why we still bother: on a fresh machine where the
 * user has only installed the VS Code extension, this lets ai-engine work
 * immediately instead of failing with "provider not found".
 */
async function findInVSCodeExtension(extensionIdPrefix: string, executableBasename: string): Promise<string | undefined> {
  for (const root of candidateExtensionsRoots()) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    const matches = entries.filter((e) => e.startsWith(extensionIdPrefix)).sort((a, b) => compareVersionSuffix(b, a, extensionIdPrefix)); // newest version-suffix first, numerically
    for (const dir of matches) {
      const found = await searchForExecutable(join(root, dir), executableBasename, 4);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Compares two extension directory names (e.g. "openai.chatgpt-26.908.31457-linux-x64") by the
 * numeric version segments right after `prefix`, not lexicographically. A plain string sort
 * breaks the moment any segment crosses a digit-count boundary (e.g. "9.0.0" would sort *after*
 * "10.0.0" as strings, even though it is the older version) — this compares each dot-separated
 * segment as a number instead, falling back to a lexicographic tie-break only for any trailing,
 * non-numeric platform suffix (e.g. "-linux-x64").
 */
function compareVersionSuffix(a: string, b: string, prefix: string): number {
  const versionOf = (name: string): number[] => {
    const suffix = name.slice(prefix.length);
    const match = suffix.match(/^\d+(?:\.\d+)*/);
    if (!match) return [];
    return match[0].split(".").map(Number);
  };
  const va = versionOf(a);
  const vb = versionOf(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const diff = (va[i] ?? 0) - (vb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b); // identical version numbers: stable, deterministic tie-break
}

async function searchForExecutable(root: string, basename: string, maxDepth: number): Promise<string | undefined> {
  if (maxDepth < 0) return undefined;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name === basename) {
      if (await isExecutable(full)) return full;
    } else if (entry.isDirectory()) {
      const nested = await searchForExecutable(full, basename, maxDepth - 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

export interface ResolveOptions {
  configuredPath?: string;
  pathExecutableName: string;
  vscodeExtensionIdPrefix: string;
  vscodeExecutableBasename: string;
}

export async function resolveProviderBinary(opts: ResolveOptions): Promise<BinaryResolution | undefined> {
  if (opts.configuredPath && (await isExecutable(opts.configuredPath))) {
    return { path: opts.configuredPath, source: "configured" };
  }
  const onPath = await findOnPath(opts.pathExecutableName);
  if (onPath) return { path: onPath, source: "path" };

  const bundled = await findInVSCodeExtension(opts.vscodeExtensionIdPrefix, opts.vscodeExecutableBasename);
  if (bundled) return { path: bundled, source: "vscode-extension" };

  return undefined;
}
