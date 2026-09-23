import { renderContextBlocks, type AgentInvocationRequest, type PromptFootprint } from "@ai-engine/core";

export interface ComposedUserPrompt {
  userPrompt: string;
  renderedContext: string;
}

/** Builds the exact user body once so adapters can both send and measure it without reconstructing it. */
export function composeUserPromptParts(request: AgentInvocationRequest): ComposedUserPrompt {
  const renderedContext = renderContextBlocks(request.context);
  return {
    userPrompt: [request.instructions.trim(), renderedContext].filter(Boolean).join("\n\n"),
    renderedContext
  };
}

/** Composes the task-specific instructions + trust-labelled context into one prompt body, for providers that take a single user turn. */
export function composeUserPrompt(request: AgentInvocationRequest): string {
  return composeUserPromptParts(request).userPrompt;
}

/**
 * Measures strings already constructed for a provider invocation. The caller supplies its
 * provider-specific final explicit material; this helper never stores or serializes it.
 */
export function promptFootprint(
  request: AgentInvocationRequest,
  composed: ComposedUserPrompt,
  explicitPrompt: string,
  systemPolicy: string,
  serializedOutputSchema?: string
): PromptFootprint {
  return {
    explicitPromptBytes: Buffer.byteLength(explicitPrompt, "utf8"),
    systemPolicyBytes: Buffer.byteLength(systemPolicy, "utf8"),
    userPromptBytes: Buffer.byteLength(composed.userPrompt, "utf8"),
    contextBytes: Buffer.byteLength(composed.renderedContext, "utf8"),
    contextBlockCount: request.context.length,
    resumedProviderSession: Boolean(request.resumeSessionId),
    ...(serializedOutputSchema === undefined ? {} : { structuredOutputSchemaBytes: Buffer.byteLength(serializedOutputSchema, "utf8") })
  };
}
