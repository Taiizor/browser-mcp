// Background service worker: WS bridge + chrome.* API router.
// WS: ws://127.0.0.1:<port>  (default 8765, configurable in storage/popup)

const PROTOCOL_VERSION = 2;
let currentPort = 8765;
let portLoaded = false;
let ws = null;
let reconnectMs = 1000;
let reconnectTimer = null;
// True once the server answered our `hello` with `welcome` on the current socket.
let paired = false;
// Last WebSocket close { code, reason, at } (e.g. 4003 untrusted extension id,
// 4001 auth required), surfaced in the popup through mcp-status.
let lastClose = null;

const consoleLogs = []; // {level,text,url,tabId,frameId,ts}
const networkLogs = []; // {requestId,url,method,type,tabId,statusCode,fromCache,ts,...}
const networkMap = new Map(); // requestId -> entry for O(1) lookups
const dialogEvents = []; // {kind,message,url,tabId,frameId,ts,response}
const MAX = 1000;

const commandHistory = []; // { id, action, ok, error, durationMs, time, tabId }
const MAX_HISTORY = 50;
function recordCommandHistory(entry) {
  commandHistory.unshift(entry);
  if (commandHistory.length > MAX_HISTORY) commandHistory.pop();
}

// Mock/block + spy sessions: tabId -> { routes, netmap, bodies }
const fetchSessions = new Map();
// Geolocation emulation sessions: tabId -> true (or the override params)
const emulationSessions = new Map();
// Persistent network emulation (network_throttle / network_set_headers):
// tabId -> params / headers. Cleared together with the debugger holders.
const throttleSessions = new Map();
const headerSessions = new Map();
let routeSeq = 0;
// Dialog policy applied by the MAIN-world dialog hook on agent tabs.
const dialogPolicy = { accept: true, promptText: "", blockUnload: false };
// Sticky frame (frame_focus): tabId -> { frameId, url }
const stickyFrames = new Map();
// Tabs under automation: targeted by a command (explicit tabId or active-tab
// fallback) or created by tab_create / window_create. Console + dialog hooks
// are installed only here. Persisted in chrome.storage.session.
const agentTabs = new Set();

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

function capStr(v, n) {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

function bridgeOpen() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

// Event frames stay well below ~1 MiB even with 3-byte UTF-8 characters.
const MAX_EVENT_CHARS = 340000;

function sendWs(obj, maxChars) {
  const sock = ws;
  if (!sock || sock.readyState !== WebSocket.OPEN) return false;
  let s;
  try {
    s = JSON.stringify(obj);
  } catch {
    return false;
  }
  if (maxChars && s.length > maxChars) return false;
  try {
    sock.send(s);
    return true;
  } catch {
    return false;
  }
}

// Event gating: nothing is captured (or streamed) while the matching
// permission is disabled; network capture also needs a connected bridge.
function eventAllowed(kind) {
  if (!permsLoaded) return false;
  if (kind === "network") return bridgeOpen() && isAllowed("network_requests");
  if (kind === "console") return isAllowed("console_get");
  if (kind === "dialog") return isAllowed("dialog_get");
  return true;
}

function sendEvent(kind, data) {
  if (!eventAllowed(kind)) return;
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
  sendWs({ type: "event", kind, data }, MAX_EVENT_CHARS);
}

function sendPermsEvent() {
  sendWs({ type: "event", kind: "perms", data: { disabled: Array.from(disabledActions) } });
}

// ---------- WS ----------
function detectBrowser() {
  // `browser` lets the server remember which browser holds the extension,
  // launch the same one next time and limit a forced browser_close to that
  // browser's processes. Brave (and other Chromium forks) send a UA string
  // identical to Chrome's, so the client-hints brand list decides; the UA
  // tokens are only a fallback. Anything unrecognized is "unknown" (never
  // "chrome"): the server then refuses a force close instead of killing an
  // unrelated Google Chrome.
  try {
    const nav = typeof navigator !== "undefined" && navigator ? navigator : {};
    const uad = nav.userAgentData;
    const brands = uad && Array.isArray(uad.brands) ? uad.brands.map((b) => String((b && b.brand) || "")) : [];
    const ua = String(nav.userAgent || "");
    if (brands.some((b) => /Brave/i.test(b)) || !!nav.brave || /\bBrave\//.test(ua)) return "brave";
    if (brands.includes("Microsoft Edge") || /\bEdg\//.test(ua)) return "edge";
    if (brands.some((b) => /^Opera/i.test(b)) || /\bOPR\//.test(ua)) return "opera";
    if (brands.includes("Google Chrome")) return "chrome";
  } catch {}
  return "unknown";
}

function dropSocket(sock) {
  if (!sock) return;
  sock.onopen = null;
  sock.onmessage = null;
  sock.onclose = null;
  sock.onerror = null;
  try {
    sock.close();
  } catch {}
}

// Idempotent: a no-op while a socket is CONNECTING or OPEN. Every handler is
// bound to its own socket and ignores events once that socket is replaced.
function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (!portLoaded) {
    // Never connect to the default port before the stored port is known.
    portReady.then(connect);
    return;
  }
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (ws) {
    // CLOSING/CLOSED socket whose onclose has not run yet
    dropSocket(ws);
    ws = null;
    paired = false;
    onBridgeDown();
  }
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${currentPort}`);
  } catch {
    schedule();
    return;
  }
  ws = sock;
  paired = false;
  sock.onopen = () => {
    if (ws !== sock) return;
    reconnectMs = 1000;
    console.log(`[mcp] bridge connected on port ${currentPort}`);
    sendHello(sock);
    onBridgeUp();
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    onSocketMessage(sock, ev.data);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    paired = false;
    lastClose = { code: Number(ev && ev.code) || 0, reason: capStr(ev && ev.reason, 200), at: Date.now() };
    onBridgeDown();
    // Explicit rejections (auth / untrusted extension id) retry slowly.
    const rejected = lastClose.code === 4001 || lastClose.code === 4003;
    schedule(rejected ? 30000 : undefined);
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {}
  };
}

async function sendHello(sock) {
  try {
    await permsReady;
  } catch {}
  if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;
  try {
    sock.send(
      JSON.stringify({
        type: "hello",
        role: "extension",
        browser: detectBrowser(),
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
        perms: { disabled: Array.from(disabledActions) },
      })
    );
  } catch {}
}

function onSocketMessage(sock, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  if (msg.type === "ping") return;
  if (msg.type === "welcome") {
    paired = true;
    return;
  }
  const id = msg.id;
  if ((typeof id !== "string" && typeof id !== "number") || id === "") return;
  if (typeof msg.action !== "string" || !msg.action) return;
  runBridgeCommand(sock, msg);
}

async function runBridgeCommand(sock, msg) {
  const start = Date.now();
  const tabId = Number.isInteger(msg.tabId) ? msg.tabId : undefined;
  const payload = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};
  const t = Number(msg.timeoutMs);
  // ctx.timeoutMs = the server-side timeout of this command (toContent derives its own budget from it)
  const ctx = { timeoutMs: Number.isFinite(t) && t > 0 ? t : undefined };
  let ok = true;
  let errStr = null;
  // Replies always go to the socket the command arrived on.
  const reply = (frame) => {
    if (sock.readyState !== WebSocket.OPEN) return;
    try {
      sock.send(frame);
    } catch {}
  };
  try {
    const result = await handleCommand(msg.action, payload, tabId, ctx);
    noteAgentTabsFromResult(msg.action, result);
    let frame;
    try {
      frame = JSON.stringify({ id: msg.id, ok: true, result });
    } catch (e) {
      throw new Error(`Result could not be serialized: ${(e && e.message) || e}`);
    }
    reply(frame);
  } catch (e) {
    ok = false;
    errStr = String((e && e.message) || e);
    reply(JSON.stringify({ id: msg.id, ok: false, error: errStr }));
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
}

function schedule(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delayMs ?? reconnectMs);
  reconnectMs = Math.min(reconnectMs * 2, 10000);
}

function setPort(newPort) {
  const p = Number(newPort);
  if (!Number.isInteger(p) || p <= 0 || p >= 65536) return;
  portLoaded = true;
  if (p === currentPort && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  currentPort = p;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    dropSocket(ws);
    ws = null;
    paired = false;
    onBridgeDown();
  }
  reconnectMs = 1000;
  connect();
}

// Popup-only data: content scripts must not read or write storage.local
// (permission switches, port).
try {
  if (chrome.storage && chrome.storage.local && chrome.storage.local.setAccessLevel) {
    Promise.resolve(chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })).catch(() => {});
  }
} catch {}

// Initial port load & connection. The heartbeat alarm can wake the worker
// before this resolves, so connect() waits for it as well.
const portReady = (async () => {
  try {
    const res = await chrome.storage.local.get("mcpPort");
    const p = Number(res && res.mcpPort);
    if (!portLoaded && Number.isInteger(p) && p > 0 && p < 65536) currentPort = p;
  } catch {}
  portLoaded = true;
})();
portReady.then(connect);

setInterval(() => {
  sendWs({ type: "ping" });
}, 20000);

// Heartbeat alarm: wakes up the service worker and reconnects if disconnected
if (typeof chrome !== "undefined" && chrome.alarms) {
  try {
    chrome.alarms.create("mcp_heartbeat", { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "mcp_heartbeat" && !bridgeOpen()) connect();
    });
  } catch {}
}

// ---------- session state (survives service-worker restarts) ----------
let stateLoaded = false;

function saveSessionState() {
  try {
    Promise.resolve(
      chrome.storage.session.set({
        mcpState: {
          dialogPolicy: { ...dialogPolicy },
          agentTabs: Array.from(agentTabs),
          stickyFrames: Array.from(stickyFrames.entries()),
        },
      })
    ).catch(() => {});
  } catch {}
}

async function restoreSessionState() {
  try {
    const got = await chrome.storage.session.get("mcpState");
    const st = got && got.mcpState;
    if (st && typeof st === "object") {
      const p = st.dialogPolicy;
      if (p && typeof p === "object") {
        dialogPolicy.accept = p.accept !== false;
        dialogPolicy.promptText = typeof p.promptText === "string" ? p.promptText : "";
        dialogPolicy.blockUnload = !!p.blockUnload;
      }
      const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
      for (const id of Array.isArray(st.agentTabs) ? st.agentTabs : []) {
        if (live.has(id)) agentTabs.add(id);
      }
      for (const e of Array.isArray(st.stickyFrames) ? st.stickyFrames : []) {
        const [id, f] = Array.isArray(e) ? e : [];
        if (!live.has(id) || stickyFrames.has(id) || !f || typeof f !== "object") continue;
        stickyFrames.set(id, { frameId: Number.isInteger(f.frameId) ? f.frameId : undefined, url: capStr(f.url, 2048) });
      }
    }
  } catch {}
  stateLoaded = true;
}
const stateReady = restoreSessionState();

function markAgentTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0 || agentTabs.has(tabId)) return;
  agentTabs.add(tabId);
  saveSessionState();
  chrome.tabs.get(tabId).then(
    () => installPageHooks(tabId),
    () => {
      if (agentTabs.delete(tabId)) saveSessionState();
    }
  );
}

// Tabs created by the agent become agent tabs as well.
function noteAgentTabsFromResult(action, result) {
  try {
    if (!result || typeof result !== "object") return;
    if (Number.isInteger(result.tabId) && (action === "tab_create" || action === "tab_duplicate" || action === "window_create")) {
      markAgentTab(result.tabId);
    }
    if (action === "tab_create" && Number.isInteger(result.id)) markAgentTab(result.id);
    if (action === "tab_duplicate" && result.tab && Number.isInteger(result.tab.id)) markAgentTab(result.tab.id);
    if (action === "window_create") {
      if (Array.isArray(result.tabs)) for (const t of result.tabs) if (t && Number.isInteger(t.id)) markAgentTab(t.id);
      if (Number.isInteger(result.id)) {
        chrome.tabs.query({ windowId: result.id }).then((tabs) => {
          for (const t of tabs) markAgentTab(t.id);
        }, () => {});
      }
    }
  } catch {}
}

// ---------- console hook: MAIN-world override ----------
// The page's own CSP can block <script> injection and content-world eval;
// overrides installed via the scripting API into the MAIN world are
// unaffected by page CSP. The only page-visible global is the non-enumerable,
// read-only `__mcpConsoleHook` switch (re-install = toggle capture on/off).
function mcpPageHookMain(enabled) {
  try {
    const KEY = "__mcpConsoleHook";
    const prev = Object.getOwnPropertyDescriptor(window, KEY);
    if (prev) {
      if (typeof prev.value === "function") prev.value(!!enabled);
      return;
    }
    let on = !!enabled;
    Object.defineProperty(window, KEY, {
      value: (v) => {
        on = !!v;
      },
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const MAX_TEXT = 4000;
    const MAX_PER_SEC = 100;
    const post = window.postMessage.bind(window);
    const dateNow = Date.now;
    const jstr = JSON.stringify;
    const addListener = EventTarget.prototype.addEventListener;
    const getDesc = Object.getOwnPropertyDescriptor;
    const getProto = Object.getPrototypeOf;
    const keysOf = Object.keys;
    const isArray = Array.isArray;
    const objToString = Object.prototype.toString;
    const dateIso = Date.prototype.toISOString;
    let busy = false; // synchronous re-entrancy (console call while we format/post)
    let winStart = 0;
    let winCount = 0;

    // A console call made while one of our own relay messages is being
    // dispatched (a page 'message' listener logging the event) is not relayed
    // again: that would loop forever. window.event = the event in dispatch.
    const inOwnDispatch = () => {
      try {
        const ev = window.event;
        if (!ev || ev.type !== "message") return false;
        const d = ev.data;
        return !!(d && typeof d === "object" && (d.__mcpConsole || d.__mcpDialog));
      } catch {
        return false;
      }
    };

    const rateOk = () => {
      const now = dateNow();
      if (now - winStart >= 1000) {
        winStart = now;
        winCount = 0;
      }
      return ++winCount <= MAX_PER_SEC;
    };
    // Reads data properties only (never runs getters).
    const peek = (o, k) => {
      for (let p = o, i = 0; p && i < 8; p = getProto(p), i++) {
        const d = getDesc(p, k);
        if (d) return "value" in d ? d.value : undefined;
      }
      return undefined;
    };
    const mentionsOwn = (args) => {
      for (const a of args) {
        if (typeof a === "string") {
          if (a.includes("__mcpConsole") || a.includes("__mcpDialog")) return true;
        } else if (a && typeof a === "object") {
          try {
            if (getDesc(a, "__mcpConsole") || getDesc(a, "__mcpDialog")) return true;
            if (typeof MessageEvent !== "undefined" && a instanceof MessageEvent) {
              const d = a.data;
              if (d && typeof d === "object" && (d.__mcpConsole || d.__mcpDialog)) return true;
            }
          } catch {}
        }
      }
      return false;
    };
    // Size-bounded serializer: depth 3, 50 items per level, MAX_TEXT chars total.
    const ser = (v, depth, seen, out) => {
      if (out.n >= MAX_TEXT) return;
      const w = (s) => {
        out.p.push(s);
        out.n += s.length;
      };
      const t = typeof v;
      if (t === "string") {
        w(depth === 0 ? v.slice(0, MAX_TEXT) : jstr(v.length > 300 ? v.slice(0, 300) + "…" : v));
        return;
      }
      if (v === null || t === "number" || t === "boolean" || t === "undefined" || t === "symbol") {
        w(String(v));
        return;
      }
      if (t === "bigint") {
        w(String(v) + "n");
        return;
      }
      if (t === "function") {
        const n = peek(v, "name");
        w(`[Function${typeof n === "string" && n ? " " + n : ""}]`);
        return;
      }
      if (seen.includes(v)) {
        w("[Circular]");
        return;
      }
      seen.push(v);
      try {
        let tag = "";
        try {
          tag = objToString.call(v);
        } catch {}
        if (tag === "[object Error]" || v instanceof Error) {
          const stack = peek(v, "stack");
          const name = peek(v, "name");
          const message = peek(v, "message");
          const head = `${typeof name === "string" ? name : "Error"}: ${typeof message === "string" ? message : ""}`;
          w(typeof stack === "string" && stack ? stack.slice(0, 1500) : head);
          return;
        }
        if (typeof Node !== "undefined" && v instanceof Node) {
          let d = "#node";
          try {
            d = String(v.nodeName || "#node").toLowerCase();
            const id = v.id;
            if (typeof id === "string" && id) d += "#" + id.slice(0, 60);
          } catch {}
          w(`<${d}>`);
          return;
        }
        if (v instanceof Date) {
          try {
            w(dateIso.call(v));
          } catch {
            w("Invalid Date");
          }
          return;
        }
        if (ArrayBuffer.isView(v)) {
          let len = "?";
          try {
            len = String(v.byteLength);
          } catch {}
          w(`${tag.slice(8, -1) || "ArrayBufferView"}(${len} bytes)`);
          return;
        }
        if (depth >= 3) {
          w(isArray(v) ? "[Array]" : "[Object]");
          return;
        }
        if (isArray(v)) {
          const ld = getDesc(v, "length");
          const len = ld && typeof ld.value === "number" ? ld.value : 0;
          w("[");
          for (let i = 0; i < len && i < 50 && out.n < MAX_TEXT; i++) {
            if (i) w(",");
            const d = getDesc(v, String(i));
            if (!d) w("empty");
            else if ("value" in d) ser(d.value, depth + 1, seen, out);
            else w("[Getter]");
          }
          if (len > 50) w(`,…${len - 50} more`);
          w("]");
          return;
        }
        let keys = [];
        try {
          keys = keysOf(v);
        } catch {}
        w((tag && tag !== "[object Object]" ? tag.slice(8, -1) + " " : "") + "{");
        let i = 0;
        for (const k of keys) {
          if (i >= 50 || out.n >= MAX_TEXT) {
            w(",…");
            break;
          }
          const d = getDesc(v, k);
          if (!d) continue;
          if (i++) w(",");
          w(jstr(k) + ":");
          if ("value" in d) ser(d.value, depth + 1, seen, out);
          else w('"[Getter]"');
        }
        w("}");
      } catch {
        w("[Unserializable]");
      } finally {
        seen.pop();
      }
    };
    const fmtArgs = (args) => {
      const out = { p: [], n: 0 };
      for (let i = 0; i < args.length && out.n < MAX_TEXT; i++) {
        if (i) {
          out.p.push(" ");
          out.n += 1;
        }
        ser(args[i], 0, [], out);
      }
      const s = out.p.join("");
      return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
    };
    const emit = (level, text) => {
      try {
        post({ __mcpConsole: { level, text, url: String(location.href).slice(0, 2048), ts: dateNow() } }, "*");
      } catch {}
    };
    const capture = (level, makeText) => {
      if (!on || busy || inOwnDispatch()) return;
      busy = true;
      try {
        if (rateOk()) {
          const text = makeText();
          if (text !== null) emit(level, text);
        }
      } catch {
      } finally {
        busy = false;
      }
    };
    for (const lv of ["log", "info", "warn", "error", "debug"]) {
      try {
        const orig = console[lv];
        if (typeof orig !== "function") continue;
        console[lv] = function (...args) {
          capture(lv, () => (mentionsOwn(args) ? null : fmtArgs(args)));
          return orig.apply(console, args);
        };
      } catch {}
    }
    try {
      addListener.call(window, "error", (e) => {
        capture("error", () => `Uncaught: ${String(e && e.message)}`.slice(0, MAX_TEXT));
      });
      addListener.call(window, "unhandledrejection", (e) => {
        capture("error", () => `Unhandled rejection: ${fmtArgs([e && e.reason])}`.slice(0, MAX_TEXT));
      });
    } catch {}
  } catch {}
}

// ---------- dialog hook: MAIN-world alert/confirm/prompt + beforeunload ----------
// The policy lives only in this closure (no readable global). Re-injecting
// calls the non-enumerable, read-only `__mcpDialogHook` updater, so accept /
// promptText / blockUnload (on AND off) apply to already-hooked documents.
// { passthrough: true } restores native dialogs (bridge disconnected).
function mcpDialogHookMain(policy) {
  try {
    const KEY = "__mcpDialogHook";
    const prev = Object.getOwnPropertyDescriptor(window, KEY);
    if (prev) {
      if (typeof prev.value === "function") prev.value(policy);
      return;
    }
    const norm = (p) => {
      const o = p && typeof p === "object" ? p : {};
      return {
        passthrough: !!o.passthrough,
        accept: o.accept !== false,
        promptText: typeof o.promptText === "string" ? o.promptText : "",
        blockUnload: !!o.blockUnload,
      };
    };
    let cur = norm(policy);
    Object.defineProperty(window, KEY, {
      value: (p) => {
        cur = norm(p);
      },
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const post = window.postMessage.bind(window);
    const dateNow = Date.now;
    const nAlert = window.alert;
    const nConfirm = window.confirm;
    const nPrompt = window.prompt;
    const text = (v) => {
      try {
        return v === undefined ? "" : String(v).slice(0, 4000);
      } catch {
        return "";
      }
    };
    const report = (kind, message, response) => {
      try {
        post({ __mcpDialog: { kind, message: text(message), url: String(location.href).slice(0, 2048), ts: dateNow(), response } }, "*");
      } catch {}
    };
    window.alert = function alert(message) {
      if (cur.passthrough) return nAlert.apply(window, arguments);
      report("alert", message, "ok");
    };
    window.confirm = function confirm(message) {
      if (cur.passthrough) return nConfirm.apply(window, arguments);
      const ok = cur.accept;
      report("confirm", message, ok ? "accepted" : "dismissed");
      return ok;
    };
    window.prompt = function prompt(message, def) {
      if (cur.passthrough) return nPrompt.apply(window, arguments);
      const res = cur.accept ? (cur.promptText !== "" ? cur.promptText : def === undefined ? "" : String(def)) : null;
      report("prompt", message, res);
      return res;
    };
    // beforeunload: a capturing listener on window runs before the page's
    // (non-capturing) listeners and the onbeforeunload handler; while
    // blockUnload is on it stops them, so no "Leave site?" dialog appears.
    // Checked at event time, so the switch works in both directions.
    try {
      EventTarget.prototype.addEventListener.call(
        window,
        "beforeunload",
        (ev) => {
          if (!cur.passthrough && cur.blockUnload) {
            try {
              ev.stopImmediatePropagation();
            } catch {}
          }
        },
        true
      );
    } catch {}
  } catch {}
}

// Turns both hooks off in a document (native dialogs, no console capture).
function mcpHooksOffMain() {
  try {
    const d = Object.getOwnPropertyDescriptor(window, "__mcpDialogHook");
    if (d && typeof d.value === "function") d.value({ passthrough: true });
  } catch {}
  try {
    const c = Object.getOwnPropertyDescriptor(window, "__mcpConsoleHook");
    if (c && typeof c.value === "function") c.value(false);
  } catch {}
}

async function runInMainWorld(tabId, func, args) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      injectImmediately: true,
      func,
      args: args || [],
    });
  } catch {}
}

function dialogHookPolicy() {
  return {
    passthrough: false,
    accept: dialogPolicy.accept !== false,
    promptText: String(dialogPolicy.promptText || ""),
    blockUnload: !!dialogPolicy.blockUnload,
  };
}

// Hooks go only into the main frame of agent tabs, and only while the bridge
// is connected (navigation re-installs; markAgentTab installs immediately).
async function installPageHooks(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  if (!agentTabs.has(tabId) || !bridgeOpen()) return;
  const consoleOn = permsLoaded && isAllowed("console_get");
  await Promise.all([
    runInMainWorld(tabId, mcpPageHookMain, [consoleOn]),
    runInMainWorld(tabId, mcpDialogHookMain, [dialogHookPolicy()]),
  ]);
}

function refreshAgentHooks() {
  stateReady.then(() => {
    for (const id of agentTabs) installPageHooks(id);
  });
}

// dialog_policy: persist and apply to every agent tab (never to other tabs).
async function pushDialogPolicyToAgentTabs() {
  saveSessionState();
  await stateReady;
  if (!bridgeOpen()) return;
  const policy = dialogHookPolicy();
  await Promise.all(Array.from(agentTabs, (id) => runInMainWorld(id, mcpDialogHookMain, [policy])));
}

// Bridge down for longer than the grace period: agent tabs get native dialogs
// back and stop console capture (a short reconnect keeps automation intact).
const PASSTHROUGH_GRACE_MS = 15000;
let passthroughTimer = null;
let bridgeUp = false;

function onBridgeUp() {
  bridgeUp = true;
  if (passthroughTimer) {
    clearTimeout(passthroughTimer);
    passthroughTimer = null;
  }
  refreshAgentHooks();
}

// Idempotent: only the up -> down transition starts the grace timer.
function onBridgeDown() {
  if (!bridgeUp) return;
  bridgeUp = false;
  if (passthroughTimer) clearTimeout(passthroughTimer);
  passthroughTimer = setTimeout(() => {
    passthroughTimer = null;
    if (bridgeOpen()) return;
    for (const id of agentTabs) runInMainWorld(id, mcpHooksOffMain, []);
  }, PASSTHROUGH_GRACE_MS);
}

// Service-worker restart: bridgeUp starts false, so onBridgeDown would never
// fire if the bridge does not come back, and the restored agent tabs would
// keep auto-accepting hooks. Start the grace timer once the state is
// restored; a later onopen (onBridgeUp) cancels it.
stateReady.then(() => {
  if (!bridgeOpen() && !passthroughTimer && agentTabs.size) {
    bridgeUp = true;
    onBridgeDown();
  }
});

// Extension reload / update: storage.session (agentTabs) is wiped, but the
// MAIN-world hooks injected by the previous instance stay in already open
// documents. Turn them off everywhere (a no-op where no hook is installed),
// then re-arm the current agent tabs if the bridge is already up.
if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.tabs.query({}).then(
      async (ts) => {
        await Promise.all(ts.filter((t) => Number.isInteger(t.id) && t.id >= 0).map((t) => runInMainWorld(t.id, mcpHooksOffMain, [])));
        refreshAgentHooks();
      },
      () => {}
    );
  });
}

if (chrome.webNavigation && chrome.webNavigation.onCompleted) {
  // onCommitted: early (catch console/dialogs during load); a main-frame
  // navigation also drops the tab's focused frame.
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    stateReady.then(() => {
      clearStickyFrame(d.tabId);
      installPageHooks(d.tabId);
    });
  });
  // onCompleted: guaranteed install
  chrome.webNavigation.onCompleted.addListener((d) => {
    if (d.frameId === 0) stateReady.then(() => installPageHooks(d.tabId));
  });
}

// ---------- helpers ----------
// Resolves the command target when no tabId was given; the tab becomes an agent tab.
async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("No active tab");
  markAgentTab(t.id);
  return t.id;
}

// Never closes an existing document: it is always created with both reasons,
// and closing it would destroy recordings in progress. Creation is serialized.
// (The legacy `requireUserMedia` argument is accepted and ignored.)
let offscreenCreating = null;
async function ensureOffscreen(_requireUserMedia) {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch {}
  if (!offscreenCreating) {
    offscreenCreating = (async () => {
      try {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["CLIPBOARD", "USER_MEDIA"],
          justification: "Clipboard read/write and tab audio capture for MCP browser bridge",
        });
      } catch (e) {
        if (/single offscreen/i.test(String((e && e.message) || e))) return;
        try {
          if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
        } catch {}
        throw e;
      }
    })().finally(() => {
      offscreenCreating = null;
    });
  }
  await offscreenCreating;
}

// ---------- frame targeting ----------
function setStickyFrame(tabId, frameId, url) {
  stickyFrames.set(tabId, { frameId: Number.isInteger(frameId) ? frameId : undefined, url: capStr(url, 2048) });
  saveSessionState();
}

function clearStickyFrame(tabId) {
  if (stickyFrames.delete(tabId)) saveSessionState();
}

// frameId for content commands: the focused frame (frame_focus) or 0 (main frame).
async function resolveStickyFrame(tabId) {
  const sticky = stickyFrames.get(tabId);
  if (!sticky) return 0;
  // (tolerates the legacy string form: a URL substring)
  const want = typeof sticky === "string" ? { frameId: undefined, url: sticky } : sticky;
  if (Number.isInteger(want.frameId)) {
    let f = null;
    try {
      f = await chrome.webNavigation.getFrame({ tabId, frameId: want.frameId });
    } catch {}
    if (f) return want.frameId;
  }
  // Frame gone (iframe re-created, etc.): re-resolve by URL substring.
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  const cands = want.url ? frames.filter((f) => (f.url || "").includes(want.url)) : [];
  const pick = cands.find((f) => f.frameId !== 0) || cands[0];
  if (!pick) {
    clearStickyFrame(tabId);
    throw new Error("Focused frame is gone; call frame_focus again or frame_clear");
  }
  setStickyFrame(tabId, pick.frameId, want.url);
  return pick.frameId;
}

async function ensureContent(tabId, frameId = 0, retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { __mcp: 1, cmd: "__ping", payload: {} }, { frameId });
      return;
    } catch (e) {
      lastErr = e;
    }
    // missing, or waking from bfcache: inject and wait a bit
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr || new Error("Could not install content script");
}

// Sends one command to ONE frame (the focused frame, else the main frame).
// timeoutMs = the server-side timeout of the command (ctx.timeoutMs); the
// content budget stays below it. Without it the budget is 25 s.
async function toContent(tabId, cmd, payload, timeoutMs) {
  const started = Date.now();
  const id = tabId ?? (await activeTabId());
  const frameId = await resolveStickyFrame(id);
  await ensureContent(id, frameId);
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const budget = hasDeadline ? Math.max(5000, timeoutMs - 1500) : 25000;
  const wait = hasDeadline ? Math.max(2000, budget - (Date.now() - started)) : budget;
  const msg = { __mcp: 1, cmd, payload };
  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Content did not respond (${cmd})`)), wait);
  });
  try {
    const value = await Promise.race([chrome.tabs.sendMessage(id, msg, { frameId }), timeout]);
    return { tabId: id, frameId, value };
  } finally {
    clearTimeout(timer);
  }
}

function unwrap(res) {
  if (!res.value) throw new Error("Content returned an empty response");
  if (res.value.ok === false) throw new Error(res.value.error || "Content error");
  return res.value.result;
}

// ---------- debugger ownership (per-tab holder model) ----------
// Chrome allows one attach per extension per tab, so every CDP user shares it.
// Holders: transient (withDebugger calls in flight, refcounted) and persistent
// (named keys: "mock", "emulation", "throttle", "headers"). The tab is attached
// for the first holder and detached when no holder remains. Attach/detach are
// serialized per tab.
const dbgTabs = new Map(); // tabId -> { attached, transient, holders:Set<string>, chain }

function dbgState(tabId) {
  let st = dbgTabs.get(tabId);
  if (!st) {
    st = { attached: false, transient: 0, holders: new Set(), chain: Promise.resolve() };
    dbgTabs.set(tabId, st);
  }
  return st;
}

function dbgSerial(tabId, fn) {
  const st = dbgState(tabId);
  const run = st.chain.then(() => fn(st));
  st.chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function dbgEnsureAttached(tabId, st) {
  if (st.attached) return;
  const dbg = { tabId };
  try {
    await chrome.debugger.attach(dbg, "1.3");
  } catch (e) {
    if (!/already attached/i.test(String((e && e.message) || e))) throw e;
    // Our own attach survived (service-worker restart, leaked session): adopt
    // it when commands go through; otherwise another client owns the tab.
    try {
      await cdpSend(dbg, "Runtime.evaluate", { expression: "0", returnByValue: true });
    } catch {
      throw e;
    }
  }
  st.attached = true;
}

async function dbgMaybeDetach(tabId, st) {
  if (!st.attached || st.transient > 0 || st.holders.size > 0) return;
  st.attached = false;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
}

// Transient holder: re-entrant and safe to run concurrently on the same tab.
async function withDebugger(tabId, fn) {
  const dbg = { tabId };
  await dbgSerial(tabId, async (st) => {
    await dbgEnsureAttached(tabId, st);
    st.transient++;
  });
  try {
    return await fn(dbg);
  } catch (e) {
    // Detached behind our back (e.g. a raw chrome.debugger.detach): re-attach next time.
    if (/not attached/i.test(String((e && e.message) || e))) {
      const st = dbgTabs.get(tabId);
      if (st && st.transient <= 1 && st.holders.size === 0) st.attached = false;
    }
    throw e;
  } finally {
    await dbgSerial(tabId, async (st) => {
      st.transient = Math.max(0, st.transient - 1);
      await dbgMaybeDetach(tabId, st);
    }).catch(() => {});
  }
}

// Persistent holder (key: "mock" | "emulation" | "throttle" | "headers").
// Idempotent per key. Returns the debuggee { tabId }.
async function acquireDebugger(tabId, key) {
  await dbgSerial(tabId, async (st) => {
    await dbgEnsureAttached(tabId, st);
    st.holders.add(String(key));
  });
  return { tabId };
}

// Drops a persistent holder; detaches when no holder remains.
async function releaseDebugger(tabId, key) {
  await dbgSerial(tabId, async (st) => {
    st.holders.delete(String(key));
    await dbgMaybeDetach(tabId, st);
  });
}

function hasDebuggerHolder(tabId, key) {
  const st = dbgTabs.get(tabId);
  return !!(st && st.attached && st.holders.has(String(key)));
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
  if (!Array.isArray(saved) || !saved.length) return;
  let live = new Set();
  try {
    live = new Set((await chrome.tabs.query({})).map((t) => t.id));
  } catch {}
  for (const s of saved) {
    if (!s || !live.has(s.tabId) || fetchSessions.has(s.tabId)) continue;
    const routes = Array.isArray(s.routes) ? s.routes : [];
    for (const r of routes) {
      const n = /^r(\d+)$/.exec(String(r && r.id));
      if (n) routeSeq = Math.max(routeSeq, Number(n[1]));
    }
    // Register first: requests paused while Fetch is (re-)enabled must
    // already see the session and its routes.
    fetchSessions.set(s.tabId, { routes, netmap: new Map(), bodies: [] });
    try {
      const dbg = await acquireDebugger(s.tabId, "mock");
      await cdpSend(dbg, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      try {
        await cdpSend(dbg, "Network.enable", {});
      } catch {}
    } catch {
      fetchSessions.delete(s.tabId);
      try {
        await releaseDebugger(s.tabId, "mock");
      } catch {}
    }
  }
  saveMockSessions();
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
// Captured only while the bridge is connected and network_requests is allowed.
const MAX_URL = 8192;

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (!eventAllowed("network")) return;
    sendEvent("network", {
      phase: "request",
      requestId: String(d.requestId),
      url: capStr(d.url, MAX_URL),
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
    if (!eventAllowed("network")) return;
    sendEvent("network", {
      phase: "response",
      requestId: String(d.requestId),
      url: capStr(d.url, MAX_URL),
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
  if (!eventAllowed("network")) return;
  sendEvent("network", {
    phase: "error",
    requestId: String(d.requestId),
    url: capStr(d.url, MAX_URL),
    type: d.type,
    tabId: d.tabId,
    error: d.error,
    ts: Date.now(),
  });
}, { urls: ["<all_urls>"] });

// Header enrichment (for HAR): merged into the local log with the same requestId
// (never streamed: the event was already sent).
chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (!eventAllowed("network")) return;
    const log = networkMap.get(String(d.requestId));
    if (log && d.requestHeaders) log.requestHeaders = d.requestHeaders.slice(0, 50);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (!eventAllowed("network")) return;
    const log = networkMap.get(String(d.requestId));
    if (log) {
      if (d.responseHeaders) log.responseHeaders = d.responseHeaders.slice(0, 50);
      if (d.statusCode) log.statusCode = d.statusCode;
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Request headers (Fetch.requestPaused: object) + route headers -> HeaderEntry[]
// with case-insensitive overrides (continueRequest `headers` replaces the set).
function mergeRequestHeaders(reqHeaders, extra) {
  const out = [];
  const idx = new Map();
  for (const [name, value] of Object.entries(reqHeaders || {})) {
    idx.set(name.toLowerCase(), out.length);
    out.push({ name, value: String(value) });
  }
  for (const h of extra || []) {
    if (!h || !h.name) continue;
    const e = { name: String(h.name), value: String(h.value ?? "") };
    const k = e.name.toLowerCase();
    if (idx.has(k)) out[idx.get(k)] = e;
    else {
      idx.set(k, out.length);
      out.push(e);
    }
  }
  return out;
}

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
  const dbg = { tabId: source.tabId };
  const cont = (extra) => {
    cdpSend(dbg, "Fetch.continueRequest", Object.assign({ requestId: params.requestId }, extra || {})).catch(() => {});
  };
  if (!sess) {
    // No session (restore in progress, or Fetch left enabled by an earlier
    // worker): never leave the request hanging.
    cont();
    return;
  }
  const url = (params.request && params.request.url) || "";
  const route = sess.routes.find((r) => wildcardMatch(r.pattern, url));
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
    // Route headers are added to (not substituted for) the request headers.
    const withHeaders = () =>
      route.headers && route.headers.length ? { headers: mergeRequestHeaders(params.request && params.request.headers, route.headers) } : undefined;
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
        url: capStr(url, MAX_URL),
        method: (params.request && params.request.method) || "GET",
        type: params.resourceType,
        tabId: source.tabId,
        statusCode: route.status || 200,
        ts: Date.now(),
      });
    } else if (route.action === "delay") {
      const extra = withHeaders();
      // An explicit 0 means "no delay" (header injection only); 1 s is the
      // default only when delayMs was not given.
      const wait = Number.isFinite(route.delayMs) && route.delayMs >= 0 ? route.delayMs : 1000;
      setTimeout(() => cont(extra), wait);
    } else {
      cont(withHeaders());
    }
  } catch {
    cont();
  }
});

// External detach (user cancelled the infobar, tab closed, DevTools took
// over): drop every holder and the session state that relied on it.
// (Not fired for chrome.debugger.detach calls made by this extension.)
chrome.debugger.onDetach.addListener((source) => {
  const tabId = source && source.tabId;
  if (!Number.isInteger(tabId)) return;
  const st = dbgTabs.get(tabId);
  if (st) {
    st.attached = false;
    st.holders.clear();
  }
  fetchSessions.delete(tabId);
  emulationSessions.delete(tabId);
  throttleSessions.delete(tabId);
  headerSessions.delete(tabId);
  saveMockSessions();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const hadMock = fetchSessions.delete(tabId);
  emulationSessions.delete(tabId);
  throttleSessions.delete(tabId);
  headerSessions.delete(tabId);
  dbgTabs.delete(tabId);
  eventRate.delete(tabId);
  if (hadMock) saveMockSessions();
  const a = agentTabs.delete(tabId);
  const b = stickyFrames.delete(tabId);
  if (a || b) saveSessionState();
});

// Prerender / instant swaps replace the tab id: keep agent status.
if (chrome.tabs.onReplaced) {
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    stickyFrames.delete(removedTabId);
    if (agentTabs.delete(removedTabId)) {
      agentTabs.add(addedTabId);
      saveSessionState();
      installPageHooks(addedTabId);
    }
  });
}

// ---------- permission catalog (shared source with the popup) ----------
// Category -> action list. Default: all enabled.
const PERM_CATS = [
  { id: "tabs", title: "Tabs & Windows", actions: ["tabs_list", "tab_create", "tab_duplicate", "tab_close", "tab_activate", "tab_navigate", "tab_reload", "tab_back", "tab_forward", "tab_pin", "tab_mute", "window_list", "window_create", "window_focus", "browser_close", "frame_list", "frame_focus", "frame_clear", "tab_group_create", "tab_group_list", "tab_group_update", "tab_group_ungroup"] },
  { id: "read", title: "Page: Read", actions: ["page_snapshot", "page_html", "page_text", "dom_query", "page_find", "page_wait", "page_axtree"] },
  { id: "interact", title: "Page: Interact", actions: ["dom_click", "dom_type", "dom_fill", "dom_select", "dom_check", "dom_hover", "dom_focus", "dom_scroll", "dom_drag", "dom_upload", "keyboard_press"] },
  { id: "media", title: "Media", actions: ["page_screenshot", "page_pdf", "tab_audio_record_start", "tab_audio_record_stop"] },
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

// Composite actions reach data guarded by other switches: every listed
// action must be enabled as well (checked in the handleCommand gate).
const REQUIRES = {
  session_state_save: ["cookies_list", "storage_get"],
  session_state_load: ["cookies_set", "storage_set"],
  har_export: ["network_requests"],
  network_bodies: ["network_requests"],
  network_response_body: ["network_requests"],
  cookies_export: ["cookies_list"],
  cookies_import: ["cookies_set"],
};

// MCP tool names that differ from the catalog's bridge action names.
const PERM_ALIASES = {
  tab_list: ["tabs_list"],
  tab_audio_capture: ["tab_audio_record_start", "tab_audio_record_stop"],
};

function normalizeAction(action) {
  return action === "tab_list" ? "tabs_list" : action;
}

function resolvePermNames(name) {
  if (PERM_ALL.includes(name)) return [name];
  return PERM_ALIASES[name] ? PERM_ALIASES[name].slice() : [];
}

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

// storage.onChanged also reports this worker's own savePerms() writes. Their
// echoes must not go through the tighten-only merge: with two changes in
// flight, the older echo would be merged back and undo the newer change.
// Writes land (and echo) in order, so the echo of entry i also retires the
// entries before it (written but unchanged values produce no event). Entries
// expire, so a stale one cannot shadow a later foreign write for long.
const ownPermWrites = []; // { key, at }
const OWN_PERM_WRITE_TTL_MS = 10000;

function pruneOwnPermWrites(now) {
  while (ownPermWrites.length && (now - ownPermWrites[0].at > OWN_PERM_WRITE_TTL_MS || ownPermWrites.length > 50)) ownPermWrites.shift();
}

// True (and consumed) when `value` is the echo of one of our own writes.
function takeOwnPermWrite(value) {
  pruneOwnPermWrites(Date.now());
  let key;
  try {
    key = JSON.stringify(value);
  } catch {
    return false;
  }
  const i = ownPermWrites.findIndex((w) => w.key === key);
  if (i < 0) return false;
  ownPermWrites.splice(0, i + 1);
  return true;
}

async function savePerms() {
  const v = Array.from(disabledActions);
  const now = Date.now();
  pruneOwnPermWrites(now);
  ownPermWrites.push({ key: JSON.stringify(v), at: now });
  try {
    await chrome.storage.local.set({ mcpDisabled: v });
  } catch {}
}

function isAllowed(action) {
  return !disabledActions.has(normalizeAction(action));
}

// Single entry point for permission changes: emits a `perms` event and
// refreshes the agent-tab hooks whenever the set actually changes.
function setDisabled(next, persist) {
  const changed = next.size !== disabledActions.size || Array.from(next).some((a) => !disabledActions.has(a));
  disabledActions = next;
  if (persist) savePerms();
  if (changed) {
    sendPermsEvent();
    refreshAgentHooks();
  }
}

const permsReady = loadPerms();
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.mcpDisabled && permsLoaded) {
      const raw = changes.mcpDisabled.newValue;
      if (takeOwnPermWrite(raw)) {
        // Echo of our own write: nothing to merge. Once the last pending
        // write has landed, storage must equal the in-memory set (a foreign
        // tightening merged meanwhile may have been overwritten by it).
        if (!ownPermWrites.length) {
          const stored = Array.isArray(raw) ? raw : [];
          const same = stored.length === disabledActions.size && stored.every((a) => disabledActions.has(a));
          if (!same) savePerms();
        }
      } else {
        // Foreign write. Storage can only tighten: re-enabling goes through
        // the popup message (mcp-perms-set). A write that drops entries is
        // reverted.
        const nv = Array.isArray(raw) ? raw.filter((a) => PERM_ALL.includes(a)) : [];
        const dropped = Array.from(disabledActions).some((a) => !nv.includes(a));
        setDisabled(new Set([...disabledActions, ...nv]), false);
        if (dropped) savePerms();
      }
    }
    // mcpPort is deliberately not applied from storage: the popup's
    // mcp-port-set message (extension pages only) calls setPort() itself, and
    // a storage write from an untrusted context must not redirect the bridge
    // to another loopback port (C18 / C3). The stored port is read only at
    // startup.
  });
}

// ---------- message router (popup + content) ----------
const CONSOLE_LEVELS = new Set(["log", "info", "warn", "error", "debug"]);
const DIALOG_KINDS = new Set(["alert", "confirm", "prompt", "beforeunload"]);
const EVENT_RATE_PER_SEC = 200;
const eventRate = new Map(); // tabId -> { start, n }

function rateOk(tabId) {
  const now = Date.now();
  let r = eventRate.get(tabId);
  if (!r || now - r.start >= 1000) {
    r = { start: now, n: 0 };
    eventRate.set(tabId, r);
  }
  return ++r.n <= EVENT_RATE_PER_SEC;
}

// Popup / offscreen / other extension pages (never content scripts).
function isExtensionPage(sender) {
  return (
    !!sender &&
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""))
  );
}

function isOwnContentScript(sender) {
  return !!sender && sender.id === chrome.runtime.id && !!sender.tab && Number.isInteger(sender.tab.id);
}

// Re-validates relayed MAIN-world hook entries: whitelisted fields, capped
// strings, and url/tabId/frameId/ts taken from the sender, not the page.
// Hooks live only in the main frame of agent tabs.
function onPageEvent(type, entry, sender) {
  if (!permsLoaded || !stateLoaded) return;
  const tabId = sender.tab.id;
  if (sender.frameId !== 0 || !agentTabs.has(tabId)) return;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
  if (!rateOk(tabId)) return;
  const url = capStr(sender.url || sender.tab.url || "", 2048);
  if (type === "mcp-console") {
    if (typeof entry.text !== "string") return;
    sendEvent("console", {
      level: CONSOLE_LEVELS.has(entry.level) ? entry.level : "log",
      text: capStr(entry.text, 4000),
      url,
      tabId,
      frameId: 0,
      ts: Date.now(),
    });
    return;
  }
  if (!eventAllowed("dialog") || !DIALOG_KINDS.has(entry.kind)) return;
  const r = entry.response;
  push(dialogEvents, {
    kind: entry.kind,
    message: capStr(entry.message, 4000),
    url,
    tabId,
    frameId: 0,
    ts: Date.now(),
    response: r === null || r === undefined ? null : capStr(r, 4000),
  });
}

function statusPayload(t) {
  const connected = bridgeOpen();
  return {
    bridgeConnected: connected,
    port: currentPort,
    activeTab: t ? { id: t.id, title: t.title || "Untitled", url: t.url || "" } : null,
    extensionId: chrome.runtime.id,
    paired: connected && paired,
    lastClose,
  };
}

const PRIVILEGED_MSGS = new Set(["mcp-status", "mcp-history-get", "mcp-history-clear", "mcp-port-get", "mcp-port-set", "mcp-perms-get", "mcp-perms-set"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
  if (msg.type === "mcp-console" || msg.type === "mcp-dialog") {
    if (isOwnContentScript(sender)) onPageEvent(msg.type, msg.entry, sender);
    return false;
  }
  if (!PRIVILEGED_MSGS.has(msg.type) || !isExtensionPage(sender)) return false;
  if (msg.type === "mcp-status") {
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(([t]) => sendResponse(statusPayload(t)))
      .catch(() => sendResponse(statusPayload(null)));
    return true;
  }
  if (msg.type === "mcp-history-get") {
    sendResponse({ history: commandHistory });
    return true;
  }
  if (msg.type === "mcp-history-clear") {
    commandHistory.length = 0;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "mcp-port-get") {
    sendResponse({ port: currentPort });
    return true;
  }
  if (msg.type === "mcp-port-set") {
    const p = Number(msg.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) {
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
  if (msg.type === "mcp-perms-get") {
    permsReady.then(() => sendResponse({ cats: PERM_CATS, disabled: Array.from(disabledActions), requires: REQUIRES }));
    return true;
  }
  if (msg.type === "mcp-perms-set") {
    // {action, enabled} single delta or {actions:{name:bool}} (only the changed ones)
    permsReady.then(() => {
      const next = new Set(disabledActions);
      if (typeof msg.action === "string" && PERM_ALL.includes(msg.action)) {
        if (msg.enabled) next.delete(msg.action);
        else next.add(msg.action);
      }
      if (msg.actions && typeof msg.actions === "object") {
        for (const [a, on] of Object.entries(msg.actions)) {
          if (!PERM_ALL.includes(a)) continue;
          if (on) next.delete(a);
          else next.add(a);
        }
      }
      setDisabled(next, true);
      sendResponse({ ok: true, disabled: Array.from(disabledActions) });
    });
    return true;
  }
  return false;
});

// ---------- BG2b helpers: top-frame content, cookies, HAR, audio ----------
// Absolute deadline for the content round trips of one command
// (ctx.timeoutMs = the server-side timeout; 25 s when unknown).
function bg2bDeadline(ctx) {
  const t = ctx && Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0 ? ctx.timeoutMs : 0;
  return Date.now() + (t ? Math.max(5000, t - 1500) : 25000);
}

// Sends one content command to the TOP frame (frameId 0), ignoring any
// frame_focus target: session state and response refetches belong to the
// page's own origin. The caller runs ensureContent(tabId, 0) first.
async function bg2bTopFrameSend(tabId, cmd, payload, deadline) {
  const wait = Math.max(2000, deadline - Date.now());
  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Content did not respond (${cmd})`)), wait);
  });
  try {
    const value = await Promise.race([chrome.tabs.sendMessage(tabId, { __mcp: 1, cmd, payload }, { frameId: 0 }), timeout]);
    return { tabId, frameId: 0, value };
  } finally {
    clearTimeout(timer);
  }
}

// http(s) origin of a URL, or "" (opaque / unparsable / other schemes).
function bg2bHttpOrigin(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

const BG2B_SAMESITE = { no_restriction: "no_restriction", none: "no_restriction", lax: "lax", strict: "strict" };

// chrome.cookies.set details for an exported cookie (cookies_export /
// session_state_save output) or a hand-written { name, value, domain|url, ... }.
// Scope is preserved: host-only cookies (hostOnly true, or a domain without a
// leading dot) get NO `domain` (chrome would turn them into domain cookies);
// domain cookies (hostOnly false, or a leading dot) keep it. __Host- cookies:
// no domain, path "/", secure. sameSite "unspecified" = no attribute;
// "no_restriction" (SameSite=None) requires secure. Throws a descriptive
// error for cookies the browser would reject.
function bg2bCookieSetDetails(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("not a cookie object");
  if (typeof c.name !== "string") throw new Error("name is required");
  const name = c.name;
  const hostPrefix = name.startsWith("__Host-");
  const securePrefix = name.startsWith("__Secure-");
  const rawDomain = typeof c.domain === "string" ? c.domain.trim() : "";
  const host = rawDomain.replace(/^\./, "").toLowerCase();
  const urlStr = typeof c.url === "string" ? c.url.trim() : "";
  let u = null;
  if (urlStr) {
    try {
      u = new URL(urlStr);
    } catch {
      throw new Error(`invalid url: ${capStr(urlStr, 200)}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`url must be http(s): ${capStr(urlStr, 200)}`);
  }
  if (!host && !u) throw new Error("domain or url is required");

  let sameSite;
  if (c.sameSite !== undefined && c.sameSite !== null && c.sameSite !== "") {
    const k = String(c.sameSite).toLowerCase();
    if (k !== "unspecified") {
      sameSite = BG2B_SAMESITE[k];
      if (!sameSite) throw new Error(`unsupported sameSite: ${capStr(c.sameSite, 50)}`);
    }
  }
  let secure = typeof c.secure === "boolean" ? c.secure : undefined;
  if (hostPrefix || securePrefix || sameSite === "no_restriction") {
    if (secure === false) {
      throw new Error(hostPrefix || securePrefix ? "__Host-/__Secure- cookies must be secure" : "sameSite 'no_restriction' requires secure: true");
    }
    secure = true;
  }

  let hostOnly;
  if (hostPrefix || !host) hostOnly = true;
  else if (typeof c.hostOnly === "boolean") hostOnly = c.hostOnly;
  else if (rawDomain.startsWith(".")) hostOnly = false;
  // A dot-less domain is host-only; with an explicit url on another host it
  // can only be meant as a domain cookie.
  else hostOnly = !u || u.hostname.toLowerCase() === host;

  let path = typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/";
  if (hostPrefix) path = "/";
  // The cookie's own host when known (host-only cookies are bound to it);
  // keep the given url (port, scheme) when it points at that host (or, for a
  // domain cookie, at a subdomain of it).
  const targetHost = (host || u.hostname).toLowerCase();
  const uh = u ? u.hostname.toLowerCase() : "";
  const base = u && (uh === targetHost || (!hostOnly && uh.endsWith("." + targetHost))) ? u : null;
  const scheme = secure ? "https:" : base ? base.protocol : "http:";
  const details = {
    url: `${scheme}//${base ? base.host : targetHost}${path}`,
    name,
    value: c.value == null ? "" : String(c.value),
    path,
  };
  if (!hostOnly) details.domain = rawDomain;
  if (secure !== undefined) details.secure = secure;
  if (typeof c.httpOnly === "boolean") details.httpOnly = c.httpOnly;
  if (sameSite) details.sameSite = sameSite;
  const exp = Number(c.expirationDate ?? (Number(c.expires) > 0 ? c.expires : undefined));
  if (c.session !== true && Number.isFinite(exp) && exp > 0) {
    if (exp * 1000 < Date.now()) throw new Error("cookie already expired");
    details.expirationDate = exp;
  }
  if (c.partitionKey && typeof c.partitionKey === "object" && !Array.isArray(c.partitionKey)) details.partitionKey = c.partitionKey;
  return details;
}

// Sets every cookie; failures are counted and reported per cookie.
async function bg2bImportCookies(list) {
  let imported = 0;
  let failed = 0;
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    try {
      const set = await chrome.cookies.set(bg2bCookieSetDetails(c));
      if (!set) throw new Error("rejected by the browser");
      imported++;
    } catch (e) {
      failed++;
      if (errors.length < 50) {
        errors.push({
          index: i,
          name: capStr(c && c.name, 200),
          domain: capStr(c && (c.domain || c.url), 300),
          error: capStr((e && e.message) || e, 300),
        });
      }
    }
  }
  return { imported, failed, errors };
}

// Header-name token (RFC 9110) and a value without CR/LF/NUL: CDP rejects
// anything else, which would leave paused requests hanging.
const BG2B_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function bg2bCheckHeader(name, value) {
  if (typeof name !== "string" || !BG2B_HEADER_NAME.test(name)) throw new Error(`Invalid header name: ${capStr(name, 100)}`);
  const v = value == null ? "" : String(value);
  if (/[\r\n\0]/.test(v)) throw new Error(`Invalid value for header ${name} (CR/LF/NUL not allowed)`);
  return v;
}

// ----- HAR 1.2 -----
const BG2B_STATUS_TEXT = {
  100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information",
  204: "No Content", 206: "Partial Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
  307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 408: "Request Timeout", 409: "Conflict", 410: "Gone",
  412: "Precondition Failed", 413: "Content Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Content",
  429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout",
};

function bg2bHarHeaders(list) {
  return (Array.isArray(list) ? list : [])
    .filter((h) => h && h.name)
    .map((h) => ({ name: String(h.name), value: h.value != null ? String(h.value) : "" }));
}

function bg2bHarHeader(headers, name) {
  const n = name.toLowerCase();
  const h = headers.find((x) => x.name.toLowerCase() === n);
  return h ? h.value : "";
}

function bg2bHarQuery(url) {
  try {
    return Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function bg2bHarRequestCookies(headers) {
  const out = [];
  for (const h of headers) {
    if (h.name.toLowerCase() !== "cookie") continue;
    for (const part of h.value.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
    }
  }
  return out;
}

function bg2bHarResponseCookies(headers) {
  const out = [];
  for (const h of headers) {
    if (h.name.toLowerCase() !== "set-cookie") continue;
    for (const line of h.value.split("\n")) {
      const [first, ...attrs] = line.split(";");
      const i = first.indexOf("=");
      if (i <= 0) continue;
      const c = { name: first.slice(0, i).trim(), value: first.slice(i + 1).trim() };
      for (const a of attrs) {
        const j = a.indexOf("=");
        const k = (j >= 0 ? a.slice(0, j) : a).trim().toLowerCase();
        const v = j >= 0 ? a.slice(j + 1).trim() : "";
        if (k === "path") c.path = v;
        else if (k === "domain") c.domain = v;
        else if (k === "httponly") c.httpOnly = true;
        else if (k === "secure") c.secure = true;
        else if (k === "expires") {
          const d = new Date(v);
          if (!Number.isNaN(d.getTime())) c.expires = d.toISOString();
        }
      }
      out.push(c);
    }
  }
  return out;
}

// Merges the locally recorded phases of every request of one tab into HAR 1.2
// entries. startedDateTime = request start (not the completion time).
function bg2bBuildHar(tabId, limit, title) {
  const byId = new Map();
  for (const e of networkLogs) {
    if (!e || e.tabId !== tabId || e.requestId == null) continue;
    const k = String(e.requestId);
    let r = byId.get(k);
    if (!r) {
      r = { startTs: null, endTs: null, firstTs: e.ts };
      byId.set(k, r);
    }
    if (e.phase === "request") r.startTs = e.ts;
    else if (Number.isFinite(e.ts)) r.endTs = e.ts;
    if (e.url) r.url = e.url;
    if (e.method) r.method = e.method;
    if (e.type) r.type = e.type;
    if (e.statusCode) r.statusCode = e.statusCode;
    if (e.fromCache) r.fromCache = true;
    if (e.error) r.error = e.error;
    if (e.phase === "mock") r.mocked = true;
    if (e.requestHeaders) r.requestHeaders = e.requestHeaders;
    if (e.responseHeaders) r.responseHeaders = e.responseHeaders;
  }
  const rows = [];
  for (const r of byId.values()) {
    const start = Number.isFinite(r.startTs) ? r.startTs : r.firstTs;
    if (!Number.isFinite(start) || !r.url) continue;
    const time = Number.isFinite(r.endTs) && r.endTs >= start ? r.endTs - start : 0;
    const method = r.method || "GET";
    const reqHeaders = bg2bHarHeaders(r.requestHeaders);
    const resHeaders = bg2bHarHeaders(r.responseHeaders);
    const status = r.statusCode || 0;
    const clen = parseInt(bg2bHarHeader(resHeaders, "content-length"), 10);
    const hasLen = Number.isFinite(clen) && clen >= 0;
    const encoded = !!bg2bHarHeader(resHeaders, "content-encoding");
    const entry = {
      pageref: "page_1",
      startedDateTime: new Date(start).toISOString(),
      time,
      request: {
        method,
        url: r.url,
        httpVersion: "HTTP/1.1",
        cookies: bg2bHarRequestCookies(reqHeaders),
        headers: reqHeaders,
        queryString: bg2bHarQuery(r.url),
        headersSize: -1,
        bodySize: method === "GET" || method === "HEAD" ? 0 : -1,
      },
      response: {
        status,
        statusText: BG2B_STATUS_TEXT[status] || "",
        httpVersion: "HTTP/1.1",
        cookies: bg2bHarResponseCookies(resHeaders),
        headers: resHeaders,
        content: { size: hasLen && !encoded ? clen : 0, mimeType: bg2bHarHeader(resHeaders, "content-type") || "x-unknown" },
        redirectURL: bg2bHarHeader(resHeaders, "location"),
        headersSize: -1,
        bodySize: r.fromCache ? 0 : hasLen ? clen : -1,
      },
      cache: {},
      timings: { send: 0, wait: time, receive: 0 },
    };
    if (r.type) entry._resourceType = r.type;
    if (r.fromCache) entry._fromCache = true;
    if (r.error) entry._error = r.error;
    if (r.mocked) entry._mocked = true;
    rows.push({ start, entry });
  }
  rows.sort((a, b) => a.start - b.start);
  const entries = rows.slice(-limit).map((x) => x.entry);
  return {
    version: "1.2",
    creator: { name: "browser-mcp", version: chrome.runtime.getManifest().version },
    pages: [
      {
        startedDateTime: entries.length ? entries[0].startedDateTime : new Date().toISOString(),
        id: "page_1",
        title: title || "",
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    ],
    entries,
    comment: "Captured with chrome.webRequest: headers only, no bodies; sizes and timings are approximate.",
  };
}

// ----- tab audio (offscreen document, SPEC 8) -----
async function bg2bOffscreen(msg, what) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res || !res.ok) throw new Error((res && res.error) || `Offscreen document failed to ${what}`);
  return res;
}

// ---------- BG2a helpers: URLs, page_wait, trusted input, keys, AX tree, clipboard ----------
const bg2aSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bg2aHas = (obj, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(obj, k);
const bg2aNoHash = (u) => String(u || "").split("#")[0];

// Snapshot refs in every form content.js accepts: e12, ref=e12, [ref=e12].
const BG2A_REF_RE = /^\[?(?:ref=)?(e\d+)\]?$/;

// Selector for CDP DOM.querySelector: snapshot refs map to their data-mcp-ref
// attribute and a css= prefix is dropped (XPath / text= need content.js).
function bg2aCdpSelector(sel) {
  const s = String(sel ?? "").trim();
  if (!s) throw new Error("selector is required");
  const m = BG2A_REF_RE.exec(s);
  if (m) return `[data-mcp-ref="${m[1]}"]`;
  return s.startsWith("css=") ? s.slice(4).trim() : s;
}

// A URL without a scheme ("example.com", "localhost:3000/x") would resolve
// against the extension origin: give it one. URLs with a scheme are unchanged.
function bg2aNormalizeUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) return s;
  if (s.startsWith("//")) return `https:${s}`;
  const hostPort = /^[^\s/?#:@]+:\d{1,5}(?:[/?#]|$)/.test(s); // "host:port" is not a scheme
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(s);
  return `${loopback ? "http" : "https"}://${s}`;
}

// ----- page_wait (E18) -----
const BG2A_READY_RANK = { loading: 0, interactive: 1, complete: 2 };

// Main-frame state of a tab: committed URL + readyState (best effort).
async function bg2aTabState(tabId, wantReady) {
  const tab = await chrome.tabs.get(tabId); // throws when the tab is gone
  const url = tab.url || "";
  let ready = tab.status === "complete" ? "complete" : "loading";
  if (wantReady === "interactive" && ready !== "complete") {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        injectImmediately: true,
        func: () => document.readyState,
      });
      if (r && bg2aHas(BG2A_READY_RANK, r.result)) ready = r.result;
    } catch {}
  }
  return { url, ready };
}

// Content-side failures caused by the document going away mid-command.
function bg2aIsNavError(e) {
  return /document unloaded|message channel (?:is )?closed|Receiving end does not exist|Could not establish connection|back\/forward cache|Frame with ID \d+ (?:was removed|is showing error page)|No frame with id/i.test(
    String((e && e.message) || e)
  );
}

// URL / readyState conditions are checked here against the tab, so they
// survive full navigations; selector / text conditions run in the targeted
// frame's content script and are re-issued against the new document when a
// navigation tears the old one down mid-wait. A pure duration wait sleeps here.
async function bg2aPageWait(tabId, payload, ctx) {
  const t0 = Date.now();
  const timeout = Math.min(Math.max(Number(payload.timeoutMs) || 15000, 0), 7200000);
  const serverMs = ctx && Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0 ? Math.max(1000, ctx.timeoutMs - 1500) : Infinity;
  const deadline = t0 + Math.min(timeout, serverMs);
  let re = null;
  if (payload.urlPattern) {
    try {
      re = new RegExp(String(payload.urlPattern));
    } catch (e) {
      throw new Error(`Invalid urlPattern: ${(e && e.message) || e}`);
    }
  }
  const rs = payload.readyState || "";
  if (rs && !bg2aHas(BG2A_READY_RANK, rs)) throw new Error(`Invalid readyState: ${rs} (use loading, interactive or complete)`);
  const urlSub = payload.url ? String(payload.url) : "";
  const navCond = !!(urlSub || re || rs);
  const domCond = !!(payload.selector || payload.text);
  let lastUrl = "";
  const timedOut = () =>
    new Error(`Timed out: expected condition never appeared (after ${Date.now() - t0} ms)${lastUrl ? `; current URL: ${capStr(lastUrl, 300)}` : ""}`);
  if (!navCond && !domCond) {
    await bg2aSleep(Math.max(0, deadline - Date.now()));
    return { tabId, ok: true, waitedMs: Date.now() - t0 };
  }
  for (;;) {
    if (navCond) {
      const st = await bg2aTabState(tabId, rs);
      lastUrl = st.url;
      const ok =
        (!urlSub || st.url.includes(urlSub)) &&
        (!re || re.test(st.url)) &&
        (!rs || BG2A_READY_RANK[st.ready] >= BG2A_READY_RANK[rs]);
      if (!ok) {
        if (Date.now() >= deadline) throw timedOut();
        await bg2aSleep(Math.min(150, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (!domCond) return { tabId, ok: true, waitedMs: Date.now() - t0, url: st.url };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    try {
      const r = await toContent(
        tabId,
        "page_wait",
        { selector: payload.selector, text: payload.text, timeoutMs: Math.max(1, remaining) },
        remaining + 3000
      );
      const v = unwrap(r);
      return Object.assign({ tabId: r.tabId }, v && typeof v === "object" ? v : {}, { ok: true, waitedMs: Date.now() - t0 });
    } catch (e) {
      if (/^Timed out/.test(String(e && e.message))) throw timedOut();
      if (!bg2aIsNavError(e) || deadline - Date.now() < 250) throw e;
      await bg2aSleep(250); // let the next document commit, then wait on it
    }
  }
}

// ----- trusted input geometry (D7/F8) -----
// Scrolls the target into view in the targeted frame (focused frame, else the
// main frame) through content.js, where every selector form (refs, xpath=,
// text=, CSS) works. Returns { frameId, v } with v in that frame's viewport px.
async function bg2aScrollTarget(tabId, selector, ctx) {
  if (selector === undefined || selector === null || String(selector).trim() === "") throw new Error("selector is required");
  const r = await toContent(tabId, "scroll_into_view", { selector: String(selector) }, ctx && ctx.timeoutMs);
  const v = unwrap(r);
  if (!v || !Number.isFinite(v.cx) || !Number.isFinite(v.cy)) throw new Error(`Could not measure element: ${selector}`);
  if (!(v.width > 0 && v.height > 0)) throw new Error(`Element has no size (hidden or not rendered): ${selector}`);
  return { frameId: r.frameId || 0, v };
}

function bg2aQuadRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Main-frame viewport size in CSS px (the space of CDP Input coordinates).
async function bg2aMainViewport(dbg) {
  const lm = await cdpSend(dbg, "Page.getLayoutMetrics", {});
  const vp = lm.cssVisualViewport || lm.cssLayoutViewport || lm.visualViewport || lm.layoutViewport || {};
  return { w: vp.clientWidth || 0, h: vp.clientHeight || 0 };
}

// Viewport size of one frame (isolated-world probe), or null.
async function bg2aFrameViewport(tabId, frameId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      func: () => [window.innerWidth, window.innerHeight],
    });
    const v = r && r.result;
    return Array.isArray(v) ? { w: v[0], h: v[1] } : null;
  } catch {
    return null;
  }
}

// Finds the <iframe>/<frame> element hosting a (webNavigation) frame through
// CDP and returns its content box (= the frame's viewport) in main-frame
// viewport px, plus its backendNodeId and the content-box offset inside the
// border box. Matching: same-process frames by document URL, out-of-process
// frames by their debugger target (whose id is the CDP frame id), else the
// src attribute; the frame's own viewport size settles ties and confirms
// heuristic matches. Owners inside another out-of-process frame are unreachable.
async function bg2aFrameBox(dbg, tabId, frameId) {
  let frames = [];
  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch {}
  const me = frames.find((f) => f.frameId === frameId);
  if (!me) throw new Error("Focused frame is gone; call frame_focus again or frame_clear");
  const parent = frames.find((f) => f.frameId === me.parentFrameId);
  const want = bg2aNoHash(me.url);
  const parentUrl = parent ? bg2aNoHash(parent.url) : "";
  await cdpSend(dbg, "DOM.enable", {});
  const doc = await cdpSend(dbg, "DOM.getDocument", { depth: -1, pierce: true });
  const owners = []; // { node, docUrl }
  const stack = [[doc.root, bg2aNoHash(doc.root && doc.root.documentURL)]];
  while (stack.length) {
    const [n, docUrl] = stack.pop();
    if (!n) continue;
    if (n.nodeType === 1 && n.frameId) owners.push({ node: n, docUrl });
    for (const c of n.children || []) stack.push([c, docUrl]);
    for (const s of n.shadowRoots || []) stack.push([s, docUrl]);
    if (n.contentDocument) stack.push([n.contentDocument, bg2aNoHash(n.contentDocument.documentURL)]);
  }
  let cands = owners.filter((o) => o.node.contentDocument && bg2aNoHash(o.node.contentDocument.documentURL) === want);
  let exact = cands.length > 0;
  if (!exact) {
    const remote = owners.filter((o) => !o.node.contentDocument);
    try {
      const targets = await chrome.debugger.getTargets();
      const ids = new Set(targets.filter((t) => t.tabId === tabId && t.type !== "page" && bg2aNoHash(t.url) === want).map((t) => t.id));
      cands = remote.filter((o) => ids.has(o.node.frameId));
      exact = cands.length > 0;
    } catch {}
    if (!exact) {
      cands = remote.filter((o) => {
        const a = o.node.attributes || [];
        for (let i = 0; i + 1 < a.length; i += 2) {
          if (String(a[i]).toLowerCase() !== "src") continue;
          try {
            return bg2aNoHash(new URL(a[i + 1], o.docUrl || undefined).href) === want;
          } catch {
            return false;
          }
        }
        return false;
      });
      if (!cands.length) cands = remote;
    }
  }
  if (cands.length > 1 && parentUrl) {
    const inParent = cands.filter((o) => o.docUrl === parentUrl);
    if (inParent.length) cands = inParent;
  }
  const boxes = [];
  for (const o of cands) {
    try {
      const bm = await cdpSend(dbg, "DOM.getBoxModel", { backendNodeId: o.node.backendNodeId });
      const c = bg2aQuadRect(bm.model.content);
      const b = bg2aQuadRect(bm.model.border);
      boxes.push({ backendNodeId: o.node.backendNodeId, x: c.x, y: c.y, w: c.w, h: c.h, dx: c.x - b.x, dy: c.y - b.y });
    } catch {}
  }
  let pick = boxes;
  if (boxes.length > 1 || (!exact && boxes.length)) {
    const fv = await bg2aFrameViewport(tabId, frameId);
    pick = fv ? boxes.filter((b) => Math.abs(b.w - fv.w) <= 2 && Math.abs(b.h - fv.h) <= 2) : [];
  }
  if (pick.length !== 1) {
    throw new Error(
      "Could not locate the focused frame's <iframe> element for trusted input (frame nested in a cross-origin frame, several identical frames, or a transformed iframe); use the dom_* tools in this frame instead"
    );
  }
  return pick[0];
}

// Converts a bg2aScrollTarget() result to main-frame viewport px for CDP
// Input events (adds the focused frame's offset). Throws rather than return a
// point outside the visible viewport: a click there would hit nothing.
async function bg2aViewportPoint(dbg, tabId, target, label, allowScroll = true) {
  const { frameId, v } = target;
  if (v.inViewport === false) {
    throw new Error(`Element is outside the visible ${frameId ? "frame" : "page"} area even after scrolling it into view: ${label}`);
  }
  const vp = await bg2aMainViewport(dbg);
  const outside = (x, y) => vp.w > 0 && vp.h > 0 && (x < 0 || y < 0 || x >= vp.w || y >= vp.h);
  let x = v.cx;
  let y = v.cy;
  if (frameId) {
    let box = await bg2aFrameBox(dbg, tabId, frameId);
    if (x < 0 || y < 0 || (box.w > 0 && x >= box.w) || (box.h > 0 && y >= box.h)) {
      throw new Error(`Element is outside the visible frame area even after scrolling it into view: ${label}`);
    }
    if (allowScroll && outside(box.x + x, box.y + y)) {
      // Scroll the main page so the part of the iframe holding the point shows.
      try {
        await cdpSend(dbg, "DOM.scrollIntoViewIfNeeded", {
          backendNodeId: box.backendNodeId,
          rect: { x: box.dx + x - 1, y: box.dy + y - 1, width: 2, height: 2 },
        });
        await bg2aSleep(50);
        const bm = await cdpSend(dbg, "DOM.getBoxModel", { backendNodeId: box.backendNodeId });
        const c = bg2aQuadRect(bm.model.content);
        box = Object.assign({}, box, { x: c.x, y: c.y });
      } catch {}
    }
    x += box.x;
    y += box.y;
  }
  if (outside(x, y)) {
    throw new Error(
      `Element centre (${Math.round(x)}, ${Math.round(y)}) is outside the visible viewport (${Math.round(vp.w)}x${Math.round(vp.h)}) even after scrolling it into view: ${label}`
    );
  }
  return { x: Math.round(x), y: Math.round(y) };
}

// ----- trusted_key (D8/D9) -----
const BG2A_NAMED_KEYS = {
  Enter: { key: "Enter", code: "Enter", win: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", win: 9, text: "" },
  Escape: { key: "Escape", code: "Escape", win: 27, text: "" },
  Backspace: { key: "Backspace", code: "Backspace", win: 8, text: "" },
  Delete: { key: "Delete", code: "Delete", win: 46, text: "" },
  Insert: { key: "Insert", code: "Insert", win: 45, text: "" },
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
// US layout: physical key + OEM virtual-key code. The raw ASCII value would
// alias command keys ('.' = 46 = VK_DELETE, '(' = 40 = VK_DOWN, ...).
const BG2A_CHAR_KEYS = {
  "-": ["Minus", 189], _: ["Minus", 189], "=": ["Equal", 187], "+": ["Equal", 187],
  "[": ["BracketLeft", 219], "{": ["BracketLeft", 219], "]": ["BracketRight", 221], "}": ["BracketRight", 221],
  "\\": ["Backslash", 220], "|": ["Backslash", 220], ";": ["Semicolon", 186], ":": ["Semicolon", 186],
  "'": ["Quote", 222], '"': ["Quote", 222], ",": ["Comma", 188], "<": ["Comma", 188],
  ".": ["Period", 190], ">": ["Period", 190], "/": ["Slash", 191], "?": ["Slash", 191],
  "`": ["Backquote", 192], "~": ["Backquote", 192],
  "!": ["Digit1", 49], "@": ["Digit2", 50], "#": ["Digit3", 51], "$": ["Digit4", 52], "%": ["Digit5", 53],
  "^": ["Digit6", 54], "&": ["Digit7", 55], "*": ["Digit8", 56], "(": ["Digit9", 57], ")": ["Digit0", 48],
};

function bg2aKeySpec(k) {
  if (typeof k !== "string" || !k) return null;
  if (bg2aHas(BG2A_NAMED_KEYS, k)) return BG2A_NAMED_KEYS[k];
  if (Array.from(k).length !== 1) return null;
  if (/^[a-z]$/i.test(k)) return { key: k, code: `Key${k.toUpperCase()}`, win: k.toUpperCase().charCodeAt(0), text: k };
  if (/^[0-9]$/.test(k)) return { key: k, code: `Digit${k}`, win: k.charCodeAt(0), text: k };
  if (bg2aHas(BG2A_CHAR_KEYS, k)) return { key: k, code: BG2A_CHAR_KEYS[k][0], win: BG2A_CHAR_KEYS[k][1], text: k };
  // Any other character: text only, no key code (cannot alias a command key).
  return { key: k, code: "", win: 0, text: k };
}

// keyDown (with text) generates keypress/beforeinput/input and implicit form
// submission; rawKeyDown is only for keys without text. Ctrl/Alt/Meta chords
// are shortcuts and carry no text (Shift keeps it).
function bg2aKeyEvents(spec, modifiers) {
  const mods = Number(modifiers) || 0;
  const text = mods & ~8 ? "" : spec.text;
  const base = { key: spec.key, modifiers: mods };
  if (spec.code) base.code = spec.code;
  if (spec.win) base.windowsVirtualKeyCode = spec.win;
  const down = Object.assign({ type: text ? "keyDown" : "rawKeyDown" }, base, text ? { text, unmodifiedText: text } : {});
  const up = Object.assign({ type: "keyUp" }, base);
  return [down, up];
}

// ----- page_axtree (D19) -----
const BG2A_AX_PLAIN = new Set(["", "generic", "none", "presentation", "LineBreak", "StaticText", "InlineTextBox"]);
const BG2A_AX_PROPS = new Set(["level", "checked", "pressed", "expanded", "selected", "disabled", "required", "focused", "invalid"]);

// CDP AX nodes -> nested tree through childIds. Ignored and nameless
// generic/presentational nodes are skipped (their children are kept),
// InlineTextBox and StaticText repeating the parent's name are dropped, and
// at most maxNodes nodes are emitted (pre-order).
function bg2aBuildAxTree(nodes, maxNodes) {
  const byId = new Map();
  for (const n of nodes) if (n && n.nodeId !== undefined) byId.set(String(n.nodeId), n);
  const roots = nodes.filter((n) => n && (n.parentId === undefined || !byId.has(String(n.parentId))));
  const seen = new Set();
  let count = 0;
  let truncated = false;
  const build = (n, depth, parentName) => {
    if (!n || seen.has(n.nodeId) || depth > 500) return [];
    seen.add(n.nodeId);
    const role = (n.role && n.role.value) || "";
    if (role === "InlineTextBox") return [];
    const name = n.name && n.name.value != null ? String(n.name.value) : "";
    const raw = n.value && n.value.value;
    const value = raw === undefined || raw === null || raw === "" ? undefined : String(raw).slice(0, 100);
    const skip = !!n.ignored || (!name && value === undefined && BG2A_AX_PLAIN.has(role)) || (role === "StaticText" && name === parentName);
    let o = null;
    if (!skip) {
      if (count >= maxNodes) {
        truncated = true;
        return [];
      }
      count++;
      o = { role: role || "?", name: name.slice(0, 500) };
      if (value !== undefined) o.value = value;
      if (n.description && n.description.value) o.desc = String(n.description.value).slice(0, 100);
      for (const p of n.properties || []) {
        if (!BG2A_AX_PROPS.has(p.name)) continue;
        const pv = p.value && p.value.value;
        if (pv === undefined || pv === null) continue;
        if (pv === false && p.name !== "checked" && p.name !== "pressed" && p.name !== "expanded") continue;
        o[p.name] = pv;
      }
    }
    const kids = [];
    for (const cid of n.childIds || []) {
      if (count >= maxNodes) {
        truncated = true;
        break;
      }
      for (const k of build(byId.get(String(cid)), depth + 1, o ? name : parentName)) kids.push(k);
    }
    if (!o) return kids;
    if (kids.length) o.children = kids;
    return [o];
  };
  const out = [];
  for (const r of roots) {
    for (const k of build(r, 0, "")) out.push(k);
    if (count >= maxNodes) break;
  }
  return { nodes: out, count, truncated };
}

// ----- clipboard (D24) -----
// Only through the extension's offscreen document: an in-page fallback would
// run execCommand copy/paste inside the user's web page, whose copy/paste
// listeners could read or replace the clipboard contents.
async function bg2aOffscreenClipboard(msg) {
  await ensureOffscreen();
  let res = null;
  for (let i = 0; ; i++) {
    try {
      res = await chrome.runtime.sendMessage(msg);
      break;
    } catch (e) {
      const m = String((e && e.message) || e);
      if (i >= 1 || !/Receiving end does not exist|Could not establish connection/i.test(m)) {
        throw new Error(`offscreen document unreachable (${m})`);
      }
      await bg2aSleep(250); // document still loading
    }
  }
  if (!res || !res.ok) throw new Error((res && res.error) || "no answer from the offscreen document");
  return res;
}

// ---------- command router ----------
// ctx = { timeoutMs?: number } — the server-side timeout of this command.
// Content commands pass it on: toContent(tabId, cmd, payload, ctx?.timeoutMs).
async function handleCommand(action, payload, tabId, ctx = {}) {
  await permsReady;
  await stateReady;
  payload = payload && typeof payload === "object" ? payload : {};
  // Permission check (perm_list/perm_set are always allowed; perm_set can only disable)
  if (action !== "perm_list" && action !== "perm_set") {
    if (!isAllowed(action)) {
      throw new Error(`Permission disabled in extension: ${action} (enable it from the extension popup)`);
    }
    for (const dep of REQUIRES[normalizeAction(action)] || []) {
      if (!isAllowed(dep)) {
        throw new Error(`Permission disabled in extension: ${dep} (required by ${action}; enable it from the extension popup)`);
      }
    }
  }
  // An explicitly targeted tab is under automation from now on.
  if (Number.isInteger(tabId) && tabId >= 0) markAgentTab(tabId);
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
        requires: REQUIRES,
      };
    }
    case "perm_set": {
      // Over the bridge a permission can only be switched OFF (self-restriction).
      const a = String(payload.action ?? "");
      const targets = resolvePermNames(a);
      if (!targets.length) throw new Error(`Unknown permission: ${a}`);
      if (payload.enabled) throw new Error("Re-enabling a permission is only possible from the extension popup");
      setDisabled(new Set([...disabledActions, ...targets]), true);
      if (targets.length === 1 && targets[0] === a) return { ok: true, action: a, enabled: false };
      return { ok: true, action: a, actions: targets, enabled: false };
    }
    // ----- tabs -----
    case "tab_list":
    case "tabs_list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }
    case "tab_create": {
      const url = payload.url ? bg2aNormalizeUrl(payload.url) : "about:blank";
      const t = await chrome.tabs.create({ url: url || "about:blank", active: payload.active !== false });
      return { id: t.id, url: t.pendingUrl || t.url || url };
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
      const url = bg2aNormalizeUrl(payload.url);
      if (!url) throw new Error("url is required");
      await chrome.tabs.update(id, { url });
      return { ok: true, id, url };
    }
    case "tab_reload": {
      const id = tabId ?? (await activeTabId());
      await chrome.tabs.reload(id);
      return { ok: true, id };
    }
    case "tab_back": {
      // tabs.goBack also works on error pages, chrome:// pages and the PDF
      // viewer, where script injection is not allowed.
      const id = tabId ?? (await activeTabId());
      await chrome.tabs.goBack(id);
      return { ok: true, id };
    }
    case "tab_forward": {
      const id = tabId ?? (await activeTabId());
      await chrome.tabs.goForward(id);
      return { ok: true, id };
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
    case "storage_get":
    case "storage_set":
    case "idb_list":
    case "idb_stores":
    case "idb_read":
    case "idb_count":
    case "idb_put":
    case "idb_delete":
    case "idb_clear": {
      const r = await toContent(tabId, action, payload, ctx && ctx.timeoutMs);
      const v = unwrap(r);
      // string results (snapshot/html/text) pass through for AI readability
      if (typeof v === "string") return { tabId: r.tabId, text: v };
      if (Array.isArray(v)) return { tabId: r.tabId, items: v };
      if (v && typeof v === "object") return Object.assign({ tabId: r.tabId }, v);
      return { tabId: r.tabId, value: v };
    }

    case "page_wait": {
      // URL / readyState waits are tracked here so they survive navigations (E18).
      const id = tabId ?? (await activeTabId());
      return await bg2aPageWait(id, payload, ctx);
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
        // `return` outside a function or top-level await fails to compile as
        // a script: retry with function-body semantics (old `new Function`
        // behavior) inside an async IIFE — but ONLY after a compile error,
        // when nothing has run yet. A runtime exception (even a runtime
        // SyntaxError such as JSON.parse('x')) is reported as is: running
        // the code again would repeat its side effects (D3/F6). A parse-time
        // SyntaxError carries no JS stack frames; a thrown one always does.
        // An awaited rejection ("Uncaught (in promise) ...") means the code
        // already ran, even when its SyntaxError has no frames (Response.json()
        // on a non-JSON body, a DOMException from crypto.subtle): never retried.
        // Compile errors are reported synchronously as plain "Uncaught".
        const det = first.exceptionDetails;
        const ex = det.exception || {};
        const desc = String(ex.description || "");
        const inPromise = /\(in promise\)/i.test(String(det.text || ""));
        const isSyntax = ex.className === "SyntaxError" || /^SyntaxError\b/.test(desc);
        const hasFrames = /\n\s+at\s/.test(desc) || !!(det.stackTrace && (det.stackTrace.callFrames || []).length);
        if (inPromise || !isSyntax || hasFrames) {
          throw new Error(`Page JS error: ${JSON.stringify(det).slice(0, 1000)}`);
        }
        // (newlines: a trailing // comment must not swallow the closing brace)
        const wrapped = `(async () => {\n${expr}\n})()`;
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
        const sel = bg2aCdpSelector(payload.selector);
        const data = await withDebugger(id, async (dbg) => {
          await cdpSend(dbg, "DOM.enable", {});
          const doc = await cdpSend(dbg, "DOM.getDocument", { depth: 0 });
          const q = await cdpSend(dbg, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
          if (!q.nodeId) throw new Error(`Element not found: ${payload.selector}`);
          try {
            await cdpSend(dbg, "DOM.scrollIntoViewIfNeeded", { nodeId: q.nodeId });
          } catch {}
          const box = await cdpSend(dbg, "DOM.getBoxModel", { nodeId: q.nodeId });
          const r = bg2aQuadRect(box.model.border);
          if (!(r.w >= 1 && r.h >= 1)) throw new Error(`Element has no visible size: ${payload.selector}`);
          // Box-model quads are viewport-relative; the clip is in document
          // coordinates, so add the page scroll offset (D6).
          const lm = await cdpSend(dbg, "Page.getLayoutMetrics", {});
          const vv = lm.cssVisualViewport || lm.cssLayoutViewport || lm.visualViewport || lm.layoutViewport || {};
          const shot = await cdpSend(dbg, "Page.captureScreenshot", {
            format: "png",
            clip: {
              x: r.x + (vv.pageX || 0),
              y: r.y + (vv.pageY || 0),
              width: r.w,
              height: r.h,
              scale: payload.scale || 1,
            },
            captureBeyondViewport: true,
          });
          return shot.data;
        });
        return { tabId: id, dataUrl: `data:image/png;base64,${data}`, note: "element base64 dataUrl" };
      }
      if (payload.fullPage) {
        // fullPage: whole page via debugger, height capped by maxHeight (B24)
        const mh = Number(payload.maxHeight);
        const maxHeight = Number.isFinite(mh) && mh > 0 ? Math.min(Math.round(mh), 32768) : 16384;
        const shot = await withDebugger(id, async (dbg) => {
          const metrics = await cdpSend(dbg, "Page.getLayoutMetrics", {});
          const size = metrics.cssContentSize || metrics.contentSize || { width: 1280, height: 800 };
          const fullWidth = Math.ceil(size.width);
          const fullHeight = Math.ceil(size.height);
          const width = Math.min(fullWidth, 16384);
          const height = Math.min(fullHeight, maxHeight);
          const { data } = await cdpSend(dbg, "Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width, height, scale: 1 },
            captureBeyondViewport: true,
          });
          return { data, width, height, fullWidth, fullHeight };
        });
        const truncated = shot.height < shot.fullHeight || shot.width < shot.fullWidth;
        return {
          tabId: id,
          dataUrl: `data:image/png;base64,${shot.data}`,
          note: truncated
            ? `fullPage base64 dataUrl, cut to ${shot.width}x${shot.height} CSS px of ${shot.fullWidth}x${shot.fullHeight} (maxHeight goes up to 32768)`
            : "fullPage base64 dataUrl",
          truncated,
          width: shot.width,
          height: shot.height,
          fullHeight: shot.fullHeight,
        };
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

    case "tab_audio_record_start": {
      const id = tabId ?? (await activeTabId());
      // Reuses the offscreen document: recordings of other tabs keep running.
      await ensureOffscreen();
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: id });
      } catch (err) {
        throw new Error(`Failed to get media stream for tab ${id}: ${err.message || err}`);
      }
      const res = await chrome.runtime.sendMessage({
        type: "mcp-offscreen-audio-start",
        streamId,
        tabId: id,
        passthrough: payload.passthrough !== false,
      });
      if (!res || !res.ok) {
        throw new Error(res?.error || "Failed to start tab audio recording in offscreen document");
      }
      return { ok: true, tabId: id, recording: true, startedAt: res.startedAt, mimeType: res.mimeType };
    }

    case "tab_audio_record_stop": {
      await ensureOffscreen();
      // Without tabId: the single active recording (never "whatever tab is
      // active now", the user may have switched tabs while recording).
      let id = Number.isInteger(tabId) ? tabId : null;
      if (id === null) {
        const list = await bg2bOffscreen({ type: "mcp-offscreen-audio-list" }, "list recordings");
        const ids = Array.isArray(list.tabIds) ? list.tabIds : [];
        if (!ids.length) throw new Error("No active tab audio recording");
        if (ids.length > 1) throw new Error(`Several tab audio recordings are active (tabs ${ids.join(", ")}); pass tabId`);
        id = ids[0];
      }
      // Stop keeps the data in the offscreen document until it is released;
      // it is fetched in chunks (raw chunk size divisible by 3, so the base64
      // parts concatenate into one valid string).
      const meta = await bg2bOffscreen({ type: "mcp-offscreen-audio-stop", tabId: id }, "stop the tab audio recording");
      let base64;
      if (typeof meta.base64 === "string") {
        base64 = meta.base64;
      } else {
        const count = Number.isInteger(meta.chunkCount) && meta.chunkCount > 0 ? meta.chunkCount : 1;
        const parts = [];
        for (let i = 0; i < count; i++) {
          const part = await bg2bOffscreen({ type: "mcp-offscreen-audio-chunk", tabId: id, index: i }, `read audio chunk ${i}`);
          parts.push(part.base64 || "");
        }
        base64 = parts.join("");
      }
      try {
        await chrome.runtime.sendMessage({ type: "mcp-offscreen-audio-release", tabId: id });
      } catch {}
      const out = {
        ok: true,
        tabId: id,
        base64,
        mimeType: meta.mimeType,
        durationMs: meta.durationMs,
        sizeBytes: meta.sizeBytes,
      };
      if (meta.endedBy && meta.endedBy !== "stop") out.endedBy = meta.endedBy;
      if (meta.recorderError) out.recorderError = meta.recorderError;
      return out;
    }

    // ----- console -----
    case "console_get": {
      // tabId (payload or command target) narrows to one tab; omitted = all tabs.
      const tid = Number.isInteger(payload.tabId) ? payload.tabId : Number.isInteger(tabId) ? tabId : undefined;
      const lvl = payload.level || "all";
      const lim = payload.limit || 200;
      const arr = consoleLogs
        .filter((e) => tid === undefined || e.tabId === tid)
        .filter((e) => lvl === "all" || e.level === lvl)
        .slice(-lim);
      const res = { count: arr.length, logs: arr };
      if (tid !== undefined) res.tabId = tid;
      return res;
    }
    case "console_clear": {
      if (Number.isInteger(payload.tabId)) {
        // Optional: drop only one tab's entries.
        const keep = consoleLogs.filter((e) => e.tabId !== payload.tabId);
        consoleLogs.length = 0;
        consoleLogs.push(...keep);
        return { ok: true, tabId: payload.tabId };
      }
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
      // webRequest exposes no bodies: use a body recorded by a mock/spy session
      // when there is one, else re-fetch GET entries once from the top frame.
      // Other methods are never replayed (side effects).
      const rid = String(payload.requestId ?? "");
      const phases = networkLogs.filter((e) => String(e.requestId) === rid);
      const last = networkMap.get(rid);
      if (last && !phases.includes(last)) phases.push(last);
      if (!phases.length) throw new Error("requestId not found, list with network_requests");
      const pick = (f) => {
        for (const e of phases) if (e && e[f] !== undefined && e[f] !== null && e[f] !== "") return e[f];
        return undefined;
      };
      const reqPhase = phases.find((e) => e.phase === "request");
      const url = (reqPhase && reqPhase.url) || pick("url");
      const method = String(pick("method") || "").toUpperCase();
      const reqTs = reqPhase ? reqPhase.ts : pick("ts");
      const entryTab = pick("tabId");
      if (!url) throw new Error("requestId not found, list with network_requests");
      const targetTab = Number.isInteger(tabId) ? tabId : Number.isInteger(entryTab) && entryTab >= 0 ? entryTab : null;
      // 1) recorded response body (network_mock_start session on that tab)
      const sess = targetTab !== null ? fetchSessions.get(targetTab) : null;
      if (sess && Array.isArray(sess.bodies)) {
        const cands = sess.bodies.filter((b) => b && b.kind !== "request" && b.url === url && typeof b.body === "string");
        const rec = cands.find((b) => !Number.isFinite(reqTs) || b.ts >= reqTs) || null;
        if (rec) {
          return {
            url,
            method: method || "GET",
            source: "recorded",
            status: rec.status,
            mimeType: rec.mime || "",
            base64Encoded: !!rec.base64,
            bodyLength: rec.body.length,
            bodySnippet: rec.body.slice(0, 20000),
            truncated: rec.body.length > 20000,
            note: rec.body.length > 20000 ? "Full recorded body: network_bodies" : undefined,
          };
        }
      }
      // 2) GET without a recorded body: re-fetch once from the top frame
      if (method !== "GET") {
        throw new Error(
          `No recorded body for this ${method || "request"} and it cannot be re-sent safely (only GET is re-fetched). ` +
            "Run network_mock_start on the tab BEFORE the request, then read it with network_response_body or network_bodies."
        );
      }
      if (targetTab === null) throw new Error("The request was not made by a tab (e.g. a service worker); pass tabId to re-fetch it from a tab");
      const deadline = bg2bDeadline(ctx);
      await ensureContent(targetTab, 0);
      const r = await bg2bTopFrameSend(targetTab, "network_refetch", { url, method: "GET" }, deadline);
      return { url, source: "refetch", ...unwrap(r) };
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
        const num = (v, d, min) => {
          if (v === undefined || v === null) return d;
          const n = Number(v);
          if (!Number.isFinite(n) || n < min) throw new Error(`Invalid custom throttle value: ${v}`);
          return n;
        };
        params = {
          offline: !!payload.offline,
          latency: num(payload.latency, 0, 0),
          downloadThroughput: num(payload.downloadThroughput, -1, -1),
          uploadThroughput: num(payload.uploadThroughput, -1, -1),
        };
      } else if (profile !== "online" && profile !== "none") {
        throw new Error(`Unknown throttle profile: ${profile}`);
      }
      // The override lives only as long as the CDP session: a persistent
      // "throttle" debugger holder keeps it until it is cleared ('online').
      const noThrottle = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
      const clears = !params.offline && params.latency <= 0 && params.downloadThroughput <= 0 && params.uploadThroughput <= 0;
      if (clears) {
        const had = throttleSessions.has(id) || hasDebuggerHolder(id, "throttle");
        if (had) {
          // Reset explicitly: other holders (mock, headers, ...) may keep the session.
          try {
            await cdpSend({ tabId: id }, "Network.emulateNetworkConditions", noThrottle);
          } catch {}
          throttleSessions.delete(id);
          await releaseDebugger(id, "throttle");
        }
        return { ok: true, tabId: id, profile, params, active: false, cleared: had };
      }
      const had = throttleSessions.has(id);
      const dbg = await acquireDebugger(id, "throttle");
      try {
        await cdpSend(dbg, "Network.enable", {});
        await cdpSend(dbg, "Network.emulateNetworkConditions", params);
      } catch (e) {
        if (!had) {
          throttleSessions.delete(id);
          await releaseDebugger(id, "throttle").catch(() => {});
        }
        throw e;
      }
      throttleSessions.set(id, params);
      return { ok: true, tabId: id, profile, params, active: true };
    }
    case "network_set_headers": {
      const id = tabId ?? (await activeTabId());
      const raw = payload.headers;
      if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("headers must be an object of name -> value");
      const headers = {};
      for (const [k, v] of Object.entries(raw || {})) headers[k] = bg2bCheckHeader(k, v);
      // Extra headers live only as long as the CDP session: a persistent
      // "headers" debugger holder keeps them until cleared with {}.
      if (!Object.keys(headers).length) {
        const had = headerSessions.has(id) || hasDebuggerHolder(id, "headers");
        if (had) {
          try {
            await cdpSend({ tabId: id }, "Network.setExtraHTTPHeaders", { headers: {} });
          } catch {}
          headerSessions.delete(id);
          await releaseDebugger(id, "headers");
        }
        return { ok: true, tabId: id, headers, active: false, cleared: had };
      }
      const had = headerSessions.has(id);
      const dbg = await acquireDebugger(id, "headers");
      try {
        await cdpSend(dbg, "Network.enable", {});
        // Replaces the whole extra-header set of the tab.
        await cdpSend(dbg, "Network.setExtraHTTPHeaders", { headers });
      } catch (e) {
        if (!had) {
          headerSessions.delete(id);
          await releaseDebugger(id, "headers").catch(() => {});
        }
        throw e;
      }
      headerSessions.set(id, headers);
      return { ok: true, tabId: id, headers, active: true };
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
      if (!payload.name || !payload.url) throw new Error("name and url are required for cookies_set");
      const details = {
        url: payload.url,
        name: payload.name,
        value: payload.value == null ? "" : String(payload.value),
        path: payload.path || "/",
      };
      if (payload.domain) details.domain = payload.domain;
      if (payload.secure !== undefined) details.secure = payload.secure;
      if (payload.httpOnly !== undefined) details.httpOnly = payload.httpOnly;
      // "unspecified" = no SameSite attribute; SameSite=None needs Secure.
      if (payload.sameSite && payload.sameSite !== "unspecified") {
        if (!BG2B_SAMESITE[String(payload.sameSite).toLowerCase()]) throw new Error(`Unsupported sameSite: ${payload.sameSite}`);
        details.sameSite = BG2B_SAMESITE[String(payload.sameSite).toLowerCase()];
        if (details.sameSite === "no_restriction") {
          if (payload.secure === false) throw new Error("sameSite 'no_restriction' requires secure: true");
          details.secure = true;
        }
      }
      if (payload.expirationDate) details.expirationDate = payload.expirationDate;
      const cookie = await chrome.cookies.set(details);
      if (!cookie) throw new Error("The browser rejected the cookie (check url/domain/path, secure and __Host-/__Secure- rules)");
      return { ok: true, cookie };
    }
    case "cookies_delete": {
      if (!payload.name || !payload.url) throw new Error("name and url are required for cookies_delete");
      const removed = await chrome.cookies.remove({ url: payload.url, name: payload.name });
      return { ok: true, removed: !!removed };
    }
    case "cookies_clear": {
      // Never "everything" by omission: a filter, or an explicit all:true.
      const domain = typeof payload.domain === "string" ? payload.domain.trim() : "";
      const url = typeof payload.url === "string" ? payload.url.trim() : "";
      if (!domain && !url && payload.all !== true) {
        throw new Error("cookies_clear needs a domain or url filter; pass all:true to delete every cookie in the browser");
      }
      const all = await chrome.cookies.getAll(domain ? { domain } : url ? { url } : {});
      let n = 0;
      let failed = 0;
      const errors = [];
      for (const c of all) {
        const curl = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
        try {
          const det = { url: curl, name: c.name };
          if (c.storeId) det.storeId = c.storeId;
          if (c.partitionKey) det.partitionKey = c.partitionKey;
          const removed = await chrome.cookies.remove(det);
          if (removed) n++;
        } catch (e) {
          failed++;
          if (errors.length < 20) errors.push({ name: c.name, domain: c.domain, error: capStr((e && e.message) || e, 300) });
        }
      }
      const out = { ok: true, removed: n, matched: all.length };
      if (failed) Object.assign(out, { failed, errors });
      return out;
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
      // Host-only vs domain scope is preserved (see bg2bCookieSetDetails);
      // per-cookie failures are reported, not swallowed.
      const res = await bg2bImportCookies(payload.cookies);
      const out = { ok: true, imported: res.imported, failed: res.failed, total: payload.cookies.length };
      if (res.errors.length) out.errors = res.errors;
      return out;
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
      // (The gate also requires cookies_list + storage_get: REQUIRES.)
      const id = tabId ?? (await activeTabId());
      const t = await chrome.tabs.get(id);
      const tabUrl = t.url || "";
      const origin = bg2bHttpOrigin(tabUrl);
      if (!origin) throw new Error(`session_state_save needs an http(s) page (tab ${id} shows ${capStr(tabUrl, 200) || "no URL"})`);
      const domain = new URL(tabUrl).hostname;
      // Every cookie the page would receive (parent-domain cookies included)
      // plus the host's own cookies on other paths / subdomains.
      const seen = new Set();
      const cookies = [];
      const lists = await Promise.all([chrome.cookies.getAll({ url: tabUrl }), chrome.cookies.getAll({ domain })]);
      for (const c of lists.flat()) {
        const k = [c.storeId, c.domain, c.path, c.name, c.partitionKey ? JSON.stringify(c.partitionKey) : ""].join("\t");
        if (seen.has(k)) continue;
        seen.add(k);
        cookies.push(c);
      }
      // Storage of the top frame (never a frame_focus target), untruncated.
      const deadline = bg2bDeadline(ctx);
      await ensureContent(id, 0);
      const local = unwrap(await bg2bTopFrameSend(id, "storage_get", { area: "local", full: true }, deadline));
      const session = unwrap(await bg2bTopFrameSend(id, "storage_get", { area: "session", full: true }, deadline));
      for (const res of [local, session]) {
        if (res && res.truncated && Object.keys(res.truncated).length) {
          throw new Error("The content script returned truncated storage values; reload the extension/page and retry");
        }
        if (res && typeof res.url === "string" && bg2bHttpOrigin(res.url) !== origin) {
          throw new Error("The page navigated while its state was being saved; retry");
        }
      }
      const state = {
        url: tabUrl,
        origin,
        domain,
        savedAt: Date.now(),
        cookies,
        localStorage: (local && local.data) || {},
        sessionStorage: (session && session.data) || {},
      };
      return { ok: true, state };
    }
    case "session_state_load": {
      // (The gate also requires cookies_set + storage_set: REQUIRES.)
      const { state } = payload;
      if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("state object is required");
      const id = tabId ?? (await activeTabId());
      const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
      const localEntries = isObj(state.localStorage) ? Object.entries(state.localStorage) : [];
      const sessionEntries = isObj(state.sessionStorage) ? Object.entries(state.sessionStorage) : [];
      // Saved storage must only ever land in the origin it came from.
      const savedOrigin = bg2bHttpOrigin(state.url) || (typeof state.origin === "string" ? bg2bHttpOrigin(state.origin) : "");
      const tabOrigin = async () => bg2bHttpOrigin((await chrome.tabs.get(id)).url || "");
      if (savedOrigin || localEntries.length || sessionEntries.length) {
        if (!savedOrigin) throw new Error("state.url (http/https) is missing, so the storage origin cannot be verified");
        const cur = await tabOrigin();
        if (cur !== savedOrigin) {
          throw new Error(
            `Saved state belongs to ${savedOrigin} but tab ${id} shows ${cur || "a non-http(s) page"}; ` +
              `navigate the tab to ${capStr(state.url || savedOrigin, 500)} first (tab_navigate), then retry`
          );
        }
      }
      let cookieRes = { imported: 0, failed: 0, errors: [] };
      if (Array.isArray(state.cookies)) cookieRes = await bg2bImportCookies(state.cookies);
      let localKeys = 0;
      let sessionKeys = 0;
      if (localEntries.length || sessionEntries.length) {
        if ((await tabOrigin()) !== savedOrigin) throw new Error("The tab navigated away while the state was being restored; storage was not written");
        const deadline = bg2bDeadline(ctx);
        await ensureContent(id, 0);
        const str = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
        for (const [k, v] of localEntries) {
          unwrap(await bg2bTopFrameSend(id, "storage_set", { area: "local", key: k, value: str(v) }, deadline));
          localKeys++;
        }
        for (const [k, v] of sessionEntries) {
          unwrap(await bg2bTopFrameSend(id, "storage_set", { area: "session", key: k, value: str(v) }, deadline));
          sessionKeys++;
        }
      }
      const out = {
        ok: true,
        origin: savedOrigin || null,
        importedCookies: cookieRes.imported,
        failedCookies: cookieRes.failed,
        restoredStorage: localKeys + sessionKeys > 0,
        localKeys,
        sessionKeys,
      };
      if (cookieRes.errors.length) out.cookieErrors = cookieRes.errors;
      return out;
    }

    // ----- history -----
    case "history_search": {
      // Chrome defaults startTime to 24 h ago: search all of history unless told otherwise.
      const max = Number(payload.maxResults ?? payload.limit) || 20;
      const st = Number(payload.startTime);
      const query = { text: String(payload.query ?? ""), maxResults: max, startTime: Number.isFinite(st) && st >= 0 ? st : 0 };
      if (Number.isFinite(Number(payload.endTime)) && payload.endTime !== null && payload.endTime !== undefined) query.endTime = Number(payload.endTime);
      const items = await chrome.history.search(query);
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
      // Persistent "mock" holder: shares the attach with other CDP users
      // (an attach of our own that survived a worker restart is adopted).
      const dbg = await acquireDebugger(id, "mock");
      const tookOver = false;
      const isNew = !fetchSessions.has(id);
      if (isNew) fetchSessions.set(id, { routes: [], netmap: new Map(), bodies: [] });
      try {
        await cdpSend(dbg, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      } catch (e) {
        // Roll back a session that never armed (other holders keep the attach).
        if (isNew) {
          fetchSessions.delete(id);
          await releaseDebugger(id, "mock").catch(() => {});
        }
        throw e;
      }
      try {
        await cdpSend(dbg, "Network.enable", {});
      } catch {}
      saveMockSessions();
      return { ok: true, tabId: id, routes: fetchSessions.get(id).routes.length, tookOver };
    }
    case "network_mock_stop": {
      const id = tabId ?? (await activeTabId());
      const dbg = { tabId: id };
      try {
        await cdpSend(dbg, "Fetch.disable", {});
      } catch {}
      fetchSessions.delete(id);
      saveMockSessions();
      // Detaches only when no other holder (emulation, throttle, ...) remains.
      await releaseDebugger(id, "mock");
      return { ok: true, tabId: id };
    }
    case "network_mock_route": {
      const id = tabId ?? (await activeTabId());
      let sess = fetchSessions.get(id);
      if (!sess) throw new Error("Run network_mock_start first");
      const action = payload.action || "block";
      if (!["block", "fulfill", "delay", "continue"].includes(action)) throw new Error(`Unknown mock action: ${action}`);
      // Headers: [{name, value}] (an object map is accepted too). Validated up
      // front: CDP rejects invalid ones, which would leave the request paused.
      // fulfill: added to the mock response headers; delay/continue: merged into
      // the original request headers (same name replaced, others kept).
      let rawHeaders = payload.headers || [];
      if (!Array.isArray(rawHeaders)) {
        if (typeof rawHeaders !== "object") throw new Error("headers must be an array of {name, value}");
        rawHeaders = Object.entries(rawHeaders).map(([name, value]) => ({ name, value }));
      }
      const headers = rawHeaders.map((h) => {
        if (!h || typeof h !== "object") throw new Error("headers must be an array of {name, value}");
        return { name: h.name, value: bg2bCheckHeader(h.name, h.value) };
      });
      const status = payload.status === undefined || payload.status === null ? undefined : Number(payload.status);
      if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) throw new Error(`Invalid status: ${payload.status}`);
      const delayMs = payload.delayMs === undefined || payload.delayMs === null ? undefined : Number(payload.delayMs);
      if (delayMs !== undefined && (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 600000)) throw new Error(`Invalid delayMs: ${payload.delayMs}`);
      if (payload.body !== undefined && payload.body !== null && typeof payload.body !== "string") throw new Error("body must be a string");
      if (payload.contentType !== undefined && payload.contentType !== null) bg2bCheckHeader("Content-Type", payload.contentType);
      const route = {
        id: `r${++routeSeq}`,
        pattern: capStr(payload.pattern || "*", 4096),
        action,
        status,
        body: payload.body ?? undefined,
        contentType: payload.contentType ?? undefined,
        delayMs,
        headers,
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
      const sel = bg2aCdpSelector(payload.selector);
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
      await pushDialogPolicyToAgentTabs();
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
      const n = Number(payload.limit);
      const lim = Number.isInteger(n) && n > 0 ? Math.min(n, 5000) : 300;
      let title = "";
      try {
        const t = await chrome.tabs.get(id);
        title = t.title || t.url || "";
      } catch {}
      // Valid HAR 1.2 (see bg2bBuildHar): request start times, sizes/timings
      // (-1 / approximations where webRequest has no data), no bodies.
      return { tabId: id, log: bg2bBuildHar(id, lim, title) };
    }

    // ----- frames -----
    case "frame_list": {
      const id = tabId ?? (await activeTabId());
      const frames = (await chrome.webNavigation.getAllFrames({ tabId: id })) || [];
      const s = stickyFrames.get(id);
      return {
        tabId: id,
        sticky: !s ? null : typeof s === "string" ? { frameId: null, url: s } : { frameId: s.frameId ?? null, url: s.url },
        frames: frames
          .map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url }))
          .sort((a, b) => a.frameId - b.frameId),
      };
    }
    case "frame_focus": {
      // Resolves {frameId?, frameUrl?} to ONE frame; later content commands go
      // only to it (cleared by frame_clear or a main-frame navigation).
      const id = tabId ?? (await activeTabId());
      const frames = (await chrome.webNavigation.getAllFrames({ tabId: id })) || [];
      const sub = payload.frameUrl === undefined || payload.frameUrl === null ? "" : String(payload.frameUrl);
      let pick = null;
      if (payload.frameId !== undefined && payload.frameId !== null) {
        const fid = Number(payload.frameId);
        if (!Number.isInteger(fid) || fid < 0) throw new Error("frameId must be a non-negative integer (see frame_list)");
        pick = frames.find((f) => f.frameId === fid) || null;
        if (!pick) throw new Error(`No frame ${fid} in tab ${id} (see frame_list)`);
        if (sub && !(pick.url || "").includes(sub)) throw new Error(`Frame ${fid} does not match frameUrl "${sub}" (its URL is ${pick.url})`);
      } else {
        if (!sub) throw new Error("frame_focus needs frameId or frameUrl (see frame_list)");
        const cands = frames.filter((f) => (f.url || "").includes(sub));
        const subframes = cands.filter((f) => f.frameId !== 0);
        const pool = subframes.length ? subframes : cands;
        if (!pool.length) throw new Error(`No frame URL contains "${sub}" (see frame_list)`);
        if (pool.length > 1) {
          throw new Error(
            `frameUrl "${sub}" matches ${pool.length} frames (frameIds ${pool.map((f) => f.frameId).join(", ")}); pass frameId instead (see frame_list)`
          );
        }
        pick = pool[0];
      }
      // The URL (substring) is kept to re-find the frame if it is re-created.
      setStickyFrame(id, pick.frameId, sub || pick.url);
      return { ok: true, tabId: id, frameId: pick.frameId, url: pick.url };
    }
    case "frame_clear": {
      const id = tabId ?? (await activeTabId());
      clearStickyFrame(id);
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
      const url = payload.url ? bg2aNormalizeUrl(payload.url) : "";
      const w = await chrome.windows.create(url ? { url } : {});
      // tabs[] lets the WS plumbing mark the new tab(s) as agent tabs at once.
      const tabs = (w.tabs || []).map((t) => ({ id: t.id, url: t.pendingUrl || t.url }));
      const res = { ok: true, id: w.id, tabs };
      if (tabs.length) res.tabId = tabs[0].id;
      return res;
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
      // Real hierarchy from childIds (D19); maxNodes caps the emitted nodes.
      const maxNodes = Math.min(Math.max(Math.round(Number(payload.maxNodes)) || 800, 1), 5000);
      const out = await withDebugger(id, async (dbg) => {
        const params = {};
        if (Number.isInteger(payload.depth) && payload.depth > 0) params.depth = payload.depth;
        const tree = await cdpSend(dbg, "Accessibility.getFullAXTree", params);
        return bg2aBuildAxTree(tree.nodes || [], maxNodes);
      });
      return { tabId: id, count: out.count, truncated: out.truncated, nodes: out.nodes };
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
      const latitude = Number(payload.latitude);
      const longitude = Number(payload.longitude);
      const accuracy = payload.accuracy === undefined || payload.accuracy === null ? 50 : Number(payload.accuracy);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error(`Invalid latitude: ${payload.latitude}`);
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error(`Invalid longitude: ${payload.longitude}`);
      if (!Number.isFinite(accuracy) || accuracy < 0) throw new Error(`Invalid accuracy: ${payload.accuracy}`);
      // Persistent "emulation" holder: shares the attach with mock/throttle/
      // headers; releasing it detaches only when no other holder remains.
      const had = emulationSessions.has(id);
      const dbg = await acquireDebugger(id, "emulation");
      try {
        await cdpSend(dbg, "Emulation.setGeolocationOverride", { latitude, longitude, accuracy: accuracy || 50 });
      } catch (e) {
        if (!had) {
          emulationSessions.delete(id);
          await releaseDebugger(id, "emulation").catch(() => {});
        }
        throw e;
      }
      emulationSessions.set(id, { latitude, longitude, accuracy: accuracy || 50 });
      return { ok: true, tabId: id, latitude, longitude };
    }
    case "emulation_geolocation_clear": {
      const id = tabId ?? (await activeTabId());
      const dbg = { tabId: id };
      try {
        await cdpSend(dbg, "Emulation.clearGeolocationOverride", {});
      } catch {}
      emulationSessions.delete(id);
      await releaseDebugger(id, "emulation");
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
      // Scroll into view (content, focused frame or main frame), convert to
      // main-frame viewport px, refuse points outside the viewport (D7/F8).
      const id = tabId ?? (await activeTabId());
      const btn = payload.button || "left";
      const count = payload.doubleClick ? 2 : 1;
      const out = await withDebugger(id, async (dbg) => {
        const target = await bg2aScrollTarget(id, payload.selector, ctx);
        const { x, y } = await bg2aViewportPoint(dbg, id, target, payload.selector);
        await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (let i = 1; i <= count; i++) {
          await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: btn, clickCount: i });
          await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: btn, clickCount: i });
        }
        return { x, y, target };
      });
      const res = { ok: true, tabId: id, x: out.x, y: out.y, trusted: true };
      if (out.target.frameId) res.frameId = out.target.frameId;
      if (out.target.v.hit === false) res.warning = "Another element covers the target's centre; the click may have landed on it";
      return res;
    }
    case "trusted_type": {
      // The target is resolved, scrolled and focused by content.js in the
      // targeted frame (every selector form works, frames included); the text
      // then goes to the focused element as trusted CDP input.
      const id = tabId ?? (await activeTabId());
      const tmo = ctx && ctx.timeoutMs;
      if (payload.selector === undefined || payload.selector === null || String(payload.selector).trim() === "") throw new Error("selector is required");
      // Attach first: the debugging infobar must not appear between focusing and typing.
      await withDebugger(id, async (dbg) => {
        const sv = unwrap(await toContent(id, "scroll_into_view", { selector: String(payload.selector) }, tmo));
        let sel = (sv && sv.ref) || String(payload.selector);
        if (payload.clearFirst) {
          const dt = unwrap(await toContent(id, "dom_type", { selector: sel, text: "", clearFirst: true }, tmo));
          if (dt && dt.ref) sel = dt.ref; // dom_type may retarget (label / wrapper -> its input)
        }
        const fr = await toContent(id, "dom_focus", { selector: sel }, tmo);
        const f = unwrap(fr);
        if (!f || f.focused === false) {
          // A host with delegatesFocus passes focus to an inner element: accept
          // focus anywhere inside the target, never elsewhere on the page.
          let inside = false;
          const rm = BG2A_REF_RE.exec(sel);
          if (rm) {
            try {
              const [p] = await chrome.scripting.executeScript({
                target: { tabId: id, frameIds: [fr.frameId || 0] },
                func: (ref) => {
                  let n = document.activeElement;
                  while (n && n.shadowRoot && n.shadowRoot.activeElement) n = n.shadowRoot.activeElement;
                  for (let x = n; x; x = x.parentNode || (x.nodeType === 11 ? x.host : null)) {
                    if (x.nodeType === 1 && x.getAttribute("data-mcp-ref") === ref) return true;
                  }
                  return false;
                },
                args: [rm[1]],
              });
              inside = !!(p && p.result === true);
            } catch {}
          }
          if (!inside) {
            throw new Error(`Element did not take focus: ${payload.selector} (target the input, textarea or contenteditable element itself)`);
          }
        }
        await cdpSend(dbg, "Input.insertText", { text: String(payload.text ?? "") });
        if (payload.pressEnter) {
          // keyDown + text "\r" generates keypress -> implicit form submission (D8)
          for (const ev of bg2aKeyEvents(BG2A_NAMED_KEYS.Enter, 0)) await cdpSend(dbg, "Input.dispatchKeyEvent", ev);
        }
      });
      return { ok: true, tabId: id, trusted: true };
    }
    case "trusted_key": {
      const id = tabId ?? (await activeTabId());
      const k = payload.key;
      const spec = bg2aKeySpec(k);
      if (!spec) throw new Error(`Unsupported key: ${k} (named keys: ${Object.keys(BG2A_NAMED_KEYS).filter((n) => n !== " ").join(", ")}, or one character)`);
      await withDebugger(id, async (dbg) => {
        for (const ev of bg2aKeyEvents(spec, payload.modifiers)) await cdpSend(dbg, "Input.dispatchKeyEvent", ev);
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
      const pts = await withDebugger(id, async (dbg) => {
        const a0 = await bg2aScrollTarget(id, payload.from, ctx);
        const b = await bg2aScrollTarget(id, payload.to, ctx);
        // Centring the target may have moved the source: measure it again without scrolling.
        let a = a0;
        try {
          const q = await toContent(id, "dom_query", { selector: a0.v.ref || String(payload.from), limit: 1 }, ctx && ctx.timeoutMs);
          const it = (unwrap(q) || [])[0];
          if (it && typeof it === "object" && it.w > 0 && it.h > 0) {
            a = { frameId: q.frameId || 0, v: { cx: it.x + it.w / 2, cy: it.y + it.h / 2, width: it.w, height: it.h } };
          }
        } catch {}
        const pa = await bg2aViewportPoint(dbg, id, a, payload.from, false);
        const pb = await bg2aViewportPoint(dbg, id, b, payload.to, false);
        const ax = pa.x, ay = pa.y, bx = pb.x, by = pb.y;
        await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mouseMoved", x: ax, y: ay });
        await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mousePressed", x: ax, y: ay, button: "left", buttons: 1, clickCount: 1 });
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          await cdpSend(dbg, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(ax + ((bx - ax) * i) / steps),
            y: Math.round(ay + ((by - ay) * i) / steps),
            button: "left",
            buttons: 1,
          });
        }
        await cdpSend(dbg, "Input.dispatchMouseEvent", { type: "mouseReleased", x: bx, y: by, button: "left", clickCount: 1 });
        return { from: pa, to: pb, frameId: b.frameId };
      });
      const res = { ok: true, tabId: id, trusted: true, from: pts.from, to: pts.to };
      if (pts.frameId) res.frameId = pts.frameId;
      return res;
    }

    // ----- raw CDP -----
    case "cdp_send": {
      const id = tabId ?? (await activeTabId());
      const out = await withDebugger(id, async (dbg) => cdpSend(dbg, payload.method, payload.params || {}));
      return { tabId: id, result: out };
    }

    // ----- clipboard -----
    case "clipboard_write": {
      // Offscreen document only; never execCommand inside a web page (D24).
      const text = String(payload.text ?? "");
      try {
        await bg2aOffscreenClipboard({ type: "mcp-offscreen-clipboard-write", text });
      } catch (err) {
        throw new Error(`Failed to write to clipboard: ${(err && err.message) || err}`);
      }
      return { ok: true, textLength: text.length };
    }
    case "clipboard_read": {
      let res;
      try {
        res = await bg2aOffscreenClipboard({ type: "mcp-offscreen-clipboard-read" });
      } catch (err) {
        throw new Error(`Failed to read clipboard: ${(err && err.message) || err}`);
      }
      return { ok: true, text: res.text || "" };
    }

    // ----- browsing data -----
    case "browsing_data_clear": {
      const since = Number(payload.since ?? 0);
      const options = { since: Number.isFinite(since) && since > 0 ? since : 0 };
      const valid = [
        "appcache", "cache", "cacheStorage", "cookies", "downloads",
        "fileSystems", "formData", "history", "indexedDB", "localStorage",
        "passwords", "serviceWorkers", "webSQL"
      ];
      // Never wipe everything implicitly: explicit types, or all:true for the
      // common session-data set.
      const hasTypes = Array.isArray(payload.types) && payload.types.length > 0;
      if (!hasTypes && payload.all !== true) {
        throw new Error("browsing_data_clear needs a non-empty types list, or all:true to clear the common session data");
      }
      const reqTypes = hasTypes ? payload.types : ["cache", "cookies", "formData", "history", "localStorage", "indexedDB", "serviceWorkers"];
      const dataToRemove = {};
      const ignored = [];
      for (const t of reqTypes) {
        if (valid.includes(t)) dataToRemove[t] = true;
        else ignored.push(capStr(t, 50));
      }
      if (!Object.keys(dataToRemove).length) throw new Error(`No valid data types to clear (valid: ${valid.join(", ")})`);
      await chrome.browsingData.remove(options, dataToRemove);
      const out = { ok: true, cleared: Object.keys(dataToRemove), since: options.since };
      if (ignored.length) out.ignored = ignored;
      return out;
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
