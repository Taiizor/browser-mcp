// Offscreen document script for clipboard access and tab audio recording in Manifest V3.
//
// Messages (accepted only from this extension's own non-tab contexts, i.e. the
// service worker or extension pages; never from content scripts):
//   mcp-offscreen-audio-start   {tabId, streamId, passthrough} -> {ok, startedAt, mimeType}
//   mcp-offscreen-audio-stop    {tabId} -> {ok, tabId, mimeType, durationMs, sizeBytes,
//                                           chunkCount, chunkBytes, endedBy}
//       Stops the recorder but KEEPS the data until it is released, so a failed
//       transfer can be retried. Idempotent: stopping a recording that already
//       finished on its own (e.g. the captured tab was closed) returns its metadata.
//   mcp-offscreen-audio-chunk   {tabId, index} -> {ok, base64, index, chunkCount}
//   mcp-offscreen-audio-release {tabId} -> {ok, released}
//   mcp-offscreen-audio-list    {} -> {ok, tabIds, recordings}
//   mcp-offscreen-clipboard-write {text} -> {ok}
//   mcp-offscreen-clipboard-read  {} -> {ok, text}

// Raw bytes per transfer chunk. Divisible by 3, so the base64 strings of
// consecutive chunks concatenate into one valid base64 string.
const AUDIO_CHUNK_BYTES = 6 * 1024 * 1024;
// How long to wait for MediaRecorder's "stop" event before finalizing anyway.
const STOP_TIMEOUT_MS = 5000;
// Finished recordings that are neither retrieved nor released are freed after this idle time.
const FINISHED_TTL_MS = 30 * 60 * 1000;

// tabId -> recording entry
const recordings = new Map();
// tabIds whose start is in progress (guards concurrent starts for the same tab)
const startingTabs = new Set();

function errMsg(e) {
  return String((e && e.message) || e);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTrustedSender(sender) {
  return !!sender && sender.id === chrome.runtime.id && !sender.tab;
}

function toTabId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid tabId: ${value}`);
  return n;
}

function chunkCountOf(blob) {
  return Math.max(1, Math.ceil(blob.size / AUDIO_CHUNK_BYTES));
}

function blobToBase64(blob) {
  // Chromium's readAsDataURL yields just "data:" (no comma) for an empty Blob,
  // so short-circuit empty input and never return the raw data URL as base64.
  if (!blob || blob.size === 0) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read audio data as a data URL"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read audio data"));
    reader.readAsDataURL(blob);
  });
}

// Stop the capture tracks and the passthrough AudioContext (idempotent).
function releaseMedia(rec) {
  try {
    rec.stream.getTracks().forEach((t) => t.stop());
  } catch {}
  if (rec.audioCtx) {
    const ctx = rec.audioCtx;
    rec.audioCtx = null;
    try {
      ctx.close().catch(() => {});
    } catch {}
  }
}

// (Re)arm the idle timer that frees a finished recording nobody collects.
function touch(rec) {
  if (rec.expiryTimer) clearTimeout(rec.expiryTimer);
  rec.expiryTimer = setTimeout(() => {
    if (recordings.get(rec.tabId) === rec) discardRecording(rec);
  }, FINISHED_TTL_MS);
}

// Turn the collected chunks into one Blob and keep it until released (idempotent).
function finalizeRecording(rec, endedBy) {
  if (rec.state === "finished" || rec.discarded) return;
  rec.state = "finished";
  if (!rec.endedBy) rec.endedBy = endedBy;
  if (!rec.stoppedAt) rec.stoppedAt = Date.now();
  rec.blob = new Blob(rec.chunks, { type: rec.mimeType });
  rec.chunks.length = 0;
  releaseMedia(rec);
  touch(rec);
  rec.resolveFinished();
}

function discardRecording(rec) {
  rec.discarded = true;
  if (rec.expiryTimer) clearTimeout(rec.expiryTimer);
  rec.expiryTimer = null;
  try {
    if (rec.recorder.state !== "inactive") rec.recorder.stop();
  } catch {}
  releaseMedia(rec);
  rec.chunks.length = 0;
  rec.blob = null;
  if (recordings.get(rec.tabId) === rec) recordings.delete(rec.tabId);
  rec.resolveFinished();
}

function recordingMeta(rec) {
  if (!rec.blob) throw new Error(`The audio recording for tab ${rec.tabId} was released.`);
  const out = {
    ok: true,
    tabId: rec.tabId,
    mimeType: rec.mimeType,
    durationMs: Math.max(0, (rec.stoppedAt || Date.now()) - rec.startedAt),
    sizeBytes: rec.blob.size,
    chunkCount: chunkCountOf(rec.blob),
    chunkBytes: AUDIO_CHUNK_BYTES,
    endedBy: rec.endedBy || "stop",
  };
  if (rec.recorderError) out.recorderError = rec.recorderError;
  return out;
}

// --- Audio recording ---

async function startRecording(msg) {
  const tabId = toTabId(msg.tabId);
  const streamId = msg.streamId;
  if (!streamId || typeof streamId !== "string") throw new Error("Missing media stream id.");
  const passthrough = msg.passthrough !== false;

  const existing = recordings.get(tabId);
  if (existing) {
    if (existing.state === "recording") throw new Error(`Tab ${tabId} is already recording audio.`);
    if (!existing.retrieved) {
      throw new Error(
        `Tab ${tabId} has a finished audio recording that was not retrieved yet; call tab_audio_record_stop for this tab first to retrieve it.`
      );
    }
    // Already handed out once via stop: a new recording replaces it.
    discardRecording(existing);
  }
  if (startingTabs.has(tabId)) throw new Error(`Tab ${tabId} is already starting an audio recording.`);
  startingTabs.add(tabId);

  let stream = null;
  let audioCtx = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    if (passthrough) {
      try {
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(audioCtx.destination);
      } catch (ctxErr) {
        console.warn("[offscreen] AudioContext passthrough failed:", ctxErr);
      }
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    const rec = {
      tabId,
      stream,
      audioCtx,
      recorder,
      chunks: [],
      startedAt: Date.now(),
      stoppedAt: null,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      state: "recording",
      endedBy: null,
      recorderError: null,
      retrieved: false,
      discarded: false,
      blob: null,
      expiryTimer: null,
      finished: null,
      resolveFinished: null,
    };
    rec.finished = new Promise((resolve) => {
      rec.resolveFinished = resolve;
    });

    recorder.ondataavailable = (e) => {
      if (rec.state === "recording" && e.data && e.data.size > 0) rec.chunks.push(e.data);
    };
    // Registered up front so a recorder that stops on its own (captured tab
    // closed, track ended, recorder error) is finalized and kept for retrieval.
    recorder.onstop = () => finalizeRecording(rec, "track-ended");
    recorder.onerror = (e) => {
      rec.recorderError = errMsg((e && e.error) || e);
      if (!rec.endedBy) rec.endedBy = "error";
    };
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (rec.state !== "recording" || rec.discarded) return;
        if (!rec.endedBy) rec.endedBy = "track-ended";
        if (!rec.stoppedAt) rec.stoppedAt = Date.now();
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {}
        // Fallback in case the "stop" event never arrives.
        setTimeout(() => finalizeRecording(rec, "track-ended"), STOP_TIMEOUT_MS);
      });
    }

    recorder.start(250);
    recordings.set(tabId, rec);
    return { ok: true, startedAt: rec.startedAt, mimeType: recorder.mimeType };
  } catch (e) {
    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
    }
    if (audioCtx) {
      try {
        audioCtx.close().catch(() => {});
      } catch {}
    }
    throw e;
  } finally {
    startingTabs.delete(tabId);
  }
}

async function stopRecording(msg) {
  const tabId = toTabId(msg.tabId);
  const rec = recordings.get(tabId);
  if (!rec) throw new Error(`No audio recording found for tab ${tabId}.`);
  if (rec.state === "recording") {
    if (!rec.endedBy) rec.endedBy = "stop";
    if (!rec.stoppedAt) rec.stoppedAt = Date.now();
    const wasActive = rec.recorder.state !== "inactive";
    try {
      if (wasActive) rec.recorder.stop();
    } catch {}
    // stop() is a no-op on a recorder that already went inactive on its own,
    // so its "stop" event may never fire again: never wait forever for it.
    await Promise.race([rec.finished, sleep(wasActive ? STOP_TIMEOUT_MS : 500)]);
    finalizeRecording(rec, rec.endedBy);
  }
  rec.retrieved = true;
  if (!rec.discarded) touch(rec);
  return recordingMeta(rec);
}

async function readChunk(msg) {
  const tabId = toTabId(msg.tabId);
  const rec = recordings.get(tabId);
  if (!rec || rec.state !== "finished" || !rec.blob) {
    throw new Error(`No stopped audio recording found for tab ${tabId}; stop the recording first.`);
  }
  const count = chunkCountOf(rec.blob);
  const index = Number(msg.index);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`Audio chunk index out of range: ${msg.index} (chunkCount ${count}).`);
  }
  touch(rec);
  const start = index * AUDIO_CHUNK_BYTES;
  const base64 = await blobToBase64(rec.blob.slice(start, start + AUDIO_CHUNK_BYTES));
  if (!rec.discarded) touch(rec);
  return { ok: true, base64, index, chunkCount: count };
}

function releaseRecording(msg) {
  const tabId = toTabId(msg.tabId);
  const rec = recordings.get(tabId);
  if (!rec) return { ok: true, released: false };
  discardRecording(rec);
  return { ok: true, released: true };
}

function listRecordings() {
  const entries = Array.from(recordings.values());
  return {
    ok: true,
    // Recordings a stop call makes sense for: still recording, or finished on
    // their own (e.g. captured tab closed) and not retrieved yet.
    tabIds: entries.filter((r) => r.state === "recording" || !r.retrieved).map((r) => r.tabId),
    recordings: entries.map((r) => ({
      tabId: r.tabId,
      state: r.state,
      endedBy: r.endedBy,
      startedAt: r.startedAt,
      retrieved: r.retrieved,
    })),
  };
}

// --- Clipboard ---

async function clipboardWrite(msg) {
  const text = String(msg.text ?? "");
  let apiError = null;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (e) {
      apiError = e;
    }
  }
  const ta = document.getElementById("ta");
  if (!ta) throw new Error("Clipboard write failed: offscreen textarea is missing.");
  let copied = false;
  let cmdError = null;
  try {
    ta.value = text;
    ta.focus();
    ta.select();
    copied = document.execCommand("copy") === true;
  } catch (e) {
    cmdError = e;
  } finally {
    ta.value = "";
  }
  if (!copied) {
    const why = cmdError ? errMsg(cmdError) : "the copy command was rejected";
    throw new Error(`Clipboard write failed: ${why}${apiError ? ` (Clipboard API: ${errMsg(apiError)})` : ""}`);
  }
  return { ok: true };
}

async function clipboardRead() {
  let apiError = null;
  if (navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      return { ok: true, text };
    } catch (e) {
      apiError = e;
    }
  }
  const ta = document.getElementById("ta");
  if (!ta) throw new Error("Clipboard read failed: offscreen textarea is missing.");
  let pasted = false;
  let cmdError = null;
  let text = "";
  try {
    ta.value = "";
    ta.focus();
    ta.select();
    pasted = document.execCommand("paste") === true;
    text = ta.value;
  } catch (e) {
    cmdError = e;
  } finally {
    ta.value = "";
  }
  if (!pasted) {
    const why = cmdError ? errMsg(cmdError) : "the paste command was rejected";
    throw new Error(`Clipboard read failed: ${why}${apiError ? ` (Clipboard API: ${errMsg(apiError)})` : ""}`);
  }
  return { ok: true, text };
}

const HANDLERS = {
  "mcp-offscreen-audio-start": startRecording,
  "mcp-offscreen-audio-stop": stopRecording,
  "mcp-offscreen-audio-chunk": readChunk,
  "mcp-offscreen-audio-release": releaseRecording,
  "mcp-offscreen-audio-list": listRecordings,
  "mcp-offscreen-clipboard-write": clipboardWrite,
  "mcp-offscreen-clipboard-read": clipboardRead,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, msg.type)) return false;
  // Clipboard and tab capture are privileged: only the service worker / extension
  // pages may drive them, never content scripts (which always carry sender.tab).
  if (!isTrustedSender(sender)) return false;
  const handler = HANDLERS[msg.type];
  Promise.resolve()
    .then(() => handler(msg))
    .then(
      (res) => sendResponse(res),
      (e) => {
        const res = { ok: false, error: errMsg(e) };
        if (msg.type === "mcp-offscreen-clipboard-read") res.text = "";
        sendResponse(res);
      }
    );
  return true;
});
