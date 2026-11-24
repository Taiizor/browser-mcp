// Integration harness: the REAL extension/background.js (mocked chrome.*,
// warpable timers) connected over a real WebSocket to the REAL ExtensionBridge
// (port 0, temp config dir, no browser launch), optionally with
// extension/content.js in a happy-dom page as tab 1 and an MCP client on top
// of createServer. Every test builds its own harness and closes it; nothing is
// shared between tests and nothing outside the temp dir is written.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BridgeClient, ExtensionBridge } from "../../src/bridge.js";
import { loadBackground, type BackgroundHandle } from "./ext-background.js";
import { ChromeMock, newStore, type ChromeStore, type MockTab } from "./ext-chrome.js";
import { WarpClock } from "./ext-clock.js";
import { connectMcp, type McpHandle } from "./ext-mcp.js";
import { ContentPage } from "./ext-page.js";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
export const EXT_VERSION: string = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dir, "../../../extension/manifest.json"), "utf8")
).version;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls cond every 10 ms; throws "timed out waiting for <what>" after timeoutMs. */
export async function waitFor(cond: () => unknown, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * Awaits a promise that must reject and returns its error.
 *
 * Use this instead of `await expect(promise).rejects`: for a pending promise
 * bun:test drains the event loop from inside the matcher, and with frames in
 * flight that was seen to break the extension socket (the server closed it
 * with 1002 "Invalid WebSocket frame: invalid opcode 1" although every frame on
 * the wire was valid; Bun 1.4.5). A plain await does not do that.
 */
export async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("expected the promise to reject, but it resolved");
}

export interface ServerOptions {
  pair?: boolean;
  allowLegacyExtension?: boolean;
}

export interface HarnessOptions extends ServerOptions {
  /** chrome.storage contents before background.js starts (mcpPort is added). */
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
  /** Body HTML of tab 1; content.js runs there. Omitted: tab 1 has no content script. */
  html?: string;
  /** Wait for the v3 handshake (default true). */
  paired?: boolean;
  /** Start without a server: background.js dials a closed port. */
  noServer?: boolean;
}

const DEFAULT_TABS: MockTab[] = [{ id: 1, windowId: 1, url: "https://example.com/", title: "Example", status: "complete", active: true }];

export class ExtHarness {
  readonly root: string;
  readonly configDir: string;
  readonly store: ChromeStore;
  readonly serverLog: string[] = [];
  bridge: ExtensionBridge | null = null;
  chrome!: ChromeMock;
  bg!: BackgroundHandle;
  page: ContentPage | null = null;
  private readonly html: string | undefined;
  private readonly bridges: ExtensionBridge[] = [];
  private readonly closers: Array<() => unknown> = [];

  private constructor(opts: HarnessOptions) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "bmcp-it-"));
    this.configDir = path.join(this.root, "config");
    fs.mkdirSync(this.configDir);
    this.store = newStore(opts.local, opts.session);
    this.html = opts.html;
  }

  static async create(opts: HarnessOptions = {}): Promise<ExtHarness> {
    const h = new ExtHarness(opts);
    try {
      if (opts.noServer) {
        h.store.local.mcpPort = await closedPort();
      } else {
        const b = await h.startServer(opts);
        h.store.local.mcpPort = b.port;
      }
      h.startWorker();
      if (!opts.noServer && opts.paired !== false) await h.waitPaired();
    } catch (e) {
      await h.close();
      throw e;
    }
    return h;
  }

  /** A new ExtensionBridge on port 0 over this harness's config dir; becomes h.bridge. */
  async startServer(opts: ServerOptions = {}): Promise<ExtensionBridge> {
    const b = new ExtensionBridge(0, {
      configDir: this.configDir,
      env: {},
      autoLaunch: false,
      exitOnAddrInUse: false,
      pair: opts.pair,
      allowLegacyExtension: opts.allowLegacyExtension,
      timings: { reconnectGraceMs: 0 },
      log: (l) => this.serverLog.push(l),
    });
    this.bridges.push(b);
    await b.ready();
    this.bridge = b;
    return b;
  }

  /** Starts background.js (a fresh service worker) over this harness's chrome.storage. */
  startWorker(opts: { clock?: WarpClock } = {}): BackgroundHandle {
    this.chrome = new ChromeMock({ extensionId: EXT_ID, version: EXT_VERSION, store: this.store, tabs: DEFAULT_TABS });
    if (this.html !== undefined) {
      if (!this.page) {
        this.page = new ContentPage({
          html: this.html,
          extensionId: EXT_ID,
          tabId: 1,
          toBackground: (msg, sender) => this.chrome.events.runtimeMessage.emit(msg, sender, () => {}),
        });
      }
      this.chrome.pages.set(1, this.page);
    }
    this.bg = loadBackground(this.chrome, opts);
    return this.bg;
  }

  /** Kills the current worker (no close handlers run) and starts a new one over the same storage. */
  restartWorker(opts: { clock?: WarpClock } = {}): BackgroundHandle {
    this.bg.dispose();
    return this.startWorker(opts);
  }

  /** Resolves once background.js and the current server completed the v3 handshake. */
  async waitPaired(timeoutMs = 5000): Promise<void> {
    await waitFor(() => this.bg.state.paired === true && this.bridge?.connected === true, "the v3 handshake", timeoutMs);
  }

  get server(): ExtensionBridge {
    if (!this.bridge) throw new Error("no server");
    return this.bridge;
  }

  /** A popup (extension page) runtime message. */
  popup<T = any>(msg: Record<string, unknown>): Promise<T> {
    return this.chrome.popup<T>(msg);
  }

  keysFile(): string {
    return path.join(this.configDir, "extension-keys.json");
  }

  /** The extension's pairing record (IndexedDB "browser-mcp" / "pairing" / "current"), as stored. */
  pairingRecord(): Record<string, string> | undefined {
    return this.store.idb["browser-mcp"]?.stores.pairing?.get("current") as Record<string, string> | undefined;
  }

  readKeys(): { version: number; installs: Array<Record<string, string>> } {
    return JSON.parse(fs.readFileSync(this.keysFile(), "utf8"));
  }

  /** Frames the server sent to the extension (commands, cancel, handshake). */
  inbound(filter?: (f: any) => boolean): any[] {
    return this.bg.frames.filter((f) => f.dir === "in" && (!filter || filter(f.data))).map((f) => f.data);
  }

  /** Frames background.js sent to the server. */
  outbound(filter?: (f: any) => boolean): any[] {
    return this.bg.frames.filter((f) => f.dir === "out" && (!filter || filter(f.data))).map((f) => f.data);
  }

  /** An MCP client on createServer(bridge) (default: this harness's server). */
  async mcp(opts: { toolsets?: string[]; maxOutputChars?: number; bridge?: ExtensionBridge | BridgeClient } = {}): Promise<McpHandle> {
    const saveDir = path.join(this.root, "saved");
    fs.mkdirSync(saveDir, { recursive: true });
    const m = await connectMcp(opts.bridge ?? this.server, { toolsets: opts.toolsets, maxOutputChars: opts.maxOutputChars, saveDir });
    this.closers.unshift(() => m.close());
    return m;
  }

  /** A satellite BridgeClient joined to the current server. */
  async satellite(): Promise<BridgeClient> {
    const sat = new BridgeClient(this.server.port, {
      configDir: this.configDir,
      env: {},
      autoLaunch: false,
      log: (l) => this.serverLog.push(`[satellite] ${l}`),
    });
    this.closers.unshift(() => sat.close());
    await sat.ready();
    return sat;
  }

  /** A path inside this harness's temp dir (removed by close()). */
  tempPath(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  async close(): Promise<void> {
    for (const c of this.closers.splice(0)) {
      try {
        await c();
      } catch {}
    }
    try {
      this.bg?.dispose();
    } catch {}
    for (const b of this.bridges.splice(0)) {
      try {
        b.close();
      } catch {}
    }
    try {
      await this.page?.close();
    } catch {}
    fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** A loopback port nobody listens on (bound once, then released). */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}
