// Web storage and IndexedDB of the page (permission category "storage").
import { z } from "zod";
import { DESTRUCTIVE, DESTRUCTIVE_IDEMPOTENT, limitParam, READ_PAGE, TabId, textResult, type ToolKit } from "../tool-kit.js";

export function registerStorageTools(kit: ToolKit): void {
  kit.define({
    name: "storage_get",
    title: "Read web storage",
    description: "Read all localStorage/sessionStorage entries of the page (values over 2000 chars truncated unless full:true).",
    category: "storage",
    inputSchema: {
      area: z.enum(["local", "session"]).optional().describe("Storage area (default local)"),
      full: z.boolean().optional().describe("true: return complete values (no 2000-char display truncation)"),
      tabId: TabId,
    },
    annotations: READ_PAGE,
    capHint: 'omit full:true (values over 2000 chars are cut), or write the complete storage and cookies to a file of your choice with session_state_save {"savePath": "<absolute .json path>"} (toolset sessions)',
    handler: async ({ area, full, tabId }, ctx) => {
      const r = await ctx.send("storage_get", { area: area ?? "local", full }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "storage_set",
    title: "Write web storage",
    description: "Write one storage entry (string values only).",
    category: "storage",
    inputSchema: {
      key: z.string().describe("Storage key"),
      value: z.string().describe("String value to store"),
      area: z.enum(["local", "session"]).optional().describe("Storage area (default local)"),
      tabId: TabId,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ key, value, area, tabId }, ctx) => {
      const r = await ctx.send(
        "storage_set",
        { key, value, area: area ?? "local" },
        tabId
      );
      return textResult(r);
    },
  });

  // ---------- IndexedDB ----------
  kit.define({
    name: "idb_list",
    title: "List IndexedDB databases",
    description: "List IndexedDB databases on the page (name + version).",
    category: "storage",
    inputSchema: { tabId: TabId },
    annotations: READ_PAGE,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("idb_list", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "idb_stores",
    title: "List IndexedDB stores",
    description: "List object stores of an IndexedDB database.",
    category: "storage",
    inputSchema: { db: z.string().describe("Database name (see idb_list)"), tabId: TabId },
    annotations: READ_PAGE,
    handler: async ({ db, tabId }, ctx) => {
      const r = await ctx.send("idb_stores", { db }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "idb_read",
    title: "Read IndexedDB rows",
    description: "Read IndexedDB rows (values truncated for AI readability).",
    category: "storage",
    inputSchema: {
      db: z.string().describe("Database name (see idb_list)"),
      store: z.string().describe("Object store name (see idb_stores)"),
      limit: limitParam(1000, "Max rows when reading all (default 50, max 1000)"),
      key: z.unknown().optional().describe("Omit to read all (up to limit)"),
      tabId: TabId,
    },
    annotations: READ_PAGE,
    capHint: "lower limit, or read one row by key",
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("idb_read", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "idb_count",
    title: "Count IndexedDB rows",
    description: "Count rows in an IndexedDB object store.",
    category: "storage",
    inputSchema: {
      db: z.string().describe("Database name (see idb_list)"),
      store: z.string().describe("Object store name (see idb_stores)"),
      tabId: TabId,
    },
    annotations: READ_PAGE,
    handler: async ({ db, store, tabId }, ctx) => {
      const r = await ctx.send("idb_count", { db, store }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "idb_put",
    title: "Write IndexedDB row",
    description: "Insert or update an IndexedDB row (returns the key).",
    category: "storage",
    inputSchema: {
      db: z.string().describe("Database name (see idb_list)"),
      store: z.string().describe("Object store name (see idb_stores)"),
      value: z.unknown().describe("Row value to store"),
      key: z.unknown().optional().describe("Key (omit for auto-keyed stores)"),
      tabId: TabId,
    },
    annotations: DESTRUCTIVE,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("idb_put", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "idb_delete",
    title: "Delete IndexedDB row",
    description: "Delete one IndexedDB row by key.",
    category: "storage",
    inputSchema: {
      db: z.string().describe("Database name (see idb_list)"),
      store: z.string().describe("Object store name (see idb_stores)"),
      key: z.unknown().describe("Key of the row to delete"),
      tabId: TabId,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("idb_delete", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "idb_clear",
    title: "Clear IndexedDB store",
    description: "Delete ALL rows in an IndexedDB object store (destructive).",
    category: "storage",
    inputSchema: {
      db: z.string().describe("Database name (see idb_list)"),
      store: z.string().describe("Object store name (see idb_stores)"),
      tabId: TabId,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ db, store, tabId }, ctx) => {
      const r = await ctx.send("idb_clear", { db, store }, tabId);
      return textResult(r);
    },
  });
}
