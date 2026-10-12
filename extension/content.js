// Isolated world content script: DOM snapshot + interaction + console/network hooks.
// Page-world hooks are installed by background via chrome.scripting (unaffected by page CSP).

(() => {
  // ---------- ref system ----------
  let refSeq = 0;
  const elToRef = new WeakMap();
  const refToEl = new Map();

  function refOf(el) {
    let r = elToRef.get(el);
    if (!r) {
      r = `e${++refSeq}`;
      elToRef.set(el, r);
      refToEl.set(r, el);
      try {
        el.setAttribute("data-mcp-ref", r);
      } catch {}
    }
    return r;
  }

  // Periodically clean up stale refs to prevent memory leaks
  setInterval(() => {
    for (const [ref, el] of refToEl) {
      if (!el.isConnected) {
        refToEl.delete(ref);
      }
    }
  }, 30000);

  function resolveTarget(sel) {
    if (!sel) return null;
    sel = String(sel);
    // ref=e12 veya e12
    const m = sel.match(/^(?:ref=)?(e\d+)$/);
    if (m && refToEl.has(m[1])) {
      const el = refToEl.get(m[1]);
      if (el && el.isConnected) return el;
    }
    if (sel.startsWith("xpath=")) {
      const xp = sel.slice(6);
      const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    }
    if (sel.startsWith("text=")) {
      if (!document.body) return null;
      const t = sel.slice(5).toLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        const txt = (n.innerText || "").trim().toLowerCase();
        if (txt && txt.includes(t)) return n;
      }
      return null;
    }
    try {
      // data-mcp-ref ile de dene
      if (/^e\d+$/.test(sel)) {
        const byAttr = document.querySelector(`[data-mcp-ref="${sel}"]`);
        if (byAttr) return byAttr;
      }
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  function describe(el) {
    const tag = (el.tagName || "?").toLowerCase();
    const ref = refOf(el);
    const parts = [`[ref=${ref}]`, `<${tag}>`];
    const interesting = ["id", "name", "type", "placeholder", "aria-label", "href", "role", "value"];
    for (const a of interesting) {
      try {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) parts.push(`${a}="${String(v).slice(0, 60)}"`);
      } catch {}
    }
    let txt = "";
    try {
      txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    } catch {}
    if (txt && !["script", "style"].includes(tag)) parts.push(`"${txt}"`);
    // visibility
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) parts.push("(hidden)");
    } catch {}
    return parts.join(" ");
  }

  function snapshot(compact) {
    const out = [];
    const root = document.body || document.documentElement;
    if (!root) return "(empty)";
    const selector = compact
      ? "a,button,input,select,textarea,[role=button],[role=link],[role=textbox],form,h1,h2,h3"
      : "a,button,input,select,textarea,form,h1,h2,h3,h4,p,li,img,div,span,nav,header,main,footer,table,tr,td";
    const els = root.querySelectorAll(selector);
    const limit = compact ? 400 : 1000;
    let i = 0;
    for (const el of els) {
      if (i++ >= limit) {
        out.push(`... (+${els.length - limit} more items trimmed)`);
        break;
      }
      out.push(describe(el));
    }
    out.unshift(`url=${location.href} title="${document.title}" interactive=${els.length}`);
    return out.join("\n");
  }

  function queryAll(sel, limit = 20) {
    let els = [];
    if (sel.startsWith("xpath=")) {
      const xp = sel.slice(6);
      const it = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < Math.min(it.snapshotLength, limit); i++) els.push(it.snapshotItem(i));
    } else {
      try {
        els = Array.from(document.querySelectorAll(sel)).slice(0, limit);
      } catch {
        const single = resolveTarget(sel);
        if (single) els = [single];
      }
    }
    return els.map((el) => {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
      return {
        ref: refOf(el),
        tag: (el.tagName || "").toLowerCase(),
        text: ((el.innerText || el.textContent || "").trim().slice(0, 200)),
        x: Math.round(r.x || 0),
        y: Math.round(r.y || 0),
        w: Math.round(r.width || 0),
        h: Math.round(r.height || 0),
      };
    });
  }

  function mouse(el, kind, button = "left") {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const btn = button === "right" ? 2 : button === "middle" ? 1 : 0;
    for (const ev of ["mouseover", "mousemove", "mousedown", "mouseup", kind]) {
      el.dispatchEvent(
        new MouseEvent(ev, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: btn })
      );
    }
  }

  async function typeInto(el, text, delayMs = 0) {
    el.focus();
    // contenteditable mi input mu?
    const isInput = /^(input|textarea)$/i.test(el.tagName) || el.isContentEditable;
    if (delayMs > 0) {
      for (const ch of text) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        if (isInput) {
          const s = el.selectionStart ?? el.value?.length ?? 0;
          if ("value" in el) {
            el.value = (el.value || "").slice(0, s) + ch + (el.value || "").slice(s);
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch }));
          } else {
            document.execCommand("insertText", false, ch);
          }
        } else {
          el.textContent += ch;
        }
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } else {
      if ("value" in el && isInput && !el.isContentEditable) {
        const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        setter ? setter.call(el, text) : (el.value = text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, text);
      } else {
        el.textContent = text;
      }
    }
  }

// NOTE: MAIN-world hooks (console + dialog) are installed by background via
// (Removed: the old <script> injection printed CSP errors.)
// This file only relays MAIN -> isolated messages to background.

  window.addEventListener("message", (ev) => {
    if (ev.data && ev.data.__mcpConsole) {
      chrome.runtime.sendMessage({ type: "mcp-console", entry: ev.data.__mcpConsole }).catch(() => {});
    }
    if (ev.data && ev.data.__mcpDialog) {
      chrome.runtime.sendMessage({ type: "mcp-dialog", entry: ev.data.__mcpDialog }).catch(() => {});
    }
  });

  // ---------- IndexedDB helpers (static code: no eval, CSP-safe) ----------
  function idbOpen(name) {
    return new Promise((res, rej) => {
      let req;
      try {
        req = indexedDB.open(name);
      } catch (e) {
        rej(e);
        return;
      }
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error("open failed"));
      req.onblocked = () => rej(new Error("open blocked by another connection"));
    });
  }

  function idbSafe(v) {
    try {
      const s = JSON.stringify(v);
      if (s !== undefined) return JSON.parse(s.length > 20000 ? s.slice(0, 20000) : s);
    } catch {}
    try {
      return String(v).slice(0, 2000);
    } catch {
      return "(unserializable)";
    }
  }

  // ---------- message router ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__mcp == null) return false;
    // Sticky frame: non-matching frames stay silent (fixes first-response-wins)
    if (msg.__frameUrl && !(location.href || "").includes(msg.__frameUrl)) return false;
    (async () => {
      const { cmd, payload } = msg;
      try {
        let result;
        switch (cmd) {
          case "page_snapshot":
            result = snapshot(payload?.compact !== false);
            break;
          case "page_html":
            result = document.documentElement.outerHTML.slice(0, 500000);
            break;
          case "page_text":
            result = (document.body?.innerText || "").slice(0, 100000);
            break;
          case "dom_query":
            result = queryAll(payload.selector);
            break;
          case "dom_click": {
            const el = resolveTarget(payload.selector);
            if (!el) throw new Error(`Element not found: ${payload.selector}`);
            el.scrollIntoView({ block: "center" });
            await new Promise((r) => setTimeout(r, 80));
            mouse(el, payload.doubleClick ? "dblclick" : "click", payload.button || "left");
            result = { ok: true, ref: refOf(el) };
            break;
          }
          case "dom_type": {
            const el = resolveTarget(payload.selector);
            if (!el) throw new Error(`Element not found: ${payload.selector}`);
            el.scrollIntoView({ block: "center" });
            if (payload.clearFirst) {
              el.focus();
              if ("value" in el) {
                el.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
              } else {
                el.textContent = "";
              }
            }
            await typeInto(el, payload.text || "", payload.delayMs || 0);
            if (payload.pressEnter) {
              el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
              el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }));
            }
            result = { ok: true };
            break;
          }
          case "dom_fill": {
            const out = {};
            for (const [sel, val] of Object.entries(payload.fields || {})) {
              const el = resolveTarget(sel);
              if (!el) {
                out[sel] = "not-found";
                continue;
              }
              if (el.tagName === "SELECT") {
                el.value = String(val);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              } else {
                await typeInto(el, String(val), 0);
              }
              out[sel] = "ok";
            }
            if (payload.submit) {
              const firstSel = Object.keys(payload.fields || {})[0];
              const firstEl = firstSel ? resolveTarget(firstSel) : null;
              const f = firstEl ? firstEl.closest("form") : document.querySelector("form");
              if (f) f.submit();
            }
            result = out;
            break;
          }
          case "dom_select": {
            const el = resolveTarget(payload.selector);
            if (!el) throw new Error("not found");
            el.value = payload.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            result = { ok: true };
            break;
          }
          case "dom_check": {
            const el = resolveTarget(payload.selector);
            if (!el) throw new Error("not found");
            const want = payload.checked ?? !el.checked;
            el.checked = want;
            // NOTE: do NOT send a synthetic click — it toggles the checkbox back.
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            result = { ok: true, checked: el.checked };
            break;
          }
          case "dom_hover": {
            const el = resolveTarget(payload.selector);
            if (!el) throw new Error("not found");
            el.scrollIntoView({ block: "center" });
            mouse(el, "mouseover");
            result = { ok: true };
            break;
          }
          case "dom_focus": {
            const el = resolveTarget(payload.selector);
            if (!el) throw new Error("not found");
            el.focus();
            result = { ok: true };
            break;
          }
          case "dom_scroll": {
            if (payload.selector) {
              const el = resolveTarget(payload.selector);
              if (!el) throw new Error("not found");
              el.scrollIntoView({ block: "center" });
            } else if (payload.direction === "top") {
              window.scrollTo(0, 0);
            } else if (payload.direction === "bottom") {
              window.scrollTo(0, document.body.scrollHeight);
            } else if (payload.direction === "up") {
              window.scrollBy(0, -(payload.pixels || 500));
            } else {
              window.scrollBy(0, payload.pixels || 500);
            }
            result = { ok: true, y: window.scrollY };
            break;
          }
          case "dom_drag": {
            const a = resolveTarget(payload.from);
            const b = resolveTarget(payload.to);
            if (!a || !b) throw new Error("drag source/target not found");
            const rb = b.getBoundingClientRect();
            a.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            a.dispatchEvent(
              new MouseEvent("mousemove", {
                bubbles: true,
                clientX: rb.x + rb.width / 2,
                clientY: rb.y + rb.height / 2,
              })
            );
            b.dispatchEvent(
              new MouseEvent("mouseup", {
                bubbles: true,
                clientX: rb.x + rb.width / 2,
                clientY: rb.y + rb.height / 2,
              })
            );
            // HTML5 DnD
            try {
              const dt = new DataTransfer();
              a.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
              b.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
              a.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
            } catch {}
            result = { ok: true };
            break;
          }
          case "keyboard_press": {
            const key = payload.key;
            const target = document.activeElement || document.body;
            // Ctrl+C gibi kombinasyonlar
            const parts = String(key).split("+");
            const main = parts.pop();
            const opts = {
              key: main,
              bubbles: true,
              ctrlKey: parts.includes("Ctrl"),
              shiftKey: parts.includes("Shift"),
              altKey: parts.includes("Alt"),
              metaKey: parts.includes("Meta"),
            };
            target.dispatchEvent(new KeyboardEvent("keydown", opts));
            target.dispatchEvent(new KeyboardEvent("keyup", opts));
            result = { ok: true };
            break;
          }
          case "page_find": {
            const q = (payload.text || "").toLowerCase();
            const body = (document.body?.innerText || "").toLowerCase();
            const idx = body.indexOf(q);
            if (idx === -1) {
              result = { found: false, count: 0 };
              break;
            }
            const count = body.split(q).length - 1;
            // highlight + scroll to first match
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walker.nextNode())) {
              if ((n.nodeValue || "").toLowerCase().includes(q)) {
                const r = document.createRange();
                r.selectNode(n.parentElement);
                n.parentElement.scrollIntoView({ block: "center" });
                break;
              }
            }
            result = { found: true, count, firstIndex: idx };
            break;
          }
          case "page_wait": {
            const timeout = payload.timeoutMs || 15000;
            const t0 = Date.now();
            const checkCondition = () => {
              if (payload.url && !location.href.includes(payload.url)) return false;
              if (payload.urlPattern) {
                try {
                  if (!new RegExp(payload.urlPattern).test(location.href)) return false;
                } catch {
                  return false;
                }
              }
              if (payload.readyState && document.readyState !== payload.readyState) return false;
              if (payload.selector && !resolveTarget(payload.selector)) return false;
              if (payload.text && !(document.body?.innerText || "").includes(payload.text)) return false;
              return true;
            };

            const hasCondition = payload.selector || payload.text || payload.url || payload.urlPattern || payload.readyState;
            if (!hasCondition) {
              await new Promise((r) => setTimeout(r, timeout));
              result = { ok: true, waitedMs: timeout };
              break;
            }

            if (checkCondition()) {
              result = { ok: true, waitedMs: Date.now() - t0 };
              break;
            }

            const ok = await new Promise((resolve) => {
              let done = false;
              let timer = null;
              let observer = null;
              let interval = null;

              const finish = (val) => {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                if (interval) clearInterval(interval);
                if (observer) observer.disconnect();
                resolve(val);
              };

              timer = setTimeout(() => finish(false), timeout);

              if (window.MutationObserver && document.documentElement) {
                observer = new MutationObserver(() => {
                  if (checkCondition()) finish(true);
                });
                observer.observe(document.documentElement, {
                  childList: true,
                  subtree: true,
                  characterData: !!payload.text,
                });
              }

              interval = setInterval(() => {
                if (checkCondition()) finish(true);
              }, 200);
            });

            if (!ok) throw new Error("Timed out: expected condition never appeared");
            result = { ok: true, waitedMs: Date.now() - t0 };
            break;
          }
          case "js_evaluate": {
            let fn;
            try {
              fn = new Function(payload.expression);
            } catch {
              fn = new Function(`return (${payload.expression})`);
            }
            let v = fn();
            if (payload.awaitPromise && v && typeof v.then === "function") v = await v;
            let json;
            try {
              json = JSON.parse(JSON.stringify(v));
            } catch {
              json = String(v);
            }
            result = { value: json };
            break;
          }
          case "storage_get": {
            const area = payload.area === "session" ? sessionStorage : localStorage;
            const all = {};
            for (let i = 0; i < area.length; i++) {
              const k = area.key(i);
              all[k] = (area.getItem(k) || "").slice(0, 2000);
            }
            result = { url: location.href, area: payload.area, data: all };
            break;
          }
          case "storage_set": {
            const area = payload.area === "session" ? sessionStorage : localStorage;
            area.setItem(payload.key, payload.value);
            result = { ok: true };
            break;
          }
          case "idb_list": {
            if (!indexedDB.databases) {
              result = { supported: false, databases: [] };
              break;
            }
            const dbs = await indexedDB.databases();
            result = {
              supported: true,
              databases: (dbs || []).map((d) => ({ name: d.name, version: d.version })),
            };
            break;
          }
          case "idb_stores": {
            const db = await idbOpen(payload.db);
            try {
              result = { db: payload.db, stores: Array.from(db.objectStoreNames) };
            } finally {
              db.close();
            }
            break;
          }
          case "idb_count": {
            const db = await idbOpen(payload.db);
            try {
              const n = await new Promise((res, rej) => {
                const tx = db.transaction(payload.store, "readonly");
                const q = tx.objectStore(payload.store).count();
                q.onsuccess = () => res(q.result);
                q.onerror = () => rej(q.error);
              });
              result = { db: payload.db, store: payload.store, count: n };
            } finally {
              db.close();
            }
            break;
          }
          case "idb_read": {
            const db = await idbOpen(payload.db);
            try {
              const rows = await new Promise((res, rej) => {
                const tx = db.transaction(payload.store, "readonly");
                const q = payload.key !== undefined
                  ? tx.objectStore(payload.store).get(payload.key)
                  : tx.objectStore(payload.store).getAll(null, payload.limit || 50);
                q.onsuccess = () => res(q.result);
                q.onerror = () => rej(q.error);
              });
              const list = Array.isArray(rows) ? rows : [rows];
              result = {
                db: payload.db,
                store: payload.store,
                rows: list.filter((r) => r !== undefined).map((r) => idbSafe(r)),
              };
            } finally {
              db.close();
            }
            break;
          }
          case "idb_put": {
            const db = await idbOpen(payload.db);
            try {
              const key = await new Promise((res, rej) => {
                const tx = db.transaction(payload.store, "readwrite");
                const q = payload.key !== undefined
                  ? tx.objectStore(payload.store).put(payload.value, payload.key)
                  : tx.objectStore(payload.store).put(payload.value);
                q.onsuccess = () => res(q.result);
                q.onerror = () => rej(q.error);
              });
              result = { ok: true, key };
            } finally {
              db.close();
            }
            break;
          }
          case "idb_delete": {
            const db = await idbOpen(payload.db);
            try {
              await new Promise((res, rej) => {
                const tx = db.transaction(payload.store, "readwrite");
                const q = tx.objectStore(payload.store).delete(payload.key);
                q.onsuccess = () => res(0);
                q.onerror = () => rej(q.error);
              });
              result = { ok: true };
            } finally {
              db.close();
            }
            break;
          }
          case "idb_clear": {
            const db = await idbOpen(payload.db);
            try {
              await new Promise((res, rej) => {
                const tx = db.transaction(payload.store, "readwrite");
                const q = tx.objectStore(payload.store).clear();
                q.onsuccess = () => res(0);
                q.onerror = () => rej(q.error);
              });
              result = { ok: true };
            } finally {
              db.close();
            }
            break;
          }
          case "network_refetch": {
            const res = await fetch(payload.url, { credentials: "include" });
            const text = await res.text();
            result = {
              status: res.status,
              headers: Object.fromEntries(res.headers.entries()),
              bodySnippet: text.slice(0, 20000),
            };
            break;
          }
          case "__ping":
            result = { pong: true };
            break;
          default:
            throw new Error(`Unknown content command: ${cmd}`);
        }
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  });
})();
