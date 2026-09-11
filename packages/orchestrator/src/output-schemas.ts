import { z } from "zod";

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
  required: ["specification", "plan"]
};

export const ReviewFindingSchema = z.object({
  dimension: z.enum(["correctness", "architecture", "security", "invariants", "state_transitions", "testing", "maintainability"]),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  summary: z.string(),
  detail: z.string(),
  suggestedFix: z.string().optional()
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
          file: { type: "string" },
          line: { type: "number" },
          summary: { type: "string" },
          detail: { type: "string" },
          suggestedFix: { type: "string" }
        },
        required: ["dimension", "severity", "summary", "detail"]
      }
    }
  },
  required: ["verdict", "summary"]
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
