// Trusted input via CDP Input.* (real OS-level events; permission category "trusted").
import { z } from "zod";
import { PAGE_ACTION, PAGE_INTERACT, SelectorDesc, TabId, textResult, type ToolKit } from "../tool-kit.js";

export function registerTrustedTools(kit: ToolKit): void {
  kit.define({
    name: "trusted_click",
    title: "Trusted click",
    description: "Real OS-level click via CDP Input (bypasses bot detection). Scrolls the target into view first (every selector form works, focused frame included).",
    category: "trusted",
    inputSchema: {
      selector: z.string().describe(SelectorDesc),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)"),
      doubleClick: z.boolean().optional().describe("Double-click instead of single click"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ selector, button, doubleClick, tabId }, ctx) => {
      const r = await ctx.send("trusted_click", { selector, button, doubleClick }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "trusted_type",
    title: "Trusted typing",
    description: "Real keystrokes via CDP Input.insertText (bypasses bot detection). The target is resolved and focused first.",
    category: "trusted",
    inputSchema: {
      selector: z.string().describe(SelectorDesc),
      text: z.string().describe("Text to type"),
      clearFirst: z.boolean().optional().describe("Clear existing content first"),
      pressEnter: z.boolean().optional().describe("Press Enter after typing"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ selector, text, clearFirst, pressEnter, tabId }, ctx) => {
      const r = await ctx.send("trusted_type", { selector, text, clearFirst, pressEnter }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "trusted_key",
    title: "Trusted key press",
    description: "Press a key as trusted CDP input (works without focus tricks).",
    category: "trusted",
    inputSchema: {
      key: z.string().describe("Enter, Tab, Escape, Backspace, Delete, Arrows, Home, End, PageUp/Down, or a single character"),
      modifiers: z.number().int().min(0).max(15).optional().describe("Bitmask: alt=1, ctrl=2, meta=4, shift=8"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ key, modifiers, tabId }, ctx) => {
      const r = await ctx.send("trusted_key", { key, modifiers }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "trusted_scroll",
    title: "Trusted scroll",
    description: "Trusted wheel scroll at a viewport point (defaults to center).",
    category: "trusted",
    inputSchema: {
      x: z.number().optional().describe("Omit for viewport center"),
      y: z.number().optional().describe("Omit for viewport center"),
      deltaX: z.number().optional().describe("Horizontal pixels (default 0)"),
      deltaY: z.number().optional().describe("Pixels, negative scrolls up (default 500)"),
      tabId: TabId,
    },
    annotations: PAGE_INTERACT,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("trusted_scroll", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "trusted_drag",
    title: "Trusted drag",
    description: "Trusted drag between two elements via CDP mouse events (bypasses bot detection).",
    category: "trusted",
    inputSchema: {
      from: z.string().describe("Source selector/ref"),
      to: z.string().describe("Target selector/ref"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ from, to, tabId }, ctx) => {
      const r = await ctx.send("trusted_drag", { from, to }, tabId);
      return textResult(r);
    },
  });
}
