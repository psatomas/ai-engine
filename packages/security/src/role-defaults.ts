import type { ApprovalPolicy, SandboxLevel } from "@ai-engine/core";
import { WellKnownRole } from "@ai-engine/core";

export interface RoleSandboxDefault {
  sandbox: SandboxLevel;
  approval: ApprovalPolicy;
}

/**
 * Read-only roles (analysis/planning/review/verification) never get write
 * access, regardless of workflow automation settings — there is no
 * legitimate reason for a reviewer to modify the code it is reviewing.
 * Roles that must write (implementer, and the implementer filling FIXING)
 * get workspace_write, scoped to the task's dedicated git worktree by the
 * orchestrator, with approval left to "never" because the isolation
 * boundary *is* the worktree, not a human in the loop for every edit —
 * per the HUMAN_CONTROL model, implementation is automatic; architecture,
 * security review and final merge are the approval gates.
 */
export const ROLE_SANDBOX_DEFAULTS: Record<string, RoleSandboxDefault> = {
  [WellKnownRole.Architect]: { sandbox: "read_only", approval: "never" },
  [WellKnownRole.Implementer]: { sandbox: "workspace_write", approval: "never" },
  [WellKnownRole.Reviewer]: { sandbox: "read_only", approval: "never" },
  [WellKnownRole.SecurityReviewer]: { sandbox: "read_only", approval: "never" },
  [WellKnownRole.Verifier]: { sandbox: "read_only", approval: "never" }
};

export function sandboxDefaultsForRole(role: string): RoleSandboxDefault {
  return ROLE_SANDBOX_DEFAULTS[role] ?? { sandbox: "read_only", approval: "on_request" };
}
