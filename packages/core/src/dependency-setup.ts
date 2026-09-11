/**
 * Result of the one-time, best-effort attempt (at task-creation time) to make a freshly created
 * task worktree usable for verification/implementation when the target project needs installed
 * dependencies. See @ai-engine/orchestrator's prepareWorktreeDependencies() for the mechanism and
 * docs/architecture.md for why this exists (a `git worktree` only checks out tracked files, so
 * node_modules never exists in a new one).
 */
export type DependencySetupStatus = "installed" | "skipped" | "failed";

export interface DependencySetupResult {
  status: DependencySetupStatus;
  /** Which package manager convention was detected from a lockfile, if any (e.g. "npm", "yarn", "pnpm", "bun"). */
  packageManager?: string;
  /** The exact command that was (or would have been) run, for auditability. */
  command?: string;
  /** Why this was skipped, or the tail of the install's output if it failed. */
  reason?: string;
  durationMs: number;
}
