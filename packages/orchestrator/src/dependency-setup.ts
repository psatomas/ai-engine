import { access } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { DependencySetupResult } from "@ai-engine/core";

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;

interface PackageManagerRule {
  id: string;
  lockfile: string;
  binary: string;
  args: string[];
}

/**
 * Each entry is deliberately that package manager's "frozen"/"reproducible" install variant —
 * `npm ci`, not `npm install`; `--frozen-lockfile`, not a plain install — because those refuse to
 * run rather than silently rewrite the lockfile when it's out of sync with package.json. That
 * matters here specifically: a plain `npm install`, run manually during the first real E2E
 * validation to unblock a "tsc: command not found" failure, re-synced an unrelated `license`
 * field into package-lock.json, and AI Engine's own commitAllIfChanged() later swept that into a
 * task commit as if it were part of the implementer's change. The frozen variants make that
 * class of incident structurally impossible: they either install exactly what the lockfile says
 * or they fail outright, never rewrite it.
 *
 * Order only matters if a repo somehow has more than one lockfile (unusual); npm first only
 * because it's the default this codebase's own verification detectors already assume elsewhere.
 */
const PACKAGE_MANAGERS: PackageManagerRule[] = [
  { id: "npm", lockfile: "package-lock.json", binary: "npm", args: ["ci"] },
  { id: "pnpm", lockfile: "pnpm-lock.yaml", binary: "pnpm", args: ["install", "--frozen-lockfile"] },
  { id: "yarn", lockfile: "yarn.lock", binary: "yarn", args: ["install", "--frozen-lockfile"] },
  { id: "bun", lockfile: "bun.lockb", binary: "bun", args: ["install", "--frozen-lockfile"] }
];

export interface CommandDenylistChecker {
  checkCommand(command: string): { denied: boolean; matchedPattern?: string };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findRule(worktreePath: string): Promise<PackageManagerRule | undefined> {
  for (const rule of PACKAGE_MANAGERS) {
    if (await exists(join(worktreePath, rule.lockfile))) return rule;
  }
  return undefined;
}

/**
 * true iff `git check-ignore` reports the path as ignored; false for "not ignored" AND for any
 * other failure (fail closed — never install on an inconclusive answer).
 *
 * The query path is passed with a trailing slash even though `node_modules` doesn't exist yet at
 * check time (that's the whole point — this runs before anything is installed): without it, git
 * can't tell whether the path would be a file or a directory, and a directory-only `.gitignore`
 * pattern (`node_modules/`, the overwhelmingly common form) only matches paths git can confirm are
 * directories — so an un-slashed query on a not-yet-existing path is wrongly reported as "not
 * ignored" regardless of what .gitignore actually says (confirmed directly against real git; a
 * trailing slash on the query resolves it correctly whether or not .gitignore's own pattern has
 * one either).
 */
async function isGitignored(cwd: string, relativePath: string): Promise<boolean> {
  try {
    await execa("git", ["check-ignore", "-q", `${relativePath}/`], { cwd });
    return true;
  } catch {
    return false;
  }
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

/**
 * Best-effort, one-time preparation of a freshly created task worktree so verification and
 * implementation don't immediately fail on a missing toolchain (`tsc: command not found`, etc.)
 * — `git worktree` only checks out *tracked* files, so `node_modules` never exists in a new one,
 * which a real end-to-end run against execution-kernel-protocol exposed.
 *
 * Deliberately narrow — this is a fix for that specific finding, not a package-management
 * framework:
 *   - Detects the package manager from whichever lockfile is present instead of assuming npm.
 *   - Only ever runs one of four fixed, hardcoded install commands (never anything read from the
 *     repository) — the same trust boundary "auto_detected" verification checks already use (see
 *     docs/security.md#repository-controlled-verification-commands: AI Engine constructs these
 *     command strings itself, so this does not need CommandApprovalStore's approval gate, which
 *     exists specifically for free-form repository-authored command text) — but the resulting
 *     command is still run past the security policy's command deny-list for defense-in-depth.
 *   - Refuses to install at all unless `node_modules` is actually covered by the repository's own
 *     .gitignore (checked live via `git check-ignore`), so a later commitAllIfChanged() can never
 *     sweep a dependency tree into a task commit.
 *   - Runs at most once, at task-creation time, before any agent is invoked.
 *   - Never throws and never blocks task creation — an install failure is recorded on the task
 *     (`dependencySetup`, see `ai status <taskId>`) and verification simply fails normally,
 *     exactly as it did before this existed, but now with a clear, upfront reason instead of a
 *     confusing downstream "command not found".
 */
export async function prepareWorktreeDependencies(
  worktreePath: string,
  deps: { securityPolicy: CommandDenylistChecker }
): Promise<DependencySetupResult> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;

  if (!(await exists(join(worktreePath, "package.json")))) {
    return { status: "skipped", reason: "no package.json in the repository root", durationMs: elapsed() };
  }

  const rule = await findRule(worktreePath);
  if (!rule) {
    return {
      status: "skipped",
      reason:
        "package.json present but no recognized lockfile (package-lock.json / yarn.lock / pnpm-lock.yaml / bun.lockb) — not attempting an install that could produce an unreviewed lockfile",
      durationMs: elapsed()
    };
  }

  if (await exists(join(worktreePath, "node_modules"))) {
    return { status: "skipped", packageManager: rule.id, reason: "node_modules already present", durationMs: elapsed() };
  }

  if (!(await isGitignored(worktreePath, "node_modules"))) {
    return {
      status: "skipped",
      packageManager: rule.id,
      reason:
        "node_modules is not confirmed to be covered by this repository's .gitignore — refusing to auto-install to avoid a later commit sweeping dependency artifacts in",
      durationMs: elapsed()
    };
  }

  const command = `${rule.binary} ${rule.args.join(" ")}`;
  const denyCheck = deps.securityPolicy.checkCommand(command);
  if (denyCheck.denied) {
    return {
      status: "skipped",
      packageManager: rule.id,
      command,
      reason: `command matches a denied pattern ("${denyCheck.matchedPattern}")`,
      durationMs: elapsed()
    };
  }

  try {
    const result = await execa(rule.binary, rule.args, {
      cwd: worktreePath,
      timeout: INSTALL_TIMEOUT_MS,
      reject: false,
      all: true
    });
    // With reject:false, execa does NOT throw on a spawn failure (e.g. the binary not existing at
    // all) — it resolves with a result object that has no exitCode and a `failed`/`code` marker
    // instead (confirmed directly; this is not the "throws on ENOENT" behavior the try/catch below
    // was originally written to guard against). Treat "never actually started" (no exitCode) as
    // "skipped" — the package manager this repo wants isn't installed — distinctly from "started
    // and exited non-zero", which is a genuine install failure.
    if (result.exitCode === undefined) {
      return {
        status: "skipped",
        packageManager: rule.id,
        command,
        reason: `"${rule.binary}" is not available on this machine (${result.all || (result as { message?: string }).message || "spawn failed"})`,
        durationMs: elapsed()
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: "failed",
        packageManager: rule.id,
        command,
        reason: tail(result.all ?? `exited with code ${result.exitCode}`),
        durationMs: elapsed()
      };
    }
    return { status: "installed", packageManager: rule.id, command, durationMs: elapsed() };
  } catch (err) {
    // Defensive fallback for an execa version/config that does throw here (e.g. reject:true was
    // ever accidentally introduced above) — not expected to be reached given reject:false, but
    // failing "skipped" rather than propagating an exception out of task creation either way.
    return {
      status: "skipped",
      packageManager: rule.id,
      command,
      reason: err instanceof Error ? err.message : String(err),
      durationMs: elapsed()
    };
  }
}
