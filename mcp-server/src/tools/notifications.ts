// Native desktop notifications (permission category "notifications").
import { z } from "zod";
import { STATE_CHANGE, STATE_SET, textResult, type ToolKit } from "../tool-kit.js";

export function registerNotificationTools(kit: ToolKit): void {
  kit.define({
    name: "notification_create",
    title: "Show notification",
    description: "Display a native desktop notification to the user",
    category: "notifications",
    inputSchema: {
      title: z.string().describe("Notification title"),
      message: z.string().describe("Main notification message / body text"),
      contextMessage: z.string().optional().describe("Small context label (defaults to 'MCP Agent')"),
      priority: z
        .number()
        .int()
        .min(-2)
        .max(2)
        .optional()
        .describe("Priority from -2 to 2 (default 1)"),
    },
    annotations: STATE_CHANGE,
    handler: async ({ title, message, contextMessage, priority }, ctx) => {
      const r = await ctx.send("notification_create", { title, message, contextMessage, priority });
      return textResult(r);
    },
  });

  kit.define({
    name: "notification_clear",
    title: "Dismiss notification",
    description: "Dismiss / clear a previously created desktop notification",
    category: "notifications",
    inputSchema: {
      id: z.string().describe("Notification ID returned from notification_create"),
    },
    annotations: STATE_SET,
    handler: async ({ id }, ctx) => {
      const r = await ctx.send("notification_clear", { id });
      return textResult(r);
    },
  });
}
