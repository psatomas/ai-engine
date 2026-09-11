# Changelog

## 0.1.0 — initial validated release

This is AI Engine's first release. It documents the system **as it exists and has been validated**,
not a roadmap. See [README.md](./README.md) for the full map and [docs/](./docs) for design
rationale; this entry is a scope summary for release purposes.

### Validated workflow

The full task lifecycle, driven by either the `ai` CLI or the VS Code extension (both thin wrappers
over the same orchestration engine):

- **Task creation** (`ai task`) — a persisted `TaskRecord`, a dedicated git worktree, and a dedicated
  branch per task; the primary checkout is never touched.
- **Dependency bootstrap** — a one-time, controlled preparation of a fresh task worktree
  (`prepareWorktreeDependencies`): detects the package manager from its lockfile, runs only the
  frozen/reproducible install variant (`npm ci`, `--frozen-lockfile`, …), refuses to run unless
  `node_modules` is confirmed `.gitignore`-covered, and is checked against the security policy's
  command deny-list.
- **Codex as architect** — analysis + specification + plan, gated behind human plan approval
  (`AWAITING_APPROVAL`).
- **Claude Code as implementer** — real headless implementation, including real Bash execution
  (build/test/lint) under the `"auto"` permission mode.
- **Verification** — npm-script / Foundry / slither check discovery (only checks that actually exist
  in the repository), reporting structured `PASS | FAIL | SKIPPED | NOT_CONFIGURED`, with
  `requiredForReady` checks gating progress; repository-configured verification commands require
  explicit, hash-pinned human approval before they can ever run.
- **Codex as reviewer + security reviewer** — independent structured review findings, each with a
  dimension, severity, and status.
- **Claude Code as fixer** — addresses open findings; every finding it touches is marked
  `fix_attempted`, never `fixed` — this system never claims verified correctness for a fix it hasn't
  independently re-checked. A finding is only ever resolved by a **subsequent, independent** review
  round finding nothing wrong, never by relabeling the old finding.
- **A second independent review/security-review round**, gated behind a human `security_review`
  approval.
- **Final verification** (Codex) and the terminal `READY` state.
- **Full task-state history** — every transition recorded, iteration-capped loops (`test_fix`,
  `review_fix`, `failure_retry`) that escalate to `BLOCKED` instead of spinning, and
  pause/resume/cancel/retry from every applicable state.
- **Git/task safety** — baseline commit capture, structured diff with suspicious-path detection,
  cross-process task locking (regression-tested against 8 real concurrent OS processes), and
  detection of the worktree diverging from persisted task state after a crash.

### Validated twice, for real

This exact pipeline — Codex as architect/reviewer/security_reviewer/verifier, Claude Code as
implementer/fixer, no mocking — has now completed **two** independent, real, authenticated
end-to-end runs against two different external repositories, each reaching `READY`:

1. **First run** (see [docs/providers.md](./docs/providers.md)) found and fixed three genuine,
   previously-unexercised defects: a Codex Structured-Outputs strict-schema incompatibility, a
   `codex exec resume` flag mismatch, and a fresh worktree's missing dependencies — and separately
   surfaced the `acceptEdits` → `auto` permission-mode fix and the `fix_attempted` honesty fix.
2. **Second run** re-validated all of the above under a fresh task against a different target
   repository: dependency bootstrap, the `"auto"` permission mode's real Bash execution, and a
   genuine (unforced) reviewer-found bug carried through a full fix → independent re-review cycle.
   No further AI Engine defects were found.

140 automated tests pass (`npm test`), alongside these two real runs — see README §12 for the full
account of what each covers, including two independent security audits.

### Known limitations

Documented in full in [README §13](./README.md#13-known-limitations); summarized:

- No automatic worktree/branch garbage collection.
- No independent network sandboxing (relies on each provider's own controls).
- No true per-tool-call human approval mid-invocation (gate granularity is plan/security_review, not
  per shell command).
- Codex has no structural system/user prompt channel to separate.
- No real `@vscode/test-electron` harness for the VS Code extension.
- The verification-command approval UI doesn't display a check's `cwd`.
- Only Codex and Claude Code are implemented as providers today.

### Explicitly out of scope for this release

- **Not a claim of general production readiness.** Two real end-to-end runs demonstrate the pipeline
  works correctly end-to-end against real, authenticated providers — that is not the same as
  exhaustive real-world coverage across arbitrary repositories, languages, and failure modes.
- **No hosted or multi-user service, no team features, no "v2/platform" direction.** This is a
  single-machine, single-user local control plane, by design.
- **No automated release/publish pipeline.** Versioning is manual; there is no CI job that tags or
  publishes packages.
