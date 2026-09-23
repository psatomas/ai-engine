import { describe, expect, it } from "vitest";
import type { AgentInvocationRequest } from "@ai-engine/core";
import { composeUserPromptParts, promptFootprint } from "./prompt.js";

function request(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    taskId: "t-1",
    role: "architect",
    systemPrompt: "System 🧭",
    instructions: "Inspect café",
    context: [],
    workingDirectory: "/worktree",
    sandbox: "read_only",
    approval: "never",
    ...overrides
  };
}

describe("promptFootprint", () => {
  it("measures the exact UTF-8 bytes of the final explicit provider prompt, including multibyte text", () => {
    const invocation = request();
    const composed = composeUserPromptParts(invocation);
    const explicit = `header\n${invocation.systemPrompt}\n${composed.userPrompt}`;
    const footprint = promptFootprint(invocation, composed, explicit, invocation.systemPrompt);

    expect(footprint).toEqual({
      explicitPromptBytes: Buffer.byteLength(explicit, "utf8"),
      systemPolicyBytes: Buffer.byteLength("System 🧭", "utf8"),
      userPromptBytes: Buffer.byteLength("Inspect café", "utf8"),
      contextBytes: 0,
      contextBlockCount: 0,
      resumedProviderSession: false
    });
    expect(footprint.userPromptBytes).toBeGreaterThan("Inspect café".length);
  });

  it("measures rendered context and schema when present without retaining their content", () => {
    const invocation = request({
      context: [{ trust: "repository_content", label: "docs/π.md", content: "Context 🐙" }],
      resumeSessionId: "provider-session",
      outputSchema: { type: "object", properties: { result: { type: "string" } } }
    });
    const composed = composeUserPromptParts(invocation);
    const schema = JSON.stringify(invocation.outputSchema);
    const footprint = promptFootprint(invocation, composed, composed.userPrompt, invocation.systemPrompt, schema);

    expect(footprint.contextBlockCount).toBe(1);
    expect(footprint.contextBytes).toBe(Buffer.byteLength(composed.renderedContext, "utf8"));
    expect(footprint.contextBytes).toBeGreaterThan(Buffer.byteLength("Context 🐙", "utf8"));
    expect(footprint.structuredOutputSchemaBytes).toBe(Buffer.byteLength(schema, "utf8"));
    expect(footprint.resumedProviderSession).toBe(true);
    expect(JSON.stringify(footprint)).not.toContain("Context 🐙");
    expect(JSON.stringify(footprint)).not.toContain("docs/π.md");
  });
});
