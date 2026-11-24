import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import pkg from "../package.json" with { type: "json" };

// WS bridge protocol v3 (see SECURITY.md for the trust model).
//
// Handshake:
//   - Web pages (any non-extension Origin) are refused during the HTTP upgrade
//     (403), so they cannot even detect the bridge.
//   - Extension sockets (chrome-extension:// / moz-extension:// Origin) must
//     come from a trusted extension id (built-in store id, BROWSER_MCP_EXTENSION_IDS,
//     --extension-id, or <configDir>/trusted-extensions.json; trust-on-first-use
//     while that file is empty). Untrusted ids are closed with 4003.
//   - Any local process can send any Origin header, so the id is only a filter.
//     Each extension install then proves a per-install key K, and the extension
//     checks that the server knows K before it runs anything (mutual HMAC). K is
//     handed out once, while the pairing window is open: no install paired yet,
//     or the server runs with --pair / BROWSER_MCP_PAIR=1 (10 min, one install).
//     Keys live in <configDir>/extension-keys.json (0600).
//   - Origin-less sockets (satellites, CLI scripts) must authenticate first with the
//     per-run token of <configDir>/bridge-<port>.token (mutual HMAC, see below),
//     otherwise they are closed with 4001.
//
// Extension handshake (Ne / Ns = 32 random bytes as lowercase hex, HMAC = HMAC-SHA256
// keyed with the hex-decoded K, hex output, extId = the id from the Origin, port = the TCP
// port as a decimal string: the one this server is bound to, and the one the extension dialed,
// so a challenge relayed from a primary on another port never verifies):
//   EXT -> MCP: { type: "hello", role: "extension", protocol: 3, browser, extensionId, version,
//                 perms: { disabled }, installId, nonce: Ne, hasKey }
//   install has a stored key (and hasKey is not false):
//     MCP -> EXT: { type: "challenge", nonce: Ns, proof: HMAC("browser-mcp/v3|server|<extId>|<installId>|<port>|<Ne>|<Ns>") }
//     EXT -> MCP: { type: "auth", proof: HMAC("browser-mcp/v3|extension|<extId>|<installId>|<port>|<Ns>|<Ne>") }
//   no stored key, pairing window open (K is fresh and only saved once the proof checks out):
//     MCP -> EXT: { type: "pair", nonce: Ns, key: K }
//     EXT -> MCP: { type: "pair_accept", proof: <extension proof, computed with K> }
//   MCP -> EXT: { type: "welcome", protocol: 3, pid, serverVersion }   (extension is now authenticated)
//   Close codes: 4001 auth-required (clients), 4002 protocol-mismatch:server=3,ext=<n>,
//   4003 untrusted-extension:<id>, 4004 pairing-closed, 4005 auth-failed, 4006 replaced
//   (same install connected again), 4008 handshake-timeout; sent by the extension:
//   4100 pair-declined, 4101 server-auth-failed, 4102 server-outdated (only 4100 / 4101 sent in
//   answer to this server's own pair offer / challenge are recorded; 4102 answers a welcome
//   without a handshake, which this server never sends).
//   Legacy (opt-in: --allow-legacy-extension / BROWSER_MCP_ALLOW_LEGACY_EXTENSION=1): a
//   protocol 2 hello is accepted without a key and answered with { type: "welcome", protocol: 2, pid }.
//
// Client (satellite / script) auth, first thing on an Origin-less socket (Nc / Np = 32 random
// bytes as lowercase hex, HMAC = HMAC-SHA256 keyed with the hex-decoded token of the port, port
// as above; the raw token never crosses the socket, and the client checks the primary first):
//   SAT -> MCP: { type: "auth", v: 2, nonce: Nc }
//   MCP -> SAT: { type: "auth_challenge", nonce: Np, proof: HMAC("browser-mcp/client|server|<port>|<Nc>|<Np>") }
//   SAT -> MCP: { type: "auth_proof", proof: HMAC("browser-mcp/client|client|<port>|<Np>|<Nc>") }
//   MCP -> SAT: { type: "auth_ok", pid }      (a wrong proof or any other frame: 4001)
//   Legacy, still accepted (scripts, older processes): { type: "auth", token } -> { type: "auth_ok", pid }.
//   It hands the raw token to whatever listens on the port, so it is no check of the primary.
//
// Messages after the handshake:
//   MCP  -> EXT: { id, action, tabId?, payload?, timeoutMs }   (command)
//   EXT  -> MCP: { id, ok, result?, error? }                    (response, only from the socket the command went to)
//   MCP  -> EXT: { type: "cancel", id }                         (the caller gave up on command id; a late reply is ignored)
//   EXT  -> MCP: { type: "event", kind: "console" | "network" | "perms", data }
//   SAT  -> MCP: { id, action, payload?, tabId?, timeoutMs?, launch? }  (relay / control plane)
//   SAT  -> MCP: { type: "cancel", id }   (id = the satellite's request id; forwarded as the extension's command id)
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

/** Optional 5th argument of IBridge.send. */
export interface SendOptions {
  /**
   * Aborting it rejects the send() with an Error named "AbortError" (message
   * "cancelled") and tells the extension to stop the command.
   */
  signal?: AbortSignal;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Socket the request was sent on; only that socket may answer it. */
  ws: WebSocket;
  action: string;
  /** Detaches the caller's abort listener (null without a signal). */
  unlisten: (() => void) | null;
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
  /** Extension sockets that completed the handshake. */
  extensions?: number;
  /** Effective trusted extension ids (["*"] in legacy accept-all mode). */
  trustedExtensionIds?: string[];
  /** Last (up to 10) extension ids that were refused with 4003. */
  rejectedExtensionIds?: string[];
  /** True while trust-on-first-use of an extension id is still open. */
  tofuOpen?: boolean;
  /** Directory holding the token / trust / key / sticky-browser files. */
  configDir?: string;
  /** Version the active extension reported in its hello (null: none connected). */
  extensionVersion?: string | null;
  /** Bridge protocol of the active extension (3, or 2 in legacy mode; null: none connected). */
  extensionProtocol?: number | null;
  /** True while a new extension install may pair (none paired yet, or the --pair window). */
  pairingOpen?: boolean;
  /** Extension installs holding a pairing key (extension-keys.json). */
  pairedInstalls?: number;
  /** Version of the browser-mcp server that owns the bridge (the primary). */
  serverVersion?: string;
  /** Bridge protocol the primary speaks. */
  bridgeProtocol?: number;
  /** Protocol-2 extensions are accepted without a key (--allow-legacy-extension). */
  legacyExtensionAllowed?: boolean;
  /** Last extension handshake refused by the primary or, with 4100 / 4101, by the extension (null: none). */
  lastExtensionRefusal?: ExtensionRefusal | null;
}

/** A refused extension handshake (close code and reason as sent by the side that refused). */
export interface ExtensionRefusal {
  code: number;
  reason: string;
  extensionId: string;
  /** Epoch ms. */
  at: number;
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
  /** Extra status fields for browser_status (mode/pid/peers/trust/pairing info). */
  status(): BridgeStatusInfo;
  /** Last disabled-actions snapshot from the extension (hello / perms events); null = unknown. */
  knownDisabled(): string[] | null;
  /**
   * Called with the new snapshot whenever knownDisabled() changes (not for
   * repeats of the same set). Returns the unsubscribe function.
   */
  onPermsChange(cb: (disabled: string[] | null) => void): () => void;
  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs?: number, opts?: SendOptions): Promise<T>;
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
/** Bridge protocol spoken by this server (see the header comment). */
export const BRIDGE_PROTOCOL = 3;
/** Unauthenticated protocol of 0.3.x extensions, only with allowLegacyExtension. */
const LEGACY_PROTOCOL = 2;
/**
 * Close codes the extension sends when it refuses this server during the handshake, with their
 * reasons. (It also sends 4102 server-outdated, but only for a welcome without a handshake, which
 * this server never sends, so a 4102 here can only come from a forged socket.)
 */
const EXTENSION_REFUSALS: ReadonlyMap<number, string> = new Map([
  [4100, "pair-declined"],
  [4101, "server-auth-failed"],
]);
/** A satellite waits this much longer per failed authentication of the primary, up to the cap (ms). */
const AUTH_BACKOFF_MAX_MS = 30000;
/** This server's version (package.json), sent in welcome and shown in status. */
export const SERVER_VERSION: string = typeof pkg.version === "string" ? pkg.version : "0.0.0";
/** Large results (full-page screenshots, PDFs, audio) travel as one frame. */
const MAX_PAYLOAD = 256 * 1024 * 1024;
const RELAY_TIMEOUT_DEFAULT = 30000;
const RELAY_TIMEOUT_MIN = 1000;
const RELAY_TIMEOUT_MAX = 7_200_000;
const MAX_REJECTED = 10;
const MAX_BUF = 1000;
/** Events above this size are dropped (the extension caps them at ~1 MiB). */
const EVENT_MAX_CHARS = 2 * 1024 * 1024;
/** Skip event broadcasts to a satellite whose socket is this far behind. */
const BROADCAST_BACKLOG_LIMIT = 16 * 1024 * 1024;
/** Upper bound of remembered installs; the oldest pairing is dropped first. */
const MAX_INSTALLS = 100;

/** Timings of a bridge; tests shrink them, production uses DEFAULT_TIMINGS. */
export interface BridgeTimings {
  /** Satellites must authenticate, and extensions finish the handshake, within this (ms). */
  authTimeoutMs: number;
  /**
   * After a fresh bind (startup / failover) or an extension drop, the extension
   * usually reconnects within its backoff (<= 10 s). Wait this long before
   * auto-launching a browser so we don't open stray windows (A6).
   */
  reconnectGraceMs: number;
  /** After a failed auto-launch, fail fast for this long instead of relaunching (ms). */
  autoLaunchCooldownMs: number;
  /** The pair option keeps the pairing window open this long after start (ms). */
  pairWindowMs: number;
  /** Satellite: ready() rejects when no link / takeover succeeded within this (ms). */
  satelliteReadyDeadlineMs: number;
  /** Satellite: __bridge_status poll interval (ms). */
  statusPollMs: number;
  /** Satellite: one status poll times out after this long (ms). */
  statusTimeoutMs: number;
  /** Satellite: consecutive status timeouts before it fails over. */
  statusFailsBeforeFailover: number;
  /** Satellite: a failover attempt waits failoverDelayMs + random * failoverJitterMs. */
  failoverDelayMs: number;
  failoverJitterMs: number;
}

export const DEFAULT_TIMINGS: Readonly<BridgeTimings> = Object.freeze({
  authTimeoutMs: 5000,
  reconnectGraceMs: 12000,
  autoLaunchCooldownMs: 60000,
  pairWindowMs: 10 * 60 * 1000,
  satelliteReadyDeadlineMs: 15000,
  statusPollMs: 3000,
  statusTimeoutMs: 8000,
  statusFailsBeforeFailover: 3,
  // Jittered: N satellites losing the primary at once must not all bind()
  // in the same millisecond (thundering herd). Spread 1.2-3.2 s.
  failoverDelayMs: 1200,
  failoverJitterMs: 2000,
});

function resolveTimings(t: Partial<BridgeTimings> | undefined): BridgeTimings {
  const out: BridgeTimings = { ...DEFAULT_TIMINGS };
  if (!t) return out;
  for (const k of Object.keys(out) as Array<keyof BridgeTimings>) {
    const v = t[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * Browser process hooks. Every method is optional in the options; a missing
 * one uses the real OS probe. Tests inject them so no browser is ever spawned.
 */
export interface BrowserLauncher {
  /** Start a browser binary, detached. */
  spawn(bin: string, args: string[]): void;
  /** Which supported browser families have a running process. */
  running(): Record<BrowserId, boolean> | Promise<Record<BrowserId, boolean>>;
  /** OS default browser family, when it is one we support. */
  defaultBrowser(): BrowserId | null;
  /** Binary of a browser family, or null when it is not installed. */
  resolve(id: BrowserId): string | null;
}

const EXT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EXT_ORIGIN_RE = /^(?:chrome-extension|moz-extension):\/\/([A-Za-z0-9_-]{1,64})\/?$/;
const INSTALL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Keys, nonces and proofs: 32 bytes as lowercase hex. */
const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------- small helpers ----------

type Env = Record<string, string | undefined>;
type LogFn = (line: string) => void;

function defaultLog(line: string): void {
  console.error(`[bridge:${process.pid}] ${line}`);
}

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

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

/** Order-insensitive identity of a permission snapshot (change detection). */
function permsKey(d: string[] | null): string {
  return d ? JSON.stringify([...d].sort()) : "null";
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

function envLaunchTimeoutMs(env: Env): number {
  const v = Number(env.BROWSER_LAUNCH_TIMEOUT_MS ?? 45000);
  return Number.isFinite(v) && v > 0 ? v : 45000;
}

/** Boolean switches such as BROWSER_MCP_PAIR=1. */
function envFlag(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

/** The error a send() rejects with when its AbortSignal fires. */
export function abortError(): Error {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === "AbortError";
}

/** Settle bookkeeping shared by every path that ends a pending request. */
function takePending(pending: Map<string, Pending>, id: string): Pending | null {
  const p = pending.get(id);
  if (!p) return null;
  pending.delete(id);
  clearTimeout(p.timer);
  p.unlisten?.();
  return p;
}

/**
 * Register a request, send its frame and settle it on reply (by the caller,
 * through takePending), timeout, send failure or abort. onAbort runs after
 * the entry is gone; it sends the cancel frame.
 */
function startRequest<T>(
  pending: Map<string, Pending>,
  r: {
    id: string;
    action: string;
    ws: WebSocket;
    frame: () => string;
    timeoutMs: number;
    timeoutMessage: string;
    signal?: AbortSignal;
    onAbort: () => void;
  }
): Promise<T> {
  if (r.signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const fail = (err: unknown) => {
      if (!takePending(pending, r.id)) return;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => fail(timeoutError(r.timeoutMessage)), r.timeoutMs);
    let unlisten: (() => void) | null = null;
    const signal = r.signal;
    if (signal) {
      const onAbort = () => {
        if (!takePending(pending, r.id)) return;
        reject(abortError());
        try { r.onAbort(); } catch {}
      };
      signal.addEventListener("abort", onAbort, { once: true });
      unlisten = () => signal.removeEventListener("abort", onAbort);
    }
    pending.set(r.id, { resolve: resolve as (v: unknown) => void, reject, timer, ws: r.ws, action: r.action, unlisten });
    try {
      r.ws.send(r.frame(), (err) => {
        if (err) fail(err);
      });
    } catch (e) {
      fail(e);
    }
  });
}

/** Rejects with AbortError as soon as the signal fires; p keeps running. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

function randomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Handshake proof: HMAC-SHA256 keyed with the hex-decoded install key.
 * The side label keeps a server proof from ever passing as an extension proof; the port (the one
 * this server is bound to, the one the extension dialed) keeps a challenge from another primary
 * that shares the config directory from verifying when a process on the extension's port relays it.
 */
function handshakeProof(
  keyHex: string,
  side: "server" | "extension",
  extId: string,
  installId: string,
  port: number,
  first: string,
  second: string
): string {
  return crypto
    .createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(`browser-mcp/v3|${side}|${extId}|${installId}|${port}|${first}|${second}`, "utf8")
    .digest("hex");
}

/**
 * Client (satellite / script) auth proof: HMAC-SHA256 keyed with the hex-decoded bridge token of
 * `port`. Each side proves the token without sending it; the label and the nonce order keep one
 * side's proof from passing as the other's.
 */
function clientAuthProof(tokenHex: string, side: "server" | "client", port: number, first: string, second: string): string {
  return crypto
    .createHmac("sha256", Buffer.from(tokenHex, "hex"))
    .update(`browser-mcp/client|${side}|${port}|${first}|${second}`, "utf8")
    .digest("hex");
}

/** Log a line at most once per `everyMs` for its key. */
function logThrottledTo(throttle: Map<string, number>, log: LogFn, key: string, line: string, everyMs: number): void {
  const now = Date.now();
  const last = throttle.get(key) ?? 0;
  if (now - last < everyMs) return;
  if (throttle.size > 200) throttle.clear();
  throttle.set(key, now);
  log(line);
}

function proofMatches(expectedHex: string, got: unknown): boolean {
  if (typeof got !== "string" || !HEX64_RE.test(got)) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(got, "hex"));
}

// ---------- config directory (tokens, trusted ids, install keys, sticky browser, last permission snapshot) ----------

const ensuredDirs = new Set<string>();

/** Create a config directory once per process (owner-only where POSIX modes exist). */
function ensureDir(dir: string, log: LogFn = defaultLog): string {
  if (ensuredDirs.has(dir)) return dir;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensuredDirs.add(dir);
  } catch (e) {
    log(`cannot create config dir ${dir}: ${errText(e)}`);
  }
  return dir;
}

/**
 * Per-user config directory: BROWSER_MCP_HOME or ~/.browser-mcp (created
 * with owner-only permissions where the OS supports POSIX modes).
 */
export function configDir(env: Env = process.env): string {
  const dir = (env.BROWSER_MCP_HOME ?? "").trim() || path.join(os.homedir(), ".browser-mcp");
  return ensureDir(dir);
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

function tokenFile(dir: string, port: number): string {
  return path.join(dir, `bridge-${port}.token`);
}

function readTokenFile(dir: string, port: number): string | null {
  try {
    const t = fs.readFileSync(tokenFile(dir, port), "utf8").trim();
    return /^[0-9a-f]{64}$/i.test(t) ? t : null;
  } catch {
    return null;
  }
}

function trustedFile(dir: string): string {
  return path.join(dir, "trusted-extensions.json");
}

type TrustedFileState = { ids: string[]; state: "missing" | "ok" | "corrupt" };

function readTrustedFile(dir: string): TrustedFileState {
  let text: string;
  try {
    text = fs.readFileSync(trustedFile(dir), "utf8");
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
function addTrustedFileId(dir: string, id: string, log: LogFn): boolean {
  const cur = readTrustedFile(dir);
  if (cur.state === "corrupt") return false;
  if (cur.ids.includes(id)) return true;
  try {
    writePrivateFile(trustedFile(dir), JSON.stringify({ ids: [...cur.ids, id] }, null, 2) + "\n");
    return true;
  } catch (e) {
    log(`cannot write ${trustedFile(dir)}: ${errText(e)}`);
    return false;
  }
}

/** One paired extension install. The key never leaves this file and the handshake. */
type InstallKey = {
  extensionId: string;
  installId: string;
  /** 32-byte key as lowercase hex. */
  key: string;
  /** ISO timestamp of the pairing. */
  pairedAt: string;
  browser: string | null;
};

type KeysFileState = { installs: InstallKey[]; state: "missing" | "ok" | "corrupt" };

function keysFile(dir: string): string {
  return path.join(dir, "extension-keys.json");
}

function readKeysFile(dir: string): KeysFileState {
  let text: string;
  try {
    text = fs.readFileSync(keysFile(dir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { installs: [], state: "missing" };
    return { installs: [], state: "corrupt" };
  }
  if (!text.trim()) return { installs: [], state: "missing" };
  try {
    const j = JSON.parse(text) as unknown;
    // Another format version is left alone (never downgraded by a rewrite).
    if (!isPlainObject(j) || j.version !== 1 || !Array.isArray(j.installs)) return { installs: [], state: "corrupt" };
    const installs: InstallKey[] = [];
    for (const it of j.installs) {
      if (!isPlainObject(it)) continue;
      const extensionId = typeof it.extensionId === "string" ? it.extensionId.toLowerCase() : "";
      const installId = typeof it.installId === "string" ? it.installId : "";
      const key = typeof it.key === "string" ? it.key.toLowerCase() : "";
      if (!EXT_ID_RE.test(extensionId) || !INSTALL_ID_RE.test(installId) || !HEX64_RE.test(key)) continue;
      installs.push({
        extensionId,
        installId,
        key,
        pairedAt: typeof it.pairedAt === "string" ? it.pairedAt.slice(0, 40) : "",
        browser: typeof it.browser === "string" ? it.browser.slice(0, 32) : null,
      });
    }
    return { installs, state: "ok" };
  } catch {
    return { installs: [], state: "corrupt" };
  }
}

/** Split a comma separated id list ("*" = accept any extension). */
function parseIdList(values: Array<string | undefined | null>, log: LogFn): { ids: string[]; wildcard: boolean } {
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
      else log(`ignoring invalid extension id ${JSON.stringify(part.trim())}`);
    }
  }
  return { ids: [...new Set(ids)], wildcard };
}

// ---------- primary bridge ----------

type PeerState = {
  kind: "extension" | "client";
  /** Extension id from the Origin header (extension sockets only). */
  extId: string | null;
  /** client: token auth completed; extension: handshake completed. */
  authed: boolean;
  /** Socket is being closed by us (rejected); ignore further frames. */
  closing: boolean;
  helloAt: number;
  browser: BrowserId | null;
  version: string | null;
  disabled: string[] | null;
  authTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Handshake progress. Extension: waiting for hello, for auth (challenge), for pair_accept, or done.
   * Client: waiting for auth, for auth_proof (challenge), or done.
   */
  stage: "hello" | "challenge" | "pair" | "done";
  /** Bridge protocol from the hello. */
  protocol: number | null;
  installId: string | null;
  /** Nonces of the running handshake (extension's, server's). */
  nonceE: string | null;
  nonceS: string | null;
  /** Key the extension has to prove: the stored one (challenge) or the offered one (pair). */
  key: string | null;
};

function newPeer(kind: "extension" | "client", extId: string | null): PeerState {
  return {
    kind,
    extId,
    authed: false,
    closing: false,
    helloAt: 0,
    browser: null,
    version: null,
    disabled: null,
    authTimer: null,
    stage: "hello",
    protocol: null,
    installId: null,
    nonceE: null,
    nonceS: null,
    key: null,
  };
}

export interface ExtensionBridgeOptions {
  exitOnAddrInUse?: boolean;
  /** Extra trusted extension ids (e.g. from --extension-id). "*" = accept any. */
  extensionIds?: string[];
  /**
   * Open the pairing window for one new extension install, for 10 minutes
   * after start (--pair). Default: BROWSER_MCP_PAIR=1.
   */
  pair?: boolean;
  /**
   * Accept protocol-2 (0.3.x) extensions without a key: the link is then NOT
   * authenticated (--allow-legacy-extension). Default: BROWSER_MCP_ALLOW_LEGACY_EXTENSION=1.
   */
  allowLegacyExtension?: boolean;
  /** Config directory (token, trust, keys, sticky browser). Default: BROWSER_MCP_HOME or ~/.browser-mcp. */
  configDir?: string;
  /** Environment read for BROWSER_MCP_* / BROWSER* settings. Default: process.env. */
  env?: Env;
  /** Timing overrides (tests). */
  timings?: Partial<BridgeTimings>;
  /**
   * false: this bridge never starts a browser by itself (also not for relayed
   * satellite commands). Default: BROWSER_AUTO_LAUNCH !== "0", and a
   * satellite's own preference wins for its commands.
   */
  autoLaunch?: boolean;
  /** Browser process hooks (tests); missing ones use the real OS probes. */
  launcher?: Partial<BrowserLauncher>;
  /** Log sink for bridge diagnostics. Default: stderr with a [bridge:<pid>] prefix. */
  log?: (line: string) => void;
  /**
   * @internal Start of the pair window (epoch ms). A promoted satellite passes
   * its own start time so --pair counts from the process start.
   */
  pairSince?: number;
}

/** Options of a satellite; the same set is used when it promotes itself to primary. */
export type BridgeClientOptions = Omit<ExtensionBridgeOptions, "exitOnAddrInUse" | "pairSince">;

export class ExtensionBridge implements IBridge {
  private readonly requestedPort: number;
  /** Bound port once listening (differs from the requested one for port 0). */
  private boundPort: number | null = null;
  private wss: WebSocketServer;
  private peers = new Map<WebSocket, PeerState>();
  /** Extension socket that most recently completed the handshake; receives commands. */
  private active: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  /** In-flight relayed commands per satellite socket: its request id -> abort handle. */
  private relays = new Map<WebSocket, Map<string, AbortController>>();
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
  private permsListeners = new Set<(disabled: string[] | null) => void>();
  private lastEmittedPerms = "null";
  private readonly token = crypto.randomBytes(32).toString("hex");
  private readonly explicitIds: Set<string>;
  private readonly wildcard: boolean;
  /** Explicit list given (env/CLI): no trust-on-first-use. */
  private readonly strict: boolean;
  private sessionTrusted = new Set<string>();
  /** Installs paired while extension-keys.json could not be written (this run only). */
  private sessionKeys = new Map<string, InstallKey>();
  private rejected: string[] = [];
  private lastRefusal: ExtensionRefusal | null = null;
  private logThrottle = new Map<string, number>();
  private readonly env: Env;
  private readonly configDirOpt: string | null;
  private readonly timings: BridgeTimings;
  private readonly autoLaunchOpt: boolean | undefined;
  private readonly launcher: Partial<BrowserLauncher>;
  private readonly log: LogFn;
  private readonly pairOpt: boolean;
  private readonly pairSince: number;
  /** A new install paired in this process (closes the pair-option window). */
  private pairedThisRun = false;
  private readonly allowLegacy: boolean;

  // ring buffers for pushed events (so tools work even with polling)
  consoleEvents: Array<unknown> = [];
  networkEvents: Array<unknown> = [];

  constructor(port: number, opts?: ExtensionBridgeOptions) {
    this.requestedPort = port;
    this.exitOnAddrInUse = opts?.exitOnAddrInUse ?? true;
    this.env = opts?.env ?? process.env;
    this.configDirOpt = opts?.configDir?.trim() ? path.resolve(opts.configDir.trim()) : null;
    this.timings = resolveTimings(opts?.timings);
    this.autoLaunchOpt = opts?.autoLaunch;
    this.launcher = opts?.launcher ?? {};
    this.log = opts?.log ?? defaultLog;
    this.pairOpt = opts?.pair ?? envFlag(this.env.BROWSER_MCP_PAIR);
    this.pairSince = opts?.pairSince ?? Date.now();
    this.allowLegacy = opts?.allowLegacyExtension ?? envFlag(this.env.BROWSER_MCP_ALLOW_LEGACY_EXTENSION);
    const parsed = parseIdList([this.env.BROWSER_MCP_EXTENSION_IDS, ...(opts?.extensionIds ?? [])], this.log);
    this.explicitIds = new Set(parsed.ids);
    this.wildcard = parsed.wildcard;
    this.strict = !parsed.wildcard && parsed.ids.length > 0;
    // Last permission snapshot from a previous run (F14): browser_close stays
    // refused after a restart while the extension is silent. A hello or perms
    // event from the extension replaces it. Port 0 has no file name until bound.
    if (port !== 0) this.loadPersistedPerms();
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
        this.log(`connection handler failed: ${errText(e)}`);
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
        this.log(`port ${port} in use, will join as satellite`);
      } else {
        this.log(`wss error: ${errText(e)}`);
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
      const addr = this.wss.address();
      if (addr && typeof addr === "object" && typeof addr.port === "number") this.boundPort = addr.port;
      if (port === 0) this.loadPersistedPerms();
      this.log(`ws listening on ws://127.0.0.1:${this.port} (primary)`);
      // Satellites / CLI scripts authenticate with this per-run token.
      const tf = tokenFile(this.dir(), this.port);
      try {
        writePrivateFile(tf, this.token);
      } catch (e) {
        this.log(`cannot write bridge token ${tf} (satellites will be refused): ${errText(e)}`);
      }
      if (this.wildcard) {
        this.log(`WARNING: BROWSER_MCP_EXTENSION_IDS=* accepts ANY browser extension as the bridge extension (legacy mode)`);
      } else if (this.tofuOpen()) {
        this.log(`no trusted extension paired yet; the first extension that connects will be trusted (${trustedFile(this.dir())})`);
      }
      if (this.pairedInstallCount() === 0) {
        this.log(`no extension install paired yet; the first install that connects gets a pairing key (${keysFile(this.dir())})`);
      } else if (this.pairOptionOpen()) {
        this.log(`pairing open for one new extension install for ${Math.round(this.timings.pairWindowMs / 60000)} min (--pair)`);
      }
      if (this.allowLegacy) {
        this.log(`WARNING: protocol-2 extensions are accepted WITHOUT authentication (--allow-legacy-extension); update the extension and drop this option`);
      }
      if (!this.readySettled) {
        this.readySettled = true;
        this.readyResolve?.();
      }
    });
  }

  /** Bound port once listening (the requested one before that). */
  get port(): number {
    return this.boundPort ?? this.requestedPort;
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

  /** Config directory of this bridge (option, else BROWSER_MCP_HOME / ~/.browser-mcp). */
  private dir(): string {
    return this.configDirOpt ? ensureDir(this.configDirOpt, this.log) : configDir(this.env);
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
    const active = this.active ? this.peers.get(this.active) : undefined;
    return {
      mode: "primary",
      pid: process.pid,
      peers: this.peerCount(),
      extensions: this.extensionCount(),
      trustedExtensionIds: this.trustedIds(),
      rejectedExtensionIds: [...this.rejected],
      tofuOpen: this.tofuOpen(),
      configDir: this.dir(),
      extensionVersion: active?.version ?? null,
      extensionProtocol: active?.protocol ?? null,
      pairingOpen: this.pairingOpen(),
      pairedInstalls: this.pairedInstallCount(),
      serverVersion: SERVER_VERSION,
      bridgeProtocol: BRIDGE_PROTOCOL,
      legacyExtensionAllowed: this.allowLegacy,
      lastExtensionRefusal: this.lastRefusal ? { ...this.lastRefusal } : null,
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

  onPermsChange(cb: (disabled: string[] | null) => void): () => void {
    this.permsListeners.add(cb);
    return () => {
      this.permsListeners.delete(cb);
    };
  }

  /** Tell subscribers about a changed snapshot (repeats of the same set are skipped). */
  private emitPerms(): void {
    const d = this.knownDisabled();
    const key = permsKey(d);
    if (key === this.lastEmittedPerms) return;
    this.lastEmittedPerms = key;
    for (const cb of [...this.permsListeners]) {
      try {
        cb(d ? [...d] : null);
      } catch (e) {
        this.log(`perms listener failed: ${errText(e)}`);
      }
    }
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
    this.emitPerms();
  }

  // ----- trust -----

  private trustedIds(): string[] {
    if (this.wildcard) return ["*"];
    const all = new Set<string>([...BUILTIN_EXTENSION_IDS, ...this.explicitIds, ...this.sessionTrusted, ...readTrustedFile(this.dir()).ids]);
    return [...all].sort();
  }

  private isTrusted(id: string): boolean {
    if (this.wildcard) return true;
    if (BUILTIN_EXTENSION_IDS.includes(id) || this.explicitIds.has(id) || this.sessionTrusted.has(id)) return true;
    return readTrustedFile(this.dir()).ids.includes(id);
  }

  /** Trust-on-first-use is open until the first extension is paired. */
  tofuOpen(): boolean {
    if (this.wildcard || this.strict || this.sessionTrusted.size > 0) return false;
    const t = readTrustedFile(this.dir());
    return t.state === "missing" || (t.state === "ok" && t.ids.length === 0);
  }

  // ----- pairing keys -----

  private installKeyId(extId: string, installId: string): string {
    return `${extId}|${installId}`;
  }

  private findInstallKey(extId: string, installId: string): InstallKey | null {
    const keys = readKeysFile(this.dir());
    const hit = keys.installs.find((i) => i.extensionId === extId && i.installId === installId);
    return hit ?? this.sessionKeys.get(this.installKeyId(extId, installId)) ?? null;
  }

  private pairedInstallCount(): number {
    return readKeysFile(this.dir()).installs.length + this.sessionKeys.size;
  }

  /** The pair option's window: 10 min from start, closed by the first new install. */
  private pairOptionOpen(): boolean {
    return this.pairOpt && !this.pairedThisRun && Date.now() - this.pairSince < this.timings.pairWindowMs;
  }

  /**
   * A new install may get a key: none is paired yet (first setup), or the pair
   * option is active. An unreadable keys file does not count as "none paired".
   */
  pairingOpen(): boolean {
    const keys = readKeysFile(this.dir());
    if (keys.state !== "corrupt" && keys.installs.length + this.sessionKeys.size === 0) return true;
    return this.pairOptionOpen();
  }

  /** Save a new install key (replacing an older key of the same install). */
  private persistInstall(entry: InstallKey): boolean {
    const dir = this.dir();
    const file = keysFile(dir);
    const cur = readKeysFile(dir);
    if (cur.state === "corrupt") {
      // Only reached through an explicit pairing (--pair): keep the unreadable
      // file for inspection instead of silently overwriting it.
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, backup);
        this.log(`moved unreadable ${file} to ${backup}`);
      } catch (e) {
        this.log(`cannot move unreadable ${file} aside: ${errText(e)}`);
        return false;
      }
    }
    const installs = cur.installs.filter((i) => !(i.extensionId === entry.extensionId && i.installId === entry.installId));
    installs.push(entry);
    if (installs.length > MAX_INSTALLS) installs.splice(0, installs.length - MAX_INSTALLS);
    try {
      writePrivateFile(file, JSON.stringify({ version: 1, installs }, null, 2) + "\n");
      return true;
    } catch (e) {
      this.log(`cannot write ${file}: ${errText(e)}`);
      return false;
    }
  }

  private logThrottled(key: string, line: string, everyMs = 60000): void {
    logThrottledTo(this.logThrottle, this.log, key, line, everyMs);
  }

  /** Close a socket we refuse; its later frames are ignored. */
  private closePeer(ws: WebSocket, peer: PeerState, code: number, reason: string): void {
    // Handshake refusals explain a "not connected" error later (4006 is a normal replacement).
    if (peer.kind === "extension" && !peer.authed && code !== 4006) {
      this.lastRefusal = { code, reason: reason.slice(0, 120), extensionId: peer.extId ?? "unknown", at: Date.now() };
    }
    peer.closing = true;
    if (peer.authTimer) {
      clearTimeout(peer.authTimer);
      peer.authTimer = null;
    }
    try {
      ws.close(code, reason.slice(0, 120));
    } catch {
      try { ws.terminate(); } catch {}
    }
  }

  private rejectExtension(ws: WebSocket, peer: PeerState): void {
    const id = peer.extId ?? "unknown";
    this.rejected = this.rejected.filter((x) => x !== id);
    this.rejected.push(id);
    if (this.rejected.length > MAX_REJECTED) this.rejected.splice(0, this.rejected.length - MAX_REJECTED);
    this.logThrottled(
      `ext:${id}`,
      `refused untrusted extension ${id} (trust it via BROWSER_MCP_EXTENSION_IDS / --extension-id or ${trustedFile(this.dir())})`
    );
    this.closePeer(ws, peer, 4003, `untrusted-extension:${id}`);
  }

  /** Untrusted id once trust-on-first-use is closed: refuse with 4003. */
  private checkTrust(ws: WebSocket, peer: PeerState): boolean {
    if (this.isTrusted(peer.extId!) || this.tofuOpen()) return true;
    this.rejectExtension(ws, peer);
    return false;
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
      peer = newPeer("extension", extId);
    } else {
      peer = newPeer("client", null);
    }
    this.peers.set(ws, peer);
    ws.on("message", (raw) => {
      try {
        this.onMessage(ws, rawToText(raw));
      } catch (e) {
        this.log(`bad frame ignored: ${errText(e)}`);
      }
    });
    ws.on("close", (code: number) => {
      try {
        this.noteExtensionRefusal(ws, code);
        this.onClose(ws);
      } catch (e) {
        this.log(`close handler failed: ${errText(e)}`);
      }
    });
    ws.on("error", (e) => this.log(`ws error: ${errText(e)}`));

    if (peer.kind === "extension") {
      // Untrusted id and pairing closed: refuse right away (the extension
      // shows the 4003 reason in its popup).
      if (!this.isTrusted(peer.extId!) && !this.tofuOpen()) {
        this.rejectExtension(ws, peer);
        return;
      }
      // A socket that never finishes the handshake must not linger.
      peer.authTimer = setTimeout(() => {
        peer.authTimer = null;
        if (!peer.authed && !peer.closing) this.closePeer(ws, peer, 4008, "handshake-timeout");
      }, this.timings.authTimeoutMs);
      return;
    }
    peer.authTimer = setTimeout(() => {
      peer.authTimer = null;
      if (!peer.authed) this.refuseClient(ws, peer);
    }, this.timings.authTimeoutMs);
  }

  private refuseClient(ws: WebSocket, peer: PeerState): void {
    this.closePeer(ws, peer, 4001, "auth-required");
  }

  /**
   * The extension refused this server (4100 pair-declined, 4101 server-auth-failed): keep it like
   * one of our own refusals, so browser_status and the "not connected" error can say what to do.
   * Sockets we closed ourselves were recorded by closePeer.
   *
   * Anything with an extension Origin can close with any code, so only a code that answers this
   * server's own handshake step counts (4101 after a challenge or a pair offer, 4100 after a pair
   * offer), and the stored reason is the code's fixed name, never the peer's text.
   */
  private noteExtensionRefusal(ws: WebSocket, code: number): void {
    const peer = this.peers.get(ws);
    const name = EXTENSION_REFUSALS.get(code);
    if (!peer || peer.kind !== "extension" || peer.closing || !name) return;
    const answersOurStep =
      (code === 4101 && (peer.stage === "challenge" || peer.stage === "pair")) || (code === 4100 && peer.stage === "pair");
    if (!answersOurStep) return;
    const refusal: ExtensionRefusal = {
      code,
      reason: name,
      extensionId: peer.extId ?? "unknown",
      at: Date.now(),
    };
    this.lastRefusal = refusal;
    this.logThrottled(
      `ext-refusal:${refusal.extensionId}:${code}`,
      `extension ${refusal.extensionId} refused this server (${code} ${refusal.reason}): ${this.refusalText(refusal)}`
    );
  }

  private onClose(ws: WebSocket): void {
    const peer = this.peers.get(ws);
    this.peers.delete(ws);
    if (peer?.authTimer) clearTimeout(peer.authTimer);
    // Reject only the requests that were sent to this socket.
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      takePending(this.pending, id);
      p.reject(new Error("Extension disconnected"));
    }
    // A departed satellite no longer waits for its commands: stop them.
    const relays = this.relays.get(ws);
    if (relays) {
      this.relays.delete(ws);
      for (const ctrl of relays.values()) ctrl.abort();
    }
    if (!peer || peer.kind !== "extension" || !peer.authed || this.active !== ws) return;
    this.active = null;
    // Fall back to the most recently authenticated other open extension socket.
    let best: [WebSocket, PeerState] | null = null;
    for (const [s, p] of this.peers) {
      if (p.kind !== "extension" || !p.authed || p.closing || s.readyState !== WebSocket.OPEN) continue;
      if (!best || p.helloAt > best[1].helloAt) best = [s, p];
    }
    if (best) {
      this.active = best[0];
      this.log(`extension ${peer.extId} disconnected, switched to ${best[1].extId} (${best[1].browser ?? "?"})`);
      this.applyActivePerms();
      this.notifyConnected();
    } else {
      this.lastExtDropAt = Date.now();
      this.log("extension disconnected");
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

  private sendFrame(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(frame)); } catch {}
  }

  // ----- extension side -----

  private onExtensionMessage(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>, text: string): void {
    if (!peer.authed) {
      // Nothing but the handshake frame of the current step is accepted
      // before the extension is authenticated.
      if (peer.stage === "hello" && msg.type === "hello" && msg.role === "extension") this.onHello(ws, peer, msg);
      else if (peer.stage === "challenge" && msg.type === "auth") this.onExtensionProof(ws, peer, msg, false);
      else if (peer.stage === "pair" && msg.type === "pair_accept") this.onExtensionProof(ws, peer, msg, true);
      return;
    }
    if (msg.type === "event") {
      this.onEvent(ws, peer, msg, text);
      return;
    }
    if (typeof msg.id !== "string") return; // ping, a repeated hello and unknown frames
    // Response: accepted only from the socket the command was sent to.
    const p = this.pending.get(msg.id);
    if (!p || p.ws !== ws) return;
    takePending(this.pending, msg.id);
    const res = msg as unknown as BridgeResponse;
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error((typeof res.error === "string" && res.error) || "extension error"));
  }

  private onHello(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>): void {
    const id = peer.extId!;
    const protocol = typeof msg.protocol === "number" && Number.isSafeInteger(msg.protocol) ? msg.protocol : null;
    peer.protocol = protocol;
    peer.browser = asBrowserId(msg.browser);
    peer.version = typeof msg.version === "string" ? msg.version.slice(0, 32) : null;
    const perms = parseDisabled(msg.perms);
    if (perms) peer.disabled = perms;
    const claimedId = typeof msg.extensionId === "string" ? msg.extensionId.toLowerCase() : null;
    if (claimedId && claimedId !== id) {
      this.log(`extension hello claims id ${claimedId.slice(0, 64)} but its Origin is ${id}; using the Origin`);
    }

    if (protocol !== BRIDGE_PROTOCOL) {
      if (protocol === LEGACY_PROTOCOL && this.allowLegacy) {
        if (!this.checkTrust(ws, peer)) return;
        this.logThrottled(
          "legacy-ext",
          `WARNING: extension ${id} speaks bridge protocol 2; accepted WITHOUT authentication because legacy extensions are allowed (any local process could pose as it). Update the extension.`,
          10 * 60 * 1000
        );
        this.completeHandshake(ws, peer, null);
        return;
      }
      const ext = protocol === null ? "none" : String(protocol);
      const update = protocol !== null && protocol > BRIDGE_PROTOCOL ? "the server" : "the extension";
      this.logThrottled(
        `proto:${id}:${ext}`,
        `refused extension ${id}: it speaks bridge protocol ${ext}, this server speaks ${BRIDGE_PROTOCOL} (update ${update})`
      );
      this.closePeer(ws, peer, 4002, `protocol-mismatch:server=${BRIDGE_PROTOCOL},ext=${ext}`);
      return;
    }
    if (!this.checkTrust(ws, peer)) return;

    const installId = typeof msg.installId === "string" && INSTALL_ID_RE.test(msg.installId) ? msg.installId : null;
    const nonce = typeof msg.nonce === "string" && HEX64_RE.test(msg.nonce) ? msg.nonce : null;
    if (!installId || !nonce) {
      this.logThrottled(`bad-hello:${id}`, `refused extension ${id}: malformed hello (installId / nonce)`);
      this.closePeer(ws, peer, 1008, "bad-hello");
      return;
    }
    peer.installId = installId;
    peer.nonceE = nonce;
    peer.nonceS = randomHex();
    // An extension that says it lost its key (hasKey:false) cannot answer a
    // challenge; it may only pair again, and only while pairing is open.
    const stored = msg.hasKey === false ? null : this.findInstallKey(id, installId);
    if (stored) {
      peer.stage = "challenge";
      peer.key = stored.key;
      this.sendFrame(ws, {
        type: "challenge",
        nonce: peer.nonceS,
        proof: handshakeProof(stored.key, "server", id, installId, this.port, nonce, peer.nonceS),
      });
      return;
    }
    if (!this.pairingOpen()) {
      this.logThrottled(
        `pairing-closed:${id}`,
        `refused new install of extension ${id}: pairing is closed (start the server once with --pair or BROWSER_MCP_PAIR=1, or delete ${keysFile(this.dir())})`
      );
      this.closePeer(ws, peer, 4004, "pairing-closed");
      return;
    }
    // Fresh key, saved only once the extension proves it accepted it.
    peer.stage = "pair";
    peer.key = randomHex();
    this.sendFrame(ws, { type: "pair", nonce: peer.nonceS, key: peer.key });
  }

  /** The extension's answer to a challenge (auth) or to a pairing offer (pair_accept). */
  private onExtensionProof(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>, pairing: boolean): void {
    const id = peer.extId!;
    const expected = handshakeProof(peer.key!, "extension", id, peer.installId!, this.port, peer.nonceS!, peer.nonceE!);
    if (!proofMatches(expected, msg.proof)) {
      this.logThrottled(`auth-failed:${id}`, `extension ${id} failed authentication (install ${peer.installId})`);
      this.closePeer(ws, peer, 4005, "auth-failed");
      return;
    }
    // Another install may have paired while this one answered.
    if (pairing && !this.pairingOpen()) {
      this.closePeer(ws, peer, 4004, "pairing-closed");
      return;
    }
    this.completeHandshake(ws, peer, pairing ? peer.key : null);
  }

  /** Handshake done (v3 proof checked, or a legacy hello): the socket becomes the active extension. */
  private completeHandshake(ws: WebSocket, peer: PeerState, pairedKey: string | null): void {
    const id = peer.extId!;
    // Trust may have changed while the extension answered (another id was
    // pinned first while trust-on-first-use was open).
    if (!this.checkTrust(ws, peer)) return;
    if (pairedKey && peer.installId) {
      const entry: InstallKey = {
        extensionId: id,
        installId: peer.installId,
        key: pairedKey,
        pairedAt: new Date().toISOString(),
        browser: peer.browser,
      };
      const k = this.installKeyId(id, peer.installId);
      if (this.persistInstall(entry)) {
        this.sessionKeys.delete(k);
      } else {
        this.sessionKeys.set(k, entry);
        this.log(`could not save the pairing of extension ${id} in ${keysFile(this.dir())} (kept for this session only)`);
      }
      this.pairedThisRun = true;
      this.log(`paired extension ${id} install ${peer.installId} (${keysFile(this.dir())})`);
    }
    // Record every accepted extension (closes trust-on-first-use after the
    // first pairing). Legacy accept-all mode records nothing.
    const pinned = !this.isTrusted(id);
    if (!this.wildcard) {
      this.sessionTrusted.add(id);
      if (!addTrustedFileId(this.dir(), id, this.log)) {
        this.log(`could not record extension ${id} in ${trustedFile(this.dir())} (kept for this session only)`);
      }
    }
    if (pinned) {
      this.log(`trusted extension ${id} (trust-on-first-use, saved to ${trustedFile(this.dir())})`);
      // Trust-on-first-use is now closed: drop other not-yet-trusted extension sockets.
      for (const [s, p] of this.peers) {
        if (s !== ws && p.kind === "extension" && !p.authed && !p.closing && !this.isTrusted(p.extId!)) this.rejectExtension(s, p);
      }
    }
    peer.key = null;
    peer.nonceE = null;
    peer.nonceS = null;
    peer.stage = "done";
    peer.authed = true;
    if (peer.authTimer) {
      clearTimeout(peer.authTimer);
      peer.authTimer = null;
    }
    peer.helloAt = Date.now();
    // Sticky browser: remember which browser holds the extension so the
    // next launch opens the same one (not hardcoded Chrome-first).
    if (peer.browser) this.rememberBrowser(peer.browser);
    // The most recent handshake owns the extension role (never events/responses).
    this.active = ws;
    this.autoLaunchFailure = null;
    // The same install connected again: its older socket is stale (or a forgery).
    if (peer.installId) {
      for (const [s, p] of this.peers) {
        if (s !== ws && p.kind === "extension" && p.authed && !p.closing && p.extId === id && p.installId === peer.installId) {
          this.closePeer(s, p, 4006, "replaced");
        }
      }
    }
    this.log(
      `extension connected id=${id} browser=${peer.browser ?? "?"}${peer.version ? ` v${peer.version}` : ""} protocol=${peer.protocol ?? "?"} (peers=${this.peerCount()}, extensions=${this.extensionCount()})`
    );
    this.sendFrame(
      ws,
      peer.protocol === BRIDGE_PROTOCOL
        ? { type: "welcome", protocol: BRIDGE_PROTOCOL, pid: process.pid, serverVersion: SERVER_VERSION }
        : { type: "welcome", protocol: LEGACY_PROTOCOL, pid: process.pid }
    );
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
    this.emitPerms();
  }

  /** Per-port permission snapshot file in the per-user config dir (F14). */
  private permsFile(): string {
    return path.join(this.dir(), `perms-${this.port}.json`);
  }

  private loadPersistedPerms(): void {
    const persisted = this.readPersistedPerms();
    if (!persisted || (this.lastDisabled && !this.disabledFromDisk)) return;
    this.lastDisabled = persisted;
    this.disabledFromDisk = true;
    this.enforceEventPerms();
    this.emitPerms();
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
      this.logThrottled("perms-file", `cannot write ${this.permsFile()}: ${errText(e)}`);
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

  /**
   * Client authentication; only the frames of the current step are accepted, anything else is
   * refused (4001). v2 (satellites): { type: "auth", v: 2, nonce } is answered with an
   * auth_challenge that proves this primary holds the token of its port, and the client's
   * auth_proof must prove the same. Legacy { type: "auth", token } (scripts, older processes)
   * still works, although it hands the raw token to whatever listens on the port.
   * Client sockets reuse the handshake fields: nonceE = the client's nonce, nonceS = ours.
   */
  private onClientAuth(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>): void {
    if (peer.stage === "hello" && msg.type === "auth") {
      if (msg.v === 2) {
        const nonce = typeof msg.nonce === "string" && HEX64_RE.test(msg.nonce) ? msg.nonce : null;
        if (nonce) {
          peer.stage = "challenge";
          peer.nonceE = nonce;
          peer.nonceS = randomHex();
          this.sendFrame(ws, {
            type: "auth_challenge",
            nonce: peer.nonceS,
            proof: clientAuthProof(this.token, "server", this.port, nonce, peer.nonceS),
          });
          return;
        }
      } else if (this.checkToken(msg.token)) {
        this.acceptClient(ws, peer);
        return;
      }
    } else if (peer.stage === "challenge" && msg.type === "auth_proof") {
      const expected = clientAuthProof(this.token, "client", this.port, peer.nonceS!, peer.nonceE!);
      if (proofMatches(expected, msg.proof)) {
        this.acceptClient(ws, peer);
        return;
      }
    }
    this.refuseClient(ws, peer);
  }

  private acceptClient(ws: WebSocket, peer: PeerState): void {
    peer.authed = true;
    peer.stage = "done";
    peer.nonceE = null;
    peer.nonceS = null;
    if (peer.authTimer) {
      clearTimeout(peer.authTimer);
      peer.authTimer = null;
    }
    this.sendFrame(ws, { type: "auth_ok", pid: process.pid });
  }

  private onClientMessage(ws: WebSocket, peer: PeerState, msg: Record<string, unknown>): void {
    if (!peer.authed) {
      this.onClientAuth(ws, peer, msg);
      return;
    }
    if (msg.type === "cancel") {
      // Ids are scoped to the sending socket: a satellite can only cancel its own commands.
      if (typeof msg.id === "string") this.relays.get(ws)?.get(msg.id)?.abort();
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
        try { ws.send(JSON.stringify({ id: replyId, ok: false, error: `relay failed: ${errText(e)}` })); } catch {}
      }
    };
    const fail = (err: unknown) => reply(false, undefined, errText(err));
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
    // The satellite's request id maps to this abort handle; aborting it sends
    // the cancel frame with the extension-side command id (sendInner).
    const ctrl = new AbortController();
    let relays = this.relays.get(ws);
    if (!relays) {
      relays = new Map();
      this.relays.set(ws, relays);
    }
    relays.set(replyId, ctrl);
    const done = () => {
      const m = this.relays.get(ws);
      if (m?.get(replyId) !== ctrl) return;
      m.delete(replyId);
      if (!m.size) this.relays.delete(ws);
    };
    this.sendWithLaunch(action, msg.payload, tabId, clampTimeout(msg.timeoutMs), parseLaunchPrefs(msg.launch), ctrl.signal).then(
      (r) => {
        done();
        reply(true, r);
      },
      (e) => {
        done();
        // The satellite already gave up on a cancelled command.
        if (!ctrl.signal.aborted) fail(e);
      }
    );
  }

  // ----- browser launch -----

  get autoLaunch(): boolean {
    return this.autoLaunchOpt ?? this.env.BROWSER_AUTO_LAUNCH !== "0";
  }

  get launchTimeoutMs(): number {
    return envLaunchTimeoutMs(this.env);
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
    if (this.env.BROWSER_PATH) {
      const r = byPath(this.env.BROWSER_PATH);
      if (r) return r;
    }
    const name = (this.env.BROWSER ?? "").trim();
    if (name) {
      const asPath = byPath(name);
      if (asPath) return asPath;
      const id = normalizeBrowserId(name);
      if (id) {
        const b = this.resolveBrowserBin(id);
        if (b) return b;
      }
      this.log(`unknown BROWSER=${JSON.stringify(name)} (want chrome|edge|brave|opera or a binary path), ignoring`);
    }
    if (this.env.CHROME_PATH) {
      const r = byPath(this.env.CHROME_PATH);
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
    const explicitName = (this.env.BROWSER ?? "").trim();
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
        this.spawnBrowser(b, ["--new-window", "about:blank"]);
        spawned = true;
      } catch {}
      const ok = await this.waitForConnection(Math.min(20000, remaining));
      if (ok) {
        return { connected: true, launched: true, detail: `Extension connected via ${b}.` };
      }
    }
    if (this.connected) return { connected: true, launched: spawned, detail: "Extension connected." };
    const rejectedHint = this.rejected.length
      ? ` Extension id(s) ${this.rejected.join(", ")} connected but are not trusted: add them to BROWSER_MCP_EXTENSION_IDS / --extension-id or ${trustedFile(this.dir())}.`
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

  private spawnBrowser(bin: string, args: string[]): void {
    if (this.launcher.spawn) {
      this.launcher.spawn(bin, args);
      return;
    }
    const proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
  }

  private resolveBrowserBin(id: BrowserId): string | null {
    if (this.launcher.resolve) return this.launcher.resolve(id);
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
    if (this.launcher.defaultBrowser) return this.launcher.defaultBrowser();
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
      return path.join(this.dir(), `sticky-browser-${this.port}`);
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
    if (this.launcher.running) return await this.launcher.running();
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

  /** Resolves true as soon as an extension completes the handshake (A11), false on timeout. */
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
    return Math.max(0, anchor + this.timings.reconnectGraceMs - Date.now());
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
      ? ` Untrusted extension id(s) tried to connect: ${this.rejected.join(", ")} (trust via BROWSER_MCP_EXTENSION_IDS / --extension-id or ${trustedFile(this.dir())}).`
      : "";
    return new Error(
      `Browser extension not connected. In Chrome open chrome://extensions -> Developer Mode -> "Load unpacked" and select the extension/ folder. The WS port must be listening.${hint}${this.refusalHint()}`
    );
  }

  /** Why the last extension that tried to connect was refused (recent ones only). */
  private refusalHint(): string {
    const r = this.lastRefusal;
    if (!r || Date.now() - r.at > 10 * 60 * 1000) return "";
    const text = this.refusalText(r);
    return text ? ` ${text}` : "";
  }

  /** What to do about a refused handshake; "" when there is nothing to advise. */
  private refusalText(r: ExtensionRefusal): string {
    const keys = keysFile(this.dir());
    // Both work whatever key either side holds: "Forget pairing" makes the extension ask for a
    // new key (hasKey:false) and --pair lets this server offer one; with the keys file gone the
    // server offers a key to every install, which an extension that still holds one accepts
    // only after the user clicks Re-pair (it closes 4100 and shows the button first).
    const repair = `use "Forget pairing" in the extension popup and start the server once with --pair (or BROWSER_MCP_PAIR=1), or delete ${keys} and click Re-pair in the popup when it asks.`;
    switch (r.code) {
      case 4002:
        return `An extension with another bridge protocol was refused (${r.reason}): update the older side so both speak protocol ${BRIDGE_PROTOCOL}.`;
      case 4004:
        return `A new extension install was refused because pairing is closed: start the server once with --pair (or BROWSER_MCP_PAIR=1) and reconnect the extension, or delete ${keys}.`;
      case 4005:
        return `An extension failed the pairing-key check: ${repair}`;
      case 4008:
        return "An extension connected but did not finish the handshake in time.";
      case 4100:
        return `The extension declined the new pairing key this server offered: it still holds the key of an earlier pairing that this server does not know (for example after ${keys} was deleted, or with another BROWSER_MCP_HOME). If this is the server it should use, click Re-pair in the extension popup.`;
      case 4101:
        return `The extension could not verify this server's pairing key (it has been paired with another server or config directory since): ${repair}`;
      default:
        return "";
    }
  }

  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs = 30000, opts?: SendOptions): Promise<T> {
    return this.sendWithLaunch<T>(action, payload, tabId, timeoutMs, null, opts?.signal);
  }

  /** send() with a caller's launch preferences (relayed satellite commands). */
  private sendWithLaunch<T = unknown>(
    action: string,
    payload: unknown,
    tabId: number | undefined,
    timeoutMs: number,
    prefs: LaunchPrefs | null,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.connected) return this.sendInner<T>(action, payload, tabId, timeoutMs, signal);
    const run = (async () => {
      // An extension that just dropped (or a fresh primary after failover)
      // usually reconnects within its backoff: wait for it instead of
      // spawning a browser window (A6). Skipped when no browser runs at all.
      const grace = this.reconnectGraceRemaining();
      if (grace > 0) {
        const running = await this.runningBrowsers();
        if (Object.values(running).some(Boolean) && (await this.waitForConnection(grace))) {
          return this.sendInner<T>(action, payload, tabId, timeoutMs, signal);
        }
      }
      const auto = this.autoLaunchOpt === false ? false : (prefs?.auto ?? this.autoLaunch);
      if (!auto) throw this.notConnectedError();
      const f = this.autoLaunchFailure;
      const cooldown = this.timings.autoLaunchCooldownMs;
      if (f && Date.now() - f.at < cooldown) {
        const ago = Math.round((Date.now() - f.at) / 1000);
        throw new Error(`${f.detail} (auto-launch failed ${ago}s ago and is paused for ${Math.round(cooldown / 1000)}s; call browser_launch to retry now)`);
      }
      // A cancelled caller must not start a browser.
      if (signal?.aborted) throw abortError();
      const r = await this.launchBrowser(undefined, { browser: prefs?.browser });
      if (!r.connected || !this.connected) {
        this.autoLaunchFailure = { at: Date.now(), detail: r.detail };
        throw new Error(`${r.detail} (auto-launch ${r.launched ? "tried" : "skipped"})`);
      }
      return this.sendInner<T>(action, payload, tabId, timeoutMs, signal);
    })();
    // The wait / launch is shared and keeps going; only this caller gives up.
    return raceAbort(run, signal);
  }

  private sendInner<T = unknown>(action: string, payload: unknown, tabId: number | undefined, timeoutMs = 30000, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    const target = this.active;
    if (!target || target.readyState !== WebSocket.OPEN) return Promise.reject(this.notConnectedError());
    const id = `cmd-${crypto.randomUUID()}`;
    const req: BridgeRequest = { id, action, tabId, payload, timeoutMs };
    return startRequest<T>(this.pending, {
      id,
      action,
      ws: target,
      frame: () => JSON.stringify(req),
      timeoutMs,
      timeoutMessage: `Extension timed out (${action}, ${timeoutMs}ms)`,
      signal,
      // Only the socket that got the command learns about the cancel.
      onAbort: () => this.sendFrame(target, { type: "cancel", id }),
    });
  }

  close(): void {
    for (const [id, p] of this.pending) {
      takePending(this.pending, id);
      p.reject(new Error("Bridge closed"));
    }
    this.pending.clear();
    this.relays.clear();
    for (const [, p] of this.peers) {
      if (p.authTimer) {
        clearTimeout(p.authTimer);
        p.authTimer = null;
      }
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
  private permsListeners = new Set<(disabled: string[] | null) => void>();
  private lastEmittedPerms = "null";
  /** The primary proved it holds the token and accepted ours (auth_ok after our auth_proof). */
  private authed = false;
  /** Client auth of the current link while it runs: our nonce, the token it uses, the step. */
  private linkAuth: { ws: WebSocket; token: string; nonce: string; stage: "challenge" | "proof"; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Consecutive links that ended without a verified primary; stretches the retry delay. */
  private authFailures = 0;
  private logThrottle = new Map<string, number>();
  private warnedLaunchPrefs = false;
  private warnedPairing = false;
  /** Own options; a promotion to primary uses them too (pair, legacy, config dir...). */
  private readonly opts: BridgeClientOptions;
  private readonly env: Env;
  private readonly timings: BridgeTimings;
  private readonly log: LogFn;
  private readonly startedAt = Date.now();

  constructor(port: number, opts?: BridgeClientOptions) {
    this.port = port;
    this.opts = { ...(opts ?? {}) };
    this.env = this.opts.env ?? process.env;
    this.timings = resolveTimings(this.opts.timings);
    this.log = this.opts.log ?? defaultLog;
    // A failed first link is retried (failover / reconnect) for a bounded
    // time before ready() rejects (A8).
    this.readyDeadline = setTimeout(() => {
      this.readyDeadline = null;
      const why = this.lastError?.message ? `: ${this.lastError.message}` : "";
      this.settleReady(new Error(`Cannot reach or take over the primary bridge on :${port}${why}`));
    }, this.timings.satelliteReadyDeadlineMs);
    this.connect();
  }

  ready(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.readySettled) {
        if (this.primary || this.linkOpen) resolve();
        else reject(this.lastError ?? new Error(`Satellite bridge to :${this.port} is not connected`));
        return;
      }
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  get connected(): boolean {
    if (this.primary) return this.primary.connected;
    return this.linkOpen && this.extensionConnected;
  }

  get mode(): "primary" | "satellite" {
    // A promoted satellite behaves as the primary for its agent.
    return this.primary ? "primary" : "satellite";
  }

  private dir(): string {
    const d = this.opts.configDir?.trim();
    return d ? ensureDir(path.resolve(d), this.log) : configDir(this.env);
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
      configDir: s?.configDir ?? this.dir(),
      extensionVersion: s?.extensionVersion,
      extensionProtocol: s?.extensionProtocol,
      pairingOpen: s?.pairingOpen,
      pairedInstalls: s?.pairedInstalls,
      serverVersion: s?.serverVersion,
      bridgeProtocol: s?.bridgeProtocol,
      legacyExtensionAllowed: s?.legacyExtensionAllowed,
      lastExtensionRefusal: s?.lastExtensionRefusal,
    };
  }

  knownDisabled(): string[] | null {
    if (this.primary) return this.primary.knownDisabled();
    return this.lastDisabled ? [...this.lastDisabled] : null;
  }

  onPermsChange(cb: (disabled: string[] | null) => void): () => void {
    this.permsListeners.add(cb);
    return () => {
      this.permsListeners.delete(cb);
    };
  }

  /** Tell subscribers about a changed snapshot (repeats of the same set are skipped). */
  private emitPerms(): void {
    const d = this.knownDisabled();
    const key = permsKey(d);
    if (key === this.lastEmittedPerms) return;
    this.lastEmittedPerms = key;
    for (const cb of [...this.permsListeners]) {
      try {
        cb(d ? [...d] : null);
      } catch (e) {
        this.log(`perms listener failed: ${errText(e)}`);
      }
    }
  }

  /** Authenticated link state (ignores extension status) — used internally for polling. */
  private get linkOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.authed;
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
      this.log(`satellite link open on :${this.port}, authenticating the primary`);
      // Mutual auth before anything else (token re-read on every attempt: a new primary writes a
      // new one). The token itself never goes on the wire: whatever holds the port has to prove
      // it knows the token before this satellite proves the same and sends commands.
      const dir = this.dir();
      const token = readTokenFile(dir, this.port);
      if (!token) {
        this.failAuth(
          ws,
          `no bridge token at ${tokenFile(dir, this.port)}, so the process on :${this.port} cannot be verified`,
          "every browser-mcp server sharing this port needs the same config directory (BROWSER_MCP_HOME)"
        );
        return;
      }
      const nonce = randomHex();
      // A primary answers in one round trip; a silent peer is treated like a failed proof.
      const timer = setTimeout(() => {
        if (this.linkAuth?.ws === ws) this.failAuth(ws, `the process on :${this.port} did not answer authentication within ${this.timings.statusTimeoutMs}ms`);
      }, this.timings.statusTimeoutMs);
      this.linkAuth = { ws, token, nonce, stage: "challenge", timer };
      try { ws.send(JSON.stringify({ type: "auth", v: 2, nonce })); } catch {}
    });
    ws.on("message", (raw) => {
      try {
        this.onLinkMessage(ws, rawToText(raw));
      } catch (e) {
        this.log(`satellite: bad frame ignored: ${errText(e)}`);
      }
    });
    ws.on("close", (code: number) => {
      if (this.ws !== ws) return;
      let why = `Primary bridge on :${this.port} closed`;
      if (code === 4001) {
        // A stale token, or a primary from before the v2 client auth: it only knows the legacy
        // raw-token frame, which this satellite never sends. Retry with backoff.
        if (!this.authed) this.authFailures++;
        why = `Primary bridge on :${this.port} refused authentication (stale token, or a primary of an older browser-mcp release that needs a restart)`;
      }
      this.dropLink(ws, new Error(why));
    });
    ws.on("error", (e) => {
      this.log(`satellite ws error: ${errText(e)}`);
      // (dropLink first, for the same reason as in failAuth)
      this.dropLink(ws, e as Error);
      try { ws.terminate(); } catch {}
    });
  }

  private onLinkMessage(ws: WebSocket, text: string): void {
    if (this.ws !== ws) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      msg = null;
    }
    if (!this.authed) {
      // Before auth_ok only the auth frames of the current step count; events or replies from
      // a peer that has not proved the token are never applied.
      this.onLinkAuth(ws, isPlainObject(msg) ? msg : {});
      return;
    }
    if (!isPlainObject(msg)) return;
    if (msg.type === "auth_ok") return;
    if (msg.type === "event") {
      this.onEvent(msg);
      return;
    }
    if (typeof msg.id !== "string") return;
    const p = takePending(this.pending, msg.id);
    if (!p) return;
    const res = msg as unknown as BridgeResponse;
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error((typeof res.error === "string" && res.error) || "primary bridge error"));
  }

  /** The client auth steps of a link (see the header comment): verify the primary, then prove the token. */
  private onLinkAuth(ws: WebSocket, msg: Record<string, unknown>): void {
    const a = this.linkAuth;
    if (!a || a.ws !== ws) {
      this.failAuth(ws, `the process on :${this.port} sent a frame before authentication started`);
      return;
    }
    if (a.stage === "challenge" && msg.type === "auth_challenge") {
      const np = typeof msg.nonce === "string" && HEX64_RE.test(msg.nonce) ? msg.nonce : null;
      if (np && proofMatches(clientAuthProof(a.token, "server", this.port, a.nonce, np), msg.proof)) {
        a.stage = "proof";
        try { ws.send(JSON.stringify({ type: "auth_proof", proof: clientAuthProof(a.token, "client", this.port, np, a.nonce) })); } catch {}
        return;
      }
      this.failAuth(ws, `the process on :${this.port} could not prove it holds the bridge token (${tokenFile(this.dir(), this.port)})`);
      return;
    }
    if (a.stage === "proof" && msg.type === "auth_ok") {
      clearTimeout(a.timer);
      this.linkAuth = null;
      this.authed = true;
      this.authFailures = 0;
      // Fetch real extension status before marking ready so `connected`
      // is accurate from the start.
      this.refreshStatus().finally(() => {
        if (this.ws !== ws || !this.linkOpen) return;
        this.settleReady();
        this.startStatusPoll();
      });
      return;
    }
    this.failAuth(
      ws,
      a.stage === "challenge"
        ? `the process on :${this.port} did not prove it holds the bridge token (${tokenFile(this.dir(), this.port)})`
        : `the process on :${this.port} sent an unexpected frame instead of auth_ok`
    );
  }

  /**
   * The peer on the port is not a verified primary (or the token is missing): close the link
   * without sending it anything more, warn (throttled per hint), and retry with a growing delay.
   */
  private failAuth(
    ws: WebSocket,
    why: string,
    hint = "another program may hold the port, or the token file is stale"
  ): void {
    if (this.ws !== ws) return;
    this.authFailures++;
    logThrottledTo(
      this.logThrottle,
      this.log,
      `primary-unverified:${hint}`,
      `WARNING: satellite not linked: ${why}; it was sent no token and no command (${hint}). Retrying with backoff.`,
      60000
    );
    // Drop the link before terminate(): Bun 1.3 emits "close" synchronously from terminate(),
    // and that handler would record a bare "closed" error in place of this one.
    this.dropLink(ws, new Error(`Primary bridge on :${this.port} failed authentication: ${why}`), true);
    try { ws.terminate(); } catch {}
  }

  /** Events broadcast by the primary (A9). */
  private onEvent(msg: Record<string, unknown>): void {
    const kind = msg.kind;
    if (kind === "perms") {
      const d = parseDisabled(msg.data);
      if (d) {
        this.lastDisabled = d;
        this.enforceEventPerms();
        this.emitPerms();
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
    this.warnIgnoredPairing(s);
    if ("disabled" in s) {
      this.lastDisabled = Array.isArray(s.disabled) ? parseDisabled({ disabled: s.disabled }) : null;
      this.enforceEventPerms();
      this.emitPerms();
    }
  }

  /**
   * --pair / --allow-legacy-extension of a satellite only matter once it is
   * promoted; the primary decides. Say so once instead of failing silently.
   */
  private warnIgnoredPairing(s: Record<string, unknown>): void {
    if (this.warnedPairing) return;
    const pair = this.opts.pair ?? envFlag(this.env.BROWSER_MCP_PAIR);
    const legacy = this.opts.allowLegacyExtension ?? envFlag(this.env.BROWSER_MCP_ALLOW_LEGACY_EXTENSION);
    const ignored: string[] = [];
    if (pair && s.pairingOpen === false) ignored.push("--pair");
    if (legacy && s.legacyExtensionAllowed === false) ignored.push("--allow-legacy-extension");
    if (!ignored.length) return;
    this.warnedPairing = true;
    this.log(
      `${ignored.join(" and ")} has no effect here: the primary bridge on :${this.port} (another browser-mcp process) decides; stop the other servers or start that one with the option`
    );
  }

  /**
   * Poll __bridge_status. Consecutive timeouts mean the primary stopped
   * servicing messages: drop the link so the normal failover runs (A15).
   */
  private refreshStatus(): Promise<void> {
    if (this.statusInflight) return this.statusInflight;
    const ws = this.ws;
    const t = this.timings.statusTimeoutMs;
    const p = this.sendRaw<BridgeStatus>("__bridge_status", {}, undefined, t, t)
      .then(
        (s) => {
          this.statusFails = 0;
          this.applyStatus(s);
        },
        (e) => {
          if ((e as { code?: string })?.code !== "ETIMEDOUT" || this.ws !== ws || !ws) return;
          this.statusFails++;
          this.extensionConnected = false;
          if (this.statusFails >= this.timings.statusFailsBeforeFailover) {
            this.log(`primary on :${this.port} stopped answering (${this.statusFails} status timeouts), failing over`);
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

  private dropLink(ws: WebSocket, err: Error, quiet = false): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.authed = false;
    this.clearLinkAuth();
    this.extensionConnected = false;
    this.statusFails = 0;
    this.lastError = err;
    // failAuth already warned (throttled): a squatter on the port must not flood the log.
    if (!quiet) this.log(`satellite link down on :${this.port} (${err.message}), failing over`);
    this.stopStatusPoll();
    for (const [id, p] of this.pending) {
      takePending(this.pending, id);
      p.reject(new Error("Primary bridge disconnected"));
    }
    this.pending.clear();
    // Primary may be gone: try to take over the port (promote), else
    // fall back to client mode against whoever owns it now.
    this.scheduleFailover();
  }

  private clearLinkAuth(): void {
    if (this.linkAuth) clearTimeout(this.linkAuth.timer);
    this.linkAuth = null;
  }

  private scheduleFailover() {
    if (this.closed || this.primary || this.reconnectTimer) return;
    // Jittered delay: N satellites losing the primary at once must not all
    // bind() in the same millisecond (thundering herd). After links that did
    // not authenticate, back off further (doubling, capped).
    const backoff = this.authFailures
      ? Math.min(AUTH_BACKOFF_MAX_MS, Math.max(this.timings.failoverDelayMs, 100) * 2 ** Math.min(this.authFailures - 1, 16))
      : 0;
    const delay = this.timings.failoverDelayMs + Math.random() * this.timings.failoverJitterMs + backoff;
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
      this.log(`satellite unhealthy, exiting instead of takeover on :${this.port}`);
      try { this.close(); } catch {}
      setTimeout(() => process.exit(0), 100).unref?.();
      return;
    }
    this.log(`satellite attempting takeover on :${this.port}`);
    let candidate: ExtensionBridge;
    try {
      // The promoted primary runs with this process's own options (pair window
      // counted from this process's start, legacy switch, config dir...).
      candidate = new ExtensionBridge(this.port, { ...this.opts, exitOnAddrInUse: false, pairSince: this.startedAt });
    } catch (e) {
      this.log(`takeover bind threw, rejoining as client: ${errText(e)}`);
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
        candidate.onPermsChange(() => this.emitPerms());
        candidate.adoptState({ disabled: this.lastDisabled, consoleEvents: this.localConsole, networkEvents: this.localNetwork });
        this.primary = candidate;
        this.log(`satellite promoted to primary on :${this.port}`);
        try { this.ws?.close(); } catch {}
        this.ws = null;
        this.authed = false;
        this.clearLinkAuth();
        this.authFailures = 0;
        this.stopStatusPoll();
        this.settleReady();
        this.emitPerms();
      },
      (e) => {
        const code = (e as { code?: string })?.code;
        this.log(`takeover failed (${errText(e)}), rejoining as client`);
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
    this.statusTimer = setInterval(poll, this.timings.statusPollMs);
  }

  private stopStatusPoll() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /** This satellite's own launch settings, forwarded to the primary (A10). */
  private launchPrefs(): LaunchPrefs {
    const prefs: LaunchPrefs = { auto: this.opts.autoLaunch ?? this.env.BROWSER_AUTO_LAUNCH !== "0" };
    const name = (this.env.BROWSER ?? "").trim();
    const bp = (this.env.BROWSER_PATH ?? "").trim();
    const cp = (this.env.CHROME_PATH ?? "").trim();
    const browser =
      (bp ? browserIdFromBin(bp) : null) ??
      (name ? normalizeBrowserId(name) ?? browserIdFromBin(name) : null) ??
      (cp ? browserIdFromBin(cp) : null);
    if (browser) prefs.browser = browser;
    if (!this.warnedLaunchPrefs && (bp || cp || (name && !normalizeBrowserId(name)))) {
      this.warnedLaunchPrefs = true;
      this.log(`satellite: browser binary paths are not forwarded; the primary launches its own ${browser ?? "default"} browser binary`);
    }
    return prefs;
  }

  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs = 30000, opts?: SendOptions): Promise<T> {
    if (this.primary) return this.primary.send<T>(action, payload, tabId, timeoutMs, opts);
    const prefs = this.launchPrefs();
    // The primary may first wait for a reconnecting extension and auto-launch
    // a browser before running the command: budget for it locally (A5).
    const extra = this.extensionConnected ? 0 : this.timings.reconnectGraceMs + (prefs.auto ? envLaunchTimeoutMs(this.env) : 0);
    return this.sendRaw<T>(action, payload, tabId, timeoutMs, timeoutMs + 5000 + extra, prefs, opts?.signal);
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
    launch?: LaunchPrefs,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    const ws = this.ws;
    if (!ws || !this.linkOpen) {
      return Promise.reject(new Error(`Primary bridge not connected (port ${this.port}); reconnecting, retry shortly.`));
    }
    const id = `sat-${process.pid}-${crypto.randomUUID()}`;
    const req: BridgeRequest = { id, action, tabId, payload, timeoutMs: relayTimeoutMs };
    if (launch) req.launch = launch;
    return startRequest<T>(this.pending, {
      id,
      action,
      ws,
      frame: () => JSON.stringify(req),
      timeoutMs: localTimeoutMs,
      timeoutMessage: `Primary bridge timed out (${action}, ${localTimeoutMs}ms)`,
      signal,
      // The primary maps this id to its own command id and tells the extension.
      onAbort: () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: "cancel", id })); } catch {}
      },
    });
  }

  async launchBrowser(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.primary) return this.primary.launchBrowser(timeoutMs);
    // Use this satellite's launch timeout and browser choice, and wait locally
    // a bit longer than the primary does (A5/B9).
    const wait = clampTimeout(timeoutMs ?? envLaunchTimeoutMs(this.env));
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
    this.clearLinkAuth();
    this.stopStatusPoll();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.readyDeadline) {
      clearTimeout(this.readyDeadline);
      this.readyDeadline = null;
    }
    for (const [id, p] of this.pending) {
      takePending(this.pending, id);
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
