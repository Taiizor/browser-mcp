// MCP server factory: tools, resources and prompts over one bridge.
// Import-safe (no argv parsing, port binding or process exit), so tests can
// drive createServer() with a fake bridge over an in-memory transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type IBridge, SERVER_VERSION } from "./bridge.js";
import { bridgeStatusSnapshot, resolveMaxOutputChars, spillToPrivateTemp, ToolKit, type ToolEntry } from "./tool-kit.js";
import { registerBookmarkTools } from "./tools/bookmarks.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerBrowsingDataTools } from "./tools/browsing-data.js";
import { registerClipboardTools } from "./tools/clipboard.js";
import { registerConsoleTools } from "./tools/console.js";
import { registerCookieTools } from "./tools/cookies.js";
import { registerDialogTools } from "./tools/dialogs.js";
import { registerDownloadTools } from "./tools/downloads.js";
import { registerEmulationTools } from "./tools/emulation.js";
import { registerInteractTools } from "./tools/interact.js";
import { registerMediaTools } from "./tools/media.js";
import { registerMockTools } from "./tools/mock.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerPerformanceTools } from "./tools/performance.js";
import { registerPowerTools } from "./tools/power.js";
import { registerReadTools } from "./tools/read.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerStorageTools } from "./tools/storage.js";
import { registerSystemTools } from "./tools/system.js";
import { registerTabTools } from "./tools/tabs.js";
import { registerToolsetTools } from "./tools/toolsets.js";
import { registerTrustedTools } from "./tools/trusted.js";
import { DEFAULT_TOOLSETS, parseToolsets, TOOLSET_IDS, type ToolsetId } from "./toolsets.js";

// Hard-coded: the npm package name is scoped, the MCP server name is not.
export const SERVER_NAME = "browser-mcp";
// One version source (package.json via bridge.ts), so the MCP initialize
// result and the bridge welcome can never disagree.
export { SERVER_VERSION };

/** Sent once at initialize; clients typically add it to the model's system prompt, so keep it short. */
export const SERVER_INSTRUCTIONS = [
  "Automates the user's own Chromium browser through the Browser MCP extension.",
  "Start with browser_status (browser_launch when the extension is disconnected), then tab_list for tab IDs; tools act on the active tab when tabId is omitted.",
  "Call page_snapshot before interacting: its refs (e.g. e473012) work as selectors in dom_* and trusted_* tools until the page navigates.",
  "More tools exist than are listed: browser_toolsets lists every toolset (network, cookies, storage, emulation, performance, ...) and enables more at runtime.",
  "page_snapshot, page_text and page_html return a window: page with offset/maxChars, continuing from the returned nextOffset, instead of re-reading everything.",
  "Text results above the output cap are cut; the trailing note says where the full output is or how to get the rest.",
  'A "Permission disabled" error means the user switched that action off in the extension popup; only the user can re-enable it. Tools switched off there are hidden from the tool list.',
  "Calling a tool that is not listed returns an error naming the fix (the browser_toolsets call, or the popup switch).",
].join("\n");

export interface CreateServerOptions {
  /** Version reported to clients (default: package.json). */
  version?: string;
  /**
   * Toolsets listed from the start: ids or comma lists ("core", "all", category
   * ids), as given by --toolsets. Default: BROWSER_MCP_TOOLSETS, else ["core"].
   * Unknown ids are reported through `log` and ignored.
   */
  toolsets?: readonly string[];
  /**
   * Text characters one tool result may return inline; longer text is cut and
   * (outside the sensitive categories) saved to a file. Default:
   * BROWSER_MCP_MAX_OUTPUT_CHARS, else 40000 (minimum 1000).
   */
  maxOutputChars?: number;
  /** Environment read for BROWSER_MCP_TOOLSETS / BROWSER_MCP_MAX_OUTPUT_CHARS (default process.env). */
  env?: Record<string, string | undefined>;
  /** Warnings about the options above (default: stderr with a [browser-mcp] prefix). */
  log?: (line: string) => void;
  /**
   * Persists oversized outputs and returns the path (default
   * spillToPrivateTemp: one private folder per process, removed on exit).
   */
  saveOutput?: (data: Buffer, baseName: string) => string;
}

/**
 * Start-up toolsets: the explicit list (--toolsets) wins over
 * BROWSER_MCP_TOOLSETS; nothing valid in either means DEFAULT_TOOLSETS.
 */
export function resolveToolsets(
  explicit: readonly string[] | undefined,
  env: Record<string, string | undefined>,
  log: (line: string) => void = () => {}
): ToolsetId[] {
  const fromEnv = env.BROWSER_MCP_TOOLSETS?.trim();
  const source = explicit !== undefined ? "--toolsets" : fromEnv ? "BROWSER_MCP_TOOLSETS" : null;
  if (!source) return [...DEFAULT_TOOLSETS];
  const { ids, unknown } = parseToolsets(explicit ?? fromEnv ?? "");
  if (unknown.length) {
    log(`ignoring unknown toolset(s) from ${source}: ${unknown.join(", ")} (known: ${TOOLSET_IDS.join(", ")})`);
  }
  if (!ids.length) {
    log(`no valid toolset in ${source}; using ${DEFAULT_TOOLSETS.join(", ")}`);
    return [...DEFAULT_TOOLSETS];
  }
  return ids;
}

const kits = new WeakMap<McpServer, ToolKit>();

/**
 * Builds the MCP server for `bridge`. Nothing runs until it is connected to a
 * transport, except that the tool list starts following the bridge's
 * permission snapshot (until the server closes).
 */
export function createServer(bridge: IBridge, opts: CreateServerOptions = {}): McpServer {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.error(`[browser-mcp] ${line}`));
  const server = new McpServer(
    { name: SERVER_NAME, version: opts.version ?? SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      // No capabilities.tools here: the SDK then installs its tool handlers on
      // the first registerTool, which lets ToolKit wrap the tools/call handler
      // (actionable errors for hidden tools). That install declares
      // tools.listChanged, which toolsets and popup switches rely on.
      // One toolset change or permission update flips many tools at once:
      // coalesce their list_changed notifications into one per tick.
      debouncedNotificationMethods: ["notifications/tools/list_changed"],
    }
  );
  const kit = new ToolKit(server, bridge, {
    maxOutputChars: resolveMaxOutputChars(opts.maxOutputChars, env, log),
    saveOutput: opts.saveOutput ?? spillToPrivateTemp,
    toolsets: resolveToolsets(opts.toolsets, env, log),
  });
  // Before any tool exists, so each one is registered under the current snapshot.
  const stopTracking = kit.trackPermissions();
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    stopTracking();
    onclose?.();
  };
  registerBrowserTools(kit);
  registerToolsetTools(kit);
  registerTabTools(kit);
  registerReadTools(kit);
  registerInteractTools(kit);
  registerMediaTools(kit);
  registerConsoleTools(kit);
  registerNetworkTools(kit);
  registerMockTools(kit);
  registerCookieTools(kit);
  registerStorageTools(kit);
  registerSessionTools(kit);
  registerDialogTools(kit);
  registerDownloadTools(kit);
  registerBookmarkTools(kit);
  registerPowerTools(kit);
  registerTrustedTools(kit);
  registerClipboardTools(kit);
  registerBrowsingDataTools(kit);
  registerNotificationTools(kit);
  registerSystemTools(kit);
  registerEmulationTools(kit);
  registerPerformanceTools(kit);
  registerResources(server, bridge);
  registerPrompts(server);
  kits.set(server, kit);
  return server;
}

/** Tools of a server built by createServer, by name, with their category, actions, required actions and SDK handle. */
export function getToolRegistry(server: McpServer): ReadonlyMap<string, ToolEntry> | undefined {
  return kits.get(server)?.registry;
}

/** The ToolKit of a server built by createServer (toolset state, output cap). */
export function getToolKit(server: McpServer): ToolKit | undefined {
  return kits.get(server);
}

// ---------- MCP Resources ----------
function registerResources(server: McpServer, bridge: IBridge): void {
  server.registerResource("status", "browser://status", { title: "Bridge status" }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(bridgeStatusSnapshot(bridge), null, 2),
    }],
  }));

  server.registerResource("tabs", "browser://tabs", { title: "Open tabs" }, async (uri) => {
    let tabs: unknown = [];
    if (bridge.connected) {
      try {
        tabs = await bridge.send("tabs_list", {});
      } catch (e) {
        tabs = { error: String((e as Error).message || e) };
      }
    } else {
      tabs = { error: "Extension not connected" };
    }
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(tabs, null, 2),
      }],
    };
  });

  /**
   * Recent events from this process's buffer (the primary's own capture or the
   * events a satellite receives by broadcast). Honours the popup switch that
   * gates the matching tool, as the extension stops capturing when it is off.
   */
  function recentEventsResource(uri: URL, events: Array<unknown>, gateAction: string) {
    const body = bridge.knownDisabled()?.includes(gateAction)
      ? { error: `Permission disabled in extension: ${gateAction} (enable it from the extension popup)` }
      : events.slice(-50);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(body, null, 2),
      }],
    };
  }

  server.registerResource("console_recent", "browser://console/recent", { title: "Recent console events" }, async (uri) =>
    recentEventsResource(uri, bridge.consoleEvents, "console_get")
  );

  server.registerResource("network_recent", "browser://network/recent", { title: "Recent network events" }, async (uri) =>
    recentEventsResource(uri, bridge.networkEvents, "network_requests")
  );
}

// ---------- MCP Prompts ----------
function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "web_research",
    {
      title: "Web research",
      description: "Structured browser research on a given topic and URL",
      argsSchema: {
        url: z.string().describe("Target website URL to inspect and research"),
        topic: z.string().describe("Topic or question to investigate"),
      },
    },
    ({ url, topic }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Please navigate to ${url} using tab_navigate, wait for page load using page_wait, extract the main content using page_snapshot or page_text, and summarize key insights specifically regarding: "${topic}".`,
        },
      }],
    })
  );

  server.registerPrompt(
    "form_automation",
    {
      title: "Form automation",
      description: "Inspect and fill a form on a given URL",
      argsSchema: {
        url: z.string().describe("Page URL containing the form"),
        fields: z.string().describe("Description or JSON of values to fill"),
      },
    },
    ({ url, fields }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Navigate to ${url}, identify form elements with dom_query or page_snapshot, populate them using dom_fill or dom_type with the following data: ${fields}, and confirm before submitting.`,
        },
      }],
    })
  );

  server.registerPrompt(
    "performance_audit",
    {
      title: "Performance audit",
      description: "Audit page metrics, network requests, and performance on a given URL",
      argsSchema: {
        url: z.string().describe("URL to audit"),
      },
    },
    ({ url }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `If perf_web_vitals, page_metrics or network_requests are not in your tool list, call browser_toolsets {"enable":["performance","network"]} first. ` +
            `Navigate to ${url}, wait for network activity to settle (page_wait with networkIdle:true), gather performance data using perf_web_vitals, page_metrics and network_requests, analyze slow requests, and export a HAR file (har_export) if appropriate.`,
        },
      }],
    })
  );

  server.registerPrompt(
    "accessibility_audit",
    {
      title: "Accessibility audit",
      description: "Audit accessibility tree and ARIA roles for a webpage",
      argsSchema: {
        url: z.string().describe("URL to evaluate for accessibility"),
      },
    },
    ({ url }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `If page_axtree is not in your tool list, call browser_toolsets {"enable":["read"]} first. ` +
            `Navigate to ${url}, run page_axtree to retrieve the accessibility tree (use page_snapshot or dom_query for heading order), and identify missing alt attributes, unlabeled buttons, heading hierarchy issues, and contrast/ARIA problems.`,
        },
      }],
    })
  );
}
