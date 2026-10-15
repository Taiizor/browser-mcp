import { WebSocketServer, WebSocket } from "ws";

// MCP -> Extension request, Extension -> MCP response.
// Protocol:
//   MCP sends:    { id, action, tabId?, payload? }
//   EXT sends:    { id, ok, result?, error? }  (response to command)
//   EXT sends:    { type: "event", kind, data } (unsolicited: console/network push)
//   EXT sends:    { type: "hello", role: "extension" } (identity; status probes
//                 never receive commands and never hijack the connection)
//   MCP sends:    { type: "ping" } keepalive

export interface BridgeRequest {
  id: string;
  action: string;
  tabId?: number;
  payload?: unknown;
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
  timer: Timer;
};

export interface BridgeStatus {
  connected: boolean;
  wsPort: number;
  consoleBuffered: number;
  networkBuffered: number;
  /** Which side of the sharing this process is. */
  mode: "primary" | "satellite";
  /** OS pid of the process answering (primary) or of this satellite. */
  pid: number;
  /**
   * Number of non-extension sockets on the primary (satellites + CLI
   * probes). -1 when unknown (satellite that hasn't polled yet).
   */
  peers: number;
}

export interface IBridge {
  readonly port: number;
  readonly connected: boolean;
  readonly mode: "primary" | "satellite";
  consoleEvents: Array<unknown>;
  networkEvents: Array<unknown>;
  /** Extra status fields for browser_status (mode/pid/peers). */
  status(): Pick<BridgeStatus, "mode" | "pid" | "peers">;
  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs?: number): Promise<T>;
  launchBrowser(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }>;
  closeBrowser(force?: boolean): Promise<{ closed: boolean; detail: string }>;
  close(): void;
}

export type BrowserId = "chrome" | "edge" | "brave" | "opera";

/** Friendly BROWSER= names (also accepts raw paths / exe names at launch). */
export function normalizeBrowserId(input: string): BrowserId | null {
  const v = input.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (v === "chrome" || v === "googlechrome" || v === "chromium") return "chrome";
  if (v === "edge" || v === "microsoftedge" || v === "msedge") return "edge";
  if (v === "brave" || v === "bravebrowser") return "brave";
  if (v === "opera" || v === "operastable") return "opera";
  return null;
}

export class ExtensionBridge implements IBridge {
  public readonly port: number;
  private wss: WebSocketServer;
  // Instead of a single socket: tell the extension socket apart via
  // hello/event/response. (Side connections like popup status probes
  // never receive commands.)
  private extensionSocket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
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

  //-ring buffers for pushed events (so tools work even with polling)
  consoleEvents: Array<unknown> = [];
  networkEvents: Array<unknown> = [];
  private static MAX_BUF = 1000;

  constructor(port: number, opts?: { exitOnAddrInUse?: boolean }) {
    this.port = port;
    this.exitOnAddrInUse = opts?.exitOnAddrInUse ?? true;
    this.wss = new WebSocketServer({ port, host: "127.0.0.1", maxPayload: 10 * 1024 * 1024 });
    this.wss.on("connection", (ws, req) => {
      const origin = req.headers.origin;
      if (origin && !origin.startsWith("chrome-extension://") && !origin.startsWith("moz-extension://")) {
        console.error(`[bridge:${process.pid}] rejected unauthorized connection from origin: ${origin}`);
        try { ws.close(1008, "Unauthorized origin"); } catch {}
        return;
      }
      ws.on("message", (raw) => this.onMessage(ws, raw.toString()));
      ws.on("close", () => {
        if (this.extensionSocket === ws) {
          this.extensionSocket = null;
          console.error(`[bridge:${process.pid}] extension disconnected`);
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("Extension disconnected"));
          }
          this.pending.clear();
        }
      });
      ws.on("error", (e) => console.error(`[bridge:${process.pid}] ws error: ${(e as Error)?.message ?? e}`));
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
      console.error(`[bridge:${process.pid}] ws listening on ws://127.0.0.1:${port} (primary)`);
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
    return (
      this.extensionSocket !== null &&
      this.extensionSocket.readyState === WebSocket.OPEN
    );
  }

  get mode(): "primary" | "satellite" {
    return "primary";
  }

  /** Non-extension sockets on this bridge (satellites + probes). */
  peerCount(): number {
    try {
      const total = this.wss.clients.size;
      return Math.max(0, total - (this.connected ? 1 : 0));
    } catch {
      return 0;
    }
  }

  status(): Pick<BridgeStatus, "mode" | "pid" | "peers"> {
    return { mode: "primary", pid: process.pid, peers: this.peerCount() };
  }

  private claimExtension(ws: WebSocket) {
    if (this.extensionSocket !== ws) {
      this.extensionSocket = ws;
      const peers = this.peerCount();
      console.error(`[bridge:${process.pid}] extension connected (peers=${peers})`);
    }
  }

  private onMessage(ws: WebSocket, raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Extension identity: this socket is the real extension
    if (msg.type === "hello" && (msg as { role?: string }).role === "extension") {
      this.claimExtension(ws);
      // Sticky browser: remember which browser holds the extension so the
      // next launch opens the same one (not hardcoded Chrome-first).
      const b = (msg as { browser?: unknown }).browser;
      if (b === "chrome" || b === "edge" || b === "brave" || b === "opera") this.rememberBrowser(b);
      return;
    }
    // Response to a pending command (the responding socket is the extension)
    if (typeof msg.id === "string" && this.pending.has(msg.id as string)) {
      this.claimExtension(ws);
      const p = this.pending.get(msg.id as string)!;
      this.pending.delete(msg.id as string);
      clearTimeout(p.timer);
      if ((msg as unknown as BridgeResponse).ok) {
        p.resolve((msg as unknown as BridgeResponse).result);
      } else {
        p.reject(
          new Error(
            ((msg as unknown as BridgeResponse).error as string) ||
              "extension error"
          )
        );
      }
      return;
    }
    // Unsolicited event push (the sender socket is the extension)
    if (msg.type === "event") {
      this.claimExtension(ws);
      const kind = msg.kind as string;
      const data = msg.data;
      if (kind === "console") {
        this.consoleEvents.push(data);
        if (this.consoleEvents.length > ExtensionBridge.MAX_BUF * 1.2) {
          this.consoleEvents.splice(0, this.consoleEvents.length - ExtensionBridge.MAX_BUF);
        }
      } else if (kind === "network") {
        this.networkEvents.push(data);
        if (this.networkEvents.length > ExtensionBridge.MAX_BUF * 1.2) {
          this.networkEvents.splice(0, this.networkEvents.length - ExtensionBridge.MAX_BUF);
        }
      }
      return;
    }
    // External client command relay (e.g. from report-bot CLI or scripts,
    // and from satellite mcp-server instances sharing this bridge).
    if (ws !== this.extensionSocket && typeof msg.action === "string" && typeof msg.id === "string") {
      const action = msg.action as string;
      const replyId = msg.id as string;
      const reply = (ok: boolean, result?: unknown, error?: string) => {
        try {
          ws.send(JSON.stringify({ id: replyId, ok, result, error }));
        } catch {}
      };
      // Satellite control plane: handled locally, never forwarded to the extension.
      if (action === "__bridge_status") {
        reply(true, {
          connected: this.connected,
          wsPort: this.port,
          consoleBuffered: this.consoleEvents.length,
          networkBuffered: this.networkEvents.length,
          mode: "primary",
          pid: process.pid,
          peers: this.peerCount(),
        } satisfies BridgeStatus);
        return;
      }
      if (action === "__launchBrowser") {
        const timeoutMs = (msg.payload as { timeoutMs?: number } | undefined)?.timeoutMs;
        this.launchBrowser(timeoutMs).then(
          (result) => reply(true, result),
          (err) => reply(false, undefined, (err as Error)?.message ?? String(err))
        );
        return;
      }
      if (action === "__closeBrowser") {
        const force = (msg.payload as { force?: boolean } | undefined)?.force ?? false;
        this.closeBrowser(force).then(
          (result) => reply(true, result),
          (err) => reply(false, undefined, (err as Error)?.message ?? String(err))
        );
        return;
      }
      Promise.resolve()
        .then(() => this.send(msg.action as string, msg.payload, msg.tabId as number))
        .then((result) => {
          try {
            ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
          } catch {}
        })
        .catch((err) => {
          try {
            ws.send(JSON.stringify({ id: msg.id, ok: false, error: err.message }));
          } catch {}
        });
      return;
    }
  }

  get autoLaunch(): boolean {
    return process.env.BROWSER_AUTO_LAUNCH !== "0";
  }

  get launchTimeoutMs(): number {
    const v = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS ?? 45000);
    return Number.isFinite(v) && v > 0 ? v : 45000;
  }

  /**
   * Explicit browser choice: BROWSER_PATH (full path or exe name) first,
   * then BROWSER= (friendly name like "edge", or a path), then legacy
   * CHROME_PATH. Returns null when nothing usable was configured.
   */
  private explicitBrowserBin(): string | null {
    const byPath = (v: string): string | null => {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        try {
          fs.accessSync(v);
          return v;
        } catch {}
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

  /** Start the browser (if needed) and wait for the extension to connect. */
  async launchBrowser(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.connected) return { connected: true, launched: false, detail: "Extension already connected." };
    // Singleflight: join the in-flight launch instead of spawning more browsers.
    if (this.launchInflight) return await this.launchInflight;
    this.launchInflight = this.launchBrowserInner(timeoutMs);
    try {
      return await this.launchInflight;
    } finally {
      this.launchInflight = null;
    }
  }

  private async launchBrowserInner(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.connected) return { connected: true, launched: false, detail: "Extension already connected." };
    const wait = timeoutMs ?? this.launchTimeoutMs;
    const deadline = Date.now() + wait;
    const running = await this.runningBrowsers();
    const sticky = this.lastBrowser ?? this.readStickyBrowser();
    const def = this.defaultBrowserId();

    // Ordered browser ids: explicit BROWSER= -> sticky -> running ->
    // OS default -> Chrome/Edge/Brave/Opera.
    const ids: Array<BrowserId> = [];
    const pushId = (id: BrowserId) => {
      if (!ids.includes(id)) ids.push(id);
    };
    const explicitName = (process.env.BROWSER ?? "").trim();
    const explicitId = explicitName ? normalizeBrowserId(explicitName) : null;
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
    const signaled = new Set<string>();
    if (explicitId) signaled.add(explicitId);
    if (sticky) signaled.add(sticky);
    (["chrome", "edge", "brave", "opera"] as const).forEach((id) => {
      if (running[id]) signaled.add(id);
    });
    if (def) signaled.add(def);

    // Resolve to binaries. Browsers with a positive signal (explicit, sticky,
    // running, default) are all tried in order; pure fallbacks only the first
    // one — don't open every installed browser blindly. Total time is capped
    // by the requested timeout; each attempt gets at most 20s.
    const attempts: string[] = [];
    const seen = new Set<string>();
    const pushBin = (b: string | null) => {
      if (b && !seen.has(b)) {
        seen.add(b);
        attempts.push(b);
      }
    };
    const explicit = this.explicitBrowserBin();
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
    return {
      connected: false,
      launched: spawned,
      detail: `Tried ${attempts.join(", ")} but the extension did not connect. Open the browser where Browser MCP is installed (${extPages} -> enable it), or set BROWSER=chrome|edge|brave|opera (or BROWSER_PATH) to that browser. The choice is remembered after the first connection.`,
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
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      for (const c of this.browserPaths(id)) {
        try {
          fs.accessSync(c);
          return c;
        } catch {}
      }
    } catch {}
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

  private stickyFile(): string {
    try {
      const os = require("node:os") as typeof import("node:os");
      const path = require("node:path") as typeof import("node:path");
      return path.join(os.tmpdir(), "browser-mcp-last-browser");
    } catch {
      return "";
    }
  }

  private readStickyBrowser(): BrowserId | null {
    try {
      const f = this.stickyFile();
      if (!f) return null;
      const fs = require("node:fs") as typeof import("node:fs");
      return normalizeBrowserId(fs.readFileSync(f, "utf8"));
    } catch {}
    return null;
  }

  private rememberBrowser(id: BrowserId): void {
    this.lastBrowser = id;
    try {
      const f = this.stickyFile();
      if (f) (require("node:fs") as typeof import("node:fs")).writeFileSync(f, id);
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

  private waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const onConn = () => {
        // Check after the new socket sends hello
        const check = () => {
          if (this.connected) {
            cleanup();
            resolve(true);
          }
        };
        setTimeout(check, 100);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.wss.off("connection", onConn);
      };
      this.wss.on("connection", onConn);
    });
  }

  /** Close the browser. Graceful = close all windows via the extension (needs connection). Force = kill the browser process (server-side). */
  async closeBrowser(force = false): Promise<{ closed: boolean; detail: string }> {
    if (!force) {
      if (!this.connected) {
        return { closed: false, detail: "Extension not connected; use force:true to kill the browser process." };
      }
      const r = (await this.sendInner("browser_close", {})) as { closed?: number };
      // give the worker a moment to die with its last window
      const deadline = Date.now() + 5000;
      while (this.connected && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 250));
      }
      return { closed: !this.connected, detail: `Closed ${r?.closed ?? 0} window(s).` };
    }
    try {
      if (process.platform === "win32") {
        const running = (name: string) => {
          try {
            const p = Bun.spawnSync(["tasklist", "/FI", `IMAGENAME eq ${name}`, "/NH"]);
            return p.stdout ? new RegExp(name.replace(".", "\\."), "i").test(Buffer.from(p.stdout).toString()) : false;
          } catch {
            return false;
          }
        };
        let killed: string[] = [];
        for (const name of ["chrome.exe", "msedge.exe", "brave.exe", "opera.exe"]) {
          if (!running(name)) continue;
          Bun.spawnSync(["taskkill", "/F", "/IM", name]);
          killed.push(name);
        }
        return killed.length
          ? { closed: true, detail: `Killed: ${killed.join(", ")}` }
          : { closed: false, detail: "No Chrome/Edge/Brave/Opera process found." };
      }
      for (const proc of process.platform === "darwin"
        ? ["Google Chrome", "Microsoft Edge", "Brave Browser", "Opera"]
        : ["chrome", "msedge", "brave", "opera"]) {
        try {
          Bun.spawnSync(["pkill", "-x", proc]);
        } catch {}
      }
      return { closed: true, detail: "Kill signal sent." };
    } catch (e) {
      return { closed: false, detail: `Force close failed: ${String((e as Error)?.message ?? e)}` };
    }
  }

  private notConnectedError(): Error {
    return new Error(
      `Browser extension not connected. In Chrome open chrome://extensions -> Developer Mode -> "Load unpacked" and select the extension/ folder. The WS port must be listening.`
    );
  }

  send<T = unknown>(
    action: string,
    payload?: unknown,
    tabId?: number,
    timeoutMs = 30000
  ): Promise<T> {
    if (!this.connected || !this.extensionSocket) {
      if (!this.autoLaunch) throw this.notConnectedError();
      return (async () => {
        const r = await this.launchBrowser();
        if (!r.connected || !this.extensionSocket) {
          throw new Error(`${r.detail} (auto-launch ${r.launched ? "tried" : "skipped"})`);
        }
        return this.sendInner<T>(action, payload, tabId, timeoutMs);
      })();
    }
    return this.sendInner<T>(action, payload, tabId, timeoutMs);
  }

  private sendInner<T = unknown>(
    action: string,
    payload?: unknown,
    tabId?: number,
    timeoutMs = 30000
  ): Promise<T> {
    const target = this.extensionSocket;
    if (!target) throw this.notConnectedError();
    const id = `cmd-${Date.now()}-${this.seq++}`;
    const req: BridgeRequest = { id, action, tabId, payload };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension timed out (${action}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      target.send(JSON.stringify(req), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  close(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge closed"));
    }
    this.pending.clear();
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
  private seq = 0;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readySettled = false;
  private statusTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private closed = false;
  private extensionConnected = true;
  /** Last peer count reported by the primary (-1 = unknown yet). */
  private lastPeers = -1;

  constructor(port: number) {
    this.port = port;
    this.connect();
  }

  ready(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.readySettled) {
        if (this.primary || (this.ws && this.ws.readyState === WebSocket.OPEN)) resolve();
        else reject(new Error(`Satellite bridge to :${this.port} is not connected`));
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

  status(): Pick<BridgeStatus, "mode" | "pid" | "peers"> {
    if (this.primary) return this.primary.status();
    return { mode: "satellite", pid: process.pid, peers: this.lastPeers };
  }

  /** Raw link state (ignores extension status) — used internally for polling. */
  private get linkOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private settleReady(err?: Error) {
    if (this.readySettled) return;
    this.readySettled = true;
    if (err) this.readyReject?.(err);
    else this.readyResolve?.();
  }

  private connect() {
    if (this.closed || this.primary) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`, { maxPayload: 10 * 1024 * 1024 });
    } catch (e) {
      this.settleReady(e as Error);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      console.error(`[bridge:${process.pid}] satellite connected to primary on :${this.port}`);
      // Fetch real extension status before marking ready so `connected`
      // is accurate from the start instead of optimistically true.
      this.send<BridgeStatus>("__bridge_status", {}, undefined, 8000).then(
        (s) => {
          this.extensionConnected = !!s?.connected;
          if (typeof s?.peers === "number") this.lastPeers = s.peers;
        },
        () => { /* keep default; link errors surface via close */ }
      ).finally(() => {
        this.settleReady();
        this.startStatusPoll();
      });
    });
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg.id !== "string" || !this.pending.has(msg.id)) return;
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ((msg as unknown as BridgeResponse).ok) {
        p.resolve((msg as unknown as BridgeResponse).result);
      } else {
        p.reject(new Error(((msg as unknown as BridgeResponse).error as string) || "primary bridge error"));
      }
    });
    const onDown = (e?: unknown) => {
      if (this.ws === ws) this.ws = null;
      else return;
      console.error(`[bridge:${process.pid}] satellite link down on :${this.port}, failing over`);
      if (!this.readySettled) {
        this.settleReady((e as Error) ?? new Error(`Cannot reach primary bridge on :${this.port}`));
      }
      this.stopStatusPoll();
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Primary bridge disconnected"));
      }
      this.pending.clear();
      // Primary may be gone: try to take over the port (promote), else
      // fall back to client mode against whoever owns it now.
      this.scheduleFailover();
    };
    ws.on("close", () => onDown(new Error(`Primary bridge on :${this.port} closed`)));
    ws.on("error", (e) => {
      const msg = (e as Error)?.message ?? String(e);
      console.error(`[bridge:${process.pid}] satellite ws error: ${msg}`);
      if (!this.readySettled) {
        try { ws.close(); } catch {}
        onDown(e);
      }
    });
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
      candidate = new ExtensionBridge(this.port, { exitOnAddrInUse: false });
    } catch (e) {
      console.error(`[bridge:${process.pid}] takeover bind threw, rejoining as client`, e);
      if (!this.closed) this.connect();
      return;
    }
    candidate.ready().then(
      () => {
        if (this.closed) {
          candidate.close();
          return;
        }
        this.primary = candidate;
        console.error(`[bridge:${process.pid}] satellite promoted to primary on :${this.port}`);
        try { this.ws?.close(); } catch {}
        this.ws = null;
        this.stopStatusPoll();
      },
      (e) => {
        console.error(`[bridge:${process.pid}] takeover failed (${(e as Error)?.message}), rejoining as client`);
        try { candidate.close(); } catch {}
        if (this.closed) return;
        this.connect();
      }
    );
  }

  private scheduleReconnect() {
    this.scheduleFailover();
  }

  private startStatusPoll() {
    this.stopStatusPoll();
    const poll = () => {
      if (this.closed || !this.linkOpen) return;
      this.send<BridgeStatus>("__bridge_status", {}, undefined, 8000).then(
        (s) => {
          this.extensionConnected = !!s?.connected;
          if (typeof s?.peers === "number") this.lastPeers = s.peers;
        },
        () => { /* keep last known value; link errors surface via close */ }
      );
    };
    poll();
    this.statusTimer = setInterval(poll, 3000);
  }

  private stopStatusPoll() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs = 30000): Promise<T> {
    if (this.primary) return this.primary.send<T>(action, payload, tabId, timeoutMs);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Primary bridge not connected (port ${this.port}). Start one agent first.`));
    }
    const id = `sat-${process.pid}-${Date.now()}-${this.seq++}`;
    const req: BridgeRequest = { id, action, tabId, payload };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Primary bridge timed out (${action}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify(req), (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  async launchBrowser(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.primary) return this.primary.launchBrowser(timeoutMs);
    return this.send("__launchBrowser", { timeoutMs });
  }

  async closeBrowser(force = false): Promise<{ closed: boolean; detail: string }> {
    if (this.primary) return this.primary.closeBrowser(force);
    return this.send("__closeBrowser", { force });
  }

  close(): void {
    this.closed = true;
    this.stopStatusPoll();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Bridge closed"));
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    if (this.primary) {
      try {
        this.primary.close();
      } catch {}
      this.primary = null;
    }
  }
}
