import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWorktreeDependencies } from "./dependency-setup.js";

const allow = { checkCommand: () => ({ denied: false }) };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-engine-depsetup-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function gitInit(cwd: string): Promise<void> {
  await execa("git", ["init", "-q"], { cwd });
  await execa("git", ["add", "-A"], { cwd });
  await execa("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd });
}

describe("prepareWorktreeDependencies", () => {
  it("skips when there is no package.json at all (most repos AI Engine points at)", async () => {
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: allow });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/no package\.json/);
  });

  it("skips (does not guess) when package.json exists but no recognized lockfile is present", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: allow });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/no recognized lockfile/);
  });

  it("skips when node_modules already exists (nothing to do)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
    await mkdir(join(dir, "node_modules"));
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: allow });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/already present/);
  });

  /**
   * Regression test for the actual incident: a manual `npm install` (to work around this exact
   * missing-node_modules problem, before this mechanism existed) modified package-lock.json, and
   * that unrelated change was later swept into a commit by commitAllIfChanged(). Requiring
   * node_modules to be gitignored *before* ever installing is the guard against that class of
   * incident recurring automatically.
   */
  it("refuses to install when node_modules is not confirmed to be gitignored (safety-first, not merely npm-first)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
    // No .gitignore at all — git check-ignore reports node_modules as NOT ignored.
    await gitInit(dir);
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: allow });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/not confirmed to be covered by this repository's \.gitignore/);
    expect(result.packageManager).toBe("npm");
  });

  it("checks the constructed install command against the security policy's deny-list before ever running it", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3 }));
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    await gitInit(dir);
    const deny = { checkCommand: () => ({ denied: true, matchedPattern: "npm ci" }) };
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: deny });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/denied pattern/);
  });

  it('never runs a plain "npm install" — only the frozen/reproducible "npm ci" variant, so an out-of-sync lockfile is refused rather than silently rewritten', async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "left-pad": "^1.0.0" } }));
    // A lockfile that does NOT satisfy the dependency above — `npm ci` must refuse this
    // deterministically and offline, not attempt to resolve/rewrite it the way `npm install` would.
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: "1.0.0" } } })
    );
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    await gitInit(dir);
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: allow });
    expect(result.status).toBe("failed");
    expect(result.command).toBe("npm ci");
    expect(result.reason).toBeTruthy();
  }, 20_000);

  it("actually runs npm ci successfully against a real, valid, zero-dependency project (real subprocess, not mocked)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    // Generate a real, valid lockfile for this exact package.json rather than hand-writing one —
    // offline and near-instant for a zero-dependency project.
    await execa("npm", ["install", "--package-lock-only"], { cwd: dir });
    await gitInit(dir);
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: allow });
    expect(result.status).toBe("installed");
    expect(result.packageManager).toBe("npm");
    expect(result.command).toBe("npm ci");
  }, 20_000);

  it("reports a missing package-manager binary as skipped, not a crash", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(dir, ".gitignore"), "node_modules/\n");
    await gitInit(dir);
    // pnpm is not installed on this machine (nor assumed to be) — this must degrade gracefully.
    const result = await prepareWorktreeDependencies(dir, { securityPolicy: allow });
    expect(result.status).toBe("skipped");
    expect(result.packageManager).toBe("pnpm");
    expect(result.reason).toBeTruthy();
  });
});
