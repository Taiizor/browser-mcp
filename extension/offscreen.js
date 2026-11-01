// Offscreen document script for clipboard access and tab audio recording in Manifest V3.

const activeRecordings = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  // --- Audio Recording Handlers ---
  if (msg.type === "mcp-offscreen-audio-start") {
    const tabId = msg.tabId;
    const streamId = msg.streamId;
    const passthrough = msg.passthrough !== false;

    (async () => {
      try {
        if (activeRecordings.has(tabId)) {
          throw new Error(`Tab ${tabId} is already recording audio.`);
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId,
            },
          },
          video: false,
        });

        let audioCtx = null;
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
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        const startedAt = Date.now();
        activeRecordings.set(tabId, {
          stream,
          audioCtx,
          recorder,
          chunks,
          startedAt,
          mimeType: recorder.mimeType || "audio/webm",
        });

        recorder.start(250);
        sendResponse({ ok: true, startedAt, mimeType: recorder.mimeType });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "mcp-offscreen-audio-stop") {
    const tabId = msg.tabId;
    (async () => {
      try {
        const rec = activeRecordings.get(tabId);
        if (!rec) {
          throw new Error(`No active audio recording found for tab ${tabId}.`);
        }
        activeRecordings.delete(tabId);

        const durationMs = Date.now() - rec.startedAt;

        const stopPromise = new Promise((resolve) => {
          rec.recorder.onstop = () => {
            const blob = new Blob(rec.chunks, { type: rec.mimeType });
            resolve(blob);
          };
        });

        rec.recorder.stop();
        const blob = await stopPromise;

        // Clean up stream & audioContext
        try {
          rec.stream.getTracks().forEach((t) => t.stop());
        } catch {}
        if (rec.audioCtx) {
          try {
            await rec.audioCtx.close();
          } catch {}
        }

        // Convert Blob to Base64
        const reader = new FileReader();
        const base64Promise = new Promise((resolve, reject) => {
          reader.onloadend = () => {
            const result = reader.result;
            if (typeof result === "string") {
              const base64 = result.includes(",") ? result.split(",")[1] : result;
              resolve(base64);
            } else {
              reject(new Error("Failed to read blob as data URL"));
            }
          };
          reader.onerror = () => reject(reader.error);
        });
        reader.readAsDataURL(blob);

        const base64 = await base64Promise;
        sendResponse({
          ok: true,
          base64,
          mimeType: rec.mimeType,
          durationMs,
          sizeBytes: blob.size,
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "mcp-offscreen-clipboard-write") {
    const text = String(msg.text ?? "");
    (async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          sendResponse({ ok: true });
          return;
        }
      } catch {}
      try {
        const ta = document.getElementById("ta");
        ta.value = text;
        ta.select();
        document.execCommand("copy");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "mcp-offscreen-clipboard-read") {
    (async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          sendResponse({ ok: true, text });
          return;
        }
      } catch {}
      try {
        const ta = document.getElementById("ta");
        ta.value = "";
        ta.select();
        document.execCommand("paste");
        sendResponse({ ok: true, text: ta.value });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), text: "" });
      }
    })();
    return true;
  }

  return false;
});
