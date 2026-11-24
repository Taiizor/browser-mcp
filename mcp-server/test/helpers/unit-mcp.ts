// createServer() + an MCP Client over InMemoryTransport, for unit tests.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { type CreateServerOptions, createServer, getToolKit, getToolRegistry } from "../../src/server.js";
import type { ToolEntry, ToolKit } from "../../src/tool-kit.js";
import { FakeBridge } from "./unit-fake-bridge.js";

export interface UnitServer {
  bridge: FakeBridge;
  server: McpServer;
  client: Client;
  kit: ToolKit;
  registry: ReadonlyMap<string, ToolEntry>;
  /** Lines createServer reported through opts.log. */
  logs: string[];
  /** notifications/tools/list_changed received by the client so far. */
  readonly listChanged: number;
  /** Names tools/list returns right now, sorted. */
  listNames(): Promise<string[]>;
  /** tools/call; protocol errors reject, tool errors resolve with isError. */
  call(name: string, args?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Lets debounced notifications and in-flight messages land. */
export function flush(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts createServer(bridge) with an isolated environment (env: {}, log
 * collected) and connects a client. Extra options override the defaults.
 */
export async function startUnitServer(
  opts: { bridge?: FakeBridge; server?: CreateServerOptions } = {}
): Promise<UnitServer> {
  const bridge = opts.bridge ?? new FakeBridge();
  const logs: string[] = [];
  const server = createServer(bridge, { env: {}, log: (line) => logs.push(line), ...opts.server });
  const kit = getToolKit(server);
  const registry = getToolRegistry(server);
  if (!kit || !registry) throw new Error("createServer did not register a ToolKit");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "unit-test", version: "0.0.0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged++;
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    bridge,
    server,
    client,
    kit,
    registry,
    logs,
    get listChanged() {
      return listChanged;
    },
    async listNames() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name).sort();
    },
    async call(name, args = {}, callOpts) {
      return (await client.callTool({ name, arguments: args }, undefined, callOpts)) as CallToolResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Text of every text part of a tool result. */
export function texts(result: CallToolResult): string[] {
  return result.content.flatMap((p) => (p.type === "text" ? [p.text] : []));
}

/** The first text part parsed as JSON. */
export function firstJson<T = any>(result: CallToolResult): T {
  const t = texts(result)[0];
  if (t === undefined) throw new Error("result has no text part");
  return JSON.parse(t) as T;
}
