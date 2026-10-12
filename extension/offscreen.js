// Offscreen document script for clipboard access in Manifest V3.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

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
