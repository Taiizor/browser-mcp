// A page with the real extension/content.js, rendered by happy-dom.
//
// content.js is a classic script that reads the page globals (window,
// document, Node, KeyboardEvent ...) and chrome.runtime. It is evaluated inside
// `with (scope)`, where scope resolves the Web API names on this page's own
// happy-dom Window: nothing is registered on Bun's global object, and several
// pages can live in one test process. (happy-dom has no layout: element boxes
// are 0x0, so the snapshot marks elements "(hidden)".)

import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import type { ContentTarget } from "./ext-chrome.js";

export const CONTENT_JS = path.resolve(import.meta.dir, "../../../extension/content.js");

export interface ContentPageOptions {
  url?: string;
  html: string;
  extensionId: string;
  tabId?: number;
  /** content.js chrome.runtime.sendMessage (console / dialog relay) is forwarded here. */
  toBackground?: (msg: unknown, sender: Record<string, unknown>) => void;
}

type ContentListener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

export class ContentPage implements ContentTarget {
  readonly window: Window;
  readonly tabId: number;
  private readonly listeners: ContentListener[] = [];

  constructor(opts: ContentPageOptions) {
    const url = opts.url ?? "https://example.com/";
    this.tabId = opts.tabId ?? 1;
    this.window = new Window({ url, width: 1280, height: 800 });
    this.document.title = "Example";
    this.document.body.innerHTML = opts.html;
    const tabId = this.tabId;
    const win = this.window as unknown as Record<string, unknown>;
    win.chrome = {
      runtime: {
        id: opts.extensionId,
        onMessage: { addListener: (fn: ContentListener) => this.listeners.push(fn) },
        sendMessage: async (msg: unknown) => {
          opts.toBackground?.(msg, { id: opts.extensionId, tab: { id: tabId }, frameId: 0, url });
          return undefined;
        },
      },
    };
    const src = fs.readFileSync(CONTENT_JS, "utf8");
    new Function("scope", `with (scope) {\n${src}\n}`)(pageScope(this.window));
    if (!this.listeners.length) throw new Error("content.js registered no chrome.runtime.onMessage listener");
  }

  get document(): Window["document"] {
    return this.window.document;
  }

  /** chrome.tabs.sendMessage semantics: the first listener's sendResponse, or undefined. */
  deliver(msg: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      let answered = false;
      const sendResponse = (r: unknown) => {
        if (answered) return;
        answered = true;
        resolve(structuredClone(r));
      };
      const keep = this.listeners[0](msg, { id: (this.window as unknown as { chrome: { runtime: { id: string } } }).chrome.runtime.id }, sendResponse);
      if (keep !== true && !answered) resolve(undefined);
    });
  }

  /** Sends one content command directly (no background) and returns its {ok, result|error} answer. */
  command(cmd: string, payload: Record<string, unknown> = {}, cmdId?: string): Promise<any> {
    return this.deliver({ __mcp: 1, cmd, payload, cmdId });
  }

  $(selector: string): any {
    return this.document.querySelector(selector);
  }

  async close(): Promise<void> {
    await this.window.happyDOM.close();
  }
}

// ECMAScript globals always come from Bun's realm, like the script's own
// literals ([] / {}) do: happy-dom's Window carries another realm's copies on
// Bun 1.4 (instanceof Array would then fail across realms) and undefined
// placeholders on Bun 1.3.
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

/**
 * The scope object content.js runs in: Web APIs resolve on the page's Window
 * (classes as they are, methods bound to the Window as a browser calls them),
 * ECMAScript globals and anything the Window lacks fall through to Bun's global.
 */
function pageScope(win: Window): object {
  const bound = new WeakMap<Function, Function>();
  return new Proxy(win as object, {
    has: (target, key) => typeof key === "string" && !JS_GLOBALS.has(key) && key in target && Reflect.get(target, key, target) !== undefined,
    get: (target, key) => {
      const value = Reflect.get(target, key, target);
      // Own properties are classes and fields; prototype methods need the Window as `this`.
      if (typeof value !== "function" || Object.prototype.hasOwnProperty.call(target, key)) return value;
      let fn = bound.get(value);
      if (!fn) bound.set(value, (fn = value.bind(target)));
      return fn;
    },
  });
}
