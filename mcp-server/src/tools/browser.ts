// Browser lifecycle and bridge-level tools: status, launch / close, permission switches.
import { z } from "zod";
import {
  bridgeStatusSnapshot,
  currentDisabledActions,
  DESTRUCTIVE,
  permissionDeniedError,
  READ_ONLY,
  STATE_SET,
  textResult,
  type ToolKit,
} from "../tool-kit.js";

export function registerBrowserTools(kit: ToolKit): void {
  kit.define({
    name: "browser_status",
    title: "Browser status",
    description: "Check whether the browser extension is connected and show bridge status (mode=primary|satellite, pid, peers=satellites sharing this bridge, trusted/rejected extension ids, last known disabled actions)",
    category: "meta",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, ctx) => {
      return textResult(bridgeStatusSnapshot(ctx.bridge));
    },
  });

  kit.define({
    name: "browser_launch",
    title: "Launch browser",
    description: "Start the browser if needed and wait for the extension to connect. Browser choice follows BROWSER / sticky / running / OS-default order; use when browser_status shows disconnected.",
    category: "meta",
    inputSchema: {
      timeoutMs: z.number().int().positive().max(600000).optional().describe("How long to wait for the extension (default 45000)"),
    },
    annotations: STATE_SET,
    handler: async ({ timeoutMs }, ctx) => {
      const r = await ctx.bridge.launchBrowser(timeoutMs);
      return textResult(r);
    },
  });

  kit.define({
    name: "browser_close",
    title: "Close browser",
    description: "Close the browser. Graceful mode (default) closes windows via the extension. force:true kills only the browser that hosts the extension (refused when that browser is unknown) and also works when the extension is silent. Respects the browser_close popup switch (last known state when the extension does not answer).",
    category: "tabs",
    inputSchema: {
      force: z.boolean().optional().describe("true: kill the process of the browser hosting the extension (also works when the extension is silent)"),
    },
    annotations: DESTRUCTIVE,
    handler: async ({ force }, ctx) => {
      // Honor the popup switch. A frozen or disconnected extension must not
      // block (or bypass) the check: use the last known snapshot then.
      const disabled = await currentDisabledActions(ctx.bridge, 3000);
      if (disabled?.includes("browser_close")) throw permissionDeniedError("browser_close");
      const r = await ctx.bridge.closeBrowser(force ?? false);
      return textResult(r);
    },
  });

  kit.define({
    name: "permissions_list",
    title: "List bridge permissions",
    description: "Show permission categories with enabled/total counts and the disabled action list.",
    category: "meta",
    inputSchema: {},
    annotations: READ_ONLY,
    handler: async (_args, ctx) => {
      const r = await ctx.send("perm_list", {});
      return textResult(r);
    },
  });

  kit.define({
    name: "permissions_set",
    title: "Disable bridge action",
    description: "Disable one bridge action (self-restriction, synced to the extension popup). Only disabling works over the bridge: enabled:true is rejected, re-enabling is only possible from the extension popup. Disabled actions fail with a clear error.",
    category: "meta",
    inputSchema: {
      action: z.string().describe("Bridge action name (e.g. dom_click)"),
      enabled: z.boolean().describe("Must be false (disable). true is rejected: re-enable from the extension popup."),
    },
    annotations: STATE_SET,
    handler: async ({ action, enabled }, ctx) => {
      // The agent must never lift a restriction the user set in the popup
      // (enforced here too, so older extensions are covered as well).
      if (enabled !== false) {
        throw new Error("Re-enabling a permission is only possible from the extension popup");
      }
      const r = await ctx.send("perm_set", { action, enabled: false });
      return textResult(r);
    },
  });
}
