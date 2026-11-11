import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  EmptyResultSchema,
  ErrorCode,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeClient, ExtensionBridge, type IBridge } from "./bridge.js";

// ---------- CLI ----------
// Invalid explicit values are fatal: silently falling back to the default
// port would bind (or join) a different bridge than the one the user asked for.
function cliFail(message: string): never {
  console.error(`[browser-mcp] ${message}`);
  process.exit(2);
}

function parsePortValue(raw: string, source: string): number {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) cliFail(`Invalid port from ${source}: "${raw}" (expected an integer 1-65535)`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) cliFail(`Invalid port from ${source}: "${raw}" (expected an integer 1-65535)`);
  return n;
}

const EXTENSION_ID_RE = /^(?:[a-p]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function parseExtensionIdList(raw: string, source: string): string[] {
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase().replace(/^\{|\}$/g, "");
    if (!id) continue;
    // "*" = accept any extension id (legacy mode, same as BROWSER_MCP_EXTENSION_IDS=*).
    if (id !== "*" && !EXTENSION_ID_RE.test(id)) {
      cliFail(`Invalid extension id from ${source}: "${part.trim()}" (expected a 32-char Chromium id a-p, a Firefox UUID, or *)`);
    }
    ids.push(id);
  }
  if (!ids.length) cliFail(`Missing extension id for ${source}`);
  return ids;
}

type CliOptions = { port?: number; browser?: string; extensionIds: string[] };

function parseCli(argv: string[]): CliOptions {
  const out: CliOptions = { extensionIds: [] };
  const takeValue = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) cliFail(`Missing value for ${flag}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let m: RegExpMatchArray | null;
    if (arg === "--port" || arg === "-p") {
      const port = parsePortValue(takeValue(i, arg), arg);
      out.port ??= port;
      i++;
    } else if ((m = arg.match(/^(--port|-p)=(.*)$/))) {
      const port = parsePortValue(m[2], m[1]);
      out.port ??= port;
    } else if (arg === "--browser" || arg === "-b") {
      out.browser ??= takeValue(i, arg);
      i++;
    } else if ((m = arg.match(/^(?:--browser|-b)=(.+)$/))) {
      out.browser ??= m[1];
    } else if (arg === "--extension-id") {
      out.extensionIds.push(...parseExtensionIdList(takeValue(i, arg), arg));
      i++;
    } else if ((m = arg.match(/^--extension-id=(.*)$/))) {
      out.extensionIds.push(...parseExtensionIdList(m[1], "--extension-id"));
    } else if (/^[+-]?\d/.test(arg)) {
      // Positional port (legacy form: `index.ts 9000`). Must be a clean integer.
      const port = parsePortValue(arg, "positional argument");
      out.port ??= port;
    } else {
      console.error(`[browser-mcp] ignoring unknown argument: ${arg}`);
    }
  }
  return out;
}

const CLI = parseCli(process.argv.slice(2));

function resolvePort(): number {
  if (CLI.port !== undefined) return CLI.port;
  // BROWSER_MCP_PORT wins over the generic PORT (README documents both).
  const own = process.env.BROWSER_MCP_PORT;
  if (own !== undefined && own.trim() !== "") return parsePortValue(own, "BROWSER_MCP_PORT");
  const generic = process.env.PORT;
  if (generic !== undefined && generic.trim() !== "") {
    const port = parsePortValue(generic, "PORT");
    // PORT is often exported for unrelated dev servers: say loudly where the port came from.
    console.error(
      `[browser-mcp] using port ${port} from the PORT environment variable (set BROWSER_MCP_PORT or --port to override; the extension must use the same port)`
    );
    return port;
  }
  return 8765;
}

const PORT = resolvePort();

// Multi-agent sharing: the first process owns the WS bridge (primary),
// later processes join it as satellite clients instead of failing on
// EADDRINUSE. All satellites relay through the single extension socket.
// NOTE: stdio MCP requires one OS process per MCP client session, so N agent
// sessions = N processes (1 primary + N-1 satellites) sharing one browser.
// That is expected — see browser_status (mode/pid/peers) to tell them apart.
// Each satellite attempt already retries internally (failover / takeover) for
// a bounded time (~15 s) before ready() rejects, so one extra outer round is
// enough and keeps the worst-case startup failure around half a minute.
const BRIDGE_START_ATTEMPTS = 2;

async function createBridge(port: number, extensionIds: string[]): Promise<IBridge> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= BRIDGE_START_ATTEMPTS; attempt++) {
    const primary = new ExtensionBridge(port, { exitOnAddrInUse: false, extensionIds });
    try {
      await primary.ready();
      console.error(`[browser-mcp:${process.pid}] primary bridge on :${port} (ppid=${process.ppid})`);
      return primary;
    } catch (e) {
      try {
        primary.close();
      } catch {}
      const code = (e as { code?: string })?.code;
      // Only "port already taken" means another bridge may own it. Any other
      // bind error (EACCES on a Windows excluded port range, EADDRNOTAVAIL...)
      // must fail with its real cause instead of a misleading satellite error.
      if (code !== "EADDRINUSE") {
        const hint =
          code === "EACCES"
            ? " The port may be reserved by the OS (Windows: `netsh interface ipv4 show excludedportrange protocol=tcp`)."
            : "";
        throw new Error(
          `Cannot bind the browser-mcp bridge on 127.0.0.1:${port} (${code ?? "error"}: ${errMessage(e)}).${hint} Choose another port with --port or BROWSER_MCP_PORT (and set the same port in the extension popup).`
        );
      }
    }
    console.error(`[browser-mcp:${process.pid}] port ${port} in use, joining as satellite client`);
    // extensionIds: a satellite promoted to primary keeps the same trust list.
    const client = new BridgeClient(port, { extensionIds });
    try {
      await client.ready();
      console.error(`[browser-mcp:${process.pid}] satellite connected to primary on :${port}`);
      return client;
    } catch (e) {
      lastError = e;
      try {
        client.close();
      } catch {}
      if (attempt >= BRIDGE_START_ATTEMPTS) break;
      // The primary may be restarting (old process shutting down): retry the
      // primary bind first, then the satellite link, with backoff.
      const delay = Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      console.error(
        `[browser-mcp:${process.pid}] satellite link failed (${errMessage(e)}), retry ${attempt}/${BRIDGE_START_ATTEMPTS - 1} in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  // "In use" but nobody answers: typically a port reserved by the OS (on
  // Windows, binding an excluded port range can surface as EADDRINUSE).
  const hint = /ECONNREFUSED/.test(errMessage(lastError))
    ? " Binding the port failed although nothing accepts connections on it; it may be reserved by the OS (Windows: `netsh interface ipv4 show excludedportrange protocol=tcp`). Choose another port with --port or BROWSER_MCP_PORT (and set the same port in the extension popup)."
    : "";
  throw new Error(
    `Could not start or join the browser-mcp bridge on :${port} after ${BRIDGE_START_ATTEMPTS} attempts: ${errMessage(lastError)}.${hint}`
  );
}

let bridge: IBridge;

const server = new McpServer({
  name: "browser-mcp",
  version: "0.3.5",
});

// ---------- helpers ----------
const TabId = z.number().int().optional().describe("Tab ID from tab_list. Omit for the active tab.");
// Log/traffic readers filter by tab only when asked: an omitted tabId means every tab.
const TabIdAllTabs = z.number().int().optional().describe("Only entries from this tab (see tab_list). Omit for all tabs.");
const SelectorDesc =
  'CSS selector (also searches open shadow roots; css=... prefix optional), "host >>> inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012)';

/** Optional positive integer limit with an upper bound. */
function limitParam(max: number, description: string) {
  return z.number().int().positive().max(max).optional().describe(description);
}

function errMessage(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects with `message` when `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function textResult(obj: unknown): { content: { type: "text"; text: string }[] } {
  if (typeof obj === "string") {
    return { content: [{ type: "text" as const, text: obj }] };
  }
  const str = JSON.stringify(obj);
  const text = str.length > 1200 ? str : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function permissionDeniedError(action: string): Error {
  return new Error(`Permission disabled in extension: ${action} (enable it from the extension popup)`);
}

function isPermissionError(e: unknown): boolean {
  return /Permission disabled/i.test(errMessage(e));
}

/**
 * Local event buffers are only a fallback: they must honour the last known
 * popup switches (the extension stops capturing when they are off) and must
 * never pass for fresh extension data.
 */
function assertNotKnownDisabled(action: string): void {
  if (bridge.knownDisabled()?.includes(action)) throw permissionDeniedError(action);
}

function bufferFallbackWarning(e: unknown): string {
  return `Extension unreachable (${errMessage(e)}). Showing events buffered by this MCP server process; they may be incomplete or stale.`;
}

/**
 * Current disabled-action list for gating decisions. Asks the extension when
 * it is connected (bounded to `timeoutMs`, so a frozen browser cannot stall
 * the caller) and falls back to the last snapshot the bridge has seen.
 */
async function currentDisabledActions(timeoutMs = 3000): Promise<string[] | null> {
  if (bridge.connected) {
    try {
      const perms = await withTimeout(
        bridge.send<{ disabled?: string[] }>("perm_list", {}, undefined, timeoutMs),
        timeoutMs,
        `perm_list timed out after ${timeoutMs}ms`
      );
      if (Array.isArray(perms?.disabled)) return perms.disabled;
    } catch {
      /* fall back to the cached snapshot */
    }
  }
  return bridge.knownDisabled();
}

function bridgeStatusSnapshot(): Record<string, unknown> {
  return {
    connected: bridge.connected,
    wsPort: bridge.port,
    consoleBuffered: bridge.consoleEvents.length,
    networkBuffered: bridge.networkEvents.length,
    // Last permission snapshot reported by the extension (null = unknown yet).
    disabledActions: bridge.knownDisabled(),
    ...bridge.status(),
  };
}

// ---------- tool annotations (MCP hints for clients) ----------
// Browser / bridge state reads (tabs, cookies, history, buffers...).
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
// Reads of page content: untrusted data from arbitrary websites.
const READ_PAGE: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
// Reversible settings that can be re-applied safely (focus, overrides, policies).
const STATE_SET: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Non-destructive changes that are not idempotent (toggles, creating items).
const STATE_CHANGE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// Opening / navigating pages.
const NAVIGATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
// Low-impact page interaction (scroll, hover, focus, find).
const PAGE_INTERACT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
// Page input whose effect depends on the page (a click can submit or delete):
// destructiveHint is left unset, i.e. the spec default (may be destructive).
const PAGE_ACTION: ToolAnnotations = { readOnlyHint: false, idempotentHint: false, openWorldHint: true };
// Arbitrary code / raw protocol access.
const POWER: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
// Irreversible deletion / overwrite of user data.
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------- status ----------
server.tool("browser_status", "Check whether the browser extension is connected and show bridge status (mode=primary|satellite, pid, peers=satellites sharing this bridge, trusted/rejected extension ids, last known disabled actions)", {}, READ_ONLY, async () => {
  return textResult(bridgeStatusSnapshot());
});

// ---------- browser launch ----------
server.tool(
  "browser_launch",
  "Start the browser if needed and wait for the extension to connect. Browser choice follows BROWSER / sticky / running / OS-default order; use when browser_status shows disconnected.",
  {
    timeoutMs: z.number().int().positive().max(600000).optional().describe("How long to wait for the extension (default 45000)"),
  },
  STATE_SET,
  async ({ timeoutMs }) => {
    const r = await bridge.launchBrowser(timeoutMs);
    return textResult(r);
  }
);

server.tool(
  "browser_close",
  "Close the browser. Graceful mode (default) closes windows via the extension. force:true kills only the browser that hosts the extension (refused when that browser is unknown) and also works when the extension is silent. Respects the browser_close popup switch (last known state when the extension does not answer).",
  {
    force: z.boolean().optional().describe("true: kill the process of the browser hosting the extension (also works when the extension is silent)"),
  },
  DESTRUCTIVE,
  async ({ force }) => {
    // Honor the popup switch. A frozen or disconnected extension must not
    // block (or bypass) the check: use the last known snapshot then.
    const disabled = await currentDisabledActions(3000);
    if (disabled?.includes("browser_close")) throw permissionDeniedError("browser_close");
    const r = await bridge.closeBrowser(force ?? false);
    return textResult(r);
  }
);

// ---------- tabs ----------
server.tool("tab_list", "List all open tabs with id, title, URL and active state. Call first to discover tab IDs for other tools.", {}, READ_ONLY, async () => {
  const r = await bridge.send("tabs_list");
  return textResult(r);
});

server.tool(
  "tab_create",
  "Open a new tab, optionally at a URL. Use active:false to keep it in the background. Returns the new tab ID.",
  {
    url: z.string().optional().describe("URL to open (default about:blank)"),
    active: z.boolean().optional().describe("Bring to front (default true)"),
  },
  NAVIGATE,
  async ({ url, active }) => {
    const r = await bridge.send("tab_create", { url, active });
    return textResult(r);
  }
);

server.tool(
  "tab_duplicate",
  "Duplicate an existing tab into a new tab",
  { tabId: TabId },
  NAVIGATE,
  async ({ tabId }) => {
    const r = await bridge.send("tab_duplicate", {}, tabId);
    return textResult(r);
  }
);

server.tool("tab_close", "Close a tab (default: active). Closing the last tab of the last window quits the browser and needs the browser_close permission.", { tabId: TabId }, DESTRUCTIVE, async ({ tabId }) => {
  const r = await bridge.send("tab_close", {}, tabId);
  return textResult(r);
});

server.tool("tab_activate", "Bring a tab to the front and focus its window.", { tabId: z.number().int().describe("Tab ID to activate (see tab_list)") }, STATE_SET, async ({ tabId }) => {
  const r = await bridge.send("tab_activate", {}, tabId);
  return textResult(r);
});

server.tool(
  "tab_navigate",
  "Navigate a tab to a URL. Navigation destroys page context: re-query refs and re-wait afterwards.",
  { url: z.string().describe("Target URL"), tabId: TabId },
  NAVIGATE,
  async ({ url, tabId }) => {
    const r = await bridge.send("tab_navigate", { url }, tabId);
    return textResult(r);
  }
);

server.tool("tab_reload", "Reload a tab (default: active). Page context resets: re-query refs afterwards.", { tabId: TabId }, NAVIGATE, async ({ tabId }) => {
  const r = await bridge.send("tab_reload", {}, tabId);
  return textResult(r);
});

server.tool("tab_back", "Go back in tab history.", { tabId: TabId }, NAVIGATE, async ({ tabId }) => {
  const r = await bridge.send("tab_back", {}, tabId);
  return textResult(r);
});

server.tool("tab_forward", "Go forward in tab history.", { tabId: TabId }, NAVIGATE, async ({ tabId }) => {
  const r = await bridge.send("tab_forward", {}, tabId);
  return textResult(r);
});

// ---------- page / dom ----------
server.tool(
  "page_snapshot",
  "Compact element tree with refs (e.g. [ref=e473012]; pass e473012 as a selector) for finding selectors. Start here before interacting; refs expire on navigation.",
  {
    tabId: TabId,
    compact: z.boolean().optional().describe("true: compact tree, false: detailed"),
  },
  READ_PAGE,
  async ({ tabId, compact }) => {
    const r = await bridge.send("page_snapshot", { compact: compact ?? true }, tabId);
    return textResult(r);
  }
);

server.tool("page_html", "Full HTML source (large, truncated in display). Prefer page_snapshot for structure.", { tabId: TabId }, READ_PAGE, async ({ tabId }) => {
  const r = await bridge.send("page_html", {}, tabId, 60000);
  return textResult(r);
});

server.tool("page_text", "Visible page text (up to 100KB). Best for reading content.", { tabId: TabId }, READ_PAGE, async ({ tabId }) => {
  const r = await bridge.send("page_text", {}, tabId);
  return textResult(r);
});

server.tool(
  "dom_query",
  "Find elements by CSS/XPath/text/ref. Returns refs with tag, text and coordinates for clicks and typing.",
  { selector: z.string().describe(SelectorDesc), tabId: TabId },
  READ_PAGE,
  async ({ selector, tabId }) => {
    const r = await bridge.send("dom_query", { selector }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_click",
  "Click an element (synthetic mouse events). For bot-protected sites use trusted_click instead.",
  {
    selector: z.string().describe(SelectorDesc),
    tabId: TabId,
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)"),
    doubleClick: z.boolean().optional().describe("Double click (two clicks + dblclick)"),
  },
  PAGE_ACTION,
  async ({ selector, tabId, button, doubleClick }) => {
    const r = await bridge.send("dom_click", { selector, button, doubleClick }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_type",
  "Type text into an input with realistic key events. For many fields at once use dom_fill.",
  {
    selector: z.string().describe(SelectorDesc),
    text: z.string().describe("Text to type"),
    tabId: TabId,
    clearFirst: z.boolean().optional().describe("Clear existing content first"),
    pressEnter: z.boolean().optional().describe("Press Enter after typing"),
    delayMs: z.number().int().nonnegative().max(5000).optional().describe("Per-keystroke delay in ms (for bot-protected sites)"),
  },
  PAGE_ACTION,
  async ({ selector, text, tabId, clearFirst, pressEnter, delayMs }) => {
    // Slow typing can take longer than the default command timeout.
    const timeoutMs = delayMs ? text.length * delayMs + 30000 : undefined;
    const r = await bridge.send(
      "dom_type",
      { selector, text, clearFirst, pressEnter, delayMs },
      tabId,
      timeoutMs
    );
    return textResult(r);
  }
);

server.tool(
  "dom_fill",
  "Fill many form fields at once (selector -> value map). Faster than repeated dom_type.",
  {
    fields: z.record(z.string(), z.string()).describe("selector -> value map"),
    tabId: TabId,
    submit: z.boolean().optional().describe("Submit the enclosing form after filling"),
  },
  PAGE_ACTION,
  async ({ fields, tabId, submit }) => {
    const r = await bridge.send("dom_fill", { fields, submit }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_select",
  "Choose a native <select> option by value or visible label (fires input/change). For custom dropdowns click the trigger and the option.",
  {
    selector: z.string().describe(SelectorDesc),
    value: z.string().describe("Option value or visible label to select"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ selector, value, tabId }) => {
    const r = await bridge.send("dom_select", { selector, value }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_check",
  "Set or toggle a checkbox/radio/switch by clicking it like a user (click, input and change fire).",
  {
    selector: z.string().describe(SelectorDesc),
    checked: z.boolean().optional().describe("Omit to toggle"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ selector, checked, tabId }) => {
    const r = await bridge.send("dom_check", { selector, checked }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_hover",
  "Hover an element (opens menus/tooltips). For real pointer input use trusted actions.",
  { selector: z.string().describe(SelectorDesc), tabId: TabId },
  PAGE_INTERACT,
  async ({ selector, tabId }) => {
    const r = await bridge.send("dom_hover", { selector }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_focus",
  "Focus an element (inputs, buttons).",
  { selector: z.string().describe(SelectorDesc), tabId: TabId },
  PAGE_INTERACT,
  async ({ selector, tabId }) => {
    const r = await bridge.send("dom_focus", { selector }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_scroll",
  "Scroll the page or an element into view.",
  {
    selector: z.string().optional().describe("Omit to scroll the page"),
    direction: z.enum(["up", "down", "top", "bottom"]).optional().describe("Scroll direction (default down)"),
    pixels: z.number().int().positive().max(100000).optional().describe("Pixels per step (default 500)"),
    tabId: TabId,
  },
  PAGE_INTERACT,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("dom_scroll", payload, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_drag",
  "Drag from one element to another (synthetic mouse + HTML5 drag events).",
  {
    from: z.string().describe("Source selector/ref"),
    to: z.string().describe("Target selector/ref"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ from, to, tabId }) => {
    const r = await bridge.send("dom_drag", { from, to }, tabId);
    return textResult(r);
  }
);

server.tool(
  "keyboard_press",
  "Dispatch synthetic key events to the focused element (combos like Ctrl+K are parsed; page key handlers see them). Only Enter, Tab, Space, Backspace/Delete, typing and select-all defaults are emulated; native shortcuts, clipboard, caret movement and scrolling need trusted_key.",
  {
    key: z.string().describe("Enter, Tab, Escape, ArrowDown, a, A, Ctrl+C ..."),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ key, tabId }) => {
    const r = await bridge.send("keyboard_press", { key }, tabId);
    return textResult(r);
  }
);

server.tool(
  "page_find",
  "Search page text (case-insensitive) and scroll the first match into view.",
  { text: z.string().describe("Text to find"), tabId: TabId },
  PAGE_INTERACT,
  async ({ text, tabId }) => {
    const r = await bridge.send("page_find", { text }, tabId);
    return textResult(r);
  }
);

server.tool(
  "page_wait",
  "Wait for an element, text, URL substring/pattern, or readyState to appear in the page, or wait for a timeout duration",
  {
    selector: z.string().optional().describe("Selector to wait for; omit for duration only"),
    timeoutMs: z.number().int().positive().max(600000).optional().describe("Maximum wait time in ms (default 15000, max 600000)"),
    text: z.string().optional().describe("Page text to wait for"),
    url: z.string().optional().describe("URL substring to wait for (e.g. after redirects)"),
    urlPattern: z.string().optional().describe("URL regex pattern to wait for"),
    readyState: z.enum(["interactive", "complete"]).optional().describe("Wait for document readyState ('interactive' or 'complete')"),
    tabId: TabId,
  },
  READ_PAGE,
  async (args) => {
    const { tabId, ...payload } = args;
    // `||` matches the extension, which also treats a falsy timeout as the default.
    const r = await bridge.send("page_wait", payload, tabId, (payload.timeoutMs || 15000) + 5000);
    return textResult(r);
  }
);

server.tool(
  "page_screenshot",
  "Capture a screenshot of the visible viewport, full page, or a specific element as an image",
  {
    tabId: TabId,
    fullPage: z.boolean().optional().describe("Whether to capture the entire scrollable page"),
    selector: z.string().optional().describe("Omit for viewport: CSS selector or ref of the element to capture"),
    scale: z.number().positive().max(2).optional().describe("Capture scale for element shots (default 1, max 2)"),
    maxHeight: z
      .number()
      .int()
      .min(256)
      .max(32768)
      .optional()
      .describe("fullPage only: maximum captured height in CSS px (default 16384). Taller pages are cut and reported with truncated:true."),
  },
  READ_PAGE,
  async ({ tabId, fullPage, selector, scale, maxHeight }) => {
    const result = (await bridge.send("page_screenshot", { fullPage, selector, scale, maxHeight }, tabId, 60000)) as {
      dataUrl?: string;
      note?: string;
      [key: string]: unknown;
    };
    if (result.dataUrl && result.dataUrl.startsWith("data:image/")) {
      const { dataUrl, ...meta } = result;
      const parts = dataUrl.split(",");
      const mime = parts[0].match(/:(.*?);/)?.[1] || "image/png";
      const base64Data = parts[1];
      return {
        content: [
          {
            type: "image" as const,
            data: base64Data,
            mimeType: mime,
          },
          {
            type: "text" as const,
            // Extension metadata (e.g. truncated / captured height) rides along with the image.
            text: JSON.stringify({ tabId, ...meta, note: meta.note || "Screenshot captured successfully" }),
          },
        ],
      };
    }
    return textResult(result);
  }
);

// ---------- binary results (PDF / audio) ----------
// Binary payloads are never pasted into the model context as base64 text:
// they are returned as typed MCP content blocks, written to savePath, or
// (when too large to return inline) written to a private temp file.
const INLINE_BINARY_MAX_BYTES = 10 * 1024 * 1024;

type SaveTarget = { file: string; ext: string; overwrite: boolean };

/**
 * Validates a user-supplied output path before any work (recording, rendering) starts.
 * `overwrite === null` means the tool has no overwrite option.
 */
function checkSavePath(savePath: string, allowedExts: readonly string[], overwrite: boolean | null): SaveTarget {
  if (!path.isAbsolute(savePath)) {
    throw new Error(`savePath must be an absolute path (got "${savePath}")`);
  }
  const file = path.resolve(savePath);
  const ext = path.extname(file).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new Error(`savePath must end with one of ${allowedExts.join(", ")} (got "${ext || "no extension"}")`);
  }
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(file);
  } catch {
    st = null;
  }
  if (st) {
    if (!st.isFile()) throw new Error(`savePath exists and is not a regular file: ${file}`);
    if (!overwrite) {
      throw new Error(`File already exists: ${file}. Choose another path${overwrite === null ? "" : " or pass overwrite:true"}.`);
    }
  }
  return { file, ext, overwrite: overwrite === true };
}

/** Writes `data` to `file`; without `overwrite` an existing file is never replaced (EEXIST). */
function writeOutputFile(file: string, data: Buffer, overwrite: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { flag: overwrite ? "w" : "wx" });
}

/** First free variant of `file` (adds a timestamp before the extension when taken). */
function freePath(file: string): string {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.${Date.now()}${ext}`;
}

/** Saves to a fresh private (0700) temp directory; used when a result is too large to return inline. */
function saveToPrivateTemp(data: Buffer, baseName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-"));
  const file = path.join(dir, baseName);
  fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
  return file;
}

function baseMimeType(mime: string | undefined, fallback: string): string {
  const base = String(mime ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]+$/.test(base) ? base : fallback;
}

server.tool(
  "page_pdf",
  "Render the tab to PDF. Returned as an embedded application/pdf resource, or written to savePath. Slower; for visuals prefer page_screenshot.",
  {
    tabId: TabId,
    savePath: z.string().optional().describe("Absolute .pdf path to write the file to (an existing file is never overwritten). Omit to return the PDF as an embedded resource."),
  },
  STATE_CHANGE,
  async ({ tabId, savePath }) => {
    const target = savePath ? checkSavePath(savePath, [".pdf"], null) : null;
    const r = (await bridge.send("page_pdf", {}, tabId, 60000)) as {
      tabId?: number;
      dataBase64?: string;
      data?: string;
      [key: string]: unknown;
    };
    const base64 = typeof r?.dataBase64 === "string" ? r.dataBase64 : typeof r?.data === "string" ? r.data : null;
    if (!base64) return textResult(r);
    const pdfTabId = typeof r.tabId === "number" ? r.tabId : tabId;
    const buffer = Buffer.from(base64, "base64");
    if (target) {
      writeOutputFile(target.file, buffer, false);
      return textResult({ ok: true, tabId: pdfTabId, sizeBytes: buffer.length, savedTo: target.file, format: "pdf" });
    }
    const fileName = `tab-${pdfTabId ?? "active"}-${Date.now()}.pdf`;
    if (buffer.length > INLINE_BINARY_MAX_BYTES) {
      const file = saveToPrivateTemp(buffer, fileName);
      return textResult({
        ok: true,
        tabId: pdfTabId,
        sizeBytes: buffer.length,
        savedTo: file,
        format: "pdf",
        note: "PDF too large to return inline; saved to a private temp file. Pass savePath to choose the location.",
      });
    }
    const result: CallToolResult = {
      content: [
        {
          type: "resource",
          resource: { uri: `browser://pdf/${fileName}`, mimeType: "application/pdf", blob: base64 },
        },
        {
          type: "text",
          text: JSON.stringify({ ok: true, tabId: pdfTabId, sizeBytes: buffer.length, mimeType: "application/pdf", note: "PDF returned as an embedded resource" }),
        },
      ],
    };
    return result;
  }
);

// ---------- tab audio recording ----------
const AUDIO_EXTS = [".webm", ".ogg", ".opus", ".mp3", ".wav", ".m4a", ".aac", ".flac"] as const;
const AUDIO_SAVE_PATH_DESC = `Absolute file path to save the recording (${AUDIO_EXTS.join(" ")}; formats other than .webm need ffmpeg via FFMPEG_PATH or PATH). An existing file is only replaced with overwrite:true.`;

/** Regular file that the OS can execute (directories, .cmd shims and non-executables are rejected). */
function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates ffmpeg from the FFMPEG_PATH env var, PATH, or well-known install
 * locations. There is deliberately no per-call override: a tool argument must
 * never choose which executable this process spawns.
 */
function resolveFfmpeg(): { path: string } | { path: null; error: string } {
  const isWin = process.platform === "win32";
  let envNote = "";
  const envPath = process.env.FFMPEG_PATH?.trim();
  if (envPath) {
    if (isExecutableFile(envPath)) return { path: envPath };
    envNote = ` FFMPEG_PATH (${envPath}) is not an executable file and was ignored.`;
  }

  // Search system PATH (spawn without a shell can only run real executables).
  const exeName = isWin ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    const full = path.join(trimmed, exeName);
    if (isExecutableFile(full)) return { path: full };
  }

  // Standard OS package manager install paths
  const candidates = isWin
    ? ([
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
        process.env.USERPROFILE && path.join(process.env.USERPROFILE, "scoop", "shims", "ffmpeg.exe"),
        process.env.ProgramData && path.join(process.env.ProgramData, "chocolatey", "bin", "ffmpeg.exe"),
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
      ].filter(Boolean) as string[])
    : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/pkg/bin/ffmpeg"];
  for (const c of candidates) {
    if (isExecutableFile(c)) return { path: c };
  }

  return {
    path: null,
    error: `ffmpeg binary was not found in PATH or FFMPEG_PATH.${envNote} Install FFmpeg (e.g. winget install Gyan.FFmpeg / brew install ffmpeg) or set FFMPEG_PATH to enable audio format conversion.`,
  };
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {}
}

/**
 * Converts the recorded webm into `outputPath` (format from its extension).
 * ffmpeg writes to a temp file next to the target that is renamed on success,
 * so a failed conversion never leaves a partial file or clobbers the target.
 */
async function convertAudioFile(
  input: Buffer,
  outputPath: string,
  overwrite: boolean,
  durationMs?: number
): Promise<{ success: true } | { success: false; error: string }> {
  const ff = resolveFfmpeg();
  if (ff.path === null) return { success: false, error: ff.error };
  const ffmpegBin = ff.path;

  const ext = path.extname(outputPath).toLowerCase();
  const stamp = `${process.pid}-${Date.now()}`;
  const tempIn = `${outputPath}.${stamp}.in.webm`;
  const tempOut = `${outputPath}.${stamp}.tmp${ext}`;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(tempIn, input, { flag: "wx" });
  } catch (e) {
    unlinkQuiet(tempIn);
    return { success: false, error: `cannot write temp input: ${errMessage(e)}` };
  }

  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", tempIn, "-vn"];
  if (ext === ".mp3") args.push("-c:a", "libmp3lame", "-q:a", "2");
  args.push(tempOut);
  // Generous but bounded: conversion is much faster than real time.
  const killAfterMs = Math.min(30 * 60_000, 120_000 + Math.max(0, durationMs ?? 0));

  const run = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    let stderrTail = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      // stdin/stdout ignored, stderr drained (a full pipe would stall ffmpeg).
      proc = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: errMessage(e) });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, killAfterMs);
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    proc.on("error", (err) => finish({ ok: false, error: err.message }));
    proc.on("close", (code, signal) => {
      if (code === 0 && !timedOut) return finish({ ok: true });
      const why = timedOut
        ? `ffmpeg timed out after ${Math.round(killAfterMs / 1000)}s`
        : `ffmpeg exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`;
      const tail = stderrTail.trim().split(/\r?\n/).slice(-8).join(" | ").slice(-1000);
      finish({ ok: false, error: tail ? `${why}: ${tail}` : why });
    });
  });

  unlinkQuiet(tempIn);
  if (!run.ok) {
    unlinkQuiet(tempOut);
    return { success: false, error: run.error ?? "ffmpeg failed" };
  }
  try {
    if (fs.existsSync(outputPath)) {
      if (!overwrite) throw new Error(`${outputPath} was created by someone else meanwhile`);
      fs.unlinkSync(outputPath);
    }
    fs.renameSync(tempOut, outputPath);
    return { success: true };
  } catch (e) {
    unlinkQuiet(tempOut);
    return { success: false, error: errMessage(e) };
  }
}

type AudioStopResult = {
  ok?: boolean;
  tabId?: number;
  base64?: string;
  mimeType?: string;
  durationMs?: number;
  sizeBytes?: number;
  [key: string]: unknown;
};

/**
 * Shared tail of tab_audio_record_stop / tab_audio_capture: save to savePath
 * (converting with ffmpeg when needed) or return an MCP audio content block.
 * The recording is already released in the extension at this point, so every
 * failure path still persists the audio somewhere and reports where.
 */
async function finishRecording(res: AudioStopResult, target: SaveTarget | null): Promise<CallToolResult> {
  if (!res || typeof res.base64 !== "string" || !res.base64) {
    return textResult(res ?? { ok: false, error: "Empty response from tab_audio_record_stop" });
  }
  const buffer = Buffer.from(res.base64, "base64");
  const meta = { ok: true, tabId: res.tabId, durationMs: res.durationMs };
  const rescue = (why: string) => {
    const file = saveToPrivateTemp(buffer, `tab-${res.tabId ?? "audio"}-${Date.now()}.webm`);
    return textResult({ ...meta, sizeBytes: buffer.length, savedTo: file, format: "webm", saveError: why });
  };

  if (target) {
    if (target.ext === ".webm") {
      try {
        writeOutputFile(target.file, buffer, target.overwrite);
      } catch (e) {
        return rescue(`Could not write ${target.file}: ${errMessage(e)}. Saved to a private temp file instead.`);
      }
      return textResult({ ...meta, sizeBytes: buffer.length, savedTo: target.file, format: "webm" });
    }
    const conv = await convertAudioFile(buffer, target.file, target.overwrite, res.durationMs);
    if (conv.success) {
      return textResult({
        ...meta,
        sizeBytes: fs.statSync(target.file).size,
        savedTo: target.file,
        format: target.ext.slice(1),
      });
    }
    const fallback = freePath(`${target.file}.webm`);
    try {
      writeOutputFile(fallback, buffer, false);
    } catch (e) {
      return rescue(`Failed to convert to ${target.ext} (${conv.error}) and could not write ${fallback}: ${errMessage(e)}.`);
    }
    return textResult({
      ...meta,
      sizeBytes: buffer.length,
      savedTo: fallback,
      format: "webm",
      conversionWarning: `Failed to convert to ${target.ext}: ${conv.error}. Saved raw webm instead.`,
    });
  }

  if (buffer.length > INLINE_BINARY_MAX_BYTES) {
    const file = saveToPrivateTemp(buffer, `tab-${res.tabId ?? "audio"}-${Date.now()}.webm`);
    return textResult({
      ...meta,
      sizeBytes: buffer.length,
      mimeType: res.mimeType,
      savedTo: file,
      format: "webm",
      note: "Recording too large to return inline; saved to a private temp file. Pass savePath to choose the location.",
    });
  }
  return {
    content: [
      { type: "audio", data: res.base64, mimeType: baseMimeType(res.mimeType, "audio/webm") },
      {
        type: "text",
        text: JSON.stringify({ ...meta, sizeBytes: res.sizeBytes ?? buffer.length, mimeType: res.mimeType, note: "Audio returned as an MCP audio content block" }),
      },
    ],
  };
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Sleeps for `totalMs`, emitting MCP progress notifications when the client
 * asked for them, and resolves early (with `true`) when the request is cancelled.
 */
function waitWithProgress(totalMs: number, extra: ToolExtra): Promise<boolean> {
  const signal = extra.signal;
  const progressToken = extra._meta?.progressToken;
  const startedAt = Date.now();
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    let ticker: ReturnType<typeof setInterval> | undefined;
    const done = (aborted: boolean) => {
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    const onAbort = () => done(true);
    const timer = setTimeout(() => done(false), totalMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (progressToken !== undefined) {
      ticker = setInterval(() => {
        const elapsed = Math.min(Date.now() - startedAt, totalMs);
        extra
          .sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: elapsed,
              total: totalMs,
              message: `Recording ${Math.round(elapsed / 1000)}s / ${Math.round(totalMs / 1000)}s`,
            },
          })
          .catch(() => {});
      }, 5000);
    }
  });
}

server.tool(
  "tab_audio_record_start",
  "Start capturing/recording audio from a browser tab (e.g. while Spotify, YouTube, or web audio plays). Does not block; use tab_audio_record_stop to stop and collect the audio.",
  {
    tabId: TabId,
    passthrough: z.boolean().optional().describe("Whether to keep playing audio through speakers while recording (default true)"),
  },
  STATE_CHANGE,
  async ({ tabId, passthrough }) => {
    const r = await bridge.send("tab_audio_record_start", { passthrough: passthrough !== false }, tabId);
    return textResult(r);
  }
);

server.tool(
  "tab_audio_record_stop",
  "Stop an ongoing tab audio recording and return it as an MCP audio block or save it to disk (.webm natively; .mp3 .wav .ogg .opus .m4a .aac .flac via ffmpeg). Omit tabId to stop the only active recording.",
  {
    tabId: z.number().int().optional().describe("Tab ID of the recording. Omit when exactly one recording is active."),
    savePath: z.string().optional().describe(AUDIO_SAVE_PATH_DESC),
    overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
  },
  DESTRUCTIVE,
  async ({ tabId, savePath, overwrite }) => {
    // Validate before stopping: a bad path must not cost the recording.
    const target = savePath ? checkSavePath(savePath, AUDIO_EXTS, overwrite === true) : null;
    const res = await bridge.send<AudioStopResult>("tab_audio_record_stop", {}, tabId, 120000);
    return finishRecording(res, target);
  }
);

server.tool(
  "tab_audio_capture",
  "Record tab audio for a specified duration in seconds (convenience tool for songs, clips, etc.). Starts recording, waits for the duration (with progress notifications; cancelling stops early), stops the same tab, and saves or returns the audio.",
  {
    durationSeconds: z.number().positive().max(3600).describe("Recording duration in seconds (e.g. 30, 252)"),
    tabId: TabId,
    savePath: z.string().optional().describe(AUDIO_SAVE_PATH_DESC),
    passthrough: z.boolean().optional().describe("Whether to keep playing audio through speakers while recording (default true)"),
    overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
  },
  DESTRUCTIVE,
  async ({ durationSeconds, tabId, savePath, passthrough, overwrite }, extra) => {
    const target = savePath ? checkSavePath(savePath, AUDIO_EXTS, overwrite === true) : null;
    const started = await bridge.send<{ tabId?: number }>("tab_audio_record_start", { passthrough: passthrough !== false }, tabId);
    // Stop exactly the tab that was started, even if the active tab changed meanwhile.
    const recordingTabId = typeof started?.tabId === "number" ? started.tabId : tabId;
    const totalMs = Math.round(durationSeconds * 1000);
    // Never rejects; resolves early (true) when the client cancels the call.
    const cancelled = await waitWithProgress(totalMs, extra);
    // Always stop (and so release) the recording, also after a cancellation.
    const res = await bridge.send<AudioStopResult>("tab_audio_record_stop", {}, recordingTabId, totalMs + 60000);
    if (cancelled) {
      // The client no longer waits for a result: keep the partial audio only if a path was given.
      const saved = target ? await finishRecording(res, target).catch(() => null) : null;
      return saved ?? textResult({ ok: false, cancelled: true, tabId: recordingTabId });
    }
    return finishRecording(res, target);
  }
);

// ---------- js / console ----------
type CdpEvalResult = {
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
};

server.tool(
  "js_evaluate",
  "Run JavaScript in the page via CDP (bypasses page CSP). Supports `return` statements and top-level await (with awaitPromise). Values must be JSON-serializable.",
  {
    expression: z.string().describe("JS to run: bare expression (2+2) or statements with return. Top-level await needs awaitPromise:true."),
    tabId: TabId,
    awaitPromise: z.boolean().optional().describe("Await promises/top-level await before returning"),
  },
  POWER,
  async ({ expression, tabId, awaitPromise }) => {
    try {
      const r = await bridge.send(
        "js_evaluate",
        { expression, awaitPromise },
        tabId
      );
      return textResult(r);
    } catch (e) {
      // Old extensions (<0.3.4) evaluated via content-script new Function,
      // blocked by the extension CSP (no 'unsafe-eval'), or answered with the
      // "handled via CDP" stub: in both cases the code never ran. Fallback
      // keeps them working: Runtime.evaluate over the debugger (unaffected by CSP).
      // An error raised by the user's code itself ("Page JS error: ...", even
      // one that mentions CSP) means it may already have run: never re-run it.
      const msg = errMessage(e);
      if (/^\s*Page JS error/i.test(msg) || !/Content Security Policy|unsafe-eval|Evaluating a string|handled via CDP/i.test(msg)) {
        throw e;
      }
      const cdp = (method: string, params: Record<string, unknown>) =>
        bridge.send<CdpEvalResult>("cdp_send", { method, params }, tabId, 30000);
      // Pick bare vs function-body semantics BEFORE running anything, with a
      // side-effect-free compile check, so the code executes exactly once.
      // (`return` / top-level await only compile inside the async wrapper.)
      let wrap = false;
      try {
        const compiled = await cdp("Runtime.compileScript", { expression, sourceURL: "", persistScript: false });
        wrap = !!compiled?.result?.exceptionDetails;
      } catch {
        wrap = false;
      }
      const out = await cdp("Runtime.evaluate", {
        expression: wrap ? `(async () => { ${expression} })()` : expression,
        awaitPromise: wrap ? true : (awaitPromise ?? false),
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      if (out?.result?.exceptionDetails) {
        throw new Error(`Page JS error: ${JSON.stringify(out.result.exceptionDetails).slice(0, 500)}`);
      }
      const inner = out?.result?.result;
      return textResult({ value: inner?.value, via: "cdp-fallback" });
    }
  }
);

server.tool(
  "console_get",
  "Read captured page console logs (filter by level and tab). Falls back to this server's local event buffer, with a warning, when the extension is unreachable.",
  {
    level: z.enum(["all", "log", "info", "warn", "error", "debug"]).optional().describe("Log level filter (default all)"),
    limit: limitParam(5000, "Max entries from the tail (default 200)"),
    tabId: TabIdAllTabs,
  },
  READ_ONLY,
  async ({ level, limit, tabId }) => {
    // Ask the extension for fresh data first, fall back to the bridge buffer
    try {
      const r = await bridge.send("console_get", { level, limit, tabId }, tabId);
      return textResult(r);
    } catch (e) {
      // Permission denials must surface (not silently downgrade to the buffer).
      if (isPermissionError(e)) throw e;
      assertNotKnownDisabled("console_get");
      const lvl = level ?? "all";
      const lim = limit ?? 200;
      const logs = (bridge.consoleEvents as Array<Record<string, unknown>>)
        .filter((x) => tabId === undefined || x?.tabId === tabId)
        .filter((x) => lvl === "all" || x?.level === lvl)
        .slice(-lim);
      return textResult({ source: "bridge-buffer", warning: bufferFallbackWarning(e), count: logs.length, logs });
    }
  }
);

server.tool("console_clear", "Clear captured console logs (extension + local buffer).", {}, DESTRUCTIVE_IDEMPOTENT, async () => {
  try {
    const r = await bridge.send("console_clear", {});
    bridge.consoleEvents.length = 0;
    return textResult(r);
  } catch (e) {
    if (isPermissionError(e)) throw e;
    assertNotKnownDisabled("console_clear");
    bridge.consoleEvents.length = 0;
    return textResult({
      ok: true,
      source: "bridge-buffer",
      warning: `Extension unreachable (${errMessage(e)}): only this server's local buffer was cleared.`,
    });
  }
});

// ---------- network ----------
server.tool(
  "network_requests",
  "List captured HTTP network requests with optional filters. Falls back to this server's local event buffer, with a warning, when the extension is unreachable.",
  {
    filter: z.string().optional().describe("URL substring filter"),
    type: z.string().optional().describe("Resource type: document, xhr, fetch, image, script..."),
    failedOnly: z.boolean().optional().describe("Only return failed requests (status >= 400 or network error)"),
    minStatus: z.number().int().min(100).max(599).optional().describe("Minimum HTTP status code (e.g. 400 for errors)"),
    limit: limitParam(5000, "Max number of requests to return (default 200)"),
    tabId: TabIdAllTabs,
  },
  READ_ONLY,
  async ({ filter, type, failedOnly, minStatus, limit, tabId }) => {
    try {
      const r = await bridge.send("network_requests", { filter, type, failedOnly, minStatus, limit, tabId });
      return textResult(r);
    } catch (e) {
      if (isPermissionError(e)) throw e;
      assertNotKnownDisabled("network_requests");
      let arr = bridge.networkEvents as Array<Record<string, unknown>>;
      if (tabId !== undefined) arr = arr.filter((x) => x?.tabId === tabId);
      if (filter) arr = arr.filter((x) => String(x?.url ?? "").includes(filter));
      if (type) arr = arr.filter((x) => x?.type === type);
      if (failedOnly) arr = arr.filter((x) => (typeof x?.statusCode === "number" && x.statusCode >= 400) || x?.phase === "error");
      if (minStatus !== undefined) arr = arr.filter((x) => typeof x?.statusCode === "number" && x.statusCode >= minStatus);
      arr = arr.slice(-(limit ?? 200));
      return textResult({ source: "bridge-buffer", warning: bufferFallbackWarning(e), count: arr.length, requests: arr });
    }
  }
);

server.tool("network_clear", "Clear captured network logs (extension + local buffer).", {}, DESTRUCTIVE_IDEMPOTENT, async () => {
  try {
    const r = await bridge.send("network_clear", {});
    bridge.networkEvents.length = 0;
    return textResult(r);
  } catch (e) {
    // Mirror console_clear: a disabled switch must surface, not report ok.
    if (isPermissionError(e)) throw e;
    assertNotKnownDisabled("network_clear");
    bridge.networkEvents.length = 0;
    return textResult({
      ok: true,
      source: "bridge-buffer",
      warning: `Extension unreachable (${errMessage(e)}): only this server's local buffer was cleared.`,
    });
  }
});

server.tool(
  "network_response_body",
  "Re-fetch a recorded GET request's body in page context (webRequest exposes no bodies; the request is sent again, non-GET entries are refused). For exact bodies use network_mock_start + network_bodies. Needs a requestId from network_requests.",
  {
    requestId: z.string().describe("requestId from network_requests"),
    tabId: TabId,
  },
  READ_PAGE,
  async ({ requestId, tabId }) => {
    const r = await bridge.send("network_response_body", { requestId }, tabId, 30000);
    return textResult(r);
  }
);

server.tool(
  "network_throttle",
  "Emulate network conditions (slow 3G, fast 3G, offline, custom) via CDP. The override stays active (debugger kept attached) until profile 'online' clears it.",
  {
    profile: z.enum(["online", "slow3g", "fast3g", "offline", "custom"]).describe("Throttling profile ('online' removes throttling)"),
    latency: z.number().nonnegative().max(600000).optional().describe("Custom latency in ms (only for profile: custom)"),
    downloadThroughput: z.number().min(-1).optional().describe("Custom download throughput in bytes/s, -1 = unlimited (only for profile: custom)"),
    uploadThroughput: z.number().min(-1).optional().describe("Custom upload throughput in bytes/s, -1 = unlimited (only for profile: custom)"),
    tabId: TabId,
  },
  STATE_SET,
  async ({ profile, latency, downloadThroughput, uploadThroughput, tabId }) => {
    const r = await bridge.send("network_throttle", { profile, latency, downloadThroughput, uploadThroughput }, tabId);
    return textResult(r);
  }
);

server.tool(
  "network_set_headers",
  "Set extra HTTP request headers attached to all requests in the tab. They stay active (debugger kept attached) until cleared by passing an empty object {}.",
  {
    headers: z.record(z.string(), z.string()).describe("Key-value header dictionary (e.g. Authorization, User-Agent); {} clears"),
    tabId: TabId,
  },
  STATE_SET,
  async ({ headers, tabId }) => {
    const r = await bridge.send("network_set_headers", { headers }, tabId);
    return textResult(r);
  }
);

// ---------- cookies ----------
// "unspecified" is what chrome.cookies reports for cookies set without a
// SameSite attribute, so cookies_export output must round-trip through it.
const CookieSameSite = z
  .enum(["no_restriction", "lax", "strict", "unspecified"])
  .optional()
  .describe("SameSite attribute ('unspecified' = no attribute)");

server.tool(
  "cookies_list",
  "List cookies filtered by domain, url, or name",
  {
    domain: z.string().optional().describe("Domain filter"),
    url: z.string().optional().describe("URL filter (e.g. https://example.com)"),
    name: z.string().optional().describe("Cookie name filter"),
  },
  READ_ONLY,
  async ({ domain, url, name }) => {
    const r = await bridge.send("cookies_list", { domain, url, name });
    return textResult(r);
  }
);

server.tool(
  "cookies_get",
  "Get a specific cookie by URL and name",
  {
    url: z.string().describe("URL of the cookie (e.g. https://example.com)"),
    name: z.string().describe("Name of the cookie"),
  },
  READ_ONLY,
  async ({ url, name }) => {
    const r = await bridge.send("cookies_get", { url, name });
    return textResult(r);
  }
);

server.tool(
  "cookies_set",
  "Set or update a browser cookie",
  {
    name: z.string().describe("Cookie name"),
    value: z.string().describe("Cookie value"),
    url: z.string().describe("URL the cookie belongs to (e.g. https://example.com)"),
    domain: z.string().optional().describe("Cookie domain"),
    path: z.string().optional().describe("Cookie path (defaults to /)"),
    secure: z.boolean().optional().describe("Whether the cookie is secure-only"),
    httpOnly: z.boolean().optional().describe("Whether the cookie is HTTP-only"),
    sameSite: CookieSameSite,
    expirationDate: z.number().positive().optional().describe("Unix timestamp (seconds) for cookie expiry; omit for a session cookie"),
  },
  DESTRUCTIVE_IDEMPOTENT,
  async (args) => {
    const r = await bridge.send("cookies_set", args);
    return textResult(r);
  }
);

server.tool(
  "cookies_delete",
  "Delete a specific cookie by URL and name",
  {
    url: z.string().describe("URL of the cookie (e.g. https://example.com)"),
    name: z.string().describe("Name of the cookie to remove"),
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ url, name }) => {
    const r = await bridge.send("cookies_delete", { url, name });
    return textResult(r);
  }
);

server.tool(
  "cookies_clear",
  "Delete all cookies for a domain or URL (irreversible). Clearing every cookie in the browser requires an explicit all:true.",
  {
    domain: z.string().optional().describe("Domain to clear cookies for"),
    url: z.string().optional().describe("URL to clear cookies for"),
    all: z.boolean().optional().describe("true: delete EVERY cookie of every site (only when no domain/url is given)"),
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ domain, url, all }) => {
    const d = domain?.trim() || undefined;
    const u = url?.trim() || undefined;
    // An empty (or misspelled, hence stripped) filter must never mean "everything".
    if (!d && !u && all !== true) {
      throw new Error("cookies_clear needs a domain or url filter; pass all:true to delete every cookie in the browser");
    }
    const r = await bridge.send("cookies_clear", d || u ? { domain: d, url: u } : { all: true });
    return textResult(r);
  }
);

server.tool(
  "cookies_export",
  "Export all cookies for a domain or URL as a portable JSON array",
  {
    domain: z.string().optional().describe("Domain to export cookies from"),
    url: z.string().optional().describe("URL to export cookies from"),
  },
  READ_ONLY,
  async ({ domain, url }) => {
    const r = await bridge.send("cookies_export", { domain, url });
    return textResult(r);
  }
);

server.tool(
  "cookies_import",
  "Import an array of cookies into the browser",
  {
    cookies: z.array(
      z.object({
        name: z.string().describe("Cookie name"),
        value: z.string().describe("Cookie value"),
        url: z.string().optional().describe("URL the cookie belongs to (built from domain/path if omitted)"),
        domain: z.string().optional().describe("Cookie domain"),
        path: z.string().optional().describe("Cookie path (defaults to /)"),
        secure: z.boolean().optional().describe("Secure-only flag"),
        httpOnly: z.boolean().optional().describe("HTTP-only flag"),
        sameSite: CookieSameSite,
        expirationDate: z.number().positive().optional().describe("Unix timestamp (seconds) for cookie expiry"),
        hostOnly: z.boolean().optional().describe("From cookies_export: true = host-only cookie (no Domain attribute)"),
      })
    ).describe("Array of cookie objects to set (cookies_export output is accepted as-is)"),
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ cookies }) => {
    const r = await bridge.send("cookies_import", { cookies });
    return textResult(r);
  }
);

// ---------- sessions & state ----------
server.tool(
  "sessions_recently_closed",
  "List recently closed tabs and windows",
  {
    maxResults: limitParam(25, "Maximum number of entries to return (default 25, max 25)"),
  },
  READ_ONLY,
  async ({ maxResults }) => {
    const r = await bridge.send("sessions_recently_closed", { maxResults });
    return textResult(r);
  }
);

server.tool(
  "sessions_restore",
  "Restore a recently closed tab or window by its session ID (or the most recent if omitted)",
  {
    sessionId: z.string().optional().describe("Session ID from sessions_recently_closed. Omit for the most recently closed."),
  },
  NAVIGATE,
  async ({ sessionId }) => {
    const r = await bridge.send("sessions_restore", { sessionId });
    return textResult(r);
  }
);

server.tool(
  "session_state_save",
  "Capture an entire session profile (cookies + localStorage + sessionStorage) for the active tab domain",
  {
    tabId: TabId,
  },
  READ_ONLY,
  async ({ tabId }) => {
    const r = await bridge.send("session_state_save", {}, tabId);
    return textResult(r);
  }
);

server.tool(
  "session_state_load",
  "Restore an entire session profile (cookies + localStorage + sessionStorage) from a saved state bundle",
  {
    state: z.record(z.string(), z.unknown()).describe("Saved session state object from session_state_save"),
    tabId: TabId,
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ state, tabId }) => {
    const r = await bridge.send("session_state_load", { state }, tabId);
    return textResult(r);
  }
);

// ---------- storage ----------
server.tool(
  "storage_get",
  "Read all localStorage/sessionStorage entries of the page (values over 2000 chars truncated unless full:true).",
  {
    area: z.enum(["local", "session"]).optional().describe("Storage area (default local)"),
    full: z.boolean().optional().describe("true: return complete values (no 2000-char display truncation)"),
    tabId: TabId,
  },
  READ_PAGE,
  async ({ area, full, tabId }) => {
    const r = await bridge.send("storage_get", { area: area ?? "local", full }, tabId);
    return textResult(r);
  }
);
server.tool(
  "storage_set",
  "Write one storage entry (string values only).",
  {
    key: z.string().describe("Storage key"),
    value: z.string().describe("String value to store"),
    area: z.enum(["local", "session"]).optional().describe("Storage area (default local)"),
    tabId: TabId,
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ key, value, area, tabId }) => {
    const r = await bridge.send(
      "storage_set",
      { key, value, area: area ?? "local" },
      tabId
    );
    return textResult(r);
  }
);

// ---------- IndexedDB ----------
server.tool("idb_list", "List IndexedDB databases on the page (name + version).", { tabId: TabId }, READ_PAGE, async ({ tabId }) => {
  const r = await bridge.send("idb_list", {}, tabId);
  return textResult(r);
});

server.tool(
  "idb_stores",
  "List object stores of an IndexedDB database.",
  { db: z.string().describe("Database name (see idb_list)"), tabId: TabId },
  READ_PAGE,
  async ({ db, tabId }) => {
    const r = await bridge.send("idb_stores", { db }, tabId);
    return textResult(r);
  }
);

server.tool(
  "idb_read",
  "Read IndexedDB rows (values truncated for AI readability).",
  {
    db: z.string().describe("Database name (see idb_list)"),
    store: z.string().describe("Object store name (see idb_stores)"),
    limit: limitParam(1000, "Max rows when reading all (default 50, max 1000)"),
    key: z.unknown().optional().describe("Omit to read all (up to limit)"),
    tabId: TabId,
  },
  READ_PAGE,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("idb_read", payload, tabId);
    return textResult(r);
  }
);

server.tool(
  "idb_count",
  "Count rows in an IndexedDB object store.",
  {
    db: z.string().describe("Database name (see idb_list)"),
    store: z.string().describe("Object store name (see idb_stores)"),
    tabId: TabId,
  },
  READ_PAGE,
  async ({ db, store, tabId }) => {
    const r = await bridge.send("idb_count", { db, store }, tabId);
    return textResult(r);
  }
);

server.tool(
  "idb_put",
  "Insert or update an IndexedDB row (returns the key).",
  {
    db: z.string().describe("Database name (see idb_list)"),
    store: z.string().describe("Object store name (see idb_stores)"),
    value: z.unknown().describe("Row value to store"),
    key: z.unknown().optional().describe("Key (omit for auto-keyed stores)"),
    tabId: TabId,
  },
  DESTRUCTIVE,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("idb_put", payload, tabId);
    return textResult(r);
  }
);

server.tool(
  "idb_delete",
  "Delete one IndexedDB row by key.",
  {
    db: z.string().describe("Database name (see idb_list)"),
    store: z.string().describe("Object store name (see idb_stores)"),
    key: z.unknown().describe("Key of the row to delete"),
    tabId: TabId,
  },
  DESTRUCTIVE_IDEMPOTENT,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("idb_delete", payload, tabId);
    return textResult(r);
  }
);

server.tool(
  "idb_clear",
  "Delete ALL rows in an IndexedDB object store (destructive).",
  {
    db: z.string().describe("Database name (see idb_list)"),
    store: z.string().describe("Object store name (see idb_stores)"),
    tabId: TabId,
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ db, store, tabId }) => {
    const r = await bridge.send("idb_clear", { db, store }, tabId);
    return textResult(r);
  }
);

// ---------- history ----------
server.tool(
  "history_search",
  "Search browser history by query text (all of history by default, not only the last 24 hours).",
  {
    query: z.string().describe("Search text (empty string matches every page)"),
    limit: limitParam(10000, "Max results (default 20)"),
    maxResults: limitParam(10000, "Alias of limit (Chrome API name); wins when both are given"),
    startTime: z
      .number()
      .nonnegative()
      .optional()
      .describe("Only visits at or after this time (ms since epoch). Default 0 = all history (Chrome's own default would be the last 24 hours)."),
  },
  READ_ONLY,
  async ({ query, limit, maxResults, startTime }) => {
    const max = maxResults ?? limit ?? 20;
    const r = await bridge.send("history_search", { query, limit: max, maxResults: max, startTime: startTime ?? 0 });
    return textResult(r);
  }
);

server.tool(
  "history_delete",
  "Delete a URL, all history, or a time range from the browser history",
  {
    url: z.string().optional().describe("URL to remove from history"),
    all: z.boolean().optional().describe("Set to true to clear all browser history"),
    startTime: z.number().nonnegative().optional().describe("Start time (ms since epoch) for range deletion"),
    endTime: z.number().nonnegative().optional().describe("End time (ms since epoch) for range deletion"),
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ url, all, startTime, endTime }) => {
    const r = await bridge.send("history_delete", { url, all, startTime, endTime });
    return textResult(r);
  }
);

// ---------- network mock / block (debugger Fetch domain) ----------
server.tool("network_mock_start", "Attach the debugger and start intercepting requests. Spy mode: without routes, unmatched traffic passes through while bodies are recorded.", { tabId: TabId }, STATE_SET, async ({ tabId }) => {
  const r = await bridge.send("network_mock_start", {}, tabId);
  return textResult(r);
});

server.tool("network_mock_stop", "End interception for the tab (the debugger detaches once no other override, e.g. throttling or geolocation, still needs it).", { tabId: TabId }, STATE_SET, async ({ tabId }) => {
  const r = await bridge.send("network_mock_stop", {}, tabId);
  return textResult(r);
});

server.tool(
  "network_mock_route",
  "Add a block/fulfill/delay rule for matching URLs. Requires network_mock_start first.",
  {
    pattern: z.string().describe("URL pattern, * wildcard (e.g. *ads* or https://api.example.com/*)"),
    action: z.enum(["block", "fulfill", "delay"]).describe("block: drop, fulfill: return a mock response, delay: hold then pass through"),
    status: z.number().int().min(100).max(599).optional().describe("HTTP code for fulfill (default 200)"),
    body: z.string().optional().describe("Body for fulfill"),
    contentType: z.string().optional().describe("Content-Type for fulfill (default application/json)"),
    delayMs: z.number().int().nonnegative().max(600000).optional().describe("Hold time in ms for delay"),
    headers: z
      .array(z.object({ name: z.string().describe("Header name"), value: z.string().describe("Header value") }))
      .optional()
      .describe("fulfill: added to the mock response headers. delay: merged into the original request headers (a same-name header is replaced, all others are kept)."),
    tabId: TabId,
  },
  STATE_CHANGE,
  async (args) => {
    const { tabId, ...route } = args;
    const r = await bridge.send("network_mock_route", route, tabId);
    return textResult(r);
  }
);

server.tool("network_mock_list", "List active mock routes and session state.", { tabId: TabId }, READ_ONLY, async ({ tabId }) => {
  const r = await bridge.send("network_mock_list", {}, tabId);
  return textResult(r);
});

server.tool(
  "network_mock_remove",
  "Remove one mock route by ID.",
  { routeId: z.string().describe("Route ID from network_mock_list"), tabId: TabId },
  STATE_SET,
  async ({ routeId, tabId }) => {
    const r = await bridge.send("network_mock_remove", { routeId }, tabId);
    return textResult(r);
  }
);

server.tool("network_mock_clear", "Remove all mock routes (keeps the interception session attached).", { tabId: TabId }, STATE_SET, async ({ tabId }) => {
  const r = await bridge.send("network_mock_clear", {}, tabId);
  return textResult(r);
});

// ---------- downloads ----------
server.tool(
  "downloads_list",
  "List recent downloads with state, progress and errors.",
  { limit: limitParam(1000, "Max entries (default 50)") },
  READ_ONLY,
  async ({ limit }) => {
    const r = await bridge.send("downloads_list", { limit: limit ?? 50 });
    return textResult(r);
  }
);

server.tool("downloads_pause", "Pause an in-progress download.", { id: z.number().int().describe("Download ID from downloads_list") }, STATE_SET, async ({ id }) => {
  const r = await bridge.send("downloads_pause", { id });
  return textResult(r);
});

server.tool("downloads_resume", "Resume a paused download.", { id: z.number().int().describe("Download ID from downloads_list") }, STATE_SET, async ({ id }) => {
  const r = await bridge.send("downloads_resume", { id });
  return textResult(r);
});

server.tool("downloads_cancel", "Cancel an in-progress download.", { id: z.number().int().describe("Download ID from downloads_list") }, DESTRUCTIVE_IDEMPOTENT, async ({ id }) => {
  const r = await bridge.send("downloads_cancel", { id });
  return textResult(r);
});

server.tool("downloads_erase", "Remove a finished download from history (keeps the file).", { id: z.number().int().describe("Download ID from downloads_list") }, DESTRUCTIVE_IDEMPOTENT, async ({ id }) => {
  const r = await bridge.send("downloads_erase", { id });
  return textResult(r);
});

// ---------- bookmarks ----------
server.tool("bookmarks_search", "Search bookmarks by title/URL.", { query: z.string().describe("Search text") }, READ_ONLY, async ({ query }) => {
  const r = await bridge.send("bookmarks_search", { query });
  return textResult(r);
});

server.tool(
  "bookmarks_list",
  "List bookmark children of a folder.",
  { parentId: z.string().optional().describe("Omit for the bookmarks bar") },
  READ_ONLY,
  async ({ parentId }) => {
    const r = await bridge.send("bookmarks_list", { parentId });
    return textResult(r);
  }
);

server.tool(
  "bookmarks_add",
  "Create a bookmark (returns its ID).",
  {
    title: z.string().describe("Bookmark title"),
    url: z.string().describe("Bookmark URL"),
    parentId: z.string().optional().describe("Parent folder ID (omit for default location)"),
  },
  STATE_CHANGE,
  async (args) => {
    const r = await bridge.send("bookmarks_add", args);
    return textResult(r);
  }
);

server.tool("bookmarks_remove", "Delete a bookmark by ID.", { id: z.string().describe("Bookmark ID") }, DESTRUCTIVE_IDEMPOTENT, async ({ id }) => {
  const r = await bridge.send("bookmarks_remove", { id });
  return textResult(r);
});

// ---------- file upload ----------
server.tool(
  "dom_upload",
  "Upload local files into an <input type=file> via CDP (fires input/change).",
  {
    selector: z.string().describe("selector/ref for the file input"),
    filePaths: z.array(z.string()).describe("Local file paths to upload"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ selector, filePaths, tabId }) => {
    const r = await bridge.send("dom_upload", { selector, filePaths }, tabId, 60000);
    return textResult(r);
  }
);

// ---------- dialogs ----------
server.tool(
  "dialog_policy",
  "Set auto-handling for JS dialogs: alert is swallowed, confirm/prompt auto-answered.",
  {
    accept: z.boolean().optional().describe("Auto-accept confirm/prompt"),
    promptText: z.string().optional().describe("Response text for prompt"),
    blockUnload: z.boolean().optional().describe("true: suppress beforeunload"),
  },
  STATE_SET,
  async (args) => {
    const r = await bridge.send("dialog_policy", args);
    return textResult(r);
  }
);

server.tool("dialog_get", "List captured dialogs (alert/confirm/prompt) with messages and responses. Capture is async: poll briefly after triggering.", { limit: limitParam(1000, "Max entries (default 50)") }, READ_ONLY, async ({ limit }) => {
  const r = await bridge.send("dialog_get", { limit: limit ?? 50 });
  return textResult(r);
});

server.tool("dialog_clear", "Clear captured dialog history.", {}, DESTRUCTIVE_IDEMPOTENT, async () => {
  const r = await bridge.send("dialog_clear", {});
  return textResult(r);
});

// ---------- HAR ----------
server.tool(
  "har_export",
  "Export captured traffic for a tab as HAR 1.2 (headers included, no bodies).",
  { tabId: TabId, limit: limitParam(5000, "Max entries (default 300)") },
  READ_ONLY,
  async ({ tabId, limit }) => {
    const r = await bridge.send("har_export", { limit: limit ?? 300 }, tabId, 60000);
    return textResult(r);
  }
);

// ---------- frames (iframe targeting) ----------
server.tool("frame_list", "List frames/iframes of a tab as { frameId, parentFrameId, url } (frameId 0 = main frame). Use frameId or a URL substring with frame_focus.", { tabId: TabId }, READ_ONLY, async ({ tabId }) => {
  const r = await bridge.send("frame_list", {}, tabId);
  return textResult(r);
});

server.tool(
  "frame_focus",
  "Route later DOM/page commands for the tab to one frame, chosen by frameId (exact) or URL substring. Returns the resolved { frameId, url }. Cleared by frame_clear or a main-frame navigation.",
  {
    frameId: z.number().int().nonnegative().optional().describe("Exact frameId from frame_list (preferred when several frames share a URL)"),
    frameUrl: z.string().optional().describe("URL substring of the target frame (from frame_list)"),
    tabId: TabId,
  },
  STATE_SET,
  async ({ frameId, frameUrl, tabId }) => {
    if (frameId === undefined && !frameUrl) throw new Error("frame_focus needs frameId or frameUrl (see frame_list)");
    const r = await bridge.send("frame_focus", { frameId, frameUrl }, tabId);
    return textResult(r);
  }
);

server.tool("frame_clear", "Clear iframe targeting (commands go to the main frame again).", { tabId: TabId }, STATE_SET, async ({ tabId }) => {
  const r = await bridge.send("frame_clear", {}, tabId);
  return textResult(r);
});

// ---------- tabs + windows ----------
server.tool(
  "tab_pin",
  "Pin/unpin a tab (omit to toggle).",
  { pinned: z.boolean().optional().describe("Omit to toggle"), tabId: TabId },
  STATE_CHANGE,
  async ({ pinned, tabId }) => {
    const r = await bridge.send("tab_pin", { pinned }, tabId);
    return textResult(r);
  }
);

server.tool(
  "tab_mute",
  "Mute/unmute a tab (omit to toggle).",
  { muted: z.boolean().optional().describe("Omit to toggle"), tabId: TabId },
  STATE_CHANGE,
  async ({ muted, tabId }) => {
    const r = await bridge.send("tab_mute", { muted }, tabId);
    return textResult(r);
  }
);

server.tool("window_list", "List windows with focus state and their tabs.", {}, READ_ONLY, async () => {
  const r = await bridge.send("window_list", {});
  return textResult(r);
});

server.tool(
  "window_create",
  "Open a new window, optionally at a URL.",
  { url: z.string().optional().describe("Initial URL (omit for blank page)") },
  NAVIGATE,
  async ({ url }) => {
    const r = await bridge.send("window_create", { url });
    return textResult(r);
  }
);

server.tool("window_focus", "Focus a window by ID.", { windowId: z.number().int().describe("Window ID from window_list") }, STATE_SET, async ({ windowId }) => {
  const r = await bridge.send("window_focus", { windowId });
  return textResult(r);
});

// ---------- accessibility tree ----------
server.tool("page_axtree", "Accessibility tree nodes (roles, names, values) for accessibility audits; very large pages are truncated.", { tabId: TabId }, READ_PAGE, async ({ tabId }) => {
  const r = await bridge.send("page_axtree", {}, tabId, 60000);
  return textResult(r);
});

// ---------- permissions + geolocation ----------
server.tool(
  "permissions_grant",
  "Allow/block a site permission (geolocation, camera...) for an origin via content settings.",
  {
    permission: z.enum(["geolocation", "notifications", "camera", "microphone", "popups", "javascript", "images", "cookies"]).describe("Permission type"),
    setting: z.enum(["allow", "block", "ask"]).optional().describe("Default allow"),
    origin: z.string().optional().describe("Omit for the active tab's origin (e.g. https://example.com)"),
    tabId: TabId,
  },
  STATE_SET,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("permissions_grant", payload, tabId);
    return textResult(r);
  }
);

server.tool(
  "emulation_geolocation",
  "Spoof geolocation for a tab via CDP (attaches the debugger while active).",
  {
    latitude: z.number().min(-90).max(90).describe("Latitude in degrees"),
    longitude: z.number().min(-180).max(180).describe("Longitude in degrees"),
    accuracy: z.number().nonnegative().optional().describe("Accuracy in meters (default 50)"),
    tabId: TabId,
  },
  STATE_SET,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("emulation_geolocation", payload, tabId);
    return textResult(r);
  }
);

server.tool("emulation_geolocation_clear", "Remove the geolocation override (detaches the debugger when idle).", { tabId: TabId }, STATE_SET, async ({ tabId }) => {
  const r = await bridge.send("emulation_geolocation_clear", {}, tabId);
  return textResult(r);
});

// ---------- performance ----------
server.tool("page_metrics", "Blink performance metrics: JS heap, layout counts, FPS-related timings.", { tabId: TabId }, READ_PAGE, async ({ tabId }) => {
  const r = await bridge.send("page_metrics", {}, tabId);
  return textResult(r);
});

// ---------- permissions ----------
server.tool("permissions_list", "Show permission categories with enabled/total counts and the disabled action list.", {}, READ_ONLY, async () => {
  const r = await bridge.send("perm_list", {});
  return textResult(r);
});

server.tool(
  "permissions_set",
  "Disable one bridge action (self-restriction, synced to the extension popup). Only disabling works over the bridge: enabled:true is rejected, re-enabling is only possible from the extension popup. Disabled actions fail with a clear error.",
  {
    action: z.string().describe("Bridge action name (e.g. dom_click)"),
    enabled: z.boolean().describe("Must be false (disable). true is rejected: re-enable from the extension popup."),
  },
  STATE_SET,
  async ({ action, enabled }) => {
    // The agent must never lift a restriction the user set in the popup
    // (enforced here too, so older extensions are covered as well).
    if (enabled !== false) {
      throw new Error("Re-enabling a permission is only possible from the extension popup");
    }
    const r = await bridge.send("perm_set", { action, enabled: false });
    return textResult(r);
  }
);

// ---------- trusted input (CDP Input.* — real OS-level events) ----------
server.tool(
  "trusted_click",
  "Real OS-level click via CDP Input (bypasses bot detection). Scrolls the target into view first (every selector form works, focused frame included).",
  {
    selector: z.string().describe(SelectorDesc),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)"),
    doubleClick: z.boolean().optional().describe("Double-click instead of single click"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ selector, button, doubleClick, tabId }) => {
    const r = await bridge.send("trusted_click", { selector, button, doubleClick }, tabId);
    return textResult(r);
  }
);

server.tool(
  "trusted_type",
  "Real keystrokes via CDP Input.insertText (bypasses bot detection). The target is resolved and focused first.",
  {
    selector: z.string().describe(SelectorDesc),
    text: z.string().describe("Text to type"),
    clearFirst: z.boolean().optional().describe("Clear existing content first"),
    pressEnter: z.boolean().optional().describe("Press Enter after typing"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ selector, text, clearFirst, pressEnter, tabId }) => {
    const r = await bridge.send("trusted_type", { selector, text, clearFirst, pressEnter }, tabId);
    return textResult(r);
  }
);

server.tool(
  "trusted_key",
  "Press a key as trusted CDP input (works without focus tricks).",
  {
    key: z.string().describe("Enter, Tab, Escape, Backspace, Delete, Arrows, Home, End, PageUp/Down, or a single character"),
    modifiers: z.number().int().min(0).max(15).optional().describe("Bitmask: alt=1, ctrl=2, meta=4, shift=8"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ key, modifiers, tabId }) => {
    const r = await bridge.send("trusted_key", { key, modifiers }, tabId);
    return textResult(r);
  }
);

server.tool(
  "trusted_scroll",
  "Trusted wheel scroll at a viewport point (defaults to center).",
  {
    x: z.number().optional().describe("Omit for viewport center"),
    y: z.number().optional().describe("Omit for viewport center"),
    deltaX: z.number().optional().describe("Horizontal pixels (default 0)"),
    deltaY: z.number().optional().describe("Pixels, negative scrolls up (default 500)"),
    tabId: TabId,
  },
  PAGE_INTERACT,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("trusted_scroll", payload, tabId);
    return textResult(r);
  }
);

server.tool(
  "trusted_drag",
  "Trusted drag between two elements via CDP mouse events (bypasses bot detection).",
  {
    from: z.string().describe("Source selector/ref"),
    to: z.string().describe("Target selector/ref"),
    tabId: TabId,
  },
  PAGE_ACTION,
  async ({ from, to, tabId }) => {
    const r = await bridge.send("trusted_drag", { from, to }, tabId);
    return textResult(r);
  }
);

server.tool(
  "network_bodies",
  "Spy-captured request/response bodies (POST data, response snippets). Requires network_mock_start first (no routes needed).",
  {
    filter: z.string().optional().describe("URL substring filter"),
    kind: z.enum(["request", "response"]).optional().describe("Only requests (with POST bodies) or only responses"),
    limit: limitParam(1000, "Max entries (default 50)"),
    tabId: TabId,
  },
  READ_ONLY,
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("network_bodies", payload, tabId);
    return textResult(r);
  }
);

// ---------- power: raw CDP ----------
server.tool(
  "cdp_send",
  "Send a raw CDP command to the tab (power tool). Prefer a typed tool when one exists; tab-scoped domains only.",
  {
    method: z.string().describe("E.g. Network.enable, Page.printToPDF, Runtime.evaluate"),
    params: z.record(z.string(), z.unknown()).optional().describe("Method params object (default {})"),
    tabId: TabId,
  },
  POWER,
  async ({ method, params, tabId }) => {
    const r = await bridge.send("cdp_send", { method, params: params ?? {} }, tabId, 30000);
    return textResult(r);
  }
);

// ---------- tab groups ----------
const TabGroupColor = z.enum([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

server.tool(
  "tab_group_create",
  "Group one or more tabs together with an optional title, color, and collapsed state",
  {
    tabIds: z.array(z.number().int()).describe("Array of tab IDs to add to the new group"),
    title: z.string().optional().describe("Group title / label"),
    color: TabGroupColor.optional().describe("Color of the tab group"),
    collapsed: z.boolean().optional().describe("Whether the tab group is collapsed"),
  },
  STATE_CHANGE,
  async ({ tabIds, title, color, collapsed }) => {
    const r = await bridge.send("tab_group_create", { tabIds, title, color, collapsed });
    return textResult(r);
  }
);

server.tool(
  "tab_group_list",
  "List all tab groups with their member tabs, colors, and collapsed states",
  {
    windowId: z.number().int().optional().describe("Filter by window ID"),
    title: z.string().optional().describe("Filter by group title (case-insensitive substring)"),
  },
  READ_ONLY,
  async ({ windowId, title }) => {
    // chrome.tabGroups.query({title}) is an exact/pattern match, so the
    // substring filter is applied here on the full list.
    const r = (await bridge.send("tab_group_list", { windowId })) as { groups?: Array<{ title?: string }> } & Record<string, unknown>;
    if (title && Array.isArray(r?.groups)) {
      const needle = title.toLowerCase();
      return textResult({ ...r, groups: r.groups.filter((g) => String(g?.title ?? "").toLowerCase().includes(needle)) });
    }
    return textResult(r);
  }
);

server.tool(
  "tab_group_update",
  "Update a tab group's title, color, or collapsed state",
  {
    groupId: z.number().int().describe("Group ID to update"),
    title: z.string().optional().describe("New title for the group"),
    color: TabGroupColor.optional().describe("New color for the group"),
    collapsed: z.boolean().optional().describe("Whether to collapse or expand the group"),
  },
  STATE_SET,
  async ({ groupId, title, color, collapsed }) => {
    const r = await bridge.send("tab_group_update", { groupId, title, color, collapsed });
    return textResult(r);
  }
);

server.tool(
  "tab_group_ungroup",
  "Remove tabs from their tab group",
  {
    tabIds: z.array(z.number().int()).describe("Array of tab IDs to ungroup"),
  },
  STATE_SET,
  async ({ tabIds }) => {
    const r = await bridge.send("tab_group_ungroup", { tabIds });
    return textResult(r);
  }
);

// ---------- clipboard ----------
server.tool(
  "clipboard_read",
  "Read current text content from the system/browser clipboard",
  {},
  READ_ONLY,
  async () => {
    const r = await bridge.send("clipboard_read", {});
    return textResult(r);
  }
);

server.tool(
  "clipboard_write",
  "Copy text to the system/browser clipboard",
  {
    text: z.string().describe("Text string to write to clipboard"),
  },
  DESTRUCTIVE_IDEMPOTENT,
  async ({ text }) => {
    const r = await bridge.send("clipboard_write", { text });
    return textResult(r);
  }
);

// ---------- browsing data ----------
// Session data cleared by browsing_data_clear {all:true} (the former implicit default).
const BROWSING_DATA_DEFAULT_TYPES = ["cache", "cookies", "formData", "history", "localStorage", "indexedDB", "serviceWorkers"] as const;

server.tool(
  "browsing_data_clear",
  "Clear browser data for every site (irreversible): cache, cookies, history, storage, downloads, form data, passwords. Pass explicit types, or all:true for the common session-data set.",
  {
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
  DESTRUCTIVE_IDEMPOTENT,
  async ({ types, all, since }) => {
    // Never wipe everything implicitly: an omitted or empty types list needs all:true.
    if (types && types.length > 0) {
      const r = await bridge.send("browsing_data_clear", { types, since });
      return textResult(r);
    }
    if (all !== true) {
      throw new Error("browsing_data_clear needs a non-empty types list, or all:true to clear the common session data");
    }
    const r = await bridge.send("browsing_data_clear", { types: [...BROWSING_DATA_DEFAULT_TYPES], all: true, since });
    return textResult(r);
  }
);

// ---------- notifications ----------
server.tool(
  "notification_create",
  "Display a native desktop notification to the user",
  {
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
  STATE_CHANGE,
  async ({ title, message, contextMessage, priority }) => {
    const r = await bridge.send("notification_create", { title, message, contextMessage, priority });
    return textResult(r);
  }
);

server.tool(
  "notification_clear",
  "Dismiss / clear a previously created desktop notification",
  {
    id: z.string().describe("Notification ID returned from notification_create"),
  },
  STATE_SET,
  async ({ id }) => {
    const r = await bridge.send("notification_clear", { id });
    return textResult(r);
  }
);

// ---------- MCP Resources ----------
server.resource("status", "browser://status", async (uri) => ({
  contents: [{
    uri: uri.href,
    mimeType: "application/json",
    text: JSON.stringify(bridgeStatusSnapshot(), null, 2),
  }],
}));

server.resource("tabs", "browser://tabs", async (uri) => {
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

server.resource("console_recent", "browser://console/recent", async (uri) =>
  recentEventsResource(uri, bridge.consoleEvents, "console_get")
);

server.resource("network_recent", "browser://network/recent", async (uri) =>
  recentEventsResource(uri, bridge.networkEvents, "network_requests")
);

// ---------- MCP Prompts ----------
server.prompt(
  "web_research",
  "Structured browser research on a given topic and URL",
  {
    url: z.string().describe("Target website URL to inspect and research"),
    topic: z.string().describe("Topic or question to investigate"),
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

server.prompt(
  "form_automation",
  "Inspect and fill a form on a given URL",
  {
    url: z.string().describe("Page URL containing the form"),
    fields: z.string().describe("Description or JSON of values to fill"),
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

server.prompt(
  "performance_audit",
  "Audit page metrics, network requests, and performance on a given URL",
  {
    url: z.string().describe("URL to audit"),
  },
  ({ url }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Navigate to ${url}, wait for network activity to settle, gather performance data using page_metrics and network_requests, analyze slow requests, and export a HAR file if appropriate.`,
      },
    }],
  })
);

server.prompt(
  "accessibility_audit",
  "Audit accessibility tree and ARIA roles for a webpage",
  {
    url: z.string().describe("URL to evaluate for accessibility"),
  },
  ({ url }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Navigate to ${url}, run page_axtree to retrieve the accessibility tree (use page_snapshot or dom_query for heading order), and identify missing alt attributes, unlabeled buttons, heading hierarchy issues, and contrast/ARIA problems.`,
      },
    }],
  })
);

// ---------- start ----------
async function main() {
  // CLI wins over env for browser selection (bridge reads process.env.BROWSER).
  const browserFlag = CLI.browser;
  if (browserFlag && browserFlag.trim()) process.env.BROWSER = browserFlag.trim();
  bridge = await createBridge(PORT, [...new Set(CLI.extensionIds)]);

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[browser-mcp:${process.pid}] shutting down (${reason})`);
    try {
      bridge.close();
    } catch {}
    // The WS server keeps the event loop alive, so force-exit after a
    // short grace period for sockets to close cleanly.
    setTimeout(() => process.exit(0), 250).unref?.();
  };

  const transport = new StdioServerTransport();
  // Preserved across server.connect() (Protocol wraps a pre-set handler).
  transport.onclose = () => shutdown("transport-close");
  await server.connect(transport);
  console.error(`[browser-mcp:${process.pid}] stdio ready, ws bridge on :${PORT} mode=${bridge.mode}`);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // General fix for orphan servers: disabling the MCP in the agent closes
  // the stdio pipe but StdioServerTransport never calls close() on stdin
  // EOF, so without this the bun process lingers holding :PORT forever.
  // Opt out with BROWSER_MCP_NO_STDIO_EXIT=1.
  if (process.env.BROWSER_MCP_NO_STDIO_EXIT !== "1") {
    try {
      process.stdin.on("close", () => shutdown("stdin-close"));
      process.stdin.on("end", () => shutdown("stdin-end"));
    } catch {}
  }
  // Parent watchdog: if the launching agent died without delivering SIGTERM
  // (kill -9, crash, Task Manager), exit instead of squatting on the port.
  // A satellite whose agent is gone exits here too instead of promoting to
  // primary and living forever. Opt out with BROWSER_MCP_NO_PARENT_CHECK=1.
  const parentPid = process.ppid;
  const parentCheckMs = Number(process.env.BROWSER_MCP_PARENT_CHECK_MS ?? 10000);
  if (
    process.env.BROWSER_MCP_NO_PARENT_CHECK !== "1" &&
    parentPid > 1 &&
    Number.isFinite(parentCheckMs) &&
    parentCheckMs > 0
  ) {
    const timer = setInterval(() => {
      // Orphaned + reparented to init (Unix): original parent is gone.
      try {
        if (process.ppid !== parentPid && process.ppid <= 1) {
          clearInterval(timer);
          shutdown("parent-reparented");
          return;
        }
      } catch {}
      try {
        process.kill(parentPid, 0);
      } catch (e) {
        // ESRCH = no such process (parent gone). EPERM = alive, ignore.
        if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
          clearInterval(timer);
          shutdown("parent-gone");
        }
      }
    }, parentCheckMs);
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {}
  }
  // Client watchdog: the agent can stay alive with our stdio pipe open while
  // tearing down its MCP client (MCP disabled). Then there is no EOF and no
  // dead parent — but a server->client `ping` gets no answer. Exit after
  // consecutive ping timeouts instead of squatting on :PORT forever. Any
  // other reply (even a method error) proves the client lives and resets
  // the counter. Opt out with BROWSER_MCP_NO_CLIENT_PING=1.
  if (process.env.BROWSER_MCP_NO_CLIENT_PING !== "1") {
    const pingEvery = Number(process.env.BROWSER_MCP_CLIENT_PING_MS ?? 30000);
    const pingTimeout = Number(process.env.BROWSER_MCP_CLIENT_PING_TIMEOUT_MS ?? 10000);
    const failsNeededRaw = Number(process.env.BROWSER_MCP_CLIENT_PING_FAILS ?? 3);
    const failsNeeded = Number.isFinite(failsNeededRaw) && failsNeededRaw > 0 ? Math.floor(failsNeededRaw) : 3;
    if (Number.isFinite(pingEvery) && pingEvery > 0 && Number.isFinite(pingTimeout) && pingTimeout > 0) {
      let fails = 0;
      let inFlight = false;
      const timer = setInterval(async () => {
        if (shuttingDown || inFlight) return;
        inFlight = true;
        try {
          await server.server.request({ method: "ping" }, EmptyResultSchema, { timeout: pingTimeout });
          fails = 0;
        } catch (e) {
          // Only a timeout means "nobody home".
          if ((e as { code?: number })?.code === ErrorCode.RequestTimeout) {
            fails++;
            console.error(`[browser-mcp:${process.pid}] MCP client ping timeout (${fails}/${failsNeeded})`);
            if (fails >= failsNeeded) {
              clearInterval(timer);
              shutdown("client-unresponsive");
            }
          } else {
            fails = 0;
          }
        } finally {
          inFlight = false;
        }
      }, pingEvery);
      try {
        (timer as unknown as { unref?: () => void }).unref?.();
      } catch {}
    }
  }
}

main().catch((e) => {
  console.error(`[browser-mcp:${process.pid}] fatal: ${errMessage(e)}`);
  process.exit(1);
});
