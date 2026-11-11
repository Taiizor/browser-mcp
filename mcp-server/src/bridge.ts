import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// WS bridge protocol v2 (see SECURITY.md for the trust model).
//
// Handshake:
//   - Web pages (any non-extension Origin) are refused during the HTTP upgrade
//     (403), so they cannot even detect the bridge.
//   - Extension sockets (chrome-extension:// / moz-extension:// Origin) must
//     come from a trusted extension id (built-in store id, BROWSER_MCP_EXTENSION_IDS,
//     --extension-id, or ~/.browser-mcp/trusted-extensions.json; trust-on-first-use
//     while that file is empty). Untrusted ids are closed with 4003.
//   - Origin-less sockets (satellites, CLI scripts) must authenticate first with
//     { type: "auth", token } (token file ~/.browser-mcp/bridge-<port>.token),
//     otherwise they are closed with 4001.
//
// Messages:
//   EXT  -> MCP: { type: "hello", role: "extension", browser, extensionId, version, protocol, perms: { disabled } }
//   MCP  -> EXT: { type: "welcome", protocol: 2, pid }
//   MCP  -> EXT: { id, action, tabId?, payload?, timeoutMs }   (command)
//   EXT  -> MCP: { id, ok, result?, error? }                    (response, only from the socket the command went to)
//   EXT  -> MCP: { type: "event", kind: "console" | "network" | "perms", data }
//   SAT  -> MCP: { type: "auth", token }  -> MCP replies { type: "auth_ok", pid }
//   SAT  -> MCP: { id, action, payload?, tabId?, timeoutMs?, launch? }  (relay / control plane)
//   MCP  -> SAT: every accepted extension event is broadcast unchanged.

export interface BridgeRequest {
  id: string;
  action: string;
  tabId?: number;
  payload?: unknown;
  /** Server-side timeout for this command (ms). */
  timeoutMs?: number;
  /** Satellite -> primary only: the satellite's own launch preferences. */
  launch?: LaunchPrefs;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Socket the request was sent on; only that socket may answer it. */
  ws: WebSocket;
  action: string;
};

/** Fields every bridge reports for browser_status (spread into the tool result). */
export interface BridgeStatusInfo {
  /** Which side of the sharing this process is. */
  mode: "primary" | "satellite";
  /** OS pid of the process answering (primary) or of this satellite. */
  pid: number;
  /**
   * Number of authenticated satellites/CLI clients on the primary.
   * -1 when unknown (satellite that hasn't polled yet).
   */
  peers: number;
  /** Extension sockets that completed the hello handshake. */
  extensions?: number;
  /** Effective trusted extension ids (["*"] in legacy accept-all mode). */
  trustedExtensionIds?: string[];
  /** Last (up to 10) extension ids that were refused with 4003. */
  rejectedExtensionIds?: string[];
  /** True while trust-on-first-use pairing is still open. */
  tofuOpen?: boolean;
  /** Directory holding the token / trust / sticky-browser files. */
  configDir?: string;
}

/** Reply of the `__bridge_status` control action. */
export interface BridgeStatus extends BridgeStatusInfo {
  connected: boolean;
  wsPort: number;
  consoleBuffered: number;
  networkBuffered: number;
  /** Last permission snapshot reported by the extension (null = unknown). */
  disabled?: string[] | null;
}

export interface IBridge {
  readonly port: number;
  readonly connected: boolean;
  readonly mode: "primary" | "satellite";
  consoleEvents: Array<unknown>;
  networkEvents: Array<unknown>;
  /** Extra status fields for browser_status (mode/pid/peers/trust info). */
  status(): BridgeStatusInfo;
  /** Last disabled-actions snapshot from the extension (hello / perms events); null = unknown. */
  knownDisabled(): string[] | null;
  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs?: number): Promise<T>;
  launchBrowser(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }>;
  closeBrowser(force?: boolean): Promise<{ closed: boolean; detail: string }>;
  close(): void;
}

export type BrowserId = "chrome" | "edge" | "brave" | "opera";

/** Launch preferences a satellite forwards so the primary honours them (A10). */
export interface LaunchPrefs {
  /** false = never auto-launch a browser for this caller's commands. */
  auto?: boolean;
  /** Preferred browser family for launches triggered by this caller. */
  browser?: BrowserId;
}

/** Friendly BROWSER= names (also accepts raw paths / exe names at launch). */
export function normalizeBrowserId(input: string): BrowserId | null {
  const v = input.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (v === "chrome" || v === "googlechrome" || v === "chromium") return "chrome";
  if (v === "edge" || v === "microsoftedge" || v === "msedge") return "edge";
  if (v === "brave" || v === "bravebrowser") return "brave";
  if (v === "opera" || v === "operastable") return "opera";
  return null;
}

/** Best-effort browser family of a binary path / exe name. */
function browserIdFromBin(bin: string): BrowserId | null {
  const b = bin.toLowerCase();
  if (/msedge|microsoft[ -]edge/.test(b)) return "edge";
  if (/brave/.test(b)) return "brave";
  if (/opera/.test(b)) return "opera";
  if (/chrome|chromium/.test(b)) return "chrome";
  return null;
}

function asBrowserId(v: unknown): BrowserId | null {
  return v === "chrome" || v === "edge" || v === "brave" || v === "opera" ? v : null;
}

// ---------- constants ----------

/** Edge Add-ons store id of Browser MCP (always trusted). */
const BUILTIN_EXTENSION_IDS = ["hdhibkihdkndmfecegdnbpebolhokkbh"];
const PROTOCOL_VERSION = 2;
/** Large results (full-page screenshots, PDFs, audio) travel as one frame. */
const MAX_PAYLOAD = 256 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5000;
const RELAY_TIMEOUT_DEFAULT = 30000;
const RELAY_TIMEOUT_MIN = 1000;
const RELAY_TIMEOUT_MAX = 7_200_000;
const MAX_REJECTED = 10;
const MAX_BUF = 1000;
/** Events above this size are dropped (the extension caps them at ~1 MiB). */
const EVENT_MAX_CHARS = 2 * 1024 * 1024;
/** Skip event broadcasts to a satellite whose socket is this far behind. */
const BROADCAST_BACKLOG_LIMIT = 16 * 1024 * 1024;
/**
 * After a fresh bind (startup / failover) or an extension drop, the extension
 * usually reconnects within its backoff (<= 10 s). Wait this long before
 * auto-launching a browser so we don't open stray windows (A6).
 */
const RECONNECT_GRACE_MS = 12000;
/** After a failed auto-launch, fail fast for this long instead of relaunching. */
const AUTO_LAUNCH_COOLDOWN_MS = 60000;
const SATELLITE_READY_DEADLINE_MS = 15000;
const STATUS_POLL_MS = 3000;
const STATUS_TIMEOUT_MS = 8000;
const STATUS_FAILS_BEFORE_FAILOVER = 3;

const EXT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXT_ORIGIN_RE = /^(?:chrome-extension|moz-extension):\/\/([A-Za-z0-9_-]{1,64})\/?$/;

// ---------- small helpers ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rawToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  return String(raw);
}

function pushRing(arr: Array<unknown>, item: unknown): void {
  arr.push(item);
  if (arr.length > MAX_BUF * 1.2) arr.splice(0, arr.length - MAX_BUF);
}

function parseDisabled(v: unknown): string[] | null {
  const arr = isPlainObject(v) ? v.disabled : undefined;
  if (!Array.isArray(arr)) return null;
  return arr.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, 1000);
}

function clampTimeout(v: unknown, def = RELAY_TIMEOUT_DEFAULT): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(RELAY_TIMEOUT_MAX, Math.max(RELAY_TIMEOUT_MIN, Math.round(n)));
}

function parseLaunchPrefs(v: unknown): LaunchPrefs | null {
  if (!isPlainObject(v)) return null;
  const out: LaunchPrefs = {};
  if (typeof v.auto === "boolean") out.auto = v.auto;
  const b = asBrowserId(v.browser);
  if (b) out.browser = b;
  return out;
}

function headerOrigin(req: IncomingMessage | undefined): string | null {
  const o = req?.headers?.origin;
  const v = Array.isArray(o) ? o[0] : o;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function extensionIdFromOrigin(origin: string): string | null {
  const m = EXT_ORIGIN_RE.exec(origin);
  return m ? m[1].toLowerCase() : null;
}

function envLaunchTimeoutMs(): number {
  const v = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS ?? 45000);
  return Number.isFinite(v) && v > 0 ? v : 45000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

// ---------- config directory (tokens, trusted ids, sticky browser, last permission snapshot) ----------

let ensuredConfigDir: string | null = null;

/**
 * Per-user config directory: BROWSER_MCP_HOME or ~/.browser-mcp (created
 * with owner-only permissions where the OS supports POSIX modes).
 */
export function configDir(): string {
  const dir = (process.env.BROWSER_MCP_HOME ?? "").trim() || path.join(os.homedir(), ".browser-mcp");
  if (ensuredConfigDir !== dir) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      ensuredConfigDir = dir;
    } catch (e) {
      console.error(`[bridge:${process.pid}] cannot create config dir ${dir}: ${(e as Error)?.message ?? e}`);
    }
  }
  return dir;
}

/** Write a user-private file (0600), atomically where the OS allows it. */
function writePrivateFile(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // rename can fail on Windows while a reader holds the file open.
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(file, data, { mode: 0o600 });
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

function tokenFile(port: number): string {
  return path.join(configDir(), `bridge-${port}.token`);
}

function readTokenFile(port: number): string | null {
  try {
    const t = fs.readFileSync(tokenFile(port), "utf8").trim();
    return /^[0-9a-f]{64}$/i.test(t) ? t : null;
  } catch {
    return null;
  }
}

function trustedFile(): string {
  return path.join(configDir(), "trusted-extensions.json");
}

type TrustedFileState = { ids: string[]; state: "missing" | "ok" | "corrupt" };

function readTrustedFile(): TrustedFileState {
  let text: string;
  try {
    text = fs.readFileSync(trustedFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ids: [], state: "missing" };
    return { ids: [], state: "corrupt" };
  }
  if (!text.trim()) return { ids: [], state: "missing" };
  try {
    const j = JSON.parse(text) as unknown;
    if (!isPlainObject(j) || (j.ids !== undefined && !Array.isArray(j.ids))) return { ids: [], state: "corrupt" };
    const ids = (Array.isArray(j.ids) ? j.ids : [])
      .filter((x): x is string => typeof x === "string" && EXT_ID_RE.test(x))
      .map((x) => x.toLowerCase());
    return { ids: [...new Set(ids)], state: "ok" };
  } catch {
    return { ids: [], state: "corrupt" };
  }
}

/** Record an extension id in trusted-extensions.json. Never overwrites a corrupt file. */
function addTrustedFileId(id: string): boolean {
  const cur = readTrustedFile();
  if (cur.state === "corrupt") return false;
  if (cur.ids.includes(id)) return true;
  try {
    writePrivateFile(trustedFile(), JSON.stringify({ ids: [...cur.ids, id] }, null, 2) + "\n");
    return true;
  } catch (e) {
    console.error(`[bridge:${process.pid}] cannot write ${trustedFile()}: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

/** Split a comma separated id list ("*" = accept any extension). */
function parseIdList(values: Array<string | undefined | null>): { ids: string[]; wildcard: boolean } {
  const ids: string[] = [];
  let wildcard = false;
  for (const v of values) {
    if (!v) continue;
    for (const part of v.split(",")) {
      const s = part.trim().toLowerCase();
      if (!s) continue;
      if (s === "*") {
        wildcard = true;
        continue;
      }
      if (EXT_ID_RE.test(s)) ids.push(s);
      else console.error(`[bridge:${process.pid}] ignoring invalid extension id ${JSON.stringify(part.trim())}`);
    }
  }
  return { ids: [...new Set(ids)], wildcard };
}

// ---------- primary bridge ----------

type PeerState = {
  kind: "extension" | "client";
  /** Extension id from the Origin header (extension sockets only). */
  extId: string | null;
  /** client: token verified; extension: hello accepted (trusted). */
  authed: boolean;
  /** Socket is being closed by us (rejected); ignore further frames. */
  closing: boolean;
  helloAt: number;
  browser: BrowserId | null;
  version: string | null;
  disabled: string[] | null;
  authTimer: ReturnType<typeof setTimeout> | null;
};

export interface ExtensionBridgeOptions {
  exitOnAddrInUse?: boolean;
  /** Extra trusted extension ids (e.g. from --extension-id). "*" = accept any. */
  extensionIds?: string[];
}

export class ExtensionBridge implements IBridge {
  public readonly port: number;
  private wss: WebSocketServer;
  private peers = new Map<WebSocket, PeerState>();
  /** Extension socket that most recently completed hello; receives commands. */
  private active: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readySettled = false;
  private exitOnAddrInUse: boolean;
  // Sticky browser: the browser that last connected the extension
  // (reported via hello). Preferred on the next launch.
  private lastBrowser: BrowserId | null = null;
  // Singleflight: N satellites may call launchBrowser concurrently while the
  // extension is down. Without this each caller spawns its own browser(s).
  private launchInflight: Promise<{ connected: boolean; launched: boolean; detail: string }> | null = null;
  private autoLaunchFailure: { at: number; detail: string } | null = null;
  private connWaiters = new Set<() => void>();
  private listeningAt = 0;
  private lastExtDropAt = 0;
  private lastDisabled: string[] | null = null;
  // lastDisabled was loaded from perms-<port>.json (previous run), not yet
  // confirmed by a live hello / perms event.
  private disabledFromDisk = false;
  // Last snapshot written to perms-<port>.json (skips redundant writes).
  private persistedPerms: string | null = null;
  private readonly token = crypto.randomBytes(32).toString("hex");
  private readonly explicitIds: Set<string>;
  private readonly wildcard: boolean;
  /** Explicit list given (env/CLI): no trust-on-first-use. */
  private readonly strict: boolean;
  private sessionTrusted = new Set<string>();
  private rejected: string[] = [];
  private logThrottle = new Map<string, number>();

  // ring buffers for pushed events (so tools work even with polling)
  consoleEvents: Array<unknown> = [];
  networkEvents: Array<unknown> = [];

  constructor(port: number, opts?: ExtensionBridgeOptions) {
    this.port = port;
    this.exitOnAddrInUse = opts?.exitOnAddrInUse ?? true;
    const parsed = parseIdList([process.env.BROWSER_MCP_EXTENSION_IDS, ...(opts?.extensionIds ?? [])]);
    this.explicitIds = new Set(parsed.ids);
    this.wildcard = parsed.wildcard;
    this.strict = !parsed.wildcard && parsed.ids.length > 0;
    // Last permission snapshot from a previous run (F14): browser_close stays
    // refused after a restart while the extension is silent. A hello or perms
    // event from the extension replaces it.
    const persisted = this.readPersistedPerms();
    if (persisted) {
      this.lastDisabled = persisted;
      this.disabledFromDisk = true;
      this.enforceEventPerms();
    }
    this.wss = new WebSocketServer({
      port,
      host: "127.0.0.1",
      maxPayload: MAX_PAYLOAD,
      // Refuse web pages during the HTTP upgrade (403): a page then sees a
      // generic connection failure, indistinguishable from a closed port (A14).
      verifyClient: (info, cb) => {
        try {
          const origin = headerOrigin(info.req) ?? (typeof info.origin === "string" && info.origin ? info.origin : null);
          if (origin !== null && !extensionIdFromOrigin(origin)) {
            this.logThrottled(`origin:${origin}`, `rejected WS upgrade from origin ${origin.slice(0, 200)}`);
            cb(false, 403, "Forbidden");
            return;
          }
          cb(true);
        } catch {
          cb(false, 400, "Bad Request");
        }
      },
    });
    this.wss.on("connection", (ws, req) => {
      try {
        this.onConnection(ws, req);
      } catch (e) {
        console.error(`[bridge:${process.pid}] connection handler failed: ${(e as Error)?.message ?? e}`);
        try { ws.terminate(); } catch {}
      }
    });
    this.wss.on("error", (e) => {
      // A server that cannot bind its port is useless (and would linger as a
      // zombie holding no browser connection). Exit so the MCP client restarts us,
      // unless the caller wants to fall back to satellite (client) mode.
      const code = (e as { code?: string })?.code;
      if (code === "EADDRINUSE" && !this.exitOnAddrInUse) {
        // Expected on every satellite startup: keep it a one-liner, the full
        // Bun code-frame dump looks like a crash and scares users.
        console.error(`[bridge:${process.pid}] port ${port} in use, will join as satellite`);
      } else {
        console.error(`[bridge:${process.pid}] wss error`, e);
      }
      if (!this.readySettled) {
        this.readySettled = true;
        if (code === "EADDRINUSE" && !this.exitOnAddrInUse) {
          this.readyReject?.(Object.assign(new Error(`Port ${port} already in use`), { code }));
          return;
        }
        if (!(code === "EADDRINUSE")) {
          this.readyReject?.(e as Error);
        }
      }
      if (code === "EADDRINUSE" && this.exitOnAddrInUse) process.exit(1);
    });
    this.wss.on("listening", () => {
      this.listeningAt = Date.now();
      console.error(`[bridge:${process.pid}] ws listening on ws://127.0.0.1:${port} (primary)`);
      // Satellites / CLI scripts authenticate with this per-run token.
      try {
        writePrivateFile(tokenFile(port), this.token);
      } catch (e) {
        console.error(`[bridge:${process.pid}] cannot write bridge token ${tokenFile(port)} (satellites will be refused): ${(e as Error)?.message ?? e}`);
      }
      if (this.wildcard) {
        console.error(`[bridge:${process.pid}] WARNING: BROWSER_MCP_EXTENSION_IDS=* accepts ANY browser extension as the bridge extension (legacy mode)`);
      } else if (this.tofuOpen()) {
        console.error(`[bridge:${process.pid}] no trusted extension paired yet; the first extension that connects will be trusted (${trustedFile()})`);
      }
      if (!this.readySettled) {
        this.readySettled = true;
        this.readyResolve?.();
      }
    });
  }

  /** Resolves when the WS server is listening, rejects on bind failure. */
  ready(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.readySettled) {
        // Already settled: check if we are actually listening.
        const addr = this.wss.address();
        if (addr) resolve();
        else reject(new Error(`Bridge on :${this.port} failed to bind`));
        return;
      }
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  get connected(): boolean {
    return this.active !== null && this.active.readyState === WebSocket.OPEN;
  }

  get mode(): "primary" | "satellite" {
    return "primary";
  }

  /** Authenticated satellite / CLI sockets on this bridge. */
  peerCount(): number {
    let n = 0;
    for (const [ws, p] of this.peers) {
      if (p.kind === "client" && p.authed && ws.readyState === WebSocket.OPEN) n++;
    }
    return n;
  }

  private extensionCount(): number {
    let n = 0;
    for (const [ws, p] of this.peers) {
      if (p.kind === "extension" && p.authed && ws.readyState === WebSocket.OPEN) n++;
    }
    return n;
  }

  status(): BridgeStatusInfo {
    return {
      mode: "primary",
      pid: process.pid,
      peers: this.peerCount(),
      extensions: this.extensionCount(),
      trustedExtensionIds: this.trustedIds(),
      rejectedExtensionIds: [...this.rejected],
      tofuOpen: this.tofuOpen(),
      configDir: configDir(),
    };
  }

  private fullStatus(): BridgeStatus {
    return {
      connected: this.connected,
      wsPort: this.port,
      consoleBuffered: this.consoleEvents.length,
      networkBuffered: this.networkEvents.length,
      ...this.status(),
      disabled: this.knownDisabled(),
    };
  }

  knownDisabled(): string[] | null {
    return this.lastDisabled ? [...this.lastDisabled] : null;
  }

  /**
   * @internal Used by BridgeClient when a satellite promotes itself: carry
   * over the last permission snapshot and buffered events.
   */
  adoptState(s: { disabled: string[] | null; consoleEvents: Array<unknown>; networkEvents: Array<unknown> }): void {
    // The satellite's snapshot came from the live primary, so it beats one
    // loaded from disk (but never one this bridge got from a live hello).
    if (s.disabled && (this.lastDisabled === null || this.disabledFromDisk)) {
      this.lastDisabled = [...s.disabled];
      this.disabledFromDisk = false;
      this.persistPerms();
    }
    if (!this.consoleEvents.length) for (const e of s.consoleEvents.slice(-MAX_BUF)) this.consoleEvents.push(e);
    if (!this.networkEvents.length) for (const e of s.networkEvents.slice(-MAX_BUF)) this.networkEvents.push(e);
    this.enforceEventPerms();
  }

  // ----- trust -----

  private trustedIds(): string[] {
    if (this.wildcard) return ["*"];
    const all = new Set<string>([...BUILTIN_EXTENSION_IDS, ...this.explicitIds, ...this.sessionTrusted, ...readTrustedFile().ids]);
    return [...all].sort();
  }

  private isTrusted(id: string): boolean {
    if (this.wildcard) return true;
    if (BUILTIN_EXTENSION_IDS.includes(id) || this.explicitIds.has(id) || this.sessionTrusted.has(id)) return true;
    return readTrustedFile().ids.includes(id);
  }

  /** Trust-on-first-use is open until the first extension is paired. */
  tofuOpen(): boolean {
    if (this.wildcard || this.strict || this.sessionTrusted.size > 0) return false;
    const t = readTrustedFile();
    return t.state === "missing" || (t.state === "ok" && t.ids.length === 0);
  }

  private logThrottled(key: string, line: string, everyMs = 60000): void {
    const now = Date.now();
    const last = this.logThrottle.get(key) ?? 0;
    if (now - last < everyMs) return;
    if (this.logThrottle.size > 200) this.logThrottle.clear();
    this.logThrottle.set(key, now);
    console.error(`[bridge:${process.pid}] ${line}`);
  }

  private rejectExtension(ws: WebSocket, peer: PeerState): void {
    const id = peer.extId ?? "unknown";
    peer.closing = true;
    this.rejected = this.rejected.filter((x) => x !== id);
    this.rejected.push(id);
    if (this.rejected.length > MAX_REJECTED) this.rejected.splice(0, this.rejected.length - MAX_REJECTED);
    this.logThrottled(
      `ext:${id}`,
      `refused untrusted extension ${id} (trust it via BROWSER_MCP_EXTENSION_IDS / --extension-id or ${trustedFile()})`
    );
    try {
      ws.close(4003, `untrusted-extension:${id}`.slice(0, 120));
    } catch {
      try { ws.terminate(); } catch {}
    }
  }

  // ----- sockets -----

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const origin = headerOrigin(req);
    let peer: PeerState;
    if (origin !== null) {
      const extId = extensionIdFromOrigin(origin);
      if (!extId) {
        // verifyClient already refuses these; defense in depth.
        try { ws.terminate(); } catch {}
        return;
      }
      peer = { kind: "extension", extId, authed: false, closing: false, helloAt: 0, browser: null, version: null, disabled: null, authTimer: null };
    } else {
      peer = { kind: "client", extId: null, authed: false, closing: false, helloAt: 0, browser: null, version: null, disabled: null, authTimer: null };
    }
    this.peers.set(ws, peer);
    ws.on("message", (raw) => {
      try {
        this.onMessage(ws, rawToText(raw));
      } catch (e) {
        console.error(`[bridge:${process.pid}] bad frame ignored: ${(e as Error)?.message ?? e}`);
      }
    });
    ws.on("close", () => {
      try {
        this.onClose(ws);
      } catch (e) {
        console.error(`[bridge:${process.pid}] close handler failed: ${(e as Error)?.message ?? e}`);
      }
    });
    ws.on("error", (e) => console.error(`[bridge:${process.pid}] ws error: ${(e as Error)?.message ?? e}`));

    if (peer.kind === "extension") {
      // Untrusted id and pairing closed: refuse right away (the extension
      // shows the 4003 reason in its popup).
      if (!this.isTrusted(peer.extId!) && !this.tofuOpen()) this.rejectExtension(ws, peer);
      return;
    }
    peer.authTimer = setTimeout(() => {
      peer.authTimer = null;
      if (!peer.authed) this.refuseClient(ws, peer);
    }, AUTH_TIMEOUT_MS);
  }

  private refuseClient(ws: WebSocket, peer: PeerState): void {
    peer.closing = true;
    if (peer.authTimer) {
      clearTimeout(peer.authTimer);
      peer.authTimer = null;
    }
    try {
      ws.close(4001, "auth-required");
    } catch {
      try { ws.terminate(); } catch {}
    }
  }

  private onClose(ws: WebSocket): void {
    const peer = this.peers.get(ws);
    this.peers.delete(ws);
    if (peer?.authTimer) clearTimeout(peer.authTimer);
    // Reject only the requests that were sent to this socket.
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error("Extension disconnected"));
    }
    if (!peer || peer.kind !== "extension" || !peer.authed || this.active !== ws) return;
    this.active = null;
    // Fall back to the most recently hello'd other open extension socket.
    let best: [WebSocket, PeerState] | null = null;
    for (const [s, p] of this.peers) {
      if (p.kind !== "extension" || !p.authed || p.closing || s.readyState !== WebSocket.OPEN) continue;
      if (!best || p.helloAt > best[1].helloAt) best = [s, p];
    }
    if (best) {
      this.active = best[0];
      console.error(`[bridge:${process.pid}] extension ${peer.extId} disconnected, switched to ${best[1].extId} (${best[1].browser ?? "?"})`);
      this.applyActivePerms();
      this.notifyConnected();
    } else {
      this.lastExtDropAt = Date.now();
      console.error(`[bridge:${process.pid}] extension disconnected`);
    }
  }

  private onMessage(ws: WebSocket, text: string): void {
    const peer = this.peers.get(ws);
    if (!peer || peer.closing) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // Only JSON objects are protocol messages (`null`, numbers, arrays: ignored).
    if (!isPlainObject(msg)) return;
    if (peer.kind === "extension") this.onExtensionMessage(ws, peer, msg, text);
    else this.onClientMessage(ws, peer, msg);
  }

  // ----- extension side -----

  private onExtensionMessage(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>, text: string): void {
    if (msg.type === "hello") {
      if (msg.role === "extension") this.onHello(ws, peer, msg);
      return;
    }
    // Nothing but hello is accepted before the extension is trusted.
    if (!peer.authed) return;
    if (msg.type === "event") {
      this.onEvent(ws, peer, msg, text);
      return;
    }
    if (typeof msg.id !== "string") return; // ping and unknown frames
    // Response: accepted only from the socket the command was sent to.
    const p = this.pending.get(msg.id);
    if (!p || p.ws !== ws) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    const res = msg as unknown as BridgeResponse;
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error((typeof res.error === "string" && res.error) || "extension error"));
  }

  private onHello(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>): void {
    const id = peer.extId!;
    let pinned = false;
    if (!this.isTrusted(id)) {
      if (!this.tofuOpen()) {
        this.rejectExtension(ws, peer);
        return;
      }
      pinned = true;
    }
    // Record every accepted extension (closes trust-on-first-use after the
    // first pairing). Legacy accept-all mode records nothing.
    if (!this.wildcard) {
      this.sessionTrusted.add(id);
      if (!addTrustedFileId(id)) {
        console.error(`[bridge:${process.pid}] could not record extension ${id} in ${trustedFile()} (kept for this session only)`);
      }
    }
    if (pinned) {
      console.error(`[bridge:${process.pid}] paired with extension ${id} (trust-on-first-use, saved to ${trustedFile()})`);
      // Pairing is now closed: drop other not-yet-trusted extension sockets.
      for (const [s, p] of this.peers) {
        if (s !== ws && p.kind === "extension" && !p.authed && !p.closing && !this.isTrusted(p.extId!)) this.rejectExtension(s, p);
      }
    }
    const claimedId = typeof msg.extensionId === "string" ? msg.extensionId.toLowerCase() : null;
    if (claimedId && claimedId !== id) {
      console.error(`[bridge:${process.pid}] extension hello claims id ${claimedId.slice(0, 64)} but its Origin is ${id}; using the Origin`);
    }
    const wasActive = this.active === ws;
    peer.authed = true;
    peer.helloAt = Date.now();
    peer.browser = asBrowserId(msg.browser);
    peer.version = typeof msg.version === "string" ? msg.version.slice(0, 32) : null;
    const perms = parseDisabled(msg.perms);
    if (perms) peer.disabled = perms;
    // Sticky browser: remember which browser holds the extension so the
    // next launch opens the same one (not hardcoded Chrome-first).
    if (peer.browser) this.rememberBrowser(peer.browser);
    // The most recent hello owns the extension role (never events/responses).
    this.active = ws;
    this.autoLaunchFailure = null;
    if (!wasActive) {
      console.error(
        `[bridge:${process.pid}] extension connected id=${id} browser=${peer.browser ?? "?"}${peer.version ? ` v${peer.version}` : ""} (peers=${this.peerCount()}, extensions=${this.extensionCount()})`
      );
    }
    try {
      ws.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION, pid: process.pid }));
    } catch {}
    this.applyActivePerms();
    this.notifyConnected();
  }

  /** Take over the active extension's permission snapshot and tell satellites. */
  private applyActivePerms(): void {
    const peer = this.active ? this.peers.get(this.active) : undefined;
    if (!peer?.disabled) return;
    this.lastDisabled = [...peer.disabled];
    this.disabledFromDisk = false;
    this.persistPerms();
    this.enforceEventPerms();
    this.broadcast(JSON.stringify({ type: "event", kind: "perms", data: { disabled: this.lastDisabled } }));
  }

  /** Per-port permission snapshot file in the per-user config dir (F14). */
  private permsFile(): string {
    return path.join(configDir(), `perms-${this.port}.json`);
  }

  private readPersistedPerms(): string[] | null {
    try {
      const d = parseDisabled(JSON.parse(fs.readFileSync(this.permsFile(), "utf8")));
      if (d) this.persistedPerms = JSON.stringify({ disabled: d });
      return d;
    } catch {
      return null;
    }
  }

  /** Remember the last known snapshot across restarts (browser_close force check). */
  private persistPerms(): void {
    if (!this.lastDisabled) return;
    const data = JSON.stringify({ disabled: this.lastDisabled });
    if (data === this.persistedPerms) return;
    try {
      writePrivateFile(this.permsFile(), data);
      this.persistedPerms = data;
    } catch (e) {
      this.logThrottled("perms-file", `cannot write ${this.permsFile()}: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Server-side buffers follow the console/network permission switches (F13). */
  private enforceEventPerms(): void {
    const d = this.lastDisabled;
    if (!d) return;
    if (d.includes("console_get")) this.consoleEvents.length = 0;
    if (d.includes("network_requests")) this.networkEvents.length = 0;
  }

  private onEvent(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>, text: string): void {
    const kind = msg.kind;
    if (kind === "perms") {
      const d = parseDisabled(msg.data);
      if (!d) return;
      peer.disabled = d;
      if (ws === this.active) this.applyActivePerms();
      return;
    }
    if (kind !== "console" && kind !== "network") return;
    if (text.length > EVENT_MAX_CHARS) return;
    const disabled = peer.disabled ?? this.lastDisabled;
    if (kind === "console") {
      if (disabled?.includes("console_get")) return;
      pushRing(this.consoleEvents, msg.data);
    } else {
      if (disabled?.includes("network_requests")) return;
      pushRing(this.networkEvents, msg.data);
    }
    this.broadcast(text);
  }

  /** Forward a frame to every authenticated satellite. */
  private broadcast(text: string): void {
    for (const [s, p] of this.peers) {
      if (p.kind !== "client" || !p.authed || p.closing || s.readyState !== WebSocket.OPEN) continue;
      // Don't let one stalled satellite pile up unbounded memory.
      if ((s.bufferedAmount ?? 0) > BROADCAST_BACKLOG_LIMIT) continue;
      try { s.send(text); } catch {}
    }
  }

  private notifyConnected(): void {
    for (const w of [...this.connWaiters]) {
      try { w(); } catch {}
    }
  }

  // ----- satellite / CLI side -----

  private checkToken(token: unknown): boolean {
    if (typeof token !== "string") return false;
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(this.token, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private onClientMessage(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>): void {
    if (!peer.authed) {
      // The first frame must be a valid auth; anything else is refused.
      if (msg.type === "auth" && this.checkToken(msg.token)) {
        peer.authed = true;
        if (peer.authTimer) {
          clearTimeout(peer.authTimer);
          peer.authTimer = null;
        }
        try { ws.send(JSON.stringify({ type: "auth_ok", pid: process.pid })); } catch {}
        return;
      }
      this.refuseClient(ws, peer);
      return;
    }
    // Origin-less sockets can never become the extension.
    if (typeof msg.type === "string") return;
    if (typeof msg.action !== "string" || typeof msg.id !== "string") return;
    this.handleRelay(ws, msg);
  }

  private handleRelay(ws: WebSocket, msg: Record<string, unknown>): void {
    const action = msg.action as string;
    const replyId = msg.id as string;
    const reply = (ok: boolean, result?: unknown, error?: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ id: replyId, ok, result, error }));
      } catch (e) {
        // e.g. a result that cannot be serialized
        try { ws.send(JSON.stringify({ id: replyId, ok: false, error: `relay failed: ${(e as Error)?.message ?? e}` })); } catch {}
      }
    };
    const fail = (err: unknown) => reply(false, undefined, (err as Error)?.message ?? String(err));
    const payload = isPlainObject(msg.payload) ? msg.payload : undefined;
    // Satellite control plane: handled locally, never forwarded to the extension.
    if (action.startsWith("__")) {
      if (action === "__bridge_status") {
        reply(true, this.fullStatus());
      } else if (action === "__launchBrowser") {
        const t = typeof payload?.timeoutMs === "number" ? clampTimeout(payload.timeoutMs) : undefined;
        const browser = asBrowserId(payload?.browser) ?? undefined;
        this.launchBrowser(t, { browser }).then((r) => reply(true, r), fail);
      } else if (action === "__closeBrowser") {
        this.closeBrowser(payload?.force === true).then((r) => reply(true, r), fail);
      } else {
        reply(false, undefined, `Unknown bridge control action: ${action.slice(0, 64)}`);
      }
      return;
    }
    const tabId = typeof msg.tabId === "number" && Number.isFinite(msg.tabId) ? msg.tabId : undefined;
    this.sendWithLaunch(action, msg.payload, tabId, clampTimeout(msg.timeoutMs), parseLaunchPrefs(msg.launch)).then(
      (r) => reply(true, r),
      fail
    );
  }

  // ----- browser launch -----

  get autoLaunch(): boolean {
    return process.env.BROWSER_AUTO_LAUNCH !== "0";
  }

  get launchTimeoutMs(): number {
    return envLaunchTimeoutMs();
  }

  /**
   * Explicit browser choice: BROWSER_PATH (full path or exe name) first,
   * then BROWSER= (friendly name like "edge", or a path), then legacy
   * CHROME_PATH. Returns null when nothing usable was configured.
   */
  private explicitBrowserBin(): string | null {
    const byPath = (v: string): string | null => {
      try {
        fs.accessSync(v);
        return v;
      } catch {}
      try {
        return Bun.which(v) ?? null;
      } catch {}
      return null;
    };
    if (process.env.BROWSER_PATH) {
      const r = byPath(process.env.BROWSER_PATH);
      if (r) return r;
    }
    const name = (process.env.BROWSER ?? "").trim();
    if (name) {
      const asPath = byPath(name);
      if (asPath) return asPath;
      const id = normalizeBrowserId(name);
      if (id) {
        const b = this.resolveBrowserBin(id);
        if (b) return b;
      }
      console.error(`[bridge:${process.pid}] unknown BROWSER=${JSON.stringify(name)} (want chrome|edge|brave|opera or a binary path), ignoring`);
    }
    if (process.env.CHROME_PATH) {
      const r = byPath(process.env.CHROME_PATH);
      if (r) return r;
    }
    return null;
  }

  /**
   * Start the browser (if needed) and wait for the extension to connect.
   * `prefs.browser` (from a satellite) is tried first.
   */
  async launchBrowser(timeoutMs?: number, prefs?: LaunchPrefs): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.connected) return { connected: true, launched: false, detail: "Extension already connected." };
    // Singleflight: join the in-flight launch instead of spawning more browsers.
    if (this.launchInflight) return await this.launchInflight;
    this.launchInflight = this.launchBrowserInner(timeoutMs, prefs?.browser ?? null);
    try {
      const r = await this.launchInflight;
      if (r.connected) this.autoLaunchFailure = null;
      return r;
    } finally {
      this.launchInflight = null;
    }
  }

  private async launchBrowserInner(timeoutMs: number | undefined, preferred: BrowserId | null): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.connected) return { connected: true, launched: false, detail: "Extension already connected." };
    const wait = timeoutMs ?? this.launchTimeoutMs;
    const deadline = Date.now() + wait;
    const running = await this.runningBrowsers();
    const sticky = this.lastBrowser ?? this.readStickyBrowser();
    const def = this.defaultBrowserId();

    // Ordered browser ids: caller preference -> explicit BROWSER= -> sticky ->
    // running -> OS default -> Chrome/Edge/Brave/Opera.
    const ids: Array<BrowserId> = [];
    const pushId = (id: BrowserId) => {
      if (!ids.includes(id)) ids.push(id);
    };
    const explicitName = (process.env.BROWSER ?? "").trim();
    const explicitId = explicitName ? normalizeBrowserId(explicitName) : null;
    const explicit = this.explicitBrowserBin();
    if (preferred) pushId(preferred);
    if (explicitId) pushId(explicitId);
    if (sticky) pushId(sticky);
    (["chrome", "edge", "brave", "opera"] as const).forEach((id) => {
      if (running[id]) pushId(id);
    });
    if (def) pushId(def);
    pushId("chrome");
    pushId("edge");
    pushId("brave");
    pushId("opera");
    // Browsers with a positive signal are all tried; the rest only as a single
    // fallback. A running process (e.g. Edge background processes) or the OS
    // default only counts as a signal when nothing better is known (A6).
    const signaled = new Set<string>();
    if (preferred) signaled.add(preferred);
    if (explicitId) signaled.add(explicitId);
    if (sticky) signaled.add(sticky);
    if (!preferred && !explicitId && !explicit && !sticky) {
      (["chrome", "edge", "brave", "opera"] as const).forEach((id) => {
        if (running[id]) signaled.add(id);
      });
      if (def) signaled.add(def);
    }

    // Resolve to binaries. Total time is capped by the requested timeout;
    // each attempt gets at most 20s.
    const attempts: string[] = [];
    const seen = new Set<string>();
    const pushBin = (b: string | null) => {
      if (b && !seen.has(b)) {
        seen.add(b);
        attempts.push(b);
      }
    };
    if (preferred) pushBin(this.resolveBrowserBin(preferred));
    pushBin(explicit);
    let fallbackUsed = false;
    for (const id of ids) {
      const hasSignal = signaled.has(id);
      if (!hasSignal && fallbackUsed) continue;
      const b = this.resolveBrowserBin(id);
      if (!b || seen.has(b)) continue;
      pushBin(b);
      if (!hasSignal) fallbackUsed = true;
    }

    if (!attempts.length) {
      return { connected: false, launched: false, detail: "No Chromium browser found. Set BROWSER=chrome|edge|brave|opera or BROWSER_PATH to your browser binary, or open the browser holding the extension manually." };
    }
    const extPages = [...new Set(attempts.map((b) => this.extPageFor(b)))].join(" / ");
    let spawned = false;
    for (const b of attempts) {
      if (this.connected) break;
      const remaining = deadline - Date.now();
      if (remaining < 3000) break;
      try {
        const proc = Bun.spawn([b, "--new-window", "about:blank"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        proc.unref();
        spawned = true;
      } catch {}
      const ok = await this.waitForConnection(Math.min(20000, remaining));
      if (ok) {
        return { connected: true, launched: true, detail: `Extension connected via ${b}.` };
      }
    }
    if (this.connected) return { connected: true, launched: spawned, detail: "Extension connected." };
    const rejectedHint = this.rejected.length
      ? ` Extension id(s) ${this.rejected.join(", ")} connected but are not trusted: add them to BROWSER_MCP_EXTENSION_IDS / --extension-id or ${trustedFile()}.`
      : "";
    return {
      connected: false,
      launched: spawned,
      detail: `Tried ${attempts.join(", ")} but the extension did not connect. Open the browser where Browser MCP is installed (${extPages} -> enable it), or set BROWSER=chrome|edge|brave|opera (or BROWSER_PATH) to that browser. The choice is remembered after the first connection.${rejectedHint}`,
    };
  }

  private extPageFor(bin: string): string {
    if (/msedge/i.test(bin)) return "edge://extensions";
    if (/brave/i.test(bin)) return "brave://extensions";
    if (/opera/i.test(bin)) return "opera://extensions";
    return "chrome://extensions";
  }

  private browserPaths(id: string): string[] {
    const out: string[] = [];
    if (process.platform === "darwin") {
      if (id === "edge") out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
      else if (id === "brave") out.push("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
      else if (id === "opera") out.push("/Applications/Opera.app/Contents/MacOS/Opera");
      else
        out.push(
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium"
        );
      return out;
    }
    const pf = process.env["ProgramFiles"];
    const pf86 = process.env["ProgramFiles(x86)"];
    const local = process.env["LOCALAPPDATA"];
    if (id === "edge") {
      out.push(
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
      );
      if (pf) out.push(`${pf}/Microsoft/Edge/Application/msedge.exe`);
      if (pf86) out.push(`${pf86}/Microsoft/Edge/Application/msedge.exe`);
    } else if (id === "brave") {
      if (pf) out.push(`${pf}/BraveSoftware/Brave-Browser/Application/brave.exe`);
      if (pf86) out.push(`${pf86}/BraveSoftware/Brave-Browser/Application/brave.exe`);
      if (local) out.push(`${local}/BraveSoftware/Brave-Browser/Application/brave.exe`);
      out.push("C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe");
    } else if (id === "opera") {
      if (local) out.push(`${local}/Programs/Opera/opera.exe`);
      if (pf) out.push(`${pf}/Opera/opera.exe`);
      if (pf86) out.push(`${pf86}/Opera/opera.exe`);
      out.push("C:/Program Files/Opera/opera.exe");
    } else {
      out.push(
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
      );
      if (pf) out.push(`${pf}/Google/Chrome/Application/chrome.exe`);
      if (pf86) out.push(`${pf86}/Google/Chrome/Application/chrome.exe`);
    }
    return out;
  }

  private resolveBrowserBin(id: string): string | null {
    for (const c of this.browserPaths(id)) {
      try {
        fs.accessSync(c);
        return c;
      } catch {}
    }
    const bins =
      process.platform === "win32"
        ? id === "edge"
          ? ["msedge.exe"]
          : id === "brave"
            ? ["brave.exe"]
            : id === "opera"
              ? ["opera.exe"]
              : ["chrome.exe"]
        : id === "edge"
          ? ["microsoft-edge", "msedge"]
          : id === "brave"
            ? ["brave-browser", "brave"]
            : id === "opera"
              ? ["opera"]
              : ["google-chrome", "chrome", "chromium"];
    for (const bin of bins) {
      try {
        const found = Bun.which(bin);
        if (found) return found;
      } catch {}
    }
    return null;
  }

  private defaultBrowserId(): BrowserId | null {
    try {
      if (process.platform === "win32") {
        const r = Bun.spawnSync([
          "reg",
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
          "/v",
          "ProgId",
        ]);
        const text = r.stdout ? Buffer.from(r.stdout).toString() : "";
        const m = text.match(/ProgId\s+REG_SZ\s+(\S+)/);
        const progId = m ? m[1] : "";
        if (/^ChromeHTML/i.test(progId)) return "chrome";
        if (/^MSEdgeHTM/i.test(progId)) return "edge";
        if (/^BraveHTML/i.test(progId)) return "brave";
        if (/^OperaStable/i.test(progId)) return "opera";
        return null; // FirefoxURL etc: our extension can't run there, don't prefer it
      }
      // No reliable built-in default-browser query on macOS (duti not stock);
      // sticky/running/PATH heuristics cover it.
      if (process.platform === "darwin") return null;
      const r = Bun.spawnSync(["xdg-settings", "get", "default-web-browser"]);
      const desktop = r.stdout ? Buffer.from(r.stdout).toString().trim().toLowerCase() : "";
      if (!desktop) return null;
      if (desktop.includes("brave")) return "brave";
      if (desktop.includes("msedge") || desktop.includes("microsoft-edge")) return "edge";
      if (desktop.includes("chrome") || desktop.includes("chromium")) return "chrome";
      return null;
    } catch {
      return null;
    }
  }

  /** Per-port sticky browser file in the per-user config dir (A12). */
  private stickyFile(): string {
    try {
      return path.join(configDir(), `sticky-browser-${this.port}`);
    } catch {
      return "";
    }
  }

  private readStickyBrowser(): BrowserId | null {
    try {
      const f = this.stickyFile();
      if (!f) return null;
      return normalizeBrowserId(fs.readFileSync(f, "utf8"));
    } catch {}
    return null;
  }

  private rememberBrowser(id: BrowserId): void {
    const changed = this.lastBrowser !== id;
    this.lastBrowser = id;
    if (!changed && this.readStickyBrowser() === id) return;
    try {
      const f = this.stickyFile();
      if (f) writePrivateFile(f, id);
    } catch {}
  }

  private async runningBrowsers(): Promise<Record<BrowserId, boolean>> {
    const out: Record<BrowserId, boolean> = { chrome: false, edge: false, brave: false, opera: false };
    try {
      if (process.platform !== "win32") {
        // macOS process names contain spaces ("Google Chrome"); pgrep -x
        // matches them exactly (helpers like "Google Chrome Helper" excluded).
        const darwin = process.platform === "darwin";
        const bins: Record<BrowserId, string[]> = darwin
          ? {
            chrome: ["Google Chrome", "Chromium"],
            edge: ["Microsoft Edge"],
            brave: ["Brave Browser"],
            opera: ["Opera"],
          }
          : {
            chrome: ["google-chrome", "chrome", "chromium"],
            edge: ["microsoft-edge", "msedge"],
            brave: ["brave-browser", "brave"],
            opera: ["opera"],
          };
        for (const id of ["chrome", "edge", "brave", "opera"] as const) {
          for (const bin of bins[id]) {
            try {
              const p = Bun.spawnSync(["pgrep", "-x", bin]);
              if (p.exitCode === 0) {
                out[id] = true;
                break;
              }
            } catch {}
          }
        }
        return out;
      }
      const p = Bun.spawnSync(["tasklist", "/NH"]);
      const text = p.stdout ? Buffer.from(p.stdout).toString() : "";
      out.chrome = /\bchrome\.exe\b/i.test(text);
      out.edge = /\bmsedge\.exe\b/i.test(text);
      out.brave = /\bbrave\.exe\b/i.test(text);
      out.opera = /\bopera\.exe\b/i.test(text);
    } catch {}
    return out;
  }

  /** Resolves true as soon as an extension completes hello (A11), false on timeout. */
  private waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.connWaiters.delete(onConn);
        resolve(ok);
      };
      const onConn = () => {
        if (this.connected) done(true);
      };
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      this.connWaiters.add(onConn);
    });
  }

  /** Remaining reconnect grace (ms) before an auto-launch may spawn a browser. */
  private reconnectGraceRemaining(): number {
    const anchor = Math.max(this.listeningAt, this.lastExtDropAt);
    if (!anchor) return 0;
    return Math.max(0, anchor + RECONNECT_GRACE_MS - Date.now());
  }

  // ----- browser close -----

  /**
   * Browser family hosting the extension. While an extension is connected only
   * its own hello counts: an unknown / unsupported browser (null) refuses force
   * close instead of falling back to an older remembered family (A7). The
   * remembered / sticky browser is used only when no extension is connected.
   */
  private hostBrowser(): BrowserId | null {
    if (this.active) return this.peers.get(this.active)?.browser ?? null;
    return this.lastBrowser ?? this.readStickyBrowser();
  }

  /** Close the browser. Graceful = close all windows via the extension (needs connection). Force = terminate the process of the browser hosting the extension (server-side). */
  async closeBrowser(force = false): Promise<{ closed: boolean; detail: string }> {
    // The popup switch applies to both modes, also while the extension is
    // silent (last known snapshot) and for relayed __closeBrowser.
    if (this.knownDisabled()?.includes("browser_close")) {
      throw new Error("Permission disabled in extension: browser_close (enable it from the extension popup)");
    }
    if (!force) {
      if (!this.connected) {
        return { closed: false, detail: "Extension not connected; use force:true to kill the browser process." };
      }
      const r = (await this.sendInner("browser_close", {}, undefined, 30000)) as { closed?: number };
      // give the worker a moment to die with its last window
      const deadline = Date.now() + 5000;
      while (this.connected && Date.now() < deadline) {
        await sleep(250);
      }
      return { closed: !this.connected, detail: `Closed ${r?.closed ?? 0} window(s).` };
    }
    const host = this.hostBrowser();
    if (!host) {
      throw new Error(
        this.active
          ? "Force close refused: the connected extension runs in a browser this bridge cannot identify (not Chrome, Edge, Brave or Opera). Close the browser manually, or use browser_close without force."
          : "Force close refused: the browser hosting the extension is unknown (it has not connected to this bridge yet). Close the browser manually, or connect the extension once so the bridge knows which browser it runs in."
      );
    }
    try {
      return await this.killBrowser(host);
    } catch (e) {
      return { closed: false, detail: `Force close failed: ${String((e as Error)?.message ?? e)}` };
    }
  }

  /** Process image names of one browser family. */
  private imageNames(id: BrowserId): string[] {
    if (process.platform === "win32") {
      return [{ chrome: "chrome.exe", edge: "msedge.exe", brave: "brave.exe", opera: "opera.exe" }[id]];
    }
    if (process.platform === "darwin") {
      return { chrome: ["Google Chrome", "Chromium"], edge: ["Microsoft Edge"], brave: ["Brave Browser"], opera: ["Opera"] }[id];
    }
    return { chrome: ["chrome", "chromium"], edge: ["msedge"], brave: ["brave"], opera: ["opera"] }[id];
  }

  private isImageRunning(name: string): boolean {
    try {
      if (process.platform === "win32") {
        const p = Bun.spawnSync(["tasklist", "/FI", `IMAGENAME eq ${name}`, "/NH"]);
        const text = p.stdout ? Buffer.from(p.stdout).toString() : "";
        return new RegExp(`\\b${name.replace(/\./g, "\\.")}\\b`, "i").test(text);
      }
      return Bun.spawnSync(["pgrep", "-x", name]).exitCode === 0;
    } catch {
      return false;
    }
  }

  private async waitImageGone(name: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!this.isImageRunning(name)) return true;
      await sleep(250);
    }
    return !this.isImageRunning(name);
  }

  /**
   * Terminate only the browser family hosting the extension (never every
   * Chromium browser on the machine): polite close first, then a hard kill.
   */
  private async killBrowser(host: BrowserId): Promise<{ closed: boolean; detail: string }> {
    const name = this.imageNames(host).find((n) => this.isImageRunning(n));
    if (!name) {
      return { closed: false, detail: `${this.imageNames(host).join(" / ")} is not running (extension host: ${host}).` };
    }
    const win = process.platform === "win32";
    // Polite: WM_CLOSE on Windows, SIGTERM elsewhere (lets the browser save its session).
    Bun.spawnSync(win ? ["taskkill", "/IM", name] : ["pkill", "-TERM", "-x", name]);
    if (await this.waitImageGone(name, 3000)) {
      return { closed: true, detail: `Closed ${name} (extension host: ${host}).` };
    }
    Bun.spawnSync(win ? ["taskkill", "/F", "/IM", name] : ["pkill", "-KILL", "-x", name]);
    const gone = await this.waitImageGone(name, 3000);
    return gone
      ? { closed: true, detail: `Killed ${name} (extension host: ${host}).` }
      : { closed: false, detail: `${name} is still running after a kill attempt (extension host: ${host}).` };
  }

  // ----- commands -----

  private notConnectedError(): Error {
    const hint = this.rejected.length
      ? ` Untrusted extension id(s) tried to connect: ${this.rejected.join(", ")} (trust via BROWSER_MCP_EXTENSION_IDS / --extension-id or ${trustedFile()}).`
      : "";
    return new Error(
      `Browser extension not connected. In Chrome open chrome://extensions -> Developer Mode -> "Load unpacked" and select the extension/ folder. The WS port must be listening.${hint}`
    );
  }

  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs = 30000): Promise<T> {
    return this.sendWithLaunch<T>(action, payload, tabId, timeoutMs, null);
  }

  /** send() with a caller's launch preferences (relayed satellite commands). */
  private sendWithLaunch<T = unknown>(
    action: string,
    payload: unknown,
    tabId: number | undefined,
    timeoutMs: number,
    prefs: LaunchPrefs | null
  ): Promise<T> {
    if (this.connected) return this.sendInner<T>(action, payload, tabId, timeoutMs);
    return (async () => {
      // An extension that just dropped (or a fresh primary after failover)
      // usually reconnects within its backoff: wait for it instead of
      // spawning a browser window (A6). Skipped when no browser runs at all.
      const grace = this.reconnectGraceRemaining();
      if (grace > 0) {
        const running = await this.runningBrowsers();
        if (Object.values(running).some(Boolean) && (await this.waitForConnection(grace))) {
          return this.sendInner<T>(action, payload, tabId, timeoutMs);
        }
      }
      if (!(prefs?.auto ?? this.autoLaunch)) throw this.notConnectedError();
      const f = this.autoLaunchFailure;
      if (f && Date.now() - f.at < AUTO_LAUNCH_COOLDOWN_MS) {
        const ago = Math.round((Date.now() - f.at) / 1000);
        throw new Error(`${f.detail} (auto-launch failed ${ago}s ago and is paused for ${AUTO_LAUNCH_COOLDOWN_MS / 1000}s; call browser_launch to retry now)`);
      }
      const r = await this.launchBrowser(undefined, { browser: prefs?.browser });
      if (!r.connected || !this.connected) {
        this.autoLaunchFailure = { at: Date.now(), detail: r.detail };
        throw new Error(`${r.detail} (auto-launch ${r.launched ? "tried" : "skipped"})`);
      }
      return this.sendInner<T>(action, payload, tabId, timeoutMs);
    })();
  }

  private sendInner<T = unknown>(action: string, payload: unknown, tabId: number | undefined, timeoutMs = 30000): Promise<T> {
    const target = this.active;
    if (!target || target.readyState !== WebSocket.OPEN) return Promise.reject(this.notConnectedError());
    const id = `cmd-${crypto.randomUUID()}`;
    const req: BridgeRequest = { id, action, tabId, payload, timeoutMs };
    return new Promise<T>((resolve, reject) => {
      const fail = (err: unknown) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(`Extension timed out (${action}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, ws: target, action });
      try {
        target.send(JSON.stringify(req), (err) => {
          if (err) fail(err);
        });
      } catch (e) {
        fail(e);
      }
    });
  }

  close(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge closed"));
    }
    this.pending.clear();
    for (const [, p] of this.peers) {
      if (p.authTimer) clearTimeout(p.authTimer);
    }
    // Drop satellite/observer sockets promptly so they fail over instead
    // of lingering on a half-open connection.
    try {
      for (const client of this.wss.clients) {
        try { (client as WebSocket).terminate(); } catch {}
      }
    } catch {}
    try {
      this.wss.close();
    } catch {}
  }
}

/**
 * Satellite client for multi-agent sharing.
 *
 * When a second MCP server starts while the bridge port is already held,
 * it joins the primary bridge as a WS client instead of binding its own
 * server. Commands are relayed by the primary to the single extension
 * connection, so N agents can share one browser.
 */
export class BridgeClient implements IBridge {
  public readonly port: number;
  private localConsole: Array<unknown> = [];
  private localNetwork: Array<unknown> = [];
  get consoleEvents(): Array<unknown> {
    return this.primary ? this.primary.consoleEvents : this.localConsole;
  }
  set consoleEvents(v: Array<unknown>) {
    if (this.primary) this.primary.consoleEvents = v;
    else this.localConsole = v;
  }
  get networkEvents(): Array<unknown> {
    return this.primary ? this.primary.networkEvents : this.localNetwork;
  }
  set networkEvents(v: Array<unknown>) {
    if (this.primary) this.primary.networkEvents = v;
    else this.localNetwork = v;
  }
  private ws: WebSocket | null = null;
  private primary: ExtensionBridge | null = null;
  private pending = new Map<string, Pending>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readySettled = false;
  private readyDeadline: ReturnType<typeof setTimeout> | null = null;
  private lastError: Error | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private statusInflight: Promise<void> | null = null;
  private statusFails = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Unknown until the primary answers __bridge_status (A15). */
  private extensionConnected = false;
  /** Last peer count reported by the primary (-1 = unknown yet). */
  private lastPeers = -1;
  private lastStatus: Partial<BridgeStatus> | null = null;
  private lastDisabled: string[] | null = null;
  private authed = false;
  private warnedLaunchPrefs = false;
  private readonly extensionIds: string[] | undefined;

  constructor(port: number, opts?: { extensionIds?: string[] }) {
    this.port = port;
    this.extensionIds = opts?.extensionIds;
    // A failed first link is retried (failover / reconnect) for a bounded
    // time before ready() rejects (A8).
    this.readyDeadline = setTimeout(() => {
      this.readyDeadline = null;
      const why = this.lastError?.message ? `: ${this.lastError.message}` : "";
      this.settleReady(new Error(`Cannot reach or take over the primary bridge on :${port}${why}`));
    }, SATELLITE_READY_DEADLINE_MS);
    this.connect();
  }

  ready(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.readySettled) {
        if (this.primary || (this.ws && this.ws.readyState === WebSocket.OPEN)) resolve();
        else reject(this.lastError ?? new Error(`Satellite bridge to :${this.port} is not connected`));
        return;
      }
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  get connected(): boolean {
    if (this.primary) return this.primary.connected;
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.extensionConnected;
  }

  get mode(): "primary" | "satellite" {
    // A promoted satellite behaves as the primary for its agent.
    return this.primary ? "primary" : "satellite";
  }

  status(): BridgeStatusInfo {
    if (this.primary) return this.primary.status();
    const s = this.lastStatus;
    return {
      mode: "satellite",
      pid: process.pid,
      peers: this.lastPeers,
      extensions: s?.extensions,
      trustedExtensionIds: s?.trustedExtensionIds,
      rejectedExtensionIds: s?.rejectedExtensionIds,
      tofuOpen: s?.tofuOpen,
      configDir: s?.configDir ?? configDir(),
    };
  }

  knownDisabled(): string[] | null {
    if (this.primary) return this.primary.knownDisabled();
    return this.lastDisabled ? [...this.lastDisabled] : null;
  }

  /** Raw link state (ignores extension status) — used internally for polling. */
  private get linkOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private settleReady(err?: Error) {
    if (this.readySettled) return;
    this.readySettled = true;
    if (this.readyDeadline) {
      clearTimeout(this.readyDeadline);
      this.readyDeadline = null;
    }
    if (err) this.readyReject?.(err);
    else this.readyResolve?.();
  }

  private connect() {
    if (this.closed || this.primary) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: MAX_PAYLOAD });
    } catch (e) {
      this.lastError = e as Error;
      this.scheduleFailover();
      return;
    }
    this.ws = ws;
    this.authed = false;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      console.error(`[bridge:${process.pid}] satellite connected to primary on :${this.port}`);
      // Authenticate first (token re-read on every attempt: a new primary
      // writes a new one). Frames are processed in order by the primary.
      const token = readTokenFile(this.port);
      if (token) {
        try { ws.send(JSON.stringify({ type: "auth", token })); } catch {}
      } else {
        console.error(`[bridge:${process.pid}] no bridge token at ${tokenFile(this.port)}; the primary will refuse this satellite`);
      }
      // Fetch real extension status before marking ready so `connected`
      // is accurate from the start.
      this.refreshStatus().finally(() => {
        if (this.ws !== ws || !this.linkOpen) return;
        this.settleReady();
        this.startStatusPoll();
      });
    });
    ws.on("message", (raw) => {
      try {
        this.onLinkMessage(ws, rawToText(raw));
      } catch (e) {
        console.error(`[bridge:${process.pid}] satellite: bad frame ignored: ${(e as Error)?.message ?? e}`);
      }
    });
    ws.on("close", (code: number) => {
      const why =
        code === 4001
          ? `Primary bridge on :${this.port} refused authentication (stale token?)`
          : `Primary bridge on :${this.port} closed`;
      this.dropLink(ws, new Error(why));
    });
    ws.on("error", (e) => {
      const msg = (e as Error)?.message ?? String(e);
      console.error(`[bridge:${process.pid}] satellite ws error: ${msg}`);
      try { ws.terminate(); } catch {}
      this.dropLink(ws, e as Error);
    });
  }

  private onLinkMessage(ws: WebSocket, text: string): void {
    if (this.ws !== ws) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isPlainObject(msg)) return;
    if (msg.type === "auth_ok") {
      this.authed = true;
      return;
    }
    if (msg.type === "event") {
      this.onEvent(msg);
      return;
    }
    if (typeof msg.id !== "string") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    const res = msg as unknown as BridgeResponse;
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error((typeof res.error === "string" && res.error) || "primary bridge error"));
  }

  /** Events broadcast by the primary (A9). */
  private onEvent(msg: Record<string, unknown>): void {
    const kind = msg.kind;
    if (kind === "perms") {
      const d = parseDisabled(msg.data);
      if (d) {
        this.lastDisabled = d;
        this.enforceEventPerms();
      }
      return;
    }
    if (kind === "console") {
      if (this.lastDisabled?.includes("console_get")) return;
      pushRing(this.localConsole, msg.data);
    } else if (kind === "network") {
      if (this.lastDisabled?.includes("network_requests")) return;
      pushRing(this.localNetwork, msg.data);
    }
  }

  private enforceEventPerms(): void {
    const d = this.lastDisabled;
    if (!d) return;
    if (d.includes("console_get")) this.localConsole.length = 0;
    if (d.includes("network_requests")) this.localNetwork.length = 0;
  }

  private applyStatus(s: unknown): void {
    if (!isPlainObject(s)) return;
    this.extensionConnected = !!s.connected;
    if (typeof s.peers === "number") this.lastPeers = s.peers;
    this.lastStatus = s as Partial<BridgeStatus>;
    if ("disabled" in s) {
      this.lastDisabled = Array.isArray(s.disabled) ? parseDisabled({ disabled: s.disabled }) : null;
      this.enforceEventPerms();
    }
  }

  /**
   * Poll __bridge_status. Consecutive timeouts mean the primary stopped
   * servicing messages: drop the link so the normal failover runs (A15).
   */
  private refreshStatus(): Promise<void> {
    if (this.statusInflight) return this.statusInflight;
    const ws = this.ws;
    const p = this.sendRaw<BridgeStatus>("__bridge_status", {}, undefined, STATUS_TIMEOUT_MS, STATUS_TIMEOUT_MS)
      .then(
        (s) => {
          this.statusFails = 0;
          this.applyStatus(s);
        },
        (e) => {
          if ((e as { code?: string })?.code !== "ETIMEDOUT" || this.ws !== ws || !ws) return;
          this.statusFails++;
          this.extensionConnected = false;
          if (this.statusFails >= STATUS_FAILS_BEFORE_FAILOVER) {
            console.error(`[bridge:${process.pid}] primary on :${this.port} stopped answering (${this.statusFails} status timeouts), failing over`);
            try { ws.terminate(); } catch {}
            this.dropLink(ws, new Error(`Primary bridge on :${this.port} is unresponsive`));
          }
        }
      )
      .finally(() => {
        this.statusInflight = null;
      });
    this.statusInflight = p;
    return p;
  }

  private dropLink(ws: WebSocket, err: Error): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.authed = false;
    this.extensionConnected = false;
    this.statusFails = 0;
    this.lastError = err;
    console.error(`[bridge:${process.pid}] satellite link down on :${this.port} (${err.message}), failing over`);
    this.stopStatusPoll();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Primary bridge disconnected"));
    }
    this.pending.clear();
    // Primary may be gone: try to take over the port (promote), else
    // fall back to client mode against whoever owns it now.
    this.scheduleFailover();
  }

  private scheduleFailover() {
    if (this.closed || this.primary || this.reconnectTimer) return;
    // Jittered delay: N satellites losing the primary at once must not all
    // bind() in the same millisecond (thundering herd). Spread 1.2–3.2s.
    const delay = 1200 + Math.random() * 2000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptPrimary();
    }, delay);
  }

  /**
   * True when this process still has a live owner (parent + stdio + MCP
   * client). A satellite whose own agent is already gone must exit instead
   * of hijacking the shared port as a zombie primary.
   */
  private selfHealthy(): boolean {
    if (this.closed) return false;
    try {
      if (process.stdin && (process.stdin as unknown as { destroyed?: boolean }).destroyed) return false;
    } catch {}
    try {
      const ppid = process.ppid;
      if (ppid && ppid > 1) process.kill(ppid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    }
    return true;
  }

  private attemptPrimary() {
    if (this.closed || this.primary) return;
    if (!this.selfHealthy()) {
      // Our own agent is gone: do not squat on the shared port. Exit so the
      // OS/manager can reap us; a healthy sibling will take over if needed.
      console.error(`[bridge:${process.pid}] satellite unhealthy, exiting instead of takeover on :${this.port}`);
      try { this.close(); } catch {}
      setTimeout(() => process.exit(0), 100).unref?.();
      return;
    }
    console.error(`[bridge:${process.pid}] satellite attempting takeover on :${this.port}`);
    let candidate: ExtensionBridge;
    try {
      candidate = new ExtensionBridge(this.port, { exitOnAddrInUse: false, extensionIds: this.extensionIds });
    } catch (e) {
      console.error(`[bridge:${process.pid}] takeover bind threw, rejoining as client`, e);
      this.lastError = e as Error;
      if (!this.closed) this.connect();
      return;
    }
    candidate.ready().then(
      () => {
        if (this.closed) {
          candidate.close();
          return;
        }
        // Carry over what this satellite knew (permission snapshot, buffered events).
        candidate.adoptState({ disabled: this.lastDisabled, consoleEvents: this.localConsole, networkEvents: this.localNetwork });
        this.primary = candidate;
        console.error(`[bridge:${process.pid}] satellite promoted to primary on :${this.port}`);
        try { this.ws?.close(); } catch {}
        this.ws = null;
        this.stopStatusPoll();
        this.settleReady();
      },
      (e) => {
        const code = (e as { code?: string })?.code;
        console.error(`[bridge:${process.pid}] takeover failed (${(e as Error)?.message}), rejoining as client`);
        if (code !== "EADDRINUSE") this.lastError = e as Error;
        try { candidate.close(); } catch {}
        if (this.closed) return;
        this.connect();
      }
    );
  }

  private startStatusPoll() {
    this.stopStatusPoll();
    const poll = () => {
      if (this.closed || !this.linkOpen) return;
      void this.refreshStatus();
    };
    this.statusTimer = setInterval(poll, STATUS_POLL_MS);
  }

  private stopStatusPoll() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /** This satellite's own launch settings, forwarded to the primary (A10). */
  private launchPrefs(): LaunchPrefs {
    const prefs: LaunchPrefs = { auto: process.env.BROWSER_AUTO_LAUNCH !== "0" };
    const name = (process.env.BROWSER ?? "").trim();
    const bp = (process.env.BROWSER_PATH ?? "").trim();
    const cp = (process.env.CHROME_PATH ?? "").trim();
    const browser =
      (bp ? browserIdFromBin(bp) : null) ??
      (name ? normalizeBrowserId(name) ?? browserIdFromBin(name) : null) ??
      (cp ? browserIdFromBin(cp) : null);
    if (browser) prefs.browser = browser;
    if (!this.warnedLaunchPrefs && (bp || cp || (name && !normalizeBrowserId(name)))) {
      this.warnedLaunchPrefs = true;
      console.error(
        `[bridge:${process.pid}] satellite: browser binary paths are not forwarded; the primary launches its own ${browser ?? "default"} browser binary`
      );
    }
    return prefs;
  }

  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs = 30000): Promise<T> {
    if (this.primary) return this.primary.send<T>(action, payload, tabId, timeoutMs);
    const prefs = this.launchPrefs();
    // The primary may first wait for a reconnecting extension and auto-launch
    // a browser before running the command: budget for it locally (A5).
    const extra = this.extensionConnected ? 0 : RECONNECT_GRACE_MS + (prefs.auto ? envLaunchTimeoutMs() : 0);
    return this.sendRaw<T>(action, payload, tabId, timeoutMs, timeoutMs + 5000 + extra, prefs);
  }

  /**
   * Relay one request. `relayTimeoutMs` is what the primary uses towards the
   * extension; `localTimeoutMs` is this satellite's own give-up timer.
   */
  private sendRaw<T = unknown>(
    action: string,
    payload: unknown,
    tabId: number | undefined,
    relayTimeoutMs: number,
    localTimeoutMs: number,
    launch?: LaunchPrefs
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Primary bridge not connected (port ${this.port}); reconnecting, retry shortly.`));
    }
    const id = `sat-${process.pid}-${crypto.randomUUID()}`;
    const req: BridgeRequest = { id, action, tabId, payload, timeoutMs: relayTimeoutMs };
    if (launch) req.launch = launch;
    return new Promise<T>((resolve, reject) => {
      const fail = (err: unknown) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(`Primary bridge timed out (${action}, ${localTimeoutMs}ms)`));
      }, localTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, ws, action });
      try {
        ws.send(JSON.stringify(req), (err) => {
          if (err) fail(err);
        });
      } catch (e) {
        fail(e);
      }
    });
  }

  async launchBrowser(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.primary) return this.primary.launchBrowser(timeoutMs);
    // Use this satellite's launch timeout and browser choice, and wait locally
    // a bit longer than the primary does (A5/B9).
    const wait = clampTimeout(timeoutMs ?? envLaunchTimeoutMs());
    const prefs = this.launchPrefs();
    return this.sendRaw("__launchBrowser", { timeoutMs: wait, browser: prefs.browser }, undefined, wait, wait + 15000);
  }

  async closeBrowser(force = false): Promise<{ closed: boolean; detail: string }> {
    if (this.primary) return this.primary.closeBrowser(force);
    // Graceful close = up to 30 s command + 5 s wait on the primary; force
    // = polite close + kill (~6 s).
    return this.sendRaw("__closeBrowser", { force }, undefined, 45000, 50000);
  }

  close(): void {
    this.closed = true;
    this.stopStatusPoll();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.readyDeadline) {
      clearTimeout(this.readyDeadline);
      this.readyDeadline = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge closed"));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    if (this.primary) {
      try {
        this.primary.close();
      } catch {}
      this.primary = null;
    }
  }
}
