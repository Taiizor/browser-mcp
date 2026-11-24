// Browser downloads (permission category "downloads").
import { z } from "zod";
import { DESTRUCTIVE_IDEMPOTENT, limitParam, READ_ONLY, STATE_SET, textResult, type ToolKit } from "../tool-kit.js";

export function registerDownloadTools(kit: ToolKit): void {
  kit.define({
    name: "downloads_list",
    title: "List downloads",
    description: "List recent downloads with state, progress and errors.",
    category: "downloads",
    inputSchema: { limit: limitParam(1000, "Max entries (default 50)") },
    annotations: READ_ONLY,
    handler: async ({ limit }, ctx) => {
      const r = await ctx.send("downloads_list", { limit: limit ?? 50 });
      return textResult(r);
    },
  });

  kit.define({
    name: "downloads_pause",
    title: "Pause download",
    description: "Pause an in-progress download.",
    category: "downloads",
    inputSchema: { id: z.number().int().describe("Download ID from downloads_list") },
    annotations: STATE_SET,
    handler: async ({ id }, ctx) => {
      const r = await ctx.send("downloads_pause", { id });
      return textResult(r);
    },
  });

  kit.define({
    name: "downloads_resume",
    title: "Resume download",
    description: "Resume a paused download.",
    category: "downloads",
    inputSchema: { id: z.number().int().describe("Download ID from downloads_list") },
    annotations: STATE_SET,
    handler: async ({ id }, ctx) => {
      const r = await ctx.send("downloads_resume", { id });
      return textResult(r);
    },
  });

  kit.define({
    name: "downloads_cancel",
    title: "Cancel download",
    description: "Cancel an in-progress download.",
    category: "downloads",
    inputSchema: { id: z.number().int().describe("Download ID from downloads_list") },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ id }, ctx) => {
      const r = await ctx.send("downloads_cancel", { id });
      return textResult(r);
    },
  });

  kit.define({
    name: "downloads_erase",
    title: "Erase download from history",
    description: "Remove a finished download from history (keeps the file).",
    category: "downloads",
    inputSchema: { id: z.number().int().describe("Download ID from downloads_list") },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ id }, ctx) => {
      const r = await ctx.send("downloads_erase", { id });
      return textResult(r);
    },
  });
}
