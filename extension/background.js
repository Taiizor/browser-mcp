// Background service worker: WS bridge + chrome.* API router.
// WS: ws://127.0.0.1:<port>  (default 8765, configurable in storage/popup)

let currentPort = 8765;
let ws = null;
let reconnectMs = 1000;
let reconnectTimer = null;

const consoleLogs = []; // {level,text,url,tabId,ts}
const networkLogs = []; // {requestId,url,method,type,tabId,statusCode,fromCache,ts,...}
const networkMap = new Map(); // requestId -> entry for O(1) lookups
const dialogEvents = []; // {kind,message,url,tabId,ts,response}
const MAX = 1000;

const commandHistory = []; // { id, action, ok, error, durationMs, time, tabId }
const MAX_HISTORY = 50;
function recordCommandHistory(entry) {
  commandHistory.unshift(entry);
  if (commandHistory.length > MAX_HISTORY) commandHistory.pop();
}

// Mock/block + spy sessions: tabId -> { routes, netmap, bodies }
const fetchSessions = new Map();
const emulationSessions = new Map();
let routeSeq = 0;
let dialogPolicy = { accept: true, promptText: "", blockUnload: false };
// Sticky frame: tabId -> URL substring (selected via frame_focus)
const stickyFrames = new Map();

function wildcardMatch(pattern, url) {
  const rx = "^" + String(pattern).split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  try {
    return new RegExp(rx).test(url);
  } catch {
    return false;
  }
}

function strToB64(s) {
  // UTF-8-safe base64 (btoa in a service worker wants latin1)
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function push(arr, item) {
  arr.push(item);
  if (arr.length > MAX) arr.shift();
}

function sendEvent(kind, data) {
  push(kind === "console" ? consoleLogs : networkLogs, data);
  if (kind === "network" && data && data.requestId) {
    networkMap.set(String(data.requestId), data);
    if (networkMap.size > MAX * 1.5) {
      const iter = networkMap.keys();
      for (let i = 0; i < 200; i++) {
        const k = iter.next().value;
        if (k !== undefined) networkMap.delete(k);
        else break;
      }
    }
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "event", kind, data }));
  }
}

// ---------- WS ----------
function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws = new WebSocket(`ws://127.0.0.1:${currentPort}`);
  } catch {
    schedule();
    return;
  }
  ws.onopen = () => {
    reconnectMs = 1000;
    console.log(`[mcp] bridge connected on port ${currentPort}`);
    // Identify ourselves to the server (so popup probes don't hijack the socket).
    // `browser` lets the server remember which browser holds the extension
    // and launch the same one next time (not hardcoded Chrome-first).
    try {
      let browser = "chrome";
      try {
        const ua = navigator.userAgent || "";
        if (/Edg\//.test(ua)) browser = "edge";
        else if (/OPR\/|Opera/.test(ua)) browser = "opera";
        else if (/\bBrave\//.test(ua)) browser = "brave";
      } catch {}
      ws.send(JSON.stringify({ type: "hello", role: "extension", browser }));
    } catch {}
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "ping") return;
    if (!msg.id || !msg.action) return;
    const start = Date.now();
    let ok = true, errStr = null;
    try {
      const result = await handleCommand(msg.action, msg.payload || {}, msg.tabId);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      ok = false;
      errStr = String((e && e.message) || e);
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, ok: false, error: errStr })); } catch {}
    } finally {
      recordCommandHistory({
        id: msg.id,
        action: msg.action,
        ok,
        error: errStr,
        durationMs: Date.now() - start,
        time: Date.now(),
        tabId: msg.tabId ?? null,
      });
    }
  };
  ws.onclose = () => schedule();
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function schedule() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectMs);
  reconnectMs = Math.min(reconnectMs * 2, 10000);
}

function setPort(newPort) {
  const p = Number(newPort);
  if (!p || p <= 0 || p >= 65536) return;
  if (p === currentPort && ws && ws.readyState === WebSocket.OPEN) return;
  currentPort = p;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch {}
    ws = null;
  }
  reconnectMs = 1000;
  connect();
}

// Initial port load & connection
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get("mcpPort", (res) => {
    if (res && res.mcpPort) {
      const p = Number(res.mcpPort);
      if (p > 0 && p < 65536) currentPort = p;
    }
    connect();
  });
} else {
  connect();
}
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }
}, 20000);

// Heartbeat alarm: wakes up the service worker and reconnects if disconnected
if (typeof chrome !== "undefined" && chrome.alarms) {
  try {
    chrome.alarms.create("mcp_heartbeat", { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "mcp_heartbeat") {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          connect();
        }
      }
    });
  } catch {}
}

// ---------- console hook: MAIN-world override ----------
// The page's own CSP can block <script> injection and content-world eval;
// overrides installed via the scripting API into the MAIN world are
// unaffected by page CSP. __mcpHookInstalled prevents double installs.
function mcpPageHookMain() {
  if (window.__mcpHookInstalled) return;
  window.__mcpHookInstalled = true;
  window.__mcpLogs = [];
  const levels = ["log", "info", "warn", "error", "debug"];
  for (const lv of levels) {
    try {
      const orig = console[lv].bind(console);
      console[lv] = (...args) => {
        try {
          const text = args
            .map((a) => {
              try {
                return typeof a === "string" ? a : JSON.stringify(a);
              } catch {
                return String(a);
              }
            })
            .join(" ");
          const entry = { level: lv, text: text.slice(0, 2000), url: location.href, ts: Date.now() };
          window.__mcpLogs.push(entry);
          if (window.__mcpLogs.length > 500) window.__mcpLogs.shift();
          window.postMessage({ __mcpConsole: entry }, "*");
        } catch {}
        orig(...args);
      };
    } catch {}
  }
  window.addEventListener("error", (e) => {
    try {
      const entry = { level: "error", text: `Uncaught: ${e.message}`, url: location.href, ts: Date.now() };
      window.__mcpLogs.push(entry);
      window.postMessage({ __mcpConsole: entry }, "*");
    } catch {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      const entry = { level: "error", text: `Unhandled rejection: ${e.reason}`, url: location.href, ts: Date.now() };
      window.__mcpLogs.push(entry);
      window.postMessage({ __mcpConsole: entry }, "*");
    } catch {}
  });
}

async function installConsoleHook(tabId) {
  if (tabId == null || tabId < 0) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: mcpPageHookMain,
    });
  } catch {}
}

function installPageHooks(tabId) {
  installConsoleHook(tabId);
  installDialogHook(tabId, dialogPolicy);
}

if (chrome.webNavigation && chrome.webNavigation.onCompleted) {
  // onCommitted: early (catch console/dialogs during load)
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) {
      // Stale sticky frame: navigation left the focused frame's URL behind.
      const sticky = stickyFrames.get(d.tabId);
      if (sticky && !(d.url || "").includes(sticky)) stickyFrames.delete(d.tabId);
      installPageHooks(d.tabId);
    }
  });
  // onCompleted: guaranteed install
  chrome.webNavigation.onCompleted.addListener((d) => {
    if (d.frameId === 0) installPageHooks(d.tabId);
  });
}

// ---------- dialog hook: MAIN-world alert/confirm/prompt + beforeunload ----------
function mcpDialogHookMain(policy) {
  try {
    if (window.__mcpDialogInstalled) {
      window.__mcpDialogPolicy = policy;
      return;
    }
    window.__mcpDialogInstalled = true;
    window.__mcpDialogPolicy = policy || { accept: true };
    const push = (entry) => {
      try {
        window.postMessage({ __mcpDialog: entry }, "*");
      } catch {}
    };
    window.alert = (msg) => {
      push({ kind: "alert", message: String(msg), url: location.href, ts: Date.now(), response: "ok" });
    };
    window.confirm = (msg) => {
      const ok = !!(window.__mcpDialogPolicy && window.__mcpDialogPolicy.accept);
      push({ kind: "confirm", message: String(msg), url: location.href, ts: Date.now(), response: ok ? "accepted" : "dismissed" });
      return ok;
    };
    window.prompt = (msg, def) => {
      const p = window.__mcpDialogPolicy || {};
      const res = p.accept ? (p.promptText !== undefined && p.promptText !== "" ? p.promptText : (def ?? "")) : null;
      push({ kind: "prompt", message: String(msg), url: location.href, ts: Date.now(), response: res });
      return res;
    };
    if (policy && policy.blockUnload) {
      try {
        Object.defineProperty(window, "onbeforeunload", { get: () => null, set: () => {}, configurable: true });
        const origAdd = window.addEventListener.bind(window);
        window.addEventListener = (t, ...rest) => {
          if (t === "beforeunload") return;
          return origAdd(t, ...rest);
        };
      } catch {}
    }
  } catch {}
}

async function installDialogHook(tabId, policy) {
  if (tabId == null || tabId < 0) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: mcpDialogHookMain,
      args: [policy || dialogPolicy],
    });
  } catch {}
}

async function pushDialogPolicyToAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) installDialogHook(t.id, dialogPolicy);
  } catch {}
}

// ---------- helpers ----------
async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("No active tab");
  return t.id;
}

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Clipboard read and write for MCP browser bridge",
    });
  } catch (e) {
    if (!String(e).includes("only a single offscreen")) throw e;
  }
}

async function ensureContent(tabId, retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { __mcp: 1, cmd: "__ping", payload: {} });
      return;
    } catch (e) {
      lastErr = e;
    }
    // missing, or waking from bfcache: inject and wait a bit
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr || new Error("Could not install content script");
}

async function toContent(tabId, cmd, payload, timeoutMs = 25000) {
  const id = tabId ?? (await activeTabId());
  await ensureContent(id);
  const msg = { __mcp: 1, cmd, payload };
  const sticky = stickyFrames.get(id);
  if (sticky) msg.__frameUrl = sticky;
  const p = chrome.tabs.sendMessage(id, msg);
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error(`Content did not respond (${cmd})`)), timeoutMs));
  return { tabId: id, value: await Promise.race([p, timer]) };
}

function unwrap(res) {
  if (!res.value) throw new Error("Content returned an empty response");
  if (res.value.ok === false) throw new Error(res.value.error || "Content error");
  return res.value.result;
}

// debugger attach helper (CDP). Shares the attach while a mock session holds it
// (a second attach to the same tab is forbidden in Chrome).
async function withDebugger(tabId, fn) {
  const dbg = { tabId };
  if (fetchSessions.has(tabId) || emulationSessions.has(tabId)) return await fn(dbg);
  await chrome.debugger.attach(dbg, "1.3");
  try {
    return await fn(dbg);
  } finally {
    if (!fetchSessions.has(tabId) && !emulationSessions.has(tabId)) {
      try {
        await chrome.debugger.detach(dbg);
      } catch {}
    }
  }
}

async function saveMockSessions() {
  try {
    await chrome.storage.session.set({
      mcpMock: Array.from(fetchSessions.entries()).map(([tabId, s]) => ({ tabId, routes: s.routes })),
    });
  } catch {}
}

async function restoreMockSessions() {
  let saved = null;
  try {
    const got = await chrome.storage.session.get("mcpMock");
    saved = got && got.mcpMock;
  } catch {
    return;
  }
  if (!Array.isArray(saved)) return;
  for (const s of saved) {
    try {
      const tabs = await chrome.tabs.query({});
      if (!tabs.some((t) => t.id === s.tabId)) continue;
      const dbg = { tabId: s.tabId };
      try {
        await chrome.debugger.attach(dbg, "1.3");
      } catch (e) {
        if (!/already attached/i.test(String((e && e.message) || e))) continue;
      }
      await cdpSend(dbg, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      try {
        await cdpSend(dbg, "Network.enable", {});
      } catch {}
      fetchSessions.set(s.tabId, { routes: s.routes || [], netmap: new Map(), bodies: [] });
    } catch {}
  }
}

restoreMockSessions();

function cdpSend(dbg, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(dbg, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// ---------- network hook (webRequest) ----------
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    sendEvent("network", {
      phase: "request",
      requestId: String(d.requestId),
      url: d.url,
      method: d.method,
      type: d.type,
      tabId: d.tabId,
      ts: Date.now(),
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    sendEvent("network", {
      phase: "response",
      requestId: String(d.requestId),
      url: d.url,
      method: d.method,
      type: d.type,
      tabId: d.tabId,
      statusCode: d.statusCode,
      fromCache: d.fromCache,
      ts: Date.now(),
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener((d) => {
  sendEvent("network", {
    phase: "error",
    requestId: String(d.requestId),
    url: d.url,
    type: d.type,
    tabId: d.tabId,
    error: d.error,
    ts: Date.now(),
  });
}, { urls: ["<all_urls>"] });

// Header enrichment (for HAR): merged into the log with the same requestId
chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    const log = networkMap.get(String(d.requestId)) || networkLogs.find((e) => String(e.requestId) === String(d.requestId));
    if (log && d.requestHeaders) log.requestHeaders = d.requestHeaders.slice(0, 50);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const log = networkMap.get(String(d.requestId)) || networkLogs.find((e) => String(e.requestId) === String(d.requestId));
    if (log) {
      if (d.responseHeaders) log.responseHeaders = d.responseHeaders.slice(0, 50);
      if (d.statusCode) log.statusCode = d.statusCode;
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---------- Fetch mock sessions (debugger events) ----------
chrome.debugger.onEvent.addListener((source, method, params) => {
  const sess = fetchSessions.get(source.tabId);
  if (method === "Network.responseReceived" && sess && params.response) {
    sess.netmap.set(params.requestId, {
      url: params.response.url || "",
      status: params.response.status || 0,
      mime: params.response.mimeType || "",
    });
    if (sess.netmap.size > 500) {
      const first = sess.netmap.keys().next().value;
      sess.netmap.delete(first);
    }
    return;
  }
  if (method === "Network.loadingFinished" && sess) {
    const meta = sess.netmap.get(params.requestId);
    if (meta && meta.url && !meta.url.startsWith("data:")) {
      cdpSend({ tabId: source.tabId }, "Network.getResponseBody", { requestId: params.requestId })
        .then((b) => {
          const body = b.body || "";
          if (body.length > 200000) return;
          sess.bodies.push({ url: meta.url, status: meta.status, mime: meta.mime, base64: !!b.base64Encoded, body: body.slice(0, 200000), ts: Date.now() });
          if (sess.bodies.length > 100) sess.bodies.shift();
        })
        .catch(() => {});
    }
    return;
  }
  if (method !== "Fetch.requestPaused") return;
  if (!sess) return;
  const url = (params.request && params.request.url) || "";
  const route = sess.routes.find((r) => wildcardMatch(r.pattern, url));
  const dbg = { tabId: source.tabId };
  const cont = (extra) => {
    cdpSend(dbg, "Fetch.continueRequest", Object.assign({ requestId: params.requestId }, extra || {})).catch(() => {});
  };
  if (!route) {
    // Spy mode: record full request (incl. POST body), then let it through.
    try {
      const req = params.request || {};
      push(sess.bodies, {
        url,
        method: req.method || "GET",
        kind: "request",
        headers: req.headers || {},
        postData: (req.postData || "").slice(0, 50000),
        ts: Date.now(),
      });
      if (sess.bodies.length > 200) sess.bodies.splice(0, sess.bodies.length - 200);
    } catch {}
    cont();
    return;
  }
  try {
    if (route.action === "block") {
      cdpSend(dbg, "Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" }).catch(() => {});
    } else if (route.action === "fulfill") {
      const body = route.body || "";
      const ct = route.contentType || "application/json";
      const headers = [
        { name: "Content-Type", value: ct },
        { name: "Content-Length", value: String(new TextEncoder().encode(body).length) },
        { name: "X-MCP-Mock", value: "1" },
      ];
      for (const h of route.headers || []) headers.push({ name: h.name, value: h.value });
      cdpSend(dbg, "Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: route.status || 200,
        responseHeaders: headers,
        body: strToB64(body),
      }).catch(() => {});
      sendEvent("network", {
        phase: "mock",
        requestId: String(params.requestId),
        url,
        method: (params.request && params.request.method) || "GET",
        type: params.resourceType,
        tabId: source.tabId,
        statusCode: route.status || 200,
        ts: Date.now(),
      });
    } else if (route.action === "delay") {
      const extra = route.headers && route.headers.length ? { headers: route.headers } : undefined;
      setTimeout(() => cont(extra), route.delayMs || 1000);
    } else {
      cont(route.headers && route.headers.length ? { headers: route.headers } : undefined);
    }
  } catch {
    cont();
  }
});

chrome.debugger.onDetach.addListener((source) => {
  // Drop the session if it was attached for mocking (leave foreign attaches alone)
  if (fetchSessions.has(source.tabId)) fetchSessions.delete(source.tabId);
  if (emulationSessions.has(source.tabId)) emulationSessions.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  fetchSessions.delete(tabId);
  emulationSessions.delete(tabId);
});

// ---------- permission catalog (shared source with the popup) ----------
// Category -> action list. Default: all enabled.
const PERM_CATS = [
  { id: "tabs", title: "Tabs & Windows", actions: ["tabs_list", "tab_create", "tab_duplicate", "tab_close", "tab_activate", "tab_navigate", "tab_reload", "tab_back", "tab_forward", "tab_pin", "tab_mute", "window_list", "window_create", "window_focus", "browser_close", "frame_list", "frame_focus", "frame_clear", "tab_group_create", "tab_group_list", "tab_group_update", "tab_group_ungroup"] },
  { id: "read", title: "Page: Read", actions: ["page_snapshot", "page_html", "page_text", "dom_query", "page_find", "page_wait", "page_axtree"] },
  { id: "interact", title: "Page: Interact", actions: ["dom_click", "dom_type", "dom_fill", "dom_select", "dom_check", "dom_hover", "dom_focus", "dom_scroll", "dom_drag", "dom_upload", "keyboard_press"] },
  { id: "media", title: "Media", actions: ["page_screenshot", "page_pdf"] },
  { id: "console", title: "Console", actions: ["console_get", "console_clear"] },
  { id: "network", title: "Network: Observe", actions: ["network_requests", "network_clear", "network_response_body", "network_bodies", "network_throttle", "network_set_headers", "har_export"] },
  { id: "mock", title: "Network: Intercept", actions: ["network_mock_start", "network_mock_stop", "network_mock_route", "network_mock_list", "network_mock_remove", "network_mock_clear"] },
  { id: "downloads", title: "Downloads", actions: ["downloads_list", "downloads_pause", "downloads_resume", "downloads_cancel", "downloads_erase"] },
  { id: "bookmarks", title: "Bookmarks", actions: ["bookmarks_search", "bookmarks_list", "bookmarks_add", "bookmarks_remove"] },
  { id: "cookies", title: "Cookies", actions: ["cookies_list", "cookies_get", "cookies_set", "cookies_delete", "cookies_clear", "cookies_export", "cookies_import"] },
  { id: "storage", title: "Storage", actions: ["storage_get", "storage_set", "idb_list", "idb_stores", "idb_read", "idb_count", "idb_put", "idb_delete", "idb_clear"] },
  { id: "sessions", title: "Sessions & State", actions: ["sessions_recently_closed", "sessions_restore", "session_state_save", "session_state_load"] },
  { id: "dialogs", title: "Dialogs", actions: ["dialog_policy", "dialog_get", "dialog_clear"] },
  { id: "power", title: "Power (arbitrary code)", actions: ["js_evaluate", "cdp_send"] },
  { id: "trusted", title: "Trusted Input (CDP)", actions: ["trusted_click", "trusted_type", "trusted_key", "trusted_scroll", "trusted_drag"] },
  { id: "clipboard", title: "Clipboard", actions: ["clipboard_read", "clipboard_write"] },
  { id: "browsing_data", title: "Browsing Data", actions: ["browsing_data_clear"] },
  { id: "notifications", title: "Notifications", actions: ["notification_create", "notification_clear"] },
  { id: "system", title: "System", actions: ["page_metrics", "permissions_grant", "emulation_geolocation", "emulation_geolocation_clear", "history_search", "history_delete"] },
];
const PERM_ALL = PERM_CATS.flatMap((c) => c.actions);

// Disabled actions (default: all enabled). Persisted in chrome.storage.local.
let disabledActions = new Set();
let permsLoaded = false;

async function loadPerms() {
  try {
    const got = await chrome.storage.local.get("mcpDisabled");
    const arr = got && got.mcpDisabled;
    if (Array.isArray(arr)) disabledActions = new Set(arr.filter((a) => PERM_ALL.includes(a)));
  } catch {}
  permsLoaded = true;
}

async function savePerms() {
  try {
    await chrome.storage.local.set({ mcpDisabled: Array.from(disabledActions) });
  } catch {}
}

function isAllowed(action) {
  const normalized = action === "tab_list" ? "tabs_list" : action;
  return !disabledActions.has(normalized);
}

loadPerms();
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.mcpDisabled && Array.isArray(changes.mcpDisabled.newValue)) {
        disabledActions = new Set(changes.mcpDisabled.newValue.filter((a) => PERM_ALL.includes(a)));
      }
      if (changes.mcpPort && changes.mcpPort.newValue) {
        const np = Number(changes.mcpPort.newValue);
        if (np > 0 && np < 65536 && np !== currentPort) {
          setPort(np);
        }
      }
    }
  });
}

// ---------- message router (popup + content) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "mcp-console" && msg.entry) {
    sendEvent("console", { ...msg.entry, tabId: sender.tab?.id ?? null });
    return false;
  }
  if (msg && msg.type === "mcp-dialog" && msg.entry) {
    const full = { ...msg.entry, tabId: sender.tab?.id ?? null };
    push(dialogEvents, full);
    return false;
  }
  if (msg && msg.type === "mcp-status") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => {
      sendResponse({
        bridgeConnected: !!ws && ws.readyState === WebSocket.OPEN,
        port: currentPort,
        activeTab: t ? { id: t.id, title: t.title || "Untitled", url: t.url || "" } : null,
      });
    }).catch(() => {
      sendResponse({
        bridgeConnected: !!ws && ws.readyState === WebSocket.OPEN,
        port: currentPort,
        activeTab: null,
      });
    });
    return true;
  }
  if (msg && msg.type === "mcp-history-get") {
    sendResponse({ history: commandHistory });
    return true;
  }
  if (msg && msg.type === "mcp-history-clear") {
    commandHistory.length = 0;
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === "mcp-port-get") {
    sendResponse({ port: currentPort });
    return true;
  }
  if (msg && msg.type === "mcp-port-set") {
    const p = Number(msg.port);
    if (p > 0 && p < 65536) {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ mcpPort: p });
      }
      setPort(p);
      sendResponse({ ok: true, port: p });
    } else {
      sendResponse({ ok: false, error: "Invalid port number" });
    }
    return true;
  }
  if (msg && msg.type === "mcp-perms-get") {
    sendResponse({ cats: PERM_CATS, disabled: Array.from(disabledActions) });
    return true;
  }
  if (msg && msg.type === "mcp-perms-set") {
    // {action, enabled} single or {actions:{name:bool}} bulk
    if (msg.action) {
      if (msg.enabled) disabledActions.delete(msg.action);
      else if (PERM_ALL.includes(msg.action)) disabledActions.add(msg.action);
    }
    if (msg.actions && typeof msg.actions === "object") {
      for (const [a, on] of Object.entries(msg.actions)) {
        if (!PERM_ALL.includes(a)) continue;
        if (on) disabledActions.delete(a);
        else disabledActions.add(a);
      }
    }
    savePerms();
    sendResponse({ ok: true, disabled: Array.from(disabledActions) });
    return true;
  }
  return false;
});

// ---------- command router ----------
async function handleCommand(action, payload, tabId) {
  if (!permsLoaded) await loadPerms();
  // Permission check (perm_list/perm_set are always allowed)
  if (action !== "perm_list" && action !== "perm_set" && !isAllowed(action)) {
    throw new Error(`Permission disabled in extension: ${action} (enable it from the extension popup)`);
  }
  switch (action) {
    case "perm_list": {
      return {
        cats: PERM_CATS.map((c) => ({
          id: c.id,
          title: c.title,
          total: c.actions.length,
          enabled: c.actions.filter((a) => !disabledActions.has(a)).length,
        })),
        disabled: Array.from(disabledActions),
      };
    }
    case "perm_set": {
      const a = payload.action;
      if (!PERM_ALL.includes(a)) throw new Error(`Unknown permission: ${a}`);
      if (payload.enabled) disabledActions.delete(a);
      else disabledActions.add(a);
      savePerms();
      return { ok: true, action: a, enabled: !disabledActions.has(a) };
    }
    // ----- tabs -----
    case "tab_list":
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }
    case "tab_create": {
      const t = await chrome.tabs.create({ url: payload.url || "about:blank", active: payload.active !== false });
      return { id: t.id, url: t.url };
    }
    case "tab_duplicate": {
      const id = tabId ?? (await activeTabId());
      const dup = await chrome.tabs.duplicate(id);
      return { ok: true, tab: { id: dup.id, title: dup.title, url: dup.url, active: dup.active, windowId: dup.windowId } };
    }
    case "tab_close": {
      const id = tabId ?? (await activeTabId());
      // Closing the last tab of the last window quits the browser:
      // treat it as browser_close for permission purposes.
      const allTabs = await chrome.tabs.query({});
      const wins = await chrome.windows.getAll({});
      if (allTabs.length === 1 && wins.length === 1 && !isAllowed("browser_close")) {
        throw new Error("Permission disabled in extension: browser_close (closing this tab would quit the browser)");
      }
      await chrome.tabs.remove(id);
      return { ok: true, closed: id };
    }
    case "tab_activate": {
      const id = tabId ?? (await activeTabId());
      await chrome.tabs.update(id, { active: true });
      const t = await chrome.tabs.get(id);
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true, id };
    }
    case "tab_navigate": {
      const id = tabId ?? (await activeTabId());
      await chrome.tabs.update(id, { url: payload.url });
      return { ok: true, id, url: payload.url };
    }
    case "tab_reload": {
      const id = tabId ?? (await activeTabId());
      await chrome.tabs.reload(id);
      return { ok: true, id };
    }
    case "tab_back": {
      const id = tabId ?? (await activeTabId());
      await chrome.scripting.executeScript({ target: { tabId: id }, func: () => history.back() });
      return { ok: true };
    }
    case "tab_forward": {
      const id = tabId ?? (await activeTabId());
      await chrome.scripting.executeScript({ target: { tabId: id }, func: () => history.forward() });
      return { ok: true };
    }
    case "tab_group_create": {
      if (!Array.isArray(payload.tabIds) || payload.tabIds.length === 0) {
        throw new Error("tabIds array is required");
      }
      const groupId = await chrome.tabs.group({ tabIds: payload.tabIds });
      const props = {};
      if (payload.title !== undefined) props.title = payload.title;
      if (payload.color !== undefined) props.color = payload.color;
      if (payload.collapsed !== undefined) props.collapsed = !!payload.collapsed;
      let group;
      if (Object.keys(props).length > 0) {
        group = await chrome.tabGroups.update(groupId, props);
      } else {
        group = await chrome.tabGroups.get(groupId);
      }
      return { ok: true, group };
    }
    case "tab_group_list": {
      const q = {};
      if (payload.windowId !== undefined) q.windowId = payload.windowId;
      if (payload.title !== undefined) q.title = payload.title;
      const groups = await chrome.tabGroups.query(q);
      const enriched = await Promise.all(
        groups.map(async (g) => {
          const tabs = await chrome.tabs.query({ groupId: g.id });
          return {
            ...g,
            tabIds: tabs.map((t) => t.id),
            tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
          };
        })
      );
      return { ok: true, groups: enriched };
    }
    case "tab_group_update": {
      if (payload.groupId == null) throw new Error("groupId is required");
      const props = {};
      if (payload.title !== undefined) props.title = payload.title;
      if (payload.color !== undefined) props.color = payload.color;
      if (payload.collapsed !== undefined) props.collapsed = !!payload.collapsed;
      const group = await chrome.tabGroups.update(payload.groupId, props);
      return { ok: true, group };
    }
    case "tab_group_ungroup": {
      if (!Array.isArray(payload.tabIds) || payload.tabIds.length === 0) {
        throw new Error("tabIds array is required");
      }
      await chrome.tabs.ungroup(payload.tabIds);
      return { ok: true, tabIds: payload.tabIds };
    }

    // ----- page/dom (delegate to content) -----
    case "page_snapshot":
    case "page_html":
    case "page_text":
    case "dom_query":
    case "dom_click":
    case "dom_type":
    case "dom_fill":
    case "dom_select":
    case "dom_check":
    case "dom_hover":
    case "dom_focus":
    case "dom_scroll":
    case "dom_drag":
    case "keyboard_press":
    case "page_find":
    case "page_wait":
    case "storage_get":
    case "storage_set":
    case "idb_list":
    case "idb_stores":
    case "idb_read":
    case "idb_count":
    case "idb_put":
    case "idb_delete":
    case "idb_clear": {
      const r = await toContent(tabId, action, payload);
      const v = unwrap(r);
      // string results (snapshot/html/text) pass through for AI readability
      if (typeof v === "string") return { tabId: r.tabId, text: v };
      if (Array.isArray(v)) return { tabId: r.tabId, items: v };
      if (v && typeof v === "object") return Object.assign({ tabId: r.tabId }, v);
      return { tabId: r.tabId, value: v };
    }

    case "js_evaluate": {
      // CSP-safe: evaluated via CDP Runtime.evaluate (trusted, bypasses both
      // page CSP and the extension's own script-src without unsafe-eval).
      // Never use eval/new Function here or in content.js.
      const id = tabId ?? (await activeTabId());
      const expr = String(payload.expression ?? "");
      const awaitPromise = !!payload.awaitPromise;
      const out = await withDebugger(id, async (dbg) => {
        const first = await cdpSend(dbg, "Runtime.evaluate", {
          expression: expr,
          awaitPromise,
          returnByValue: true,
          includeCommandLineAPI: true,
        });
        if (!first.exceptionDetails) {
          const r = first.result || {};
          const val = r.value !== undefined ? r.value : r.description;
          return { value: val, via: "cdp" };
        }
        // `return` outside a function or multi-statement input fails as a
        // bare expression: retry with function-body semantics
        // (old `new Function` behavior) inside an async IIFE.
        const wrapped = `(async () => { ${expr} })()`;
        const second = await cdpSend(dbg, "Runtime.evaluate", {
          expression: wrapped,
          awaitPromise: true,
          returnByValue: true,
          includeCommandLineAPI: true,
        });
        if (second.exceptionDetails) {
          throw new Error(`Page JS error: ${JSON.stringify(second.exceptionDetails).slice(0, 1000)}`);
        }
        const r2 = second.result || {};
        const val2 = r2.value !== undefined ? r2.value : r2.description;
        return { value: val2, via: "cdp" };
      });
      return { tabId: id, ...out };
    }

    case "page_screenshot": {
      const id = tabId ?? (await activeTabId());
      await chrome.tabs.update(id, { active: true });
      const t = await chrome.tabs.get(id);
      await chrome.windows.update(t.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, 300));
      if (payload.selector) {
        // Element screenshot: resolve box via CDP, capture clipped at full res.
        let sel = payload.selector;
        const m = String(sel || "").match(/^(?:ref=)?(e\d+)$/);
        if (m) sel = `[data-mcp-ref="${m[1]}"]`;
        const data = await withDebugger(id, async (dbg) => {
          await cdpSend(dbg, "DOM.enable", {});
          const doc = await cdpSend(dbg, "DOM.getDocument", { depth: 0 });
          const q = await cdpSend(dbg, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
          if (!q.nodeId) throw new Error(`Element not found: ${payload.selector}`);
          const box = await cdpSend(dbg, "DOM.getBoxModel", { nodeId: q.nodeId });
          const quad = box.model.border;
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const shot = await cdpSend(dbg, "Page.captureScreenshot", {
            format: "png",
            clip: {
              x: Math.min(...xs),
              y: Math.min(...ys),
              width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys),
              scale: payload.scale || 1,
            },
            captureBeyondViewport: true,
          });
          return shot.data;
        });
        return { tabId: id, dataUrl: `data:image/png;base64,${data}`, note: "element base64 dataUrl" };
      }
      if (payload.fullPage) {
        // fullPage: whole page via debugger
        const data = await withDebugger(id, async (dbg) => {
          const metrics = await cdpSend(dbg, "Page.getLayoutMetrics", {});
          const { width, height } = metrics.cssContentSize || metrics.contentSize || { width: 1280, height: 800 };
          const { data } = await cdpSend(dbg, "Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width, height, scale: 1 },
            captureBeyondViewport: true,
          });
          return data;
        });
        return { tabId: id, dataUrl: `data:image/png;base64,${data}`, note: "fullPage base64 dataUrl" };
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
      return { tabId: id, dataUrl, note: "visible-tab base64 dataUrl (the AI can view this image)" };
    }

    case "page_pdf": {
      const id = tabId ?? (await activeTabId());
      const pdf = await withDebugger(id, async (dbg) => {
        return await cdpSend(dbg, "Page.printToPDF", { printBackground: true });
      });
      return { tabId: id, dataBase64: pdf.data, note: "PDF base64 (write the data field to a file)" };
    }

    // ----- console -----
    case "console_get": {
      const lvl = payload.level || "all";
      const lim = payload.limit || 200;
      const arr = consoleLogs
        .filter((e) => lvl === "all" || e.level === lvl)
        .slice(-lim);
      return { count: arr.length, logs: arr };
    }
    case "console_clear": {
      consoleLogs.length = 0;
      return { ok: true };
    }

    // ----- network: observe -----
    case "network_requests": {
      let arr = networkLogs.slice();
      if (payload.tabId !== undefined) arr = arr.filter((e) => e.tabId === payload.tabId);
      if (payload.filter) arr = arr.filter((e) => (e.url || "").includes(payload.filter));
      if (payload.type) arr = arr.filter((e) => e.type === payload.type);
      if (payload.failedOnly) arr = arr.filter((e) => (e.statusCode && e.statusCode >= 400) || e.phase === "error");
      if (payload.minStatus !== undefined) arr = arr.filter((e) => e.statusCode && e.statusCode >= payload.minStatus);
      if (payload.limit) arr = arr.slice(-payload.limit);
      else arr = arr.slice(-200);
      return { count: arr.length, requests: arr };
    }
    case "network_clear": {
      networkLogs.length = 0;
      networkMap.clear();
      return { ok: true };
    }
    case "network_response_body": {
      // webRequest exposes no bodies; re-fetch in page context.
      const entry = networkMap.get(String(payload.requestId)) || networkLogs.find((e) => String(e.requestId) === String(payload.requestId));
      const url = entry?.url || payload.url;
      if (!url) throw new Error("requestId not found, list with network_requests");
      const targetTab = tabId ?? entry?.tabId ?? (await activeTabId());
      const r = await toContent(targetTab, "network_refetch", { url });
      return { url, ...unwrap(r) };
    }
    case "network_throttle": {
      const id = tabId ?? (await activeTabId());
      const profile = payload.profile || "online";
      let params = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
      if (profile === "offline") {
        params = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
      } else if (profile === "slow3g") {
        params = { offline: false, latency: 400, downloadThroughput: Math.round((400 * 1024) / 8), uploadThroughput: Math.round((400 * 1024) / 8) };
      } else if (profile === "fast3g") {
        params = { offline: false, latency: 150, downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8), uploadThroughput: Math.round((750 * 1024) / 8) };
      } else if (profile === "custom") {
        params = {
          offline: !!payload.offline,
          latency: payload.latency ?? 0,
          downloadThroughput: payload.downloadThroughput ?? -1,
          uploadThroughput: payload.uploadThroughput ?? -1,
        };
      }
      await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "Network.enable", {});
        await cdpSend(dbg, "Network.emulateNetworkConditions", params);
      });
      return { ok: true, tabId: id, profile, params };
    }
    case "network_set_headers": {
      const id = tabId ?? (await activeTabId());
      const headers = payload.headers || {};
      await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "Network.enable", {});
        await cdpSend(dbg, "Network.setExtraHTTPHeaders", { headers });
      });
      return { ok: true, tabId: id, headers };
    }

    // ----- cookies -----
    case "cookies_list": {
      const q = {};
      if (payload.domain) q.domain = payload.domain;
      if (payload.url) q.url = payload.url;
      if (payload.name) q.name = payload.name;
      const all = await chrome.cookies.getAll(q);
      return {
        count: all.length,
        cookies: all.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate,
        })),
      };
    }
    case "cookies_get": {
      if (!payload.name || !payload.url) throw new Error("name and url are required for cookies_get");
      const cookie = await chrome.cookies.get({ url: payload.url, name: payload.name });
      return { ok: true, found: !!cookie, cookie };
    }
    case "cookies_set": {
      const details = {
        url: payload.url,
        name: payload.name,
        value: payload.value,
        path: payload.path || "/",
      };
      if (payload.domain) details.domain = payload.domain;
      if (payload.secure !== undefined) details.secure = payload.secure;
      if (payload.httpOnly !== undefined) details.httpOnly = payload.httpOnly;
      if (payload.sameSite) details.sameSite = payload.sameSite;
      if (payload.expirationDate) details.expirationDate = payload.expirationDate;
      const cookie = await chrome.cookies.set(details);
      return { ok: true, cookie };
    }
    case "cookies_delete": {
      if (!payload.name || !payload.url) throw new Error("name and url are required for cookies_delete");
      const removed = await chrome.cookies.remove({ url: payload.url, name: payload.name });
      return { ok: true, removed: !!removed };
    }
    case "cookies_clear": {
      const all = await chrome.cookies.getAll(payload.domain ? { domain: payload.domain } : (payload.url ? { url: payload.url } : {}));
      let n = 0;
      for (const c of all) {
        const url = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
        try {
          await chrome.cookies.remove({ url, name: c.name });
          n++;
        } catch {}
      }
      return { ok: true, removed: n };
    }
    case "cookies_export": {
      const q = {};
      if (payload.domain) q.domain = payload.domain;
      if (payload.url) q.url = payload.url;
      const all = await chrome.cookies.getAll(q);
      return { count: all.length, cookies: all };
    }
    case "cookies_import": {
      if (!Array.isArray(payload.cookies)) throw new Error("cookies array is required");
      let imported = 0;
      for (const c of payload.cookies) {
        try {
          const url = c.url || `http${c.secure ? "s" : ""}://${(c.domain || "").replace(/^\./, "")}${c.path || "/"}`;
          const details = {
            url,
            name: c.name,
            value: c.value,
            path: c.path || "/",
          };
          if (c.domain && !c.domain.startsWith(".")) details.domain = c.domain;
          if (c.secure !== undefined) details.secure = c.secure;
          if (c.httpOnly !== undefined) details.httpOnly = c.httpOnly;
          if (c.sameSite) details.sameSite = c.sameSite;
          if (c.expirationDate) details.expirationDate = c.expirationDate;
          await chrome.cookies.set(details);
          imported++;
        } catch {}
      }
      return { ok: true, imported, total: payload.cookies.length };
    }

    // ----- sessions -----
    case "sessions_recently_closed": {
      const maxResults = payload.maxResults || 25;
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults });
      return { count: sessions.length, sessions };
    }
    case "sessions_restore": {
      const restored = await chrome.sessions.restore(payload.sessionId || undefined);
      return { ok: true, restored };
    }
    case "session_state_save": {
      const id = tabId ?? (await activeTabId());
      const t = await chrome.tabs.get(id);
      const tabUrl = t.url || "";
      let domain = "";
      try { domain = new URL(tabUrl).hostname; } catch {}
      const cookies = domain ? await chrome.cookies.getAll({ domain }) : [];
      const storageRes = await toContent(id, "storage_get", { area: "local" });
      const sessionRes = await toContent(id, "storage_get", { area: "session" });
      const state = {
        url: tabUrl,
        domain,
        savedAt: Date.now(),
        cookies,
        localStorage: unwrap(storageRes)?.data || {},
        sessionStorage: unwrap(sessionRes)?.data || {},
      };
      return { ok: true, state };
    }
    case "session_state_load": {
      const { state } = payload;
      if (!state || typeof state !== "object") throw new Error("state object is required");
      const id = tabId ?? (await activeTabId());
      let importedCookies = 0;
      if (Array.isArray(state.cookies)) {
        for (const c of state.cookies) {
          try {
            const url = c.url || `http${c.secure ? "s" : ""}://${(c.domain || "").replace(/^\./, "")}${c.path || "/"}`;
            await chrome.cookies.set({
              url,
              name: c.name,
              value: c.value,
              path: c.path || "/",
              domain: c.domain && !c.domain.startsWith(".") ? c.domain : undefined,
              secure: c.secure,
              httpOnly: c.httpOnly,
              sameSite: c.sameSite,
              expirationDate: c.expirationDate,
            });
            importedCookies++;
          } catch {}
        }
      }
      if (state.localStorage && typeof state.localStorage === "object") {
        for (const [k, v] of Object.entries(state.localStorage)) {
          await toContent(id, "storage_set", { area: "local", key: k, value: String(v) });
        }
      }
      if (state.sessionStorage && typeof state.sessionStorage === "object") {
        for (const [k, v] of Object.entries(state.sessionStorage)) {
          await toContent(id, "storage_set", { area: "session", key: k, value: String(v) });
        }
      }
      return { ok: true, importedCookies, restoredStorage: true };
    }

    // ----- history -----
    case "history_search": {
      const items = await chrome.history.search({ text: payload.query, maxResults: payload.limit || 20 });
      return { count: items.length, items: items.map((h) => ({ title: h.title, url: h.url, lastVisit: h.lastVisitTime, visits: h.visitCount })) };
    }
    case "history_delete": {
      if (payload.url) {
        await chrome.history.deleteUrl({ url: payload.url });
        return { ok: true, deletedUrl: payload.url };
      }
      if (payload.all) {
        await chrome.history.deleteAll();
        return { ok: true, all: true };
      }
      if (payload.startTime !== undefined || payload.endTime !== undefined) {
        await chrome.history.deleteRange({
          startTime: payload.startTime ?? 0,
          endTime: payload.endTime ?? Date.now(),
        });
        return { ok: true, range: { startTime: payload.startTime, endTime: payload.endTime } };
      }
      throw new Error("Provide url, all: true, or startTime/endTime range");
    }

    // ----- network mock -----
    case "network_mock_start": {
      const id = tabId ?? (await activeTabId());
      const dbg = { tabId: id };
      let tookOver = false;
      if (!fetchSessions.has(id)) {
        try {
          await chrome.debugger.attach(dbg, "1.3");
        } catch (e) {
          // Take over a stale debugger attach on the tab (leaked from a previous session, etc.)
          if (!/already attached/i.test(String((e && e.message) || e))) throw e;
          try {
            await chrome.debugger.detach(dbg);
          } catch {}
          await chrome.debugger.attach(dbg, "1.3");
          tookOver = true;
        }
        fetchSessions.set(id, { routes: [], netmap: new Map(), bodies: [] });
      }
      await cdpSend(dbg, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      try {
        await cdpSend(dbg, "Network.enable", {});
      } catch {}
      return { ok: true, tabId: id, routes: fetchSessions.get(id).routes.length, tookOver };
    }
    case "network_mock_stop": {
      const id = tabId ?? (await activeTabId());
      const dbg = { tabId: id };
      try {
        await cdpSend(dbg, "Fetch.disable", {});
      } catch {}
      try {
        await chrome.debugger.detach(dbg);
      } catch {}
      fetchSessions.delete(id);
      saveMockSessions();
      return { ok: true, tabId: id };
    }
    case "network_mock_route": {
      const id = tabId ?? (await activeTabId());
      let sess = fetchSessions.get(id);
      if (!sess) throw new Error("Run network_mock_start first");
      const route = {
        id: `r${++routeSeq}`,
        pattern: payload.pattern || "*",
        action: payload.action || "block",
        status: payload.status,
        body: payload.body,
        contentType: payload.contentType,
        delayMs: payload.delayMs,
        headers: payload.headers || [],
      };
      sess.routes.push(route);
      saveMockSessions();
      return { ok: true, tabId: id, route };
    }
    case "network_mock_list": {
      const id = tabId ?? (await activeTabId());
      const sess = fetchSessions.get(id);
      return { tabId: id, active: !!sess, routes: sess ? sess.routes : [] };
    }
    case "network_mock_remove": {
      const id = tabId ?? (await activeTabId());
      const sess = fetchSessions.get(id);
      if (!sess) return { ok: false, tabId: id };
      sess.routes = sess.routes.filter((r) => r.id !== payload.routeId);
      saveMockSessions();
      return { ok: true, tabId: id, routes: sess.routes.length };
    }
    case "network_mock_clear": {
      const id = tabId ?? (await activeTabId());
      const sess = fetchSessions.get(id);
      if (sess) sess.routes = [];
      saveMockSessions();
      return { ok: true, tabId: id };
    }
    case "network_bodies": {
      // Spy capture: full request records (method/headers/postData) + response
      // bodies collected while a mock session holds the debugger. Requires
      // network_mock_start first (no routes needed — unmatched traffic passes).
      const id = tabId ?? (await activeTabId());
      const sess = fetchSessions.get(id);
      if (!sess) throw new Error("Run network_mock_start first (spy mode needs the debugger session)");
      let items = (sess.bodies || []).slice();
      if (payload.filter) items = items.filter((e) => (e.url || "").includes(payload.filter));
      if (payload.kind) items = items.filter((e) => (e.kind || "response") === payload.kind);
      items = items.slice(-(payload.limit || 50));
      return { tabId: id, count: items.length, items };
    }

    // ----- downloads -----
    case "downloads_list": {
      const items = await chrome.downloads.search({ limit: payload.limit || 50, orderBy: ["-startTime"] });
      return {
        count: items.length,
        items: items.map((d) => ({
          id: d.id, url: d.url, filename: d.filename, state: d.state,
          paused: d.paused, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
          mime: d.mime, danger: d.danger, error: d.error,
        })),
      };
    }
    case "downloads_pause": {
      await chrome.downloads.pause(payload.id);
      return { ok: true, id: payload.id };
    }
    case "downloads_resume": {
      await chrome.downloads.resume(payload.id);
      return { ok: true, id: payload.id };
    }
    case "downloads_cancel": {
      await chrome.downloads.cancel(payload.id);
      return { ok: true, id: payload.id };
    }
    case "downloads_erase": {
      await chrome.downloads.erase({ id: payload.id });
      return { ok: true, id: payload.id };
    }

    // ----- bookmarks -----
    case "bookmarks_search": {
      const items = await chrome.bookmarks.search(payload.query || "");
      return { count: items.length, items: items.map((b) => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId })) };
    }
    case "bookmarks_list": {
      const items = await chrome.bookmarks.getChildren(payload.parentId || "1");
      return { count: items.length, items: items.map((b) => ({ id: b.id, title: b.title, url: b.url, parentId: b.parentId })) };
    }
    case "bookmarks_add": {
      const b = await chrome.bookmarks.create({ parentId: payload.parentId, title: payload.title, url: payload.url });
      return { ok: true, id: b.id, title: b.title, url: b.url };
    }
    case "bookmarks_remove": {
      await chrome.bookmarks.remove(payload.id);
      return { ok: true, id: payload.id };
    }

    // ----- file upload (CDP DOM.setFileInputFiles) -----
    case "dom_upload": {
      const id = tabId ?? (await activeTabId());
      let sel = payload.selector;
      const m = String(sel || "").match(/^(?:ref=)?(e\d+)$/);
      if (m) sel = `[data-mcp-ref="${m[1]}"]`;
      const files = payload.filePaths;
      if (!files || !files.length) throw new Error("filePaths is empty");
      const out = await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "DOM.enable", {});
        const doc = await cdpSend(dbg, "DOM.getDocument", { depth: 0 });
        const q = await cdpSend(dbg, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
        if (!q.nodeId) throw new Error(`File input not found: ${payload.selector}`);
        const desc = await cdpSend(dbg, "DOM.describeNode", { nodeId: q.nodeId });
        const attrs = {};
        const arr = desc.node.attributes || [];
        for (let i = 0; i < arr.length; i += 2) attrs[arr[i].toLowerCase()] = arr[i + 1];
        if ((desc.node.nodeName || "").toUpperCase() !== "INPUT" || (attrs.type || "").toLowerCase() !== "file") {
          throw new Error("Target is not an <input type=file>");
        }
        await cdpSend(dbg, "DOM.setFileInputFiles", { files, backendNodeId: desc.node.backendNodeId });
        const res = await cdpSend(dbg, "DOM.resolveNode", { backendNodeId: desc.node.backendNodeId });
        const fired = await cdpSend(dbg, "Runtime.callFunctionOn", {
          objectId: res.object.objectId,
          functionDeclaration: "function(){this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.files?this.files.length:0;}",
          returnByValue: true,
        });
        return { ok: true, filesSet: (fired.result && fired.result.value) || files.length };
      });
      return { tabId: id, ...out };
    }

    // ----- dialogs -----
    case "dialog_policy": {
      if (payload.accept !== undefined) dialogPolicy.accept = !!payload.accept;
      if (payload.promptText !== undefined) dialogPolicy.promptText = String(payload.promptText);
      if (payload.blockUnload !== undefined) dialogPolicy.blockUnload = !!payload.blockUnload;
      await pushDialogPolicyToAllTabs();
      return { ok: true, policy: dialogPolicy };
    }
    case "dialog_get": {
      return { count: dialogEvents.length, dialogs: dialogEvents.slice(-(payload.limit || 50)) };
    }
    case "dialog_clear": {
      dialogEvents.length = 0;
      return { ok: true };
    }

    // ----- HAR -----
    case "har_export": {
      const id = tabId ?? (await activeTabId());
      const lim = payload.limit || 300;
      const byId = new Map();
      for (const e of networkLogs) {
        if (e.tabId !== id) continue;
        const k = String(e.requestId);
        if (!byId.has(k)) byId.set(k, {});
        Object.assign(byId.get(k), e);
      }
      const entries = Array.from(byId.values()).slice(-lim).map((e) => ({
        startedDateTime: new Date(e.ts || Date.now()).toISOString(),
        time: -1,
        request: {
          method: e.method || "GET",
          url: e.url,
          headers: (e.requestHeaders || []).map((h) => ({ name: h.name, value: h.value })),
        },
        response: {
          status: e.statusCode || 0,
          headers: (e.responseHeaders || []).map((h) => ({ name: h.name, value: h.value })),
          content: { size: -1, mimeType: "" },
        },
        cache: {},
        timings: {},
      }));
      return {
        tabId: id,
        log: {
          version: "1.2",
          creator: { name: "browser-mcp", version: chrome.runtime.getManifest().version },
          pages: [{ id: "p1", title: "", pageTimings: {} }],
          entries,
        },
      };
    }

    // ----- frames -----
    case "frame_list": {
      const id = tabId ?? (await activeTabId());
      const frames = await chrome.webNavigation.getAllFrames({ tabId: id });
      return {
        tabId: id,
        sticky: stickyFrames.get(id) || null,
        frames: (frames || []).map((f) => ({ frameId: f.frameId, parentId: f.parentFrameId, url: f.url })),
      };
    }
    case "frame_focus": {
      const id = tabId ?? (await activeTabId());
      stickyFrames.set(id, payload.frameUrl);
      return { ok: true, tabId: id, frameUrl: payload.frameUrl };
    }
    case "frame_clear": {
      const id = tabId ?? (await activeTabId());
      stickyFrames.delete(id);
      return { ok: true, tabId: id };
    }

    // ----- tabs + windows -----
    case "tab_pin": {
      const id = tabId ?? (await activeTabId());
      const cur = await chrome.tabs.get(id);
      const pinned = payload.pinned !== undefined ? !!payload.pinned : !cur.pinned;
      await chrome.tabs.update(id, { pinned });
      return { ok: true, id, pinned };
    }
    case "tab_mute": {
      const id = tabId ?? (await activeTabId());
      const cur = await chrome.tabs.get(id);
      const currentlyMuted = !!(cur.mutedInfo && cur.mutedInfo.muted);
      const muted = payload.muted !== undefined ? !!payload.muted : !currentlyMuted;
      await chrome.tabs.update(id, { muted });
      return { ok: true, id, muted };
    }
    case "window_list": {
      const wins = await chrome.windows.getAll({ populate: true });
      return {
        count: wins.length,
        windows: wins.map((w) => ({
          id: w.id, focused: w.focused, state: w.state,
          tabs: (w.tabs || []).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
        })),
      };
    }
    case "window_create": {
      const w = await chrome.windows.create(payload.url ? { url: payload.url } : {});
      return { ok: true, id: w.id };
    }
    case "window_focus": {
      await chrome.windows.update(payload.windowId, { focused: true });
      return { ok: true, id: payload.windowId };
    }
    case "browser_close": {
      const wins = await chrome.windows.getAll({});
      let n = 0;
      for (const w of wins) {
        try {
          await chrome.windows.remove(w.id);
          n++;
        } catch {}
      }
      return { ok: true, closed: n };
    }

    // ----- accessibility tree -----
    case "page_axtree": {
      const id = tabId ?? (await activeTabId());
      const out = await withDebugger(id, async (dbg) => {
        const tree = await cdpSend(dbg, "Accessibility.getFullAXTree", { depth: 12 });
        let count = 0;
        const prune = (n) => {
          if (++count > 800) return null;
          const o = { role: (n.role && n.role.value) || "?", name: (n.name && n.name.value) || "" };
          if (n.value && n.value.value !== undefined) o.value = String(n.value.value).slice(0, 100);
          if (n.description && n.description.value) o.desc = String(n.description.value).slice(0, 100);
          const kids = (n.children || []).map(prune).filter(Boolean);
          if (kids.length) o.children = kids;
          if (!o.name && !kids.length && !o.value) return null;
          return o;
        };
        return (tree.nodes || []).map(prune).filter(Boolean);
      });
      return { tabId: id, nodes: out };
    }

    // ----- permissions + geolocation -----
    case "permissions_grant": {
      const map = { geolocation: "location", notifications: "notifications", camera: "camera", microphone: "microphone", popups: "popups", javascript: "javascript", images: "images", cookies: "cookies" };
      const resource = map[payload.permission];
      if (!resource || !chrome.contentSettings[resource]) throw new Error(`Unsupported permission: ${payload.permission}`);
      let origin = payload.origin;
      if (!origin) {
        const id = tabId ?? (await activeTabId());
        const t = await chrome.tabs.get(id);
        origin = new URL(t.url).origin;
      }
      await chrome.contentSettings[resource].set({ primaryPattern: `${origin}/*`, setting: payload.setting || "allow" });
      return { ok: true, permission: payload.permission, origin, setting: payload.setting || "allow" };
    }
    case "emulation_geolocation": {
      const id = tabId ?? (await activeTabId());
      const dbg = { tabId: id };
      if (!fetchSessions.has(id) && !emulationSessions.has(id)) {
        await chrome.debugger.attach(dbg, "1.3");
      }
      emulationSessions.set(id, true);
      await cdpSend(dbg, "Emulation.setGeolocationOverride", {
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy: payload.accuracy || 50,
      });
      return { ok: true, tabId: id, latitude: payload.latitude, longitude: payload.longitude };
    }
    case "emulation_geolocation_clear": {
      const id = tabId ?? (await activeTabId());
      const dbg = { tabId: id };
      try {
        await cdpSend(dbg, "Emulation.clearGeolocationOverride", {});
      } catch {}
      emulationSessions.delete(id);
      if (!fetchSessions.has(id)) {
        try {
          await chrome.debugger.detach(dbg);
        } catch {}
      }
      return { ok: true, tabId: id };
    }

    // ----- performance -----
    case "page_metrics": {
      const id = tabId ?? (await activeTabId());
      const out = await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "Performance.enable", {});
        const m = await cdpSend(dbg, "Performance.getMetrics", {});
        const keep = ["Timestamp", "AudioHandlers", "FramesPerSecond", "LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration", "JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "LayoutObjects", "Resources", "Contexts", "BackForwardCacheRestores"];
        const all = {};
        for (const x of m.metrics || []) all[x.name] = x.value;
        const out = {};
        for (const k of keep) if (all[k] !== undefined) out[k] = all[k];
        return out;
      });
      return { tabId: id, metrics: out };
    }

    // ----- trusted input (CDP Input.* — real, trusted events) -----
    case "trusted_click": {
      const id = tabId ?? (await activeTabId());
      const qr = await toContent(id, "dom_query", { selector: payload.selector });
      const items = unwrap(qr);
      const el = (items.items || items)[0];
      if (!el) throw new Error(`Element not found: ${payload.selector}`);
      const x = Math.round(el.x + el.w / 2), y = Math.round(el.y + el.h / 2);
      const btn = payload.button || "left";
      const count = payload.doubleClick ? 2 : 1;
      await withDebugger(id, async (dbg) => {
        for (let i = 1; i <= count; i++) {
          await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: btn, clickCount: i });
          await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: btn, clickCount: i });
        }
      });
      return { ok: true, tabId: id, x, y, trusted: true };
    }
    case "trusted_type": {
      const id = tabId ?? (await activeTabId());
      let sel = payload.selector;
      const m = String(sel || "").match(/^(?:ref=)?(e\d+)$/);
      if (m) sel = `[data-mcp-ref="${m[1]}"]`;
      await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "DOM.enable", {});
        const doc = await cdpSend(dbg, "DOM.getDocument", { depth: 0 });
        const q = await cdpSend(dbg, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
        if (!q.nodeId) throw new Error(`Element not found: ${payload.selector}`);
        if (payload.clearFirst) {
          const res = await cdpSend(dbg, "DOM.resolveNode", { nodeId: q.nodeId });
          await cdpSend(dbg, "Runtime.callFunctionOn", {
            objectId: res.object.objectId,
            functionDeclaration: "function(){if('value' in this){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));}else{this.textContent='';}}",
          });
        }
        await cdpSend(dbg, "DOM.focus", { nodeId: q.nodeId });
        await cdpSend(dbg, "Input.insertText", { text: payload.text || "" });
        if (payload.pressEnter) {
          await cdpSend(dbg, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
          await cdpSend(dbg, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        }
      });
      return { ok: true, tabId: id, trusted: true };
    }
    case "trusted_key": {
      const id = tabId ?? (await activeTabId());
      const NAMES = {
        Enter: { key: "Enter", code: "Enter", win: 13, text: "\r" },
        Tab: { key: "Tab", code: "Tab", win: 9, text: "" },
        Escape: { key: "Escape", code: "Escape", win: 27, text: "" },
        Backspace: { key: "Backspace", code: "Backspace", win: 8, text: "" },
        Delete: { key: "Delete", code: "Delete", win: 46, text: "" },
        ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", win: 37, text: "" },
        ArrowUp: { key: "ArrowUp", code: "ArrowUp", win: 38, text: "" },
        ArrowRight: { key: "ArrowRight", code: "ArrowRight", win: 39, text: "" },
        ArrowDown: { key: "ArrowDown", code: "ArrowDown", win: 40, text: "" },
        Home: { key: "Home", code: "Home", win: 36, text: "" },
        End: { key: "End", code: "End", win: 35, text: "" },
        PageUp: { key: "PageUp", code: "PageUp", win: 33, text: "" },
        PageDown: { key: "PageDown", code: "PageDown", win: 34, text: "" },
        " ": { key: " ", code: "Space", win: 32, text: " " },
      };
      const k = payload.key;
      let spec = NAMES[k];
      if (!spec && k && k.length === 1) {
        spec = { key: k, code: "Key" + k.toUpperCase(), win: k.toUpperCase().charCodeAt(0), text: k };
      }
      if (!spec) throw new Error(`Unsupported key: ${k}`);
      await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.win, text: spec.text, modifiers: payload.modifiers || 0 });
        await cdpSend(dbg, "Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.win, modifiers: payload.modifiers || 0 });
      });
      return { ok: true, tabId: id, trusted: true };
    }
    case "trusted_scroll": {
      const id = tabId ?? (await activeTabId());
      let { x, y } = payload;
      if (x === undefined || y === undefined) {
        const vp = await withDebugger(id, async (dbg) => {
          return await cdpSend(dbg, "Runtime.evaluate", { expression: "({w: window.innerWidth, h: window.innerHeight})", returnByValue: true });
        });
        x = x !== undefined ? x : Math.round((vp.result.value.w || 800) / 2);
        y = y !== undefined ? y : Math.round((vp.result.value.h || 600) / 2);
      }
      await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x, y,
          deltaX: payload.deltaX || 0,
          deltaY: payload.deltaY !== undefined ? payload.deltaY : 500,
          modifiers: 0,
          pointerType: "mouse",
        });
      });
      return { ok: true, tabId: id, x, y, trusted: true };
    }
    case "trusted_drag": {
      const id = tabId ?? (await activeTabId());
      const qa = await toContent(id, "dom_query", { selector: payload.from });
      const qb = await toContent(id, "dom_query", { selector: payload.to });
      const ia = (unwrap(qa).items || unwrap(qa))[0];
      const ib = (unwrap(qb).items || unwrap(qb))[0];
      if (!ia || !ib) throw new Error("Drag source/target not found");
      const ax = Math.round(ia.x + ia.w / 2), ay = Math.round(ia.y + ia.h / 2);
      const bx = Math.round(ib.x + ib.w / 2), by = Math.round(ib.y + ib.h / 2);
      await withDebugger(id, async (dbg) => {
        await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mousePressed", x: ax, y: ay, button: "left", clickCount: 1 });
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          await cdpSend(dbg, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(ax + ((bx - ax) * i) / steps),
            y: Math.round(ay + ((by - ay) * i) / steps),
            button: "left",
          });
        }
        await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mouseReleased", x: bx, y: by, button: "left", clickCount: 1 });
      });
      return { ok: true, tabId: id, trusted: true };
    }

    // ----- raw CDP -----
    case "cdp_send": {
      const id = tabId ?? (await activeTabId());
      const out = await withDebugger(id, async (dbg) => cdpSend(dbg, payload.method, payload.params || {}));
      return { tabId: id, result: out };
    }

    // ----- clipboard -----
    case "clipboard_write": {
      const text = String(payload.text ?? "");
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({
          type: "mcp-offscreen-clipboard-write",
          text,
        });
        if (res && res.ok) return { ok: true, textLength: text.length };
      } catch {}
      try {
        const id = tabId ?? (await activeTabId());
        await chrome.scripting.executeScript({
          target: { tabId: id },
          func: (txt) => {
            const ta = document.createElement("textarea");
            ta.value = txt;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
          },
          args: [text],
        });
        return { ok: true, textLength: text.length, via: "tab-fallback" };
      } catch (err) {
        throw new Error(`Failed to write to clipboard: ${err.message || err}`);
      }
    }
    case "clipboard_read": {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({
          type: "mcp-offscreen-clipboard-read",
        });
        if (res && res.ok) return { ok: true, text: res.text || "" };
      } catch {}
      try {
        const id = tabId ?? (await activeTabId());
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: async () => {
            try {
              return await navigator.clipboard.readText();
            } catch {
              const ta = document.createElement("textarea");
              document.body.appendChild(ta);
              ta.select();
              document.execCommand("paste");
              const val = ta.value;
              ta.remove();
              return val;
            }
          },
        });
        return { ok: true, text: res?.result || "", via: "tab-fallback" };
      } catch (err) {
        throw new Error(`Failed to read clipboard: ${err.message || err}`);
      }
    }

    // ----- browsing data -----
    case "browsing_data_clear": {
      const options = { since: payload.since ?? 0 };
      const valid = [
        "appcache", "cache", "cacheStorage", "cookies", "downloads",
        "fileSystems", "formData", "history", "indexedDB", "localStorage",
        "passwords", "serviceWorkers", "webSQL"
      ];
      const dataToRemove = {};
      const reqTypes = Array.isArray(payload.types) && payload.types.length > 0
        ? payload.types
        : ["cache", "cookies", "formData", "history", "localStorage", "indexedDB", "serviceWorkers"];
      for (const t of reqTypes) {
        if (valid.includes(t)) dataToRemove[t] = true;
      }
      await chrome.browsingData.remove(options, dataToRemove);
      return { ok: true, cleared: Object.keys(dataToRemove), since: options.since };
    }

    // ----- notifications -----
    case "notification_create": {
      const id = payload.id || `mcp-${Date.now()}`;
      const nid = await chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon48.png"),
        title: payload.title || "Browser MCP",
        message: payload.message || "",
        contextMessage: payload.contextMessage || "MCP Agent",
        priority: payload.priority ?? 1,
      });
      return { ok: true, id: nid };
    }
    case "notification_clear": {
      if (!payload.id) throw new Error("id is required");
      const wasCleared = await chrome.notifications.clear(payload.id);
      return { ok: true, cleared: wasCleared, id: payload.id };
    }

    default:
      throw new Error(`Unknown command: ${action}`);
  }
}
