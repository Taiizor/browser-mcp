import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmptyResultSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeClient, ExtensionBridge, type IBridge } from "./bridge.js";

function parsePort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
      const val = parseInt(args[i + 1], 10);
      if (!isNaN(val) && val > 0 && val < 65536) return val;
    } else if (arg.startsWith("--port=") || arg.startsWith("-p=")) {
      const val = parseInt(arg.split("=")[1], 10);
      if (!isNaN(val) && val > 0 && val < 65536) return val;
    } else if (/^\d+$/.test(arg)) {
      const val = parseInt(arg, 10);
      if (val > 0 && val < 65536) return val;
    }
  }
  const env = process.env.BROWSER_MCP_PORT || process.env.PORT;
  if (env) {
    const val = parseInt(env, 10);
    if (!isNaN(val) && val > 0 && val < 65536) return val;
  }
  return 8765;
}

const PORT = parsePort();

function parseBrowser(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--browser" || arg === "-b") && i + 1 < args.length) {
      return args[i + 1];
    }
    const m = arg.match(/^(?:--browser|-b)=(.+)$/);
    if (m) return m[1];
  }
  return undefined;
}

// Multi-agent sharing: the first process owns the WS bridge (primary),
// later processes join it as satellite clients instead of failing on
// EADDRINUSE. All satellites relay through the single extension socket.
// NOTE: stdio MCP requires one OS process per MCP client session, so N agent
// sessions = N processes (1 primary + N-1 satellites) sharing one browser.
// That is expected — see browser_status (mode/pid/peers) to tell them apart.
async function createBridge(port: number): Promise<IBridge> {
  const primary = new ExtensionBridge(port, { exitOnAddrInUse: false });
  try {
    await primary.ready();
    console.error(`[browser-mcp:${process.pid}] primary bridge on :${port} (ppid=${process.ppid})`);
    return primary;
  } catch {
    console.error(`[browser-mcp:${process.pid}] port ${port} in use, joining as satellite client`);
    try {
      primary.close();
    } catch {}
    const client = new BridgeClient(port);
    await client.ready();
    console.error(`[browser-mcp:${process.pid}] satellite connected to primary on :${port}`);
    return client;
  }
}

let bridge: IBridge;

const server = new McpServer({
  name: "browser-mcp",
  version: "0.3.3",
});

// ---------- helpers ----------
const TabId = z.number().int().optional().describe("Tab ID from tab_list. Omit for the active tab.");
const SelectorDesc = "CSS selector, XPath (prefix with xpath=...), or snapshot ref (ref=e12)";

function textResult(obj: unknown): { content: { type: "text"; text: string }[] } {
  if (typeof obj === "string") {
    return { content: [{ type: "text" as const, text: obj }] };
  }
  const str = JSON.stringify(obj);
  const text = str.length > 1200 ? str : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

// ---------- status ----------
server.tool("browser_status", "Check whether the browser extension is connected and show bridge status (mode=primary|satellite, pid, peers=satellites sharing this bridge)", {}, async () => {
  return textResult({
    connected: bridge.connected,
    wsPort: PORT,
    consoleBuffered: bridge.consoleEvents.length,
    networkBuffered: bridge.networkEvents.length,
    ...bridge.status(),
  });
});

// ---------- browser launch ----------
server.tool(
  "browser_launch",
  "Start the browser if needed and wait for the extension to connect. Browser choice follows BROWSER / sticky / running / OS-default order; use when browser_status shows disconnected.",
  {
    timeoutMs: z.number().optional().describe("How long to wait for the extension (default 45000)"),
  },
  async ({ timeoutMs }) => {
    const r = await bridge.launchBrowser(timeoutMs);
    return textResult(r);
  }
);

server.tool(
  "browser_close",
  "Close the browser. Graceful mode closes windows via the extension; force kills the process (also works when the extension is silent). Respects the browser_close popup switch.",
  {
    force: z.boolean().optional().describe("true: kill the browser process (also works when the extension is silent)"),
  },
  async ({ force }) => {
    // Honor the popup switch whenever the extension is reachable.
    if (bridge.connected) {
      const perms = (await bridge.send("perm_list", {})) as { disabled?: string[] };
      if (perms?.disabled?.includes("browser_close")) {
        throw new Error("Permission disabled in extension: browser_close (enable it from the extension popup)");
      }
    }
    const r = await bridge.closeBrowser(force ?? false);
    return textResult(r);
  }
);

// ---------- tabs ----------
server.tool("tab_list", "List all open tabs with id, title, URL and active state. Call first to discover tab IDs for other tools.", {}, async () => {
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
  async ({ url, active }) => {
    const r = await bridge.send("tab_create", { url, active });
    return textResult(r);
  }
);

server.tool(
  "tab_duplicate",
  "Duplicate an existing tab into a new tab",
  { tabId: TabId },
  async ({ tabId }) => {
    const r = await bridge.send("tab_duplicate", {}, tabId);
    return textResult(r);
  }
);

server.tool("tab_close", "Close a tab (default: active). Closing the last tab of the last window quits the browser and needs the browser_close permission.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("tab_close", {}, tabId);
  return textResult(r);
});

server.tool("tab_activate", "Bring a tab to the front and focus its window.", { tabId: z.number().int().describe("Tab ID to activate (see tab_list)") }, async ({ tabId }) => {
  const r = await bridge.send("tab_activate", {}, tabId);
  return textResult(r);
});

server.tool(
  "tab_navigate",
  "Navigate a tab to a URL. Navigation destroys page context: re-query refs and re-wait afterwards.",
  { url: z.string().describe("Target URL"), tabId: TabId },
  async ({ url, tabId }) => {
    const r = await bridge.send("tab_navigate", { url }, tabId);
    return textResult(r);
  }
);

server.tool("tab_reload", "Reload a tab (default: active). Page context resets: re-query refs afterwards.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("tab_reload", {}, tabId);
  return textResult(r);
});

server.tool("tab_back", "Go back in tab history.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("tab_back", {}, tabId);
  return textResult(r);
});

server.tool("tab_forward", "Go forward in tab history.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("tab_forward", {}, tabId);
  return textResult(r);
});

// ---------- page / dom ----------
server.tool(
  "page_snapshot",
  "Compact element tree with refs (ref=e1) for finding selectors. Start here before interacting; refs expire on navigation.",
  {
    tabId: TabId,
    compact: z.boolean().optional().describe("true: compact tree, false: detailed"),
  },
  async ({ tabId, compact }) => {
    const r = await bridge.send("page_snapshot", { compact: compact ?? true }, tabId);
    return textResult(r);
  }
);

server.tool("page_html", "Full HTML source (large, truncated in display). Prefer page_snapshot for structure.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("page_html", {}, tabId, 60000);
  return textResult(r);
});

server.tool("page_text", "Visible page text (up to 100KB). Best for reading content.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("page_text", {}, tabId);
  return textResult(r);
});

server.tool(
  "dom_query",
  "Find elements by CSS/XPath/text/ref. Returns refs with tag, text and coordinates for clicks and typing.",
  { selector: z.string().describe(SelectorDesc), tabId: TabId },
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
    doubleClick: z.boolean().optional().describe("Fire dblclick instead of click"),
  },
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
    delayMs: z.number().optional().describe("Per-keystroke delay (for bot-protected sites)"),
  },
  async ({ selector, text, tabId, clearFirst, pressEnter, delayMs }) => {
    const r = await bridge.send(
      "dom_type",
      { selector, text, clearFirst, pressEnter, delayMs },
      tabId
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
  async ({ fields, tabId, submit }) => {
    const r = await bridge.send("dom_fill", { fields, submit }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_select",
  "Choose a <select> option by its value (fires input/change).",
  {
    selector: z.string().describe(SelectorDesc),
    value: z.string().describe("Option value to select"),
    tabId: TabId,
  },
  async ({ selector, value, tabId }) => {
    const r = await bridge.send("dom_select", { selector, value }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_check",
  "Set or toggle a checkbox/radio (fires input/change, no synthetic click).",
  {
    selector: z.string().describe(SelectorDesc),
    checked: z.boolean().optional().describe("Omit to toggle"),
    tabId: TabId,
  },
  async ({ selector, checked, tabId }) => {
    const r = await bridge.send("dom_check", { selector, checked }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_hover",
  "Hover an element (opens menus/tooltips). For real pointer input use trusted actions.",
  { selector: z.string().describe(SelectorDesc), tabId: TabId },
  async ({ selector, tabId }) => {
    const r = await bridge.send("dom_hover", { selector }, tabId);
    return textResult(r);
  }
);

server.tool(
  "dom_focus",
  "Focus an element (inputs, buttons).",
  { selector: z.string().describe(SelectorDesc), tabId: TabId },
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
    pixels: z.number().optional().describe("Pixels per step (default 500)"),
    tabId: TabId,
  },
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
  async ({ from, to, tabId }) => {
    const r = await bridge.send("dom_drag", { from, to }, tabId);
    return textResult(r);
  }
);

server.tool(
  "keyboard_press",
  "Send a key press to the focused element. Supports combos like Ctrl+C.",
  {
    key: z.string().describe("Enter, Tab, Escape, ArrowDown, a, A, Ctrl+C ..."),
    tabId: TabId,
  },
  async ({ key, tabId }) => {
    const r = await bridge.send("keyboard_press", { key }, tabId);
    return textResult(r);
  }
);

server.tool(
  "page_find",
  "Search page text (case-insensitive), scroll to and highlight the first match.",
  { text: z.string().describe("Text to find"), tabId: TabId },
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
    timeoutMs: z.number().optional().describe("Maximum wait time in ms (default 15000)"),
    text: z.string().optional().describe("Page text to wait for"),
    url: z.string().optional().describe("URL substring to wait for (e.g. after redirects)"),
    urlPattern: z.string().optional().describe("URL regex pattern to wait for"),
    readyState: z.enum(["interactive", "complete"]).optional().describe("Wait for document readyState ('interactive' or 'complete')"),
    tabId: TabId,
  },
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("page_wait", payload, tabId, (payload.timeoutMs ?? 15000) + 5000);
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
    scale: z.number().optional().describe("Capture scale for element shots (default 1, max 2)"),
  },
  async ({ tabId, fullPage, selector, scale }) => {
    const result = (await bridge.send("page_screenshot", { fullPage, selector, scale }, tabId, 60000)) as {
      dataUrl?: string;
      note?: string;
    };
    if (result.dataUrl && result.dataUrl.startsWith("data:image/")) {
      const parts = result.dataUrl.split(",");
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
            text: JSON.stringify({ tabId, note: result.note || "Screenshot captured successfully" }),
          },
        ],
      };
    }
    return textResult(result);
  }
);

server.tool("page_pdf", "Render the tab to PDF (base64). Slower; for visuals prefer page_screenshot.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("page_pdf", {}, tabId, 60000);
  return textResult(r);
});

// ---------- js / console ----------
server.tool(
  "js_evaluate",
  "Run JavaScript in the page via CDP (bypasses page CSP). Supports `return` statements and top-level await (with awaitPromise). Values must be JSON-serializable.",
  {
    expression: z.string().describe("JS to run: bare expression (2+2) or statements with return. Top-level await needs awaitPromise:true."),
    tabId: TabId,
    awaitPromise: z.boolean().optional().describe("Await promises/top-level await before returning"),
  },
  async ({ expression, tabId, awaitPromise }) => {
    try {
      const r = await bridge.send(
        "js_evaluate",
        { expression, awaitPromise },
        tabId
      );
      return textResult(r);
    } catch (e) {
      // Old extensions (<0.3.3) evaluated via content-script new Function,
      // blocked by the extension CSP (no 'unsafe-eval'). Fallback keeps them
      // working: Runtime.evaluate over the debugger (unaffected by CSP).
      if (!/Content Security Policy|unsafe-eval|Evaluating a string|handled via CDP/i.test(String((e as Error)?.message ?? e))) {
        throw e;
      }
      const evalOnce = async (expr: string, awaitP: boolean) =>
        (await bridge.send(
          "cdp_send",
          {
            method: "Runtime.evaluate",
            params: {
              expression: expr,
              awaitPromise: awaitP,
              returnByValue: true,
              includeCommandLineAPI: true,
            },
          },
          tabId,
          30000
        )) as { result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
      let cdp = await evalOnce(expression, awaitPromise ?? false);
      if (cdp?.result?.exceptionDetails) {
        // `return` outside a function needs function-body semantics: retry wrapped.
        cdp = await evalOnce(`(async () => { ${expression} })()`, true);
      }
      if (cdp?.result?.exceptionDetails) {
        throw new Error(`Page JS error: ${JSON.stringify(cdp.result.exceptionDetails).slice(0, 500)}`);
      }
      const inner = cdp?.result?.result;
      return textResult({ value: inner?.value, via: "cdp-fallback" });
    }
  }
);

server.tool(
  "console_get",
  "Read captured page console logs (filter by level). Falls back to the local bridge buffer when the extension is unreachable.",
  {
    level: z.enum(["all", "log", "info", "warn", "error", "debug"]).optional().describe("Log level filter (default all)"),
    limit: z.number().optional().describe("Max entries from the tail (default 200)"),
    tabId: TabId,
  },
  async ({ level, limit, tabId }) => {
    // Ask the extension for fresh data first, fall back to the bridge buffer
    try {
      const r = await bridge.send("console_get", { level, limit }, tabId);
      return textResult(r);
    } catch (e) {
      // Permission denials must surface (not silently downgrade to the buffer).
      if (/Permission disabled/i.test(String((e as Error)?.message ?? e))) throw e;
      const lvl = level ?? "all";
      const lim = limit ?? 200;
      const filtered = bridge.consoleEvents
        .filter((e) => lvl === "all" || (e as { level?: string }).level === lvl)
        .slice(-lim);
      return textResult({ source: "bridge-buffer", logs: filtered });
    }
  }
);

server.tool("console_clear", "Clear captured console logs (extension + local buffer).", {}, async () => {
  try {
    const r = await bridge.send("console_clear", {});
    return textResult(r);
  } catch (e) {
    if (/Permission disabled/i.test(String((e as Error)?.message ?? e))) throw e;
    bridge.consoleEvents.length = 0;
    return textResult({ ok: true, source: "bridge-buffer" });
  }
});

// ---------- network ----------
server.tool(
  "network_requests",
  "List captured HTTP network requests with optional filters",
  {
    filter: z.string().optional().describe("URL substring filter"),
    type: z.string().optional().describe("Resource type: document, xhr, fetch, image, script..."),
    failedOnly: z.boolean().optional().describe("Only return failed requests (status >= 400 or network error)"),
    minStatus: z.number().optional().describe("Minimum HTTP status code (e.g. 400 for errors)"),
    limit: z.number().optional().describe("Max number of requests to return (default 200)"),
    tabId: TabId,
  },
  async ({ filter, type, failedOnly, minStatus, limit, tabId }) => {
    try {
      const r = await bridge.send("network_requests", { filter, type, failedOnly, minStatus, limit, tabId });
      return textResult(r);
    } catch (e) {
      if (/Permission disabled/i.test(String((e as Error)?.message ?? e))) throw e;
      let arr = bridge.networkEvents as Array<Record<string, unknown>>;
      if (tabId !== undefined) arr = arr.filter((e) => e.tabId === tabId);
      if (filter) arr = arr.filter((e) => String(e.url ?? "").includes(filter));
      if (type) arr = arr.filter((e) => (e as { type?: string }).type === type);
      if (failedOnly) arr = arr.filter((e) => (typeof e.statusCode === "number" && e.statusCode >= 400) || e.phase === "error");
      if (minStatus !== undefined) arr = arr.filter((e) => typeof e.statusCode === "number" && e.statusCode >= minStatus);
      if (limit) arr = arr.slice(-limit);
      return textResult({ source: "bridge-buffer", requests: arr });
    }
  }
);

server.tool("network_clear", "Clear captured network logs (extension + local buffer).", {}, async () => {
  try {
    const r = await bridge.send("network_clear", {});
    return textResult(r);
  } catch {
    bridge.networkEvents.length = 0;
    return textResult({ ok: true });
  }
});

server.tool(
  "network_response_body",
  "Re-fetch a recorded request's body in page context (webRequest exposes no bodies). Needs a requestId from network_requests.",
  {
    requestId: z.string().describe("requestId from network_requests"),
    tabId: TabId,
  },
  async ({ requestId, tabId }) => {
    const r = await bridge.send("network_response_body", { requestId }, tabId, 30000);
    return textResult(r);
  }
);

server.tool(
  "network_throttle",
  "Emulate network conditions (slow 3G, fast 3G, offline, or online) via CDP",
  {
    profile: z.enum(["online", "slow3g", "fast3g", "offline", "custom"]).describe("Throttling profile"),
    latency: z.number().optional().describe("Custom latency in ms (only for profile: custom)"),
    downloadThroughput: z.number().optional().describe("Custom download throughput in bytes/s (only for profile: custom)"),
    uploadThroughput: z.number().optional().describe("Custom upload throughput in bytes/s (only for profile: custom)"),
    tabId: TabId,
  },
  async ({ profile, latency, downloadThroughput, uploadThroughput, tabId }) => {
    const r = await bridge.send("network_throttle", { profile, latency, downloadThroughput, uploadThroughput }, tabId);
    return textResult(r);
  }
);

server.tool(
  "network_set_headers",
  "Set extra custom HTTP request headers attached to all requests in the tab",
  {
    headers: z.record(z.string(), z.string()).describe("Key-value header dictionary (e.g. Authorization, User-Agent)"),
    tabId: TabId,
  },
  async ({ headers, tabId }) => {
    const r = await bridge.send("network_set_headers", { headers }, tabId);
    return textResult(r);
  }
);

// ---------- cookies ----------
server.tool(
  "cookies_list",
  "List cookies filtered by domain, url, or name",
  {
    domain: z.string().optional().describe("Domain filter"),
    url: z.string().optional().describe("URL filter (e.g. https://example.com)"),
    name: z.string().optional().describe("Cookie name filter"),
  },
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
    sameSite: z.enum(["no_restriction", "lax", "strict"]).optional().describe("SameSite attribute"),
    expirationDate: z.number().optional().describe("Unix timestamp for cookie expiry"),
  },
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
  async ({ url, name }) => {
    const r = await bridge.send("cookies_delete", { url, name });
    return textResult(r);
  }
);

server.tool(
  "cookies_clear",
  "Clear all cookies for a domain or URL",
  {
    domain: z.string().optional().describe("Domain to clear cookies for"),
    url: z.string().optional().describe("URL to clear cookies for"),
  },
  async ({ domain, url }) => {
    const r = await bridge.send("cookies_clear", { domain, url });
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
        sameSite: z.enum(["no_restriction", "lax", "strict"]).optional().describe("SameSite attribute"),
        expirationDate: z.number().optional().describe("Unix timestamp for cookie expiry"),
      })
    ).describe("Array of cookie objects to set"),
  },
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
    maxResults: z.number().int().optional().describe("Maximum number of entries to return (default 25)"),
  },
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
  async ({ state, tabId }) => {
    const r = await bridge.send("session_state_load", { state }, tabId);
    return textResult(r);
  }
);

// ---------- storage ----------
server.tool(
  "storage_get",
  "Read all localStorage/sessionStorage entries of the page (values truncated).",
  {
    area: z.enum(["local", "session"]).optional().describe("Storage area (default local)"),
    tabId: TabId,
  },
  async ({ area, tabId }) => {
    const r = await bridge.send("storage_get", { area: area ?? "local" }, tabId);
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
server.tool("idb_list", "List IndexedDB databases on the page (name + version).", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("idb_list", {}, tabId);
  return textResult(r);
});

server.tool(
  "idb_stores",
  "List object stores of an IndexedDB database.",
  { db: z.string().describe("Database name (see idb_list)"), tabId: TabId },
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
    limit: z.number().optional().describe("Max rows when reading all (default 50)"),
    key: z.unknown().optional().describe("Omit to read all (up to limit)"),
    tabId: TabId,
  },
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
  async ({ db, store, tabId }) => {
    const r = await bridge.send("idb_clear", { db, store }, tabId);
    return textResult(r);
  }
);

// ---------- history ----------
server.tool(
  "history_search",
  "Search browser history by query text.",
  {
    query: z.string().describe("Search text"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    const r = await bridge.send("history_search", { query, limit: limit ?? 20 });
    return textResult(r);
  }
);

server.tool(
  "history_delete",
  "Delete a URL, all history, or a time range from the browser history",
  {
    url: z.string().optional().describe("URL to remove from history"),
    all: z.boolean().optional().describe("Set to true to clear all browser history"),
    startTime: z.number().optional().describe("Start time (ms since epoch) for range deletion"),
    endTime: z.number().optional().describe("End time (ms since epoch) for range deletion"),
  },
  async ({ url, all, startTime, endTime }) => {
    const r = await bridge.send("history_delete", { url, all, startTime, endTime });
    return textResult(r);
  }
);

// ---------- network mock / block (debugger Fetch domain) ----------
server.tool("network_mock_start", "Attach the debugger and start intercepting requests. Spy mode: without routes, unmatched traffic passes through while bodies are recorded.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("network_mock_start", {}, tabId);
  return textResult(r);
});

server.tool("network_mock_stop", "Detach the debugger and end interception for the tab.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("network_mock_stop", {}, tabId);
  return textResult(r);
});

server.tool(
  "network_mock_route",
  "Add a block/fulfill/delay rule for matching URLs. Requires network_mock_start first.",
  {
    pattern: z.string().describe("URL pattern, * wildcard (e.g. *ads* or https://api.example.com/*)"),
    action: z.enum(["block", "fulfill", "delay"]).describe("block: drop, fulfill: return a mock response, delay: hold then pass through"),
    status: z.number().optional().describe("HTTP code for fulfill (default 200)"),
    body: z.string().optional().describe("Body for fulfill"),
    contentType: z.string().optional().describe("Content-Type for fulfill (default application/json)"),
    delayMs: z.number().optional().describe("Hold time for delay"),
    headers: z
      .array(z.object({ name: z.string().describe("Header name"), value: z.string().describe("Header value") }))
      .optional()
      .describe("Appended to the response headers on fulfill; applied to the request in other modes"),
    tabId: TabId,
  },
  async (args) => {
    const { tabId, ...route } = args;
    const r = await bridge.send("network_mock_route", route, tabId);
    return textResult(r);
  }
);

server.tool("network_mock_list", "List active mock routes and session state.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("network_mock_list", {}, tabId);
  return textResult(r);
});

server.tool(
  "network_mock_remove",
  "Remove one mock route by ID.",
  { routeId: z.string().describe("Route ID from network_mock_list"), tabId: TabId },
  async ({ routeId, tabId }) => {
    const r = await bridge.send("network_mock_remove", { routeId }, tabId);
    return textResult(r);
  }
);

server.tool("network_mock_clear", "Remove all mock routes (keeps the interception session attached).", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("network_mock_clear", {}, tabId);
  return textResult(r);
});

// ---------- downloads ----------
server.tool(
  "downloads_list",
  "List recent downloads with state, progress and errors.",
  { limit: z.number().optional().describe("Max entries (default 50)") },
  async ({ limit }) => {
    const r = await bridge.send("downloads_list", { limit: limit ?? 50 });
    return textResult(r);
  }
);

server.tool("downloads_pause", "Pause an in-progress download.", { id: z.number().int().describe("Download ID from downloads_list") }, async ({ id }) => {
  const r = await bridge.send("downloads_pause", { id });
  return textResult(r);
});

server.tool("downloads_resume", "Resume a paused download.", { id: z.number().int().describe("Download ID from downloads_list") }, async ({ id }) => {
  const r = await bridge.send("downloads_resume", { id });
  return textResult(r);
});

server.tool("downloads_cancel", "Cancel an in-progress download.", { id: z.number().int().describe("Download ID from downloads_list") }, async ({ id }) => {
  const r = await bridge.send("downloads_cancel", { id });
  return textResult(r);
});

server.tool("downloads_erase", "Remove a finished download from history (keeps the file).", { id: z.number().int().describe("Download ID from downloads_list") }, async ({ id }) => {
  const r = await bridge.send("downloads_erase", { id });
  return textResult(r);
});

// ---------- bookmarks ----------
server.tool("bookmarks_search", "Search bookmarks by title/URL.", { query: z.string().describe("Search text") }, async ({ query }) => {
  const r = await bridge.send("bookmarks_search", { query });
  return textResult(r);
});

server.tool(
  "bookmarks_list",
  "List bookmark children of a folder.",
  { parentId: z.string().optional().describe("Omit for the bookmarks bar") },
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
  async (args) => {
    const r = await bridge.send("bookmarks_add", args);
    return textResult(r);
  }
);

server.tool("bookmarks_remove", "Delete a bookmark by ID.", { id: z.string().describe("Bookmark ID") }, async ({ id }) => {
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
  async (args) => {
    const r = await bridge.send("dialog_policy", args);
    return textResult(r);
  }
);

server.tool("dialog_get", "List captured dialogs (alert/confirm/prompt) with messages and responses. Capture is async: poll briefly after triggering.", { limit: z.number().optional().describe("Max entries (default 50)") }, async ({ limit }) => {
  const r = await bridge.send("dialog_get", { limit: limit ?? 50 });
  return textResult(r);
});

server.tool("dialog_clear", "Clear captured dialog history.", {}, async () => {
  const r = await bridge.send("dialog_clear", {});
  return textResult(r);
});

// ---------- HAR ----------
server.tool(
  "har_export",
  "Export captured traffic for a tab as HAR 1.2 (headers included, no bodies).",
  { tabId: TabId, limit: z.number().optional().describe("Max entries (default 300)") },
  async ({ tabId, limit }) => {
    const r = await bridge.send("har_export", { limit: limit ?? 300 }, tabId, 60000);
    return textResult(r);
  }
);

// ---------- frames (iframe targeting) ----------
server.tool("frame_list", "List frames/iframes of a tab with URLs (for frame_focus targeting).", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("frame_list", {}, tabId);
  return textResult(r);
});

server.tool(
  "frame_focus",
  "Route later DOM/page commands to the iframe whose URL contains this string.",
  {
    frameUrl: z.string().describe("URL substring of the target frame (from frame_list). Later DOM/page commands go to that frame."),
    tabId: TabId,
  },
  async ({ frameUrl, tabId }) => {
    const r = await bridge.send("frame_focus", { frameUrl }, tabId);
    return textResult(r);
  }
);

server.tool("frame_clear", "Clear iframe targeting (commands go to the main frame again).", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("frame_clear", {}, tabId);
  return textResult(r);
});

// ---------- tabs + windows ----------
server.tool(
  "tab_pin",
  "Pin/unpin a tab (omit to toggle).",
  { pinned: z.boolean().optional().describe("Omit to toggle"), tabId: TabId },
  async ({ pinned, tabId }) => {
    const r = await bridge.send("tab_pin", { pinned }, tabId);
    return textResult(r);
  }
);

server.tool(
  "tab_mute",
  "Mute/unmute a tab (omit to toggle).",
  { muted: z.boolean().optional().describe("Omit to toggle"), tabId: TabId },
  async ({ muted, tabId }) => {
    const r = await bridge.send("tab_mute", { muted }, tabId);
    return textResult(r);
  }
);

server.tool("window_list", "List windows with focus state and their tabs.", {}, async () => {
  const r = await bridge.send("window_list", {});
  return textResult(r);
});

server.tool(
  "window_create",
  "Open a new window, optionally at a URL.",
  { url: z.string().optional().describe("Initial URL (omit for blank page)") },
  async ({ url }) => {
    const r = await bridge.send("window_create", { url });
    return textResult(r);
  }
);

server.tool("window_focus", "Focus a window by ID.", { windowId: z.number().int().describe("Window ID from window_list") }, async ({ windowId }) => {
  const r = await bridge.send("window_focus", { windowId });
  return textResult(r);
});

// ---------- accessibility tree ----------
server.tool("page_axtree", "Full accessibility tree (roles, names, values) for accessibility audits.", { tabId: TabId }, async ({ tabId }) => {
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
    latitude: z.number().describe("Latitude in degrees"),
    longitude: z.number().describe("Longitude in degrees"),
    accuracy: z.number().optional().describe("Accuracy in meters (default 50)"),
    tabId: TabId,
  },
  async (args) => {
    const { tabId, ...payload } = args;
    const r = await bridge.send("emulation_geolocation", payload, tabId);
    return textResult(r);
  }
);

server.tool("emulation_geolocation_clear", "Remove the geolocation override (detaches the debugger when idle).", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("emulation_geolocation_clear", {}, tabId);
  return textResult(r);
});

// ---------- performance ----------
server.tool("page_metrics", "Blink performance metrics: JS heap, layout counts, FPS-related timings.", { tabId: TabId }, async ({ tabId }) => {
  const r = await bridge.send("page_metrics", {}, tabId);
  return textResult(r);
});

// ---------- permissions ----------
server.tool("permissions_list", "Show permission categories with enabled/total counts and the disabled action list.", {}, async () => {
  const r = await bridge.send("perm_list", {});
  return textResult(r);
});

server.tool(
  "permissions_set",
  "Enable/disable one bridge action (synced to the extension popup). Disabled actions fail with a clear error.",
  {
    action: z.string().describe("Bridge action name (e.g. dom_click)"),
    enabled: z.boolean().describe("true to enable, false to disable"),
  },
  async ({ action, enabled }) => {
    const r = await bridge.send("perm_set", { action, enabled });
    return textResult(r);
  }
);

// ---------- trusted input (CDP Input.* — real OS-level events) ----------
server.tool(
  "trusted_click",
  "Real OS-level click via CDP Input (bypasses bot detection). Resolves the target with dom_query first.",
  {
    selector: z.string().describe(SelectorDesc),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)"),
    doubleClick: z.boolean().optional().describe("Double-click instead of single click"),
    tabId: TabId,
  },
  async ({ selector, button, doubleClick, tabId }) => {
    const r = await bridge.send("trusted_click", { selector, button, doubleClick }, tabId);
    return textResult(r);
  }
);

server.tool(
  "trusted_type",
  "Real keystrokes via CDP Input.insertText (bypasses bot detection). CSS selectors only.",
  {
    selector: z.string().describe("CSS selector or ref (XPath/text selectors are not supported here)"),
    text: z.string().describe("Text to type"),
    clearFirst: z.boolean().optional().describe("Clear existing content first"),
    pressEnter: z.boolean().optional().describe("Press Enter after typing"),
    tabId: TabId,
  },
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
    modifiers: z.number().optional().describe("Bitmask: alt=1, ctrl=2, meta=4, shift=8"),
    tabId: TabId,
  },
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
    limit: z.number().optional().describe("Max entries (default 50)"),
    tabId: TabId,
  },
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
    title: z.string().optional().describe("Filter by group title substring"),
  },
  async ({ windowId, title }) => {
    const r = await bridge.send("tab_group_list", { windowId, title });
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
  async ({ text }) => {
    const r = await bridge.send("clipboard_write", { text });
    return textResult(r);
  }
);

// ---------- browsing data ----------
server.tool(
  "browsing_data_clear",
  "Clear browser cache, cookies, history, storage, downloads, or form data",
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
      .describe("Types of browsing data to clear. Defaults to all common session data."),
    since: z
      .number()
      .optional()
      .describe("Milliseconds since epoch to clear data since (0 = all time, default)"),
  },
  async ({ types, since }) => {
    const r = await bridge.send("browsing_data_clear", { types, since });
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
    text: JSON.stringify({
      connected: bridge.connected,
      wsPort: bridge.port,
      consoleBuffered: bridge.consoleEvents.length,
      networkBuffered: bridge.networkEvents.length,
      ...bridge.status(),
    }, null, 2),
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

server.resource("console_recent", "browser://console/recent", async (uri) => ({
  contents: [{
    uri: uri.href,
    mimeType: "application/json",
    text: JSON.stringify(bridge.consoleEvents.slice(-50), null, 2),
  }],
}));

server.resource("network_recent", "browser://network/recent", async (uri) => ({
  contents: [{
    uri: uri.href,
    mimeType: "application/json",
    text: JSON.stringify(bridge.networkEvents.slice(-50), null, 2),
  }],
}));

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
        text: `Navigate to ${url}, run page_axtree to retrieve the full accessibility tree, and identify missing alt attributes, unlabeled buttons, heading hierarchy issues, and contrast/ARIA problems.`,
      },
    }],
  })
);

// ---------- start ----------
async function main() {
  // CLI wins over env for browser selection (bridge reads process.env.BROWSER).
  const browserFlag = parseBrowser();
  if (browserFlag && browserFlag.trim()) process.env.BROWSER = browserFlag.trim();
  bridge = await createBridge(PORT);

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
  console.error(e);
  process.exit(1);
});
