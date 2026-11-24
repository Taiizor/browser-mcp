// Captured page console logs (permission category "console").
import { z } from "zod";
import {
  assertNotKnownDisabled,
  bufferFallbackWarning,
  DESTRUCTIVE_IDEMPOTENT,
  errMessage,
  isPermissionError,
  limitParam,
  READ_ONLY,
  TabIdAllTabs,
  textResult,
  type ToolKit,
} from "../tool-kit.js";

export function registerConsoleTools(kit: ToolKit): void {
  kit.define({
    name: "console_get",
    title: "Read console",
    description: "Read captured page console logs (filter by level and tab). Falls back to this server's local event buffer, with a warning, when the extension is unreachable.",
    category: "console",
    inputSchema: {
      level: z.enum(["all", "log", "info", "warn", "error", "debug"]).optional().describe("Log level filter (default all)"),
      limit: limitParam(5000, "Max entries from the tail (default 200)"),
      tabId: TabIdAllTabs,
    },
    annotations: READ_ONLY,
    handler: async ({ level, limit, tabId }, ctx) => {
      // Ask the extension for fresh data first, fall back to the bridge buffer
      try {
        // tabId is a filter, not a command target: payload only (the extension
        // reads payload.tabId), so the tab is not marked as being under automation.
        const r = await ctx.send("console_get", { level, limit, tabId });
        return textResult(r);
      } catch (e) {
        // Permission denials must surface (not silently downgrade to the buffer).
        if (isPermissionError(e)) throw e;
        assertNotKnownDisabled(ctx.bridge, "console_get");
        const lvl = level ?? "all";
        const lim = limit ?? 200;
        const logs = (ctx.bridge.consoleEvents as Array<Record<string, unknown>>)
          .filter((x) => tabId === undefined || x?.tabId === tabId)
          .filter((x) => lvl === "all" || x?.level === lvl)
          .slice(-lim);
        return textResult({ source: "bridge-buffer", warning: bufferFallbackWarning(e), count: logs.length, logs });
      }
    },
  });

  kit.define({
    name: "console_clear",
    title: "Clear console",
    description: "Clear captured console logs (extension + local buffer), for every tab or only one.",
    category: "console",
    inputSchema: {
      tabId: z.number().int().optional().describe("Only clear this tab's entries (see tab_list). Omit to clear every tab."),
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ tabId }, ctx) => {
      // Drops this tab's entries (or all of them) from the local buffer in place.
      const clearLocal = () => {
        const buf = ctx.bridge.consoleEvents as Array<Record<string, unknown>>;
        if (tabId === undefined) {
          buf.length = 0;
          return;
        }
        const keep = buf.filter((x) => x?.tabId !== tabId);
        buf.length = 0;
        for (const x of keep) buf.push(x);
      };
      try {
        // tabId is a filter here, not a command target: it goes in the payload
        // only, so the tab is not marked as being under automation.
        const r = await ctx.send("console_clear", { tabId });
        clearLocal();
        return textResult(r);
      } catch (e) {
        if (isPermissionError(e)) throw e;
        assertNotKnownDisabled(ctx.bridge, "console_clear");
        clearLocal();
        return textResult({
          ok: true,
          source: "bridge-buffer",
          ...(tabId === undefined ? {} : { tabId }),
          warning: `Extension unreachable (${errMessage(e)}): only this server's local buffer was cleared.`,
        });
      }
    },
  });
}
