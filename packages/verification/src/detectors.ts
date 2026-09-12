import { readFile, access, opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
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
 * How far below the repository root (depth 0) discovery looks for a nested project
 * manifest (foundry.toml / package.json). Conservative on purpose: a real end-to-end
 * run against a monorepo exposed a Foundry project at `packages/contracts/foundry.toml`
 * (depth 2) that this system failed to discover at all — this constant exists to reach
 * that real case with a little headroom, not to walk an entire tree indiscriminately.
 */
const MAX_DISCOVERY_DEPTH = 3;

/**
 * Hard resource bounds on the traversal itself, independent of depth — depth alone
 * doesn't bound cost against a repository that is merely very *wide* (thousands of
 * sibling directories, or one directory with an enormous number of entries). Both
 * are deliberately generous for any real project layout while still being a real,
 * finite ceiling rather than an unbounded walk.
 */
const MAX_VISITED_DIRECTORIES = 400;
const MAX_ENTRIES_PER_DIRECTORY = 2000;

/**
 * Directory names never descended into, at any depth — dependency trees, build output,
 * and VCS metadata. A nested `packages/foo/node_modules` is skipped exactly like the
 * root one; the check is by name, not by position.
 */
const IGNORED_DIR_NAMES = new Set([".git", "node_modules", "lib", "out", "cache", "dist", "build"]);

interface DiscoveredProject {
  dir: string;
  hasFoundry: boolean;
  hasPackageJson: boolean;
}

interface DiscoveryResult {
  projects: DiscoveredProject[];
  /** true iff MAX_VISITED_DIRECTORIES or MAX_ENTRIES_PER_DIRECTORY was hit before the walk
   *  would otherwise have finished — some nested projects may not have been discovered. */
  truncated: boolean;
}

/**
 * One bounded, deterministic traversal of the repository that discovers both manifest
 * types (`foundry.toml`, `package.json`) at once, rather than walking the same tree
 * twice. Bounded by MAX_DISCOVERY_DEPTH, MAX_VISITED_DIRECTORIES, and
 * MAX_ENTRIES_PER_DIRECTORY; skips IGNORED_DIR_NAMES; never follows symlinked
 * directories. `repoRoot` itself is always visited first (depth 0), so its own
 * project (if any) is always first in `projects`.
 *
 * Symlinked directories are excluded for free: `Dirent.isDirectory()` reflects the
 * directory entry's own type as reported by `readdir`, which is false for a symlink
 * regardless of what it points to — no `realpath` call is needed at discovery time to
 * detect and reject them. (A directory that is real *now* but gets replaced by a
 * symlink before a discovered check actually executes is a separate, later-stage race —
 * see runner.ts's execution-time containment check, which is what actually closes that
 * gap; discovery-time symlink exclusion alone cannot.)
 *
 * cwd for every discovered project is always the directory the manifest was found
 * in — never a path read from that manifest's own content — so a hostile
 * foundry.toml/package.json cannot redirect a check's execution elsewhere.
 *
 * Directory listing is streamed via `opendir()`, not materialized via `readdir()`
 * and trimmed afterward: a second independent review found that checking
 * MAX_ENTRIES_PER_DIRECTORY only after the entire directory had already been read
 * into an array defeats the point of a resource bound — the cost it's meant to cap
 * (reading a pathologically large directory) had already been paid by the time the
 * check ran. `opendir`'s async iterator reads one entry at a time; traversal stops
 * pulling further entries the moment the bound is exceeded, so a directory with
 * millions of entries costs no more than MAX_ENTRIES_PER_DIRECTORY reads, not one
 * read of the whole thing. (Node closes the underlying directory handle
 * automatically when a `for await...of` over it exits early via `break` — no
 * explicit `close()` call is needed or safe to make afterward.)
 *
 * Subdirectory names collected up to that bound are then sorted, so traversal order
 * — and therefore which directories appear where in the result — is deterministic
 * across platforms and filesystems for any directory at or under the bound (the
 * overwhelmingly common case). Only in the already-degraded case of a directory
 * that exceeds MAX_ENTRIES_PER_DIRECTORY does *which* names make it into that
 * first, bounded batch depend on raw filesystem enumeration order — an accepted,
 * documented trade-off: sorting the *entire* directory first, the way the previous
 * readdir()-based version did, is exactly the unbounded read this fix removes, so
 * "deterministic among an unbounded read" and "genuinely bounded" cannot both hold
 * at once for that one edge case. `discovery.bounded` (see detectChecks) already
 * surfaces and blocks on it either way.
 */
async function discoverProjects(repoRoot: string): Promise<DiscoveryResult> {
  const projects: DiscoveredProject[] = [];
  let visited = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated) return;
    if (visited >= MAX_VISITED_DIRECTORIES) {
      truncated = true;
      return;
    }
    visited++;

    const [hasFoundry, hasPackageJson] = await Promise.all([exists(join(dir, "foundry.toml")), exists(join(dir, "package.json"))]);
    if (hasFoundry || hasPackageJson) projects.push({ dir, hasFoundry, hasPackageJson });

    if (depth >= MAX_DISCOVERY_DEPTH) return;

    const subdirNames: string[] = [];
    try {
      const handle = await opendir(dir);
      let entryCount = 0;
      for await (const entry of handle) {
        entryCount++;
        if (entryCount > MAX_ENTRIES_PER_DIRECTORY) {
          truncated = true;
          break; // stop reading further entries — never materializes the rest
        }
        if (!entry.isDirectory()) continue;
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        subdirNames.push(entry.name);
      }
    } catch {
      return; // unreadable directory (permissions, race) — skip, don't fail discovery
    }
    subdirNames.sort((a, b) => a.localeCompare(b));

    for (const name of subdirNames) {
      if (truncated && visited >= MAX_VISITED_DIRECTORIES) return;
      await walk(join(dir, name), depth + 1);
    }
  }

  await walk(repoRoot, 0);
  return { projects, truncated };
}

/**
 * The shared nested-check-id convention: "" for `repoRoot` itself (so root-level
 * check ids never change — see detectFoundryChecks/detectNodeChecks), and
 * ":relative/posix/path" for anything discovered underneath it, e.g.
 * "forge.test:packages/contracts" or "npm.test:packages/sdk".
 */
function idSuffixFor(repoRoot: string, dir: string): string {
  const rel = relative(repoRoot, dir);
  return rel === "" ? "" : `:${rel.split(sep).join("/")}`;
}

function labelFor(suffix: string): string {
  return suffix === "" ? "" : ` (${suffix.slice(1)})`;
}

interface NodeCandidate {
  script: string;
  id: string;
  description: string;
}

const NODE_CANDIDATES: NodeCandidate[] = [
  { script: "build", id: "npm.build", description: "npm run build" },
  { script: "test", id: "npm.test", description: "npm test" },
  { script: "typecheck", id: "npm.typecheck", description: "npm run typecheck" },
  { script: "lint", id: "npm.lint", description: "npm run lint" },
  { script: "format:check", id: "npm.format", description: "npm run format:check" }
];

function isRequiredForReady(id: string): boolean {
  return id === "npm.build" || id === "npm.test" || id === "npm.typecheck";
}

interface PkgJson {
  scripts?: Record<string, string>;
  workspaces?: unknown;
}

/**
 * Lenient, nested-manifest-only reader: a malformed or unreadable `package.json`
 * anywhere *other than* the repository root is treated as "nothing to detect here"
 * so one bad vendored/generated/unrelated nested file can never halt discovery of
 * everything else. This is deliberately NOT used for the root manifest — see
 * `readRootPkgJson` below for why the root gets different, louder treatment.
 */
async function readPkgJson(dir: string): Promise<PkgJson | undefined> {
  const pkgPath = join(dir, "package.json");
  if (!(await exists(pkgPath))) return undefined;
  try {
    return JSON.parse(await readFile(pkgPath, "utf8")) as PkgJson;
  } catch {
    return undefined;
  }
}

type RootPkgRead = { status: "absent" } | { status: "malformed"; error: string } | { status: "ok"; pkg: PkgJson };

/**
 * The root manifest gets different treatment than a nested one: it's a file the
 * user directly owns and relies on, not an incidental discovery. A second
 * independent review found that collapsing "malformed" and "absent" into the same
 * `undefined` (as the original, pre-nested-discovery code effectively did by
 * letting `JSON.parse` throw, and as this file briefly did by silently swallowing
 * it) makes a broken root package.json indistinguishable from "no package.json
 * here at all" — exactly the failure mode a user most needs to see. This function
 * keeps the three states distinct so the caller can react differently to each;
 * see the `npm.root` check below for what "malformed" actually produces.
 */
async function readRootPkgJson(repoRoot: string): Promise<RootPkgRead> {
  const pkgPath = join(repoRoot, "package.json");
  if (!(await exists(pkgPath))) return { status: "absent" };
  try {
    return { status: "ok", pkg: JSON.parse(await readFile(pkgPath, "utf8")) as PkgJson };
  } catch (err) {
    return { status: "malformed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * npm's own two supported `workspaces` forms: a bare array of patterns, or an object
 * with a `packages` array (the only sub-key npm itself recognizes for this purpose).
 * Anything else (missing, malformed, unexpected shape) yields no patterns at all —
 * "can't prove this package is covered" is the safe default, never "assume it is".
 */
function parseWorkspacePatterns(pkg: PkgJson | undefined): string[] {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === "string");
  if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    return (ws as { packages: unknown[] }).packages.filter((p): p is string => typeof p === "string");
  }
  return [];
}

/**
 * Minimal, deterministic glob matching for npm workspace patterns: `*` matches exactly
 * one path segment, everything else must match literally, and the pattern must have
 * the same number of segments as the candidate path — e.g. `"packages/*"` matches
 * `"packages/sdk"` but not `"packages/sdk/nested"` or `"apps/sdk"`. This deliberately
 * does not support `**`/recursive globs or npm's fuller minimatch semantics — real
 * workspace configs overwhelmingly use single-level patterns like `"packages/*"`, and
 * keeping this small and exact is preferable to an approximate, harder-to-audit
 * general-purpose glob engine for a check that gates whether a command runs twice.
 */
function matchesWorkspacePattern(relPosixPath: string, pattern: string): boolean {
  const patternSegs = pattern.split("/").filter(Boolean);
  const pathSegs = relPosixPath.split("/").filter(Boolean);
  if (patternSegs.length !== pathSegs.length) return false;
  return patternSegs.every((seg, i) => seg === "*" || seg === pathSegs[i]);
}

function isIncludedInWorkspaces(relPosixPath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesWorkspacePattern(relPosixPath, p));
}

/**
 * True iff `command` is genuinely an npm invocation that runs THIS SAME `script` name
 * with the `--workspaces` flag as its own token — e.g. `"npm run typecheck
 * --workspaces --if-present"` for `script === "typecheck"`. Two things this
 * deliberately does NOT accept, per a second independent review:
 *   - a command merely *containing the text* "--workspaces" (e.g. `echo --workspaces`
 *     — tokens[0] isn't "npm" at all);
 *   - a genuine `npm run <other-script> --workspaces` that happens to also carry
 *     `--workspaces` but fans out a DIFFERENT script than the one being evaluated
 *     (checked first: only checking for the flag anywhere in the tokens, with no tie
 *     back to which script it actually runs, would accept this incorrectly).
 * Deliberately a plain whitespace split, not a full shell parse — this project only
 * ever constructs `npm run <script>`-shaped commands itself, and the one thing being
 * defended against here is a repository's own hand-written script text being mistaken
 * for real workspace fan-out, not adversarial shell syntax. A wrapper prefix (e.g.
 * `cross-env FOO=bar npm run build --workspaces`) is deliberately left unrecognized
 * too — supporting it would mean parsing arbitrary env-assignment/wrapper syntax,
 * and failing to recognize it only ever fails toward the safe direction (see
 * rootProxiesPackage below), never the unsafe one.
 */
function hasGenuineWorkspacesFlag(command: string | undefined, script: string): boolean {
  if (typeof command !== "string") return false;
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "npm") return false;
  const runIndex = tokens.indexOf("run");
  if (runIndex === -1 || tokens[runIndex + 1] !== script) return false;
  return tokens.includes("--workspaces");
}

/**
 * A nested package's script is only suppressed when root's script for that same name
 * BOTH (a) is a genuine `npm run <that same script> --workspaces` invocation, AND (b)
 * root's configured `workspaces` patterns actually include that package's path.
 * Either condition alone is not enough: a script merely containing the text
 * "--workspaces" (e.g. `echo --workspaces`), or one that invokes `--workspaces` for a
 * *different* script, must not suppress anything; and a real, correctly-targeted
 * `--workspaces` script must not suppress a package that isn't actually part of the
 * configured workspaces (root's own fan-out wouldn't reach it either). Failing to
 * prove genuine coverage always resolves to "add the nested check", never to "skip
 * it" — the safe direction for a verification gate is a possibly-redundant extra
 * check, never a silently missing one. `rootPkg`/`rootScripts` being `undefined`
 * (root absent, or malformed — see readRootPkgJson) falls out of this naturally:
 * nothing can be proven covered by a root that couldn't even be read.
 */
function rootProxiesPackage(
  rootPkg: PkgJson | undefined,
  rootScripts: Record<string, string> | undefined,
  script: string,
  relPosixPath: string
): boolean {
  if (!hasGenuineWorkspacesFlag(rootScripts?.[script], script)) return false;
  const patterns = parseWorkspacePatterns(rootPkg);
  if (patterns.length === 0) return false;
  return isIncludedInWorkspaces(relPosixPath, patterns);
}

/**
 * Never blindly runs every command it can imagine — only checks whose trigger
 * condition is actually present in the repository (a script, a config file, an
 * installed tool) are proposed, and only npm scripts that already exist are ever
 * invoked. Root-level detection is unchanged from before nested discovery existed;
 * nested packages are additive only and never alter the root checks/notConfigured
 * list above.
 */
async function detectNodeChecks(repoRoot: string, discovery: DiscoveryResult): Promise<DetectionResult> {
  const rootRead = await readRootPkgJson(repoRoot);
  const rootPkg = rootRead.status === "ok" ? rootRead.pkg : undefined;
  const rootScripts = rootPkg?.scripts;
  const checks: VerificationCheck[] = [];
  const notConfigured: NotConfiguredCheck[] = [];

  if (rootRead.status === "malformed") {
    // Loud on purpose, as a real (required, failing) check rather than only a
    // notConfigured note — a malformed root package.json must never be silently
    // indistinguishable from "no package.json here" (see readRootPkgJson).
    //
    // The command is a fully static string with NO interpolated content at all —
    // not even JSON.stringify-escaped. A second independent review correctly found
    // that `JSON.stringify` is JSON escaping, not shell escaping, and interpolating
    // `rootRead.error` (attacker-influenceable: it's derived from JSON.parse's own
    // error message over repository-controlled bytes) into a `shell: true` command
    // string was a real shell-injection vector, regardless of how it was quoted.
    // The actual parse error is reported separately, in `description` — a field
    // that is never passed to a shell — never folded back into `command`.
    checks.push({
      id: "npm.root",
      description: `package.json exists but could not be parsed: ${rootRead.error}`,
      command: "exit 1",
      cwd: repoRoot,
      requiredForReady: true,
      origin: "auto_detected"
    });
  } else if (rootRead.status === "ok") {
    for (const c of NODE_CANDIDATES) {
      if (rootScripts?.[c.script]) {
        checks.push({
          id: c.id,
          description: c.description,
          command: `npm run ${c.script}`,
          cwd: repoRoot,
          requiredForReady: isRequiredForReady(c.id),
          origin: "auto_detected"
        });
      } else {
        notConfigured.push({ id: c.id, description: c.description, reason: `no "${c.script}" script in package.json` });
      }
    }
  }
  // rootRead.status === "absent": no root checks and no notConfigured entries for
  // them either — unchanged from the original, pre-nested-discovery behavior.

  const nestedDirs = discovery.projects.filter((p) => p.hasPackageJson && p.dir !== repoRoot).map((p) => p.dir);
  for (const dir of nestedDirs) {
    const pkg = await readPkgJson(dir);
    if (!pkg?.scripts) continue;
    const suffix = idSuffixFor(repoRoot, dir);
    const relPath = suffix.slice(1);
    for (const c of NODE_CANDIDATES) {
      if (!pkg.scripts[c.script]) continue;
      if (rootProxiesPackage(rootPkg, rootScripts, c.script, relPath)) continue;
      checks.push({
        id: `${c.id}${suffix}`,
        description: `${c.description}${labelFor(suffix)}`,
        command: `npm run ${c.script}`,
        cwd: dir,
        requiredForReady: isRequiredForReady(c.id),
        origin: "auto_detected"
      });
    }
  }

  return { checks, notConfigured };
}

async function detectFoundryChecks(repoRoot: string, discovery: DiscoveryResult): Promise<DetectionResult> {
  const dirs = discovery.projects.filter((p) => p.hasFoundry).map((p) => p.dir);
  if (dirs.length === 0) return { checks: [], notConfigured: [] };

  const checks: VerificationCheck[] = [];
  const hasSlither = await binaryOnPath("slither"); // evaluated once, reused for every discovered directory

  for (const dir of dirs) {
    const suffix = idSuffixFor(repoRoot, dir);
    const label = labelFor(suffix);
    checks.push(
      {
        id: `forge.build${suffix}`,
        description: `forge build${label}`,
        command: "forge build",
        cwd: dir,
        requiredForReady: true,
        origin: "auto_detected"
      },
      {
        id: `forge.test${suffix}`,
        description: `forge test${label}`,
        command: "forge test",
        cwd: dir,
        requiredForReady: true,
        origin: "auto_detected"
      },
      {
        id: `forge.fmt${suffix}`,
        description: `forge fmt --check${label}`,
        command: "forge fmt --check",
        cwd: dir,
        requiredForReady: false,
        origin: "auto_detected"
      }
    );
    if (hasSlither) {
      checks.push({
        id: `slither${suffix}`,
        description: `slither static analysis${label}`,
        command: "slither .",
        cwd: dir,
        requiredForReady: false,
        origin: "auto_detected"
      });
    }
  }

  // Slither's absence is a fact about the machine, not per-project — reported once,
  // globally, rather than once per discovered Foundry directory.
  const notConfigured: NotConfiguredCheck[] = hasSlither
    ? []
    : [{ id: "slither", description: "slither static analysis", reason: "slither not found on PATH" }];

  return { checks, notConfigured };
}

export async function detectChecks(repoRoot: string): Promise<DetectionResult> {
  const discovery = await discoverProjects(repoRoot);
  const [node, foundry] = await Promise.all([detectNodeChecks(repoRoot, discovery), detectFoundryChecks(repoRoot, discovery)]);
  const checks = [...node.checks, ...foundry.checks];
  const notConfigured = [...node.notConfigured, ...foundry.notConfigured];

  if (discovery.truncated) {
    // A real, requiredForReady, deterministically-failing check — not merely a
    // notConfigured note. A second independent review found that a notConfigured-only
    // signal is never consulted by verificationPassed() (see @ai-engine/core), so a
    // task could reach READY even though hitting this bound means some required
    // nested project's checks may never have been generated at all. This uses the
    // existing verification model unchanged (a normal auto_detected check that just
    // happens to always fail while true) rather than adding a new status/gate
    // mechanism — the smallest change that actually blocks READY here.
    //
    // The command is fully static (no interpolation, matching npm.root above) even
    // though the values folded into this message are AI Engine's own fixed constants,
    // never repository-controlled content — consistency with the one case that
    // genuinely needed this is worth more than a second, differently-shaped pattern.
    checks.push({
      id: "discovery.bounded",
      description: `nested project discovery stopped early after reaching a resource bound (max ${MAX_VISITED_DIRECTORIES} directories, ${MAX_ENTRIES_PER_DIRECTORY} entries per directory) — some nested projects may not have been discovered; add anything missed via .ai/project.yaml's verification.additionalChecks`,
      command: "exit 1",
      cwd: repoRoot,
      requiredForReady: true,
      origin: "auto_detected"
    });
  }

  return { checks, notConfigured };
}
