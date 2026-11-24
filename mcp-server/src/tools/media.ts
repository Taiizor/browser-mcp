// Screenshots, PDF rendering and tab audio recording (permission category "media").
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DESTRUCTIVE,
  errMessage,
  READ_PAGE,
  saveToPrivateTemp,
  STATE_CHANGE,
  TabId,
  textResult,
  type ToolExtra,
  type ToolKit,
} from "../tool-kit.js";

// ---------- binary results (PDF / audio) ----------
// Binary payloads are never pasted into the model context as base64 text:
// they are returned as typed MCP content blocks, written to savePath, or
// (when too large to return inline) written to a private temp file.
const INLINE_BINARY_MAX_BYTES = 10 * 1024 * 1024;

export type SaveTarget = { file: string; ext: string; overwrite: boolean };

/**
 * Validates a user-supplied output path before any work (recording, rendering) starts.
 * `overwrite === null` means the tool has no overwrite option.
 */
export function checkSavePath(savePath: string, allowedExts: readonly string[], overwrite: boolean | null): SaveTarget {
  if (!path.isAbsolute(savePath)) {
    throw new Error(`savePath must be an absolute path (got "${savePath}")`);
  }
  const file = path.resolve(savePath);
  const ext = path.extname(file).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new Error(`savePath must end with one of ${allowedExts.join(", ")} (got "${ext || "no extension"}")`);
  }
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(file);
  } catch {
    st = null;
  }
  if (st) {
    if (!st.isFile()) throw new Error(`savePath exists and is not a regular file: ${file}`);
    if (!overwrite) {
      throw new Error(`File already exists: ${file}. Choose another path${overwrite === null ? "" : " or pass overwrite:true"}.`);
    }
  }
  return { file, ext, overwrite: overwrite === true };
}

/**
 * Writes `data` to `file`; without `overwrite` an existing file is never
 * replaced (EEXIST). `mode` applies to a file this call creates (0o600 for
 * credential bundles; ignored on Windows).
 */
export function writeOutputFile(file: string, data: Buffer, overwrite: boolean, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { flag: overwrite ? "w" : "wx", ...(mode === undefined ? {} : { mode }) });
}

/** First free variant of `file` (adds a timestamp before the extension when taken). */
function freePath(file: string): string {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.${Date.now()}${ext}`;
}

function baseMimeType(mime: string | undefined, fallback: string): string {
  const base = String(mime ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]+$/.test(base) ? base : fallback;
}

// ---------- tab audio recording ----------
const AUDIO_EXTS = [".webm", ".ogg", ".opus", ".mp3", ".wav", ".m4a", ".aac", ".flac"] as const;
const AUDIO_SAVE_PATH_DESC = `Absolute file path to save the recording (${AUDIO_EXTS.join(" ")}; formats other than .webm need ffmpeg via FFMPEG_PATH or PATH). An existing file is only replaced with overwrite:true.`;

/** Regular file that the OS can execute (directories, .cmd shims and non-executables are rejected). */
function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates ffmpeg from the FFMPEG_PATH env var, PATH, or well-known install
 * locations. There is deliberately no per-call override: a tool argument must
 * never choose which executable this process spawns.
 */
function resolveFfmpeg(): { path: string } | { path: null; error: string } {
  const isWin = process.platform === "win32";
  let envNote = "";
  const envPath = process.env.FFMPEG_PATH?.trim();
  if (envPath) {
    if (isExecutableFile(envPath)) return { path: envPath };
    envNote = ` FFMPEG_PATH (${envPath}) is not an executable file and was ignored.`;
  }

  // Search system PATH (spawn without a shell can only run real executables).
  const exeName = isWin ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    const full = path.join(trimmed, exeName);
    if (isExecutableFile(full)) return { path: full };
  }

  // Standard OS package manager install paths
  const candidates = isWin
    ? ([
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
        process.env.USERPROFILE && path.join(process.env.USERPROFILE, "scoop", "shims", "ffmpeg.exe"),
        process.env.ProgramData && path.join(process.env.ProgramData, "chocolatey", "bin", "ffmpeg.exe"),
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
      ].filter(Boolean) as string[])
    : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/pkg/bin/ffmpeg"];
  for (const c of candidates) {
    if (isExecutableFile(c)) return { path: c };
  }

  return {
    path: null,
    error: `ffmpeg binary was not found in PATH or FFMPEG_PATH.${envNote} Install FFmpeg (e.g. winget install Gyan.FFmpeg / brew install ffmpeg) or set FFMPEG_PATH to enable audio format conversion.`,
  };
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {}
}

/**
 * Converts the recorded webm into `outputPath` (format from its extension).
 * ffmpeg writes to a temp file next to the target that is renamed on success,
 * so a failed conversion never leaves a partial file or clobbers the target.
 */
async function convertAudioFile(
  input: Buffer,
  outputPath: string,
  overwrite: boolean,
  durationMs?: number
): Promise<{ success: true } | { success: false; error: string }> {
  const ff = resolveFfmpeg();
  if (ff.path === null) return { success: false, error: ff.error };
  const ffmpegBin = ff.path;

  const ext = path.extname(outputPath).toLowerCase();
  const stamp = `${process.pid}-${Date.now()}`;
  const tempIn = `${outputPath}.${stamp}.in.webm`;
  const tempOut = `${outputPath}.${stamp}.tmp${ext}`;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(tempIn, input, { flag: "wx" });
  } catch (e) {
    unlinkQuiet(tempIn);
    return { success: false, error: `cannot write temp input: ${errMessage(e)}` };
  }

  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", tempIn, "-vn"];
  if (ext === ".mp3") args.push("-c:a", "libmp3lame", "-q:a", "2");
  args.push(tempOut);
  // Generous but bounded: conversion is much faster than real time.
  const killAfterMs = Math.min(30 * 60_000, 120_000 + Math.max(0, durationMs ?? 0));

  const run = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    let stderrTail = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      // stdin/stdout ignored, stderr drained (a full pipe would stall ffmpeg).
      proc = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: errMessage(e) });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, killAfterMs);
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    proc.on("error", (err) => finish({ ok: false, error: err.message }));
    proc.on("close", (code, signal) => {
      if (code === 0 && !timedOut) return finish({ ok: true });
      const why = timedOut
        ? `ffmpeg timed out after ${Math.round(killAfterMs / 1000)}s`
        : `ffmpeg exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`;
      const tail = stderrTail.trim().split(/\r?\n/).slice(-8).join(" | ").slice(-1000);
      finish({ ok: false, error: tail ? `${why}: ${tail}` : why });
    });
  });

  unlinkQuiet(tempIn);
  if (!run.ok) {
    unlinkQuiet(tempOut);
    return { success: false, error: run.error ?? "ffmpeg failed" };
  }
  try {
    if (fs.existsSync(outputPath)) {
      if (!overwrite) throw new Error(`${outputPath} was created by someone else meanwhile`);
      fs.unlinkSync(outputPath);
    }
    fs.renameSync(tempOut, outputPath);
    return { success: true };
  } catch (e) {
    unlinkQuiet(tempOut);
    return { success: false, error: errMessage(e) };
  }
}

type AudioStopResult = {
  ok?: boolean;
  tabId?: number;
  base64?: string;
  mimeType?: string;
  durationMs?: number;
  sizeBytes?: number;
  [key: string]: unknown;
};

/**
 * Shared tail of tab_audio_record_stop / tab_audio_capture: save to savePath
 * (converting with ffmpeg when needed) or return an MCP audio content block.
 * The recording is already released in the extension at this point, so every
 * failure path still persists the audio somewhere and reports where.
 */
async function finishRecording(res: AudioStopResult, target: SaveTarget | null): Promise<CallToolResult> {
  if (!res || typeof res.base64 !== "string" || !res.base64) {
    return textResult(res ?? { ok: false, error: "Empty response from tab_audio_record_stop" });
  }
  const buffer = Buffer.from(res.base64, "base64");
  const meta = { ok: true, tabId: res.tabId, durationMs: res.durationMs };
  const rescue = (why: string) => {
    const file = saveToPrivateTemp(buffer, `tab-${res.tabId ?? "audio"}-${Date.now()}.webm`);
    return textResult({ ...meta, sizeBytes: buffer.length, savedTo: file, format: "webm", saveError: why });
  };

  if (target) {
    if (target.ext === ".webm") {
      try {
        writeOutputFile(target.file, buffer, target.overwrite);
      } catch (e) {
        return rescue(`Could not write ${target.file}: ${errMessage(e)}. Saved to a private temp file instead.`);
      }
      return textResult({ ...meta, sizeBytes: buffer.length, savedTo: target.file, format: "webm" });
    }
    const conv = await convertAudioFile(buffer, target.file, target.overwrite, res.durationMs);
    if (conv.success) {
      return textResult({
        ...meta,
        sizeBytes: fs.statSync(target.file).size,
        savedTo: target.file,
        format: target.ext.slice(1),
      });
    }
    const fallback = freePath(`${target.file}.webm`);
    try {
      writeOutputFile(fallback, buffer, false);
    } catch (e) {
      return rescue(`Failed to convert to ${target.ext} (${conv.error}) and could not write ${fallback}: ${errMessage(e)}.`);
    }
    return textResult({
      ...meta,
      sizeBytes: buffer.length,
      savedTo: fallback,
      format: "webm",
      conversionWarning: `Failed to convert to ${target.ext}: ${conv.error}. Saved raw webm instead.`,
    });
  }

  if (buffer.length > INLINE_BINARY_MAX_BYTES) {
    const file = saveToPrivateTemp(buffer, `tab-${res.tabId ?? "audio"}-${Date.now()}.webm`);
    return textResult({
      ...meta,
      sizeBytes: buffer.length,
      mimeType: res.mimeType,
      savedTo: file,
      format: "webm",
      note: "Recording too large to return inline; saved to a private temp file. Pass savePath to choose the location.",
    });
  }
  return {
    content: [
      { type: "audio", data: res.base64, mimeType: baseMimeType(res.mimeType, "audio/webm") },
      {
        type: "text",
        text: JSON.stringify({ ...meta, sizeBytes: res.sizeBytes ?? buffer.length, mimeType: res.mimeType, note: "Audio returned as an MCP audio content block" }),
      },
    ],
  };
}

/**
 * Sleeps for `totalMs`, emitting MCP progress notifications when the client
 * asked for them, and resolves early (with `true`) when the request is cancelled.
 */
function waitWithProgress(totalMs: number, extra: ToolExtra): Promise<boolean> {
  const signal = extra.signal;
  const progressToken = extra._meta?.progressToken;
  const startedAt = Date.now();
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    let ticker: ReturnType<typeof setInterval> | undefined;
    const done = (aborted: boolean) => {
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    const onAbort = () => done(true);
    const timer = setTimeout(() => done(false), totalMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (progressToken !== undefined) {
      ticker = setInterval(() => {
        const elapsed = Math.min(Date.now() - startedAt, totalMs);
        extra
          .sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: elapsed,
              total: totalMs,
              message: `Recording ${Math.round(elapsed / 1000)}s / ${Math.round(totalMs / 1000)}s`,
            },
          })
          .catch(() => {});
      }, 5000);
    }
  });
}

export function registerMediaTools(kit: ToolKit): void {
  kit.define({
    name: "page_screenshot",
    title: "Screenshot",
    description: "Capture a screenshot of the visible viewport, full page, or a specific element as an image",
    category: "media",
    inputSchema: {
      tabId: TabId,
      fullPage: z.boolean().optional().describe("Whether to capture the entire scrollable page"),
      selector: z.string().optional().describe("Omit for viewport: CSS selector or ref of the element to capture"),
      scale: z.number().positive().max(2).optional().describe("Capture scale for element shots (default 1, max 2)"),
      maxHeight: z
        .number()
        .int()
        .min(256)
        .max(32768)
        .optional()
        .describe("fullPage only: maximum captured height in CSS px (default 16384). Taller pages are cut and reported with truncated:true."),
    },
    annotations: READ_PAGE,
    handler: async ({ tabId, fullPage, selector, scale, maxHeight }, ctx) => {
      const result = (await ctx.send("page_screenshot", { fullPage, selector, scale, maxHeight }, tabId, 60000)) as {
        dataUrl?: string;
        note?: string;
        [key: string]: unknown;
      };
      if (result.dataUrl && result.dataUrl.startsWith("data:image/")) {
        const { dataUrl, ...meta } = result;
        const parts = dataUrl.split(",");
        const mime = parts[0].match(/:(.*?);/)?.[1] || "image/png";
        const base64Data = parts[1];
        return {
          content: [
            {
              type: "image" as const,
              data: base64Data,
              mimeType: mime,
            },
            {
              type: "text" as const,
              // Extension metadata (e.g. truncated / captured height) rides along with the image.
              text: JSON.stringify({ tabId, ...meta, note: meta.note || "Screenshot captured successfully" }),
            },
          ],
        };
      }
      return textResult(result);
    },
  });

  kit.define({
    name: "page_pdf",
    title: "Save page as PDF",
    description: "Render the tab to PDF. Returned as an embedded application/pdf resource, or written to savePath. Slower; for visuals prefer page_screenshot.",
    category: "media",
    inputSchema: {
      tabId: TabId,
      savePath: z.string().optional().describe("Absolute .pdf path to write the file to (an existing file is never overwritten). Omit to return the PDF as an embedded resource."),
    },
    annotations: STATE_CHANGE,
    handler: async ({ tabId, savePath }, ctx) => {
      const target = savePath ? checkSavePath(savePath, [".pdf"], null) : null;
      const r = (await ctx.send("page_pdf", {}, tabId, 60000)) as {
        tabId?: number;
        dataBase64?: string;
        data?: string;
        [key: string]: unknown;
      };
      const base64 = typeof r?.dataBase64 === "string" ? r.dataBase64 : typeof r?.data === "string" ? r.data : null;
      if (!base64) return textResult(r);
      const pdfTabId = typeof r.tabId === "number" ? r.tabId : tabId;
      const buffer = Buffer.from(base64, "base64");
      if (target) {
        writeOutputFile(target.file, buffer, false);
        return textResult({ ok: true, tabId: pdfTabId, sizeBytes: buffer.length, savedTo: target.file, format: "pdf" });
      }
      const fileName = `tab-${pdfTabId ?? "active"}-${Date.now()}.pdf`;
      if (buffer.length > INLINE_BINARY_MAX_BYTES) {
        const file = saveToPrivateTemp(buffer, fileName);
        return textResult({
          ok: true,
          tabId: pdfTabId,
          sizeBytes: buffer.length,
          savedTo: file,
          format: "pdf",
          note: "PDF too large to return inline; saved to a private temp file. Pass savePath to choose the location.",
        });
      }
      const result: CallToolResult = {
        content: [
          {
            type: "resource",
            resource: { uri: `browser://pdf/${fileName}`, mimeType: "application/pdf", blob: base64 },
          },
          {
            type: "text",
            text: JSON.stringify({ ok: true, tabId: pdfTabId, sizeBytes: buffer.length, mimeType: "application/pdf", note: "PDF returned as an embedded resource" }),
          },
        ],
      };
      return result;
    },
  });

  kit.define({
    name: "tab_audio_record_start",
    title: "Start audio recording",
    description: "Start capturing/recording audio from a browser tab (e.g. while Spotify, YouTube, or web audio plays). Does not block; use tab_audio_record_stop to stop and collect the audio.",
    category: "media",
    inputSchema: {
      tabId: TabId,
      passthrough: z.boolean().optional().describe("Whether to keep playing audio through speakers while recording (default true)"),
    },
    annotations: STATE_CHANGE,
    handler: async ({ tabId, passthrough }, ctx) => {
      const r = await ctx.send("tab_audio_record_start", { passthrough: passthrough !== false }, tabId);
      return textResult(r);
    },
  });

  kit.define({
    name: "tab_audio_record_stop",
    title: "Stop audio recording",
    description: "Stop an ongoing tab audio recording and return it as an MCP audio block or save it to disk (.webm natively; .mp3 .wav .ogg .opus .m4a .aac .flac via ffmpeg). Omit tabId to stop the only active recording.",
    category: "media",
    inputSchema: {
      tabId: z.number().int().optional().describe("Tab ID of the recording. Omit when exactly one recording is active."),
      savePath: z.string().optional().describe(AUDIO_SAVE_PATH_DESC),
      overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
    },
    annotations: DESTRUCTIVE,
    handler: async ({ tabId, savePath, overwrite }, ctx) => {
      // Validate before stopping: a bad path must not cost the recording.
      const target = savePath ? checkSavePath(savePath, AUDIO_EXTS, overwrite === true) : null;
      const res = await ctx.send<AudioStopResult>("tab_audio_record_stop", {}, tabId, 120000);
      return finishRecording(res, target);
    },
  });

  kit.define({
    name: "tab_audio_capture",
    title: "Record tab audio",
    description: "Record tab audio for a specified duration in seconds (convenience tool for songs, clips, etc.). Starts recording, waits for the duration (with progress notifications; cancelling stops early), stops the same tab, and saves or returns the audio.",
    category: "media",
    inputSchema: {
      durationSeconds: z.number().positive().max(3600).describe("Recording duration in seconds (e.g. 30, 252)"),
      tabId: TabId,
      savePath: z.string().optional().describe(AUDIO_SAVE_PATH_DESC),
      passthrough: z.boolean().optional().describe("Whether to keep playing audio through speakers while recording (default true)"),
      overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
    },
    annotations: DESTRUCTIVE,
    handler: async ({ durationSeconds, tabId, savePath, passthrough, overwrite }, ctx) => {
      const target = savePath ? checkSavePath(savePath, AUDIO_EXTS, overwrite === true) : null;
      // The start goes through the raw bridge, not ctx.send: a cancel that
      // lands while it runs must not skip the stop below, or the recording
      // would keep running in the extension. waitWithProgress returns at
      // once for a request that is already cancelled, so the stop follows.
      const started = await ctx.bridge.send<{ tabId?: number }>("tab_audio_record_start", { passthrough: passthrough !== false }, tabId);
      // Stop exactly the tab that was started, even if the active tab changed
      // meanwhile. Without a tabId from the caller, the extension picked the
      // user's active tab: it is named in the payload (recordingTabId), never
      // as the command's tabId, which would make it a full agent tab (dialog
      // auto-accept hook and all) although the agent never targeted it.
      const recordingTabId = typeof started?.tabId === "number" ? started.tabId : tabId;
      const stopPayload = tabId === undefined && recordingTabId !== undefined ? { recordingTabId } : {};
      const totalMs = Math.round(durationSeconds * 1000);
      // Never rejects; resolves early (true) when the client cancels the call.
      const cancelled = await waitWithProgress(totalMs, ctx.extra);
      // Always stop (and so release) the recording, also after a cancellation:
      // the raw bridge, not ctx.send, so a cancelled request still releases it.
      const res = await ctx.bridge.send<AudioStopResult>("tab_audio_record_stop", stopPayload, tabId, totalMs + 60000);
      if (cancelled) {
        // The client no longer waits for a result: keep the partial audio only if a path was given.
        const saved = target ? await finishRecording(res, target).catch(() => null) : null;
        return saved ?? textResult({ ok: false, cancelled: true, tabId: recordingTabId });
      }
      return finishRecording(res, target);
    },
  });
}
