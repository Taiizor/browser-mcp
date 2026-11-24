// Browser bookmarks (permission category "bookmarks").
import { z } from "zod";
import { DESTRUCTIVE_IDEMPOTENT, READ_ONLY, STATE_CHANGE, textResult, type ToolKit } from "../tool-kit.js";

export function registerBookmarkTools(kit: ToolKit): void {
  kit.define({
    name: "bookmarks_search",
    title: "Search bookmarks",
    description: "Search bookmarks by title/URL.",
    category: "bookmarks",
    inputSchema: { query: z.string().describe("Search text") },
    annotations: READ_ONLY,
    handler: async ({ query }, ctx) => {
      const r = await ctx.send("bookmarks_search", { query });
      return textResult(r);
    },
  });

  kit.define({
    name: "bookmarks_list",
    title: "List bookmarks",
    description: "List bookmark children of a folder.",
    category: "bookmarks",
    inputSchema: { parentId: z.string().optional().describe("Omit for the bookmarks bar") },
    annotations: READ_ONLY,
    handler: async ({ parentId }, ctx) => {
      const r = await ctx.send("bookmarks_list", { parentId });
      return textResult(r);
    },
  });

  kit.define({
    name: "bookmarks_add",
    title: "Add bookmark",
    description: "Create a bookmark (returns its ID).",
    category: "bookmarks",
    inputSchema: {
      title: z.string().describe("Bookmark title"),
      url: z.string().describe("Bookmark URL"),
      parentId: z.string().optional().describe("Parent folder ID (omit for default location)"),
    },
    annotations: STATE_CHANGE,
    handler: async (args, ctx) => {
      const r = await ctx.send("bookmarks_add", args);
      return textResult(r);
    },
  });

  kit.define({
    name: "bookmarks_remove",
    title: "Remove bookmark",
    description: "Delete a bookmark by ID.",
    category: "bookmarks",
    inputSchema: { id: z.string().describe("Bookmark ID") },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ id }, ctx) => {
      const r = await ctx.send("bookmarks_remove", { id });
      return textResult(r);
    },
  });
}
