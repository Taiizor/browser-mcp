// Network observation and conditions (permission category "network").
import { z } from "zod";
import {
  assertNotKnownDisabled,
  bufferFallbackWarning,
  DESTRUCTIVE_IDEMPOTENT,
  errMessage,
  isPermissionError,
  limitParam,
  READ_ONLY,
  READ_PAGE,
  STATE_SET,
  TabId,
  TabIdAllTabs,
  textResult,
  type ToolKit,
} from "../tool-kit.js";

export function registerNetworkTools(kit: ToolKit): void {
  kit.define({
    name: "network_requests",
    title: "List network requests",
    description: "List captured HTTP network requests with optional filters. Falls back to this server's local event buffer, with a warning, when the extension is unreachable.",
    category: "network",
    inputSchema: {
      filter: z.string().optional().describe("URL substring filter"),
      type: z.string().optional().describe("Resource type: document, xhr, fetch, image, script..."),
      failedOnly: z.boolean().optional().describe("Only return failed requests (status >= 400 or network error)"),
      minStatus: z.number().int().min(100).max(599).optional().describe("Minimum HTTP status code (e.g. 400 for errors)"),
      limit: limitParam(5000, "Max number of requests to return (default 200)"),
      tabId: TabIdAllTabs,
    },
    annotations: READ_ONLY,
    handler: async ({ filter, type, failedOnly, minStatus, limit, tabId }, ctx) => {
      try {
        const r = await ctx.send("network_requests", { filter, type, failedOnly, minStatus, limit, tabId });
        return textResult(r);
      } catch (e) {
        if (isPermissionError(e)) throw e;
        assertNotKnownDisabled(ctx.bridge, "network_requests");
        let arr = ctx.bridge.networkEvents as Array<Record<string, unknown>>;
        if (tabId !== undefined) arr = arr.filter((x) => x?.tabId === tabId);
        if (filter) arr = arr.filter((x) => String(x?.url ?? "").includes(filter));
        if (type) arr = arr.filter((x) => x?.type === type);
        if (failedOnly) arr = arr.filter((x) => (typeof x?.statusCode === "number" && x.statusCode >= 400) || x?.phase === "error");
        if (minStatus !== undefined) arr = arr.filter((x) => typeof x?.statusCode === "number" && x.statusCode >= minStatus);
        arr = arr.slice(-(limit ?? 200));
        return textResult({ source: "bridge-buffer", warning: bufferFallbackWarning(e), count: arr.length, requests: arr });
      }
    },
  });

  kit.define({
    name: "network_clear",
    title: "Clear network log",
    description: "Clear captured network logs (extension + local buffer).",
    category: "network",
    inputSchema: {},
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async (_args, ctx) => {
      try {
        const r = await ctx.send("network_clear", {});
        ctx.bridge.networkEvents.length = 0;
        return textResult(r);
      } catch (e) {
        // Mirror console_clear: a disabled switch must surface, not report ok.
        if (isPermissionError(e)) throw e;
        assertNotKnownDisabled(ctx.bridge, "network_clear");
        ctx.bridge.networkEvents.length = 0;
        return textResult({
          ok: true,
          source: "bridge-buffer",
          warning: `Extension unreachable (${errMessage(e)}): only this server's local buffer was cleared.`,
        });
      }
    },
  });

  kit.define({
    name: "network_response_body",
    title: "Fetch response body",
    description: "Re-fetch a recorded GET request's body in page context (webRequest exposes no bodies; the request is sent again, non-GET entries are refused). For exact bodies use network_mock_start + network_bodies. Needs a requestId from network_requests.",
    category: "network",
    inputSchema: {
      requestId: z.string().describe("requestId from network_requests"),
      tabId: TabId,
    },
    annotations: READ_PAGE,
    handler: async ({ requestId, tabId }, ctx) => {
      const r = await ctx.send("network_response_body", { requestId }, tabId, 30000);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_throttle",
    title: "Throttle network",
    description: "Emulate network conditions (slow 3G, fast 3G, offline, custom) via CDP. The override stays active (debugger kept attached) until profile 'online' clears it.",
    category: "network",
    inputSchema: {
      profile: z.enum(["online", "slow3g", "fast3g", "offline", "custom"]).describe("Throttling profile ('online' removes throttling)"),
      latency: z.number().nonnegative().max(600000).optional().describe("Custom latency in ms (only for profile: custom)"),
      downloadThroughput: z.number().min(-1).optional().describe("Custom download throughput in bytes/s, -1 = unlimited (only for profile: custom)"),
      uploadThroughput: z.number().min(-1).optional().describe("Custom upload throughput in bytes/s, -1 = unlimited (only for profile: custom)"),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async ({ profile, latency, downloadThroughput, uploadThroughput, tabId }, ctx) => {
      const r = await ctx.send("network_throttle", { profile, latency, downloadThroughput, uploadThroughput }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_set_headers",
    title: "Set request headers",
    description: "Set extra HTTP request headers attached to all requests in the tab. They stay active (debugger kept attached) until cleared by passing an empty object {}.",
    category: "network",
    inputSchema: {
      headers: z.record(z.string(), z.string()).describe("Key-value header dictionary (e.g. Authorization, User-Agent); {} clears"),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async ({ headers, tabId }, ctx) => {
      const r = await ctx.send("network_set_headers", { headers }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "network_bodies",
    title: "Captured request bodies",
    description: "Spy-captured request/response bodies (POST data, response snippets). Requires network_mock_start first (no routes needed).",
    category: "network",
    inputSchema: {
      filter: z.string().optional().describe("URL substring filter"),
      kind: z.enum(["request", "response"]).optional().describe("Only requests (with POST bodies) or only responses"),
      limit: limitParam(1000, "Max entries (default 50)"),
      tabId: TabId,
    },
    annotations: READ_ONLY,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("network_bodies", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "har_export",
    title: "Export HAR",
    description: "Export captured traffic for a tab as HAR 1.2 (headers included, no bodies).",
    category: "network",
    inputSchema: { tabId: TabId, limit: limitParam(5000, "Max entries (default 300)") },
    annotations: READ_ONLY,
    handler: async ({ tabId, limit }, ctx) => {
      const r = await ctx.send("har_export", { limit: limit ?? 300 }, tabId, 60000);
      return textResult(r);
    },
  });
}
