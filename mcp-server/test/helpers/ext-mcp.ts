// MCP server (createServer) + SDK client over an in-memory transport, for
// driving tools end to end against a bridge.

import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IBridge } from "../../src/bridge.js";
import { createServer } from "../../src/server.js";

export interface ToolResult {
  isError: boolean;
  /** Text parts, in order (non-text parts are left out). */
  texts: string[];
  /** All text parts joined with "\n". */
  text: string;
  /** JSON.parse of text part i (default 0). */
  json<T = any>(i?: number): T;
  raw: any;
}

export interface McpHandle {
  readonly client: Client;
  readonly server: ReturnType<typeof createServer>;
  /** Files written through createServer's saveOutput (over-cap outputs). */
  readonly saved: string[];
  /** createServer log lines. */
  readonly log: string[];
  /** notifications/tools/list_changed received so far. */
  listChanged(): number;
  call(name: string, args?: Record<string, unknown>, opts?: RequestOptions): Promise<ToolResult>;
  listNames(): Promise<string[]>;
  close(): Promise<void>;
}

export interface McpOptions {
  toolsets?: string[];
  maxOutputChars?: number;
  /** Directory for saved over-cap outputs. */
  saveDir: string;
}

export async function connectMcp(bridge: IBridge, opts: McpOptions): Promise<McpHandle> {
  const saved: string[] = [];
  const log: string[] = [];
  const server = createServer(bridge, {
    env: {},
    log: (l) => log.push(l),
    toolsets: opts.toolsets,
    maxOutputChars: opts.maxOutputChars,
    saveOutput: (data, baseName) => {
      const file = path.join(fs.mkdtempSync(path.join(opts.saveDir, "out-")), baseName);
      fs.writeFileSync(file, data);
      saved.push(file);
      return file;
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ext-integration", version: "0.0.0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged++;
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    saved,
    log,
    listChanged: () => listChanged,
    async call(name, args = {}, reqOpts) {
      const raw: any = await client.callTool({ name, arguments: args }, undefined, reqOpts);
      const texts: string[] = (raw.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text as string);
      return {
        isError: !!raw.isError,
        texts,
        text: texts.join("\n"),
        json: (i = 0) => JSON.parse(texts[i] ?? ""),
        raw,
      };
    },
    async listNames() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}
