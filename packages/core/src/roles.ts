/**
 * Agent roles are provider-independent job descriptions. The workflow engine
 * only ever asks for a role ("who should architect this?"); which provider
 * actually fills that role is a configuration concern resolved by the
 * RoleRegistry at runtime. New roles can be added without touching the
 * workflow engine or any provider adapter.
 */
export type AgentRole = string;

export const WellKnownRole = {
  Architect: "architect",
  Implementer: "implementer",
  Reviewer: "reviewer",
  SecurityReviewer: "security_reviewer",
  Verifier: "verifier"
} as const;

/**
 * Capabilities a provider adapter can advertise. The workflow/orchestrator
 * layer checks these before assigning a role to a provider so we fail fast
 * ("gemini adapter has no shell_execution capability yet") instead of
 * pretending unsupported functionality exists.
 */
export type Capability =
  | "analyze"
  | "plan"
  | "implement"
  | "review"
  | "shell_execution"
  | "file_modification"
  | "streaming"
  | "cancellation"
  | "status"
  | "resume"
  | "structured_output";

/** Capabilities the default workflow requires from whichever provider fills each role. */
export const ROLE_REQUIRED_CAPABILITIES: Record<string, Capability[]> = {
  [WellKnownRole.Architect]: ["analyze", "plan", "streaming"],
  [WellKnownRole.Implementer]: ["implement", "file_modification", "shell_execution", "streaming"],
  [WellKnownRole.Reviewer]: ["review", "structured_output", "streaming"],
  [WellKnownRole.SecurityReviewer]: ["review", "structured_output", "streaming"],
  [WellKnownRole.Verifier]: ["review", "structured_output"]
};
