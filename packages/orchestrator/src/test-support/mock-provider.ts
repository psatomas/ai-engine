import type { AgentInvocationRequest, AgentResult, AgentRun, Capability, ProviderAdapter, ProviderAvailability } from "@ai-engine/core";

/**
 * A deterministic, in-memory ProviderAdapter used only by orchestrator
 * tests. It never spawns a process, which is what lets the orchestrator's
 * workflow-wiring be tested without a network call or a CLI installation.
 * Real provider behavior is covered by @ai-engine/providers' own tests.
 */
export class MockProvider implements ProviderAdapter {
  public readonly displayName = "Mock Provider";
  public readonly invocations: Array<{ role: string; request: AgentInvocationRequest }> = [];

  constructor(
    public readonly id: string,
    private readonly responder: (request: AgentInvocationRequest, callIndex: number) => AgentResult | Promise<AgentResult>
  ) {}

  capabilities(): Capability[] {
    return [
      "analyze",
      "plan",
      "implement",
      "review",
      "shell_execution",
      "file_modification",
      "streaming",
      "cancellation",
      "status",
      "resume",
      "structured_output"
    ];
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    return { available: true, authenticated: true, version: "mock" };
  }

  invoke(request: AgentInvocationRequest): AgentRun {
    this.invocations.push({ role: request.role, request });
    const callIndex = this.invocations.length - 1;
    const resultPromise = Promise.resolve(this.responder(request, callIndex));
    async function* events() {
      yield { type: "lifecycle" as const, phase: "started" as const, at: new Date().toISOString() };
      const response = await resultPromise;
      if (response.finalMessage) yield { type: "message" as const, channel: "assistant" as const, text: response.finalMessage };
      yield {
        type: "lifecycle" as const,
        phase: response.status === "success" ? ("completed" as const) : ("failed" as const),
        at: new Date().toISOString()
      };
    }
    return { events: events(), result: resultPromise, cancel: () => undefined };
  }
}
