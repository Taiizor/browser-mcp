// browser_toolsets: lists the toolsets and changes which ones tools/list shows (category "meta", always listed).
import { z } from "zod";
import { STATE_SET, textResult, type ToolKit } from "../tool-kit.js";
import { normalizeToolsetId, TOOLSET_IDS } from "../toolsets.js";

// Ids match like --toolsets: case-insensitive, "-" as "_" ("Browsing-Data").
// The published schema still lists the exact ids (the SDK renders a
// preprocess by its target schema).
const ToolsetIds = z.array(z.preprocess((v) => (typeof v === "string" ? normalizeToolsetId(v) : v), z.enum(TOOLSET_IDS))).optional();

export function registerToolsetTools(kit: ToolKit): void {
  kit.define({
    name: "browser_toolsets",
    title: "Toolsets",
    description:
      'List the toolsets (groups of tools) and which are enabled, or enable / disable toolsets at runtime. Only "core" is listed by default (start-up: --toolsets / BROWSER_MCP_TOOLSETS). Call without arguments to see every toolset with its tools, then e.g. {"enable":["network"]}; "all" enables everything. Disabling a category also hides its tools from core / all. Tools switched off in the extension popup (or needing a switch that is off, e.g. har_export needs network_requests) stay hidden whatever is enabled.',
    category: "meta",
    inputSchema: {
      enable: ToolsetIds.describe("Toolsets to add: core, all, or a category id (case-insensitive)"),
      disable: ToolsetIds.describe("Toolsets to remove (applied after enable)"),
    },
    annotations: STATE_SET,
    handler: async ({ enable, disable }) => {
      if (!enable?.length && !disable?.length) return textResult(kit.toolsetSummary());
      const { shown, hidden, ...summary } = kit.changeToolsets({ enable, disable });
      return textResult({
        shown,
        hidden,
        note:
          shown.length || hidden.length
            ? "The tool list changed (notifications/tools/list_changed). A client that does not refresh its list on that notification shows the new tools only after it reconnects; start the server with --toolsets to choose them up front."
            : "No tool was added or removed.",
        ...summary,
      });
    },
  });
}
