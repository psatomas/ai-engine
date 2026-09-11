import { z } from "zod";

export const ProviderConfigSchema = z.object({
  /** Explicit override; otherwise resolved from PATH / known install locations. */
  binaryPath: z.string().optional(),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).default([])
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const RoleAssignmentConfigSchema = z.object({
  providerId: z.string(),
  model: z.string().optional()
});
export type RoleAssignmentConfig = z.infer<typeof RoleAssignmentConfigSchema>;

export const ApprovalGateConfigSchema = z.record(z.string(), z.boolean());

export const SecurityConfigSchema = z.object({
  /** Command substrings/regexes that are always refused, regardless of role or approval. */
  deniedCommandPatterns: z.array(z.string()).default(["rm -rf /", "git push --force", "git reset --hard", ":(){:|:&};:", "mkfs", "dd if="]),
  /** When true, agents may only read/write inside the task worktree + configured extra dirs. */
  restrictToWorkspace: z.boolean().default(true),
  network: z.enum(["allow", "deny", "provider_default"]).default("provider_default")
});
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const WorkflowLimitsConfigSchema = z.object({
  maxIterations: z.record(z.string(), z.number().int().positive()).default({ test_fix: 3, review_fix: 3, failure_retry: 3 }),
  defaultMaxIterations: z.number().int().positive().default(3),
  /** Wall-clock budget for a single agent invocation. Previously hardcoded at 20 minutes; now configurable. */
  roleTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(20 * 60 * 1000)
});

export const BudgetConfigSchema = z.object({
  maxCostUsdPerTask: z.number().positive().optional(),
  maxInvocationsPerRolePerTask: z.record(z.string(), z.number().int().positive()).default({})
});

export const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  toConsole: z.boolean().default(true)
});

export const GlobalConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  roles: z.record(z.string(), RoleAssignmentConfigSchema).default({
    architect: { providerId: "codex" },
    implementer: { providerId: "claude" },
    reviewer: { providerId: "codex" },
    security_reviewer: { providerId: "codex" },
    verifier: { providerId: "codex" }
  }),
  approvals: ApprovalGateConfigSchema.default({
    plan: true,
    security_review: true,
    final_merge: true
  }),
  security: SecurityConfigSchema.default({}),
  workflow: WorkflowLimitsConfigSchema.default({}),
  budgets: BudgetConfigSchema.default({}),
  logging: LoggingConfigSchema.default({})
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const VerificationCheckOverrideSchema = z.object({
  id: z.string(),
  description: z.string().default(""),
  command: z.string(),
  cwd: z.string().optional(),
  requiredForReady: z.boolean().default(true),
  timeoutMs: z.number().int().positive().optional()
});

export const ProjectConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  roles: z.record(z.string(), RoleAssignmentConfigSchema).default({}),
  verification: z
    .object({
      additionalChecks: z.array(VerificationCheckOverrideSchema).default([]),
      disable: z.array(z.string()).default([])
    })
    .default({}),
  review: z
    .object({
      focusAreas: z.array(z.string()).default([]),
      protocolSecurityReview: z.boolean().default(false)
    })
    .default({}),
  writeTaskSummaries: z.boolean().default(true)
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
