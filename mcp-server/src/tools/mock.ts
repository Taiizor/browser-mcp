// Request interception via the debugger Fetch domain (permission category "mock").
import { z } from "zod";
import { READ_ONLY, STATE_CHANGE, STATE_SET, TabId, textResult, type ToolKit } from "../tool-kit.js";

export function registerMockTools(kit: ToolKit): void {
  kit.define({
    name: "network_mock_start",
    title: "Start interception",
    description: "Attach the debugger and start intercepting requests. Spy mode: without routes, unmatched traffic passes through while bodies are recorded.",
    category: "mock",
    inputSchema: { tabId: TabId },
    annotations: STATE_SET,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("network_mock_start", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_mock_stop",
    title: "Stop interception",
    description: "End interception for the tab (the debugger detaches once no other override, e.g. throttling or geolocation, still needs it).",
    category: "mock",
    inputSchema: { tabId: TabId },
    annotations: STATE_SET,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("network_mock_stop", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_mock_route",
    title: "Add mock route",
    description: "Add a block/fulfill/delay rule for matching URLs. Requires network_mock_start first.",
    category: "mock",
    inputSchema: {
      pattern: z.string().describe("URL pattern, * wildcard (e.g. *ads* or https://api.example.com/*)"),
      action: z.enum(["block", "fulfill", "delay"]).describe("block: drop, fulfill: return a mock response, delay: hold then pass through"),
      status: z.number().int().min(100).max(599).optional().describe("HTTP code for fulfill (default 200)"),
      body: z.string().optional().describe("Body for fulfill"),
      contentType: z.string().optional().describe("Content-Type for fulfill (default application/json)"),
      delayMs: z.number().int().nonnegative().max(600000).optional().describe("Hold time in ms for delay"),
      headers: z
        .array(z.object({ name: z.string().describe("Header name"), value: z.string().describe("Header value") }))
        .optional()
        .describe("fulfill: added to the mock response headers. delay: merged into the original request headers (a same-name header is replaced, all others are kept)."),
      tabId: TabId,
    },
    annotations: STATE_CHANGE,
    handler: async (args, ctx) => {
      const { tabId, ...route } = args;
      const r = await ctx.send("network_mock_route", route, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_mock_list",
    title: "List mock routes",
    description: "List active mock routes and session state.",
    category: "mock",
    inputSchema: { tabId: TabId },
    annotations: READ_ONLY,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("network_mock_list", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_mock_remove",
    title: "Remove mock route",
    description: "Remove one mock route by ID.",
    category: "mock",
    inputSchema: { routeId: z.string().describe("Route ID from network_mock_list"), tabId: TabId },
    annotations: STATE_SET,
    handler: async ({ routeId, tabId }, ctx) => {
      const r = await ctx.send("network_mock_remove", { routeId }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_mock_clear",
    title: "Clear mock routes",
    description: "Remove all mock routes (keeps the interception session attached).",
    category: "mock",
    inputSchema: { tabId: TabId },
    annotations: STATE_SET,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("network_mock_clear", {}, tabId);
      return textResult(r);
    },
  });
}
