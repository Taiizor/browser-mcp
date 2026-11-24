// Tabs, windows, frames and tab groups (permission category "tabs").
import { z } from "zod";
import { DESTRUCTIVE, NAVIGATE, READ_ONLY, STATE_CHANGE, STATE_SET, TabId, textResult, type ToolKit } from "../tool-kit.js";

const TabGroupColor = z.enum([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

export function registerTabTools(kit: ToolKit): void {
  kit.define({
    name: "tab_list",
    title: "List tabs",
    description: "List all open tabs with id, title, URL and active state. Call first to discover tab IDs for other tools.",
    category: "tabs",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, ctx) => {
      const r = await ctx.send("tabs_list");
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_create",
    title: "Open tab",
    description: "Open a new tab, optionally at a URL. Use active:false to keep it in the background. Returns the new tab ID.",
    category: "tabs",
    inputSchema: {
      url: z.string().optional().describe("URL to open (default about:blank)"),
      active: z.boolean().optional().describe("Bring to front (default true)"),
    },
    annotations: NAVIGATE,
    handler: async ({ url, active }, ctx) => {
      const r = await ctx.send("tab_create", { url, active });
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_duplicate",
    title: "Duplicate tab",
    description: "Duplicate an existing tab into a new tab",
    category: "tabs",
    inputSchema: { tabId: TabId },
    annotations: NAVIGATE,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("tab_duplicate", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_close",
    title: "Close tab",
    description: "Close a tab (default: active). Closing the last tab of the last window quits the browser and needs the browser_close permission.",
    category: "tabs",
    inputSchema: { tabId: TabId },
    annotations: DESTRUCTIVE,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("tab_close", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_activate",
    title: "Activate tab",
    description: "Bring a tab to the front and focus its window.",
    category: "tabs",
    inputSchema: { tabId: z.number().int().describe("Tab ID to activate (see tab_list)") },
    annotations: STATE_SET,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("tab_activate", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_navigate",
    title: "Navigate tab",
    description: "Navigate a tab to a URL. Navigation destroys page context: re-query refs and re-wait afterwards.",
    category: "tabs",
    inputSchema: { url: z.string().describe("Target URL"), tabId: TabId },
    annotations: NAVIGATE,
    handler: async ({ url, tabId }, ctx) => {
      const r = await ctx.send("tab_navigate", { url }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_reload",
    title: "Reload tab",
    description: "Reload a tab (default: active). Page context resets: re-query refs afterwards.",
    category: "tabs",
    inputSchema: { tabId: TabId },
    annotations: NAVIGATE,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("tab_reload", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_back",
    title: "Go back",
    description: "Go back in tab history.",
    category: "tabs",
    inputSchema: { tabId: TabId },
    annotations: NAVIGATE,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("tab_back", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_forward",
    title: "Go forward",
    description: "Go forward in tab history.",
    category: "tabs",
    inputSchema: { tabId: TabId },
    annotations: NAVIGATE,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("tab_forward", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_pin",
    title: "Pin tab",
    description: "Pin/unpin a tab (omit to toggle).",
    category: "tabs",
    inputSchema: { pinned: z.boolean().optional().describe("Omit to toggle"), tabId: TabId },
    annotations: STATE_CHANGE,
    handler: async ({ pinned, tabId }, ctx) => {
      const r = await ctx.send("tab_pin", { pinned }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_mute",
    title: "Mute tab",
    description: "Mute/unmute a tab (omit to toggle).",
    category: "tabs",
    inputSchema: { muted: z.boolean().optional().describe("Omit to toggle"), tabId: TabId },
    annotations: STATE_CHANGE,
    handler: async ({ muted, tabId }, ctx) => {
      const r = await ctx.send("tab_mute", { muted }, tabId);
      return textResult(r);
    },
  });

  // ---------- windows ----------
  kit.define({
    name: "window_list",
    title: "List windows",
    description: "List windows with focus state and their tabs.",
    category: "tabs",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, ctx) => {
      const r = await ctx.send("window_list", {});
      return textResult(r);
    },
  });

  kit.define({
    name: "window_create",
    title: "Open window",
    description: "Open a new window, optionally at a URL.",
    category: "tabs",
    inputSchema: { url: z.string().optional().describe("Initial URL (omit for blank page)") },
    annotations: NAVIGATE,
    handler: async ({ url }, ctx) => {
      const r = await ctx.send("window_create", { url });
      return textResult(r);
    },
  });

  kit.define({
    name: "window_focus",
    title: "Focus window",
    description: "Focus a window by ID.",
    category: "tabs",
    inputSchema: { windowId: z.number().int().describe("Window ID from window_list") },
    annotations: STATE_SET,
    handler: async ({ windowId }, ctx) => {
      const r = await ctx.send("window_focus", { windowId });
      return textResult(r);
    },
  });

  // ---------- frames (iframe targeting) ----------
  kit.define({
    name: "frame_list",
    title: "List frames",
    description: "List frames/iframes of a tab as { frameId, parentFrameId, url } (frameId 0 = main frame). Use frameId or a URL substring with frame_focus.",
    category: "tabs",
    inputSchema: { tabId: TabId },
    annotations: READ_ONLY,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("frame_list", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "frame_focus",
    title: "Target frame",
    description: "Route later DOM/page commands for the tab to one frame, chosen by frameId (exact) or URL substring. Returns the resolved { frameId, url }. Cleared by frame_clear or a main-frame navigation.",
    category: "tabs",
    inputSchema: {
      frameId: z.number().int().nonnegative().optional().describe("Exact frameId from frame_list (preferred when several frames share a URL)"),
      frameUrl: z.string().optional().describe("URL substring of the target frame (from frame_list)"),
      tabId: TabId,
    },
    annotations: STATE_SET,
    handler: async ({ frameId, frameUrl, tabId }, ctx) => {
      if (frameId === undefined && !frameUrl) throw new Error("frame_focus needs frameId or frameUrl (see frame_list)");
      const r = await ctx.send("frame_focus", { frameId, frameUrl }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "frame_clear",
    title: "Clear frame target",
    description: "Clear iframe targeting (commands go to the main frame again).",
    category: "tabs",
    inputSchema: { tabId: TabId },
    annotations: STATE_SET,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("frame_clear", {}, tabId);
      return textResult(r);
    },
  });

  // ---------- tab groups ----------
  kit.define({
    name: "tab_group_create",
    title: "Create tab group",
    description: "Group one or more tabs together with an optional title, color, and collapsed state",
    category: "tabs",
    inputSchema: {
      tabIds: z.array(z.number().int()).describe("Array of tab IDs to add to the new group"),
      title: z.string().optional().describe("Group title / label"),
      color: TabGroupColor.optional().describe("Color of the tab group"),
      collapsed: z.boolean().optional().describe("Whether the tab group is collapsed"),
    },
    annotations: STATE_CHANGE,
    handler: async ({ tabIds, title, color, collapsed }, ctx) => {
      const r = await ctx.send("tab_group_create", { tabIds, title, color, collapsed });
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_group_list",
    title: "List tab groups",
    description: "List all tab groups with their member tabs, colors, and collapsed states",
    category: "tabs",
    inputSchema: {
      windowId: z.number().int().optional().describe("Filter by window ID"),
      title: z.string().optional().describe("Filter by group title (case-insensitive substring)"),
    },
    annotations: READ_ONLY,
    handler: async ({ windowId, title }, ctx) => {
      // chrome.tabGroups.query({title}) is an exact/pattern match, so the
      // substring filter is applied here on the full list.
      const r = (await ctx.send("tab_group_list", { windowId })) as { groups?: Array<{ title?: string }> } & Record<string, unknown>;
      if (title && Array.isArray(r?.groups)) {
        const needle = title.toLowerCase();
        return textResult({ ...r, groups: r.groups.filter((g) => String(g?.title ?? "").toLowerCase().includes(needle)) });
      }
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_group_update",
    title: "Update tab group",
    description: "Update a tab group's title, color, or collapsed state",
    category: "tabs",
    inputSchema: {
      groupId: z.number().int().describe("Group ID to update"),
      title: z.string().optional().describe("New title for the group"),
      color: TabGroupColor.optional().describe("New color for the group"),
      collapsed: z.boolean().optional().describe("Whether to collapse or expand the group"),
    },
    annotations: STATE_SET,
    handler: async ({ groupId, title, color, collapsed }, ctx) => {
      const r = await ctx.send("tab_group_update", { groupId, title, color, collapsed });
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_group_ungroup",
    title: "Ungroup tabs",
    description: "Remove tabs from their tab group",
    category: "tabs",
    inputSchema: {
      tabIds: z.array(z.number().int()).describe("Array of tab IDs to ungroup"),
    },
    annotations: STATE_SET,
    handler: async ({ tabIds }, ctx) => {
      const r = await ctx.send("tab_group_ungroup", { tabIds });
      return textResult(r);
    },
  });
}
