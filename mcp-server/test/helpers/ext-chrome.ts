// Mocked chrome.* API for running the real extension/background.js in Bun.
//
// Only the APIs the integration tests exercise are modelled (storage with
// onChanged, tabs with content-script messaging, debugger, scripting,
// webNavigation, webRequest, contentSettings, history, runtime). Any other
// chrome.* member resolves to an inert stub (calls resolve undefined, events
// accept listeners), so loading background.js never fails on an API a test
// does not care about.

import type { IdbData } from "./ext-idb.js";

export type Listener = (...args: any[]) => any;

/** chrome.events.Event lookalike with a test-side emit(). */
export class ChromeEvent {
  readonly listeners: Listener[] = [];
  addListener = (fn: Listener): void => {
    this.listeners.push(fn);
  };
  removeListener = (fn: Listener): void => {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  };
  hasListener = (fn: Listener): boolean => this.listeners.includes(fn);
  hasListeners = (): boolean => this.listeners.length > 0;
  /** Calls every listener with args; returns their return values. */
  emit(...args: unknown[]): unknown[] {
    return this.listeners.slice().map((fn) => fn(...args));
  }
}

/**
 * Backing data of chrome.storage and of the extension origin's IndexedDB
 * (see ext-idb.ts), shareable between two mock instances (worker restart).
 */
export interface ChromeStore {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  idb: IdbData;
  /** While true, indexedDB.open() fails (a broken profile). */
  idbBroken?: boolean;
}

export function newStore(local: Record<string, unknown> = {}, session: Record<string, unknown> = {}): ChromeStore {
  return { local: structuredClone(local), session: structuredClone(session), idb: {} };
}

class StorageArea {
  constructor(
    private readonly areaName: "local" | "session",
    private readonly store: ChromeStore,
    private readonly changed: ChromeEvent,
    private readonly live: () => boolean
  ) {}

  private get data(): Record<string, unknown> {
    return this.store[this.areaName];
  }

  get = async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
    const data = this.data;
    if (keys == null) return structuredClone(data);
    const out: Record<string, unknown> = {};
    if (typeof keys === "string" || Array.isArray(keys)) {
      for (const k of ([] as string[]).concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }
    for (const [k, def] of Object.entries(keys)) out[k] = k in data ? structuredClone(data[k]) : def;
    return out;
  };

  set = async (items: Record<string, unknown>): Promise<void> => {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(items ?? {})) {
      const next = structuredClone(v);
      const prev = this.data[k];
      if (JSON.stringify(prev) !== JSON.stringify(next)) changes[k] = { oldValue: prev, newValue: structuredClone(next) };
      this.data[k] = next;
    }
    this.notify(changes);
  };

  remove = async (keys: string | string[]): Promise<void> => {
    const changes: Record<string, { oldValue?: unknown }> = {};
    for (const k of ([] as string[]).concat(keys)) {
      if (k in this.data) {
        changes[k] = { oldValue: this.data[k] };
        delete this.data[k];
      }
    }
    this.notify(changes);
  };

  clear = async (): Promise<void> => {
    await this.remove(Object.keys(this.data));
  };

  setAccessLevel = async (): Promise<void> => {};

  private notify(changes: Record<string, unknown>): void {
    if (!Object.keys(changes).length) return;
    // Chrome reports changes asynchronously, after the write resolved.
    setTimeout(() => {
      if (this.live()) this.changed.emit(changes, this.areaName);
    }, 0);
  }
}

export interface MockTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  status: string;
  active: boolean;
  index?: number;
}

export interface ContentTarget {
  /** Delivers one chrome.tabs.sendMessage message to the page's content script. */
  deliver(msg: unknown, frameId: number): Promise<unknown>;
}

export interface CdpCall {
  tabId: number | undefined;
  method: string;
  params: Record<string, unknown>;
}

export interface DebuggerOp {
  op: "attach" | "detach";
  tabId: number | undefined;
}

export interface ScriptCall {
  tabId: number | undefined;
  frameIds?: number[];
  world?: string;
  func?: string;
  args?: unknown[];
  files?: string[];
}

export interface ContentCall {
  tabId: number;
  frameId: number;
  cmd: string;
  cmdId?: string;
  payload: any;
  response?: any;
}

/** Return a value (or a promise), or throw, to answer a CDP command; undefined = default reply. */
export type CdpHandler = (call: CdpCall) => unknown;
export type ScriptHandler = (details: any) => unknown;

export interface ChromeMockOptions {
  extensionId: string;
  version: string;
  store: ChromeStore;
  tabs?: MockTab[];
}

const CONTENT_SETTING_TYPES = ["location", "notifications", "camera", "microphone", "popups", "javascript", "images", "cookies"];

/** Default CDP replies: enough for emulation, tracing, DOM.setFileInputFiles and the AX tree. */
function defaultCdpReply(method: string): unknown {
  switch (method) {
    case "Runtime.evaluate":
      return { result: { type: "number", value: 0 } };
    case "DOM.getDocument":
      return { root: { nodeId: 1 } };
    case "DOM.querySelector":
      return { nodeId: 5 };
    case "DOM.describeNode":
      return { node: { nodeName: "INPUT", attributes: ["type", "file"], backendNodeId: 9 } };
    case "DOM.resolveNode":
      return { object: { objectId: "o1" } };
    case "Runtime.callFunctionOn":
      return { result: { value: 1 } };
    case "Accessibility.getFullAXTree":
      return { nodes: [] };
    case "Performance.getMetrics":
      return { metrics: [] };
    default:
      return {};
  }
}

export class ChromeMock {
  readonly extensionId: string;
  readonly store: ChromeStore;
  readonly tabs = new Map<number, MockTab>();
  /** Content scripts by tab id (frame 0 only). */
  readonly pages = new Map<number, ContentTarget>();

  readonly cdp: CdpCall[] = [];
  readonly debuggerOps: DebuggerOp[] = [];
  readonly scripts: ScriptCall[] = [];
  readonly content: ContentCall[] = [];
  readonly contentSettings: Array<{ type: string; primaryPattern: string; setting: string }> = [];
  /** Messages background.js sent with chrome.runtime.sendMessage (offscreen document). */
  readonly runtimeMessages: unknown[] = [];

  cdpHandler: CdpHandler | null = null;
  scriptHandler: ScriptHandler | null = null;
  /** Answers chrome.runtime.sendMessage from background.js (the offscreen document); undefined = no answer. */
  runtimeHandler: ((msg: any) => unknown) | null = null;
  historyItems: Array<Record<string, unknown>> = [];

  readonly events = {
    runtimeMessage: new ChromeEvent(),
    storageChanged: new ChromeEvent(),
    debuggerEvent: new ChromeEvent(),
    debuggerDetach: new ChromeEvent(),
    navCommitted: new ChromeEvent(),
    navCompleted: new ChromeEvent(),
    navError: new ChromeEvent(),
    tabRemoved: new ChromeEvent(),
    tabUpdated: new ChromeEvent(),
    beforeRequest: new ChromeEvent(),
    requestCompleted: new ChromeEvent(),
    requestError: new ChromeEvent(),
  };

  /** The object handed to background.js as `chrome`. */
  readonly api: any;
  private alive = true;

  constructor(opts: ChromeMockOptions) {
    this.extensionId = opts.extensionId;
    this.store = opts.store;
    for (const t of opts.tabs ?? [{ id: 1, windowId: 1, url: "https://example.com/", title: "Example", status: "complete", active: true }]) {
      this.tabs.set(t.id, { ...t });
    }
    const ev = (e?: ChromeEvent) => e ?? new ChromeEvent();
    const live = () => this.alive;
    const ext = `chrome-extension://${opts.extensionId}/`;

    const api: Record<string, unknown> = {
      runtime: {
        id: opts.extensionId,
        lastError: undefined as undefined | { message: string },
        getManifest: () => ({ manifest_version: 3, version: opts.version }),
        getURL: (p: string) => ext + String(p ?? "").replace(/^\//, ""),
        onMessage: this.events.runtimeMessage,
        onInstalled: ev(),
        onStartup: ev(),
        sendMessage: async (msg: unknown) => {
          this.runtimeMessages.push(msg);
          return this.runtimeHandler ? structuredClone(await this.runtimeHandler(msg)) : undefined;
        },
      },
      storage: {
        local: new StorageArea("local", opts.store, this.events.storageChanged, live),
        session: new StorageArea("session", opts.store, this.events.storageChanged, live),
        onChanged: this.events.storageChanged,
      },
      tabs: {
        query: async (q: Record<string, unknown> = {}) =>
          [...this.tabs.values()].filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)).map((t) => ({ ...t })),
        get: async (id: number) => {
          const t = this.tabs.get(id);
          if (!t) throw new Error(`No tab with id: ${id}.`);
          return { ...t };
        },
        sendMessage: (tabId: number, msg: any, options?: { frameId?: number }) => this.sendToContent(tabId, msg, options?.frameId ?? 0),
        // A new tab (next free id) in window 1 unless windowId is given; an active one deactivates its window's other tabs.
        create: async (props: { url?: string; active?: boolean; windowId?: number } = {}) => {
          const id = Math.max(0, ...this.tabs.keys()) + 1;
          const t: MockTab = { id, windowId: props.windowId ?? 1, url: props.url ?? "about:blank", title: "", status: "complete", active: props.active !== false };
          if (t.active) for (const o of this.tabs.values()) if (o.windowId === t.windowId) o.active = false;
          this.tabs.set(id, t);
          return { ...t };
        },
        reload: async (tabId: number) => {
          // A reload "finishes" shortly after: perf_web_vitals {reload} waits for it.
          setTimeout(() => {
            if (live()) this.events.navCompleted.emit({ tabId, frameId: 0, url: this.tabs.get(tabId)?.url ?? "" });
          }, 30);
        },
        onRemoved: this.events.tabRemoved,
        onUpdated: this.events.tabUpdated,
        onCreated: ev(),
        onActivated: ev(),
        onReplaced: ev(),
      },
      alarms: { create: () => {}, clear: async () => true, onAlarm: ev() },
      debugger: {
        attach: async (target: { tabId?: number }) => {
          this.debuggerOps.push({ op: "attach", tabId: target?.tabId });
        },
        detach: async (target: { tabId?: number }) => {
          this.debuggerOps.push({ op: "detach", tabId: target?.tabId });
        },
        sendCommand: (target: { tabId?: number }, method: string, params: Record<string, unknown> | undefined, cb: (r: unknown) => void) => {
          const call: CdpCall = { tabId: target?.tabId, method, params: params ?? {} };
          this.cdp.push(call);
          let reply: Promise<unknown>;
          try {
            const custom = this.cdpHandler ? this.cdpHandler(call) : undefined;
            reply = Promise.resolve(custom === undefined ? defaultCdpReply(method) : custom);
          } catch (e) {
            reply = Promise.reject(e);
          }
          const runtime = api.runtime as { lastError?: { message: string } };
          reply.then(
            (r) => setTimeout(() => cb(r), 0),
            (e) =>
              setTimeout(() => {
                runtime.lastError = { message: String((e as Error)?.message ?? e) };
                try {
                  cb(undefined);
                } finally {
                  runtime.lastError = undefined;
                }
              }, 0)
          );
        },
        getTargets: async () => [...this.tabs.values()].map((t) => ({ tabId: t.id, type: "page", id: `FRAME${t.id}`, attached: true, url: t.url })),
        onEvent: this.events.debuggerEvent,
        onDetach: this.events.debuggerDetach,
      },
      scripting: {
        executeScript: async (details: any) => {
          const call: ScriptCall = {
            tabId: details?.target?.tabId,
            frameIds: details?.target?.frameIds,
            world: details?.world,
            func: details?.func?.name,
            args: details?.args,
            files: details?.files,
          };
          this.scripts.push(call);
          const custom = this.scriptHandler ? await this.scriptHandler(details) : undefined;
          if (custom !== undefined) return custom;
          return [{ frameId: 0, result: undefined }];
        },
      },
      webNavigation: {
        getAllFrames: async ({ tabId }: { tabId: number }) => [{ frameId: 0, parentFrameId: -1, url: this.tabs.get(tabId)?.url ?? "" }],
        getFrame: async ({ tabId, frameId }: { tabId: number; frameId: number }) =>
          frameId === 0 ? { frameId: 0, parentFrameId: -1, url: this.tabs.get(tabId)?.url ?? "" } : null,
        onCommitted: this.events.navCommitted,
        onCompleted: this.events.navCompleted,
        onErrorOccurred: this.events.navError,
        onHistoryStateUpdated: ev(),
        onBeforeNavigate: ev(),
        onDOMContentLoaded: ev(),
      },
      webRequest: {
        onBeforeRequest: this.events.beforeRequest,
        onCompleted: this.events.requestCompleted,
        onErrorOccurred: this.events.requestError,
        onSendHeaders: ev(),
        onHeadersReceived: ev(),
        onBeforeRedirect: ev(),
        onResponseStarted: ev(),
      },
      contentSettings: Object.fromEntries(
        CONTENT_SETTING_TYPES.map((type) => [
          type,
          {
            set: async (d: { primaryPattern: string; setting: string }) => {
              this.contentSettings.push({ type, primaryPattern: d.primaryPattern, setting: d.setting });
            },
            get: async () => ({ setting: "ask" }),
            clear: async () => {},
          },
        ])
      ),
      history: {
        search: async (q: { maxResults?: number }) => this.historyItems.slice(0, q?.maxResults ?? 100),
        deleteUrl: async () => {},
        deleteAll: async () => {},
        deleteRange: async () => {},
      },
    };
    this.api = deepStub(api);
  }

  /** Stops event delivery (the background instance using this mock is gone). */
  dispose(): void {
    this.alive = false;
  }

  /** Sends a runtime message as an extension page (the popup) and resolves its response. */
  popup<T = any>(msg: Record<string, unknown>): Promise<T> {
    const sender = { id: this.extensionId, url: `chrome-extension://${this.extensionId}/popup.html` };
    return new Promise<T>((resolve) => {
      let answered = false;
      const respond = (r: unknown) => {
        if (answered) return;
        answered = true;
        resolve(r as T);
      };
      const keep = this.events.runtimeMessage.emit(msg, sender, respond);
      if (!keep.includes(true) && !answered) resolve(undefined as T);
    });
  }

  /** Emits a finished main-frame navigation (onCommitted + onCompleted) and updates the tab URL. */
  navigate(tabId: number, url: string): void {
    const t = this.tabs.get(tabId);
    if (t) t.url = url;
    this.events.navCommitted.emit({ tabId, frameId: 0, url, transitionType: "link" });
    this.events.navCompleted.emit({ tabId, frameId: 0, url });
  }

  /** CDP calls with this method (optionally on one tab). */
  cdpCalls(method: string, tabId?: number): CdpCall[] {
    return this.cdp.filter((c) => c.method === method && (tabId === undefined || c.tabId === tabId));
  }

  private sendToContent(tabId: number, msg: any, frameId: number): Promise<unknown> {
    const entry: ContentCall = { tabId, frameId, cmd: msg?.cmd, cmdId: msg?.cmdId, payload: msg?.payload };
    this.content.push(entry);
    const page = frameId === 0 ? this.pages.get(tabId) : undefined;
    if (!page) return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
    return page.deliver(structuredClone(msg), frameId).then((r) => {
      entry.response = r;
      return r;
    });
  }
}

// Unknown members resolve to an inert stub: callable (resolves undefined),
// with any property (events: addListener etc.). "then" stays undefined so a
// stub is never mistaken for a promise.
const inert: any = new Proxy(function inertStub() {}, {
  get: (_t, p) => (p === "then" ? undefined : p === Symbol.toPrimitive ? () => "" : inert),
  apply: () => Promise.resolve(undefined),
});

function deepStub<T extends object>(obj: T): T {
  return new Proxy(obj, {
    get(target, p, receiver) {
      if (!(p in target)) return typeof p === "symbol" ? undefined : inert;
      const v = Reflect.get(target, p, receiver);
      if (v && typeof v === "object" && !(v instanceof ChromeEvent) && !Array.isArray(v)) return deepStub(v as object);
      return v;
    },
  }) as T;
}
