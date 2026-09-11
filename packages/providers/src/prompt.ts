import { renderContextBlocks, type AgentInvocationRequest } from "@ai-engine/core";

/** Composes the task-specific instructions + trust-labelled context into one prompt body, for providers that take a single user turn. */
export function composeUserPrompt(request: AgentInvocationRequest): string {
  const parts = [request.instructions.trim()];
  const context = renderContextBlocks(request.context);
  if (context) parts.push(context);
  return parts.join("\n\n");
}
