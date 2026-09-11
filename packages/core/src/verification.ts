export type VerificationStatus = "PASS" | "FAIL" | "SKIPPED" | "NOT_CONFIGURED" | "NOT_APPROVED";

/**
 * Where a check's command came from. This is the trust boundary the
 * verification runner enforces (see @ai-engine/verification's runner.ts and
 * docs/security.md#repository-controlled-verification-commands):
 *
 *   - "auto_detected": the command string is constructed by AI Engine itself
 *     (e.g. `npm run ${script}` for a script that exists in package.json).
 *     The repository controls *whether* the check exists and what the named
 *     script does once npm runs it — the same trust a developer already
 *     extends by running `npm test` themselves — but not the literal shell
 *     command AI Engine invokes.
 *   - "repository_configured": the full command *string* is taken verbatim
 *     from repository-tracked configuration (.ai/project.yaml). This is a
 *     materially different, higher-risk surface: it is arbitrary shell text
 *     chosen entirely by whoever can land a PR. Such a check is NEVER
 *     executed until a human has explicitly approved that exact command
 *     text (see CommandApprovalStore) — an unapproved one is reported as
 *     NOT_APPROVED rather than silently run or silently skipped.
 */
export type VerificationCheckOrigin = "auto_detected" | "repository_configured";

export interface VerificationCheck {
  id: string;
  description: string;
  /** Shell command, run with cwd = repository root (or the given subdirectory). */
  command: string;
  cwd?: string;
  /** If true, a FAIL (or SKIPPED/NOT_CONFIGURED/NOT_APPROVED) blocks the task from reaching READY. */
  requiredForReady: boolean;
  /** Wall-clock timeout for this single check. */
  timeoutMs?: number;
  /** Trust boundary for this check's command text — see VerificationCheckOrigin. Defaults to "auto_detected" for callers that predate this field (never widens trust for repository-configured checks, which always set it explicitly). */
  origin?: VerificationCheckOrigin;
}

export interface VerificationResult {
  checkId: string;
  status: VerificationStatus;
  durationMs: number;
  exitCode?: number | null;
  output?: string;
  reason?: string;
}

export interface VerificationReport {
  taskId: string;
  createdAt: string;
  results: VerificationResult[];
}

/**
 * A check counts against the READY gate only while it is still required.
 * Disabling a check (project config's verification.disable) is expected to
 * exempt it from this set — callers building `checks` for a disabled id
 * must also clear its `requiredForReady`, otherwise a disabled-but-still-
 * "required" check can never be satisfied (SKIPPED is never PASS) and the
 * task would be permanently unable to reach READY. See
 * @ai-engine/orchestrator's test()/finalVerify() for where that's done.
 */
export function verificationPassed(report: VerificationReport, checks: VerificationCheck[]): boolean {
  const requiredIds = new Set(checks.filter((c) => c.requiredForReady).map((c) => c.id));
  return report.results.every((r) => !requiredIds.has(r.checkId) || r.status === "PASS");
}
