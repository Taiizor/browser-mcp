// Recently closed tabs and session state bundles (permission category "sessions").
import { z } from "zod";
import {
  DESTRUCTIVE_IDEMPOTENT,
  inlineLength,
  limitParam,
  NAVIGATE,
  READ_ONLY,
  readJsonInputFile,
  TabId,
  textResult,
  type ToolKit,
} from "../tool-kit.js";
import { checkSavePath, writeOutputFile } from "./media.js";

type SavedState = {
  url?: unknown;
  origin?: unknown;
  cookies?: unknown;
  localStorage?: unknown;
  sessionStorage?: unknown;
  [key: string]: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What a saved state holds, without any value (for results that must not echo credentials). */
function stateSummary(state: SavedState): Record<string, unknown> {
  return {
    url: typeof state.url === "string" ? state.url : undefined,
    origin: typeof state.origin === "string" ? state.origin : undefined,
    cookies: Array.isArray(state.cookies) ? state.cookies.length : 0,
    localStorageKeys: isObject(state.localStorage) ? Object.keys(state.localStorage).length : 0,
    sessionStorageKeys: isObject(state.sessionStorage) ? Object.keys(state.sessionStorage).length : 0,
  };
}

/**
 * The state object in a session_state_save file: the bundle itself (what
 * savePath writes) or the tool's inline result {ok, state} pasted to a file.
 */
export function stateFromFile(parsed: unknown, param: string): Record<string, unknown> {
  if (isObject(parsed) && isObject(parsed.state) && !("url" in parsed) && !("cookies" in parsed)) return parsed.state;
  if (isObject(parsed)) return parsed;
  throw new Error(`${param} must hold a session state object (written by session_state_save with savePath)`);
}

export function registerSessionTools(kit: ToolKit): void {
  kit.define({
    name: "sessions_recently_closed",
    title: "Recently closed tabs",
    description: "List recently closed tabs and windows",
    category: "sessions",
    inputSchema: {
      maxResults: limitParam(25, "Maximum number of entries to return (default 25, max 25)"),
    },
    annotations: READ_ONLY,
    capHint: "lower maxResults to get fewer entries",
    handler: async ({ maxResults }, ctx) => {
      const r = await ctx.send("sessions_recently_closed", { maxResults });
      return textResult(r);
    },
  });

  kit.define({
    name: "sessions_restore",
    title: "Restore closed tab",
    description: "Restore a recently closed tab or window by its session ID (or the most recent if omitted)",
    category: "sessions",
    inputSchema: {
      sessionId: z.string().optional().describe("Session ID from sessions_recently_closed. Omit for the most recently closed."),
    },
    annotations: NAVIGATE,
    handler: async ({ sessionId }, ctx) => {
      const r = await ctx.send("sessions_restore", { sessionId });
      return textResult(r);
    },
  });

  kit.define({
    name: "session_state_save",
    title: "Save session state",
    description:
      "Capture an entire session profile (cookies + localStorage + sessionStorage) of the tab's site. " +
      "With savePath the complete bundle is written to that .json file and only a summary is returned (restore it with session_state_load {filePath}); " +
      "without it the bundle is returned inline, and a bundle too large for the output cap is refused (never cut): pass savePath then.",
    category: "sessions",
    inputSchema: {
      tabId: TabId,
      savePath: z
        .string()
        .optional()
        .describe("Absolute .json path to write the complete bundle to (it holds session cookies: keep it private). An existing file is only replaced with overwrite:true."),
      overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
    },
    // The browser is only read, but savePath writes a file (overwrite:true replaces one).
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ tabId, savePath, overwrite }, ctx) => {
      // Validate before reading: a bad path must not cost a round trip.
      const target = savePath ? checkSavePath(savePath, [".json"], overwrite === true) : null;
      const r = await ctx.send<{ ok?: boolean; state?: SavedState; [key: string]: unknown }>("session_state_save", {}, tabId);
      const state = isObject(r?.state) ? (r.state as SavedState) : null;
      if (target) {
        if (!state) return textResult(r);
        const data = Buffer.from(JSON.stringify(state), "utf8");
        writeOutputFile(target.file, data, target.overwrite, 0o600);
        return textResult({ ok: true, savedTo: target.file, sizeBytes: data.length, ...stateSummary(state), restoreWith: "session_state_load {\"filePath\": savedTo}" });
      }
      const out = textResult(r);
      const size = inlineLength(out);
      if (size > kit.maxOutputChars) {
        throw new Error(
          `session_state_save: the bundle has ${size} chars, more than the ${kit.maxOutputChars}-char output cap. It holds cookies and storage, so it is neither cut ` +
            "nor written to disk behind your back: call session_state_save again with savePath (an absolute .json path), then restore it with session_state_load {\"filePath\": ...}."
        );
      }
      return out;
    },
  });

  kit.define({
    name: "session_state_load",
    title: "Load session state",
    description:
      "Restore an entire session profile (cookies + localStorage + sessionStorage) from a saved bundle: the state object from session_state_save, " +
      "or filePath of a bundle written with savePath (exactly one of the two). Storage is only written when the tab shows the bundle's origin.",
    category: "sessions",
    inputSchema: {
      state: z.record(z.string(), z.unknown()).optional().describe("Saved session state object from session_state_save"),
      filePath: z.string().optional().describe("Absolute path of a .json bundle written by session_state_save with savePath"),
      tabId: TabId,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: async ({ state, filePath, tabId }, ctx) => {
      if ((state === undefined) === (filePath === undefined)) {
        throw new Error("session_state_load needs exactly one of state (the bundle object) or filePath (a bundle saved with savePath)");
      }
      const bundle = filePath !== undefined ? stateFromFile(readJsonInputFile(filePath, "filePath"), "filePath") : state;
      const r = await ctx.send("session_state_load", { state: bundle }, tabId);
      return textResult(r);
    },
  });
}
