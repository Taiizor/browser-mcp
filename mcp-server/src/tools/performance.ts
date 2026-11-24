// Page performance measurement (permission category "performance").
import { z } from "zod";
import {
  DESTRUCTIVE,
  errMessage,
  PAGE_INTERACT,
  READ_PAGE,
  saveToPrivateTemp,
  STATE_CHANGE,
  TabId,
  textResult,
  type ToolKit,
} from "../tool-kit.js";
import { checkSavePath, writeOutputFile } from "./media.js";

type TraceStopResult = {
  tabId?: number;
  traceId?: string;
  size?: number;
  chunks?: number;
  summary?: unknown;
  [key: string]: unknown;
};

// A sanity bound against a confused extension, far above any real trace.
const MAX_TRACE_CHUNKS = 100000;

/**
 * Trace category names the extension accepts (PERF_TRACE_CATEGORY_RE and the
 * 64-name limit in extension/background.js bg2cTraceStart; keep in sync): a
 * leading "-" excludes a category.
 */
export const PERF_TRACE_CATEGORY_RE = /^-?[\w.:*()-]{1,200}$/;
export const PERF_TRACE_MAX_CATEGORIES = 64;

/**
 * Fields of the extension's perf_trace_stop result that mark an incomplete
 * trace: dataLossOccurred (Chrome's trace buffer filled up), droppedEvents and
 * truncated (events past the extension's size limit were dropped). They are
 * passed on so the caller knows the file and summary miss part of the run.
 */
export const TRACE_INCOMPLETE_FIELDS = ["dataLossOccurred", "droppedEvents", "truncated"] as const;

export function registerPerformanceTools(kit: ToolKit): void {
  kit.define({
    name: "page_metrics",
    title: "Performance metrics",
    description: "Blink performance metrics: JS heap, layout counts, FPS-related timings.",
    category: "performance",
    inputSchema: { tabId: TabId },
    annotations: READ_PAGE,
    handler: async ({ tabId }, ctx) => {
      const r = await ctx.send("page_metrics", {}, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "perf_web_vitals",
    title: "Measure Web Vitals",
    description:
      "Web Vitals of the tab's current page from buffered PerformanceObservers: lcp, fcp, inp, ttfb (ms), cls (unitless), " +
      "longTasks {count, totalMs} and navigation {domContentLoaded, load}. reload:true reloads the tab first and measures the fresh load " +
      "(unsaved page state is lost); waitMs keeps observing that long before reporting. A metric the page has not produced yet " +
      "(inp needs a user interaction) is reported empty. Combine with emulation_cpu / network_throttle for slow-device numbers.",
    category: "performance",
    inputSchema: {
      waitMs: z.number().int().nonnegative().max(30000).optional().describe("Keep observing this long before reporting, in ms (default 0, max 30000)"),
      reload: z.boolean().optional().describe("Reload the tab first and measure the new page load (default false)"),
      tabId: TabId,
    },
    // Static hints must hold for every call: reload:true changes the page,
    // so this is not read-only even though the default call only observes.
    annotations: PAGE_INTERACT,
    handler: async ({ waitMs, reload, tabId }, ctx) => {
      const timeoutMs = 30000 + (waitMs ?? 0) + (reload ? 30000 : 0);
      const r = await ctx.send("perf_web_vitals", { waitMs, reload }, tabId, timeoutMs);
      return textResult(r);
    },
  });

  kit.define({
    name: "perf_trace_start",
    title: "Start performance trace",
    description:
      "Start a Chrome performance trace of the tab via CDP (the debugger stays attached until perf_trace_stop). " +
      "Reproduce the slow interaction or load, then call perf_trace_stop to save the trace and get a summary.",
    category: "performance",
    inputSchema: {
      categories: z
        .array(z.string().regex(PERF_TRACE_CATEGORY_RE, "a trace category name: letters, digits, _ . : * ( ) -, at most 200 chars"))
        .min(1)
        .max(PERF_TRACE_MAX_CATEGORIES)
        .optional()
        .describe(
          "Trace categories (e.g. devtools.timeline, v8.execute; a leading - excludes one, at least one must be included; " +
            `max ${PERF_TRACE_MAX_CATEGORIES}). Omit for the extension's default set.`
        ),
      screenshots: z.boolean().optional().describe("Also record filmstrip screenshots (much larger trace; default false)"),
      tabId: TabId,
    },
    annotations: STATE_CHANGE,
    handler: async ({ categories, screenshots, tabId }, ctx) => {
      const r = await ctx.send("perf_trace_start", { categories, screenshots }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "perf_trace_stop",
    title: "Stop performance trace",
    description:
      "Stop the tab's performance trace and save it as a .json file (open it in Chrome DevTools > Performance > Load profile, or ui.perfetto.dev). " +
      "Returns the file path, its size and a summary: durationMs, eventCount, the 10 longest main-thread tasks and mainThreadBusyMs. " +
      "Without savePath the trace goes to a private temp folder. An incomplete trace (Chrome's buffer filled up, or events were dropped) " +
      "is flagged with dataLossOccurred / droppedEvents / truncated and a note.",
    category: "performance",
    inputSchema: {
      tabId: TabId,
      savePath: z.string().optional().describe("Absolute .json path to write the trace to. Omit to save it in a private temp folder."),
      overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
    },
    annotations: DESTRUCTIVE,
    handler: async ({ tabId, savePath, overwrite }, ctx) => {
      // Validate before stopping: a bad path must not cost the trace.
      const target = savePath ? checkSavePath(savePath, [".json"], overwrite === true) : null;
      const res = await ctx.send<TraceStopResult>("perf_trace_stop", {}, tabId, 120000);
      const chunks = res?.chunks;
      if (!res || typeof res.traceId !== "string" || typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 0) {
        return textResult(res ?? { ok: false, error: "Empty response from perf_trace_stop" });
      }
      if (chunks > MAX_TRACE_CHUNKS) throw new Error(`perf_trace_stop reported ${chunks} chunks (more than ${MAX_TRACE_CHUNKS})`);
      const traceTabId = typeof res.tabId === "number" ? res.tabId : tabId;
      // The chunk reads go through ctx.send, so a cancelled call stops reading.
      // A partial read leaks nothing lasting: tracing has already ended in the
      // extension, and it drops unread trace data by itself after 5 minutes.
      // (Cleanup that must survive a cancel would use ctx.bridge.send instead.)
      const parts: string[] = [];
      for (let index = 0; index < chunks; index++) {
        ctx.extra.signal.throwIfAborted();
        const c = await ctx.send<{ data?: unknown }>("perf_trace_chunk", { traceId: res.traceId, index }, undefined, 60000);
        if (typeof c?.data !== "string") throw new Error(`perf_trace_chunk ${index + 1} of ${chunks} returned no data`);
        parts.push(c.data);
      }
      const json = parts.join("");
      if (!json) return textResult({ ok: false, tabId: traceTabId, summary: res.summary, error: "The trace is empty; nothing was saved." });
      const buffer = Buffer.from(json, "utf8");
      const out: Record<string, unknown> = { ok: true, tabId: traceTabId, path: "", size: buffer.length, chunks, summary: res.summary };
      for (const k of TRACE_INCOMPLETE_FIELDS) if (res[k] !== undefined) out[k] = res[k];
      if (res.dataLossOccurred === true || res.truncated === true || (typeof res.droppedEvents === "number" && res.droppedEvents > 0)) {
        out.note = "The trace is incomplete (Chrome's trace buffer filled up or events were dropped): record a shorter trace or fewer categories.";
      }
      if (typeof res.size === "number" && res.size !== json.length && res.size !== buffer.length) {
        out.warning = `The extension reported ${res.size} bytes but ${buffer.length} arrived; the trace may be incomplete.`;
      }
      const fileName = `trace-${traceTabId ?? "tab"}-${Date.now()}.json`;
      if (target) {
        try {
          writeOutputFile(target.file, buffer, target.overwrite);
          out.path = target.file;
          return textResult(out);
        } catch (e) {
          // The trace is gone from the browser once read: keep it somewhere.
          out.saveError = `Could not write ${target.file}: ${errMessage(e)}. Saved to a private temp file instead.`;
        }
      }
      out.path = saveToPrivateTemp(buffer, fileName);
      return textResult(out);
    },
  });
}
