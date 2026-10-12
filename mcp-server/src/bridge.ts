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

export class ExtensionBridge {
  public readonly port: number;
  private wss: WebSocketServer;
  // Instead of a single socket: tell the extension socket apart via
  // hello/event/response. (Side connections like popup status probes
  // never receive commands.)
  private extensionSocket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  //-ring buffers for pushed events (so tools work even with polling)
  consoleEvents: Array<unknown> = [];
  networkEvents: Array<unknown> = [];
  private static MAX_BUF = 1000;

  constructor(port: number) {
    this.port = port;
    this.wss = new WebSocketServer({ port, host: "127.0.0.1", maxPayload: 10 * 1024 * 1024 });
    this.wss.on("connection", (ws, req) => {
      const origin = req.headers.origin;
      if (origin && !origin.startsWith("chrome-extension://") && !origin.startsWith("moz-extension://")) {
        console.error(`[bridge] rejected unauthorized connection from origin: ${origin}`);
        try { ws.close(1008, "Unauthorized origin"); } catch {}
        return;
      }
      ws.on("message", (raw) => this.onMessage(ws, raw.toString()));
      ws.on("close", () => {
        if (this.extensionSocket === ws) {
          this.extensionSocket = null;
          console.error(`[bridge] extension disconnected`);
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("Extension disconnected"));
          }
          this.pending.clear();
        }
      });
      ws.on("error", (e) => console.error(`[bridge] ws error`, e));
    });
    this.wss.on("error", (e) => {
      console.error(`[bridge] wss error`, e);
      // A server that cannot bind its port is useless (and would linger as a
      // zombie holding no browser connection). Exit so the MCP client restarts us.
      const code = (e as { code?: string })?.code;
      if (code === "EADDRINUSE") process.exit(1);
    });
    this.wss.on("listening", () =>
      console.error(`[bridge] ws listening on ws://127.0.0.1:${port}`)
    );
  }

  get connected(): boolean {
    return (
      this.extensionSocket !== null &&
      this.extensionSocket.readyState === WebSocket.OPEN
    );
  }

  private claimExtension(ws: WebSocket) {
    if (this.extensionSocket !== ws) {
      this.extensionSocket = ws;
      console.error(`[bridge] extension connected`);
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
    // External client command relay (e.g. from report-bot CLI or scripts)
    if (ws !== this.extensionSocket && typeof msg.action === "string" && typeof msg.id === "string") {
      this.send(msg.action as string, msg.payload, msg.tabId as number)
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

  private findChrome(): string | null {
    const candidates = [
      process.env.CHROME_PATH,
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      process.env["ProgramFiles"] ? `${process.env["ProgramFiles"]}/Google/Chrome/Application/chrome.exe` : null,
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ].filter(Boolean) as string[];
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      for (const c of candidates) {
        try {
          fs.accessSync(c);
          return c;
        } catch {}
      }
    } catch {}
    for (const bin of ["chrome", "chrome.exe", "msedge", "msedge.exe"]) {
      try {
        const found = Bun.which(bin);
        if (found) return found;
      } catch {}
    }
    return null;
  }

  private async isChromeRunning(): Promise<boolean> {
    try {
      if (process.platform !== "win32") {
        const p = Bun.spawnSync(["pgrep", "-x", "chrome"]);
        if (p.exitCode === 0) return true;
        const e = Bun.spawnSync(["pgrep", "-x", "msedge"]);
        return e.exitCode === 0;
      }
      const p = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq chrome.exe", "/NH"]);
      const out = p.stdout ? Buffer.from(p.stdout).toString() : "";
      if (/chrome\.exe/i.test(out)) return true;
      const e = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq msedge.exe", "/NH"]);
      const out2 = e.stdout ? Buffer.from(e.stdout).toString() : "";
      return /msedge\.exe/i.test(out2);
    } catch {
      return false;
    }
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

  /** Start the browser (if needed) and wait for the extension to connect. */
  async launchBrowser(timeoutMs?: number): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    if (this.connected) return { connected: true, launched: false, detail: "Extension already connected." };
    const wait = timeoutMs ?? this.launchTimeoutMs;
    if (await this.isChromeRunning()) {
      // Browser process exists but the extension is silent (background-only
      // process, sleeping worker...): open a window to wake it, then wait.
      const bin = this.findChrome();
      if (bin) {
        try {
          const proc = Bun.spawn([bin, "--new-window", "about:blank"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          proc.unref();
        } catch {}
      }
      const ok = await this.waitForConnection(wait);
      if (ok) return { connected: true, launched: true, detail: "Woke the running browser, extension connected." };
      return {
        connected: false,
        launched: true,
        detail: "Chrome is running but the extension did not connect. Check chrome://extensions that Browser MCP is enabled.",
      };
    }
    const bin = this.findChrome();
    if (!bin) {
      return { connected: false, launched: false, detail: "No Chrome/Edge binary found. Set CHROME_PATH or open Chrome manually." };
    }
    try {
      const proc = Bun.spawn([bin, "--new-window", "about:blank"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref();
    } catch (e) {
      return { connected: false, launched: false, detail: `Failed to start browser: ${String((e as Error)?.message ?? e)}` };
    }
    const ok = await this.waitForConnection(wait);
    return ok
      ? { connected: true, launched: true, detail: "Browser started, extension connected." }
      : { connected: false, launched: true, detail: "Browser started but the extension did not connect in time. Check chrome://extensions that Browser MCP is enabled." };
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
        for (const name of ["chrome.exe", "msedge.exe"]) {
          if (!running(name)) continue;
          Bun.spawnSync(["taskkill", "/F", "/IM", name]);
          killed.push(name);
        }
        return killed.length
          ? { closed: true, detail: `Killed: ${killed.join(", ")}` }
          : { closed: false, detail: "No Chrome/Edge process found." };
      }
      for (const proc of ["chrome", "msedge"]) {
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
    try {
      this.wss.close();
    } catch {}
  }
}
