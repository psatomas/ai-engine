import { createRequire } from "node:module";
import type { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { TOOLS, resolveDeps, runGuarded, type TaskMcpDeps, type ToolDefinition } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

function register(server: McpServer, deps: ReturnType<typeof resolveDeps>, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Both tools only read persisted task state: nothing is written, deleted, or reached over a network.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (args: unknown) => runGuarded(deps, tool, args as z.infer<z.ZodObject>)
  );
}

/**
 * The read-only AI Engine MCP server: `list_tasks` and `get_task`, and nothing else. Every tool is
 * registered here through the same `runGuarded` path, so the nested-delegation guard cannot be
 * skipped by adding a tool. Transport is the caller's choice; `bin.ts` serves it over stdio.
 */
export function createTaskMcpServer(overrides: TaskMcpDeps = {}): McpServer {
  const deps = resolveDeps(overrides);
  const server = new McpServer({ name: "ai-engine", version }, { capabilities: { tools: {} } });
  for (const tool of TOOLS) register(server, deps, tool as unknown as ToolDefinition);
  return server;
}
