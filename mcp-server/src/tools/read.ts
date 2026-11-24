// Page reading: snapshot, HTML / text, element queries, waits (permission category "read").
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { limitParam, PAGE_INTERACT, READ_PAGE, SelectorDesc, TabId, textResult, type ToolKit } from "../tool-kit.js";

// page_html / page_text read one window of the page at a time (content.js pageSlice).
const PAGE_WINDOW_DEFAULT = 40000;
const PAGE_WINDOW_MAX = 500000;
// Room for the metadata block next to the window inside the output cap.
const PAGE_META_RESERVE = 256;
/**
 * The window to request. It always fits the kit's output cap together with
 * the metadata block: a window cut by the cap would report a nextOffset past
 * text the caller never saw.
 */
function pageWindowSize(kit: Pick<ToolKit, "maxOutputChars">, maxChars: number | undefined): { maxChars: number; limited: boolean } {
  const fit = Math.max(1, kit.maxOutputChars - PAGE_META_RESERVE);
  const want = maxChars ?? PAGE_WINDOW_DEFAULT;
  return want > fit ? { maxChars: fit, limited: maxChars !== undefined } : { maxChars: want, limited: false };
}

/** The window size used without maxChars: PAGE_WINDOW_DEFAULT, or less so it fits the output cap. */
export function defaultPageWindow(kit: Pick<ToolKit, "maxOutputChars">): number {
  return pageWindowSize(kit, undefined).maxChars;
}

/** offset / maxChars of page_html and page_text; the documented default is this kit's real one. */
function pageWindowShape(kit: ToolKit) {
  return {
    offset: z.number().int().nonnegative().optional().describe("Start index in characters (default 0); pass nextOffset from the previous call to continue"),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(PAGE_WINDOW_MAX)
      .optional()
      .describe(`Window size in characters (default ${defaultPageWindow(kit)}, max ${PAGE_WINDOW_MAX}; never more than the server's output cap allows)`),
  };
}

/** One window of a longer text, in the shape content.js pageSlice() returns. */
export interface TextWindow {
  text: string;
  offset: number;
  length: number;
  totalLength: number;
  truncated: boolean;
  nextOffset: number | null;
}

/**
 * One window of a page_snapshot tree, cut at line boundaries so no element
 * line (and no ref) is ever split: the window ends after the last "\n" that
 * fits in maxChars (only a single line longer than maxChars is cut inside,
 * never between a surrogate pair). An offset inside a line that fits a window
 * (the page changed between two calls) moves back to the start of that line;
 * inside a longer line it is the continuation of a cut and stays. The windows
 * of one tree joined in order give the tree.
 */
export function snapshotWindow(full: string, offset: number | undefined, maxChars: number): TextWindow {
  const total = full.length;
  const max = Math.max(1, Math.floor(maxChars));
  let start = Math.min(Math.max(0, Math.floor(offset ?? 0)), total);
  if (start > 0 && start < total && full[start - 1] !== "\n") {
    const lineStart = full.lastIndexOf("\n", start - 1) + 1;
    const nl = full.indexOf("\n", start);
    const lineEnd = nl < 0 ? total : nl + 1;
    if (lineEnd - lineStart <= max) start = lineStart;
  }
  let end = Math.min(total, start + max);
  if (end < total) {
    const nl = full.lastIndexOf("\n", end - 1);
    if (nl >= start) end = nl + 1;
    else if (end - 1 > start) {
      const c = full.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end--;
    }
  }
  const text = full.slice(start, end);
  const more = end < total;
  return { text, offset: start, length: text.length, totalLength: total, truncated: more, nextOffset: more ? end : null };
}

/**
 * One page window: the paging metadata as a small JSON block, then the text
 * itself as a plain block. Pasting HTML into a JSON string would escape every
 * quote and line break, inflating the window and the tokens it costs.
 */
function pageWindowResult(r: unknown, limitedTo: number | null): CallToolResult {
  if (!r || typeof r !== "object" || typeof (r as { text?: unknown }).text !== "string") return textResult(r);
  const { text, ...meta } = r as { text: string; [key: string]: unknown };
  if (limitedTo !== null) meta.note = `window limited to ${limitedTo} chars by the output cap`;
  return {
    content: [
      { type: "text", text: JSON.stringify(meta) },
      { type: "text", text },
    ],
  };
}

export function registerReadTools(kit: ToolKit): void {
  kit.define({
    name: "page_snapshot",
    title: "Page snapshot",
    description:
      "Element tree with refs (e.g. [ref=e473012]; pass e473012 as a selector). Start here before interacting; refs expire on navigation. " +
      "Lines show tag, key attributes, short text and live state: value= (typed input/textarea value; current= when it differs from the value attribute), " +
      "filled=true|false (passwords, value never shown), checked[=mixed], selected= (chosen options) or selected, options= (a select's choices), disabled, readonly, required, " +
      "expanded=, pressed=, value= on sliders/spinbuttons, contenteditable, (hidden). iframes are (frame) markers: read them with frame_list + frame_focus (toolset tabs). " +
      `A long tree comes in windows of whole lines (default ${defaultPageWindow(kit)} chars): the first block gives offset, length, totalLength, truncated and nextOffset; ` +
      "call again with offset=nextOffset for the next lines (refs stay the same across calls).",
    category: "read",
    inputSchema: {
      tabId: TabId,
      compact: z
        .boolean()
        .optional()
        .describe("true (default): interactive elements, ARIA widgets, editable hosts, iframes, forms and h1-h3 (max 400 lines); false: also text blocks and containers (max 1000)"),
      ...pageWindowShape(kit),
    },
    annotations: READ_PAGE,
    handler: async ({ tabId, compact, offset, maxChars }, ctx) => {
      // The extension returns the whole tree ({tabId, text}); it is windowed
      // here, at line boundaries, so it always fits the output cap.
      const win = pageWindowSize(kit, maxChars);
      const r = await ctx.send<{ tabId?: number; text?: unknown }>("page_snapshot", { compact: compact ?? true }, tabId);
      if (!r || typeof r !== "object" || typeof r.text !== "string") return textResult(r);
      const { text: tree, ...rest } = r;
      return pageWindowResult({ ...rest, ...snapshotWindow(tree, offset, win.maxChars) }, win.limited ? win.maxChars : null);
    },
  });

  kit.define({
    name: "page_html",
    title: "Page HTML",
    description:
      `Page HTML source (documentElement.outerHTML), one window at a time: at most maxChars characters (default ${defaultPageWindow(kit)}) starting at offset. ` +
      "The first block gives offset, length, totalLength, truncated and nextOffset (null at the end); call again with offset=nextOffset for the rest. Prefer page_snapshot for structure.",
    category: "read",
    inputSchema: { tabId: TabId, ...pageWindowShape(kit) },
    annotations: READ_PAGE,
    handler: async ({ tabId, offset, maxChars }, ctx) => {
      const win = pageWindowSize(kit, maxChars);
      const r = await ctx.send("page_html", { offset, maxChars: win.maxChars }, tabId, 60000);
      return pageWindowResult(r, win.limited ? win.maxChars : null);
    },
  });

  kit.define({
    name: "page_text",
    title: "Page text",
    description:
      `Visible page text (innerText), one window at a time: at most maxChars characters (default ${defaultPageWindow(kit)}) starting at offset. ` +
      "The first block gives offset, length, totalLength, truncated and nextOffset (null at the end); call again with offset=nextOffset for the rest. Best for reading content.",
    category: "read",
    inputSchema: { tabId: TabId, ...pageWindowShape(kit) },
    annotations: READ_PAGE,
    handler: async ({ tabId, offset, maxChars }, ctx) => {
      const win = pageWindowSize(kit, maxChars);
      const r = await ctx.send("page_text", { offset, maxChars: win.maxChars }, tabId);
      return pageWindowResult(r, win.limited ? win.maxChars : null);
    },
  });

  kit.define({
    name: "dom_query",
    title: "Query elements",
    description:
      "Find elements by CSS/XPath/text/ref. Returns {total, returned, items:[{ref, tag, text, x, y, w, h}]}: total counts every match, items holds the first limit of them " +
      "(text is whitespace-normalised, at most 200 chars; x/y/w/h in viewport px). Use the refs as selectors for clicks and typing.",
    category: "read",
    inputSchema: {
      selector: z.string().describe(SelectorDesc),
      limit: limitParam(500, "Max items returned (default 20, max 500)"),
      tabId: TabId,
    },
    annotations: READ_PAGE,
    handler: async ({ selector, limit, tabId }, ctx) => {
      const r = await ctx.send("dom_query", { selector, limit }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "page_find",
    title: "Find text on page",
    description: "Search page text (case-insensitive) and scroll the first match into view.",
    category: "read",
    inputSchema: { text: z.string().describe("Text to find"), tabId: TabId },
    annotations: PAGE_INTERACT,
    handler: async ({ text, tabId }, ctx) => {
      const r = await ctx.send("page_find", { text }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "page_wait",
    title: "Wait for page",
    description:
      "Wait until every given condition holds: an element (selector), page text, URL substring/pattern, readyState, and/or network idle " +
      "(networkIdle: at most maxInflight requests in flight for idleMs, e.g. after a click that loads data). With no condition it just waits timeoutMs. " +
      "Fails with a timeout error after timeoutMs (default 15000).",
    category: "read",
    inputSchema: {
      selector: z.string().optional().describe("Selector to wait for; omit for duration only"),
      timeoutMs: z.number().int().positive().max(600000).optional().describe("Maximum wait time in ms (default 15000, max 600000)"),
      text: z.string().optional().describe("Page text to wait for"),
      url: z.string().optional().describe("URL substring to wait for (e.g. after redirects)"),
      urlPattern: z.string().optional().describe("URL regex pattern to wait for"),
      readyState: z.enum(["interactive", "complete"]).optional().describe("Wait for document readyState ('interactive' or 'complete')"),
      networkIdle: z
        .boolean()
        .optional()
        .describe("Wait for the tab's network to go quiet (requests tracked by the extension; default true when idleMs or maxInflight is given)"),
      idleMs: z.number().int().nonnegative().max(600000).optional().describe("networkIdle: how long the network must stay quiet, in ms (default 500)"),
      maxInflight: z
        .number()
        .int()
        .nonnegative()
        .max(1000)
        .optional()
        .describe("networkIdle: requests that may still be in flight (default 0; 2 tolerates long-polling and analytics)"),
      tabId: TabId,
    },
    annotations: READ_PAGE,
    handler: async (args, ctx) => {
      const { tabId, ...payload } = args;
      // idleMs / maxInflight only mean something for a network-idle wait.
      if (payload.networkIdle === undefined && (payload.idleMs !== undefined || payload.maxInflight !== undefined)) payload.networkIdle = true;
      // `||` matches the extension, which also treats a falsy timeout as the default.
      const waitMs = payload.timeoutMs || 15000;
      if (payload.networkIdle && (payload.idleMs ?? 500) >= waitMs) {
        throw new Error(`idleMs (${payload.idleMs ?? 500}) must be shorter than timeoutMs (${waitMs}), or the network can never count as idle in time`);
      }
      // Every condition, network idle included, is bounded by timeoutMs in the
      // extension; the extra 5 s only covers the round trip.
      const r = await ctx.send("page_wait", payload, tabId, waitMs + 5000);
      return textResult(r);
    },
  });

  kit.define({
    name: "page_axtree",
    title: "Accessibility tree",
    description:
      "Accessibility tree nodes (roles, names, values) for accessibility audits. Returns {count, truncated, nodes}; maxNodes caps the nodes (default 800) and depth limits how deep the tree is read.",
    category: "read",
    inputSchema: {
      tabId: TabId,
      maxNodes: limitParam(5000, "Max nodes returned (default 800, max 5000); truncated:true when cut"),
      depth: z.number().int().positive().max(1000).optional().describe("Read only the top N levels of the tree (default: all)"),
    },
    annotations: READ_PAGE,
    handler: async ({ tabId, maxNodes, depth }, ctx) => {
      const r = await ctx.send("page_axtree", { maxNodes, depth }, tabId, 60000);
      return textResult(r);
    },
  });
}
