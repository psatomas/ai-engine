import { describe, expect, it } from "vitest";
import { unapprovedRequiredChecks, type VerificationCheck, type VerificationReport, type VerificationResult } from "./verification.js";

const result = (checkId: string, status: VerificationResult["status"], reason?: string): VerificationResult => ({
  checkId,
  status,
  durationMs: 1,
  reason
});
const report = (...results: VerificationResult[]): VerificationReport => ({ taskId: "t", createdAt: "2026-01-01T00:00:00.000Z", results });
const check = (
  id: string,
  overrides: Partial<VerificationCheck & { approved: boolean }> = {}
): VerificationCheck & { approved: boolean } => ({
  id,
  description: `${id} description`,
  command: `run ${id}`,
  requiredForReady: true,
  origin: "repository_configured",
  approved: false,
  ...overrides
});

describe("unapprovedRequiredChecks", () => {
  it("returns each NOT_APPROVED, required, still-unapproved check with its result, in report order", () => {
    const a = check("a");
    const b = check("b");
    const pending = unapprovedRequiredChecks(report(result("b", "NOT_APPROVED", "needs approval"), result("a", "NOT_APPROVED")), [a, b]);
    expect(pending.map((p) => p.check.id)).toEqual(["b", "a"]);
    expect(pending[0]!.result.reason).toBe("needs approval");
    expect(pending[0]!.check).toBe(b);
  });

  it("returns nothing for an absent or empty report", () => {
    expect(unapprovedRequiredChecks(undefined, [check("a")])).toEqual([]);
    expect(unapprovedRequiredChecks(report(), [check("a")])).toEqual([]);
  });

  it.each(["PASS", "FAIL", "SKIPPED", "NOT_CONFIGURED"] as const)("ignores a %s result", (status) => {
    expect(unapprovedRequiredChecks(report(result("a", status)), [check("a")])).toEqual([]);
  });

  it("does not flag a check that is approved now, even though its historical result says NOT_APPROVED", () => {
    // Regression: a report never changes retroactively, so approved-since checks must be excluded
    // or they are re-flagged (and re-approved, duplicating the approval record) forever.
    expect(unapprovedRequiredChecks(report(result("a", "NOT_APPROVED")), [check("a", { approved: true })])).toEqual([]);
  });

  it("does not flag a check that is not required for READY", () => {
    expect(unapprovedRequiredChecks(report(result("a", "NOT_APPROVED")), [check("a", { requiredForReady: false })])).toEqual([]);
  });

  it("does not flag a result whose check is no longer configured", () => {
    expect(unapprovedRequiredChecks(report(result("gone", "NOT_APPROVED")), [check("a")])).toEqual([]);
  });

  it("returns only the still-waiting subset when some checks are already approved", () => {
    const pending = unapprovedRequiredChecks(report(result("a", "NOT_APPROVED"), result("b", "NOT_APPROVED")), [
      check("a", { approved: true }),
      check("b")
    ]);
    expect(pending.map((p) => p.check.id)).toEqual(["b"]);
  });

  it("does not mutate its inputs", () => {
    const r = Object.freeze(report(Object.freeze(result("a", "NOT_APPROVED"))));
    const checks = Object.freeze([Object.freeze(check("a"))]);
    expect(() => unapprovedRequiredChecks(r, checks)).not.toThrow();
  });
});
