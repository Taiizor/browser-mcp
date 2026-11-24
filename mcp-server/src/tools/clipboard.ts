// System clipboard (permission category "clipboard").
import { z } from "zod";
import { DESTRUCTIVE_IDEMPOTENT, READ_ONLY, textResult, type ToolKit } from "../tool-kit.js";

export function registerClipboardTools(kit: ToolKit): void {
  kit.define({
    name: "clipboard_read",
    title: "Read clipboard",
    description: "Read current text content from the system/browser clipboard",
    category: "clipboard",
    inputSchema: {},
    annotations: READ_ONLY,
    capHint: "clipboard text is never written to disk; raise BROWSER_MCP_MAX_OUTPUT_CHARS to read more of it inline",
    handler: async (_args, ctx) => {
      const r = await ctx.send("clipboard_read", {});
      return textResult(r);
    },
  });

  kit.define({
    name: "clipboard_write",
    title: "Write clipboard",
    description: "Copy text to the system/browser clipboard",
    category: "clipboard",
    inputSchema: {
      text: z.string().describe("Text string to write to clipboard"),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ text }, ctx) => {
      const r = await ctx.send("clipboard_write", { text });
      return textResult(r);
    },
  });
}
