import { z } from "zod";

/**
 * BUG FOUND BY REAL END-TO-END EXECUTION (not a mock/unit test): the first live run of the
 * architect role against the actual authenticated Codex CLI failed outright —
 * `codex exec --output-schema` forwards this schema to OpenAI's Structured Outputs API in strict
 * mode, which rejects any `type: "object"` node that doesn't explicitly set
 * `additionalProperties: false`, and requires every property to appear in `required` (optional
 * fields must be expressed as a nullable type union, e.g. `["string", "null"]`, not simply
 * omitted). Neither of these hand-written schemas had ever been exercised against a real,
 * authenticated Codex invocation before, so this was never caught by mocked-provider tests. The
 * corresponding zod schemas below use `.nullish()` (accepts `null` or `undefined`) transformed
 * back to `undefined`, since a strict-mode-compliant model response sends explicit `null` for an
 * absent optional field rather than omitting the key.
 */
export const ArchitectOutputSchema = z.object({
  specification: z.string(),
  plan: z.string(),
  risks: z.array(z.string()).default([])
});
export type ArchitectOutput = z.infer<typeof ArchitectOutputSchema>;

export const ArchitectJsonSchema = {
  type: "object",
  properties: {
    specification: { type: "string" },
    plan: { type: "string" },
    risks: { type: "array", items: { type: "string" } }
  },
  required: ["specification", "plan", "risks"],
  additionalProperties: false
};

export const ReviewFindingSchema = z.object({
  dimension: z.enum(["correctness", "architecture", "security", "invariants", "state_transitions", "testing", "maintainability"]),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  file: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  line: z
    .number()
    .int()
    .nullish()
    .transform((v) => v ?? undefined),
  summary: z.string(),
  detail: z.string(),
  suggestedFix: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined)
});

export const ReviewOutputSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  summary: z.string(),
  findings: z.array(ReviewFindingSchema).default([])
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const ReviewJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "changes_requested"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          file: { type: ["string", "null"] },
          line: { type: ["number", "null"] },
          summary: { type: "string" },
          detail: { type: "string" },
          suggestedFix: { type: ["string", "null"] }
        },
        required: ["dimension", "severity", "file", "line", "summary", "detail", "suggestedFix"],
        additionalProperties: false
      }
    }
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false
};

/**
 * Structured output from providers is best-effort (a model can still return
 * malformed JSON even against a schema). Callers must handle `undefined`
 * rather than assume compliance.
 */
export function tryParseArchitectOutput(structured: unknown, fallbackText: string | undefined): ArchitectOutput | undefined {
  const parsed = ArchitectOutputSchema.safeParse(structured);
  if (parsed.success) return parsed.data;
  if (fallbackText) {
    try {
      return ArchitectOutputSchema.parse(JSON.parse(fallbackText));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function tryParseReviewOutput(structured: unknown, fallbackText: string | undefined): ReviewOutput | undefined {
  const parsed = ReviewOutputSchema.safeParse(structured);
  if (parsed.success) return parsed.data;
  if (fallbackText) {
    try {
      return ReviewOutputSchema.parse(JSON.parse(fallbackText));
    } catch {
      return undefined;
    }
  }
  return undefined;
}
