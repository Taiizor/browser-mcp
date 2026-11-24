// Synthetic page input: clicks, typing, forms, scrolling, uploads (permission category "interact").
import { z } from "zod";
import { PAGE_ACTION, PAGE_INTERACT, SelectorDesc, TabId, textResult, type ToolKit } from "../tool-kit.js";
import { checkUploadPaths, UPLOAD_MAX_FILES, uploadGuardOptions } from "../upload-guard.js";

export function registerInteractTools(kit: ToolKit): void {
  kit.define({
    name: "dom_click",
    title: "Click element",
    description: "Click an element (synthetic mouse events). For bot-protected sites use trusted_click instead (toolset trusted).",
    category: "interact",
    inputSchema: {
      selector: z.string().describe(SelectorDesc),
      tabId: TabId,
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)"),
      doubleClick: z.boolean().optional().describe("Double click (two clicks + dblclick)"),
    },
    annotations: PAGE_ACTION,
    handler: async ({ selector, tabId, button, doubleClick }, ctx) => {
      const r = await ctx.send("dom_click", { selector, button, doubleClick }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_type",
    title: "Type text",
    description:
      "Type into an input, textarea or contenteditable with real per-character key events (keydown/keypress/beforeinput/input/keyup; works with React/Vue controlled inputs). " +
      "Inserts at the caret if the element has focus, else at the end; keeps existing text unless clearFirst. Honours maxlength; single-line inputs skip newlines. " +
      "In a textarea or contenteditable a newline is a line break typed as Shift+Enter, so chat boxes do not send early; pressEnter (or keyboard_press) presses a real Enter. " +
      "Returns value (final value, first 200 chars; never for passwords) and a warning when keys were cancelled, clearFirst failed or maxlength cut text. " +
      "For many fields use dom_fill.",
    category: "interact",
    inputSchema: {
      selector: z.string().describe(SelectorDesc),
      text: z.string().describe("Text to type"),
      tabId: TabId,
      clearFirst: z.boolean().optional().describe("Clear existing content first (select-all + delete, with input events)"),
      pressEnter: z.boolean().optional().describe("Press Enter after typing"),
      delayMs: z.number().int().nonnegative().max(5000).optional().describe("Extra per-keystroke delay in ms (for bot-protected sites; default 0)"),
    },
    annotations: PAGE_ACTION,
    handler: async ({ selector, text, tabId, clearFirst, pressEnter, delayMs }, ctx) => {
      // Typing is per character even without a delay (key events, page
      // handlers): budget ~5 ms per character on top of the delay, which the
      // browser clamps to at least ~4 ms per nested timer.
      const timeoutMs = 30000 + text.length * (Math.max(delayMs ?? 0, delayMs ? 4 : 0) + 5);
      const r = await ctx.send(
        "dom_type",
        { selector, text, clearFirst, pressEnter, delayMs },
        tabId,
        timeoutMs
      );
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_fill",
    title: "Fill form fields",
    description: "Fill many form fields at once (selector -> value map). Faster than repeated dom_type.",
    category: "interact",
    inputSchema: {
      fields: z.record(z.string(), z.string()).describe("selector -> value map"),
      tabId: TabId,
      submit: z.boolean().optional().describe("Submit the enclosing form after filling"),
    },
    annotations: PAGE_ACTION,
    handler: async ({ fields, tabId, submit }, ctx) => {
      const r = await ctx.send("dom_fill", { fields, submit }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_select",
    title: "Select option",
    description: "Choose a native <select> option by value or visible label (fires input/change). For custom dropdowns click the trigger and the option.",
    category: "interact",
    inputSchema: {
      selector: z.string().describe(SelectorDesc),
      value: z.string().describe("Option value or visible label to select"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ selector, value, tabId }, ctx) => {
      const r = await ctx.send("dom_select", { selector, value }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_check",
    title: "Set checkbox",
    description: "Set or toggle a checkbox/radio/switch by clicking it like a user (click, input and change fire).",
    category: "interact",
    inputSchema: {
      selector: z.string().describe(SelectorDesc),
      checked: z.boolean().optional().describe("Omit to toggle"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ selector, checked, tabId }, ctx) => {
      const r = await ctx.send("dom_check", { selector, checked }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_hover",
    title: "Hover element",
    description: "Hover an element (opens menus/tooltips). For real pointer input use the trusted_* tools (toolset trusted).",
    category: "interact",
    inputSchema: { selector: z.string().describe(SelectorDesc), tabId: TabId },
    annotations: PAGE_INTERACT,
    handler: async ({ selector, tabId }, ctx) => {
      const r = await ctx.send("dom_hover", { selector }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_focus",
    title: "Focus element",
    description: "Focus an element (inputs, buttons).",
    category: "interact",
    inputSchema: { selector: z.string().describe(SelectorDesc), tabId: TabId },
    annotations: PAGE_INTERACT,
    handler: async ({ selector, tabId }, ctx) => {
      const r = await ctx.send("dom_focus", { selector }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_scroll",
    title: "Scroll",
    description: "Scroll the page or an element into view.",
    category: "interact",
    inputSchema: {
      selector: z.string().optional().describe("Omit to scroll the page"),
      direction: z.enum(["up", "down", "top", "bottom"]).optional().describe("Scroll direction (default down)"),
      pixels: z.number().int().positive().max(100000).optional().describe("Pixels per step (default 500)"),
      tabId: TabId,
    },
    annotations: PAGE_INTERACT,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      const r = await ctx.send("dom_scroll", payload, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_drag",
    title: "Drag and drop",
    description: "Drag from one element to another (synthetic mouse + HTML5 drag events).",
    category: "interact",
    inputSchema: {
      from: z.string().describe("Source selector/ref"),
      to: z.string().describe("Target selector/ref"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ from, to, tabId }, ctx) => {
      const r = await ctx.send("dom_drag", { from, to }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "keyboard_press",
    title: "Press key",
    description: "Dispatch synthetic key events to the focused element (combos like Ctrl+K are parsed; page key handlers see them). Only Enter, Tab, Space, Backspace/Delete, typing and select-all defaults are emulated; native shortcuts, clipboard, caret movement and scrolling need trusted_key (toolset trusted).",
    category: "interact",
    inputSchema: {
      key: z.string().describe("Enter, Tab, Escape, ArrowDown, a, A, Ctrl+C ..."),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ key, tabId }, ctx) => {
      const r = await ctx.send("keyboard_press", { key }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "dom_upload",
    title: "Upload files",
    description:
      "Upload local files into an <input type=file> via CDP (fires input/change). Paths must be absolute, regular files of at most 100 MiB, inside an allowed folder: " +
      "temp, ~/Downloads or the server's working directory (unless that is a drive root or holds the home folder), or the folders in BROWSER_MCP_UPLOAD_DIRS " +
      "(set by the user; \"*\" = any). Dot-segment paths (.ssh, .env ...), key/credential files (id_rsa*, *.pem, *.key, *.p12, *.pfx, *.ppk, *.kdbx, " +
      "credentials* ...) and this server's spilled output (browser-mcp-spill-* folders) are always refused; the error names the broken rule.",
    category: "interact",
    inputSchema: {
      selector: z.string().describe("selector/ref for the file input"),
      filePaths: z.array(z.string()).min(1).max(UPLOAD_MAX_FILES).describe("Absolute local file paths to upload"),
      tabId: TabId,
    },
    annotations: PAGE_ACTION,
    handler: async ({ selector, filePaths, tabId }, ctx) => {
      // Checked here, before anything reaches the browser; the canonical
      // (realpath) form is sent so no symlink is followed after the check.
      const files = checkUploadPaths(filePaths, uploadGuardOptions());
      const r = await ctx.send("dom_upload", { selector, filePaths: files }, tabId, 60000);
      return textResult(r);
    },
  });
}
