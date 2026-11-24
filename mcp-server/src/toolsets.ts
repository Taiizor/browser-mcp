// Toolsets: named groups of tools that decide what tools/list shows, plus the
// rule that hides tools whose extension actions are switched off in the popup.
// Pure logic (no SDK, bridge or environment access): ToolKit applies it to the
// registered tools, createServer resolves the start-up selection.

/**
 * Tool categories. Each is the permission category (PERM_CATS id in
 * extension/background.js) of the extension action the tool runs, so a
 * category can be matched against the popup switches; "meta" marks tools that
 * never reach a switchable extension action (bridge status, launch,
 * permission list, toolsets). Every category is also a toolset id.
 */
export const TOOL_CATEGORIES = [
  "meta",
  "tabs",
  "read",
  "interact",
  "media",
  "console",
  "network",
  "mock",
  "downloads",
  "bookmarks",
  "cookies",
  "storage",
  "sessions",
  "dialogs",
  "power",
  "trusted",
  "clipboard",
  "browsing_data",
  "notifications",
  "system",
  "emulation",
  "performance",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Selectable toolsets: the curated core set, every tool, or one category. */
export const TOOLSET_IDS = ["core", "all", ...TOOL_CATEGORIES] as const;
export type ToolsetId = (typeof TOOLSET_IDS)[number];

/** Used when neither --toolsets nor BROWSER_MCP_TOOLSETS selects anything valid. */
export const DEFAULT_TOOLSETS: readonly ToolsetId[] = ["core"];

/**
 * The "core" toolset: what most browsing tasks need, small enough that the
 * tool list does not crowd the model's context. Everything else is one
 * browser_toolsets call away. Meta tools are listed regardless.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "browser_status",
  "browser_toolsets",
  "tab_list",
  "tab_create",
  "tab_close",
  "tab_activate",
  "tab_navigate",
  "tab_reload",
  "tab_back",
  "tab_forward",
  "page_snapshot",
  "page_text",
  "page_html",
  "dom_query",
  "page_find",
  "page_wait",
  "dom_click",
  "dom_type",
  "dom_fill",
  "dom_select",
  "dom_check",
  "dom_hover",
  "dom_scroll",
  "keyboard_press",
  "dom_upload",
  "page_screenshot",
  "console_get",
  "dialog_policy",
]);

/** One-line summaries for browser_toolsets (category titles follow the popup). */
export const TOOLSET_TITLES: Readonly<Record<ToolsetId, string>> = {
  core: "Curated everyday set: tabs, navigation, page reading, DOM input, screenshot, console, dialogs",
  all: "Every tool",
  meta: "Bridge status, browser launch, permission switches, toolsets (always listed)",
  tabs: "Tabs, windows, frames, tab groups, closing the browser",
  read: "Page: read (snapshot, text, HTML, queries, find, wait, accessibility tree)",
  interact: "Page: interact (click, type, fill, select, hover, scroll, drag, keys, upload)",
  media: "Media (screenshot, PDF, tab audio)",
  console: "Console messages",
  network: "Network: observe (requests, response bodies, HAR, throttling, extra headers)",
  mock: "Network: intercept (mocked routes)",
  downloads: "Downloads",
  bookmarks: "Bookmarks",
  cookies: "Cookies (read, write, import, export)",
  storage: "Storage (localStorage, sessionStorage, IndexedDB)",
  sessions: "Sessions and saved page state",
  dialogs: "JavaScript dialogs (alert, confirm, prompt, beforeunload)",
  power: "Power: arbitrary JavaScript and raw CDP commands",
  trusted: "Trusted input through CDP (real mouse and keyboard events)",
  clipboard: "Clipboard",
  browsing_data: "Clearing browsing data",
  notifications: "Desktop notifications",
  system: "System: history, site permissions",
  emulation: "Emulation: viewport, color scheme and media, CPU, geolocation",
  performance: "Performance: metrics, web vitals, traces",
};

const TOOLSET_ID_SET: ReadonlySet<string> = new Set(TOOLSET_IDS);

export function isToolsetId(v: string): v is ToolsetId {
  return TOOLSET_ID_SET.has(v);
}

/** "Browsing-Data" -> "browsing_data": ids are matched case-insensitively, "-" as "_". */
export function normalizeToolsetId(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Parses comma separated toolset ids (one string, or several, e.g. repeated
 * --toolsets flags). Known ids come back deduplicated in order; anything else
 * is returned in `unknown` (as written) for the caller to report.
 */
export function parseToolsets(input: string | readonly string[]): { ids: ToolsetId[]; unknown: string[] } {
  const ids: ToolsetId[] = [];
  const unknown: string[] = [];
  for (const list of typeof input === "string" ? [input] : input) {
    for (const part of list.split(",")) {
      const raw = part.trim();
      if (!raw) continue;
      const id = normalizeToolsetId(raw);
      if (isToolsetId(id)) {
        if (!ids.includes(id)) ids.push(id);
      } else if (!unknown.includes(raw)) {
        unknown.push(raw);
      }
    }
  }
  return { ids, unknown };
}

/**
 * Which toolsets are on. `include` holds the selected toolsets; `exclude`
 * holds categories switched off at runtime, which win over "core" and "all",
 * so "disable interact" hides dom_click even though core lists it.
 */
export interface ToolsetSelection {
  readonly include: ReadonlySet<ToolsetId>;
  readonly exclude: ReadonlySet<ToolCategory>;
}

export function selectionOf(ids: readonly ToolsetId[]): ToolsetSelection {
  return { include: new Set(ids), exclude: new Set() };
}

/** What the visibility rule needs to know about a tool. */
export interface ToolsetMember {
  readonly name: string;
  readonly category: ToolCategory;
  /** Extension actions the tool runs (popup switches it depends on). */
  readonly actions: readonly string[];
  /**
   * Other switches those actions need (the extension's REQUIRES, e.g.
   * har_export needs network_requests); switching one off hides the tool too.
   */
  readonly requires?: readonly string[];
}

/** Whether toolset `id` lists `tool` (membership only, ignoring the selection). */
export function toolsetHas(id: ToolsetId, tool: ToolsetMember): boolean {
  if (id === "all") return true;
  if (id === "core") return CORE_TOOLS.has(tool.name);
  return tool.category === id;
}

/** Whether the selection lists `tool`; meta tools always are. */
export function inSelection(tool: ToolsetMember, sel: ToolsetSelection): boolean {
  if (tool.category === "meta") return true;
  if (sel.exclude.has(tool.category)) return false;
  return sel.include.has("all") || sel.include.has(tool.category) || (sel.include.has("core") && CORE_TOOLS.has(tool.name));
}

/**
 * The tool's actions and required actions that the popup has switched off
 * (none when the snapshot is unknown).
 */
export function blockedActions(tool: ToolsetMember, disabled: ReadonlySet<string> | null): string[] {
  if (!disabled) return [];
  const out: string[] = [];
  for (const a of [...tool.actions, ...(tool.requires ?? [])]) if (disabled.has(a) && !out.includes(a)) out.push(a);
  return out;
}

/**
 * A tool is listed iff its toolset is selected and none of its actions or
 * required actions is switched off in the popup.
 */
export function isToolVisible(tool: ToolsetMember, sel: ToolsetSelection, disabled: ReadonlySet<string> | null): boolean {
  return inSelection(tool, sel) && blockedActions(tool, disabled).length === 0;
}

/**
 * The error text for a call to a tool that tools/list hides: it names the
 * cause and the fix. A popup switch comes first (only the user can undo it,
 * so the model must not retry); it keeps the "Permission disabled in
 * extension" prefix the extension itself uses. Otherwise the tool's toolset
 * is off, which browser_toolsets fixes. null when the tool is listed.
 */
export function hiddenToolMessage(tool: ToolsetMember, sel: ToolsetSelection, disabled: ReadonlySet<string> | null): string | null {
  const blocked = blockedActions(tool, disabled);
  const selected = inSelection(tool, sel);
  if (!blocked.length && selected) return null;
  const enable = `browser_toolsets {"enable":["${tool.category}"]}`;
  if (blocked.length) {
    const list = blocked.join(", ");
    const toolsetToo = selected ? "" : ` (its toolset "${tool.category}" is off as well: ${enable})`;
    return (
      `Permission disabled in extension: ${list} (enable it from the extension popup). ` +
      `Tool ${tool.name} is hidden from the tool list while ${blocked.length > 1 ? "these switches are" : "this switch is"} off${toolsetToo}; ` +
      "only the user can switch it back on, so ask the user instead of retrying."
    );
  }
  return sel.exclude.has(tool.category)
    ? `Tool ${tool.name} is not enabled: its toolset "${tool.category}" was disabled with browser_toolsets. Call ${enable} to list it again, then call ${tool.name} again.`
    : `Tool ${tool.name} is not enabled: it belongs to the "${tool.category}" toolset, which is off. Call ${enable} to list it, then call ${tool.name} again.`;
}

export interface ToolsetChange {
  enable?: readonly ToolsetId[];
  disable?: readonly ToolsetId[];
}

/**
 * Applies a runtime change. Enabling runs first, so {enable:["all"],
 * disable:["power"]} means every tool except power. Enabling a category lifts
 * its exclusion; enabling "all" lifts every exclusion. Disabling a category
 * excludes it (also from core / all); disabling "core" or "all" only drops
 * that selection. "meta" is always on and ignored here.
 */
export function changeSelection(sel: ToolsetSelection, change: ToolsetChange): ToolsetSelection {
  const include = new Set(sel.include);
  const exclude = new Set(sel.exclude);
  for (const id of change.enable ?? []) {
    if (id === "meta") continue;
    include.add(id);
    if (id === "all") exclude.clear();
    else if (id !== "core") exclude.delete(id);
  }
  for (const id of change.disable ?? []) {
    if (id === "meta") continue;
    include.delete(id);
    if (id !== "all" && id !== "core") exclude.add(id);
  }
  return { include, exclude };
}

export interface ToolsetInfo {
  id: ToolsetId;
  title: string;
  /** Selected (meta: always). A category can also be partly listed through core. */
  enabled: boolean;
  /** Tools in this toolset / how many of them tools/list shows right now. */
  tools: number;
  listed: number;
  /** Tool names (omitted for "all"). */
  names?: string[];
}

export interface ToolsetSummary {
  selection: { enabled: ToolsetId[]; excluded: ToolCategory[] };
  listedTools: number;
  totalTools: number;
  toolsets: ToolsetInfo[];
  /** Tools whose actions or required actions are switched off in the extension popup (hidden in every toolset). */
  hiddenByPermissions: { tool: string; actions: string[] }[];
  /** false: the extension has not reported its switches yet, so nothing is hidden for them. */
  permissionsKnown: boolean;
}

/** The browser_toolsets listing for `tools` under `sel` and the popup snapshot `disabled`. */
export function summarizeToolsets(
  tools: readonly ToolsetMember[],
  sel: ToolsetSelection,
  disabled: ReadonlySet<string> | null
): ToolsetSummary {
  const listed = new Set(tools.filter((t) => isToolVisible(t, sel, disabled)).map((t) => t.name));
  const toolsets = TOOLSET_IDS.map((id): ToolsetInfo => {
    const members = tools.filter((t) => toolsetHas(id, t));
    const enabled =
      id === "meta" ||
      (sel.include.has(id) && (id === "core" || id === "all" || !sel.exclude.has(id))) ||
      (id !== "core" && id !== "all" && sel.include.has("all") && !sel.exclude.has(id));
    const info: ToolsetInfo = {
      id,
      title: TOOLSET_TITLES[id],
      enabled,
      tools: members.length,
      listed: members.filter((t) => listed.has(t.name)).length,
    };
    if (id !== "all") info.names = members.map((t) => t.name);
    return info;
  });
  return {
    selection: { enabled: [...sel.include], excluded: [...sel.exclude] },
    listedTools: listed.size,
    totalTools: tools.length,
    toolsets,
    hiddenByPermissions: tools
      .map((t) => ({ tool: t.name, actions: blockedActions(t, disabled) }))
      .filter((h) => h.actions.length > 0),
    permissionsKnown: disabled !== null,
  };
}
