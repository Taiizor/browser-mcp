// Loads the real extension/background.js into the test process.
//
// The service-worker script is evaluated with new Function, with its globals
// passed in as parameters: the mocked chrome API, a WebSocket class that sends
// the extension Origin (and records every frame), a WarpClock's timers and
// Date, a console that collects the worker's log lines, and an IndexedDB over
// the ChromeStore (the pairing record). Each call gives a
// fresh, independent worker (its top-level state lives in the function's
// scope), so two loads over the same ChromeStore model a service-worker
// restart. A getter object appended to the source exposes the top-level
// bindings the tests inspect; a renamed binding fails only the tests that read
// it.

import fs from "node:fs";
import path from "node:path";
import type { ChromeMock } from "./ext-chrome.js";
import { WarpClock } from "./ext-clock.js";
import { FakeIndexedDB } from "./ext-idb.js";

export const BACKGROUND_JS = path.resolve(import.meta.dir, "../../../extension/background.js");

/** Top-level bindings of background.js exposed through BackgroundHandle.state. */
const EXPOSED = [
  "pairState",
  "paired",
  "lastClose",
  "serverInfo",
  "pairing",
  "acceptPairUntil",
  "currentPort",
  "commandHistory",
  "runningCmds",
  "disabledActions",
  "agentTabs",
  "fallbackTabs",
  "fetchSessions",
  "emulationSessions",
  "viewportSessions",
  "mediaSessions",
  "cpuSessions",
  "throttleSessions",
  "traceSessions",
  "traceStore",
  "consoleLogs",
] as const;

export type BackgroundState = { readonly [K in (typeof EXPOSED)[number]]: any } & {
  reconnectNow(): void;
};

export interface WsFrame {
  dir: "in" | "out";
  data: any;
}

export interface BackgroundHandle {
  readonly state: BackgroundState;
  readonly clock: WarpClock;
  /** Frames on every extension socket: "in" = from the server, "out" = sent by background.js. */
  readonly frames: WsFrame[];
  /** console.* lines written by background.js. */
  readonly log: string[];
  /** Simulates the worker dying: sockets dropped without close handlers, timers cancelled. */
  dispose(): void;
}

let cachedSource: string | null = null;

function source(): string {
  if (cachedSource === null) {
    const getters = EXPOSED.map((n) => `get ${n}() { return ${n}; }`).join(",\n  ");
    cachedSource =
      fs.readFileSync(BACKGROUND_JS, "utf8") +
      `\n;return {\n  ${getters},\n  reconnectNow: () => reconnectNow(),\n};\n`;
  }
  return cachedSource;
}

export function loadBackground(chrome: ChromeMock, opts: { clock?: WarpClock } = {}): BackgroundHandle {
  const clock = opts.clock ?? new WarpClock();
  const frames: WsFrame[] = [];
  const log: string[] = [];
  const sockets = new Set<WebSocket>();
  const origin = `chrome-extension://${chrome.extensionId}`;
  const BaseWebSocket = globalThis.WebSocket;
  const parse = (d: unknown) => {
    try {
      return JSON.parse(String(d));
    } catch {
      return d;
    }
  };

  class ExtensionWebSocket extends BaseWebSocket {
    constructor(url: string | URL) {
      // Bun's WebSocket takes request headers; Chrome sends the extension Origin itself.
      super(url, { headers: { Origin: origin } } as unknown as string[]);
      sockets.add(this);
      this.addEventListener("message", (e) => frames.push({ dir: "in", data: parse(e.data) }));
      this.addEventListener("close", () => sockets.delete(this));
    }

    override send(data: Parameters<WebSocket["send"]>[0]): void {
      frames.push({ dir: "out", data: parse(data) });
      super.send(data);
    }
  }

  const quietConsole = Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map((level) => [level, (...args: unknown[]) => log.push(`[${level}] ${args.map(String).join(" ")}`)])
  );

  const run = new Function(
    "chrome",
    "WebSocket",
    "self",
    "console",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "Date",
    "indexedDB",
    source()
  );
  const state = run(
    chrome.api,
    ExtensionWebSocket,
    {},
    quietConsole,
    clock.setTimeout,
    clock.clearTimeout,
    clock.setInterval,
    clock.clearInterval,
    clock.Date,
    new FakeIndexedDB(chrome.store.idb, { fail: () => chrome.store.idbBroken === true })
  ) as BackgroundState;

  return {
    state,
    clock,
    frames,
    log,
    dispose() {
      clock.dispose();
      chrome.dispose();
      for (const s of sockets) {
        s.onopen = null;
        s.onmessage = null;
        s.onclose = null;
        s.onerror = null;
        try {
          s.close();
        } catch {}
      }
      sockets.clear();
    },
  };
}
