// The REAL extension popup (extension/popup.html + i18n.js + popup.js) in a
// happy-dom Window, with a mocked chrome API and fake timers.
//
// popup.html is loaded without its <script> tags; i18n.js and popup.js then run
// as one classic script inside `with (scope)` (as content.js does in
// ext-page.ts), where scope resolves chrome, fetch, the timer functions and Date
// to the mocks below and every other Web API name to the page's own Window.
// Nothing is registered on Bun's global object. The service-worker side is a
// small in-memory model of the privileged mcp-* messages; a test changes its
// state (status, history, disabled sets) and advances the fake clock so the
// popup's polls pick the change up.

import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { parsePermCats, type PermCategory } from "./unit-source-scan.js";

export const EXTENSION_DIR = path.resolve(import.meta.dir, "../../../extension");
export const POPUP_EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
export const EXT_VERSION: string = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8")).version;

/** Messages of a locale: key -> message text. */
export function localeText(locale = "en"): Record<string, string> {
  const raw = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "_locales", locale, "messages.json"), "utf8"));
  return Object.fromEntries(Object.entries<{ message: string }>(raw).map(([k, v]) => [k, v.message]));
}

export interface HistoryEntry {
  id: string;
  action: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  time: number;
  tabId?: number | null;
  host?: string;
  detail?: string;
}

export interface RunningCmd {
  id: string;
  action: string;
  tabId: number | null;
  host: string;
  startedAt: number;
}

export interface AgentTab {
  id: number;
  windowId: number;
  title: string;
  host: string;
  active: boolean;
}

type Timer = { at: number; fn: (...args: unknown[]) => unknown; args: unknown[]; every: number | null };

/** setTimeout / setInterval / Date for the popup, driven by advance(). */
export class FakeClock {
  now: number;
  readonly errors: unknown[] = [];
  private seq = 1;
  private readonly timers = new Map<number, Timer>();

  constructor(start = Date.UTC(2026, 10, 24, 12, 0, 0)) {
    this.now = start;
  }

  setTimeout = (fn: (...args: unknown[]) => unknown, ms = 0, ...args: unknown[]): number => this.add(fn, ms, args, null);
  setInterval = (fn: (...args: unknown[]) => unknown, ms = 0, ...args: unknown[]): number => this.add(fn, ms, args, Math.max(1, Number(ms) || 0));
  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };
  clearInterval = (id: number): void => {
    this.timers.delete(id);
  };

  /** A Date class whose now() (and argument-less constructor) read this clock. */
  dateClass(): DateConstructor {
    const clock = this;
    class FakeDate extends Date {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [clock.now]) as [number]));
      }
      static now(): number {
        return clock.now;
      }
    }
    return FakeDate as unknown as DateConstructor;
  }

  /** Runs every timer due within ms, in order; settle() runs after each callback. */
  async advance(ms: number, settle: () => Promise<void>): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let next: [number, Timer] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      this.now = Math.max(this.now, timer.at);
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      try {
        timer.fn(...timer.args);
      } catch (e) {
        this.errors.push(e);
      }
      await settle();
    }
    this.now = end;
    await settle();
  }

  clearAll(): void {
    this.timers.clear();
  }

  private add(fn: (...args: unknown[]) => unknown, ms: unknown, args: unknown[], every: number | null): number {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn, args, every });
    return id;
  }
}

export interface PopupOptions {
  /** Disabled actions (mcp-perms-get). */
  disabled?: string[];
  /** Actions the agent switched off (mcp-perms-get agentDisabled). */
  agentDisabled?: string[];
  /** Fields merged over the default mcp-status answer (a paired, current server). */
  status?: Record<string, unknown>;
  history?: HistoryEntry[];
  /** chrome.storage.local contents (mcpLang ...). */
  local?: Record<string, unknown>;
  /** chrome.i18n.getUILanguage() (default "en"). */
  uiLanguage?: string;
}

type StorageListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

// ECMAScript globals always come from Bun's realm (see ext-page.ts).
const JS_GLOBALS = new Set([
  "globalThis", "undefined", "NaN", "Infinity", "eval", "isFinite", "isNaN", "parseFloat", "parseInt",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape",
  "Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "BigInt", "Date", "RegExp", "Promise",
  "Proxy", "Reflect", "JSON", "Math", "Intl", "Atomics", "Iterator",
  "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array",
  "BigUint64Array",
]);

export class PopupPage {
  readonly window: Window;
  readonly clock = new FakeClock();
  readonly cats: PermCategory[];
  readonly allActions: string[];
  disabled: Set<string>;
  agentDisabled: Set<string>;
  status: Record<string, unknown>;
  history: HistoryEntry[];
  readonly local: Record<string, unknown>;
  /** Every chrome.runtime.sendMessage the popup made, in order. */
  readonly sent: any[] = [];
  readonly tabUpdates: Array<{ id: number; props: unknown }> = [];
  /** chrome.tabs.create calls (the notice's Details link). */
  readonly tabCreates: unknown[] = [];
  readonly windowUpdates: Array<{ id: number; props: unknown }> = [];
  /** Text the popup wrote with navigator.clipboard.writeText, in order. */
  readonly clipboard: string[] = [];
  /** Per message type: replaces the default answer. */
  handlers: Record<string, (msg: any) => unknown> = {};
  private readonly storageListeners: StorageListener[] = [];

  static catalog(): PermCategory[] {
    return parsePermCats();
  }

  /** Loads the popup and resolves once the permission list has rendered. */
  static async open(opts: PopupOptions = {}): Promise<PopupPage> {
    const p = new PopupPage(opts);
    try {
      await p.until(() => p.$$("#cats .cat").length > 0, "the permission list");
    } catch (e) {
      await p.close();
      throw e;
    }
    return p;
  }

  private constructor(opts: PopupOptions) {
    this.cats = PopupPage.catalog();
    this.allActions = this.cats.flatMap((c) => c.actions);
    this.disabled = new Set(opts.disabled ?? []);
    this.agentDisabled = new Set(opts.agentDisabled ?? []);
    this.status = { ...(opts.status ?? {}) };
    this.history = opts.history ?? [];
    this.local = structuredClone(opts.local ?? {});
    this.window = new Window({
      url: `chrome-extension://${POPUP_EXT_ID}/popup.html`,
      width: 360,
      height: 550,
      settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
    });
    const html = fs.readFileSync(path.join(EXTENSION_DIR, "popup.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    const inner = /<html[^>]*>([\s\S]*)<\/html>/i.exec(html);
    if (!inner) throw new Error("popup.html has no <html> element");
    this.document.documentElement.innerHTML = inner[1];
    const clipboard = {
      writeText: async (text: unknown) => {
        this.clipboard.push(String(text));
      },
      readText: async () => this.clipboard.at(-1) ?? "",
    };
    Object.defineProperty(this.window.navigator, "clipboard", { configurable: true, get: () => clipboard });
    const src = ["i18n.js", "popup.js"].map((f) => fs.readFileSync(path.join(EXTENSION_DIR, f), "utf8")).join("\n;\n");
    new Function("scope", `with (scope) {\n${src}\n}`)(this.scope(opts.uiLanguage ?? "en"));
  }

  get document(): any {
    return this.window.document;
  }

  $(selector: string): any {
    return this.document.querySelector(selector);
  }

  $$(selector: string): any[] {
    return Array.from(this.document.querySelectorAll(selector));
  }

  /** textContent with runs of whitespace collapsed. */
  text(selector: string): string {
    const n = this.$(selector);
    if (!n) throw new Error(`no element matches ${selector}`);
    return String(n.textContent).replace(/\s+/g, " ").trim();
  }

  visible(selector: string): boolean {
    const n = this.$(selector);
    if (!n) throw new Error(`no element matches ${selector}`);
    for (let e = n; e && e !== this.document.documentElement; e = e.parentElement) if (e.hidden) return false;
    return true;
  }

  /** The derived profile the segmented control shows (aria-checked). */
  checkedProfile(): string | null {
    const b = this.$$("#profileSeg [role=radio]").find((x) => x.getAttribute("aria-checked") === "true");
    return b ? b.getAttribute("data-profile") : null;
  }

  dialogOpen(): boolean {
    return !!this.$("#confirmDlg").open;
  }

  sentOf(type: string): any[] {
    return this.sent.filter((m) => m && m.type === type);
  }

  /** Focuses the element (as a real click does) and clicks it. */
  async click(target: string | any): Promise<void> {
    const n = typeof target === "string" ? this.$(target) : target;
    if (!n) throw new Error(`no element matches ${target}`);
    if (typeof n.focus === "function") n.focus();
    n.click();
    await this.settle();
  }

  /** The themed tooltip (#tip): whether it is shown and its text. */
  tip(): { open: boolean; text: string } {
    const tip = this.$("#tip");
    if (!tip) throw new Error("no #tip element");
    return { open: tip.classList.contains("show"), text: String(tip.textContent) };
  }

  /** The pointer moves onto the element (pointerover bubbles to the document), at `at` when given. */
  async hover(target: string | any, at?: { x: number; y: number }): Promise<void> {
    const n = typeof target === "string" ? this.$(target) : target;
    if (!n) throw new Error(`no element matches ${target}`);
    n.dispatchEvent(new this.window.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", relatedTarget: this.document.body, clientX: at?.x ?? 0, clientY: at?.y ?? 0 }));
    await this.settle();
  }

  /** The pointer leaves the element for `to` (the body by default), to `at` when given. */
  async unhover(target: string | any, to?: any, at?: { x: number; y: number }): Promise<void> {
    const n = typeof target === "string" ? this.$(target) : target;
    if (!n) throw new Error(`no element matches ${target}`);
    n.dispatchEvent(new this.window.PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: to ?? this.document.body, clientX: at?.x ?? 0, clientY: at?.y ?? 0 }));
    await this.settle();
  }

  /** The pointer moves to (x, y) within the element (pointermove bubbles to the document). */
  async move(target: string | any, x: number, y: number): Promise<void> {
    const n = typeof target === "string" ? this.$(target) : target;
    if (!n) throw new Error(`no element matches ${target}`);
    n.dispatchEvent(new this.window.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: x, clientY: y }));
    await this.settle();
  }

  /** happy-dom has no layout: makes the element report the given box. */
  setBox(target: string | any, left: number, top: number, width: number, height: number): void {
    const n = typeof target === "string" ? this.$(target) : target;
    if (!n) throw new Error(`no element matches ${target}`);
    n.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  }

  /**
   * happy-dom has no layout: makes an element report text cut by an ellipsis
   * (scrollWidth > clientWidth), or text that fits again with cut = false.
   */
  setCut(target: string | any, cut = true): void {
    const n = typeof target === "string" ? this.$(target) : target;
    if (!n) throw new Error(`no element matches ${target}`);
    Object.defineProperty(n, "clientWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(n, "scrollWidth", { configurable: true, get: () => (cut ? 180 : 100) });
  }

  /** keydown on the focused element (bubbles to the document). */
  async key(key: string): Promise<void> {
    const target = this.document.activeElement || this.document.body;
    target.dispatchEvent(new this.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await this.settle();
  }

  /** Lets pending promise chains and storage events run (real macrotask turns). */
  async settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  }

  async until(cond: () => unknown, what: string, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      if (cond()) return;
      await this.settle(1);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Advances the popup's clock: polls and tickers due in that time run. */
  async advance(ms: number): Promise<void> {
    await this.clock.advance(ms, () => this.settle(4));
  }

  /** A chrome.storage.local write from elsewhere (background, another popup). */
  async storageWrite(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.local[k], newValue: structuredClone(v) };
      this.local[k] = structuredClone(v);
    }
    for (const fn of this.storageListeners.slice()) fn(structuredClone(changes), "local");
    await this.settle();
  }

  async close(): Promise<void> {
    this.clock.clearAll();
    await this.window.happyDOM.close();
  }

  /** Default answers of the background (extension/background.js) to the popup's messages. */
  private answer(msg: any): unknown {
    switch (msg && msg.type) {
      case "mcp-status":
        return {
          bridgeConnected: true,
          port: 8765,
          activeTab: null,
          extensionId: POPUP_EXT_ID,
          paired: true,
          lastClose: null,
          pairState: "paired",
          serverVersion: EXT_VERSION,
          serverProtocol: 3,
          hasKey: true,
          running: [],
          agentTabs: [],
          ...this.status,
        };
      case "mcp-perms-get":
        return { cats: this.cats, disabled: [...this.disabled], requires: {}, agentDisabled: [...this.agentDisabled] };
      case "mcp-perms-set": {
        for (const [a, on] of Object.entries<boolean>(msg.actions ?? {})) {
          if (!this.allActions.includes(a)) continue;
          if (on) this.disabled.delete(a);
          else this.disabled.add(a);
          this.agentDisabled.delete(a);
        }
        return { ok: true, disabled: [...this.disabled] };
      }
      case "mcp-history-get":
        return { history: this.history };
      case "mcp-history-clear":
        this.history = [];
        return { ok: true };
      case "mcp-stop-all": {
        const running = Array.isArray(this.status.running) ? this.status.running : [];
        this.disabled = new Set(this.allActions);
        this.agentDisabled.clear();
        this.status = { ...this.status, running: [] };
        return { ok: true, cancelled: running.length, disabled: [...this.disabled] };
      }
      case "mcp-forget-pairing":
        this.status = { ...this.status, hasKey: false };
        return { ok: true };
      case "mcp-repair":
        return { ok: true };
      case "mcp-port-set":
        return { ok: true, port: msg.port };
      default:
        return undefined;
    }
  }

  private chromeApi(uiLanguage: string): unknown {
    const local = {
      get: async (keys?: string | string[] | null) => {
        if (keys == null) return structuredClone(this.local);
        const out: Record<string, unknown> = {};
        for (const k of ([] as string[]).concat(keys)) if (k in this.local) out[k] = structuredClone(this.local[k]);
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: this.local[k], newValue: structuredClone(v) };
          this.local[k] = structuredClone(v);
        }
        // Chrome reports changes asynchronously, after the write resolved.
        setTimeout(() => {
          for (const fn of this.storageListeners.slice()) fn(structuredClone(changes), "local");
        }, 0);
      },
      remove: async (keys: string | string[]) => {
        for (const k of ([] as string[]).concat(keys)) delete this.local[k];
      },
    };
    return {
      runtime: {
        id: POPUP_EXT_ID,
        getManifest: () => ({ manifest_version: 3, version: EXT_VERSION }),
        getURL: (p: string) => `chrome-extension://${POPUP_EXT_ID}/${String(p).replace(/^\//, "")}`,
        sendMessage: async (msg: any) => {
          this.sent.push(structuredClone(msg));
          const handler = msg && this.handlers[msg.type];
          const r = handler ? await handler(msg) : this.answer(msg);
          return r === undefined ? undefined : structuredClone(r);
        },
      },
      i18n: { getUILanguage: () => uiLanguage, getMessage: () => "" },
      storage: {
        local,
        onChanged: {
          addListener: (fn: StorageListener) => this.storageListeners.push(fn),
          removeListener: (fn: StorageListener) => {
            const i = this.storageListeners.indexOf(fn);
            if (i >= 0) this.storageListeners.splice(i, 1);
          },
        },
      },
      tabs: {
        create: async (props: unknown) => {
          this.tabCreates.push(structuredClone(props));
          return { id: 1000 + this.tabCreates.length };
        },
        update: async (id: number, props: unknown) => {
          this.tabUpdates.push({ id, props: structuredClone(props) });
          return { id };
        },
      },
      windows: {
        update: async (id: number, props: unknown) => {
          this.windowUpdates.push({ id, props: structuredClone(props) });
          return { id };
        },
      },
    };
  }

  /** extension files by chrome-extension:// URL (i18n.js loads _locales/<l>/messages.json). */
  private async fetchExtensionFile(url: unknown): Promise<Response> {
    const prefix = `chrome-extension://${POPUP_EXT_ID}/`;
    if (typeof url !== "string" || !url.startsWith(prefix)) throw new TypeError(`unexpected fetch: ${String(url)}`);
    const file = path.resolve(EXTENSION_DIR, url.slice(prefix.length));
    if (!file.startsWith(EXTENSION_DIR + path.sep) || !fs.existsSync(file)) return new Response("", { status: 404 });
    return new Response(fs.readFileSync(file, "utf8"), { headers: { "content-type": "application/json" } });
  }

  private scope(uiLanguage: string): object {
    const win = this.window as unknown as Record<string | symbol, unknown>;
    const overrides: Record<string, unknown> = {
      chrome: this.chromeApi(uiLanguage),
      fetch: (url: unknown) => this.fetchExtensionFile(url),
      setTimeout: this.clock.setTimeout,
      setInterval: this.clock.setInterval,
      clearTimeout: this.clock.clearTimeout,
      clearInterval: this.clock.clearInterval,
      Date: this.clock.dateClass(),
    };
    const bound = new WeakMap<Function, Function>();
    return new Proxy(win as object, {
      has: (target, key) =>
        typeof key === "string" &&
        (key in overrides || (!JS_GLOBALS.has(key) && key in target && Reflect.get(target, key, target) !== undefined)),
      get: (target, key) => {
        if (typeof key === "string" && key in overrides) return overrides[key];
        const value = Reflect.get(target, key, target);
        // Own properties are classes and fields; prototype methods need the Window as `this`.
        if (typeof value !== "function" || Object.prototype.hasOwnProperty.call(target, key)) return value;
        let fn = bound.get(value);
        if (!fn) bound.set(value, (fn = value.bind(target)));
        return fn;
      },
    });
  }
}
