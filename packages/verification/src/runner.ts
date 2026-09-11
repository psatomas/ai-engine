import { execa } from "execa";
import type { VerificationCheck, VerificationReport, VerificationResult } from "@ai-engine/core";
import type { NotConfiguredCheck } from "./detectors.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 8000;

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

async function runOne(check: VerificationCheck): Promise<VerificationResult> {
  const start = Date.now();
  try {
    const result = await execa(check.command, {
      shell: true,
      cwd: check.cwd,
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

    results.push(await runOne(check));
  }

  for (const nc of notConfigured) {
    results.push({ checkId: nc.id, status: "NOT_CONFIGURED", durationMs: 0, reason: nc.reason });
  }

  return { taskId, createdAt: new Date().toISOString(), results };
}
