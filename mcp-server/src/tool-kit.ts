// Shared building blocks of the MCP tool layer: the one registration wrapper
// every tool goes through (ToolKit.define), common parameters, annotation
// presets, the output cap and result / bridge helpers. Import-safe: no side
// effects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { IBridge } from "./bridge.js";
import {
  changeSelection,
  hiddenToolMessage,
  isToolVisible,
  selectionOf,
  summarizeToolsets,
  type ToolCategory,
  type ToolsetChange,
  type ToolsetId,
  type ToolsetSelection,
  type ToolsetSummary,
} from "./toolsets.js";
import { hiddenSegment, isStrictAbsolute, secretNameRule, SPILL_DIR_PREFIX } from "./upload-guard.js";

// ---------- registration ----------

// Categories live with the toolset logic; re-exported here because every tool
// module imports its building blocks from tool-kit.
export { TOOL_CATEGORIES, type ToolCategory } from "./toolsets.js";

/**
 * Extension actions by permission category: a mirror of PERM_CATS in
 * extension/background.js (keep the two in sync). It tells which popup
 * switches a tool depends on, so a tool whose actions are switched off can be
 * hidden from tools/list.
 */
export const EXTENSION_ACTIONS: Readonly<Record<Exclude<ToolCategory, "meta">, readonly string[]>> = {
  tabs: [
    "tabs_list", "tab_create", "tab_duplicate", "tab_close", "tab_activate", "tab_navigate", "tab_reload", "tab_back",
    "tab_forward", "tab_pin", "tab_mute", "window_list", "window_create", "window_focus", "browser_close", "frame_list",
    "frame_focus", "frame_clear", "tab_group_create", "tab_group_list", "tab_group_update", "tab_group_ungroup",
  ],
  read: ["page_snapshot", "page_html", "page_text", "dom_query", "page_find", "page_wait", "page_axtree"],
  interact: [
    "dom_click", "dom_type", "dom_fill", "dom_select", "dom_check", "dom_hover", "dom_focus", "dom_scroll", "dom_drag",
    "dom_upload", "keyboard_press",
  ],
  media: ["page_screenshot", "page_pdf", "tab_audio_record_start", "tab_audio_record_stop"],
  console: ["console_get", "console_clear"],
  network: [
    "network_requests", "network_clear", "network_response_body", "network_bodies", "network_throttle",
    "network_set_headers", "har_export",
  ],
  mock: [
    "network_mock_start", "network_mock_stop", "network_mock_route", "network_mock_list", "network_mock_remove",
    "network_mock_clear",
  ],
  downloads: ["downloads_list", "downloads_pause", "downloads_resume", "downloads_cancel", "downloads_erase"],
  bookmarks: ["bookmarks_search", "bookmarks_list", "bookmarks_add", "bookmarks_remove"],
  cookies: ["cookies_list", "cookies_get", "cookies_set", "cookies_delete", "cookies_clear", "cookies_export", "cookies_import"],
  storage: ["storage_get", "storage_set", "idb_list", "idb_stores", "idb_read", "idb_count", "idb_put", "idb_delete", "idb_clear"],
  sessions: ["sessions_recently_closed", "sessions_restore", "session_state_save", "session_state_load"],
  dialogs: ["dialog_policy", "dialog_get", "dialog_clear"],
  power: ["js_evaluate", "cdp_send"],
  trusted: ["trusted_click", "trusted_type", "trusted_key", "trusted_scroll", "trusted_drag"],
  clipboard: ["clipboard_read", "clipboard_write"],
  browsing_data: ["browsing_data_clear"],
  notifications: ["notification_create", "notification_clear"],
  emulation: [
    "emulation_geolocation", "emulation_geolocation_clear", "emulation_viewport", "emulation_media", "emulation_cpu",
    "emulation_reset",
  ],
  performance: ["page_metrics", "perf_web_vitals", "perf_trace_start", "perf_trace_stop", "perf_trace_chunk"],
  system: ["permissions_grant", "history_search", "history_delete"],
};

const KNOWN_EXTENSION_ACTIONS: ReadonlySet<string> = new Set(Object.values(EXTENSION_ACTIONS).flat());

/**
 * Tools whose popup switches differ from their own name. Every other tool
 * depends on the action of the same name when that is an extension action,
 * and on none otherwise (browser_status, browser_launch, browser_toolsets).
 * js_evaluate stays [js_evaluate]: its cdp_send path is only a fallback for
 * extensions older than 0.3.4.
 */
const TOOL_ACTION_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  tab_list: ["tabs_list"],
  tab_audio_capture: ["tab_audio_record_start", "tab_audio_record_stop"],
  // The trace is read back chunk by chunk: without perf_trace_chunk the tool cannot finish.
  perf_trace_stop: ["perf_trace_stop", "perf_trace_chunk"],
  // perm_list / perm_set manage the switches themselves and are never gated.
  permissions_list: [],
  permissions_set: [],
};

/** Extension actions (popup switches) tool `name` depends on. */
export function toolActions(name: string): readonly string[] {
  return TOOL_ACTION_OVERRIDES[name] ?? (KNOWN_EXTENSION_ACTIONS.has(name) ? [name] : []);
}

/**
 * Composite extension actions that read or write data guarded by other
 * switches: a mirror of REQUIRES in extension/background.js (keep the two in
 * sync). The extension refuses such an action unless every listed action is
 * enabled as well, so a tool is hidden when any of them is switched off.
 */
export const EXTENSION_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  session_state_save: ["cookies_list", "storage_get"],
  session_state_load: ["cookies_set", "storage_set"],
  har_export: ["network_requests"],
  network_bodies: ["network_requests"],
  network_response_body: ["network_requests"],
  cookies_export: ["cookies_list"],
  cookies_import: ["cookies_set"],
};

/**
 * Further switches tool `name` needs through EXTENSION_REQUIRES (deduplicated,
 * without the tool's own actions). They may lie in another category, which is
 * why they are kept apart from toolActions().
 */
export function toolRequires(name: string): readonly string[] {
  const own = toolActions(name);
  const out: string[] = [];
  for (const a of own) {
    for (const dep of EXTENSION_REQUIRES[a] ?? []) if (!own.includes(dep) && !out.includes(dep)) out.push(dep);
  }
  return out;
}

/** Per-request context the SDK hands to tool callbacks. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type SendFn = <T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs?: number) => Promise<T>;

/** What a tool handler gets besides its validated arguments. */
export interface ToolContext {
  /**
   * The bridge given to createServer. Commands go through `send`; the raw
   * bridge is for local state (event buffers, permission snapshot, launch /
   * close) and for cleanup that must still run after the request is
   * cancelled (tab_audio_capture stopping its recording).
   */
  readonly bridge: IBridge;
  /**
   * bridge.send on behalf of this request, bound to its abort signal: when the
   * client cancels the call, the extension command is cancelled too.
   */
  readonly send: SendFn;
  /** SDK request context: abort signal, progress token, sendNotification. */
  readonly extra: ToolExtra;
}

export interface ToolDefinition<Shape extends ZodRawShapeCompat> {
  name: string;
  /** Short human-readable name shown by clients. */
  title: string;
  description: string;
  category: ToolCategory;
  /** zod raw shape; {} for tools without arguments. */
  inputSchema: Shape;
  annotations: ToolAnnotations;
  handler: (args: ShapeOutput<Shape>, ctx: ToolContext) => CallToolResult | Promise<CallToolResult>;
  /**
   * What the output cap's note tells the caller when this tool's text is cut.
   * Default: PAGING_HINT for tools with an offset parameter, else NARROW_HINT
   * (SENSITIVE_HINT in the sensitive categories, whose text is never saved).
   */
  capHint?: string;
}

export interface ToolEntry {
  readonly name: string;
  readonly category: ToolCategory;
  /** Extension actions (popup switches) the tool depends on, from toolActions(). */
  readonly actions: readonly string[];
  /** Other switches its actions need (EXTENSION_REQUIRES), from toolRequires(). */
  readonly requires: readonly string[];
  /** SDK handle: enable() / disable() / update() re-announce tools/list. */
  readonly tool: RegisteredTool;
}

export interface ToolKitOptions {
  /** Text characters a tool result may return inline (default DEFAULT_MAX_OUTPUT_CHARS, at least MIN_OUTPUT_CHARS). */
  maxOutputChars?: number;
  /** Persists an oversized output; returns its path (default spillToPrivateTemp). */
  saveOutput?: (data: Buffer, baseName: string) => string;
  /** Toolsets listed from the start (default ["all"]: a bare ToolKit hides nothing by toolset). */
  toolsets?: readonly ToolsetId[];
}

/** Result of ToolKit.changeToolsets: the new listing plus the tools that appeared / disappeared. */
export interface ToolsetUpdate extends ToolsetSummary {
  shown: string[];
  hidden: string[];
}

/**
 * Registers tools on one McpServer for one bridge. Every tool goes through
 * define(), so behaviour that applies to all calls lives in one place:
 * cancellation (ctx.send carries the request's abort signal), the output cap,
 * toolsets, and hiding tools whose actions are switched off in the popup.
 * The registry keeps each tool's SDK handle with its category, actions and
 * required actions.
 *
 * The McpServer must not have its tool handlers yet (create it without
 * capabilities.tools; the first define() installs them): the kit wraps the
 * SDK's tools/call handler as it is installed, so a call to a hidden tool
 * gets an error that names the cause and the fix (hiddenToolMessage) instead
 * of the SDK's bare "Tool X disabled".
 */
export class ToolKit {
  /** Registered tools by name, in registration order. */
  readonly registry = new Map<string, ToolEntry>();
  readonly maxOutputChars: number;
  private readonly saveOutput: (data: Buffer, baseName: string) => string;
  private selection: ToolsetSelection;
  /** Last popup snapshot as a set; null = not reported yet (nothing is hidden for it). */
  private disabled: ReadonlySet<string> | null = null;

  constructor(
    readonly server: McpServer,
    readonly bridge: IBridge,
    opts: ToolKitOptions = {}
  ) {
    this.maxOutputChars = clampOutputChars(opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
    this.saveOutput = opts.saveOutput ?? spillToPrivateTemp;
    this.selection = selectionOf(opts.toolsets ?? ["all"]);
    this.interceptHiddenToolCalls();
  }

  /**
   * Wraps the tools/call handler the SDK installs on the first registerTool:
   * hidden tools stay disabled in the SDK (so its tools/list leaves them
   * out), but a call to one is answered here with hiddenToolMessage().
   * Relies only on public Server methods (assertCanSetRequestHandler,
   * setRequestHandler); the unit tests fail loudly if the SDK changes that.
   */
  private interceptHiddenToolCalls(): void {
    const low = this.server.server;
    try {
      low.assertCanSetRequestHandler("tools/call");
    } catch {
      throw new Error(
        "ToolKit needs an McpServer without tool handlers: create it without capabilities.tools (the first define() installs them)"
      );
    }
    type Handler = (request: CallToolRequest, extra: ToolExtra) => unknown;
    const install = low.setRequestHandler.bind(low) as unknown as (schema: unknown, handler: Handler) => void;
    const patched = (schema: unknown, handler: Handler): void => {
      if (schema === CallToolRequestSchema) {
        const inner = handler;
        handler = (request, extra) => this.hiddenToolResult(request?.params?.name) ?? inner(request, extra);
      }
      install(schema, handler);
    };
    low.setRequestHandler = patched as unknown as typeof low.setRequestHandler;
  }

  /** The isError result for a call to a registered tool that is hidden now; null for anything else. */
  private hiddenToolResult(name: unknown): CallToolResult | null {
    const entry = typeof name === "string" ? this.registry.get(name) : undefined;
    if (!entry || entry.tool.enabled) return null;
    const message = hiddenToolMessage(entry, this.selection, this.disabled) ?? `Tool ${entry.name} is hidden right now; browser_toolsets shows why.`;
    return { content: [{ type: "text", text: message }], isError: true };
  }

  define<Shape extends ZodRawShapeCompat>(def: ToolDefinition<Shape>): RegisteredTool {
    const { name, title, description, category, inputSchema, annotations, handler } = def;
    if (this.registry.has(name)) throw new Error(`Tool ${name} is already registered`);
    const sensitive = SENSITIVE_OUTPUT_CATEGORIES.has(category);
    const capHint = def.capHint ?? ("offset" in inputSchema ? PAGING_HINT : sensitive ? SENSITIVE_HINT : NARROW_HINT);
    const callback = async (args: ShapeOutput<Shape>, extra: ToolExtra): Promise<CallToolResult> => {
      let result: CallToolResult;
      try {
        result = await handler(args, this.context(extra));
      } catch (e) {
        // Short errors keep the SDK's own error result; an oversized message
        // (a page error echoing a huge value) is capped like any other output.
        const message = e instanceof Error ? e.message : String(e);
        if (message.length <= this.maxOutputChars) throw e;
        result = { content: [{ type: "text", text: message }], isError: true };
      }
      return this.capOutput(name, result, { hint: capHint, sensitive: sensitive ? category : null });
    };
    const tool = this.server.registerTool(
      name,
      { title, description, inputSchema, annotations },
      callback as unknown as ToolCallback<Shape>
    );
    const entry: ToolEntry = { name, category, actions: toolActions(name), requires: toolRequires(name), tool };
    this.registry.set(name, entry);
    // Tools registered at any time fall under the current toolsets and switches.
    this.sync(entry);
    return tool;
  }

  // ---------- toolsets and popup switches ----------

  /** Current toolset selection (a copy). */
  get toolsets(): ToolsetSelection {
    return { include: new Set(this.selection.include), exclude: new Set(this.selection.exclude) };
  }

  /** Listing for browser_toolsets. */
  toolsetSummary(): ToolsetSummary {
    return summarizeToolsets([...this.registry.values()], this.selection, this.disabled);
  }

  /** Changes the selection at runtime; tools/list_changed goes out when the list changes. */
  changeToolsets(change: ToolsetChange): ToolsetUpdate {
    this.selection = changeSelection(this.selection, change);
    const { shown, hidden } = this.syncAll();
    return { ...this.toolsetSummary(), shown, hidden };
  }

  /** Applies a popup snapshot (null = unknown: nothing is hidden for it). */
  setDisabledActions(disabled: readonly string[] | null): void {
    this.disabled = disabled ? new Set(disabled) : null;
    this.syncAll();
  }

  /**
   * Follows the bridge's permission snapshot: applies the current one, then
   * every change the extension reports. Returns the unsubscribe function.
   */
  trackPermissions(): () => void {
    this.setDisabledActions(this.bridge.knownDisabled());
    return this.bridge.onPermsChange((disabled) => this.setDisabledActions(disabled));
  }

  /** Whether tools/list should show `entry` now. */
  isListed(entry: ToolEntry): boolean {
    return isToolVisible(entry, this.selection, this.disabled);
  }

  private sync(entry: ToolEntry): "shown" | "hidden" | null {
    const want = this.isListed(entry);
    if (entry.tool.enabled === want) return null;
    // Each call announces tools/list_changed; createServer debounces the
    // notification, so a batch of changes reaches the client as one.
    if (want) entry.tool.enable();
    else entry.tool.disable();
    return want ? "shown" : "hidden";
  }

  private syncAll(): { shown: string[]; hidden: string[] } {
    const shown: string[] = [];
    const hidden: string[] = [];
    for (const entry of this.registry.values()) {
      const r = this.sync(entry);
      if (r === "shown") shown.push(entry.name);
      else if (r === "hidden") hidden.push(entry.name);
    }
    return { shown, hidden };
  }

  // ---------- per-call plumbing ----------

  private context(extra: ToolExtra): ToolContext {
    const bridge = this.bridge;
    // A cancelled MCP request aborts its extension command too (cancel frame).
    const signal = extra.signal;
    const send: SendFn = (action, payload, tabId, timeoutMs) => bridge.send(action, payload, tabId, timeoutMs, { signal });
    return { bridge, send, extra };
  }

  /**
   * Caps one result. Text of the sensitive categories (cookies, storage,
   * sessions, clipboard) is never written to disk implicitly: it is cut and
   * the note says how to get the rest.
   */
  private capOutput(name: string, result: CallToolResult, how: { hint: string; sensitive: ToolCategory | null }): CallToolResult {
    return capToolOutput(result, this.maxOutputChars, {
      save: how.sensitive ? null : (text, ext) => this.saveOutput(Buffer.from(text, "utf8"), `${name}-output${ext}`),
      withheld: how.sensitive ? `${how.sensitive} data is sensitive` : undefined,
      hint: how.hint,
    });
  }
}

// ---------- output cap ----------
/** Default text budget of one tool result (BROWSER_MCP_MAX_OUTPUT_CHARS). */
export const DEFAULT_MAX_OUTPUT_CHARS = 40000;
/** Smallest accepted cap: below it even a short page window or error would be cut. */
export const MIN_OUTPUT_CHARS = 1000;

function clampOutputChars(n: number): number {
  return Number.isFinite(n) ? Math.max(MIN_OUTPUT_CHARS, Math.floor(n)) : DEFAULT_MAX_OUTPUT_CHARS;
}

/**
 * The output cap: an explicit value wins, else BROWSER_MCP_MAX_OUTPUT_CHARS,
 * else DEFAULT_MAX_OUTPUT_CHARS. Values below MIN_OUTPUT_CHARS are raised to
 * it; an unparsable env value is ignored. Problems are reported through `log`.
 */
export function resolveMaxOutputChars(
  explicit: number | undefined,
  env: Record<string, string | undefined>,
  log: (line: string) => void = () => {}
): number {
  let n = explicit;
  let source = "maxOutputChars";
  if (n === undefined) {
    const raw = env.BROWSER_MCP_MAX_OUTPUT_CHARS?.trim();
    if (!raw) return DEFAULT_MAX_OUTPUT_CHARS;
    if (!/^\d+$/.test(raw)) {
      log(`ignoring BROWSER_MCP_MAX_OUTPUT_CHARS="${raw}" (expected a whole number); using ${DEFAULT_MAX_OUTPUT_CHARS}`);
      return DEFAULT_MAX_OUTPUT_CHARS;
    }
    n = Number(raw);
    source = "BROWSER_MCP_MAX_OUTPUT_CHARS";
  }
  const capped = clampOutputChars(n);
  if (Number.isFinite(n) && n < MIN_OUTPUT_CHARS) log(`${source}=${n} is below the minimum; using ${capped}`);
  return capped;
}

/** Cap note hint for tools that page with offset / maxChars. */
export const PAGING_HINT = "use offset/maxChars to read the rest";
/** Cap note hint for every other tool. */
export const NARROW_HINT = "narrow the request (a filter, limit or selector) to get less at once";
/** Cap note hint for the sensitive categories without a hint of their own. */
export const SENSITIVE_HINT = "narrow the request, or raise BROWSER_MCP_MAX_OUTPUT_CHARS to get more inline";

/**
 * Categories whose output holds credentials or private data (cookies, web
 * storage, session bundles, the clipboard): when it is cut by the cap, the
 * rest is never written to a temp file behind the caller's back.
 */
export const SENSITIVE_OUTPUT_CATEGORIES: ReadonlySet<ToolCategory> = new Set<ToolCategory>(["cookies", "storage", "sessions", "clipboard"]);

function isTextPart(part: CallToolResult["content"][number]): part is Extract<CallToolResult["content"][number], { type: "text" }> {
  return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export type SaveFullOutput = (fullText: string, ext: ".txt" | ".json") => string;

export interface CapOptions {
  /** Persists the full text and returns where; null / omitted: the full text is not saved. */
  save?: SaveFullOutput | null;
  /** Why the full text is not saved (shown in the note when there is no `save`). */
  withheld?: string;
  /** Last part of the note: how to get the rest (default NARROW_HINT). */
  hint?: string;
}

/**
 * Caps the text of a tool result at `maxChars` characters in total. Only text
 * parts count and change: images, audio and resources pass through. When the
 * text is longer, the head is kept and a note line follows it:
 * [output truncated: <shown>/<total> chars; <where>; <hint>], where <where>
 * is "full output saved to <path>" when `save` (given as a function or as
 * opts.save) stored the full text (all text parts joined by "\n"; ".json"
 * when it parses as JSON, else ".txt"), "saving the full output failed (...)"
 * when it threw, and "the rest is not saved to disk (<withheld>)" without
 * one. Text parts after the cut are dropped. isError results are capped the
 * same way. Returns `result` itself when nothing needs cutting.
 */
export function capToolOutput(result: CallToolResult, maxChars: number, saveOrOpts: SaveFullOutput | CapOptions): CallToolResult {
  const opts: CapOptions = typeof saveOrOpts === "function" ? { save: saveOrOpts } : saveOrOpts;
  const content = Array.isArray(result?.content) ? result.content : [];
  let total = 0;
  for (const part of content) if (isTextPart(part)) total += part.text.length;
  if (total <= maxChars) return result;

  // Where the cut falls: whole text parts while they fit, then the head of the next one.
  let budget = maxChars;
  let cutAt = -1;
  let head = "";
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (!isTextPart(part)) continue;
    if (part.text.length <= budget) {
      budget -= part.text.length;
      continue;
    }
    cutAt = i;
    head = headOf(part.text, budget);
    break;
  }
  const shown = maxChars - budget + head.length;

  let where: string;
  if (opts.save) {
    const fullText = content.filter(isTextPart).map((p) => p.text).join("\n");
    try {
      where = `full output saved to ${opts.save(fullText, looksLikeJson(fullText) ? ".json" : ".txt")}`;
    } catch (e) {
      where = `saving the full output failed (${errMessage(e)})`;
    }
  } else {
    where = `the rest is not saved to disk${opts.withheld ? ` (${opts.withheld})` : ""}`;
  }
  const note = `[output truncated: ${shown}/${total} chars; ${where}; ${opts.hint ?? NARROW_HINT}]`;

  const out: CallToolResult["content"] = [];
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (!isTextPart(part) || i < cutAt) out.push(part);
    else if (i === cutAt) out.push({ ...part, text: head ? `${head}\n${note}` : note });
    // Text parts after the cut are dropped.
  }
  return { ...result, content: out };
}

// ---------- shared parameters ----------
export const TabId = z.number().int().optional().describe("Tab ID from tab_list. Omit for the active tab.");
// Log/traffic readers filter by tab only when asked: an omitted tabId means every tab.
export const TabIdAllTabs = z.number().int().optional().describe("Only entries from this tab (see tab_list). Omit for all tabs.");
export const SelectorDesc =
  'CSS selector (also searches open shadow roots; css=... prefix optional), "host >>> inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012)';

/** Optional positive integer limit with an upper bound. */
export function limitParam(max: number, description: string) {
  return z.number().int().positive().max(max).optional().describe(description);
}

// ---------- tool annotations (MCP hints for clients) ----------
// Browser / bridge state reads (tabs, cookies, history, buffers...).
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
// Reads of page content: untrusted data from arbitrary websites.
export const READ_PAGE: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
// Reversible settings that can be re-applied safely (focus, overrides, policies).
export const STATE_SET: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Non-destructive changes that are not idempotent (toggles, creating items).
export const STATE_CHANGE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// Opening / navigating pages.
export const NAVIGATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
// Low-impact page interaction (scroll, hover, focus, find).
export const PAGE_INTERACT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
// Page input whose effect depends on the page (a click can submit or delete):
// destructiveHint is left unset, i.e. the spec default (may be destructive).
export const PAGE_ACTION: ToolAnnotations = { readOnlyHint: false, idempotentHint: false, openWorldHint: true };
// Arbitrary code / raw protocol access.
export const POWER: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
// Irreversible deletion / overwrite of user data.
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------- results and errors ----------
export function errMessage(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

/** Rejects with `message` when `p` does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export function textResult(obj: unknown): { content: { type: "text"; text: string }[] } {
  if (typeof obj === "string") {
    return { content: [{ type: "text" as const, text: obj }] };
  }
  const str = JSON.stringify(obj);
  const text = str.length > 1200 ? str : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

export function permissionDeniedError(action: string): Error {
  return new Error(`Permission disabled in extension: ${action} (enable it from the extension popup)`);
}

export function isPermissionError(e: unknown): boolean {
  return /Permission disabled/i.test(errMessage(e));
}

/**
 * Saves a binary artifact the caller asked for (a PDF, recording or trace
 * without savePath) to a fresh private (0700) temp directory. It is kept
 * after the process exits; spilled text output goes to spillToPrivateTemp.
 */
export function saveToPrivateTemp(data: Buffer, baseName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-"));
  const file = path.join(dir, baseName);
  fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
  return file;
}

// ---------- spill directory (text output cut by the cap) ----------
// Spill directories are named ${SPILL_DIR_PREFIX}<pid>-<random> in the OS temp
// folder; the prefix lives in upload-guard.ts, which refuses to upload from them.
export { SPILL_DIR_PREFIX };
/** Spill directories of dead processes older than this are removed at start-up (24 h). */
export const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let spillDir: string | null = null;

/** This process's spill directory, or null before the first spill (or after removeSpillDir). */
export function currentSpillDir(): string | null {
  return spillDir;
}

/**
 * The default saver of the output cap: writes into ONE private (0700)
 * directory per process, created on first use (again if something removed
 * it) and deleted by removeSpillDir() when the process exits. A name already
 * taken gets a counter: dom_query-output.json, dom_query-output-2.json, ...
 */
export function spillToPrivateTemp(data: Buffer, baseName: string): string {
  if (!spillDir || !fs.existsSync(spillDir)) {
    spillDir = fs.mkdtempSync(path.join(os.tmpdir(), `${SPILL_DIR_PREFIX}${process.pid}-`));
  }
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let n = 1; ; n++) {
    const file = path.join(spillDir, n === 1 ? baseName : `${stem}-${n}${ext}`);
    try {
      fs.writeFileSync(file, data, { flag: "wx", mode: 0o600 });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST" || n >= 100000) throw e;
    }
  }
}

/** Deletes this process's spill directory (shutdown and process exit). Never throws. */
export function removeSpillDir(): void {
  const dir = spillDir;
  spillDir = null;
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a locked file must not break the shutdown.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// Spill folders of the 0.3.5 development builds: a bare mkdtemp folder holding one <tool>-output file.
const LEGACY_SPILL_DIR_RE = /^browser-mcp-[A-Za-z0-9]{6}$/;
const LEGACY_SPILL_FILE_RE = /^[a-z][a-z0-9_]*-output\.(?:json|txt)$/;
const SPILL_DIR_RE = new RegExp(`^${SPILL_DIR_PREFIX}(\\d+)-[A-Za-z0-9]+$`);

export interface PruneSpillOptions {
  /** Folder to scan (default os.tmpdir()). */
  tmpdir?: string;
  /** Minimum age by modification time (default SPILL_MAX_AGE_MS). */
  maxAgeMs?: number;
  now?: number;
  /** Whether the process that owns a spill directory still runs (default: process.kill(pid, 0)). */
  isAlive?: (pid: number) => boolean;
}

/**
 * Start-up sweep of spill directories a crashed or killed process left
 * behind: browser-mcp-spill-<pid>-* folders older than maxAgeMs whose process
 * is gone, and folders of earlier development builds (browser-mcp-XXXXXX with
 * exactly one <tool>-output.json/.txt file) older than maxAgeMs. Artifact
 * folders (PDFs, recordings, traces) are left alone. Returns the removed
 * paths; never throws.
 */
export function pruneStaleSpillDirs(opts: PruneSpillOptions = {}): string[] {
  const root = opts.tmpdir ?? os.tmpdir();
  const maxAge = opts.maxAgeMs ?? SPILL_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? processAlive;
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const own = name.match(SPILL_DIR_RE);
    if (!own && !LEGACY_SPILL_DIR_RE.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < maxAge) continue;
      if (dir === spillDir) continue;
      if (own) {
        const pid = Number(own[1]);
        if (pid === process.pid || alive(pid)) continue;
      } else {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        if (entries.length !== 1 || !entries[0].isFile() || !LEGACY_SPILL_FILE_RE.test(entries[0].name)) continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Gone meanwhile or not ours to remove: skip it.
    }
  }
  return removed;
}

// ---------- files a tool reads back (session / cookie bundles) ----------
/** Largest bundle file session_state_load / cookies_import reads (64 MiB). */
export const INPUT_FILE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads and parses a JSON file the caller named (a bundle written by
 * session_state_save / cookies_export with savePath). The path must be
 * absolute, end in .json and be a regular file of at most maxBytes; like
 * dom_upload, dot-segments (.ssh, .aws ...) and key/credential file names
 * are refused, in the given and in the resolved path. Errors never quote
 * the file's content.
 */
export function readJsonInputFile(filePath: string, param: string, maxBytes = INPUT_FILE_MAX_BYTES): unknown {
  const platform = process.platform;
  if (!isStrictAbsolute(filePath, platform)) throw new Error(`${param} must be an absolute path (got "${filePath}")`);
  if (path.extname(filePath).toLowerCase() !== ".json") throw new Error(`${param} must name a .json file (got "${filePath}")`);
  const checkName = (p: string) => {
    const hidden = hiddenSegment(p, platform);
    if (hidden) throw new Error(`${param} is refused: "${p}" contains the dot-segment "${hidden}" (dot-files and dot-directories are never read)`);
    const secret = secretNameRule(path.basename(p));
    if (secret) throw new Error(`${param} is refused: "${p}" has a key/credential file name (${secret})`);
  };
  checkName(filePath);
  let real: string;
  try {
    real = fs.realpathSync.native(filePath);
  } catch (e) {
    throw new Error(`${param}: cannot open "${filePath}" (${(e as NodeJS.ErrnoException)?.code || errMessage(e)})`);
  }
  if (real !== filePath) checkName(real);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`${param}: "${filePath}" is not a regular file`);
  if (st.size > maxBytes) throw new Error(`${param}: "${filePath}" has ${st.size} bytes, over the ${maxBytes}-byte limit`);
  const text = fs.readFileSync(real, "utf8");
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error(`${param}: "${filePath}" is not valid JSON`);
  }
}

/**
 * The text a result would take inline, for tools that must not be cut
 * (re-importable bundles): they check it against the cap before returning.
 */
export function inlineLength(result: CallToolResult): number {
  let n = 0;
  for (const part of result.content) if (isTextPart(part)) n += part.text.length;
  return n;
}

// ---------- bridge state helpers ----------
/**
 * Local event buffers are only a fallback: they must honour the last known
 * popup switches (the extension stops capturing when they are off) and must
 * never pass for fresh extension data.
 */
export function assertNotKnownDisabled(bridge: IBridge, action: string): void {
  if (bridge.knownDisabled()?.includes(action)) throw permissionDeniedError(action);
}

export function bufferFallbackWarning(e: unknown): string {
  return `Extension unreachable (${errMessage(e)}). Showing events buffered by this MCP server process; they may be incomplete or stale.`;
}

/**
 * Current disabled-action list for gating decisions. Asks the extension when
 * it is connected (bounded to `timeoutMs`, so a frozen browser cannot stall
 * the caller) and falls back to the last snapshot the bridge has seen.
 */
export async function currentDisabledActions(bridge: IBridge, timeoutMs = 3000): Promise<string[] | null> {
  if (bridge.connected) {
    try {
      const perms = await withTimeout(
        bridge.send<{ disabled?: string[] }>("perm_list", {}, undefined, timeoutMs),
        timeoutMs,
        `perm_list timed out after ${timeoutMs}ms`
      );
      if (Array.isArray(perms?.disabled)) return perms.disabled;
    } catch {
      /* fall back to the cached snapshot */
    }
  }
  return bridge.knownDisabled();
}

export function bridgeStatusSnapshot(bridge: IBridge): Record<string, unknown> {
  return {
    connected: bridge.connected,
    wsPort: bridge.port,
    consoleBuffered: bridge.consoleEvents.length,
    networkBuffered: bridge.networkEvents.length,
    // Last permission snapshot reported by the extension (null = unknown yet).
    disabledActions: bridge.knownDisabled(),
    ...bridge.status(),
  };
}
