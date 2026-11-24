// JS dialog handling (permission category "dialogs").
import { z } from "zod";
import { DESTRUCTIVE_IDEMPOTENT, limitParam, READ_ONLY, STATE_SET, textResult, type ToolKit } from "../tool-kit.js";

export function registerDialogTools(kit: ToolKit): void {
  kit.define({
    name: "dialog_policy",
    title: "Set dialog policy",
    description: "Set auto-handling for JS dialogs: alert is swallowed, confirm/prompt auto-answered.",
    category: "dialogs",
    inputSchema: {
      accept: z.boolean().optional().describe("Auto-accept confirm/prompt"),
      promptText: z.string().optional().describe("Response text for prompt"),
      blockUnload: z.boolean().optional().describe("true: suppress beforeunload"),
    },
    annotations: STATE_SET,
    handler: async (args, ctx) => {
      const r = await ctx.send("dialog_policy", args);
      return textResult(r);
    },
  });

  kit.define({
    name: "dialog_get",
    title: "List dialogs",
    description: "List captured dialogs (alert/confirm/prompt) with messages and responses. Capture is async: poll briefly after triggering.",
    category: "dialogs",
    inputSchema: { limit: limitParam(1000, "Max entries (default 50)") },
    annotations: READ_ONLY,
    handler: async ({ limit }, ctx) => {
      const r = await ctx.send("dialog_get", { limit: limit ?? 50 });
      return textResult(r);
    },
  });

  kit.define({
    name: "dialog_clear",
    title: "Clear dialog history",
    description: "Clear captured dialog history.",
    category: "dialogs",
    inputSchema: {},
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async (_args, ctx) => {
      const r = await ctx.send("dialog_clear", {});
      return textResult(r);
    },
  });
}
