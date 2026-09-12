import { execa } from "execa";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { VerificationCheck, VerificationReport, VerificationResult } from "@ai-engine/core";
import type { NotConfiguredCheck } from "./detectors.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 8000;

/**
 * Re-validates that a check's `cwd` is still contained within the repository root at
 * the moment right before it actually executes — not at whatever earlier moment
 * discovery found the directory. Discovery-time detection already never follows a
 * symlinked directory (see detectors.ts), but that alone can't close a TOCTOU gap: a
 * directory `Dirent.isDirectory()` saw as real at discovery time could have been
 * replaced by a symlink pointing outside the repository by the time this actually
 * runs.
 *
 * Returns the resolved `realCwd` on success — a first review of this exact check
 * found that computing it here and then still executing with the original, unresolved
 * `check.cwd` defeated much of the point: `execa` would re-resolve `check.cwd` itself
 * at spawn time, independently, giving a symlink swapped in the intervening window
 * exactly the redirection this check exists to catch. The caller must use the
 * returned `realCwd`, not `check.cwd`, for that reason.
 *
 * What this does and does not guarantee — stated precisely, since a later review
 * found the comment that used to be here overstated it:
 *   - Resolving and validating `realCwd` prevents execution through a symlink
 *     redirection that already existed at the moment `realpath` resolved it — that
 *     redirection is caught and rejected right here.
 *   - Passing that validated, resolved pathname to `execa` (instead of the original
 *     `check.cwd`) avoids `execa` re-resolving `check.cwd`'s own symlink a second,
 *     independent time at spawn — the specific issue a first review found (this
 *     function used to compute `realCwd` and then still hand `execa` the original,
 *     unresolved `check.cwd`).
 *   - It does NOT eliminate pathname-based TOCTOU races in general. `realCwd` is
 *     still only a pathname, not an opened directory descriptor: the path it names
 *     can still, in principle, be removed, renamed, or replaced by something else —
 *     including a new symlink — after this check validates it and before `execa`'s
 *     spawn actually opens it. Nothing here prevents that specific window; closing
 *     it would require file-descriptor-relative execution (opening the directory
 *     once and executing relative to that open handle, `openat`-style) rather than
 *     validating and re-passing a path string — a materially larger change this
 *     does not make. In short: this reduces/avoids the specific re-resolution issue
 *     found in a first review, it does not eliminate all pathname-based TOCTOU
 *     races.
 */
async function checkContainment(cwd: string, repoRoot: string): Promise<{ ok: true; realCwd: string } | { ok: false; reason: string }> {
  let realCwd: string;
  let realRoot: string;
  try {
    [realCwd, realRoot] = await Promise.all([realpath(cwd), realpath(repoRoot)]);
  } catch (err) {
    return { ok: false, reason: `check cwd could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rel = relative(realRoot, realCwd);
  const contained = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!contained) {
    return { ok: false, reason: `check cwd "${cwd}" resolves outside the repository root — refusing to execute` };
  }
  return { ok: true, realCwd };
}

/**
 * Consulted before a "repository_configured" check is ever executed (see
 * VerificationCheckOrigin in @ai-engine/core). The runner is deliberately
 * decoupled from any concrete approval-store implementation — the
 * orchestrator wires @ai-engine/security's CommandApprovalStore in — so
 * this package doesn't need a dependency on @ai-engine/security, and so a
 * test can substitute a trivial in-memory predicate.
 */
export interface CommandApprovalChecker {
  isApproved(command: string): Promise<boolean>;
}

/** Optional secondary check (defense-in-depth, not the primary boundary — see docs/security.md). */
export interface CommandDenylistChecker {
  checkCommand(command: string): { denied: boolean; matchedPattern?: string };
}

async function runOne(check: VerificationCheck, repoRoot?: string): Promise<VerificationResult> {
  const start = Date.now();
  let cwd = check.cwd;

  if (repoRoot && check.cwd) {
    const containment = await checkContainment(check.cwd, repoRoot);
    if (!containment.ok) {
      return { checkId: check.id, status: "FAIL", durationMs: Date.now() - start, reason: containment.reason };
    }
    // Execute at the exact path just validated, not the original check.cwd — avoids
    // execa re-resolving check.cwd's own symlink a second, independent time. See
    // checkContainment's doc comment for exactly what this does and doesn't
    // guarantee: it narrows one specific re-resolution issue, it does not eliminate
    // pathname-based TOCTOU races in general.
    cwd = containment.realCwd;
  }

  try {
    const result = await execa(check.command, {
      shell: true,
      cwd,
      timeout: check.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      reject: false,
      all: true
    });
    const durationMs = Date.now() - start;
    const output = tail(result.all ?? "");
    if (result.timedOut) {
      return { checkId: check.id, status: "FAIL", durationMs, exitCode: result.exitCode, output, reason: "timed out" };
    }
    return {
      checkId: check.id,
      status: result.exitCode === 0 ? "PASS" : "FAIL",
      durationMs,
      exitCode: result.exitCode,
      output
    };
  } catch (err) {
    return {
      checkId: check.id,
      status: "FAIL",
      durationMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err)
    };
  }
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

export interface RunVerificationOptions {
  /** Checks explicitly disabled by project config; reported SKIPPED and never run. Callers must also have cleared requiredForReady for these ids — see core/verification.ts. */
  skip?: string[];
  /**
   * Required for any check with origin "repository_configured" — such a
   * check is reported NOT_APPROVED and never executed unless this reports
   * it approved. Omitting this entirely means NO repository-configured
   * command can ever run, which is the safe default; the CLI/orchestrator
   * always wires a real CommandApprovalStore in.
   */
  approvals?: CommandApprovalChecker;
  /** Optional secondary deny-list check applied even to an approved repository-configured command. */
  denylist?: CommandDenylistChecker;
  /**
   * The repository root every check's `cwd` must remain contained within, re-verified
   * via `realpath` immediately before each check executes (see `checkContainment`
   * above). Optional for backward compatibility with callers/tests that construct
   * checks directly and don't need this boundary re-validated at execution time; the
   * orchestrator always supplies it, since it always knows the task's repository root.
   */
  repoRoot?: string;
}

export async function runVerification(
  taskId: string,
  checks: VerificationCheck[],
  notConfigured: NotConfiguredCheck[] = [],
  skipOrOptions: string[] | RunVerificationOptions = []
): Promise<VerificationReport> {
  const options: RunVerificationOptions = Array.isArray(skipOrOptions) ? { skip: skipOrOptions } : skipOrOptions;
  const skip = options.skip ?? [];
  const results: VerificationResult[] = [];

  for (const check of checks) {
    if (skip.includes(check.id)) {
      results.push({ checkId: check.id, status: "SKIPPED", durationMs: 0, reason: "disabled by project config" });
      continue;
    }

    if (check.origin === "repository_configured") {
      const denyCheck = options.denylist?.checkCommand(check.command);
      if (denyCheck?.denied) {
        results.push({
          checkId: check.id,
          status: "NOT_APPROVED",
          durationMs: 0,
          reason: `command matches a denied pattern ("${denyCheck.matchedPattern}") and can never be approved; edit or remove this check in .ai/project.yaml`
        });
        continue;
      }
      const approved = (await options.approvals?.isApproved(check.command)) ?? false;
      if (!approved) {
        results.push({
          checkId: check.id,
          status: "NOT_APPROVED",
          durationMs: 0,
          reason:
            "this command is defined in repository-tracked configuration (.ai/project.yaml) and has not been explicitly approved on this machine — run `ai verify approve <taskId> " +
            check.id +
            "` (or the equivalent VS Code command) to review and approve it before it will ever be executed"
        });
        continue;
      }
    }

    results.push(await runOne(check, options.repoRoot));
  }

  for (const nc of notConfigured) {
    results.push({ checkId: nc.id, status: "NOT_CONFIGURED", durationMs: 0, reason: nc.reason });
  }

  return { taskId, createdAt: new Date().toISOString(), results };
}
