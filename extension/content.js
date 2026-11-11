// Isolated world content script: DOM snapshot + interaction + console/dialog relay.
// Page-world hooks (console/dialog) are installed by the background via
// chrome.scripting (unaffected by page CSP); this file only relays them.
// Never use eval / new Function here: the extension CSP has no 'unsafe-eval'.

(() => {
  // Guard against double injection: the manifest auto-injects this file at
  // document_start, and the background re-injects it on demand when a command
  // races a navigation commit. Without this, two instances coexist and relay
  // every MAIN-world event twice (duplicate console/dialog entries).
  // (Isolated worlds reset on navigation, so a per-world flag is correct.)
  // An instance orphaned by an extension reload (chrome.runtime.id is gone)
  // must not block the fresh injection, so the guard asks it whether it is alive.
  try {
    if (typeof window.__mcpContentAlive === "function" && window.__mcpContentAlive()) return;
  } catch {}
  window.__mcpContentLoaded = true;
  window.__mcpContentAlive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ELEMENT_NODE = 1;
  const DOCUMENT_NODE = 9;

  // ---------- shadow DOM traversal ----------
  // Open shadow roots are reachable through el.shadowRoot; closed ones through
  // chrome.dom (content scripts only). Only custom elements (dash in the tag
  // name) are worth the extra call for closed roots.
  function shadowOf(el) {
    try {
      if (el.shadowRoot) return el.shadowRoot;
      if (
        el.localName &&
        el.localName.includes("-") &&
        typeof chrome !== "undefined" &&
        chrome.dom &&
        typeof chrome.dom.openOrClosedShadowRoot === "function"
      ) {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      }
    } catch {}
    return null;
  }

  // Visits every element under `root` (Document, ShadowRoot or Element; an
  // Element root is visited itself) in tree order, descending into shadow
  // roots: a host's shadow tree is visited before its light children.
  // visit(el, shadowRoot) returns true to stop. Returns true when stopped.
  function walkDeep(root, visit, depth = 0) {
    if (!root || depth > 32) return false;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = root.nodeType === ELEMENT_NODE ? root : tw.nextNode();
    while (n) {
      const sr = shadowOf(n);
      if (visit(n, sr)) return true;
      if (sr && walkDeep(sr, visit, depth + 1)) return true;
      n = tw.nextNode();
    }
    return false;
  }

  function shadowRootsUnder(root) {
    const out = [];
    walkDeep(root, (_el, sr) => {
      if (sr) out.push(sr);
      return false;
    });
    return out;
  }

  // Ancestor test that crosses shadow boundaries (ShadowRoot -> host).
  function containsDeep(anc, node) {
    for (let n = node; n; n = n.parentNode || (n.nodeType === 11 ? n.host : null)) {
      if (n === anc) return true;
    }
    return false;
  }

  function deepActiveElement() {
    let a = document.activeElement;
    for (let i = 0; a && i < 32; i++) {
      const sr = shadowOf(a);
      if (!sr || !sr.activeElement || sr.activeElement === a) break;
      a = sr.activeElement;
    }
    return a;
  }

  function deepElementFromPoint(x, y) {
    let top = document.elementFromPoint(x, y);
    for (let i = 0; top && i < 32; i++) {
      const sr = shadowOf(top);
      if (!sr || typeof sr.elementFromPoint !== "function") break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return top;
  }

  function isVisible(el) {
    try {
      if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  }

  function normText(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function describeShort(el) {
    if (!el || !el.tagName) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += `.${cls.join(".")}`;
    return `<${s}>`;
  }

  // ---------- ref system ----------
  // Refs keep the `e<digits>` shape (the background maps bare refs to
  // [data-mcp-ref="eN"] for CDP lookups) but carry a random per-document
  // namespace: e<namespace: 6 digits><sequence: 3 digits>, e.g. e473912012.
  // Every document/frame picks its own namespace from 900000 values, so a ref
  // taken from another page or frame is reported as stale instead of silently
  // hitting an unrelated element. Resolution only trusts the in-memory maps;
  // the page-writable data-mcp-ref attribute is never used to find an element.
  const REF_SPAN = 1000;
  const REF_NS_MIN = 100000;
  const REF_NS_COUNT = 900000;
  const refSpaces = new Set();
  let refSpace = 0;
  let refSeq = REF_SPAN; // forces allocation of the first namespace
  const elToRef = new WeakMap();
  const refToEl = new Map();

  function newRefSpace() {
    // Never reuse a namespace of this document: that would reset the sequence
    // and overwrite live refToEl entries.
    let ns = REF_NS_MIN + Math.floor(Math.random() * REF_NS_COUNT);
    for (let tries = 0; refSpaces.has(ns) && tries < 64; tries++) {
      ns = REF_NS_MIN + Math.floor(Math.random() * REF_NS_COUNT);
    }
    // Practically unreachable (needs ~900M refs); scan for a free one.
    while (refSpaces.has(ns)) ns = ns + 1 >= REF_NS_MIN + REF_NS_COUNT ? REF_NS_MIN : ns + 1;
    refSpaces.add(ns);
    refSpace = ns;
    refSeq = 0;
  }

  function refOf(el) {
    let r = elToRef.get(el);
    if (!r) {
      if (refSeq >= REF_SPAN - 1) newRefSpace();
      r = `e${refSpace * REF_SPAN + ++refSeq}`;
      elToRef.set(el, r);
    }
    // Re-register refs dropped by the cleanup while the element was detached.
    if (refToEl.get(r) !== el) refToEl.set(r, el);
    try {
      if (el.getAttribute("data-mcp-ref") !== r) el.setAttribute("data-mcp-ref", r);
    } catch {}
    return r;
  }

  // Periodically clean up refs of detached elements to prevent memory leaks
  setInterval(() => {
    for (const [ref, el] of refToEl) {
      if (!el.isConnected) refToEl.delete(ref);
    }
  }, 30000);

  // `e473912012`, `ref=e473912012` and the snapshot's `[ref=e473912012]` form.
  const REF_RE = /^\[?(?:ref=)?(e\d+)\]?$/;

  function lookupRef(id) {
    const el = refToEl.get(id);
    if (el && elToRef.get(el) === id) {
      if (el.isConnected) return el;
      throw new Error(
        `Ref ${id} is no longer attached to the page (the element was removed or re-rendered); run page_snapshot or dom_query again`
      );
    }
    const n = Number(id.slice(1));
    if (!refSpaces.has(Math.floor(n / REF_SPAN))) {
      throw new Error(
        `Unknown ref ${id}: it does not belong to the current page/frame (refs expire on navigation and are per frame); run page_snapshot again`
      );
    }
    throw new Error(`Ref ${id} is no longer available; run page_snapshot or dom_query again`);
  }

  // ---------- selector engine ----------
  // Supported forms: snapshot ref (e12 / ref=e12), xpath=..., text=...
  // (text="..." for an exact match), css=..., plain CSS, and a shadow-piercing
  // CSS chain `host >>> inner`. Plain CSS also searches open shadow roots.
  function findAll(sel, limit = 20) {
    if (sel === undefined || sel === null) throw new Error("selector is required");
    let s = String(sel).trim();
    if (!s) throw new Error("selector is required");
    const m = REF_RE.exec(s);
    if (m) return [lookupRef(m[1])];
    if (s.startsWith("xpath=")) return xpathAll(s.slice(6), limit);
    if (s.startsWith("text=")) return textAll(s.slice(5), limit);
    if (s.startsWith("css=")) s = s.slice(4).trim();
    return cssAll(s, limit);
  }

  function findOne(sel) {
    return findAll(sel, 1)[0] || null;
  }

  function requireOne(sel) {
    const el = findOne(sel);
    if (!el) throw new Error(`Element not found: ${sel}`);
    return el;
  }

  function xpathAll(xp, limit) {
    let it;
    try {
      it = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch (e) {
      throw new Error(`Invalid XPath (it must select nodes): ${xp}`);
    }
    const out = [];
    for (let i = 0; i < it.snapshotLength && out.length < limit; i++) {
      let n = it.snapshotItem(i);
      if (n && n.nodeType === 2) n = n.ownerElement; // attribute node
      else if (n && n.nodeType !== ELEMENT_NODE) n = n.parentElement; // text/comment node
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }

  function validateCss(sel) {
    try {
      document.createDocumentFragment().querySelector(sel);
    } catch {
      throw new Error(`Invalid selector: ${sel} (use CSS, xpath=..., text=... or a snapshot ref such as e473912012)`);
    }
  }

  function cssAll(sel, limit) {
    if (sel.includes(">>>")) return piercingAll(sel, limit);
    validateCss(sel);
    const out = [];
    if (limit === 1) {
      const one = document.querySelector(sel);
      if (one) return [one];
    } else {
      for (const el of document.querySelectorAll(sel)) {
        out.push(el);
        if (out.length >= limit) return out;
      }
    }
    for (const sr of shadowRootsUnder(document.documentElement)) {
      for (const el of sr.querySelectorAll(sel)) {
        out.push(el);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  // `a >>> b >>> c`: each step searches inside the shadow root of the previous
  // match (or its light subtree when it has no shadow root), nested roots included.
  function piercingAll(sel, limit) {
    const parts = sel.split(">>>").map((p) => p.trim());
    if (parts.some((p) => !p)) throw new Error(`Invalid selector: ${sel}`);
    parts.forEach(validateCss);
    let scopes = [document];
    let found = [];
    for (const part of parts) {
      const seen = new Set();
      found = [];
      for (const scope of scopes) {
        const base = scope.nodeType === DOCUMENT_NODE ? scope.documentElement : scope;
        const roots = [scope, ...shadowRootsUnder(base)];
        for (const r of roots) {
          for (const el of r.querySelectorAll(part)) {
            if (!seen.has(el)) {
              seen.add(el);
              found.push(el);
            }
          }
        }
      }
      scopes = found.map((el) => shadowOf(el) || el);
    }
    return found.slice(0, limit);
  }

  const TEXT_SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const INTERACTIVE_SEL =
    "a[href],button,input,select,textarea,label,summary,option," +
    "[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch]";

  function elementText(el) {
    if (el.tagName === "INPUT") {
      const t = (el.type || "").toLowerCase();
      return t === "button" || t === "submit" || t === "reset" ? el.value || "" : "";
    }
    return el.textContent || "";
  }

  // Text of an element excluding script/style children (leaf check only).
  function visibleishText(el) {
    if (el.tagName === "INPUT") return elementText(el);
    let s = "";
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === ELEMENT_NODE && !TEXT_SKIP.has(c.tagName)) s += elementText(c);
    }
    return s;
  }

  // text=Foo  -> case-insensitive substring; text="Foo" -> exact (whitespace-normalized).
  // Returns the deepest elements holding the text (not their wrappers), visible
  // ones and exact matches first, promoted to an interactive ancestor (button,
  // link, ...) when that ancestor carries exactly the same text.
  function textAll(spec, limit) {
    let raw = spec.trim();
    let exact = false;
    const q = /^(["'])([\s\S]*)\1$/.exec(raw);
    if (q) {
      exact = true;
      raw = q[2];
    }
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("text= needs a non-empty text");
    const prep = exact ? (s) => normText(s) : (s) => normText(s).toLowerCase();
    const needle = prep(words.join(" "));
    // Containment is tested on raw text with a whitespace-tolerant regex, so
    // large subtrees are never copied into normalized strings.
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), exact ? "u" : "iu");
    const contains = (s) => re.test(s);
    const hits = [];
    const search = (root) => {
      if (!root) return;
      if (root.nodeType === ELEMENT_NODE && !contains(elementText(root))) return;
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        const kids = [];
        for (const c of node.children) {
          if (TEXT_SKIP.has(c.tagName)) continue;
          if (contains(elementText(c))) kids.push(c);
        }
        if (kids.length) {
          for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        } else if (node.nodeType === ELEMENT_NODE && contains(visibleishText(node))) {
          hits.push(node);
        }
      }
    };
    const roots = [document.body || document.documentElement, ...shadowRootsUnder(document.documentElement)];
    for (const r of roots) search(r);
    // Button-like inputs carry their label in `value`, which no ancestor's
    // textContent includes, so the descent above cannot reach them.
    for (const r of [document, ...roots.slice(1)]) {
      for (const inp of r.querySelectorAll("input[type=submit],input[type=button],input[type=reset]")) {
        if (contains(inp.value || "")) hits.push(inp);
      }
    }

    const seen = new Set();
    const ranked = [];
    hits.forEach((hit, i) => {
      let el = hit;
      try {
        const a = hit.closest(INTERACTIVE_SEL);
        if (a && a !== hit && prep(elementText(a)) === prep(elementText(hit))) el = a;
      } catch {}
      if (seen.has(el)) return;
      seen.add(el);
      const equal = prep(visibleishText(el)) === needle;
      if (exact && !equal) return;
      ranked.push({ el, i, score: (isVisible(el) ? 0 : 2) + (equal ? 0 : 1) });
    });
    ranked.sort((a, b) => a.score - b.score || a.i - b.i);
    return ranked.slice(0, limit).map((x) => x.el);
  }

  // ---------- snapshot / query ----------
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
    const root = document.body || document.documentElement;
    if (!root) return "(empty)";
    const selector = compact
      ? "a,button,input,select,textarea,[role=button],[role=link],[role=textbox],form,h1,h2,h3"
      : "a,button,input,select,textarea,form,h1,h2,h3,h4,p,li,img,div,span,nav,header,main,footer,table,tr,td";
    const limit = compact ? 400 : 1000;
    const out = [];
    let total = 0;
    // Deep walk: elements inside (open or reachable closed) shadow roots are listed too.
    walkDeep(root, (el) => {
      let match = false;
      try {
        match = el.matches(selector);
      } catch {}
      if (match) {
        total++;
        if (out.length < limit) out.push(describe(el));
      }
      return false;
    });
    if (total > limit) out.push(`... (+${total - limit} more items trimmed)`);
    out.unshift(`url=${location.href} title="${document.title}" interactive=${total}`);
    return out.join("\n");
  }

  function queryAll(sel, limit = 20) {
    const n = Math.max(1, Math.min(Number(limit) || 20, 500));
    return findAll(sel, n).map((el) => {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
      return {
        ref: refOf(el),
        tag: (el.tagName || "").toLowerCase(),
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        x: Math.round(r.x || 0),
        y: Math.round(r.y || 0),
        w: Math.round(r.width || 0),
        h: Math.round(r.height || 0),
      };
    });
  }

  // ---------- synthetic pointer / mouse events ----------
  const BUTTON_CODE = { left: 0, middle: 1, right: 2 };
  const BUTTONS_MASK = { 0: 1, 1: 4, 2: 2 };

  function pointFor(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function mouseInit(pt, extra) {
    return Object.assign(
      {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: pt.x,
        clientY: pt.y,
        screenX: pt.x + (window.screenX || 0),
        screenY: pt.y + (window.screenY || 0),
        button: 0,
        buttons: 0,
      },
      extra || {}
    );
  }

  function nonBubbling(init) {
    init.bubbles = false;
    init.cancelable = false;
    init.composed = false;
    return init;
  }

  function fireMouse(el, type, pt, extra) {
    const init = mouseInit(pt, extra);
    if (type === "mouseenter" || type === "mouseleave") nonBubbling(init);
    return el.dispatchEvent(new MouseEvent(type, init));
  }

  function pointerInit(pt, extra) {
    return Object.assign(mouseInit(pt, extra), {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: extra && extra.buttons ? 0.5 : 0,
    });
  }

  function firePointer(el, type, pt, extra) {
    if (typeof PointerEvent !== "function") return true;
    const init = pointerInit(pt, extra);
    if (type === "pointerenter" || type === "pointerleave") nonBubbling(init);
    return el.dispatchEvent(new PointerEvent(type, init));
  }

  // click / auxclick / contextmenu are PointerEvents in Chromium.
  function fireClickLike(el, type, pt, extra) {
    if (typeof PointerEvent === "function") return el.dispatchEvent(new PointerEvent(type, pointerInit(pt, extra)));
    return el.dispatchEvent(new MouseEvent(type, mouseInit(pt, extra)));
  }

  // Hover only: no press, so widgets acting on mousedown/pointerdown stay untouched.
  function hoverSequence(el, pt) {
    firePointer(el, "pointerover", pt);
    firePointer(el, "pointerenter", pt);
    fireMouse(el, "mouseover", pt);
    fireMouse(el, "mouseenter", pt);
    firePointer(el, "pointermove", pt);
    fireMouse(el, "mousemove", pt);
  }

  const FOCUSABLE_SEL =
    "a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]:not([contenteditable='false'])";

  // Default action of an uncancelled mousedown: focus the closest focusable
  // ancestor, or blur the current focus when clicking non-focusable content.
  function mousedownFocus(el) {
    try {
      const f = el.closest ? el.closest(FOCUSABLE_SEL) : null;
      if (f && !f.disabled) {
        if (deepActiveElement() !== f) f.focus({ preventScroll: true });
        return;
      }
      const a = deepActiveElement();
      if (a && a !== document.body && a !== document.documentElement && !containsDeep(a, el) && typeof a.blur === "function") {
        a.blur();
      }
    } catch {}
  }

  function pressRelease(el, pt, b, detail) {
    const mask = BUTTONS_MASK[b] || 1;
    // A cancelled pointerdown suppresses the compatibility mouse events (not click).
    const pd = firePointer(el, "pointerdown", pt, { button: b, buttons: mask });
    let md = true;
    if (pd) md = fireMouse(el, "mousedown", pt, { button: b, buttons: mask, detail });
    if (pd && md) mousedownFocus(el);
    firePointer(el, "pointerup", pt, { button: b, buttons: 0 });
    if (pd) fireMouse(el, "mouseup", pt, { button: b, buttons: 0, detail });
  }

  function clickSequence(el, button = "left", doubleClick = false) {
    const pt = pointFor(el);
    const b = BUTTON_CODE[button] ?? 0;
    hoverSequence(el, pt);
    if (b === 2) {
      pressRelease(el, pt, 2, 1);
      fireClickLike(el, "contextmenu", pt, { button: 2, buttons: 0, detail: 0 });
      return;
    }
    if (b === 1) {
      pressRelease(el, pt, 1, 1);
      fireClickLike(el, "auxclick", pt, { button: 1, buttons: 0, detail: 1 });
      return;
    }
    const clicks = doubleClick ? 2 : 1;
    for (let i = 1; i <= clicks; i++) {
      pressRelease(el, pt, 0, i);
      fireClickLike(el, "click", pt, { button: 0, buttons: 0, detail: i });
    }
    if (doubleClick) fireMouse(el, "dblclick", pt, { button: 0, buttons: 0, detail: 2 });
  }

  // What a real click at the element's centre would hit (diagnostics only).
  function hitWarning(el) {
    try {
      if (el.disabled) return "the element is disabled; browsers ignore clicks on disabled controls";
      const pt = pointFor(el);
      if (pt.x < 0 || pt.y < 0 || pt.x >= window.innerWidth || pt.y >= window.innerHeight) {
        return "the element centre is outside the viewport";
      }
      const top = deepElementFromPoint(pt.x, pt.y);
      if (!top || top === el || containsDeep(el, top) || containsDeep(top, el)) return null;
      return `the element is covered by ${describeShort(top)} at its centre (the synthetic events still went to the element; a real click, e.g. trusted_click, would hit the covering element)`;
    } catch {
      return null;
    }
  }

  function scrollIntoViewCentered(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {
      try {
        el.scrollIntoView({ block: "center" });
      } catch {}
    }
  }

  // ---------- editing helpers ----------
  const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "file", "button", "submit", "reset", "image", "hidden", "range", "color"]);
  // Input types that block implicit submission (HTML spec).
  const BLOCKING_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "date", "month", "week", "time", "datetime-local", "number"]);

  function isValueEditable(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase());
    return false;
  }

  function isTextEditable(el) {
    if (isValueEditable(el)) return !el.disabled && !el.readOnly;
    return !!(el && el.isContentEditable);
  }

  function supportsSelection(el) {
    try {
      return el.selectionStart !== null && el.selectionStart !== undefined;
    } catch {
      return false;
    }
  }

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function fireBeforeInput(el, data, inputType) {
    try {
      return el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, data, inputType }));
    } catch {
      return true;
    }
  }

  function fireInput(el, data, inputType = "insertText") {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data, inputType }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
  }

  function fireChange(el) {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function editingHost(el) {
    try {
      return el.closest("[contenteditable]:not([contenteditable='false'])") || el;
    } catch {
      return el;
    }
  }

  function focusEl(el) {
    try {
      const target = el.isContentEditable ? editingHost(el) : el;
      if (deepActiveElement() !== target) target.focus({ preventScroll: true });
    } catch {}
  }

  function selectContents(el) {
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Put the caret at the end of `el` unless the selection is already inside it.
  function ensureSelectionIn(el) {
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount && containsDeep(el, sel.getRangeAt(0).startContainer)) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Selection/Range fallback when execCommand is unavailable or refused.
  function rangeInsert(el, text) {
    try {
      const sel = window.getSelection();
      if (!sel) return false;
      ensureSelectionIn(el);
      if (!fireBeforeInput(el, text, "insertText")) return true;
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const tn = document.createTextNode(text);
      r.insertNode(tn);
      r.setStartAfter(tn);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      fireInput(el, text, "insertText");
      return true;
    } catch {
      return false;
    }
  }

  // Inserts text at the caret (replacing the selection) like a keystroke would.
  function insertText(el, text, inputType = "insertText") {
    if (isValueEditable(el)) {
      const v = el.value;
      let s = v.length;
      let e = v.length;
      if (supportsSelection(el)) {
        s = el.selectionStart;
        e = el.selectionEnd;
      }
      if (!fireBeforeInput(el, text, inputType)) return false;
      setNativeValue(el, v.slice(0, s) + text + v.slice(e));
      if (supportsSelection(el)) {
        try {
          el.setSelectionRange(s + text.length, s + text.length);
        } catch {}
      }
      fireInput(el, text, inputType);
      return true;
    }
    if (el.isContentEditable) {
      ensureSelectionIn(el);
      let ok = false;
      try {
        ok =
          inputType === "insertLineBreak"
            ? document.execCommand("insertLineBreak")
            : document.execCommand("insertText", false, text);
      } catch {}
      return ok || rangeInsert(el, text);
    }
    return false;
  }

  function deleteText(el, dir) {
    if (isValueEditable(el)) {
      const v = el.value;
      let s = v.length;
      let e = v.length;
      if (supportsSelection(el)) {
        s = el.selectionStart;
        e = el.selectionEnd;
      }
      if (s === e) {
        if (dir < 0) s = Math.max(0, s - 1);
        else e = Math.min(v.length, e + 1);
      }
      if (s === e) return false;
      const inputType = dir < 0 ? "deleteContentBackward" : "deleteContentForward";
      if (!fireBeforeInput(el, null, inputType)) return false;
      setNativeValue(el, v.slice(0, s) + v.slice(e));
      if (supportsSelection(el)) {
        try {
          el.setSelectionRange(s, s);
        } catch {}
      }
      fireInput(el, null, inputType);
      return true;
    }
    if (el.isContentEditable) {
      ensureSelectionIn(el);
      try {
        return document.execCommand(dir < 0 ? "delete" : "forwardDelete");
      } catch {
        return false;
      }
    }
    return false;
  }

  function clearEditable(el) {
    if (isValueEditable(el)) {
      if (el.value === "") return;
      setNativeValue(el, "");
      fireInput(el, null, "deleteContentBackward");
      return;
    }
    if (el.isContentEditable) {
      selectContents(el);
      let ok = false;
      try {
        ok = document.execCommand("delete");
      } catch {}
      // `el` is (inside) the editing host itself, never an arbitrary element.
      if (!ok && el.firstChild) {
        el.textContent = "";
        fireInput(el, null, "deleteContentBackward");
      }
    }
  }

  function checkWritable(el) {
    if (el.disabled) throw new Error(`The ${el.tagName.toLowerCase()} is disabled`);
    if (el.readOnly) throw new Error(`The ${el.tagName.toLowerCase()} is read-only`);
    return el;
  }

  // Resolves the element dom_type writes into. Never falls back to replacing
  // textContent of arbitrary elements (that would wipe page subtrees).
  function editableTarget(el) {
    if (isValueEditable(el) || el.isContentEditable) return checkWritable(el);
    if (el.tagName === "LABEL" && el.control && isValueEditable(el.control)) return checkWritable(el.control);
    // A wrapper (e.g. a design-system input root): use its first editable descendant.
    let inner = null;
    walkDeep(el, (n) => {
      if (n !== el && (isValueEditable(n) || (n.isContentEditable && n.hasAttribute("contenteditable")))) {
        inner = n;
        return true;
      }
      return false;
    });
    if (inner) return checkWritable(inner);
    const tag = (el.tagName || "?").toLowerCase();
    const type = tag === "input" ? (el.type || "").toLowerCase() : "";
    let hint = "";
    if (tag === "select") hint = " (use dom_select)";
    else if (type === "checkbox" || type === "radio") hint = " (use dom_check)";
    else if (type === "file") hint = " (use dom_upload)";
    throw new Error(`Element is not editable: <${tag}${type ? ` type=${type}` : ""}>${hint}; dom_type needs an input, textarea or contenteditable element`);
  }

  // ---------- keyboard ----------
  const NAMED_KEYS = {
    enter: ["Enter", "Enter", 13],
    return: ["Enter", "Enter", 13],
    tab: ["Tab", "Tab", 9],
    escape: ["Escape", "Escape", 27],
    esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8],
    delete: ["Delete", "Delete", 46],
    del: ["Delete", "Delete", 46],
    insert: ["Insert", "Insert", 45],
    arrowup: ["ArrowUp", "ArrowUp", 38],
    up: ["ArrowUp", "ArrowUp", 38],
    arrowdown: ["ArrowDown", "ArrowDown", 40],
    down: ["ArrowDown", "ArrowDown", 40],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37],
    left: ["ArrowLeft", "ArrowLeft", 37],
    arrowright: ["ArrowRight", "ArrowRight", 39],
    right: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36],
    end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33],
    pagedown: ["PageDown", "PageDown", 34],
    space: [" ", "Space", 32],
    spacebar: [" ", "Space", 32],
    shift: ["Shift", "ShiftLeft", 16],
    control: ["Control", "ControlLeft", 17],
    ctrl: ["Control", "ControlLeft", 17],
    alt: ["Alt", "AltLeft", 18],
    meta: ["Meta", "MetaLeft", 91],
    capslock: ["CapsLock", "CapsLock", 20],
    contextmenu: ["ContextMenu", "ContextMenu", 93],
  };

  // -> { key, code, keyCode, char } (char = text the key produces, "" if none)
  function keyInfo(name, mods) {
    if (name === " ") return { key: " ", code: "Space", keyCode: 32, char: " " };
    const named = NAMED_KEYS[name.toLowerCase()];
    if (named) return { key: named[0], code: named[1], keyCode: named[2], char: named[0] === " " ? " " : "" };
    const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(name);
    if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]), char: "" };
    if ([...name].length === 1) {
      let k = name;
      if (/^[a-z]$/i.test(k)) {
        if (mods.shift) k = k.toUpperCase();
        else if (mods.ctrl || mods.meta || mods.alt) k = k.toLowerCase();
      }
      const up = k.toUpperCase();
      const code = /^[a-z]$/i.test(k) ? `Key${up}` : /^[0-9]$/.test(k) ? `Digit${k}` : "";
      const keyCode = /^[a-z0-9]$/i.test(k) ? up.charCodeAt(0) : 0;
      return { key: k, code, keyCode, char: k };
    }
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(name)) return { key: name, code: name, keyCode: 0, char: "" };
    return null;
  }

  const NO_MODS = { ctrl: false, shift: false, alt: false, meta: false };

  // "Ctrl+Shift+a", "control+A", "Meta+Enter", "Shift+Tab", "+", "Ctrl++" ...
  // Modifier names are case-insensitive.
  function parseCombo(spec) {
    const s = String(spec ?? "");
    if (!s) throw new Error("key is required");
    let main;
    let modParts;
    if (s === "+" || s === " ") {
      main = s;
      modParts = [];
    } else if (s.endsWith("++")) {
      main = "+";
      modParts = s.slice(0, -2).split("+");
    } else {
      const parts = s.split("+");
      main = parts.pop();
      modParts = parts;
    }
    const mods = { ...NO_MODS };
    for (const p of modParts) {
      const m = p.trim().toLowerCase();
      if (!m) continue;
      if (m === "ctrl" || m === "control") mods.ctrl = true;
      else if (m === "shift") mods.shift = true;
      else if (m === "alt" || m === "option" || m === "opt") mods.alt = true;
      else if (["meta", "cmd", "command", "win", "windows", "super", "os"].includes(m)) mods.meta = true;
      else throw new Error(`Unknown modifier "${p}" in "${s}" (use Ctrl, Shift, Alt or Meta)`);
    }
    if (main !== " ") main = main.trim() || main;
    const info = keyInfo(main, mods);
    if (!info) throw new Error(`Unsupported key: ${main}`);
    return { mods, info };
  }

  function keyInit(info, mods, extra) {
    return Object.assign(
      {
        key: info.key,
        code: info.code,
        keyCode: info.keyCode,
        which: info.keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        ctrlKey: mods.ctrl,
        shiftKey: mods.shift,
        altKey: mods.alt,
        metaKey: mods.meta,
      },
      extra || {}
    );
  }

  function keypressInit(info, mods) {
    const cc = info.key === "Enter" ? 13 : info.char.codePointAt(0);
    return keyInit(info, mods, { charCode: cc, keyCode: cc, which: cc });
  }

  function defaultSubmitButton(form) {
    for (const el of form.elements) {
      if (el.tagName === "BUTTON" && (el.type || "submit") === "submit") return el;
      if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "image")) return el;
    }
    return null;
  }

  // Constraint problems without firing "invalid" events.
  function invalidFields(form) {
    if (form.noValidate) return [];
    const bad = [];
    for (const el of form.elements) {
      try {
        if (el.willValidate && !el.validity.valid) {
          bad.push(`${el.name || el.id || el.tagName.toLowerCase()}: ${el.validationMessage || "invalid"}`);
        }
      } catch {}
    }
    return bad;
  }

  // Explicit submission (dom_fill submit): click the default submit button like
  // a user would (runs click handlers + validation + submit event), otherwise
  // form.requestSubmit() (submit event + validation), otherwise form.submit().
  function submitForm(form) {
    const bad = invalidFields(form);
    const btn = defaultSubmitButton(form);
    if (btn && btn.disabled) throw new Error("the form's submit button is disabled (the form is probably incomplete or invalid)");
    if (btn) btn.click();
    else if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    const how = btn ? "clicked the submit button" : typeof form.requestSubmit === "function" ? "requestSubmit()" : "submit()";
    if (bad.length) return `blocked by form validation (${how}): ${bad.slice(0, 5).join("; ")}`;
    return `submitted (${how})`;
  }

  // Implicit submission (Enter in a text field), following the HTML rules.
  function implicitSubmit(form) {
    const btn = defaultSubmitButton(form);
    if (btn) {
      if (btn.disabled) return { name: "none", detail: "the form's submit button is disabled" };
      btn.click();
      return { name: "submitted form", detail: "clicked the default submit button" };
    }
    let blocking = 0;
    for (const el of form.elements) {
      if (el.tagName === "INPUT" && BLOCKING_INPUTS.has((el.type || "text").toLowerCase())) blocking++;
    }
    if (blocking > 1) {
      return { name: "none", detail: "the form has no submit button and several text fields, so Enter does not submit it" };
    }
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return { name: "submitted form", detail: "requestSubmit()" };
  }

  function isActivatable(el, key) {
    const tag = el.tagName;
    const type = (el.type || "").toLowerCase();
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    if (tag === "INPUT" && ["button", "submit", "reset", "image"].includes(type)) return true;
    if (key === "Enter") return tag === "A" && el.hasAttribute("href");
    return tag === "INPUT" && (type === "checkbox" || type === "radio");
  }

  function tabOrder() {
    const list = [];
    walkDeep(document.body || document.documentElement, (el) => {
      try {
        if (
          el.tabIndex >= 0 &&
          !el.disabled &&
          !(el.tagName === "INPUT" && (el.type || "").toLowerCase() === "hidden") &&
          isVisible(el)
        ) {
          list.push(el);
        }
      } catch {}
      return false;
    });
    const positive = list.filter((e) => e.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return positive.concat(list.filter((e) => e.tabIndex === 0));
  }

  function moveFocus(dir) {
    const order = tabOrder();
    if (!order.length) return { name: "none", detail: "no focusable elements" };
    const cur = deepActiveElement();
    const i = order.indexOf(cur);
    const next = i === -1 ? (dir > 0 ? order[0] : order[order.length - 1]) : order[(i + dir + order.length) % order.length];
    try {
      next.focus();
      if (isValueEditable(next) && typeof next.select === "function") next.select();
    } catch {}
    return { name: "moved focus", detail: `${describeShort(next)} ref=${refOf(next)}` };
  }

  function selectAllIn(t) {
    try {
      if (isValueEditable(t)) t.select();
      else if (t.isContentEditable) selectContents(editingHost(t));
      else if (document.body) window.getSelection().selectAllChildren(document.body);
      return { name: "selected all" };
    } catch {
      return { name: "none" };
    }
  }

  // Emulates the browser default action of an uncancelled key press. Untrusted
  // key events have no default actions of their own. Returns an action object,
  // or a function for actions that happen after keyup (Space activation).
  function keyDefaultAction(t, info, mods) {
    const k = info.key;
    if (mods.ctrl || mods.meta) {
      if (k.toLowerCase() === "a" && !mods.alt) return selectAllIn(t);
      return { name: "none" };
    }
    if (mods.alt) return { name: "none" };
    if (k === "Tab") return moveFocus(mods.shift ? -1 : 1);
    const editable = isTextEditable(t);
    if (k === "Enter") {
      if (editable && t.tagName === "INPUT") {
        return t.form ? implicitSubmit(t.form) : { name: "none", detail: "the input is not inside a form" };
      }
      if (editable) return insertText(t, "\n", "insertLineBreak") ? { name: "inserted line break" } : { name: "none" };
      if (isActivatable(t, "Enter")) {
        t.click();
        return { name: "clicked", detail: describeShort(t) };
      }
      return { name: "none" };
    }
    if (k === " ") {
      if (editable) return insertText(t, " ") ? { name: "inserted text" } : { name: "none" };
      if (isActivatable(t, " ")) {
        return () => {
          t.click();
          return { name: "clicked", detail: describeShort(t) };
        };
      }
      return { name: "none" };
    }
    if (k === "Backspace" || k === "Delete") {
      if (editable) return deleteText(t, k === "Backspace" ? -1 : 1) ? { name: "deleted text" } : { name: "none" };
      return { name: "none" };
    }
    if (info.char && editable) return insertText(t, info.char) ? { name: "inserted text" } : { name: "none" };
    return { name: "none" };
  }

  // keydown -> keypress (character keys / Enter) -> default action -> keyup.
  function pressKey(target, combo) {
    const { mods, info } = combo;
    const downOk = target.dispatchEvent(new KeyboardEvent("keydown", keyInit(info, mods)));
    let pressOk = downOk;
    const producesChar = (info.char && !mods.ctrl && !mods.meta && !mods.alt) || info.key === "Enter";
    if (downOk && producesChar) pressOk = target.dispatchEvent(new KeyboardEvent("keypress", keypressInit(info, mods)));
    let action = { name: "none" };
    let deferred = null;
    if (downOk && pressOk) {
      const r = keyDefaultAction(target, info, mods);
      if (typeof r === "function") deferred = r;
      else action = r;
    }
    // Focus may have moved (Tab): keyup goes to the newly focused element.
    let upTarget = deepActiveElement();
    if (!upTarget || upTarget === document.body || !upTarget.isConnected) upTarget = target.isConnected ? target : document.body;
    if (upTarget) upTarget.dispatchEvent(new KeyboardEvent("keyup", keyInit(info, mods)));
    if (deferred) action = deferred();
    const out = { defaultPrevented: !downOk || !pressOk, defaultAction: action.name };
    if (action.detail) out.detail = action.detail;
    return out;
  }

  const TRUSTED_KEY_NOTE =
    "No browser default action was emulated for this key (page key handlers did run). If the page relies on native behaviour (shortcuts, clipboard, caret movement, scrolling), use trusted_key for real keyboard input.";

  // ---------- typing ----------
  async function typeText(target, text, { delayMs = 0, clearFirst = false } = {}) {
    focusEl(target);
    if (clearFirst) clearEditable(target);
    if (!(delayMs > 0)) {
      if (isValueEditable(target)) {
        // Fast path keeps the historical semantics: the value becomes `text`.
        setNativeValue(target, text);
        fireInput(target, text, "insertText");
        fireChange(target);
      } else {
        selectContents(target);
        let ok = false;
        try {
          ok = document.execCommand("insertText", false, text);
        } catch {}
        if (!ok && !rangeInsert(target, text)) throw new Error("Could not insert text into the contenteditable element");
      }
      return;
    }
    // Per keystroke. Input types without a selection API (number, email, date...)
    // sanitize partial values ("1." -> ""), so their value is rebuilt from a
    // buffer instead of being read back from the element on every keystroke.
    const buffered = isValueEditable(target) && !supportsSelection(target);
    let buf = buffered ? target.value : "";
    for (const ch of text) {
      if (ch === "\n" && target.tagName === "INPUT") continue; // never submit while typing
      const info = ch === "\n" ? keyInfo("Enter", NO_MODS) : keyInfo(ch, NO_MODS) || { key: ch, code: "", keyCode: 0, char: ch };
      if (ch === "\n") info.char = "\n";
      const downOk = target.dispatchEvent(new KeyboardEvent("keydown", keyInit(info, NO_MODS)));
      let pressOk = downOk;
      if (downOk) pressOk = target.dispatchEvent(new KeyboardEvent("keypress", keypressInit(info, NO_MODS)));
      if (downOk && pressOk) {
        if (buffered) {
          if (fireBeforeInput(target, ch, "insertText")) {
            buf += ch;
            setNativeValue(target, buf);
            fireInput(target, ch, "insertText");
          }
        } else {
          insertText(target, ch, ch === "\n" ? "insertLineBreak" : "insertText");
        }
      }
      target.dispatchEvent(new KeyboardEvent("keyup", keyInit(info, NO_MODS)));
      await sleep(delayMs);
    }
    if (isValueEditable(target)) fireChange(target);
  }

  // ---------- checkbox / radio / select ----------
  async function setChecked(el, want) {
    let input = el;
    if (input.tagName === "LABEL" && input.control) input = input.control;
    const type = input.tagName === "INPUT" ? (input.type || "").toLowerCase() : "";
    if (type === "checkbox" || type === "radio") {
      const target = want === undefined || want === null ? !input.checked : !!want;
      if (input.checked === target) return { checked: input.checked, changed: false };
      if (type === "radio" && !target) {
        throw new Error("A radio button cannot be unchecked directly; check another option of the same group instead");
      }
      if (input.disabled) throw new Error(`The ${type} is disabled`);
      // el.click() flips the state and fires click -> input -> change, the way
      // a user click does; React derives onChange for checkboxes from "click".
      input.click();
      if (input.checked !== target) await sleep(50); // async framework re-render
      if (input.checked !== target) {
        throw new Error(`The page prevented the change (checked is still ${input.checked})`);
      }
      return { checked: input.checked, changed: true };
    }
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (/^(checkbox|switch|radio|menuitemcheckbox|menuitemradio)$/.test(role)) {
      const cur = el.getAttribute("aria-checked") === "true";
      const target = want === undefined || want === null ? !cur : !!want;
      if (cur === target) return { checked: cur, changed: false };
      scrollIntoViewCentered(el);
      clickSequence(el, "left", false);
      await sleep(50);
      const now = el.getAttribute("aria-checked") === "true";
      if (now !== target) {
        throw new Error(`The custom ${role} did not change state (aria-checked=${el.getAttribute("aria-checked")}); try dom_click or trusted_click`);
      }
      return { checked: now, changed: true };
    }
    // A wrapper around one checkbox/radio (e.g. a styled toggle).
    const inner = el.querySelector ? el.querySelector("input[type=checkbox],input[type=radio]") : null;
    if (inner) return setChecked(inner, want);
    throw new Error(`Element is not a checkbox or radio (${describeShort(el)}); use dom_click`);
  }

  function selectOption(el, value) {
    let sel = el;
    if (sel.tagName === "LABEL" && sel.control) sel = sel.control;
    if (sel.tagName !== "SELECT") {
      throw new Error(`Element is not a <select> (${describeShort(sel)}); for custom dropdowns click the trigger and then the option with dom_click`);
    }
    if (sel.disabled) throw new Error("The <select> is disabled");
    const wanted = Array.isArray(value) ? value.map((v) => String(v)) : [String(value ?? "")];
    const opts = Array.from(sel.options);
    const label = (o) => normText(o.label || o.text);
    const pick = (v) => {
      const nv = normText(v);
      return (
        opts.find((o) => o.value === v) ||
        opts.find((o) => label(o) === nv) ||
        opts.find((o) => label(o).toLowerCase() === nv.toLowerCase()) ||
        null
      );
    };
    const chosen = wanted.map((v) => {
      const o = pick(v);
      if (!o) {
        const avail = opts
          .slice(0, 15)
          .map((x) => `${JSON.stringify(x.value)} (${JSON.stringify(label(x))})`)
          .join(", ");
        throw new Error(`No option matches ${JSON.stringify(v)} by value or label. Options: ${avail}${opts.length > 15 ? ", ..." : ""}`);
      }
      if (o.disabled) throw new Error(`Option ${JSON.stringify(v)} is disabled`);
      return o;
    });
    if (chosen.length > 1 && !sel.multiple) throw new Error("Several values were given but the <select> is not multiple");
    if (sel.multiple) {
      for (const o of opts) o.selected = chosen.includes(o);
    } else {
      // Selecting the option itself (not `value`) picks the right one even when
      // several options share a value.
      chosen[0].selected = true;
    }
    sel.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const selected = Array.from(sel.selectedOptions);
    const res = { value: sel.value, label: selected[0] ? label(selected[0]) : "" };
    if (sel.multiple) res.values = selected.map((o) => o.value);
    return res;
  }

  function parseBool(s) {
    const v = String(s).trim().toLowerCase();
    if (["true", "on", "1", "yes", "y", "checked"].includes(v)) return true;
    if (["false", "off", "0", "no", "n", "unchecked", ""].includes(v)) return false;
    return null;
  }

  // All radios of the same group (same name and form owner) as `radio`.
  function radioGroup(radio) {
    if (!radio.name) return [radio];
    const pool = radio.form ? Array.from(radio.form.elements) : Array.from(radio.getRootNode().querySelectorAll("input[type=radio]"));
    return pool.filter((r) => r.tagName === "INPUT" && r.type === "radio" && r.name === radio.name && r.form === radio.form);
  }

  function radioInGroup(radio, value) {
    return radioGroup(radio).find((r) => r.value === value) || null;
  }

  // dom_fill: one field. Returns "ok", "ok (...)" or "error: ..." (never throws).
  async function fillField(el, val) {
    const sval = val === undefined || val === null ? "" : String(val);
    let target = el;
    if (target.tagName === "LABEL" && target.control) target = target.control;
    if (target.tagName === "SELECT") {
      selectOption(target, sval);
      return "ok";
    }
    if (target.tagName === "INPUT") {
      const type = (target.type || "text").toLowerCase();
      if (type === "file") return "error: file inputs cannot be filled with text; use dom_upload";
      if (type === "radio") {
        // Match the group's option values first: groups valued yes/no, 1/0,
        // true/false or on/off are common and must not be read as booleans.
        const byValue = radioInGroup(target, sval);
        if (byValue) {
          await setChecked(byValue, true);
          return "ok";
        }
        const want = parseBool(sval);
        if (want === null) {
          const values = radioGroup(target)
            .slice(0, 15)
            .map((r) => JSON.stringify(r.value))
            .join(", ");
          const group = target.name ? `group "${target.name}"` : "this radio";
          return `error: no radio in ${group} has value ${JSON.stringify(sval)} (values: ${values})`;
        }
        if (!want) return "error: a radio button cannot be unchecked; pass the value of the option to select";
        await setChecked(target, true);
        return "ok";
      }
      if (type === "checkbox") {
        const want = parseBool(sval);
        if (want === null) return "error: expected true/false (on/off, 1/0) for a checkbox";
        await setChecked(target, want);
        return "ok";
      }
      if (["button", "submit", "reset", "image"].includes(type)) return `error: <input type=${type}> is not a fillable field`;
      if (type === "hidden" || type === "range" || type === "color") {
        setNativeValue(target, sval);
        fireInput(target, sval, "insertText");
        fireChange(target);
        return target.value === sval ? "ok" : `ok (the input normalized the value to ${JSON.stringify(target.value)})`;
      }
    }
    const t = editableTarget(target);
    await typeText(t, sval, { delayMs: 0 });
    if (isValueEditable(t) && t.value !== sval) {
      if (sval !== "" && t.value === "") return `error: the input rejected the value (type=${t.type || "text"})`;
      if ((t.type || "").toLowerCase() === "password") return "ok (the input normalized the value)";
      return `ok (the input normalized the value to ${JSON.stringify(t.value.slice(0, 100))})`;
    }
    return "ok";
  }

  // ---------- scrolling ----------
  function scrollPos(t) {
    return t === window ? window.scrollY : t.scrollTop;
  }

  function isScrollableEl(el) {
    try {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      const oy = getComputedStyle(el).overflowY;
      return oy === "auto" || oy === "scroll" || oy === "overlay";
    } catch {
      return false;
    }
  }

  function canScroll(t, down) {
    if (t === window) {
      const se = document.scrollingElement || document.documentElement;
      if (!se) return false;
      return down ? se.scrollHeight - (window.scrollY + window.innerHeight) > 1 : window.scrollY > 0;
    }
    return down ? t.scrollTop + t.clientHeight < t.scrollHeight - 1 : t.scrollTop > 0;
  }

  function applyScroll(t, mode, amount) {
    const height = t === window ? (document.scrollingElement || document.documentElement || {}).scrollHeight || 0 : t.scrollHeight;
    const call = (opts) => {
      if (mode === "top") t.scrollTo(Object.assign({ top: 0 }, opts));
      else if (mode === "bottom") t.scrollTo(Object.assign({ top: height }, opts));
      else t.scrollBy(Object.assign({ top: amount }, opts));
    };
    try {
      call({ behavior: "instant" });
    } catch {
      call({});
    }
  }

  // Candidates: the window, then scrollable ancestors of the element at the
  // viewport centre (inner scroll containers such as Gmail/Slack layouts), then
  // the largest scrollable elements of the page.
  function* scrollCandidates() {
    yield window;
    try {
      let n = deepElementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      for (let i = 0; n && i < 200; i++) {
        if (n.nodeType === ELEMENT_NODE && isScrollableEl(n)) yield n;
        n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
      }
    } catch {}
    const all = [];
    walkDeep(document.body || document.documentElement, (el) => {
      if (el.scrollHeight > el.clientHeight + 1 && isScrollableEl(el) && isVisible(el)) all.push(el);
      return all.length >= 2000;
    });
    all.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    for (const el of all.slice(0, 8)) yield el;
  }

  async function scrollPage(direction, pixels) {
    const mode = direction === "top" || direction === "bottom" ? direction : "by";
    const step = Math.abs(Number(pixels) || 500);
    const amount = direction === "up" ? -step : step;
    const down = direction !== "up" && direction !== "top";
    const tried = new Set();
    for (const t of scrollCandidates()) {
      if (tried.has(t)) continue;
      tried.add(t);
      if (!canScroll(t, down)) continue;
      const before = scrollPos(t);
      applyScroll(t, mode, amount);
      let after = scrollPos(t);
      if (after === before) {
        await sleep(80); // CSS scroll-behavior: smooth
        after = scrollPos(t);
      }
      if (after !== before) return { t, after };
    }
    return null;
  }

  // ---------- drag ----------
  async function dragSynthetic(a, b) {
    scrollIntoViewCentered(a);
    await sleep(30);
    const pa = pointFor(a);
    const pb = pointFor(b);
    let mutated = false;
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        if (!(m.type === "attributes" && m.attributeName === "data-mcp-ref")) {
          mutated = true;
          break;
        }
      }
    });
    if (document.documentElement) {
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    const at = (pt, fallback) => {
      const inView = pt.x >= 0 && pt.y >= 0 && pt.x < window.innerWidth && pt.y < window.innerHeight;
      return (inView && deepElementFromPoint(pt.x, pt.y)) || fallback;
    };
    let dragSrc = null;
    try {
      dragSrc = a.closest("[draggable=true]") || (a.draggable ? a : null);
    } catch {}
    let dropAccepted = null;
    hoverSequence(a, pa);
    const pd = firePointer(a, "pointerdown", pa, { button: 0, buttons: 1 });
    if (pd && fireMouse(a, "mousedown", pa, { button: 0, buttons: 1, detail: 1 })) mousedownFocus(a);
    const steps = 6;
    if (dragSrc) {
      // HTML5 drag-and-drop: after dragstart, the browser sends drag events only.
      const first = { x: pa.x + Math.sign(pb.x - pa.x || 1) * 6, y: pa.y + Math.sign(pb.y - pa.y || 1) * 6 };
      firePointer(a, "pointermove", first, { buttons: 1 });
      if (pd) fireMouse(a, "mousemove", first, { buttons: 1 });
      const dt = new DataTransfer();
      const dragInit = (pt, extra) => Object.assign(mouseInit(pt, { buttons: 1 }), { dataTransfer: dt }, extra || {});
      const started = dragSrc.dispatchEvent(new DragEvent("dragstart", dragInit(pa)));
      dropAccepted = false;
      if (started) {
        firePointer(a, "pointercancel", first, { buttons: 0 });
        let over = null;
        for (let i = 1; i <= steps; i++) {
          const pt = { x: pa.x + ((pb.x - pa.x) * i) / steps, y: pa.y + ((pb.y - pa.y) * i) / steps };
          const cur = i === steps ? b : at(pt, a);
          dragSrc.dispatchEvent(new DragEvent("drag", dragInit(pt)));
          if (cur !== over) {
            cur.dispatchEvent(new DragEvent("dragenter", dragInit(pt)));
            if (over) over.dispatchEvent(new DragEvent("dragleave", dragInit(pt)));
            over = cur;
          }
          // A drop target accepts the drop by cancelling dragover.
          const accepted = !cur.dispatchEvent(new DragEvent("dragover", dragInit(pt)));
          if (cur === b) dropAccepted = accepted;
          await sleep(16);
        }
        if (dropAccepted) b.dispatchEvent(new DragEvent("drop", dragInit(pb)));
        else b.dispatchEvent(new DragEvent("dragleave", dragInit(pb)));
        dragSrc.dispatchEvent(new DragEvent("dragend", dragInit(pb, { buttons: 0 })));
      } else {
        firePointer(a, "pointerup", pa, { button: 0, buttons: 0 });
        if (pd) fireMouse(a, "mouseup", pa, { button: 0, buttons: 0, detail: 1 });
      }
    } else {
      // Pointer/mouse based libraries (dnd-kit, SortableJS fallback, sliders...).
      for (let i = 1; i <= steps; i++) {
        const pt = { x: pa.x + ((pb.x - pa.x) * i) / steps, y: pa.y + ((pb.y - pa.y) * i) / steps };
        const cur = at(pt, i === steps ? b : a);
        firePointer(cur, "pointermove", pt, { buttons: 1 });
        if (pd) fireMouse(cur, "mousemove", pt, { buttons: 1 });
        await sleep(16);
      }
      const end = at(pb, b);
      firePointer(end, "pointerup", pb, { button: 0, buttons: 0 });
      if (pd) fireMouse(end, "mouseup", pb, { button: 0, buttons: 0, detail: 1 });
    }
    // Wait briefly for the page to react.
    for (let i = 0; i < 10 && !mutated; i++) await sleep(30);
    mo.disconnect();
    const res = { ok: true, mode: dragSrc ? "html5" : "pointer", domChanged: mutated };
    if (dropAccepted !== null) res.dropAccepted = dropAccepted;
    if (!mutated) {
      res.warning = "No DOM change was observed after the synthetic drag; if nothing moved, use trusted_drag (real mouse input)";
    }
    return res;
  }

  // ---------- page_wait ----------
  const MAX_WAIT_MS = 7200000;
  const READY_RANK = { loading: 0, interactive: 1, complete: 2 };

  async function pageWait(payload) {
    const timeout = Math.min(Math.max(Number(payload.timeoutMs) || 15000, 0), MAX_WAIT_MS);
    const t0 = Date.now();
    // Validate up front so a typo fails fast instead of timing out.
    if (payload.selector) findAll(payload.selector, 1); // throws on invalid syntax / stale refs
    let re = null;
    if (payload.urlPattern) {
      try {
        re = new RegExp(payload.urlPattern);
      } catch (e) {
        throw new Error(`Invalid urlPattern: ${(e && e.message) || e}`);
      }
    }
    if (payload.readyState && !(payload.readyState in READY_RANK)) {
      throw new Error(`Invalid readyState: ${payload.readyState} (use loading, interactive or complete)`);
    }
    const check = () => {
      if (payload.url && !location.href.includes(payload.url)) return false;
      if (re && !re.test(location.href)) return false;
      // Ordered: waiting for "interactive" is satisfied by "complete" as well.
      if (payload.readyState && READY_RANK[document.readyState] < READY_RANK[payload.readyState]) return false;
      if (payload.selector) {
        let el = null;
        try {
          el = findOne(payload.selector);
        } catch {}
        if (!el) return false;
      }
      if (payload.text && !(document.body?.innerText || "").includes(payload.text)) return false;
      return true;
    };
    const hasCondition = !!(payload.selector || payload.text || payload.url || payload.urlPattern || payload.readyState);
    if (hasCondition && check()) return { ok: true, waitedMs: Date.now() - t0 };

    const outcome = await new Promise((resolve) => {
      let done = false;
      let timer = null;
      let interval = null;
      let pending = null;
      let observer = null;
      let lastCheck = 0;
      const onHide = () => finish("unloaded");
      const onState = () => schedule();
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(interval);
        clearTimeout(pending);
        if (observer) observer.disconnect();
        window.removeEventListener("pagehide", onHide, true);
        document.removeEventListener("readystatechange", onState);
        resolve(v);
      }
      function run() {
        pending = null;
        lastCheck = Date.now();
        try {
          if (check()) finish("ok");
        } catch {}
      }
      // Throttled re-check (busy pages mutate constantly; text= and innerText are not free).
      function schedule() {
        if (done || pending) return;
        pending = setTimeout(run, Math.max(0, 100 - (Date.now() - lastCheck)));
      }
      timer = setTimeout(() => finish(hasCondition ? "timeout" : "ok"), timeout);
      // The document going away (navigation) ends the wait with a clean error;
      // the background re-runs URL/readyState waits on the new document.
      window.addEventListener("pagehide", onHide, true);
      if (!hasCondition) return;
      document.addEventListener("readystatechange", onState);
      if (typeof MutationObserver === "function" && document.documentElement) {
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: !!payload.selector,
          characterData: !!payload.text,
        });
      }
      interval = setInterval(schedule, 250);
    });
    if (outcome === "unloaded") {
      throw new Error("page_wait: document unloaded (navigation) before the condition was met");
    }
    if (outcome === "timeout") throw new Error(`Timed out: expected condition never appeared (after ${timeout} ms)`);
    return { ok: true, waitedMs: Date.now() - t0 };
  }

  // ---------- console / dialog relay (MAIN world -> background) ----------
  // The MAIN-world hooks post { __mcpConsole } / { __mcpDialog } to this window.
  // Only same-window messages with the expected shape are relayed, strings are
  // capped, url/ts come from this frame, and the rate is limited per frame.
  const RELAY_MAX_PER_SEC = 200;
  const CONSOLE_LEVELS = new Set(["log", "info", "warn", "error", "debug", "trace"]);
  const DIALOG_KINDS = new Set(["alert", "confirm", "prompt", "beforeunload"]);
  let relayWindowStart = 0;
  let relayCount = 0;

  function relayAllowed() {
    const now = Date.now();
    if (now - relayWindowStart >= 1000) {
      relayWindowStart = now;
      relayCount = 0;
    }
    return ++relayCount <= RELAY_MAX_PER_SEC;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v) && Object.prototype.toString.call(v) === "[object Object]";
  }

  const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const frameUrl = () => cap(String(location.href || ""), 2048);

  function sanitizeConsole(e) {
    if (!isPlainObject(e)) return null;
    if (typeof e.level !== "string" || !CONSOLE_LEVELS.has(e.level)) return null;
    if (typeof e.text !== "string") return null;
    return { level: e.level, text: cap(e.text, 4000), url: frameUrl(), ts: Date.now() };
  }

  function sanitizeDialog(e) {
    if (!isPlainObject(e)) return null;
    if (typeof e.kind !== "string" || !DIALOG_KINDS.has(e.kind)) return null;
    if (typeof e.message !== "string") return null;
    let response = null;
    if (typeof e.response === "string") response = cap(e.response, 4000);
    else if (typeof e.response === "boolean") response = e.response;
    return { kind: e.kind, message: cap(e.message, 4000), url: frameUrl(), ts: Date.now(), response };
  }

  window.addEventListener("message", (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!isPlainObject(d)) return;
      let type;
      let entry;
      if (d.__mcpConsole !== undefined) {
        type = "mcp-console";
        entry = sanitizeConsole(d.__mcpConsole);
      } else if (d.__mcpDialog !== undefined) {
        type = "mcp-dialog";
        entry = sanitizeDialog(d.__mcpDialog);
      } else {
        return;
      }
      if (!entry || !relayAllowed()) return;
      chrome.runtime.sendMessage({ type, entry }).catch(() => {});
    } catch {}
  });

  // ---------- IndexedDB helpers (static code: no eval, CSP-safe) ----------
  // Opening a database that does not exist would silently create it (empty,
  // version 1) and break the site's own schema upgrade later. So: check
  // indexedDB.databases() first, and abort the version-change transaction of a
  // brand-new database (oldVersion 0), which discards it.
  async function idbOpen(name) {
    if (typeof name !== "string" || !name) throw new Error("db (database name) is required; see idb_list");
    const notFound = () => new Error(`IndexedDB database not found: ${name} (see idb_list)`);
    if (typeof indexedDB.databases === "function") {
      let dbs = null;
      try {
        dbs = await indexedDB.databases();
      } catch {}
      // Version 0 = a database whose creation was aborted; it does not exist.
      if (dbs && !dbs.some((d) => d && d.name === name && d.version !== 0)) throw notFound();
    }
    return await new Promise((res, rej) => {
      let created = false;
      let req;
      try {
        req = indexedDB.open(name);
      } catch (e) {
        rej(e);
        return;
      }
      req.onupgradeneeded = (e) => {
        if (e.oldVersion === 0) {
          created = true;
          try {
            req.transaction.abort();
          } catch {}
          // Never keep a connection that would block the site's own upgrade.
          try {
            req.result.close();
          } catch {}
        }
      };
      req.onsuccess = () => {
        if (created) {
          try {
            req.result.close();
          } catch {}
          rej(notFound());
          return;
        }
        res(req.result);
      };
      req.onerror = (e) => {
        try {
          e.preventDefault();
        } catch {}
        rej(created ? notFound() : req.error || new Error("open failed"));
      };
      req.onblocked = () => rej(new Error("open blocked by another connection"));
    });
  }

  function requireStore(db, store) {
    if (typeof store !== "string" || !store) throw new Error("store (object store name) is required; see idb_stores");
    if (!db.objectStoreNames.contains(store)) {
      throw new Error(`Object store not found: ${store} (stores: ${Array.from(db.objectStoreNames).join(", ") || "none"})`);
    }
  }

  // Structured, JSON-safe preview with a size budget (never "[object Object]").
  const PREVIEW_STR = 2000;
  const PREVIEW_ROW_BUDGET = 20000;

  function previewValue(v, budget, depth, stack) {
    if (v === null || v === undefined) {
      budget.left -= 4;
      return null;
    }
    const t = typeof v;
    if (t === "string") {
      if (v.length > PREVIEW_STR) {
        budget.cut = true;
        budget.left -= PREVIEW_STR;
        return `${v.slice(0, PREVIEW_STR)}…(+${v.length - PREVIEW_STR} chars)`;
      }
      budget.left -= v.length + 2;
      return v;
    }
    if (t === "number") {
      budget.left -= 8;
      return Number.isFinite(v) ? v : String(v);
    }
    if (t === "boolean") {
      budget.left -= 5;
      return v;
    }
    if (t === "bigint") {
      budget.left -= 12;
      return `${v}n`;
    }
    if (t !== "object") return String(v);
    const tag = Object.prototype.toString.call(v).slice(8, -1);
    if (tag === "Date") {
      budget.left -= 26;
      return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    }
    if (tag === "RegExp") return String(v);
    if (tag === "Blob" || tag === "File") {
      budget.left -= 60;
      const o = { __type: tag, size: v.size, type: v.type };
      if (tag === "File") o.name = v.name;
      return o;
    }
    if (tag === "ArrayBuffer" || ArrayBuffer.isView(v)) {
      budget.left -= 40;
      return { __type: tag, byteLength: v.byteLength };
    }
    if (stack.includes(v)) return "[circular]";
    if (depth >= 8) {
      budget.cut = true;
      return "[max depth]";
    }
    stack.push(v);
    try {
      if (tag === "Map" || tag === "Set") {
        const items = [];
        let i = 0;
        for (const item of v) {
          if (budget.left <= 0) {
            budget.cut = true;
            items.push(`…(+${v.size - i} more)`);
            break;
          }
          items.push(tag === "Map" ? [previewValue(item[0], budget, depth + 1, stack), previewValue(item[1], budget, depth + 1, stack)] : previewValue(item, budget, depth + 1, stack));
          i++;
        }
        return tag === "Map" ? { __type: "Map", size: v.size, entries: items } : { __type: "Set", size: v.size, values: items };
      }
      if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length; i++) {
          if (budget.left <= 0) {
            budget.cut = true;
            out.push(`…(+${v.length - i} more items)`);
            break;
          }
          out.push(previewValue(v[i], budget, depth + 1, stack));
        }
        return out;
      }
      const out = {};
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) {
        if (budget.left <= 0) {
          budget.cut = true;
          out["…"] = `+${keys.length - i} more keys`;
          break;
        }
        budget.left -= keys[i].length + 4;
        out[keys[i]] = previewValue(v[keys[i]], budget, depth + 1, stack);
      }
      return out;
    } finally {
      stack.pop();
    }
  }

  function idbSafe(v) {
    const budget = { left: PREVIEW_ROW_BUDGET, cut: false };
    try {
      return { value: previewValue(v, budget, 0, []), cut: budget.cut };
    } catch {
      return { value: "(unserializable)", cut: true };
    }
  }

  // ---------- network_refetch ----------
  async function readBodyCapped(res, maxBytes) {
    if (!res.body || typeof res.body.getReader !== "function") {
      const text = await res.text();
      return { text, cut: false };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let cut = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        cut = true;
        try {
          await reader.cancel();
        } catch {}
        break;
      }
    }
    const buf = new Uint8Array(Math.min(total, maxBytes));
    let off = 0;
    for (const c of chunks) {
      const n = Math.min(c.byteLength, buf.length - off);
      buf.set(c.subarray(0, n), off);
      off += n;
      if (off >= buf.length) break;
    }
    return { text: new TextDecoder().decode(buf), cut };
  }

  // ---------- commands ----------
  async function runCommand(cmd, payload) {
    switch (cmd) {
      case "page_snapshot":
        return snapshot(payload.compact !== false);
      case "page_html":
        return (document.documentElement?.outerHTML || "").slice(0, 500000);
      case "page_text":
        return (document.body?.innerText || "").slice(0, 100000);
      case "dom_query":
        return queryAll(payload.selector, payload.limit);
      case "scroll_into_view": {
        const el = requireOne(payload.selector);
        scrollIntoViewCentered(el);
        await sleep(50);
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const top = (() => {
          try {
            return deepElementFromPoint(cx, cy);
          } catch {
            return null;
          }
        })();
        return {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
          cx,
          cy,
          inViewport: r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          visible: isVisible(el),
          hit: !!top && (top === el || containsDeep(el, top) || containsDeep(top, el)),
          ref: refOf(el),
          tag: (el.tagName || "").toLowerCase(),
          topFrame: window === window.top,
        };
      }
      case "dom_click": {
        const el = requireOne(payload.selector);
        scrollIntoViewCentered(el);
        await sleep(80);
        const warning = hitWarning(el);
        clickSequence(el, payload.button || "left", !!payload.doubleClick);
        const res = { ok: true, ref: refOf(el) };
        if (warning) res.warning = warning;
        return res;
      }
      case "dom_type": {
        const el = requireOne(payload.selector);
        const target = editableTarget(el);
        scrollIntoViewCentered(target);
        await typeText(target, payload.text == null ? "" : String(payload.text), {
          delayMs: Number(payload.delayMs) || 0,
          clearFirst: !!payload.clearFirst,
        });
        const res = { ok: true, ref: refOf(target) };
        if (target !== el) res.typedInto = describeShort(target);
        if (payload.pressEnter) {
          if (target.isConnected) focusEl(target);
          const enter = pressKey(target.isConnected ? target : deepActiveElement() || document.body, parseCombo("Enter"));
          res.enter = enter;
          if (enter.defaultAction === "none" && !enter.defaultPrevented) res.note = TRUSTED_KEY_NOTE;
        }
        return res;
      }
      case "dom_fill": {
        const out = {};
        let form = null;
        for (const [sel, val] of Object.entries(payload.fields || {})) {
          let el = null;
          try {
            el = findOne(sel);
          } catch (e) {
            out[sel] = `error: ${(e && e.message) || e}`;
            continue;
          }
          if (!el) {
            out[sel] = "not-found";
            continue;
          }
          try {
            out[sel] = await fillField(el, val);
          } catch (e) {
            out[sel] = `error: ${(e && e.message) || e}`;
          }
          if (!form) {
            const ctl = el.tagName === "LABEL" && el.control ? el.control : el;
            form = ctl.form || (ctl.closest ? ctl.closest("form") : null);
          }
        }
        if (payload.submit) {
          // Only the form of a filled field; never some unrelated form on the page.
          if (!form) out._submit = "error: none of the filled fields is inside a form";
          else {
            try {
              out._submit = submitForm(form);
            } catch (e) {
              out._submit = `error: ${(e && e.message) || e}`;
            }
          }
        }
        return out;
      }
      case "dom_select": {
        const el = requireOne(payload.selector);
        const r = selectOption(el, payload.value);
        return Object.assign({ ok: true }, r);
      }
      case "dom_check": {
        const el = requireOne(payload.selector);
        const r = await setChecked(el, payload.checked);
        return { ok: true, checked: r.checked, changed: r.changed };
      }
      case "dom_hover": {
        const el = requireOne(payload.selector);
        scrollIntoViewCentered(el);
        await sleep(50);
        hoverSequence(el, pointFor(el));
        return { ok: true, ref: refOf(el) };
      }
      case "dom_focus": {
        const el = requireOne(payload.selector);
        el.focus();
        return { ok: true, focused: deepActiveElement() === el };
      }
      case "dom_scroll": {
        if (payload.selector) {
          const el = requireOne(payload.selector);
          scrollIntoViewCentered(el);
          return { ok: true, y: window.scrollY, ref: refOf(el) };
        }
        const r = await scrollPage(payload.direction || "down", payload.pixels);
        if (!r) {
          return {
            ok: true,
            moved: false,
            y: window.scrollY,
            note: "Nothing scrolled: already at the edge, or no scrollable area was found",
          };
        }
        const res = { ok: true, moved: true, target: r.t === window ? "window" : describeShort(r.t), y: Math.round(r.after) };
        if (r.t !== window) res.ref = refOf(r.t);
        return res;
      }
      case "dom_drag": {
        const a = requireOne(payload.from);
        const b = requireOne(payload.to);
        return await dragSynthetic(a, b);
      }
      case "keyboard_press": {
        const combo = parseCombo(payload.key);
        const target = deepActiveElement() || document.body || document.documentElement;
        const r = pressKey(target, combo);
        const res = Object.assign({ ok: true, key: String(payload.key) }, r);
        if (r.defaultAction === "none" && !r.defaultPrevented) res.note = TRUSTED_KEY_NOTE;
        return res;
      }
      case "page_find": {
        const q = String(payload.text || "").toLowerCase();
        if (!q) throw new Error("text is required");
        const body = (document.body?.innerText || "").toLowerCase();
        const idx = body.indexOf(q);
        if (idx === -1) return { found: false, count: 0 };
        const count = body.split(q).length - 1;
        // scroll to the first match
        if (document.body) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            if ((n.nodeValue || "").toLowerCase().includes(q) && n.parentElement) {
              n.parentElement.scrollIntoView({ block: "center" });
              break;
            }
          }
        }
        return { found: true, count, firstIndex: idx };
      }
      case "page_wait":
        return await pageWait(payload);
      case "js_evaluate":
        // CSP-safe stub: real evaluation happens in background via CDP
        // Runtime.evaluate. Never use eval/new Function here (violates
        // the extension CSP which lacks 'unsafe-eval').
        throw new Error("js_evaluate is handled via CDP in background (update extension)");
      case "storage_get": {
        const areaName = payload.area === "session" ? "session" : "local";
        const area = areaName === "session" ? sessionStorage : localStorage;
        const full = payload.full === true;
        const data = {};
        const truncated = {};
        for (let i = 0; i < area.length; i++) {
          const k = area.key(i);
          if (k === null) continue;
          const v = area.getItem(k) ?? "";
          if (!full && v.length > 2000) {
            data[k] = v.slice(0, 2000);
            truncated[k] = v.length;
          } else {
            data[k] = v;
          }
        }
        const res = { url: location.href, area: areaName, data };
        if (Object.keys(truncated).length) {
          res.truncated = truncated;
          res.note = "Values longer than 2000 chars were truncated for display (truncated: key -> full length); pass full:true for complete values";
        }
        return res;
      }
      case "storage_set": {
        const area = payload.area === "session" ? sessionStorage : localStorage;
        if (typeof payload.key !== "string") throw new Error("key is required");
        area.setItem(payload.key, String(payload.value ?? ""));
        return { ok: true };
      }
      case "idb_list": {
        if (!indexedDB.databases) return { supported: false, databases: [] };
        const dbs = await indexedDB.databases();
        return {
          supported: true,
          databases: (dbs || []).map((d) => ({ name: d.name, version: d.version })),
        };
      }
      case "idb_stores": {
        const db = await idbOpen(payload.db);
        try {
          return { db: payload.db, version: db.version, stores: Array.from(db.objectStoreNames) };
        } finally {
          db.close();
        }
      }
      case "idb_count": {
        const db = await idbOpen(payload.db);
        try {
          requireStore(db, payload.store);
          const n = await new Promise((res, rej) => {
            const tx = db.transaction(payload.store, "readonly");
            const q = tx.objectStore(payload.store).count();
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          });
          return { db: payload.db, store: payload.store, count: n };
        } finally {
          db.close();
        }
      }
      case "idb_read": {
        const db = await idbOpen(payload.db);
        try {
          requireStore(db, payload.store);
          const limit = Math.max(1, Math.min(Number(payload.limit) || 50, 1000));
          const rows = await new Promise((res, rej) => {
            const tx = db.transaction(payload.store, "readonly");
            const q =
              payload.key !== undefined
                ? tx.objectStore(payload.store).get(payload.key)
                : tx.objectStore(payload.store).getAll(null, limit);
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          });
          const list = (Array.isArray(rows) && payload.key === undefined ? rows : [rows]).filter((r) => r !== undefined);
          let cut = false;
          const out = list.map((r) => {
            const p = idbSafe(r);
            if (p.cut) cut = true;
            return p.value;
          });
          const res = { db: payload.db, store: payload.store, rows: out };
          if (cut) {
            res.truncated = true;
            res.note = "Large rows were shortened for display (strings over 2000 chars, about 20 KB per row)";
          }
          return res;
        } finally {
          db.close();
        }
      }
      case "idb_put": {
        const db = await idbOpen(payload.db);
        try {
          requireStore(db, payload.store);
          const key = await new Promise((res, rej) => {
            const tx = db.transaction(payload.store, "readwrite");
            const q =
              payload.key !== undefined
                ? tx.objectStore(payload.store).put(payload.value, payload.key)
                : tx.objectStore(payload.store).put(payload.value);
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          });
          return { ok: true, key };
        } finally {
          db.close();
        }
      }
      case "idb_delete": {
        const db = await idbOpen(payload.db);
        try {
          requireStore(db, payload.store);
          await new Promise((res, rej) => {
            const tx = db.transaction(payload.store, "readwrite");
            const q = tx.objectStore(payload.store).delete(payload.key);
            q.onsuccess = () => res(0);
            q.onerror = () => rej(q.error);
          });
          return { ok: true };
        } finally {
          db.close();
        }
      }
      case "idb_clear": {
        const db = await idbOpen(payload.db);
        try {
          requireStore(db, payload.store);
          await new Promise((res, rej) => {
            const tx = db.transaction(payload.store, "readwrite");
            const q = tx.objectStore(payload.store).clear();
            q.onsuccess = () => res(0);
            q.onerror = () => rej(q.error);
          });
          return { ok: true };
        } finally {
          db.close();
        }
      }
      case "network_refetch": {
        // Re-issues the request as a credentialed GET in the page context.
        // Only GET is ever re-sent: replaying POST/PUT/... would repeat side effects.
        const method = String(payload.method || "GET").toUpperCase();
        if (method !== "GET") {
          throw new Error(`network_refetch only re-issues GET requests (recorded method: ${method})`);
        }
        let u;
        try {
          u = new URL(String(payload.url || ""), location.href);
        } catch {
          throw new Error(`Invalid URL: ${payload.url}`);
        }
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Only http(s) URLs can be re-fetched: ${u.protocol}`);
        const res = await fetch(u.href, { method: "GET", credentials: "include" });
        const body = await readBodyCapped(res, 512 * 1024);
        return {
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          bodySnippet: body.text.slice(0, 20000),
          truncated: body.cut || body.text.length > 20000,
          method: "GET",
        };
      }
      case "__ping":
        return { pong: true };
      default:
        throw new Error(`Unknown content command: ${cmd}`);
    }
  }

  // ---------- message router ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__mcp == null) return false;
    // Legacy sticky-frame filter: the background now targets frames by frameId,
    // but older senders may still pass a URL substring.
    if (msg.__frameUrl && !(location.href || "").includes(msg.__frameUrl)) return false;
    (async () => {
      let reply;
      try {
        const result = await runCommand(msg.cmd, msg.payload && typeof msg.payload === "object" ? msg.payload : {});
        reply = { ok: true, result };
      } catch (e) {
        reply = { ok: false, error: String((e && e.message) || e) };
      }
      try {
        sendResponse(reply);
      } catch {}
    })();
    return true;
  });
})();
