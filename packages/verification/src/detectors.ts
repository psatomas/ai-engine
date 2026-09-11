import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { VerificationCheck } from "@ai-engine/core";

export interface NotConfiguredCheck {
  id: string;
  description: string;
  reason: string;
}

export interface DetectionResult {
  checks: VerificationCheck[];
  notConfigured: NotConfiguredCheck[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function binaryOnPath(name: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    if (await exists(join(dir, name))) return true;
  }
  return false;
}

/**
 * Never blindly runs every command it can imagine — only checks whose
 * trigger condition is actually present in the repository (a script, a
 * config file, an installed tool) are proposed, and only npm scripts that
 * already exist are ever invoked.
 */
async function detectNodeChecks(repoRoot: string): Promise<DetectionResult> {
  const pkgPath = join(repoRoot, "package.json");
  if (!(await exists(pkgPath))) return { checks: [], notConfigured: [] };

  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const checks: VerificationCheck[] = [];
  const notConfigured: NotConfiguredCheck[] = [];

  const candidates: Array<{ script: string; id: string; description: string }> = [
    { script: "build", id: "npm.build", description: "npm run build" },
    { script: "test", id: "npm.test", description: "npm test" },
    { script: "typecheck", id: "npm.typecheck", description: "npm run typecheck" },
    { script: "lint", id: "npm.lint", description: "npm run lint" },
    { script: "format:check", id: "npm.format", description: "npm run format:check" }
  ];

  for (const c of candidates) {
    if (scripts[c.script]) {
      checks.push({
        id: c.id,
        description: c.description,
        command: `npm run ${c.script}`,
        cwd: repoRoot,
        requiredForReady: c.id === "npm.build" || c.id === "npm.test" || c.id === "npm.typecheck",
        origin: "auto_detected"
      });
    } else {
      notConfigured.push({ id: c.id, description: c.description, reason: `no "${c.script}" script in package.json` });
    }
  }

  return { checks, notConfigured };
}

async function detectFoundryChecks(repoRoot: string): Promise<DetectionResult> {
  const hasFoundry = await exists(join(repoRoot, "foundry.toml"));
  if (!hasFoundry) return { checks: [], notConfigured: [] };

  const checks: VerificationCheck[] = [
    {
      id: "forge.build",
      description: "forge build",
      command: "forge build",
      cwd: repoRoot,
      requiredForReady: true,
      origin: "auto_detected"
    },
    { id: "forge.test", description: "forge test", command: "forge test", cwd: repoRoot, requiredForReady: true, origin: "auto_detected" },
    {
      id: "forge.fmt",
      description: "forge fmt --check",
      command: "forge fmt --check",
      cwd: repoRoot,
      requiredForReady: false,
      origin: "auto_detected"
    }
  ];
  const notConfigured: NotConfiguredCheck[] = [];

  if (await binaryOnPath("slither")) {
    checks.push({
      id: "slither",
      description: "slither static analysis",
      command: "slither .",
      cwd: repoRoot,
      requiredForReady: false,
      origin: "auto_detected"
    });
  } else {
    notConfigured.push({ id: "slither", description: "slither static analysis", reason: "slither not found on PATH" });
  }

  return { checks, notConfigured };
}

export async function detectChecks(repoRoot: string): Promise<DetectionResult> {
  const [node, foundry] = await Promise.all([detectNodeChecks(repoRoot), detectFoundryChecks(repoRoot)]);
  return {
    checks: [...node.checks, ...foundry.checks],
    notConfigured: [...node.notConfigured, ...foundry.notConfigured]
  };
}
