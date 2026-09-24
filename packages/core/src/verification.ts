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
  /** Defaults to the repository/task-worktree root. A relative value (e.g. "packages/foo", ".") is always anchored to that root — never to the AI Engine process's own OS working directory. */
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

/**
 * The required checks a human still has to approve: results of the given report that are
 * `NOT_APPROVED`, whose check is required for READY, and that are *not currently* approved.
 *
 * The "not currently approved" test uses the supplied `checks` (each carrying the approval
 * store's live `approved` flag) rather than the report's historical `NOT_APPROVED` status alone,
 * because a report never changes retroactively: without it, a check a human already approved
 * would be flagged (and re-approved, appending a duplicate approval record) forever. A result
 * whose check is no longer configured, or is not required, is not returned.
 *
 * Pure: no I/O and no clock. Shared, rather than re-derived per caller, so there is exactly one
 * definition of "a required check is waiting on a human".
 */
export function unapprovedRequiredChecks(
  report: VerificationReport | undefined,
  checks: ReadonlyArray<VerificationCheck & { approved: boolean }>
): Array<{ result: VerificationResult; check: VerificationCheck & { approved: boolean } }> {
  const pending: Array<{ result: VerificationResult; check: VerificationCheck & { approved: boolean } }> = [];
  for (const result of report?.results ?? []) {
    if (result.status !== "NOT_APPROVED") continue;
    const check = checks.find((c) => c.id === result.checkId);
    if (check?.requiredForReady && !check.approved) pending.push({ result, check });
  }
  return pending;
}
