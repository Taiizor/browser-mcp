// Background service worker: WS bridge + chrome.* API router.
// WS: ws://127.0.0.1:<port>  (default 8765, configurable in storage/popup)

// 3 = mutual HMAC authentication with a per-install key (see "pairing" below).
const PROTOCOL_VERSION = 3;
let currentPort = 8765;
let portLoaded = false;
let ws = null;
let reconnectMs = 1000;
let reconnectTimer = null;
// True once the server completed the v3 handshake on the current socket and
// sent `welcome`: commands, events and page hooks need it.
let paired = false;
// Last WebSocket close { code, reason, at } (e.g. 4003 untrusted extension id,
// 4001 auth required), surfaced in the popup through mcp-status.
let lastClose = null;

const consoleLogs = []; // {level,text,url,tabId,frameId,ts}
const networkLogs = []; // {requestId,url,method,type,tabId,statusCode,fromCache,ts,...}
const networkMap = new Map(); // requestId -> entry for O(1) lookups
const dialogEvents = []; // {kind,message,url,tabId,frameId,ts,response}
const MAX = 1000;

// { id, action, ok, error, durationMs, time, tabId, host, detail } (memory only;
// host/detail: see commandHost / historyDetail)
const commandHistory = [];
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
// emulation_viewport / emulation_media / emulation_cpu: tabId -> the applied
// override. They share the persistent "emulation" holder with geolocation.
const viewportSessions = new Map();
const mediaSessions = new Map();
const cpuSessions = new Map();
// Running CDP traces (perf_trace_start, persistent "perf" holder):
// tabId -> { startedAt, categories, collector (set while perf_trace_stop collects) }
const traceSessions = new Map();
let routeSeq = 0;
// Dialog policy applied by the MAIN-world dialog hook on agent tabs.
const dialogPolicy = { accept: true, promptText: "", blockUnload: false };
// Sticky frame (frame_focus): tabId -> { frameId, url }
const stickyFrames = new Map();
// Tabs under automation: created by tab_create / tab_duplicate / window_create
// or targeted with an explicit tabId. Console + dialog hooks are installed only
// here. Persisted in chrome.storage.session.
const agentTabs = new Set();
// Tabs reached only through the active-tab fallback (no tabId): tabId -> the
// origin they showed then. Console hook only, never the dialog hook; see
// activeTabId() for the rule. Persisted with agentTabs.
const fallbackTabs = new Map();
// Last time a command that may navigate touched a tab (explicit tabId or
// fallback): tabId -> ms. Tells agent-caused navigations from the user's own.
const tabTouch = new Map();

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

// Open AND authenticated (v3 handshake done): events are streamed, page hooks
// installed and network / spy data captured only then.
function bridgePaired() {
  return paired && bridgeOpen();
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
// permission is disabled; network capture also needs a paired bridge.
function eventAllowed(kind) {
  if (!permsLoaded) return false;
  if (kind === "network") return bridgePaired() && isAllowed("network_requests");
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
  // Never streamed to a socket that has not completed the handshake.
  if (paired) sendWs({ type: "event", kind, data }, MAX_EVENT_CHARS);
}

function sendPermsEvent() {
  if (!paired) return;
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
  abortSocketCommands(sock);
  sock.onopen = null;
  sock.onmessage = null;
  sock.onclose = null;
  sock.onerror = null;
  try {
    sock.close();
  } catch {}
}

// ---------- pairing (protocol 3) ----------
// Per extension install: installId (crypto.randomUUID(), kept for the life of
// the install, also when the key is replaced) and a 32-byte key K (64
// lowercase hex) handed out once by the server in a "pair" frame. Both live
// in the extension origin's IndexedDB (database "browser-mcp", object store
// "pairing", record "current"), which content scripts, running in the page's
// origin, can never open. (chrome.storage.local is not used for them: its
// TRUSTED_CONTEXTS access level needs Chromium 140+, and older versions let
// content scripts read and write it.) K never leaves the worker except inside
// HMAC proofs. port = the TCP port this socket dialed (decimal), so a server
// on another port cannot relay its challenge to us:
//   serverProof = HMAC-SHA256(K, "browser-mcp/v3|server|"    + extId + "|" + installId + "|" + port + "|" + Ne + "|" + Ns)
//   extProof    = HMAC-SHA256(K, "browser-mcp/v3|extension|" + extId + "|" + installId + "|" + port + "|" + Ns + "|" + Ne)
// Per socket: hello {installId, nonce: Ne, hasKey} ->
//   challenge {nonce: Ns, proof}: the server proves it holds K; we answer
//     auth {proof: extProof}. No stored key / wrong proof: close 4101.
//   pair {nonce: Ns, key}: accepted only without a stored key (first use) or
//     within 2 min of the popup's Re-pair; the key is stored first, then
//     pair_accept {proof: extProof}. Otherwise close 4100 (Re-pair offered).
// -> welcome {protocol, pid, serverVersion}: paired; commands run from now on.
// A welcome before that (an old v2 server, or one skipping the proof) is
// closed with 4102 and nothing runs. Every frame with an id + action is
// ignored until the socket is paired, so a process squatting on the port gets
// neither command execution nor events.
const HEX64_RE = /^[0-9a-f]{64}$/;
const INSTALL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ACCEPT_PAIR_MS = 120000;
const SLOW_RETRY_MS = 30000;
// Explicit rejections (either side) retry only every 30 s.
const SLOW_RETRY_CODES = new Set([4001, 4002, 4003, 4004, 4005, 4100, 4101, 4102]);
// Close code -> pairState shown in the popup (any other close: "none").
const CLOSE_PAIR_STATES = {
  4002: "protocol-mismatch",
  4004: "pairing-closed",
  4005: "auth-failed",
  4100: "repair-offered",
  4101: "server-auth-failed",
  4102: "protocol-mismatch",
};
// Problem states: kept across the slow retries (see sock.onopen).
const PAIR_PROBLEM_STATES = new Set(Object.values(CLOSE_PAIR_STATES));

let pairing = { installId: "", key: null };
// "none" | "handshake" | "paired" | "repair-offered" | "pairing-closed" |
// "server-auth-failed" | "auth-failed" | "protocol-mismatch"
let pairState = "none";
// From the last welcome / protocol-mismatch close (reset for every new socket).
let serverInfo = { version: null, protocol: null, pid: null };
// Re-pair clicked in the popup: a "pair" offer is accepted until this time
// (ms; mirrored in storage.session so a worker restart keeps it).
let acceptPairUntil = 0;
// socket -> { nonce: Ne, phase, port }: phase "hello" (not sent yet) ->
// "await" (waiting for challenge / pair) -> "verifying" (HMAC / key storage in
// progress) -> "verified" (waiting for welcome) -> "paired"; "closed" once
// rejected. port: the port this socket dialed (setPort may change currentPort
// while a handshake is still running).
const sockHs = new WeakMap();

function bytesToHex(u8) {
  let s = "";
  for (const b of u8) s += (b < 16 ? "0" : "") + b.toString(16);
  return s;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex32() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function hmacHex(keyHex, message) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

// Constant-time comparison: no early exit on the first differing character.
function hexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  return diff === 0;
}

// The pairing record in IndexedDB (see above).
const PAIRING_DB = "browser-mcp";
const PAIRING_STORE = "pairing";
const PAIRING_RECORD = "current";
// Where builds before the move kept it: migrated once, then removed.
const LEGACY_PAIRING_KEY = "mcpPairing";
let pairingDbPromise = null;

function pairingDb() {
  if (!pairingDbPromise) {
    const p = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined" || !indexedDB) throw new Error("IndexedDB is not available");
      const req = indexedDB.open(PAIRING_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PAIRING_STORE)) db.createObjectStore(PAIRING_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Closed under us (a version change, the browser clearing site data):
        // the next access opens it again.
        db.onversionchange = () => {
          db.close();
          if (pairingDbPromise === p) pairingDbPromise = null;
        };
        db.onclose = () => {
          if (pairingDbPromise === p) pairingDbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
    p.catch(() => {
      if (pairingDbPromise === p) pairingDbPromise = null;
    });
    pairingDbPromise = p;
  }
  return pairingDbPromise;
}

// One request in its own transaction; resolves the request's result once the
// transaction has committed.
async function pairingTx(mode, makeRequest) {
  const db = await pairingDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAIRING_STORE, mode);
    const req = makeRequest(tx.objectStore(PAIRING_STORE));
    let result;
    req.onsuccess = () => {
      result = req.result;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || req.error || new Error("IndexedDB request failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

// { installId, key } from a stored record; "" / null for what is missing or malformed.
function pairingFrom(p) {
  let installId = "";
  let key = null;
  if (p && typeof p === "object") {
    if (typeof p.installId === "string" && INSTALL_ID_RE.test(p.installId)) installId = p.installId;
    if (installId && typeof p.key === "string" && HEX64_RE.test(p.key)) key = p.key;
  }
  return { installId, key };
}

const pairingReady = (async () => {
  let legacy;
  try {
    const got = await chrome.storage.local.get(LEGACY_PAIRING_KEY);
    legacy = got ? got[LEGACY_PAIRING_KEY] : undefined;
  } catch {}
  let record;
  let dbOk = true;
  try {
    record = await pairingTx("readonly", (s) => s.get(PAIRING_RECORD));
  } catch (e) {
    // Never fall back to storage.local: content scripts may have written it.
    // This worker runs unpaired (a pair offer is declined: the key cannot be
    // stored) and the legacy record stays for the next start to migrate.
    dbOk = false;
    console.warn(`[mcp] pairing store (IndexedDB) unavailable: ${(e && e.message) || e}`);
  }
  let next = pairingFrom(record);
  let write = false;
  if (dbOk && record === undefined && legacy !== undefined) {
    // First start after the move: the storage.local record becomes the
    // IndexedDB record. (Only while IndexedDB holds no record at all: later,
    // a storage.local value is never trusted.)
    next = pairingFrom(legacy);
    write = !!next.installId;
  }
  if (!next.installId) {
    next = { installId: crypto.randomUUID(), key: null };
    write = true;
  }
  pairing = next;
  let saved = !write;
  if (write && dbOk) {
    try {
      await savePairing();
      saved = true;
    } catch {}
  }
  // The copy is committed (or IndexedDB already had the record): drop the old one.
  if (dbOk && saved && legacy !== undefined) {
    try {
      await chrome.storage.local.remove(LEGACY_PAIRING_KEY);
    } catch {}
  }
  try {
    const s = await chrome.storage.session.get("mcpAcceptPairUntil");
    const until = Number(s && s.mcpAcceptPairUntil);
    if (Number.isFinite(until) && until > Date.now()) acceptPairUntil = Math.min(until, Date.now() + ACCEPT_PAIR_MS);
  } catch {}
})();

async function savePairing() {
  const record = pairing.key ? { installId: pairing.installId, key: pairing.key } : { installId: pairing.installId };
  await pairingTx("readwrite", (s) => s.put(record, PAIRING_RECORD));
}

function setAcceptPairUntil(until) {
  acceptPairUntil = until;
  try {
    Promise.resolve(
      until ? chrome.storage.session.set({ mcpAcceptPairUntil: until }) : chrome.storage.session.remove("mcpAcceptPairUntil")
    ).catch(() => {});
  } catch {}
}

function sendOn(sock, obj) {
  if (sock.readyState !== WebSocket.OPEN) return;
  try {
    sock.send(JSON.stringify(obj));
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
    pairState = "none";
    onBridgeDown();
  }
  let sock;
  // Bound into the handshake proofs (see pairing above).
  const dialPort = currentPort;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${dialPort}`);
  } catch {
    schedule();
    return;
  }
  ws = sock;
  paired = false;
  sockHs.set(sock, { nonce: randomHex32(), phase: "hello", port: dialPort });
  sock.onopen = () => {
    if (ws !== sock) return;
    reconnectMs = 1000;
    // A problem state (pairing-closed, repair-offered, ...) stays visible
    // while the slow retry dials again: only welcome ("paired") or the next
    // close replaces it, and user actions (reconnectNow / setPort) reset it.
    if (!PAIR_PROBLEM_STATES.has(pairState)) pairState = "handshake";
    serverInfo = { version: null, protocol: null, pid: null };
    console.log(`[mcp] bridge connected on port ${currentPort}`);
    sendHello(sock);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    onSocketMessage(sock, ev.data);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    paired = false;
    abortSocketCommands(sock);
    lastClose = { code: Number(ev && ev.code) || 0, reason: capStr(ev && ev.reason, 200), at: Date.now() };
    pairState = CLOSE_PAIR_STATES[lastClose.code] || "none";
    if (lastClose.code === 4002) {
      const m = /server=(\d+)/.exec(lastClose.reason);
      if (m) serverInfo = Object.assign({}, serverInfo, { protocol: Number(m[1]) });
    }
    onBridgeDown();
    schedule(SLOW_RETRY_CODES.has(lastClose.code) ? SLOW_RETRY_MS : undefined);
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {}
  };
}

// Drops the current socket (if any) and dials again at once (Re-pair, forget
// pairing): a waiting server answers the new hello immediately.
function reconnectNow() {
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
  pairState = "none";
  reconnectMs = 1000;
  connect();
}

// Extension-initiated close of a server that failed the handshake (4100
// pair-declined, 4101 server-auth-failed, 4102 server-outdated): nothing runs
// on this socket and the next attempt comes in 30 s.
function rejectServer(sock, code, reason, state) {
  const hs = sockHs.get(sock);
  if (hs) hs.phase = "closed";
  if (ws !== sock) return;
  ws = null;
  paired = false;
  pairState = state;
  lastClose = { code, reason, at: Date.now() };
  console.warn(`[mcp] bridge rejected: ${code} ${reason}`);
  dropSocketWith(sock, code, reason);
  onBridgeDown();
  schedule(SLOW_RETRY_MS);
}

function dropSocketWith(sock, code, reason) {
  abortSocketCommands(sock);
  sock.onopen = null;
  sock.onmessage = null;
  sock.onclose = null;
  sock.onerror = null;
  try {
    sock.close(code, reason);
  } catch {
    try {
      sock.close();
    } catch {}
  }
}

async function sendHello(sock) {
  try {
    await permsReady;
  } catch {}
  try {
    await pairingReady;
  } catch {}
  const hs = sockHs.get(sock);
  if (ws !== sock || sock.readyState !== WebSocket.OPEN || !hs || hs.phase !== "hello") return;
  hs.phase = "await";
  sendOn(sock, {
    type: "hello",
    role: "extension",
    browser: detectBrowser(),
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    protocol: PROTOCOL_VERSION,
    perms: { disabled: Array.from(disabledActions) },
    installId: pairing.installId,
    nonce: hs.nonce,
    hasKey: !!pairing.key,
  });
}

// challenge: verify serverProof with the stored key, then prove ourselves.
async function onChallenge(sock, hs, msg) {
  const ns = msg.nonce;
  const proof = msg.proof;
  const key = pairing.key;
  const installId = pairing.installId;
  if (!key || typeof ns !== "string" || !HEX64_RE.test(ns) || typeof proof !== "string" || !HEX64_RE.test(proof)) {
    rejectServer(sock, 4101, "server-auth-failed", "server-auth-failed");
    return;
  }
  const extId = chrome.runtime.id;
  const expected = await hmacHex(key, `browser-mcp/v3|server|${extId}|${installId}|${hs.port}|${hs.nonce}|${ns}`);
  if (ws !== sock || hs.phase !== "verifying") return;
  if (!hexEqual(expected, proof)) {
    rejectServer(sock, 4101, "server-auth-failed", "server-auth-failed");
    return;
  }
  const extProof = await hmacHex(key, `browser-mcp/v3|extension|${extId}|${installId}|${hs.port}|${ns}|${hs.nonce}`);
  if (ws !== sock || hs.phase !== "verifying") return;
  hs.phase = "verified";
  // The server holds our key: a pending Re-pair is not needed any more.
  if (acceptPairUntil) setAcceptPairUntil(0);
  sendOn(sock, { type: "auth", proof: extProof });
}

// pair: trust on first use, or a Re-pair the user asked for in the popup.
async function onPairOffer(sock, hs, msg) {
  const ns = msg.nonce;
  const key = msg.key;
  if (typeof ns !== "string" || !HEX64_RE.test(ns) || typeof key !== "string" || !HEX64_RE.test(key)) {
    rejectServer(sock, 4101, "server-auth-failed", "server-auth-failed");
    return;
  }
  const repair = acceptPairUntil > Date.now();
  if (pairing.key && !repair) {
    // Already paired: replacing the key needs the user's Re-pair click.
    rejectServer(sock, 4100, "pair-declined", "repair-offered");
    return;
  }
  const prev = pairing.key;
  pairing = { installId: pairing.installId, key };
  try {
    await savePairing();
  } catch {
    pairing = { installId: pairing.installId, key: prev };
    rejectServer(sock, 4100, "pair-declined", "repair-offered");
    return;
  }
  if (repair) setAcceptPairUntil(0);
  const extProof = await hmacHex(key, `browser-mcp/v3|extension|${chrome.runtime.id}|${pairing.installId}|${hs.port}|${ns}|${hs.nonce}`);
  if (ws !== sock || hs.phase !== "verifying") return;
  hs.phase = "verified";
  sendOn(sock, { type: "pair_accept", proof: extProof });
}

function onSocketMessage(sock, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  const hs = sockHs.get(sock);
  if (!hs || hs.phase === "closed") return;
  const type = msg.type;
  if (type === "ping") return;
  if (type === "challenge" || type === "pair") {
    // Exactly one challenge or pair offer, and only in answer to our hello.
    if (hs.phase !== "await") {
      rejectServer(sock, 4101, "server-auth-failed", "server-auth-failed");
      return;
    }
    hs.phase = "verifying";
    (type === "challenge" ? onChallenge(sock, hs, msg) : onPairOffer(sock, hs, msg)).catch(() =>
      rejectServer(sock, 4101, "server-auth-failed", "server-auth-failed")
    );
    return;
  }
  if (type === "welcome") {
    if (hs.phase === "paired") return;
    if (hs.phase !== "verified") {
      if (hs.phase === "verifying") {
        // welcome before our proof was even sent: not a v3 server we can trust.
        rejectServer(sock, 4101, "server-auth-failed", "server-auth-failed");
      } else {
        // welcome without a challenge / pair: a v2 server (or an impostor).
        serverInfo = { version: null, protocol: Number.isInteger(msg.protocol) ? msg.protocol : null, pid: null };
        rejectServer(sock, 4102, "server-outdated", "protocol-mismatch");
      }
      return;
    }
    hs.phase = "paired";
    paired = true;
    pairState = "paired";
    serverInfo = {
      version: typeof msg.serverVersion === "string" ? capStr(msg.serverVersion, 50) : null,
      protocol: Number.isInteger(msg.protocol) ? msg.protocol : null,
      pid: Number.isInteger(msg.pid) ? msg.pid : null,
    };
    onBridgeUp();
    return;
  }
  // Nothing below runs before the handshake completed on this socket.
  if (hs.phase !== "paired") return;
  if (type === "cancel") {
    cancelBridgeCommand(sock, msg.id);
    return;
  }
  const id = msg.id;
  if ((typeof id !== "string" && typeof id !== "number") || id === "") return;
  if (typeof msg.action !== "string" || !msg.action) return;
  runBridgeCommand(sock, msg);
}

// ---------- cancellation ----------
// Running bridge commands: String(id) -> { ac, sock, ctx, id, action, tabId,
// startedAt, host }. {type:"cancel", id} from the socket that sent the command
// (or that socket going away, or the popup's mcp-stop-all) aborts ctx.signal;
// the command then answers { id, ok:false, error:"cancelled" }. The popup sees
// id/action/tabId/host/startedAt (mcp-status "running").
const runningCmds = new Map();

function cancelledError() {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelledError();
}

// Rejects once the signal aborts (never resolves).
function whenAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(cancelledError());
    else signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
  });
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(cancelledError());
      return;
    }
    let onAbort = null;
    const timer = setTimeout(() => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, Math.max(0, ms));
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(cancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function cancelBridgeCommand(sock, id) {
  if ((typeof id !== "string" && typeof id !== "number") || id === "") return;
  const e = runningCmds.get(String(id));
  if (e && e.sock === sock) e.ac.abort();
}

function abortSocketCommands(sock) {
  for (const e of runningCmds.values()) if (e.sock === sock) e.ac.abort();
}

// Actions that cannot navigate the page: they never count as the agent
// causing a navigation of a fallback tab (see activeTabId).
const NON_NAVIGATING_ACTIONS = new Set([
  "tabs_list", "tab_pin", "tab_mute", "window_list", "frame_list", "frame_focus", "frame_clear", "tab_group_list",
  "page_snapshot", "page_html", "page_text", "dom_query", "page_find", "page_wait", "page_axtree",
  "page_screenshot", "page_pdf", "console_get", "console_clear", "network_requests", "network_clear",
  "network_bodies", "har_export", "network_mock_list", "cookies_list", "cookies_get", "cookies_export",
  "storage_get", "idb_list", "idb_stores", "idb_read", "idb_count", "dialog_get", "dialog_clear", "page_metrics",
  "emulation_geolocation", "emulation_geolocation_clear", "emulation_viewport", "emulation_media", "emulation_cpu",
  "emulation_reset", "perf_trace_start", "perf_trace_stop", "perf_trace_chunk",
]);

function touchTab(ctx, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0 || (ctx && ctx.mayNavigate === false)) return;
  tabTouch.set(tabId, Date.now());
  if (ctx && ctx.touched) ctx.touched.add(tabId);
}

async function runBridgeCommand(sock, msg) {
  const start = Date.now();
  const tabId = Number.isInteger(msg.tabId) ? msg.tabId : undefined;
  const payload = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};
  const t = Number(msg.timeoutMs);
  const ac = new AbortController();
  // ctx.timeoutMs = the server-side timeout of this command (toContent derives its own budget from it)
  // ctx.signal    = aborted by a cancel frame or when the socket goes away
  // ctx.touched   = tabs this command resolved that it may navigate (fallback rule)
  const ctx = {
    timeoutMs: Number.isFinite(t) && t > 0 ? t : undefined,
    signal: ac.signal,
    touched: new Set(),
    mayNavigate: !NON_NAVIGATING_ACTIONS.has(normalizeAction(msg.action)),
  };
  const key = String(msg.id);
  // host: undefined until the lookup below settles.
  const entry = { ac, sock, ctx, id: key, action: msg.action, tabId: tabId ?? null, startedAt: start, host: undefined };
  runningCmds.set(key, entry);
  // Popup bookkeeping (running list + history). The host lookup runs beside
  // the command and never delays it; the detail is computed from the payload
  // as it arrived (see historyDetail for what may appear there).
  const hostLookup = commandHost(msg.action, tabId, payload).then(
    (h) => (entry.host = h),
    () => (entry.host = "")
  );
  let detail = "";
  try {
    detail = historyDetail(msg.action, payload);
  } catch {}
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
    const run = handleCommand(msg.action, payload, tabId, ctx);
    run.catch(() => {});
    // A handler that ignores the signal still answers "cancelled" at once.
    const result = await Promise.race([run, whenAborted(ac.signal)]);
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
    errStr = ac.signal.aborted ? "cancelled" : String((e && e.message) || e);
    reply(JSON.stringify({ id: msg.id, ok: false, error: errStr }));
  } finally {
    if (runningCmds.get(key) === entry) runningCmds.delete(key);
    const now = Date.now();
    for (const id of ctx.touched) tabTouch.set(id, now);
    // The reply has been sent: a host lookup still pending gets a short grace.
    const host = entry.host !== undefined ? entry.host : await settleWithin(hostLookup, HISTORY_HOST_WAIT_MS, "");
    recordCommandHistory({
      id: msg.id,
      action: msg.action,
      ok,
      error: errStr,
      durationMs: now - start,
      time: now,
      tabId: msg.tabId ?? null,
      host: typeof host === "string" ? host : "",
      detail,
    });
  }
}

// ---------- popup bookkeeping: command host + safe detail ----------
const HISTORY_HOST_WAIT_MS = 300;
const HISTORY_DETAIL_MAX = 120;
const HISTORY_SELECTOR_MAX = 80;

// Resolves p's value, or `fallback` once ms have passed (or when p rejects).
function settleWithin(p, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

// Hostname of an http(s) or file URL; "" for every other scheme and for
// anything unparsable. Never a path, query or credentials.
function urlHostname(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") return "";
    return capStr(u.hostname, 253);
  } catch {
    return "";
  }
}

// Actions that do not act on "the active tab" when no tabId is given (the
// browser, a window, global buffers or another API): their host is the
// explicit target's, else "".
const TABLESS_ACTIONS = new Set([
  "tabs_list", "window_list", "window_create", "window_focus", "browser_close",
  "tab_group_create", "tab_group_list", "tab_group_update", "tab_group_ungroup",
  "console_get", "console_clear", "network_requests", "network_clear",
  "downloads_list", "downloads_pause", "downloads_resume", "downloads_cancel", "downloads_erase",
  "bookmarks_search", "bookmarks_list", "bookmarks_add", "bookmarks_remove",
  "cookies_list", "cookies_get", "cookies_set", "cookies_delete", "cookies_clear", "cookies_export", "cookies_import",
  "sessions_recently_closed", "sessions_restore", "dialog_policy", "dialog_get", "dialog_clear",
  "clipboard_read", "clipboard_write", "browsing_data_clear", "notification_create", "notification_clear",
  "perf_trace_chunk", "history_search", "history_delete",
]);

// Hostname of the tab a command acts on: the explicit tabId, else the active
// tab of the last focused window (the active-tab fallback). tab_create acts on
// the tab it opens: the target URL's hostname. "" when none / unknown.
async function commandHost(action, tabId, payload) {
  const a = normalizeAction(action);
  if (!PERM_ALL_SET.has(a)) return "";
  if (a === "tab_create") return urlHostname(bg2aNormalizeUrl(payload && payload.url));
  if (Number.isInteger(tabId) && tabId >= 0) {
    const t = await chrome.tabs.get(tabId);
    return urlHostname(t && (t.url || t.pendingUrl));
  }
  if (TABLESS_ACTIONS.has(a)) return "";
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return urlHostname(t && (t.url || t.pendingUrl));
}

// A selector/ref for the popup: whitespace and control characters collapsed, capped.
function histSelector(v) {
  if (typeof v !== "string") return "";
  return capStr(v.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim(), HISTORY_SELECTOR_MAX);
}

function histJoin(...parts) {
  return parts.filter((p) => p !== "").join(" · ");
}

function histLength(v) {
  return v == null ? 0 : String(v).length;
}

// Named keys (keyboard_press / trusted_key) that may be shown by name.
const HISTORY_NAMED_KEY_RE =
  /^(?:Enter|Return|Tab|Escape|Esc|Backspace|Delete|Del|Insert|Space|Spacebar|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Up|Down|Left|Right|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-9]|2[0-4])|ContextMenu|CapsLock|NumLock|ScrollLock|Pause|PrintScreen)$/i;
const HISTORY_KEY_MODS = new Set(["ctrl", "control", "shift", "alt", "option", "opt", "meta", "cmd", "command", "win", "windows", "super", "os"]);

// The key name for a named key ("Enter", "Shift+Tab") or a shortcut with
// Ctrl/Alt/Meta ("Ctrl+K"); anything that could be typed text is "1 key".
function histKey(k) {
  if (typeof k !== "string" || !k) return "";
  const parts = k.split("+");
  const main = parts.pop().trim();
  const mods = parts.map((p) => p.trim().toLowerCase());
  if (!mods.every((m) => HISTORY_KEY_MODS.has(m))) return "1 key";
  if (main.length > 1 && HISTORY_NAMED_KEY_RE.test(main)) return capStr(k.trim(), 40);
  const shortcut = mods.some((m) => m !== "shift");
  if (shortcut && main.length === 1 && /^[A-Za-z0-9]$/.test(main)) return capStr(k.trim(), 40);
  return "1 key";
}

// A cookie domain filter ("example.com", ".example.com"), else "".
function histDomain(v) {
  if (typeof v !== "string") return "";
  const d = v.trim();
  return /^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/i.test(d) ? capStr(d, HISTORY_SELECTOR_MAX) : "";
}

const SELECTOR_DETAIL_ACTIONS = new Set([
  "dom_click", "dom_select", "dom_check", "dom_hover", "dom_focus", "dom_scroll", "page_wait", "page_screenshot",
  "trusted_click", "trusted_scroll",
]);

// Short, SAFE summary of a command for the popup history (max 120 chars, ""
// when nothing applies). An allow-list per action: selectors, lengths, counts,
// hostnames, named keys and CDP method names only. Never typed text, field
// values, cookie / storage / clipboard values, code, CDP params, file paths,
// or URL paths and queries.
function historyDetail(action, payload) {
  const a = normalizeAction(action);
  const p = payload && typeof payload === "object" ? payload : {};
  let d = "";
  if (a === "tab_create" || a === "tab_navigate") {
    d = urlHostname(bg2aNormalizeUrl(p.url));
  } else if (SELECTOR_DETAIL_ACTIONS.has(a)) {
    d = histSelector(p.selector);
  } else if (a === "dom_drag") {
    d = histSelector(p.from);
  } else if (a === "dom_type" || a === "trusted_type") {
    d = histJoin(histSelector(p.selector), `${histLength(p.text)} chars`);
  } else if (a === "dom_fill") {
    if (typeof p.selector === "string") {
      d = histJoin(histSelector(p.selector), p.value != null ? `${histLength(p.value)} chars` : "");
    } else if (p.fields && typeof p.fields === "object" && !Array.isArray(p.fields)) {
      // The MCP tool sends { fields: { selector: value } }.
      const entries = Object.entries(p.fields);
      if (entries.length === 1) {
        const [sel, val] = entries[0];
        d = histJoin(histSelector(sel), val != null ? `${histLength(val)} chars` : "");
      } else if (entries.length > 1) {
        const sels = capStr(entries.map(([sel]) => histSelector(sel)).join(", "), HISTORY_SELECTOR_MAX);
        d = histJoin(sels, `${entries.length} fields`);
      }
    }
  } else if (a === "dom_upload") {
    d = histJoin(histSelector(p.selector), `${Array.isArray(p.filePaths) ? p.filePaths.length : 0} files`);
  } else if (a === "keyboard_press" || a === "trusted_key") {
    d = histKey(p.key);
  } else if (a === "js_evaluate") {
    d = `${histLength(p.expression)} chars of code`;
  } else if (a === "cdp_send") {
    d = typeof p.method === "string" && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(p.method) ? capStr(p.method, HISTORY_SELECTOR_MAX) : "";
  } else if (a.startsWith("cookies_")) {
    d = histDomain(p.domain) || urlHostname(p.url);
  }
  return capStr(d, HISTORY_DETAIL_MAX);
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
  pairState = "none";
  reconnectMs = 1000;
  connect();
}

// Popup-only data: content scripts must not read or write storage.local
// (permission switches, port). Chromium accepts this for the local area only
// from version 140 (older versions reject it, and content scripts can then
// write storage.local), so nothing read from it is trusted blindly: switches
// only tighten (see the onChanged merge), a stored port is not applied from
// storage changes, and the pairing key lives in IndexedDB instead.
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
      // A pending retry (30 s after a rejection) keeps its schedule.
      if (alarm.name === "mcp_heartbeat" && !bridgeOpen() && !reconnectTimer) connect();
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
          fallbackTabs: Array.from(fallbackTabs.entries()),
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
      for (const e of Array.isArray(st.fallbackTabs) ? st.fallbackTabs : []) {
        const [id, origin] = Array.isArray(e) ? e : [];
        if (!live.has(id) || agentTabs.has(id)) continue;
        fallbackTabs.set(id, typeof origin === "string" ? capStr(origin, 2048) : "");
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

// Full agent tab (created by the agent or targeted with an explicit tabId):
// console + dialog hooks. A fallback tab targeted explicitly is promoted.
function markAgentTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0 || agentTabs.has(tabId)) return;
  agentTabs.add(tabId);
  fallbackTabs.delete(tabId);
  saveSessionState();
  chrome.tabs.get(tabId).then(
    () => installPageHooks(tabId),
    () => {
      if (agentTabs.delete(tabId)) saveSessionState();
    }
  );
}

function urlOrigin(url) {
  try {
    return new URL(String(url || "")).origin;
  } catch {
    return "";
  }
}

// Active-tab fallback target (see activeTabId): console hook only.
function markFallbackTab(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0 || agentTabs.has(tabId)) return;
  const origin = urlOrigin(url);
  const isNew = !fallbackTabs.has(tabId);
  if (!isNew && fallbackTabs.get(tabId) === origin) return;
  fallbackTabs.set(tabId, origin);
  saveSessionState();
  if (isNew) installPageHooks(tabId);
}

// Within this window after a navigating command touched the tab (or while
// such a command still runs on it), a navigation counts as agent-caused.
const AGENT_NAV_WINDOW_MS = 10000;

function agentCausedNavigation(tabId) {
  const ts = tabTouch.get(tabId);
  if (ts && Date.now() - ts <= AGENT_NAV_WINDOW_MS) return true;
  for (const e of runningCmds.values()) if (e.ctx.touched.has(tabId)) return true;
  return false;
}

// Main-frame commit in a fallback tab: a cross-origin navigation the agent
// did not cause ends the fallback status (the new document gets no hooks).
function checkFallbackNavigation(tabId, url) {
  if (!fallbackTabs.has(tabId)) return;
  const origin = urlOrigin(url);
  if (origin === fallbackTabs.get(tabId)) return;
  if (agentCausedNavigation(tabId)) fallbackTabs.set(tabId, origin);
  else fallbackTabs.delete(tabId);
  saveSessionState();
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

// Dialogs are answered only while dialog_policy is switched on: with it off
// (e.g. after the popup's Stop agent) agent tabs get native dialogs back, as
// when the bridge is down; switching it on again re-arms the agent's policy
// (setDisabled -> refreshAgentHooks).
function dialogHookPolicy() {
  return {
    passthrough: !(permsLoaded && isAllowed("dialog_policy")),
    accept: dialogPolicy.accept !== false,
    promptText: String(dialogPolicy.promptText || ""),
    blockUnload: !!dialogPolicy.blockUnload,
  };
}

// Hooks go only into the main frame of agent tabs, and only while the bridge
// is paired (navigation re-installs; markAgentTab installs immediately).
// Fallback tabs get the console hook only: dialogs are auto-answered only in
// tabs the agent created or targeted with an explicit tabId.
async function installPageHooks(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const full = agentTabs.has(tabId);
  if ((!full && !fallbackTabs.has(tabId)) || !bridgePaired()) return;
  const consoleOn = permsLoaded && isAllowed("console_get");
  const jobs = [runInMainWorld(tabId, mcpPageHookMain, [consoleOn])];
  if (full) jobs.push(runInMainWorld(tabId, mcpDialogHookMain, [dialogHookPolicy()]));
  await Promise.all(jobs);
}

function hookedTabs() {
  return new Set([...agentTabs, ...fallbackTabs.keys()]);
}

function refreshAgentHooks() {
  stateReady.then(() => {
    for (const id of hookedTabs()) installPageHooks(id);
  });
}

// dialog_policy: persist and apply to every agent tab (never to other tabs).
async function pushDialogPolicyToAgentTabs() {
  saveSessionState();
  await stateReady;
  if (!bridgePaired()) return;
  const policy = dialogHookPolicy();
  await Promise.all(Array.from(agentTabs, (id) => runInMainWorld(id, mcpDialogHookMain, [policy])));
}

// Bridge down (closed or never paired) for longer than the grace period:
// agent tabs get native dialogs back and stop console capture, and fallback
// tabs lose their status (a short reconnect keeps automation intact).
const PASSTHROUGH_GRACE_MS = 15000;
let passthroughTimer = null;
let bridgeUp = false;

function startPassthroughTimer() {
  if (passthroughTimer) clearTimeout(passthroughTimer);
  passthroughTimer = setTimeout(() => {
    passthroughTimer = null;
    if (bridgePaired()) return;
    for (const id of hookedTabs()) runInMainWorld(id, mcpHooksOffMain, []);
    if (fallbackTabs.size) {
      fallbackTabs.clear();
      saveSessionState();
    }
  }, PASSTHROUGH_GRACE_MS);
}

// Called on welcome (paired), not on socket open.
function onBridgeUp() {
  bridgeUp = true;
  if (passthroughTimer) {
    clearTimeout(passthroughTimer);
    passthroughTimer = null;
  }
  cancelSessionTeardown();
  setBridgeDownAt(0);
  refreshAgentHooks();
  resumeDebugSessions().catch(() => {});
}

// Idempotent: only the up -> down transition starts the grace timers.
function onBridgeDown() {
  if (!bridgeUp) return;
  bridgeUp = false;
  setBridgeDownAt(Date.now());
  armSessionTeardown(SESSION_TEARDOWN_MS);
  startPassthroughTimer();
}

// ---------- debugger session teardown timer ----------
// Debugger-backed sessions (registry below) are torn down once the bridge has
// been down for SESSION_TEARDOWN_MS. The moment it went down is mirrored in
// storage.session, so a worker restart in between keeps the deadline.
const SESSION_TEARDOWN_MS = 30000;
let sessionTeardownTimer = null;

function setBridgeDownAt(ts) {
  try {
    Promise.resolve(ts ? chrome.storage.session.set({ mcpBridgeDownAt: ts }) : chrome.storage.session.remove("mcpBridgeDownAt")).catch(() => {});
  } catch {}
}

function armSessionTeardown(delayMs) {
  if (sessionTeardownTimer) clearTimeout(sessionTeardownTimer);
  sessionTeardownTimer = setTimeout(() => {
    sessionTeardownTimer = null;
    if (bridgePaired()) return;
    discardPendingRestore();
    teardownDebugSessions().catch(() => {});
  }, Math.max(0, delayMs));
}

function cancelSessionTeardown() {
  if (sessionTeardownTimer) {
    clearTimeout(sessionTeardownTimer);
    sessionTeardownTimer = null;
  }
}

// Service-worker restart: bridgeUp starts false, so onBridgeDown would never
// fire if the bridge does not come back, and the restored agent tabs would
// keep auto-accepting hooks. Start the grace timer once the state is
// restored; a later welcome (onBridgeUp) cancels it.
stateReady.then(() => {
  if (!bridgePaired() && !passthroughTimer && (agentTabs.size || fallbackTabs.size)) startPassthroughTimer();
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
      checkFallbackNavigation(d.tabId, d.url);
      installPageHooks(d.tabId);
    });
  });
  // onCompleted: guaranteed install
  chrome.webNavigation.onCompleted.addListener((d) => {
    if (d.frameId === 0) stateReady.then(() => installPageHooks(d.tabId));
  });
}

// ---------- helpers ----------
// Resolves the command target when no tabId was given.
// Active-tab fallback rule: the user's focused tab must not become a permanent
// agent tab. It becomes only a *fallback* tab: console hook (when console_get
// is allowed), never the dialog auto-accept hook, which is reserved for tabs
// the agent created (tab_create / tab_duplicate / window_create) or targeted
// with an explicit tabId (markAgentTab). The fallback status ends on a
// main-frame cross-origin navigation the agent did not cause (no navigating
// command touched the tab within AGENT_NAV_WINDOW_MS and none is running on
// it), when the tab closes, and once the bridge has been down for the
// passthrough grace period. Targeting it later with an explicit tabId
// promotes it to a full agent tab.
async function activeTabId(ctx) {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("No active tab");
  touchTab(ctx, t.id);
  markFallbackTab(t.id, t.url);
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

async function ensureContent(tabId, frameId = 0, retries = 4, signal) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    throwIfAborted(signal);
    try {
      await chrome.tabs.sendMessage(tabId, { __mcp: 1, cmd: "__ping", payload: {} }, { frameId });
      return;
    } catch (e) {
      lastErr = e;
    }
    throwIfAborted(signal);
    // missing, or waking from bfcache: inject and wait a bit
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
    } catch (e) {
      lastErr = e;
    }
    await abortableSleep(400 * (i + 1), signal);
  }
  throw lastErr || new Error("Could not install content script");
}

// One content-script round trip to one frame. Every message carries a unique
// cmdId; on cancellation (signal) or timeout the frame gets
// { __mcp:1, cmd:"__cancel", payload:{ cmdId } } so long content work
// (page_wait, dom_type with a delay) stops as well.
let contentCmdSeq = 0;
async function contentRequest(tabId, frameId, cmd, payload, waitMs, signal) {
  throwIfAborted(signal);
  const cmdId = `c${Date.now().toString(36)}-${++contentCmdSeq}`;
  const cancelInContent = () => {
    try {
      Promise.resolve(chrome.tabs.sendMessage(tabId, { __mcp: 1, cmd: "__cancel", payload: { cmdId } }, { frameId })).catch(() => {});
    } catch {}
  };
  let timer = null;
  let onAbort = null;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancelInContent();
      reject(new Error(`Content did not respond (${cmd})`));
    }, waitMs);
    if (signal) {
      onAbort = () => {
        cancelInContent();
        reject(cancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([chrome.tabs.sendMessage(tabId, { __mcp: 1, cmd, payload, cmdId }, { frameId }), stop]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// Sends one command to ONE frame (the focused frame, else the main frame).
// timeoutMs = the server-side timeout of the command (ctx.timeoutMs); the
// content budget stays below it. Without it the budget is 25 s. ctx (the
// command context) supplies the cancel signal and the fallback bookkeeping.
async function toContent(tabId, cmd, payload, timeoutMs, ctx) {
  const signal = ctx && ctx.signal;
  const started = Date.now();
  const id = tabId ?? (await activeTabId(ctx));
  const frameId = await resolveStickyFrame(id);
  await ensureContent(id, frameId, undefined, signal);
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const budget = hasDeadline ? Math.max(5000, timeoutMs - 1500) : 25000;
  const wait = hasDeadline ? Math.max(2000, budget - (Date.now() - started)) : budget;
  const value = await contentRequest(id, frameId, cmd, payload, wait, signal);
  return { tabId: id, frameId, value };
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
    const msg = String((e && e.message) || e);
    if (/URL of different extension/i.test(msg)) {
      // Chrome refuses to debug a page that shows a frame of another extension
      // (password managers and security software inject such overlays).
      throw new Error(
        `Chrome refused to attach the debugger to tab ${tabId}: the page contains a frame of another extension (a password manager or security-software overlay, for example). Close that overlay or reload the tab, then try again. (${capStr(msg, 200)})`
      );
    }
    if (!/already attached/i.test(msg)) throw e;
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

// Persistent holder (key: "mock" | "emulation" | "throttle" | "headers" | "perf").
// Idempotent per key. Returns the debuggee { tabId }.
async function acquireDebugger(tabId, key) {
  await dbgSerial(tabId, async (st) => {
    await dbgEnsureAttached(tabId, st);
    st.holders.add(String(key));
  });
  saveDebugTabs();
  return { tabId };
}

// Drops a persistent holder; detaches when no holder remains.
async function releaseDebugger(tabId, key) {
  await dbgSerial(tabId, async (st) => {
    st.holders.delete(String(key));
    await dbgMaybeDetach(tabId, st);
  });
  saveDebugTabs();
}

function hasDebuggerHolder(tabId, key) {
  const st = dbgTabs.get(tabId);
  return !!(st && st.attached && st.holders.has(String(key)));
}

// ---------- debugger-backed sessions: one registry, one teardown ----------
// Every persistent CDP state the agent can leave on a tab registers here:
// its per-tab state map, the persistent debugger holder it keeps, the actions
// that control it and clear(dbg, state, tabId), which resets the CDP state.
// Wave-2 emulation_* state plugs in with registerDebugSession (holder
// "emulation" may be shared: the holder is released only when no kind using
// it has state on the tab any more). Teardown runs when a controlling action
// is disabled (setDisabled), once the bridge has been down for
// SESSION_TEARDOWN_MS, and from the stop / clear actions themselves; nothing
// is re-armed after a worker restart without a paired bridge (pendingRestore).
const debugSessionKinds = new Map(); // name -> { name, holder, actions, sessions, clear, onChange }

function registerDebugSession(name, def) {
  debugSessionKinds.set(String(name), {
    name: String(name),
    holder: String(def.holder),
    actions: Array.isArray(def.actions) ? def.actions.slice() : [],
    sessions: def.sessions,
    clear: def.clear,
    onChange: def.onChange,
  });
}

async function releaseHolderIfUnused(tabId, holder) {
  for (const k of debugSessionKinds.values()) if (k.holder === holder && k.sessions.has(tabId)) return;
  await releaseDebugger(tabId, holder);
}

// Clears one kind's state on one tab. Resolves true when there was state.
async function teardownDebugSession(name, tabId) {
  const k = debugSessionKinds.get(name);
  if (!k || !Number.isInteger(tabId)) return false;
  const state = k.sessions.get(tabId);
  // A held holder without state counts only when no other kind sharing it
  // has state on the tab (a leftover of this kind, not someone else's).
  let shared = false;
  for (const o of debugSessionKinds.values()) if (o !== k && o.holder === k.holder && o.sessions.has(tabId)) shared = true;
  const had = k.sessions.has(tabId) || (!shared && hasDebuggerHolder(tabId, k.holder));
  // Dropped first: debugger events stop using it while the reset runs.
  k.sessions.delete(tabId);
  if (had && typeof k.clear === "function") {
    try {
      await k.clear({ tabId }, state, tabId);
    } catch {}
  }
  if (typeof k.onChange === "function") {
    try {
      k.onChange();
    } catch {}
  }
  await releaseHolderIfUnused(tabId, k.holder).catch(() => {});
  return had;
}

// Every tab of every kind matching `match` (all kinds without it), including
// a held holder whose state entry is missing.
async function teardownDebugSessions(match) {
  const jobs = [];
  for (const k of debugSessionKinds.values()) {
    if (match && !match(k)) continue;
    const tabs = new Set(k.sessions.keys());
    for (const [tabId, st] of dbgTabs) if (st.holders.has(k.holder)) tabs.add(tabId);
    for (const tabId of tabs) jobs.push(teardownDebugSession(k.name, tabId));
  }
  await Promise.all(jobs);
}

// One tab, every kind matching `match` (all without it), one after the other;
// resolves the names that had state. emulation_reset (wave 2):
// teardownTabDebugSessions(tabId, (k) => k.holder === "emulation").
async function teardownTabDebugSessions(tabId, match) {
  const cleared = [];
  for (const k of Array.from(debugSessionKinds.values())) {
    if (match && !match(k)) continue;
    if (await teardownDebugSession(k.name, tabId)) cleared.push(k.name);
  }
  return cleared;
}

// Drops every kind's state of a tab whose debugger session is gone (tab
// closed, external detach); no CDP call is possible any more.
function forgetDebugSessions(tabId) {
  for (const k of debugSessionKinds.values()) {
    if (k.sessions.delete(tabId) && typeof k.onChange === "function") {
      try {
        k.onChange();
      } catch {}
    }
  }
}

registerDebugSession("mock", {
  holder: "mock",
  actions: ["network_mock_start", "network_mock_route"],
  sessions: fetchSessions,
  clear: (dbg) => cdpSend(dbg, "Fetch.disable", {}),
  onChange: () => saveMockSessions(),
});
registerDebugSession("throttle", {
  holder: "throttle",
  actions: ["network_throttle"],
  sessions: throttleSessions,
  clear: (dbg) => cdpSend(dbg, "Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
});
registerDebugSession("headers", {
  holder: "headers",
  actions: ["network_set_headers"],
  sessions: headerSessions,
  clear: (dbg) => cdpSend(dbg, "Network.setExtraHTTPHeaders", { headers: {} }),
});
registerDebugSession("geolocation", {
  holder: "emulation",
  actions: ["emulation_geolocation"],
  sessions: emulationSessions,
  clear: (dbg) => cdpSend(dbg, "Emulation.clearGeolocationOverride", {}),
});
registerDebugSession("viewport", {
  holder: "emulation",
  actions: ["emulation_viewport"],
  sessions: viewportSessions,
  clear: (dbg) =>
    cdpSendEach(dbg, [
      ["Emulation.clearDeviceMetricsOverride", {}],
      ["Emulation.setTouchEmulationEnabled", { enabled: false }],
    ]),
});
registerDebugSession("media", {
  holder: "emulation",
  actions: ["emulation_media"],
  sessions: mediaSessions,
  clear: (dbg) => cdpSend(dbg, "Emulation.setEmulatedMedia", { media: "", features: [] }),
});
registerDebugSession("cpu", {
  holder: "emulation",
  actions: ["emulation_cpu"],
  sessions: cpuSessions,
  clear: (dbg) => cdpSend(dbg, "Emulation.setCPUThrottlingRate", { rate: 1 }),
});
// A running trace: ending it on teardown discards the data (no collector
// listens any more); perf_trace_stop is the only way to keep a trace.
registerDebugSession("trace", {
  holder: "perf",
  actions: ["perf_trace_start", "perf_trace_stop"],
  sessions: traceSessions,
  clear: (dbg) => cdpSend(dbg, "Tracing.end", {}),
  onChange: () => onTraceSessionsChanged(),
});

// ---------- worker restart: parked sessions ----------
// The previous worker's mock sessions (storage.session "mcpMock") and the tabs
// that held a persistent debugger session ("mcpDbgTabs") are parked here until
// a paired bridge is back (resumeDebugSessions re-arms allowed mock sessions)
// or the bridge-down deadline passes (discardPendingRestore). Either way a
// surviving attach this worker does not use is detached, which ends any
// leftover throttle / header / emulation override with it.
let pendingRestore = null; // { mock: [{ tabId, routes }], tabs: [tabId] }

async function saveMockSessions() {
  const list = Array.from(fetchSessions.entries()).map(([tabId, s]) => ({ tabId, routes: s.routes }));
  if (pendingRestore) for (const s of pendingRestore.mock) if (s && !fetchSessions.has(s.tabId)) list.push(s);
  try {
    await chrome.storage.session.set({ mcpMock: list });
  } catch {}
}

function saveDebugTabs() {
  const tabs = [];
  for (const [tabId, st] of dbgTabs) if (st.holders.size) tabs.push(tabId);
  if (pendingRestore) for (const id of pendingRestore.tabs) if (!tabs.includes(id)) tabs.push(id);
  try {
    Promise.resolve(chrome.storage.session.set({ mcpDbgTabs: tabs })).catch(() => {});
  } catch {}
}

// Detaches an attach that survived a worker restart, unless this worker uses it.
function detachLeftover(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  chrome.tabs.get(tabId).then(
    () =>
      dbgSerial(tabId, async (st) => {
        if (st.attached || st.transient > 0 || st.holders.size > 0) return;
        try {
          await chrome.debugger.detach({ tabId });
        } catch {}
      }).catch(() => {}),
    () => {}
  );
}

const debugRestoreReady = (async () => {
  let mock = [];
  let tabs = [];
  let downAt = NaN;
  try {
    const got = await chrome.storage.session.get(["mcpMock", "mcpDbgTabs", "mcpBridgeDownAt"]);
    mock = Array.isArray(got && got.mcpMock) ? got.mcpMock.filter((s) => s && Number.isInteger(s.tabId)) : [];
    tabs = Array.isArray(got && got.mcpDbgTabs) ? got.mcpDbgTabs.filter((t) => Number.isInteger(t)) : [];
    downAt = Number(got && got.mcpBridgeDownAt);
  } catch {}
  if (!mock.length && !tabs.length) return;
  pendingRestore = { mock, tabs };
  if (bridgePaired()) return; // onBridgeUp -> resumeDebugSessions takes over
  // Down since the last recorded moment, or since now (the old worker died
  // while the bridge was up).
  if (!Number.isFinite(downAt) || downAt <= 0 || downAt > Date.now()) {
    downAt = Date.now();
    setBridgeDownAt(downAt);
  }
  armSessionTeardown(downAt + SESSION_TEARDOWN_MS - Date.now());
})();

function discardPendingRestore() {
  const p = pendingRestore;
  if (!p) return;
  pendingRestore = null;
  saveMockSessions();
  saveDebugTabs();
  for (const tabId of new Set([...p.tabs, ...p.mock.map((s) => s.tabId)])) detachLeftover(tabId);
}

// Paired bridge back: re-arm the parked mock sessions whose controlling
// actions are still enabled; everything else parked is dropped.
async function resumeDebugSessions() {
  await debugRestoreReady;
  await permsReady;
  const p = pendingRestore;
  if (!p || !bridgePaired()) return;
  pendingRestore = null;
  let live = new Set();
  try {
    live = new Set((await chrome.tabs.query({})).map((t) => t.id));
  } catch {}
  const mockKind = debugSessionKinds.get("mock");
  const allowed = mockKind.actions.every((a) => isAllowed(a));
  const restored = new Set();
  for (const s of allowed ? p.mock : []) {
    if (!live.has(s.tabId) || fetchSessions.has(s.tabId)) continue;
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
      restored.add(s.tabId);
    } catch {
      fetchSessions.delete(s.tabId);
      try {
        await releaseHolderIfUnused(s.tabId, "mock");
      } catch {}
    }
  }
  saveMockSessions();
  saveDebugTabs();
  for (const tabId of new Set([...p.tabs, ...p.mock.map((s) => s.tabId)])) {
    if (!restored.has(tabId) && live.has(tabId)) detachLeftover(tabId);
  }
}

function cdpSend(dbg, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(dbg, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// Runs every [method, params] even when an earlier one fails (teardown:
// reset as much as possible); rejects with the first error afterwards.
async function cdpSendEach(dbg, calls) {
  let first = null;
  for (const [method, params] of calls) {
    try {
      await cdpSend(dbg, method, params);
    } catch (e) {
      if (!first) first = e;
    }
  }
  if (first) throw first;
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

// ---------- in-flight requests per tab (page_wait networkIdle) ----------
// Counts only (no URLs, nothing streamed), independent of network capture,
// its permission and its buffers, so it is always on. Not counted:
// - requests outside a tab (tabId -1: service / shared workers, the
//   extension itself) and requests of prerendering documents;
// - WebSockets (type "websocket") and responses that turn out to be streams
//   (Content-Type text/event-stream = EventSource, multipart/x-mixed-replace);
// - anything in flight for longer than NET_LONG_LIVED_MS (long-polling, hung
//   requests, a completion event that never came).
// Media and download streams still count: maxInflight absorbs them. A
// service-worker restart forgets the requests already in flight (undercount).
const NET_LONG_LIVED_MS = 60000;
const NET_MAX_PER_TAB = 2000;
const netInflight = new Map(); // tabId -> Map<requestId, startedAt ms>
const netWaiters = new Map(); // tabId -> Set<(gone?: boolean) => void>

function netNotify(tabId, gone) {
  const set = netWaiters.get(tabId);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn(gone);
    } catch {}
  }
}

function netStart(d) {
  if (!d || !Number.isInteger(d.tabId) || d.tabId < 0 || d.type === "websocket") return;
  if (d.documentLifecycle === "prerender") return;
  let m = netInflight.get(d.tabId);
  if (!m) netInflight.set(d.tabId, (m = new Map()));
  const id = String(d.requestId);
  // A redirect fires onBeforeRequest again with the same id: keep its start.
  if (m.has(id)) return;
  m.set(id, Date.now());
  if (m.size > NET_MAX_PER_TAB) m.delete(m.keys().next().value);
  netNotify(d.tabId);
}

function netEnd(d) {
  if (!d) return;
  const m = netInflight.get(d.tabId);
  if (!m || !m.delete(String(d.requestId))) return;
  if (!m.size) netInflight.delete(d.tabId);
  netNotify(d.tabId);
}

// In-flight requests of a tab, the long-lived ones excluded.
function netCount(tabId, now) {
  const m = netInflight.get(tabId);
  if (!m) return 0;
  let n = 0;
  for (const t of m.values()) if (now - t < NET_LONG_LIVED_MS) n++;
  return n;
}

chrome.webRequest.onBeforeRequest.addListener(netStart, { urls: ["<all_urls>"] });
chrome.webRequest.onCompleted.addListener(netEnd, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(netEnd, { urls: ["<all_urls>"] });
// The same request goes on after a redirect, unless it leaves the schemes
// webRequest reports (data:, blob:, extension pages): then it ends here.
if (chrome.webRequest.onBeforeRedirect) {
  chrome.webRequest.onBeforeRedirect.addListener(
    (d) => {
      if (!/^(?:https?|wss?|ftp|file):/i.test(String((d && d.redirectUrl) || ""))) netEnd(d);
    },
    { urls: ["<all_urls>"] }
  );
}
if (chrome.webRequest.onResponseStarted) {
  chrome.webRequest.onResponseStarted.addListener(
    (d) => {
      const h = ((d && d.responseHeaders) || []).find((x) => x && String(x.name).toLowerCase() === "content-type");
      if (h && /^\s*(?:text\/event-stream|multipart\/x-mixed-replace)/i.test(String(h.value || ""))) netEnd(d);
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
}
chrome.tabs.onRemoved.addListener((tabId) => {
  netInflight.delete(tabId);
  netNotify(tabId, true);
});

// Resolves { inflight } once the tab has had <= maxInflight requests in
// flight for idleMs without a break; rejects at the deadline, on cancel and
// when the tab closes. Every start / end re-checks, so a short request
// between two polls still restarts the quiet period.
function netWaitIdle(tabId, idleMs, maxInflight, deadline, signal, t0) {
  return new Promise((resolve, reject) => {
    let quietSince = null;
    let done = false;
    let timer = null;
    let onAbort = null;
    let set = netWaiters.get(tabId);
    if (!set) netWaiters.set(tabId, (set = new Set()));
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      set.delete(check);
      if (!set.size && netWaiters.get(tabId) === set) netWaiters.delete(tabId);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      fn(v);
    };
    function check(gone) {
      if (done) return;
      if (gone) {
        finish(reject, new Error(`Tab ${tabId} was closed while waiting for the network to go idle`));
        return;
      }
      const now = Date.now();
      const n = netCount(tabId, now);
      if (n > maxInflight) quietSince = null;
      else if (quietSince === null) quietSince = now;
      if (quietSince !== null && now - quietSince >= idleMs) {
        finish(resolve, { inflight: n });
      } else if (now >= deadline) {
        finish(
          reject,
          new Error(
            `Timed out: the network never stayed idle (at most ${maxInflight} request(s) in flight for ${idleMs} ms) (after ${now - t0} ms; ${n} request(s) in flight now)`
          )
        );
      }
    }
    if (signal) {
      if (signal.aborted) {
        finish(reject, cancelledError());
        return;
      }
      onAbort = () => finish(reject, cancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
    set.add(check);
    timer = setInterval(check, 50);
    check();
  });
}

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

// Spy data (request records with POST bodies, response bodies) is recorded
// only while network_bodies (and the network_requests it requires) is allowed
// and a paired bridge is connected; mock routes keep applying regardless.
function spyCaptureAllowed() {
  return permsLoaded && bridgePaired() && isAllowed("network_bodies") && isAllowed("network_requests");
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
    if (meta && meta.url && !meta.url.startsWith("data:") && spyCaptureAllowed()) {
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
    if (spyCaptureAllowed()) {
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
    }
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
  forgetDebugSessions(tabId);
  saveDebugTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetDebugSessions(tabId);
  const hadDbg = dbgTabs.delete(tabId);
  eventRate.delete(tabId);
  tabTouch.delete(tabId);
  if (hadDbg) saveDebugTabs();
  const a = agentTabs.delete(tabId);
  const b = stickyFrames.delete(tabId);
  const c = fallbackTabs.delete(tabId);
  if (a || b || c) saveSessionState();
});

// Prerender / instant swaps replace the tab id: keep agent (or fallback) status.
if (chrome.tabs.onReplaced) {
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    stickyFrames.delete(removedTabId);
    const fallbackOrigin = fallbackTabs.get(removedTabId);
    const wasFallback = fallbackTabs.delete(removedTabId);
    if (agentTabs.delete(removedTabId)) {
      agentTabs.add(addedTabId);
      saveSessionState();
      installPageHooks(addedTabId);
    } else if (wasFallback) {
      if (!agentTabs.has(addedTabId)) fallbackTabs.set(addedTabId, fallbackOrigin);
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
  { id: "emulation", title: "Emulation", actions: ["emulation_geolocation", "emulation_geolocation_clear", "emulation_viewport", "emulation_media", "emulation_cpu", "emulation_reset"] },
  { id: "performance", title: "Performance", actions: ["page_metrics", "perf_web_vitals", "perf_trace_start", "perf_trace_stop", "perf_trace_chunk"] },
  { id: "system", title: "System", actions: ["permissions_grant", "history_search", "history_delete"] },
];
const PERM_ALL = PERM_CATS.flatMap((c) => c.actions);
const PERM_ALL_SET = new Set(PERM_ALL);

// Routed actions outside the catalog. The gate in handleCommand is an
// allow-list: an action that is neither in PERM_ALL (after normalizeAction)
// nor here is refused, so a handler added without a catalog entry can never
// bypass the popup switches. perm_list / perm_set manage the switches
// themselves and skip the permission check (UNGATED_ACTIONS); tab_list is the
// MCP tool name of tabs_list and is gated as tabs_list. (__ping / __cancel are
// content-script commands, never bridge actions.)
const INTERNAL_ACTIONS = new Set(["perm_list", "perm_set", "tab_list"]);
const UNGATED_ACTIONS = new Set(["perm_list", "perm_set"]);

// The action catalog of 0.3.5, the last release that did not store
// mcpKnownActions: an upgrade from it treats exactly these as known.
const KNOWN_ACTIONS_0_3_5 = [
  "tabs_list", "tab_create", "tab_duplicate", "tab_close", "tab_activate", "tab_navigate", "tab_reload", "tab_back",
  "tab_forward", "tab_pin", "tab_mute", "window_list", "window_create", "window_focus", "browser_close", "frame_list",
  "frame_focus", "frame_clear", "tab_group_create", "tab_group_list", "tab_group_update", "tab_group_ungroup",
  "page_snapshot", "page_html", "page_text", "dom_query", "page_find", "page_wait", "page_axtree", "dom_click",
  "dom_type", "dom_fill", "dom_select", "dom_check", "dom_hover", "dom_focus", "dom_scroll", "dom_drag", "dom_upload",
  "keyboard_press", "page_screenshot", "page_pdf", "tab_audio_record_start", "tab_audio_record_stop", "console_get",
  "console_clear", "network_requests", "network_clear", "network_response_body", "network_bodies", "network_throttle",
  "network_set_headers", "har_export", "network_mock_start", "network_mock_stop", "network_mock_route",
  "network_mock_list", "network_mock_remove", "network_mock_clear", "downloads_list", "downloads_pause",
  "downloads_resume", "downloads_cancel", "downloads_erase", "bookmarks_search", "bookmarks_list", "bookmarks_add",
  "bookmarks_remove", "cookies_list", "cookies_get", "cookies_set", "cookies_delete", "cookies_clear",
  "cookies_export", "cookies_import", "storage_get", "storage_set", "idb_list", "idb_stores", "idb_read", "idb_count",
  "idb_put", "idb_delete", "idb_clear", "sessions_recently_closed", "sessions_restore", "session_state_save",
  "session_state_load", "dialog_policy", "dialog_get", "dialog_clear", "js_evaluate", "cdp_send", "trusted_click",
  "trusted_type", "trusted_key", "trusted_scroll", "trusted_drag", "clipboard_read", "clipboard_write",
  "browsing_data_clear", "notification_create", "notification_clear", "page_metrics", "permissions_grant",
  "emulation_geolocation", "emulation_geolocation_clear", "history_search", "history_delete",
];

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

// Disabled actions (default: all enabled). Persisted in chrome.storage.local
// "mcpDisabled", next to "mcpKnownActions" (the catalog the user last saw).
let disabledActions = new Set();
let permsLoaded = false;
// Actions the agent switched off itself (bridge perm_set) that the user has
// not switched since: the popup marks them "off by agent". Always a subset of
// disabledActions. Persisted in chrome.storage.local "mcpAgentDisabled"
// (written together with mcpDisabled by savePerms); the in-memory set is
// authoritative, a foreign write to the key is overwritten.
let agentDisabledActions = new Set();

async function loadPerms() {
  try {
    const got = await chrome.storage.local.get(["mcpDisabled", "mcpKnownActions", "mcpAgentDisabled"]);
    const arr = got && got.mcpDisabled;
    const next = new Set(Array.isArray(arr) ? arr.filter((a) => PERM_ALL_SET.has(a)) : []);
    const storedKnown = got && got.mcpKnownActions;
    const known = new Set(Array.isArray(storedKnown) ? storedKnown.filter((a) => typeof a === "string") : KNOWN_ACTIONS_0_3_5);
    // Actions new since the last run start disabled when the user had
    // switched off every previously known action of their category (a
    // category turned off stays off after an update adds to it).
    let added = false;
    for (const c of PERM_CATS) {
      const prev = c.actions.filter((a) => known.has(a));
      const fresh = c.actions.filter((a) => !known.has(a));
      if (!prev.length || !fresh.length || !prev.every((a) => next.has(a))) continue;
      for (const a of fresh) next.add(a);
      added = true;
    }
    disabledActions = next;
    const agentArr = got && got.mcpAgentDisabled;
    agentDisabledActions = new Set(Array.isArray(agentArr) ? agentArr.filter((a) => PERM_ALL_SET.has(a) && next.has(a)) : []);
    const knownChanged = !Array.isArray(storedKnown) || storedKnown.length !== PERM_ALL.length || PERM_ALL.some((a) => !known.has(a));
    if (added || knownChanged) {
      // One write: the new disabled set never lands without the catalog it was computed for.
      const write = { mcpKnownActions: PERM_ALL.slice() };
      if (added) {
        write.mcpDisabled = Array.from(next);
        noteOwnPermWrite(write.mcpDisabled);
      }
      await chrome.storage.local.set(write);
    }
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

function noteOwnPermWrite(v) {
  const now = Date.now();
  pruneOwnPermWrites(now);
  ownPermWrites.push({ key: JSON.stringify(v), at: now });
}

async function savePerms() {
  const v = Array.from(disabledActions);
  noteOwnPermWrite(v);
  try {
    // One write: a popup reacting to the mcpDisabled change reads the matching agent set.
    await chrome.storage.local.set({ mcpDisabled: v, mcpAgentDisabled: Array.from(agentDisabledActions) });
  } catch {}
}

// Re-asserts the in-memory agent-disabled set over a foreign storage write.
function saveAgentDisabled() {
  try {
    Promise.resolve(chrome.storage.local.set({ mcpAgentDisabled: Array.from(agentDisabledActions) })).catch(() => {});
  } catch {}
}

function sameActionList(raw, set) {
  if (!Array.isArray(raw)) return false;
  const s = new Set(raw);
  return s.size === raw.length && s.size === set.size && raw.every((a) => set.has(a));
}

function isAllowed(action) {
  return !disabledActions.has(normalizeAction(action));
}

// Single entry point for permission changes: emits a `perms` event,
// refreshes the agent-tab hooks whenever the set actually changes, and tears
// down the debugger-backed sessions whose controlling action was just
// switched off (an offline throttle or a block route must not outlive it).
function setDisabled(next, persist) {
  const newlyOff = new Set(Array.from(next).filter((a) => !disabledActions.has(a)));
  const changed = next.size !== disabledActions.size || newlyOff.size > 0;
  disabledActions = next;
  // An action switched back on is no longer "off by agent".
  for (const a of agentDisabledActions) if (!next.has(a)) agentDisabledActions.delete(a);
  if (persist) savePerms();
  if (changed) {
    sendPermsEvent();
    refreshAgentHooks();
  }
  if (newlyOff.size) {
    teardownDebugSessions((k) => k.actions.some((a) => newlyOff.has(a))).catch(() => {});
  }
  if (newlyOff.has("tab_audio_record_start") || newlyOff.has("tab_audio_record_stop")) {
    discardAudioRecordings().catch(() => {});
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
    // mcpAgentDisabled: only this worker writes it. Our own echoes match
    // the in-memory set (or an older one of ours, then re-saving is a no-op);
    // anything else is overwritten.
    if (changes.mcpAgentDisabled && permsLoaded && !sameActionList(changes.mcpAgentDisabled.newValue, agentDisabledActions)) {
      saveAgentDisabled();
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
// Hooks live only in the main frame of agent tabs; fallback tabs carry only
// the console hook, so dialog entries from them are dropped.
function onPageEvent(type, entry, sender) {
  if (!permsLoaded || !stateLoaded) return;
  const tabId = sender.tab.id;
  const full = agentTabs.has(tabId);
  if (sender.frameId !== 0 || !(full || fallbackTabs.has(tabId))) return;
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
  if (!full || !eventAllowed("dialog") || !DIALOG_KINDS.has(entry.kind)) return;
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

// Popup status lists (mcp-status).
const STATUS_MAX_RUNNING = 10;
const STATUS_MAX_AGENT_TABS = 20;

// Running bridge commands, newest first.
function runningPayload() {
  return Array.from(runningCmds.values())
    .reverse()
    .slice(0, STATUS_MAX_RUNNING)
    .map((e) => ({
      id: capStr(e.id, 64),
      action: capStr(e.action, 64),
      tabId: Number.isInteger(e.tabId) ? e.tabId : null,
      host: typeof e.host === "string" ? e.host : "",
      startedAt: e.startedAt,
    }));
}

// Agent tabs (not the fallback tabs) that still exist.
async function agentTabsPayload() {
  const ids = Array.from(agentTabs).slice(-STATUS_MAX_AGENT_TABS);
  const tabs = await Promise.all(ids.map((id) => Promise.resolve().then(() => chrome.tabs.get(id)).catch(() => null)));
  return tabs
    .filter((t) => t && Number.isInteger(t.id))
    .map((t) => ({
      id: t.id,
      windowId: t.windowId,
      title: capStr(t.title || "", 120),
      host: urlHostname(t.url || t.pendingUrl),
      active: !!t.active,
    }));
}

function statusPayload(t, agentTabList) {
  const connected = bridgeOpen();
  return {
    bridgeConnected: connected,
    port: currentPort,
    activeTab: t ? { id: t.id, title: t.title || "Untitled", url: t.url || "" } : null,
    extensionId: chrome.runtime.id,
    paired: connected && paired,
    lastClose,
    pairState,
    serverVersion: serverInfo.version,
    serverProtocol: serverInfo.protocol,
    serverPid: serverInfo.pid,
    hasKey: !!pairing.key,
    running: runningPayload(),
    agentTabs: Array.isArray(agentTabList) ? agentTabList : [],
  };
}

const PRIVILEGED_MSGS = new Set([
  "mcp-status",
  "mcp-history-get",
  "mcp-history-clear",
  "mcp-port-get",
  "mcp-port-set",
  "mcp-perms-get",
  "mcp-perms-set",
  "mcp-repair",
  "mcp-forget-pairing",
  "mcp-stop-all",
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
  if (msg.type === "mcp-console" || msg.type === "mcp-dialog") {
    if (isOwnContentScript(sender)) onPageEvent(msg.type, msg.entry, sender);
    return false;
  }
  if (!PRIVILEGED_MSGS.has(msg.type) || !isExtensionPage(sender)) return false;
  if (msg.type === "mcp-status") {
    pairingReady
      .catch(() => {})
      .then(() => stateReady)
      .then(() =>
        Promise.all([
          chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t, () => null),
          agentTabsPayload().catch(() => []),
        ])
      )
      .then(([t, tabs]) => sendResponse(statusPayload(t, tabs)))
      .catch(() => sendResponse(statusPayload(null, [])));
    return true;
  }
  if (msg.type === "mcp-repair") {
    // Re-pair: the next "pair" offer within 2 minutes replaces the stored
    // key; reconnect now so a waiting server makes the offer at once.
    pairingReady
      .catch(() => {})
      .then(() => {
        setAcceptPairUntil(Date.now() + ACCEPT_PAIR_MS);
        reconnectNow();
        sendResponse({ ok: true });
      });
    return true;
  }
  if (msg.type === "mcp-forget-pairing") {
    // Deletes the key (the installId stays) and reconnects.
    pairingReady
      .catch(() => {})
      .then(async () => {
        pairing = { installId: pairing.installId, key: null };
        try {
          await savePairing();
        } catch {}
        reconnectNow();
        sendResponse({ ok: true });
      });
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
    permsReady.then(() =>
      sendResponse({
        cats: PERM_CATS,
        disabled: Array.from(disabledActions),
        requires: REQUIRES,
        agentDisabled: Array.from(agentDisabledActions),
      })
    );
    return true;
  }
  if (msg.type === "mcp-perms-set") {
    // {action, enabled} single delta or {actions:{name:bool}} (only the changed ones)
    permsReady.then(() => {
      const next = new Set(disabledActions);
      // Every action the user names (on or off) is the user's choice from now on.
      if (typeof msg.action === "string" && PERM_ALL.includes(msg.action)) {
        if (msg.enabled) next.delete(msg.action);
        else next.add(msg.action);
        agentDisabledActions.delete(msg.action);
      }
      if (msg.actions && typeof msg.actions === "object") {
        for (const [a, on] of Object.entries(msg.actions)) {
          if (!PERM_ALL.includes(a)) continue;
          if (on) next.delete(a);
          else next.add(a);
          agentDisabledActions.delete(a);
        }
      }
      setDisabled(next, true);
      sendResponse({ ok: true, disabled: Array.from(disabledActions), agentDisabled: Array.from(agentDisabledActions) });
    });
    return true;
  }
  if (msg.type === "mcp-stop-all") {
    // Emergency stop: every switch off (debugger-backed sessions are torn
    // down by setDisabled), the agent marks cleared (the user decided), and
    // every running command aborted (it answers "cancelled"). Switching off
    // first means no new command passes the gate meanwhile.
    permsReady.then(() => {
      agentDisabledActions.clear();
      setDisabled(new Set(PERM_ALL), true);
      let cancelled = 0;
      for (const e of Array.from(runningCmds.values())) {
        if (e.ac.signal.aborted) continue;
        e.ac.abort();
        cancelled++;
      }
      sendResponse({ ok: true, cancelled, disabled: Array.from(disabledActions) });
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
async function bg2bTopFrameSend(tabId, cmd, payload, deadline, signal) {
  const wait = Math.max(2000, deadline - Date.now());
  const value = await contentRequest(tabId, 0, cmd, payload, wait, signal);
  return { tabId, frameId: 0, value };
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

// permissions_grant: content-setting values the tool may set.
const PERMISSION_SETTINGS = new Set(["allow", "block", "ask"]);

// One exact http(s) origin ("https://example.com", "http://localhost:3000"),
// or "" for anything else: wildcards, patterns, paths, userinfo, other schemes
// and non-canonical spellings all fail new URL(o).origin === o.
function exactHttpOrigin(o) {
  if (typeof o !== "string" || !o || o.includes("*")) return "";
  try {
    const u = new URL(o);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin === o ? o : "";
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

// A recording must not outlive its switches: once tab_audio_record_start or
// tab_audio_record_stop is off (the popup's Stop agent switches everything
// off), every recording in the offscreen document is released, which stops
// the recorder, frees the capture stream and drops the data, so switching
// them on again cannot hand the agent audio captured meanwhile. A start in
// flight checks audioDiscards when it returns. No document: nothing records.
let audioDiscards = 0;
async function discardAudioRecordings() {
  audioDiscards++;
  const off = chrome.offscreen;
  try {
    if (!off || (off.hasDocument && !(await off.hasDocument()))) return;
  } catch {
    return;
  }
  let list = null;
  try {
    list = await chrome.runtime.sendMessage({ type: "mcp-offscreen-audio-list" });
  } catch {}
  if (!list || !list.ok) return;
  // tabIds: recording or not retrieved yet; recordings: every entry kept.
  const ids = new Set(Array.isArray(list.tabIds) ? list.tabIds : []);
  for (const r of Array.isArray(list.recordings) ? list.recordings : []) if (r) ids.add(r.tabId);
  await Promise.all(
    Array.from(ids)
      .filter((id) => Number.isInteger(id))
      .map(async (tabId) => {
        try {
          await chrome.runtime.sendMessage({ type: "mcp-offscreen-audio-release", tabId });
        } catch {}
      })
  );
}

// ---------- BG2a helpers: URLs, page_wait, trusted input, keys, AX tree, clipboard ----------
const bg2aSleep = (ms, signal) => abortableSleep(ms, signal);
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
// navigation tears the old one down mid-wait. networkIdle is tracked here
// (netWaitIdle). Every given condition must hold at the same time: after the
// network went idle the URL / DOM conditions are checked once more, and the
// wait starts over when one of them no longer holds. A pure duration wait
// sleeps here. ctx.signal (cancel) stops every sleep and the content wait.
async function bg2aPageWait(tabId, payload, ctx) {
  const signal = ctx && ctx.signal;
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
  const net = bg2cNetIdleSpec(payload);
  const urlSub = payload.url ? String(payload.url) : "";
  const navCond = !!(urlSub || re || rs);
  const domCond = !!(payload.selector || payload.text);
  let lastUrl = "";
  const timedOut = () =>
    new Error(`Timed out: expected condition never appeared (after ${Date.now() - t0} ms)${lastUrl ? `; current URL: ${capStr(lastUrl, 300)}` : ""}`);
  if (!navCond && !domCond && !net) {
    await bg2aSleep(Math.max(0, deadline - Date.now()), signal);
    return { tabId, ok: true, waitedMs: Date.now() - t0 };
  }
  const navOk = async () => {
    const st = await bg2aTabState(tabId, rs);
    lastUrl = st.url;
    const ok =
      (!urlSub || st.url.includes(urlSub)) &&
      (!re || re.test(st.url)) &&
      (!rs || BG2A_READY_RANK[st.ready] >= BG2A_READY_RANK[rs]);
    return ok ? st.url : null;
  };
  for (;;) {
    throwIfAborted(signal);
    let url = null;
    if (navCond) {
      url = await navOk();
      if (url === null) {
        if (Date.now() >= deadline) throw timedOut();
        await bg2aSleep(Math.min(150, Math.max(0, deadline - Date.now())), signal);
        continue;
      }
      if (!domCond && !net) return { tabId, ok: true, waitedMs: Date.now() - t0, url };
    }
    let dom = null;
    if (domCond) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timedOut();
      try {
        const r = await toContent(
          tabId,
          "page_wait",
          { selector: payload.selector, text: payload.text, timeoutMs: Math.max(1, remaining) },
          remaining + 3000,
          ctx
        );
        const v = unwrap(r);
        dom = v && typeof v === "object" ? v : {};
      } catch (e) {
        throwIfAborted(signal);
        if (/^Timed out/.test(String(e && e.message))) throw timedOut();
        if (!bg2aIsNavError(e) || deadline - Date.now() < 250) throw e;
        await bg2aSleep(250, signal); // let the next document commit, then wait on it
        continue;
      }
      if (!net) return Object.assign({ tabId }, dom, { ok: true, waitedMs: Date.now() - t0 });
    }
    const idle = await netWaitIdle(tabId, net.idleMs, net.maxInflight, deadline, signal, t0);
    // The other conditions must still hold now that the network is idle.
    let still = true;
    if (navCond) {
      url = await navOk();
      still = url !== null;
    }
    if (still && domCond) still = await bg2cDomProbe(tabId, payload, ctx);
    if (still) {
      const out = Object.assign({ tabId }, dom || {}, { ok: true, waitedMs: Date.now() - t0, inflight: idle.inflight });
      if (url) out.url = url;
      return out;
    }
    if (Date.now() >= deadline) throw timedOut();
    await bg2aSleep(Math.min(100, Math.max(0, deadline - Date.now())), signal);
  }
}

// page_wait networkIdle options: null unless networkIdle is true.
function bg2cNetIdleSpec(payload) {
  const on = payload.networkIdle;
  if (on === undefined || on === null || on === false) return null;
  if (on !== true) throw new Error(`Invalid networkIdle: ${bg2cFmt(on)} (use true or false)`);
  return {
    idleMs: bg2cInt(payload, "idleMs", 0, 600000, 500),
    maxInflight: bg2cInt(payload, "maxInflight", 0, 1000, 0),
  };
}

// One immediate check of the selector / text condition in the targeted frame
// (no waiting). A document going away counts as "does not hold".
async function bg2cDomProbe(tabId, payload, ctx) {
  try {
    // timeoutMs 1: a content script without "probe" support answers within ~1 ms.
    const r = await toContent(tabId, "page_wait", { selector: payload.selector, text: payload.text, probe: true, timeoutMs: 1 }, undefined, ctx);
    const v = unwrap(r);
    return !(v && v.ok === false);
  } catch (e) {
    throwIfAborted(ctx && ctx.signal);
    if (/^Timed out/.test(String(e && e.message)) || bg2aIsNavError(e)) return false;
    throw e;
  }
}

// ----- payload validation (wave-2 handlers) -----
function bg2cFmt(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {}
  return capStr(s === undefined ? String(v) : s, 60);
}

// Integer field; def === undefined makes it required.
function bg2cInt(payload, key, min, max, def) {
  const v = payload[key];
  if (v === undefined || v === null) {
    if (def === undefined) throw new Error(`${key} is required (an integer from ${min} to ${max})`);
    return def;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`Invalid ${key}: ${bg2cFmt(v)} (an integer from ${min} to ${max})`);
  }
  return v;
}

function bg2cNum(payload, key, min, max, def) {
  const v = payload[key];
  if (v === undefined || v === null) {
    if (def === undefined) throw new Error(`${key} is required (a number from ${min} to ${max})`);
    return def;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid ${key}: ${bg2cFmt(v)} (a number from ${min} to ${max})`);
  }
  return v;
}

function bg2cBool(payload, key, def) {
  const v = payload[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") throw new Error(`Invalid ${key}: ${bg2cFmt(v)} (true or false)`);
  return v;
}

function bg2cEnum(payload, key, allowed) {
  const v = payload[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) throw new Error(`Invalid ${key}: ${bg2cFmt(v)} (use ${allowed.join(", ")})`);
  return v;
}

// Absolute deadline inside the server-side timeout of the command.
function bg2cDeadline(ctx, fallbackMs) {
  const t = ctx && Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0 ? Math.max(1000, ctx.timeoutMs - 1500) : fallbackMs;
  return Date.now() + t;
}

// Settles with p, or rejects at the deadline / on cancel (p keeps running).
function bg2cRace(p, deadline, signal, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let onAbort = null;
    const done = (fn, v) => {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      fn(v);
    };
    if (signal) {
      if (signal.aborted) {
        reject(cancelledError());
        return;
      }
      onAbort = () => done(reject, cancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => done(reject, new Error(timeoutMessage)), Math.max(0, deadline - Date.now()));
    Promise.resolve(p).then(
      (v) => done(resolve, v),
      (e) => done(reject, e)
    );
  });
}

// ----- emulation_* (persistent "emulation" holder, debugger-session registry) -----
// Sets one emulation kind. The state is recorded only after CDP accepted it;
// a failure on a tab without earlier state of this kind leaves no holder.
async function bg2cApplyEmulation(tabId, sessions, state, apply) {
  const had = sessions.has(tabId);
  const dbg = await acquireDebugger(tabId, "emulation");
  try {
    await apply(dbg);
  } catch (e) {
    if (!had) await releaseHolderIfUnused(tabId, "emulation").catch(() => {});
    throw e;
  }
  sessions.set(tabId, state);
}

// emulation_media payload key -> [allowed values, CSS media feature]
const BG2C_MEDIA_FEATURES = {
  colorScheme: [["light", "dark", "no-preference"], "prefers-color-scheme"],
  reducedMotion: [["reduce", "no-preference"], "prefers-reduced-motion"],
  forcedColors: [["active", "none"], "forced-colors"],
};
const BG2C_MEDIA_TYPES = ["screen", "print"];

function bg2cMediaParams(state) {
  const features = [];
  for (const [key, [, name]] of Object.entries(BG2C_MEDIA_FEATURES)) {
    if (state[key]) features.push({ name, value: state[key] });
  }
  return { media: state.media || "", features };
}

// ----- perf_web_vitals -----
// Runs in the page's MAIN world (serialized: no outer references). Buffered
// PerformanceObservers deliver what happened before the call; observeMs keeps
// watching (interactions, late LCP candidates, layout shifts). Values are ms
// from the navigation start (a prerender's activation subtracted); CLS uses
// the web-vitals session windows (gaps < 1 s, windows <= 5 s), INP the worst
// interaction (the 98th percentile from 50 interactions on). The page can
// tamper with anything here: the background validates every value.
async function bg2cWebVitalsMain(observeMs) {
  const PO = typeof PerformanceObserver === "function" ? PerformanceObserver : null;
  const supported = PO && Array.isArray(PO.supportedEntryTypes) ? PO.supportedEntryTypes.slice() : [];
  const got = { "largest-contentful-paint": [], "layout-shift": [], event: [], "first-input": [], longtask: [], paint: [] };
  const observers = [];
  for (const type of Object.keys(got)) {
    if (!supported.includes(type)) continue;
    try {
      const o = new PO((list) => {
        for (const e of list.getEntries()) got[type].push(e);
      });
      const opts = { type, buffered: true };
      // (Chrome buffers event entries of 104 ms and more; new ones from 16 ms)
      if (type === "event") opts.durationThreshold = 16;
      o.observe(opts);
      observers.push([type, o]);
    } catch {}
  }
  await new Promise((r) => setTimeout(r, Math.max(100, observeMs)));
  for (const [type, o] of observers) {
    try {
      for (const e of o.takeRecords()) got[type].push(e);
    } catch {}
    try {
      o.disconnect();
    } catch {}
  }
  const nav = /** @type {any} */ ((performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || null);
  const act = nav && nav.activationStart > 0 ? nav.activationStart : 0;
  const rel = (t) => (typeof t === "number" && t > 0 ? Math.max(t - act, 0) : null);
  let fcp = null;
  const paints = got.paint.length ? got.paint : performance.getEntriesByType ? performance.getEntriesByType("paint") : [];
  for (const e of paints) if (e.name === "first-contentful-paint") fcp = rel(e.startTime);
  const lcps = got["largest-contentful-paint"];
  const lcp = lcps.length ? rel(lcps[lcps.length - 1].startTime) : null;
  let cls = null;
  if (supported.includes("layout-shift")) {
    cls = 0;
    let cur = 0;
    let first = 0;
    let prev = 0;
    const shifts = got["layout-shift"].filter((e) => !e.hadRecentInput).sort((a, b) => a.startTime - b.startTime);
    for (const e of shifts) {
      if (cur > 0 && e.startTime - prev < 1000 && e.startTime - first < 5000) cur += e.value;
      else {
        cur = e.value;
        first = e.startTime;
      }
      prev = e.startTime;
      if (cur > cls) cls = cur;
    }
  }
  const worst = new Map(); // interaction -> its slowest event
  for (const e of got.event.concat(got["first-input"])) {
    const key = e.interactionId || (e.entryType === "first-input" ? "first-input" : 0);
    if (key) worst.set(key, Math.max(worst.get(key) || 0, e.duration));
  }
  const durs = Array.from(worst.values()).sort((a, b) => b - a);
  const inp = durs.length ? durs[Math.min(durs.length - 1, Math.floor(durs.length / 50))] : null;
  let longMs = 0;
  for (const e of got.longtask) longMs += e.duration;
  return {
    url: String(location.href),
    visibility: String(document.visibilityState),
    supported: {
      lcp: supported.includes("largest-contentful-paint"),
      cls: supported.includes("layout-shift"),
      inp: supported.includes("event"),
      longtask: supported.includes("longtask"),
    },
    lcp,
    fcp,
    cls,
    inp,
    interactions: durs.length,
    ttfb: nav ? rel(nav.responseStart) : null,
    longTasks: { count: got.longtask.length, totalMs: longMs },
    navigation: { domContentLoaded: nav ? rel(nav.domContentLoadedEventEnd) : null, load: nav ? rel(nav.loadEventEnd) : null },
  };
}

// Reloads a tab; resolves true once its main frame finished loading, false
// when the deadline came first. A main-frame load error rejects.
function bg2cReloadAndWait(tabId, deadline, signal) {
  const wn = chrome.webNavigation;
  const events = !!(wn && wn.onCompleted && wn.onErrorOccurred);
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let poll = null;
    let onAbort = null;
    const onDone = (d) => {
      if (d && d.tabId === tabId && d.frameId === 0) finish(resolve, true);
    };
    const onErr = (d) => {
      // (ERR_ABORTED: replaced by another navigation, whose load still counts)
      if (d && d.tabId === tabId && d.frameId === 0 && !/ERR_ABORTED/.test(String(d.error || ""))) {
        finish(reject, new Error(`Reload failed: ${capStr(d.error, 200)}`));
      }
    };
    function finish(fn, v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (events) {
        wn.onCompleted.removeListener(onDone);
        wn.onErrorOccurred.removeListener(onErr);
      }
      if (onAbort) signal.removeEventListener("abort", onAbort);
      fn(v);
    }
    if (signal) {
      if (signal.aborted) {
        reject(cancelledError());
        return;
      }
      onAbort = () => finish(reject, cancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (events) {
      wn.onCompleted.addListener(onDone);
      wn.onErrorOccurred.addListener(onErr);
    } else {
      // No webNavigation events: poll the tab status (loading -> complete).
      const started = Date.now();
      let sawLoading = false;
      poll = setInterval(() => {
        chrome.tabs.get(tabId).then(
          (t) => {
            if (t.status !== "complete") sawLoading = true;
            else if (sawLoading || Date.now() - started > 2000) finish(resolve, true);
          },
          (e) => finish(reject, e)
        );
      }, 100);
    }
    timer = setTimeout(() => finish(resolve, false), Math.max(0, deadline - Date.now()));
    Promise.resolve(chrome.tabs.reload(tabId)).catch((e) => finish(reject, e));
  });
}

// Resolves true once the tab has no uncommitted navigation (tab.pendingUrl),
// false when the deadline comes first.
async function bg2cWaitNavigationCommitted(tabId, deadline, signal) {
  for (;;) {
    throwIfAborted(signal);
    const t = await chrome.tabs.get(tabId);
    if (!t || !t.pendingUrl) return true;
    if (Date.now() >= deadline) return false;
    await bg2aSleep(Math.min(100, Math.max(0, deadline - Date.now())), signal);
  }
}

// committed rejects when the tab's main frame commits a new document: a script
// still running in the old one would never answer. dispose() stops watching.
function bg2cWatchMainFrameCommit(tabId) {
  const wn = chrome.webNavigation;
  let listener = null;
  const committed = new Promise((_, reject) => {
    if (!wn || !wn.onCommitted) return;
    listener = (d) => {
      if (d && d.tabId === tabId && d.frameId === 0) {
        reject(new Error('the page navigated during the measurement; wait for it to load (page_wait readyState: "complete") and measure again, or pass reload: true'));
      }
    };
    wn.onCommitted.addListener(listener);
  });
  committed.catch(() => {});
  return {
    committed,
    dispose: () => {
      if (listener) wn.onCommitted.removeListener(listener);
      listener = null;
    },
  };
}

async function bg2cWebVitals(tabId, payload, ctx) {
  const signal = ctx && ctx.signal;
  const t0 = Date.now();
  const waitMs = bg2cInt(payload, "waitMs", 0, 30000, 0);
  const reload = bg2cBool(payload, "reload", false);
  const deadline = bg2cDeadline(ctx, 30000);
  const notes = [];
  throwIfAborted(signal);
  if (reload) {
    // The load wait leaves room for the observation window.
    const loaded = await bg2cReloadAndWait(tabId, Math.max(t0 + 1000, deadline - waitMs - 2000), signal);
    if (!loaded) notes.push("the reloaded page had not finished loading when the measurement started");
  } else {
    // tab_navigate returns as soon as the navigation starts: measure the
    // document it brings, not the one it replaces (a script injected into a
    // page that unloads never answers).
    const committed = await bg2cWaitNavigationCommitted(tabId, Math.max(t0 + 1000, deadline - waitMs - 2000), signal);
    if (!committed) notes.push("a navigation of the tab was still pending when the measurement started");
  }
  throwIfAborted(signal);
  const observeMs = Math.max(0, Math.min(waitMs, deadline - Date.now() - 1500));
  if (observeMs < waitMs) notes.push(`observed for ${observeMs} ms only (the command timeout is too short for waitMs)`);
  let res;
  const watch = bg2cWatchMainFrameCommit(tabId);
  try {
    const run = chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: bg2cWebVitalsMain,
      args: [observeMs],
    });
    res = await bg2cRace(Promise.race([run, watch.committed]), deadline, signal, "Timed out measuring web vitals (the page did not answer)");
  } catch (e) {
    throwIfAborted(signal);
    const msg = String((e && e.message) || e);
    if (/^Timed out/.test(msg)) throw e;
    throw new Error(`Cannot measure web vitals in tab ${tabId}: ${capStr(msg, 300)}`);
  } finally {
    watch.dispose();
  }
  const v = res && res[0] && res[0].result;
  if (!v || typeof v !== "object") throw new Error("The page navigated or closed during the measurement; try again");
  const ms = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x * 10) / 10 : null);
  const obj = (x) => (x && typeof x === "object" ? x : {});
  const sup = obj(v.supported);
  const lt = obj(v.longTasks);
  const nv = obj(v.navigation);
  const out = {
    tabId,
    url: capStr(typeof v.url === "string" ? v.url : "", 2048),
    lcp: ms(v.lcp),
    fcp: ms(v.fcp),
    cls: typeof v.cls === "number" && Number.isFinite(v.cls) && v.cls >= 0 ? Math.round(v.cls * 10000) / 10000 : null,
    inp: ms(v.inp),
    ttfb: ms(v.ttfb),
    longTasks: { count: Number.isInteger(lt.count) && lt.count >= 0 ? lt.count : 0, totalMs: ms(lt.totalMs) ?? 0 },
    navigation: { domContentLoaded: ms(nv.domContentLoaded), load: ms(nv.load) },
    interactions: Number.isInteger(v.interactions) && v.interactions >= 0 ? v.interactions : 0,
    observedMs: observeMs,
    reloaded: reload,
  };
  if (out.lcp === null) {
    notes.push(sup.lcp === false ? "lcp: not supported by this browser" : "lcp: no largest-contentful-paint entry (nothing painted yet, or the page loaded while hidden)");
  }
  if (out.fcp === null) notes.push("fcp: no first-contentful-paint yet (or the page loaded while hidden)");
  if (out.cls === null) notes.push("cls: layout-shift entries are not supported by this browser");
  if (out.inp === null) {
    notes.push(
      sup.inp === false
        ? "inp: Event Timing is not supported by this browser"
        : "inp: no interaction recorded (INP needs clicks, taps or key presses: interact with the page, then measure again or observe with waitMs)"
    );
  } else {
    notes.push("inp: approximation from Event Timing; interactions before this call count only when they took 104 ms or more");
  }
  if (out.ttfb === null) notes.push("ttfb: no navigation timing for this document");
  if (out.navigation.domContentLoaded === null) notes.push("navigation.domContentLoaded: not finished yet");
  if (out.navigation.load === null) notes.push("navigation.load: the load event has not finished yet");
  if (sup.longtask === false) notes.push("longTasks: not supported by this browser");
  if (v.visibility === "hidden") notes.push("the tab is hidden: Chrome reports no paint metrics (fcp, lcp) for a document while it is hidden");
  if (notes.length) out.note = notes.join("; ");
  return out;
}

// ----- perf_trace_* (CDP Tracing on the persistent "perf" holder) -----
// perf_trace_start reserves the tab, attaches and starts Tracing (transfer
// mode ReportEvents). perf_trace_stop ends it, collects the
// Tracing.dataCollected events into a JSON text {"traceEvents":[...]} kept as
// chunks of at most PERF_TRACE_CHUNK_BYTES (UTF-8) under a random traceId,
// and summarizes the main thread while the events stream in.
// perf_trace_chunk hands out one chunk; a trace is dropped once every chunk
// was read, after PERF_TRACE_TTL_MS, or when the service worker restarts.
// A running trace is a "trace" kind in the debugger-session registry:
// switching perf_trace_start / perf_trace_stop off, 30 s of bridge-down, a
// detach or closing the tab ends it and discards its data.
const PERF_TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "v8.execute",
  "blink.user_timing",
  "loading",
  "latencyInfo",
];
const PERF_TRACE_SCREENSHOTS = "disabled-by-default-devtools.screenshot";
const PERF_TRACE_CATEGORY_RE = /^-?[\w.:*()-]{1,200}$/;

// Categories that record page pixels or replayable paint data (filmstrip
// screenshots, SkPicture / display-item dumps, layer snapshots): they reveal
// page content like a screenshot does.
const PERF_TRACE_PAGE_CONTENT = [
  PERF_TRACE_SCREENSHOTS,
  "disabled-by-default-devtools.timeline.picture",
  "disabled-by-default-devtools.timeline.layers",
  "disabled-by-default-devtools.timeline.paint",
  "disabled-by-default-cc.debug.display_items",
  "disabled-by-default-cc.debug.picture",
  "disabled-by-default-cc.debug.quads",
  "disabled-by-default-skia",
  "disabled-by-default-skia.gpu",
  "disabled-by-default-skia.picture",
];
const PERF_TRACE_PAGE_CONTENT_RE = /screenshot|picture|display_items|layers|skia|\.paint|cc\.debug/i;

// True when an included category pattern can switch on a page-content
// category: Chrome glob-matches "*" in disabled-by-default patterns
// ("disabled-by-default-*", "disabled-by-default-devtools.*"), and an explicit
// include wins over an exclusion, so excluding one is no guard. A bare "*"
// never enables disabled-by-default categories. Deliberately broad: a pattern
// matching a known name, or naming one of these kinds itself, counts.
function traceIncludesScreenshots(included) {
  return included.some((p) => {
    if (p === "*") return false;
    if (PERF_TRACE_PAGE_CONTENT_RE.test(p)) return true;
    const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return PERF_TRACE_PAGE_CONTENT.some((name) => re.test(name));
  });
}
const PERF_TRACE_CHUNK_BYTES = 4 * 1024 * 1024;
const PERF_TRACE_MAX_BYTES = 200 * 1024 * 1024; // later events are dropped (droppedEvents)
const PERF_TRACE_BUFFER_KB = 64 * 1024; // Chrome's trace buffer (recordUntilFull)
const PERF_TRACE_TTL_MS = 5 * 60 * 1000;
const PERF_TRACE_KEEP = 4; // finished traces held at once (the oldest is dropped)
const PERF_TRACE_STORE_BYTES = 256 * 1024 * 1024; // and their total size (the newest always stays)
const PERF_LONG_TASK_US = 50000;
// Main-thread task events, preferred first (one name per thread is summed).
const PERF_TASK_NAMES = ["RunTask", "ThreadControllerImpl::RunTask", "ThreadControllerImpl::DoWork"];
const traceCollectors = new Map(); // tabId -> collector while perf_trace_stop collects
const traceStore = new Map(); // traceId -> { tabId, chunks, bytes, read:Set<index>, timer }
const lostTraceTabs = new Set(); // tabs whose trace a worker restart ended

function saveTraceTabs() {
  try {
    Promise.resolve(chrome.storage.session.set({ mcpTraceTabs: Array.from(traceSessions.keys()) })).catch(() => {});
  } catch {}
}

// A trace never survives a service-worker restart: the in-memory session is
// gone, and the surviving attach is detached as a leftover (pendingRestore),
// which ends Chrome's recording. The tabs are remembered only so that
// perf_trace_stop can say so.
const traceRestoreReady = (async () => {
  try {
    const got = await chrome.storage.session.get("mcpTraceTabs");
    const tabs = got && got.mcpTraceTabs;
    if (Array.isArray(tabs)) for (const t of tabs) if (Number.isInteger(t) && !traceSessions.has(t)) lostTraceTabs.add(t);
  } catch {}
  saveTraceTabs();
})();

// Registry hook (teardown, detach, tab closed): a stop still collecting on a
// tab whose session is gone fails at once instead of at its timeout.
function onTraceSessionsChanged() {
  saveTraceTabs();
  for (const [tabId, c] of traceCollectors) {
    if (traceSessions.has(tabId)) continue;
    traceCollectors.delete(tabId);
    c.fail(new Error("The trace was discarded before its data arrived (debugger detached, tab closed, permission switched off or bridge down)"));
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Tracing.dataCollected" && method !== "Tracing.tracingComplete") return;
  const c = traceCollectors.get(source && source.tabId);
  if (!c) return;
  if (method === "Tracing.dataCollected") {
    if (!c.discard) bg2cTraceAdd(c, params && params.value);
  }
  else c.complete(params);
});

function bg2cUtf8Len(s) {
  return /^[\x00-\x7f]*$/.test(s) ? s.length : new TextEncoder().encode(s).length;
}

function bg2cTraceCollector() {
  const c = {
    eventCount: 0,
    dropped: 0,
    bytes: 0,
    chunks: [],
    cur: [],
    curBytes: 0,
    first: true,
    minTs: Infinity,
    maxTs: -Infinity,
    threads: new Map(), // "pid:tid" -> { pid, tid, name, tasks: { [name]: { busy, longCount, long, lastEnd } } }
    mainFrame: null,
    mainPids: new Set(),
  };
  c.done = new Promise((resolve, reject) => {
    c.complete = (p) => resolve(p || {});
    c.fail = (e) => reject(e);
  });
  c.done.catch(() => {});
  bg2cTraceWrite(c, '{"traceEvents":[');
  return c;
}

function bg2cTraceFlush(c) {
  if (!c.cur.length) return;
  c.chunks.push(c.cur.join(""));
  c.cur = [];
  c.curBytes = 0;
}

// Appends JSON text: the chunks stay <= PERF_TRACE_CHUNK_BYTES (UTF-8) and
// their concatenation is the trace file.
function bg2cTraceWrite(c, s) {
  const n = bg2cUtf8Len(s);
  if (n > PERF_TRACE_CHUNK_BYTES) {
    // One oversized piece: split it (at worst 3 UTF-8 bytes per UTF-16 unit),
    // never between the halves of a surrogate pair.
    const step = n === s.length ? PERF_TRACE_CHUNK_BYTES : Math.floor(PERF_TRACE_CHUNK_BYTES / 3);
    for (let i = 0; i < s.length; ) {
      let end = Math.min(s.length, i + step);
      const code = s.charCodeAt(end - 1);
      if (end < s.length && code >= 0xd800 && code <= 0xdbff) end--;
      bg2cTraceWrite(c, s.slice(i, end));
      i = end;
    }
    return;
  }
  if (c.curBytes + n > PERF_TRACE_CHUNK_BYTES) bg2cTraceFlush(c);
  c.cur.push(s);
  c.curBytes += n;
  c.bytes += n;
}

function bg2cTraceAdd(c, events) {
  if (!Array.isArray(events)) return;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    c.eventCount++;
    bg2cTraceNote(c, e);
    let s;
    try {
      s = JSON.stringify(e);
    } catch {
      c.dropped++;
      continue;
    }
    if (c.bytes + s.length + 3 > PERF_TRACE_MAX_BYTES) {
      c.dropped++;
      continue;
    }
    bg2cTraceWrite(c, c.first ? s : "," + s);
    c.first = false;
  }
}

function bg2cTraceThread(c, pid, tid) {
  const key = `${pid}:${tid}`;
  let t = c.threads.get(key);
  if (!t) c.threads.set(key, (t = { pid, tid, name: "", tasks: {} }));
  return t;
}

// Summary bookkeeping per event: trace bounds, thread names, the main
// frame's renderer process(es) and per-thread task time / long tasks.
function bg2cTraceNote(c, e) {
  const args = e.args && typeof e.args === "object" ? e.args : null;
  if (e.ph === "M") {
    if (e.name === "thread_name" && args) bg2cTraceThread(c, e.pid, e.tid).name = String(args.name || "");
    return;
  }
  if (typeof e.ts === "number" && e.ts > 0) {
    if (e.ts < c.minTs) c.minTs = e.ts;
    const end = e.ts + (typeof e.dur === "number" && e.dur > 0 ? e.dur : 0);
    if (end > c.maxTs) c.maxTs = end;
  }
  const data = args && args.data && typeof args.data === "object" ? args.data : null;
  // A tab's trace holds only its renderer process(es) (site-isolated frames
  // add more): events of the tab's main frame (its id is the tab's debugger
  // target id) or of a main-frame commit mark the main frame's process.
  if (data && e.pid !== undefined && ((c.mainFrame && data.frame === c.mainFrame) || data.isOutermostMainFrame === true)) c.mainPids.add(e.pid);
  if (e.name === "TracingStartedInBrowser" && data && Array.isArray(data.frames)) {
    const main = data.frames.find((f) => f && !f.parent);
    if (main) {
      c.mainFrame = main.frame;
      if (Number.isInteger(main.processId)) c.mainPids.add(main.processId);
    }
  } else if (e.name === "FrameCommittedInBrowser" && data && c.mainFrame && data.frame === c.mainFrame && Number.isInteger(data.processId)) {
    c.mainPids.add(data.processId); // a cross-process navigation of the main frame
  } else if (e.ph === "X" && typeof e.dur === "number" && typeof e.ts === "number" && PERF_TASK_NAMES.includes(e.name)) {
    const t = bg2cTraceThread(c, e.pid, e.tid);
    const st = t.tasks[e.name] || (t.tasks[e.name] = { busy: 0, longCount: 0, long: [], lastEnd: -Infinity });
    // (a task nested in one already counted adds no busy time)
    if (e.ts >= st.lastEnd) {
      st.busy += e.dur;
      if (e.dur > PERF_LONG_TASK_US) {
        st.longCount++;
        st.long.push([e.ts, e.dur]);
        if (st.long.length > 40) {
          st.long.sort((a, b) => b[1] - a[1]);
          st.long.length = 10;
        }
      }
    }
    st.lastEnd = Math.max(st.lastEnd, e.ts + e.dur);
  }
}

function bg2cTraceSummary(c) {
  const ms = (us) => Math.round(us / 100) / 10;
  const stat = (t) => {
    for (const n of PERF_TASK_NAMES) if (t.tasks[n]) return t.tasks[n];
    return null;
  };
  const busyOf = (t) => (stat(t) ? stat(t).busy : 0);
  const threads = Array.from(c.threads.values());
  const renderers = threads.filter((t) => t.name === "CrRendererMain");
  // The main frame's renderer main thread(s); else the busiest renderer main
  // thread, else the busiest thread of the main frame's process.
  let main = renderers.filter((t) => c.mainPids.has(t.pid));
  if (!main.length && renderers.length) main = [renderers.reduce((a, b) => (busyOf(b) > busyOf(a) ? b : a))];
  if (!main.length) {
    const own = threads.filter((t) => c.mainPids.has(t.pid) && stat(t));
    if (own.length) main = [own.reduce((a, b) => (busyOf(b) > busyOf(a) ? b : a))];
  }
  let busy = 0;
  let longCount = 0;
  const long = [];
  for (const t of main) {
    const st = stat(t);
    if (!st) continue;
    busy += st.busy;
    longCount += st.longCount;
    long.push(...st.long);
  }
  long.sort((a, b) => b[1] - a[1]);
  const t0 = Number.isFinite(c.minTs) ? c.minTs : 0;
  return {
    durationMs: Number.isFinite(c.minTs) && c.maxTs > c.minTs ? ms(c.maxTs - c.minTs) : 0,
    eventCount: c.eventCount,
    longTasks: long.slice(0, 10).map(([ts, dur]) => ({ startMs: ms(ts - t0), durationMs: ms(dur) })),
    longTaskCount: longCount,
    mainThreadBusyMs: main.length ? ms(busy) : null,
    mainThread: main.length ? main.map((t) => ({ pid: t.pid, tid: t.tid })) : null,
  };
}

async function bg2cTraceStart(tabId, payload, ctx) {
  await traceRestoreReady;
  const signal = ctx && ctx.signal;
  if (traceSessions.has(tabId)) throw new Error(`A trace is already running on tab ${tabId}; stop it with perf_trace_stop first`);
  let cats = PERF_TRACE_CATEGORIES.slice();
  const given = payload.categories;
  if (given !== undefined && given !== null) {
    if (!Array.isArray(given) || !given.length || given.length > 64 || !given.every((x) => typeof x === "string" && PERF_TRACE_CATEGORY_RE.test(x))) {
      throw new Error("Invalid categories: a non-empty list of up to 64 trace category names (letters, digits, _ . : * ( ) -; a leading - excludes one)");
    }
    cats = Array.from(new Set(given));
  }
  if (bg2cBool(payload, "screenshots", false) && !cats.includes(PERF_TRACE_SCREENSHOTS)) cats.push(PERF_TRACE_SCREENSHOTS);
  const included = cats.filter((x) => !x.startsWith("-"));
  const excluded = cats.filter((x) => x.startsWith("-")).map((x) => x.slice(1)).filter(Boolean);
  if (!included.length) throw new Error("Invalid categories: include at least one category");
  // Filmstrip frames are page screenshots: they need the page_screenshot
  // switch (Media) as well, like the REQUIRES rules of composite actions.
  if (traceIncludesScreenshots(included) && !isAllowed("page_screenshot")) {
    throw new Error("Permission disabled in extension: page_screenshot (required by perf_trace_start screenshots and paint-data categories; enable it from the extension popup)");
  }
  // Only the listed categories (Chrome would add its default ones otherwise).
  if (!included.includes("*") && !excluded.includes("*")) excluded.push("*");
  throwIfAborted(signal);
  const st = { startedAt: Date.now(), categories: cats, collector: null };
  traceSessions.set(tabId, st); // reserved: a concurrent second start is refused
  const params = {
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordUntilFull",
      traceBufferSizeInKb: PERF_TRACE_BUFFER_KB,
      includedCategories: included,
      excludedCategories: excluded,
    },
  };
  try {
    const dbg = await acquireDebugger(tabId, "perf");
    try {
      await cdpSend(dbg, "Tracing.start", params);
    } catch (e) {
      // A trace the previous service worker left running on an attach this
      // worker adopted: end it (nobody reads its data) and start afresh.
      if (!lostTraceTabs.has(tabId) || !/already/i.test(String((e && e.message) || e))) throw e;
      const sink = { discard: true };
      const ended = new Promise((resolve) => {
        sink.complete = resolve;
        sink.fail = resolve;
      });
      traceCollectors.set(tabId, sink);
      try {
        await cdpSend(dbg, "Tracing.end", {});
        await bg2cRace(ended, Date.now() + 3000, signal, "Timed out ending the previous trace");
      } catch {
      } finally {
        if (traceCollectors.get(tabId) === sink) traceCollectors.delete(tabId);
      }
      await cdpSend(dbg, "Tracing.start", params);
    }
  } catch (e) {
    if (traceSessions.get(tabId) === st) traceSessions.delete(tabId);
    await releaseHolderIfUnused(tabId, "perf").catch(() => {});
    throw new Error(`Could not start tracing on tab ${tabId}: ${capStr((e && e.message) || e, 300)}`);
  }
  if (traceSessions.get(tabId) !== st) {
    // Torn down while starting (permission switched off, tab closed).
    throw new Error(`The trace on tab ${tabId} was ended while it started`);
  }
  if (signal && signal.aborted) {
    await teardownDebugSession("trace", tabId).catch(() => {});
    throw cancelledError();
  }
  lostTraceTabs.delete(tabId);
  saveTraceTabs();
  return { tabId, started: true, categories: cats };
}

async function bg2cTraceStop(tabId, ctx) {
  await traceRestoreReady;
  const signal = ctx && ctx.signal;
  const st = traceSessions.get(tabId);
  if (!st) {
    if (lostTraceTabs.delete(tabId)) {
      throw new Error(
        `The trace on tab ${tabId} was lost: the extension's service worker restarted while it was recording (Chrome ends a trace together with its debugger session). Start a new one with perf_trace_start`
      );
    }
    const others = Array.from(traceSessions.keys());
    throw new Error(`No trace is running on tab ${tabId} (start one with perf_trace_start)${others.length ? `; running on tab ${others.join(", ")}` : ""}`);
  }
  if (st.collector) throw new Error(`The trace on tab ${tabId} is already being stopped`);
  const c = bg2cTraceCollector();
  st.collector = c;
  traceCollectors.set(tabId, c);
  const deadline = bg2cDeadline(ctx, 120000);
  let done;
  try {
    // The tab's target id is its main frame id in the trace events.
    try {
      const t = ((await chrome.debugger.getTargets()) || []).find((x) => x && x.tabId === tabId && x.type === "page");
      if (t && typeof t.id === "string") c.mainFrame = t.id;
    } catch {}
    // The data follows as Tracing.dataCollected events, then Tracing.tracingComplete.
    try {
      await cdpSend({ tabId }, "Tracing.end", {});
    } catch (e) {
      throw new Error(`Could not stop tracing on tab ${tabId}: ${capStr((e && e.message) || e, 300)}`);
    }
    done = await bg2cRace(c.done, deadline, signal, "Timed out collecting the trace data (give perf_trace_stop a longer timeout, or record a shorter trace)");
  } catch (e) {
    // Nothing usable: drop the session, its data and the holder.
    if (traceCollectors.get(tabId) === c) traceCollectors.delete(tabId);
    if (traceSessions.get(tabId) === st) await teardownDebugSession("trace", tabId).catch(() => {});
    throw e;
  }
  traceCollectors.delete(tabId);
  if (traceSessions.get(tabId) === st) traceSessions.delete(tabId);
  saveTraceTabs();
  await releaseHolderIfUnused(tabId, "perf").catch(() => {});
  bg2cTraceWrite(c, "]}");
  bg2cTraceFlush(c);
  const traceId = bg2cStoreTrace(tabId, c.chunks, c.bytes);
  const out = { tabId, traceId, size: c.bytes, chunks: c.chunks.length, summary: bg2cTraceSummary(c) };
  if (done && done.dataLossOccurred) out.dataLossOccurred = true; // Chrome's buffer filled up
  if (c.dropped) {
    out.droppedEvents = c.dropped;
    out.truncated = true;
  }
  return out;
}

function bg2cDropTrace(traceId) {
  const e = traceStore.get(traceId);
  if (!e) return;
  clearTimeout(e.timer);
  traceStore.delete(traceId);
}

function bg2cStoreTrace(tabId, chunks, bytes) {
  const held = () => Array.from(traceStore.values()).reduce((n, e) => n + e.bytes, 0);
  while (traceStore.size && (traceStore.size >= PERF_TRACE_KEEP || held() + bytes > PERF_TRACE_STORE_BYTES)) {
    bg2cDropTrace(traceStore.keys().next().value);
  }
  const traceId = randomHex32().slice(0, 32);
  traceStore.set(traceId, { tabId, chunks, bytes, read: new Set(), timer: setTimeout(() => bg2cDropTrace(traceId), PERF_TRACE_TTL_MS) });
  return traceId;
}

// One chunk of a finished trace; the trace is dropped once every chunk was read.
function bg2cTraceChunk(payload) {
  const traceId = payload.traceId;
  if (typeof traceId !== "string" || !/^[0-9a-f]{32}$/.test(traceId)) throw new Error(`Invalid traceId: ${bg2cFmt(traceId)}`);
  const e = traceStore.get(traceId);
  if (!e) {
    throw new Error(`Unknown or expired traceId: ${traceId} (a trace is kept until every chunk was read, for 5 minutes at most, and not across an extension restart)`);
  }
  const index = bg2cInt(payload, "index", 0, e.chunks.length - 1);
  e.read.add(index);
  const out = { traceId, index, chunks: e.chunks.length, data: e.chunks[index] };
  if (e.read.size >= e.chunks.length) bg2cDropTrace(traceId);
  return out;
}

// ----- trusted input geometry (D7/F8) -----
// Scrolls the target into view in the targeted frame (focused frame, else the
// main frame) through content.js, where every selector form (refs, xpath=,
// text=, CSS) works. Returns { frameId, v } with v in that frame's viewport px.
async function bg2aScrollTarget(tabId, selector, ctx) {
  if (selector === undefined || selector === null || String(selector).trim() === "") throw new Error("selector is required");
  const r = await toContent(tabId, "scroll_into_view", { selector: String(selector) }, ctx && ctx.timeoutMs, ctx);
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
// ctx = { timeoutMs?, signal?, touched?, mayNavigate? } (see runBridgeCommand):
// the server-side timeout, the cancel signal and the fallback bookkeeping.
// Content commands pass it on: toContent(tabId, cmd, payload, ctx?.timeoutMs, ctx).
async function handleCommand(action, payload, tabId, ctx = {}) {
  await permsReady;
  await stateReady;
  payload = payload && typeof payload === "object" ? payload : {};
  // Allow-list: only catalog actions and INTERNAL_ACTIONS are routed at all.
  if (!PERM_ALL_SET.has(normalizeAction(action)) && !INTERNAL_ACTIONS.has(action)) {
    throw new Error(`Unknown command: ${action}`);
  }
  // Permission check (perm_list/perm_set are always allowed; perm_set can only disable)
  if (!UNGATED_ACTIONS.has(action)) {
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
  if (Number.isInteger(tabId) && tabId >= 0) {
    markAgentTab(tabId);
    touchTab(ctx, tabId);
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
        requires: REQUIRES,
      };
    }
    case "perm_set": {
      // Over the bridge a permission can only be switched OFF (self-restriction).
      const a = String(payload.action ?? "");
      const targets = resolvePermNames(a);
      if (!targets.length) throw new Error(`Unknown permission: ${a}`);
      if (payload.enabled) throw new Error("Re-enabling a permission is only possible from the extension popup");
      // The popup shows what the agent switched off (only switches it turned off now).
      for (const t of targets) if (!disabledActions.has(t)) agentDisabledActions.add(t);
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
      const id = tabId ?? (await activeTabId(ctx));
      const dup = await chrome.tabs.duplicate(id);
      return { ok: true, tab: { id: dup.id, title: dup.title, url: dup.url, active: dup.active, windowId: dup.windowId } };
    }
    case "tab_close": {
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
      await chrome.tabs.update(id, { active: true });
      const t = await chrome.tabs.get(id);
      await chrome.windows.update(t.windowId, { focused: true });
      return { ok: true, id };
    }
    case "tab_navigate": {
      const id = tabId ?? (await activeTabId(ctx));
      const url = bg2aNormalizeUrl(payload.url);
      if (!url) throw new Error("url is required");
      await chrome.tabs.update(id, { url });
      return { ok: true, id, url };
    }
    case "tab_reload": {
      const id = tabId ?? (await activeTabId(ctx));
      await chrome.tabs.reload(id);
      return { ok: true, id };
    }
    case "tab_back": {
      // tabs.goBack also works on error pages, chrome:// pages and the PDF
      // viewer, where script injection is not allowed.
      const id = tabId ?? (await activeTabId(ctx));
      await chrome.tabs.goBack(id);
      return { ok: true, id };
    }
    case "tab_forward": {
      const id = tabId ?? (await activeTabId(ctx));
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
      const r = await toContent(tabId, action, payload, ctx && ctx.timeoutMs, ctx);
      const v = unwrap(r);
      // string results (snapshot/html/text) pass through for AI readability
      if (typeof v === "string") return { tabId: r.tabId, text: v };
      if (Array.isArray(v)) return { tabId: r.tabId, items: v };
      if (v && typeof v === "object") return Object.assign({ tabId: r.tabId }, v);
      return { tabId: r.tabId, value: v };
    }

    case "page_wait": {
      // URL / readyState waits are tracked here so they survive navigations (E18).
      const id = tabId ?? (await activeTabId(ctx));
      return await bg2aPageWait(id, payload, ctx);
    }

    case "js_evaluate": {
      // CSP-safe: evaluated via CDP Runtime.evaluate (trusted, bypasses both
      // page CSP and the extension's own script-src without unsafe-eval).
      // Never use eval/new Function here or in content.js.
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
      await chrome.tabs.update(id, { active: true });
      const t = await chrome.tabs.get(id);
      await chrome.windows.update(t.windowId, { focused: true });
      await bg2aSleep(300, ctx && ctx.signal);
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
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
      } catch (first) {
        // A window that was minimized or covered may not have repainted yet
        // ("image readback failed"): try once more, then capture the viewport
        // through the debugger.
        await bg2aSleep(700, ctx && ctx.signal);
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
        } catch {
          try {
            const shot = await withDebugger(id, (dbg) => cdpSend(dbg, "Page.captureScreenshot", { format: "png" }));
            dataUrl = `data:image/png;base64,${shot.data}`;
          } catch (e) {
            const a = capStr(String((first && first.message) || first), 200);
            const b = capStr(String((e && e.message) || e), 200);
            throw new Error(`Failed to capture tab ${id}: ${a} (debugger fallback: ${b})`);
          }
        }
      }
      return { tabId: id, dataUrl, note: "visible-tab base64 dataUrl (the AI can view this image)" };
    }

    case "page_pdf": {
      const id = tabId ?? (await activeTabId(ctx));
      const pdf = await withDebugger(id, async (dbg) => {
        return await cdpSend(dbg, "Page.printToPDF", { printBackground: true });
      });
      return { tabId: id, dataBase64: pdf.data, note: "PDF base64 (write the data field to a file)" };
    }

    case "tab_audio_record_start": {
      const discards = audioDiscards;
      const id = tabId ?? (await activeTabId(ctx));
      // Reuses the offscreen document: recordings of other tabs keep running.
      await ensureOffscreen();
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: id });
      } catch (err) {
        throw new Error(`Failed to get media stream for tab ${id}: ${err.message || err}`);
      }
      throwIfAborted(ctx && ctx.signal);
      const res = await chrome.runtime.sendMessage({
        type: "mcp-offscreen-audio-start",
        streamId,
        tabId: id,
        passthrough: payload.passthrough !== false,
      });
      if (!res || !res.ok) {
        throw new Error(res?.error || "Failed to start tab audio recording in offscreen document");
      }
      // Cancelled while starting (the caller already got "cancelled" and will
      // never send the stop), or its switches went off meanwhile (that
      // discard ran before this recording existed): an active recording has
      // no time limit, so stop and release it here instead of leaving the tab
      // recorded.
      const aborted = !!(ctx && ctx.signal && ctx.signal.aborted);
      if (aborted || audioDiscards !== discards) {
        try {
          await bg2bOffscreen({ type: "mcp-offscreen-audio-stop", tabId: id }, "stop the tab audio recording");
        } catch {}
        try {
          await chrome.runtime.sendMessage({ type: "mcp-offscreen-audio-release", tabId: id });
        } catch {}
        if (aborted) throw cancelledError();
        throw new Error("Tab audio recording was switched off in the extension while it started; the recording was discarded");
      }
      return { ok: true, tabId: id, recording: true, startedAt: res.startedAt, mimeType: res.mimeType };
    }

    case "tab_audio_record_stop": {
      await ensureOffscreen();
      // payload.recordingTabId: the tab tab_audio_capture's own start returned
      // (the agent named no tab). It only picks the recording to stop: as a
      // payload field it never reaches the agent-tab marking above, so the
      // user's tab stays a fallback tab (no dialog auto-accept hook).
      // Without either: the single active recording (never "whatever tab is
      // active now", the user may have switched tabs while recording).
      let id = Number.isInteger(tabId)
        ? tabId
        : Number.isInteger(payload.recordingTabId) && payload.recordingTabId >= 0
          ? payload.recordingTabId
          : null;
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
      await ensureContent(targetTab, 0, undefined, ctx && ctx.signal);
      const r = await bg2bTopFrameSend(targetTab, "network_refetch", { url, method: "GET" }, deadline, ctx && ctx.signal);
      return { url, source: "refetch", ...unwrap(r) };
    }
    case "network_throttle": {
      const id = tabId ?? (await activeTabId(ctx));
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
      const clears = !params.offline && params.latency <= 0 && params.downloadThroughput <= 0 && params.uploadThroughput <= 0;
      if (clears) {
        // Reset explicitly: other holders (mock, headers, ...) may keep the session.
        const had = await teardownDebugSession("throttle", id);
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
      const id = tabId ?? (await activeTabId(ctx));
      const raw = payload.headers;
      if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("headers must be an object of name -> value");
      const headers = {};
      for (const [k, v] of Object.entries(raw || {})) headers[k] = bg2bCheckHeader(k, v);
      // Extra headers live only as long as the CDP session: a persistent
      // "headers" debugger holder keeps them until cleared with {}.
      if (!Object.keys(headers).length) {
        const had = await teardownDebugSession("headers", id);
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
      const id = tabId ?? (await activeTabId(ctx));
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
      const signal = ctx && ctx.signal;
      await ensureContent(id, 0, undefined, signal);
      const local = unwrap(await bg2bTopFrameSend(id, "storage_get", { area: "local", full: true }, deadline, signal));
      const session = unwrap(await bg2bTopFrameSend(id, "storage_get", { area: "session", full: true }, deadline, signal));
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
      const id = tabId ?? (await activeTabId(ctx));
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
        const signal = ctx && ctx.signal;
        await ensureContent(id, 0, undefined, signal);
        const str = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
        for (const [k, v] of localEntries) {
          unwrap(await bg2bTopFrameSend(id, "storage_set", { area: "local", key: k, value: str(v) }, deadline, signal));
          localKeys++;
        }
        for (const [k, v] of sessionEntries) {
          unwrap(await bg2bTopFrameSend(id, "storage_set", { area: "session", key: k, value: str(v) }, deadline, signal));
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
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
      // Fetch.disable, session dropped; detaches only when no other holder
      // (emulation, throttle, ...) remains.
      await teardownDebugSession("mock", id);
      return { ok: true, tabId: id };
    }
    case "network_mock_route": {
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
      const sess = fetchSessions.get(id);
      return { tabId: id, active: !!sess, routes: sess ? sess.routes : [] };
    }
    case "network_mock_remove": {
      const id = tabId ?? (await activeTabId(ctx));
      const sess = fetchSessions.get(id);
      if (!sess) return { ok: false, tabId: id };
      sess.routes = sess.routes.filter((r) => r.id !== payload.routeId);
      saveMockSessions();
      return { ok: true, tabId: id, routes: sess.routes.length };
    }
    case "network_mock_clear": {
      const id = tabId ?? (await activeTabId(ctx));
      const sess = fetchSessions.get(id);
      if (sess) sess.routes = [];
      saveMockSessions();
      return { ok: true, tabId: id };
    }
    case "network_bodies": {
      // Spy capture: full request records (method/headers/postData) + response
      // bodies collected while a mock session holds the debugger. Requires
      // network_mock_start first (no routes needed — unmatched traffic passes).
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
      clearStickyFrame(id);
      return { ok: true, tabId: id };
    }

    // ----- tabs + windows -----
    case "tab_pin": {
      const id = tabId ?? (await activeTabId(ctx));
      const cur = await chrome.tabs.get(id);
      const pinned = payload.pinned !== undefined ? !!payload.pinned : !cur.pinned;
      await chrome.tabs.update(id, { pinned });
      return { ok: true, id, pinned };
    }
    case "tab_mute": {
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
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
      const resource = bg2aHas(map, payload.permission) ? map[payload.permission] : null;
      if (!resource || !chrome.contentSettings || !chrome.contentSettings[resource]) throw new Error(`Unsupported permission: ${payload.permission}`);
      const setting = payload.setting === undefined || payload.setting === null ? "allow" : payload.setting;
      if (!PERMISSION_SETTINGS.has(setting)) throw new Error(`Invalid setting: ${capStr(String(setting), 50)} (use allow, block or ask)`);
      // One exact http(s) origin, never a pattern: "https://*" or "*://*"
      // would grant (or block) the setting browser-wide.
      let origin;
      if (payload.origin !== undefined && payload.origin !== null && payload.origin !== "") {
        origin = exactHttpOrigin(payload.origin);
        if (!origin) {
          throw new Error(
            `Invalid origin: ${capStr(String(payload.origin), 200)} (give one exact http(s) origin such as https://example.com: no wildcards, paths or patterns)`
          );
        }
      } else {
        const id = tabId ?? (await activeTabId(ctx));
        const t = await chrome.tabs.get(id);
        origin = bg2bHttpOrigin(t.url);
        if (!origin) throw new Error(`permissions_grant needs an http(s) page or an explicit origin (tab ${id} shows ${capStr(t.url || "", 200) || "no URL"})`);
      }
      await chrome.contentSettings[resource].set({ primaryPattern: `${origin}/*`, setting });
      return { ok: true, permission: payload.permission, origin, setting };
    }
    case "emulation_geolocation": {
      const id = tabId ?? (await activeTabId(ctx));
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
          // (other emulation state on the tab may share the holder)
          await releaseHolderIfUnused(id, "emulation").catch(() => {});
        }
        throw e;
      }
      emulationSessions.set(id, { latitude, longitude, accuracy: accuracy || 50 });
      return { ok: true, tabId: id, latitude, longitude };
    }
    case "emulation_geolocation_clear": {
      const id = tabId ?? (await activeTabId(ctx));
      await teardownDebugSession("geolocation", id);
      return { ok: true, tabId: id };
    }
    case "emulation_viewport": {
      const id = tabId ?? (await activeTabId(ctx));
      if (bg2cBool(payload, "reset", false)) {
        const had = await teardownDebugSession("viewport", id);
        return { tabId: id, applied: { reset: true }, cleared: had };
      }
      const width = bg2cInt(payload, "width", 1, 16384);
      const height = bg2cInt(payload, "height", 1, 16384);
      const deviceScaleFactor = bg2cNum(payload, "deviceScaleFactor", 0, 10, 0); // 0 = the screen's own
      const mobile = bg2cBool(payload, "mobile", false);
      // touch follows mobile unless given: a phone viewport without touch input is rarely wanted
      const touch = bg2cBool(payload, "touch", mobile);
      const applied = { width, height, deviceScaleFactor, mobile, touch };
      throwIfAborted(ctx && ctx.signal);
      await bg2cApplyEmulation(id, viewportSessions, applied, async (dbg) => {
        await cdpSend(dbg, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
        await cdpSend(dbg, "Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      });
      return { tabId: id, applied };
    }
    case "emulation_media": {
      // Fields not given keep their current override; null removes one.
      const id = tabId ?? (await activeTabId(ctx));
      if (bg2cBool(payload, "reset", false)) {
        const had = await teardownDebugSession("media", id);
        return { tabId: id, applied: { reset: true }, cleared: had };
      }
      const next = Object.assign({}, mediaSessions.get(id) || {});
      let given = 0;
      for (const [key, [allowed]] of Object.entries(BG2C_MEDIA_FEATURES).concat([["media", [BG2C_MEDIA_TYPES]]])) {
        if (payload[key] === undefined) continue;
        given++;
        if (payload[key] === null) delete next[key];
        else next[key] = bg2cEnum(payload, key, allowed);
      }
      if (!given) throw new Error("emulation_media needs colorScheme, reducedMotion, forcedColors or media (or reset: true)");
      if (!Object.keys(next).length) {
        const had = await teardownDebugSession("media", id);
        return { tabId: id, applied: {}, cleared: had };
      }
      throwIfAborted(ctx && ctx.signal);
      await bg2cApplyEmulation(id, mediaSessions, next, (dbg) => cdpSend(dbg, "Emulation.setEmulatedMedia", bg2cMediaParams(next)));
      return { tabId: id, applied: next };
    }
    case "emulation_cpu": {
      const id = tabId ?? (await activeTabId(ctx));
      const rate = bg2cNum(payload, "rate", 1, 20);
      if (rate === 1) {
        // 1 = no throttling: clear it (and release the holder when unused)
        await teardownDebugSession("cpu", id);
        return { tabId: id, rate: 1 };
      }
      throwIfAborted(ctx && ctx.signal);
      await bg2cApplyEmulation(id, cpuSessions, { rate }, (dbg) => cdpSend(dbg, "Emulation.setCPUThrottlingRate", { rate }));
      return { tabId: id, rate };
    }
    case "emulation_reset": {
      // Viewport, media, CPU and geolocation; the shared holder goes with the last one.
      const id = tabId ?? (await activeTabId(ctx));
      const cleared = await teardownTabDebugSessions(id, (k) => k.holder === "emulation");
      return { tabId: id, cleared };
    }

    // ----- performance -----
    case "page_metrics": {
      const id = tabId ?? (await activeTabId(ctx));
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
    case "perf_web_vitals": {
      const id = tabId ?? (await activeTabId(ctx));
      return await bg2cWebVitals(id, payload, ctx);
    }
    case "perf_trace_start": {
      const id = tabId ?? (await activeTabId(ctx));
      return await bg2cTraceStart(id, payload, ctx);
    }
    case "perf_trace_stop": {
      // Without a tabId: the only running trace, else the active tab.
      let id = tabId;
      if (id === undefined) id = traceSessions.size === 1 ? traceSessions.keys().next().value : await activeTabId(ctx);
      return await bg2cTraceStop(id, ctx);
    }
    case "perf_trace_chunk":
      // (no tab involved: the trace is addressed by its traceId)
      return bg2cTraceChunk(payload);

    // ----- trusted input (CDP Input.* — real, trusted events) -----
    case "trusted_click": {
      // Scroll into view (content, focused frame or main frame), convert to
      // main-frame viewport px, refuse points outside the viewport (D7/F8).
      const id = tabId ?? (await activeTabId(ctx));
      const btn = payload.button || "left";
      const count = payload.doubleClick ? 2 : 1;
      const out = await withDebugger(id, async (dbg) => {
        const target = await bg2aScrollTarget(id, payload.selector, ctx);
        const { x, y } = await bg2aViewportPoint(dbg, id, target, payload.selector);
        throwIfAborted(ctx && ctx.signal);
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
      const id = tabId ?? (await activeTabId(ctx));
      const tmo = ctx && ctx.timeoutMs;
      if (payload.selector === undefined || payload.selector === null || String(payload.selector).trim() === "") throw new Error("selector is required");
      // Attach first: the debugging infobar must not appear between focusing and typing.
      await withDebugger(id, async (dbg) => {
        const sv = unwrap(await toContent(id, "scroll_into_view", { selector: String(payload.selector) }, tmo, ctx));
        let sel = (sv && sv.ref) || String(payload.selector);
        if (payload.clearFirst) {
          const dt = unwrap(await toContent(id, "dom_type", { selector: sel, text: "", clearFirst: true }, tmo, ctx));
          if (dt && dt.ref) sel = dt.ref; // dom_type may retarget (label / wrapper -> its input)
        }
        const fr = await toContent(id, "dom_focus", { selector: sel }, tmo, ctx);
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
        throwIfAborted(ctx && ctx.signal);
        await cdpSend(dbg, "Input.insertText", { text: String(payload.text ?? "") });
        if (payload.pressEnter) {
          // keyDown + text "\r" generates keypress -> implicit form submission (D8)
          for (const ev of bg2aKeyEvents(BG2A_NAMED_KEYS.Enter, 0)) await cdpSend(dbg, "Input.dispatchKeyEvent", ev);
        }
      });
      return { ok: true, tabId: id, trusted: true };
    }
    case "trusted_key": {
      const id = tabId ?? (await activeTabId(ctx));
      const k = payload.key;
      const spec = bg2aKeySpec(k);
      if (!spec) throw new Error(`Unsupported key: ${k} (named keys: ${Object.keys(BG2A_NAMED_KEYS).filter((n) => n !== " ").join(", ")}, or one character)`);
      await withDebugger(id, async (dbg) => {
        for (const ev of bg2aKeyEvents(spec, payload.modifiers)) await cdpSend(dbg, "Input.dispatchKeyEvent", ev);
      });
      return { ok: true, tabId: id, trusted: true };
    }
    case "trusted_scroll": {
      const id = tabId ?? (await activeTabId(ctx));
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
      const id = tabId ?? (await activeTabId(ctx));
      const pts = await withDebugger(id, async (dbg) => {
        const a0 = await bg2aScrollTarget(id, payload.from, ctx);
        const b = await bg2aScrollTarget(id, payload.to, ctx);
        // Centring the target may have moved the source: measure it again without scrolling.
        let a = a0;
        try {
          const q = await toContent(id, "dom_query", { selector: a0.v.ref || String(payload.from), limit: 1 }, ctx && ctx.timeoutMs, ctx);
          // dom_query answers { total, returned, items } (older content scripts: a bare array)
          const qv = unwrap(q);
          const it = (Array.isArray(qv) ? qv : qv && Array.isArray(qv.items) ? qv.items : [])[0];
          if (it && typeof it === "object" && it.w > 0 && it.h > 0) {
            a = { frameId: q.frameId || 0, v: { cx: it.x + it.w / 2, cy: it.y + it.h / 2, width: it.w, height: it.h } };
          }
        } catch {}
        const pa = await bg2aViewportPoint(dbg, id, a, payload.from, false);
        const pb = await bg2aViewportPoint(dbg, id, b, payload.to, false);
        const ax = pa.x, ay = pa.y, bx = pb.x, by = pb.y;
        // (checked once before the button goes down: a drag is never left half done)
        throwIfAborted(ctx && ctx.signal);
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
      const id = tabId ?? (await activeTabId(ctx));
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
