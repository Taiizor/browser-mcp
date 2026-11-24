// Browsing data removal (permission category "browsing_data").
import { z } from "zod";
import { DESTRUCTIVE_IDEMPOTENT, textResult, type ToolKit } from "../tool-kit.js";

// Session data cleared by browsing_data_clear {all:true} (the former implicit default).
const BROWSING_DATA_DEFAULT_TYPES = ["cache", "cookies", "formData", "history", "localStorage", "indexedDB", "serviceWorkers"] as const;

export function registerBrowsingDataTools(kit: ToolKit): void {
  kit.define({
    name: "browsing_data_clear",
    title: "Clear browsing data",
    description: "Clear browser data for every site (irreversible): cache, cookies, history, storage, downloads, form data, passwords. Pass explicit types, or all:true for the common session-data set.",
    category: "browsing_data",
    inputSchema: {
      types: z
        .array(
          z.enum([
            "appcache",
            "cache",
            "cacheStorage",
            "cookies",
            "downloads",
            "fileSystems",
            "formData",
            "history",
            "indexedDB",
            "localStorage",
            "passwords",
            "serviceWorkers",
            "webSQL",
          ])
        )
        .optional()
        .describe("Types of browsing data to clear (required unless all:true)"),
      all: z
        .boolean()
        .optional()
        .describe(`true without types: clear the common session data (${BROWSING_DATA_DEFAULT_TYPES.join(", ")})`),
      since: z
        .number()
        .nonnegative()
        .optional()
        .describe("Milliseconds since epoch to clear data since (0 = all time, default)"),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ types, all, since }, ctx) => {
      // Never wipe everything implicitly: an omitted or empty types list needs all:true.
      if (types && types.length > 0) {
        const r = await ctx.send("browsing_data_clear", { types, since });
        return textResult(r);
      }
      if (all !== true) {
        throw new Error("browsing_data_clear needs a non-empty types list, or all:true to clear the common session data");
      }
      const r = await ctx.send("browsing_data_clear", { types: [...BROWSING_DATA_DEFAULT_TYPES], all: true, since });
      return textResult(r);
    },
  });
}
