// Browser history and site permissions (permission category "system").
import { z } from "zod";
import { DESTRUCTIVE_IDEMPOTENT, limitParam, READ_ONLY, STATE_SET, TabId, textResult, type ToolKit } from "../tool-kit.js";

export function registerSystemTools(kit: ToolKit): void {
  kit.define({
    name: "history_search",
    title: "Search history",
    description: "Search browser history by query text (all of history by default, not only the last 24 hours).",
    category: "system",
    inputSchema: {
      query: z.string().describe("Search text (empty string matches every page)"),
      limit: limitParam(10000, "Max results (default 20)"),
      maxResults: limitParam(10000, "Alias of limit (Chrome API name); wins when both are given"),
      startTime: z
        .number()
        .nonnegative()
        .optional()
        .describe("Only visits at or after this time (ms since epoch). Default 0 = all history (Chrome's own default would be the last 24 hours)."),
      endTime: z.number().nonnegative().optional().describe("Only visits before this time (ms since epoch). Default: now."),
    },
    annotations: READ_ONLY,
    handler: async ({ query, limit, maxResults, startTime, endTime }, ctx) => {
      const max = maxResults ?? limit ?? 20;
      if (endTime !== undefined && endTime < (startTime ?? 0)) {
        throw new Error(`endTime (${endTime}) is before startTime (${startTime ?? 0})`);
      }
      const r = await ctx.send("history_search", { query, limit: max, maxResults: max, startTime: startTime ?? 0, endTime });
      return textResult(r);
    },
  });

  kit.define({
    name: "history_delete",
    title: "Delete history",
    description: "Delete a URL, all history, or a time range from the browser history",
    category: "system",
    inputSchema: {
      url: z.string().optional().describe("URL to remove from history"),
      all: z.boolean().optional().describe("Set to true to clear all browser history"),
      startTime: z.number().nonnegative().optional().describe("Start time (ms since epoch) for range deletion"),
      endTime: z.number().nonnegative().optional().describe("End time (ms since epoch) for range deletion"),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ url, all, startTime, endTime }, ctx) => {
      const r = await ctx.send("history_delete", { url, all, startTime, endTime });
      return textResult(r);
    },
  });

  kit.define({
    name: "permissions_grant",
    title: "Set site permission",
    description: "Allow/block a site permission (geolocation, camera...) for an origin via content settings.",
    category: "system",
    inputSchema: {
      permission: z.enum(["geolocation", "notifications", "camera", "microphone", "popups", "javascript", "images", "cookies"]).describe("Permission type"),
      setting: z.enum(["allow", "block", "ask"]).optional().describe("Default allow"),
      origin: z.string().optional().describe("Omit for the active tab's origin (e.g. https://example.com)"),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("permissions_grant", payload, tabId);
      return textResult(r);
    },
  });
}
