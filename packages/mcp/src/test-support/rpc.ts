import { InMemoryTransport, type McpServer, type JSONRPCMessage } from "@modelcontextprotocol/server";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcResponse {
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

export interface RpcClient {
  request(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  callTool(name: string, args?: Record<string, unknown>): Promise<RpcResponse>;
  close(): Promise<void>;
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test-client", version: "0.0.0" }
};

/** A raw JSON-RPC client over `send`, with the initialize handshake already done. */
async function handshake(
  send: (message: JSONRPCMessage) => void,
  waiters: Map<number, (r: RpcResponse) => void>
): Promise<(m: string, p?: Record<string, unknown>) => Promise<RpcResponse>> {
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>): Promise<RpcResponse> =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } as JSONRPCMessage);
    });
  const init = await request("initialize", INITIALIZE);
  if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  return request;
}

/** Connects a real `McpServer` to an in-process client, speaking the actual MCP wire protocol. */
export async function connectInProcess(server: McpServer): Promise<RpcClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiters = new Map<number, (r: RpcResponse) => void>();
  clientSide.onmessage = (message) => {
    const m = message as { id?: number; result?: RpcResponse["result"]; error?: RpcResponse["error"] };
    if (typeof m.id === "number" && ("result" in m || "error" in m)) {
      waiters.get(m.id)?.({ result: m.result, error: m.error });
      waiters.delete(m.id);
    }
  };
  await server.connect(serverSide);
  await clientSide.start();
  const request = await handshake((message) => void clientSide.send(message), waiters);
  return {
    request,
    callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    close: async () => {
      await clientSide.close();
    }
  };
}

/** Speaks newline-delimited JSON-RPC to a child process's stdio. Any non-JSON stdout line fails the test. */
export async function connectStdio(
  child: ChildProcessWithoutNullStreams
): Promise<RpcClient & { stdoutLines: string[]; exit: Promise<number | null> }> {
  const waiters = new Map<number, (r: RpcResponse) => void>();
  const stdoutLines: string[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      stdoutLines.push(line);
      const m = JSON.parse(line) as { id?: number; result?: RpcResponse["result"]; error?: RpcResponse["error"] };
      if (typeof m.id === "number" && ("result" in m || "error" in m)) {
        waiters.get(m.id)?.({ result: m.result, error: m.error });
        waiters.delete(m.id);
      }
    }
  });
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const request = await handshake((message) => void child.stdin.write(JSON.stringify(message) + "\n"), waiters);
  return {
    request,
    stdoutLines,
    exit,
    callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    close: async () => {
      child.stdin.end();
      await exit;
    }
  };
}
