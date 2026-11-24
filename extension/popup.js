// Popup: status + category-based permission switches.
// Single source is PERM_CATS in background; state syncs via chrome.storage.

// Disable default right-click context menu (prevents "Inspect" in popup)
document.addEventListener("contextmenu", (e) => e.preventDefault());

const $ = (s) => document.querySelector(s);
const t = (k, def) => (typeof I18N !== "undefined" ? I18N.t(k, def) : def);
let CATS = [];
let disabled = new Set();
let openCat = null;
// Number of permission writes in flight; storage echoes are ignored meanwhile
// because the write's own response carries the authoritative state.
let pendingPermWrites = 0;
let lastExtensionId = "";

async function bg(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Small DOM helper: every dynamic value goes through textContent (never innerHTML).
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function switchEl(on, onChange) {
  const l = document.createElement("label");
  l.className = "sw";
  const inp = document.createElement("input");
  inp.type = "checkbox";
  inp.checked = on;
  inp.addEventListener("change", (e) => {
    e.stopPropagation();
    onChange(inp.checked);
  });
  l.appendChild(inp);
  const i = document.createElement("i");
  l.appendChild(i);
  l.addEventListener("click", (e) => e.stopPropagation());
  return { el: l, set: (v) => { inp.checked = v; } };
}

let currentPort = 8765;

function extensionId() {
  return lastExtensionId || (chrome.runtime && chrome.runtime.id) || "";
}

function updateVer(port) {
  const v = chrome.runtime.getManifest().version;
  const ver = $("#ver");
  if (!ver) return;
  ver.textContent = `v${v} · 127.0.0.1:${port}`;
  const id = extensionId();
  ver.title = id ? `${t("extensionIdLabel", "Extension ID")}: ${id}` : "";
}

// Bridge pairing states reported by the background (mcp-status.pairState, protocol v3).
const PAIR_STATES = new Set(["none", "handshake", "paired", "repair-offered", "pairing-closed", "server-auth-failed", "auth-failed", "protocol-mismatch"]);
// States that need the user's attention; each one is explained in the notice box.
const PAIR_PROBLEMS = new Set(["repair-offered", "pairing-closed", "server-auth-failed", "auth-failed", "protocol-mismatch"]);
// States whose remedy involves the server's extension-keys.json.
const KEYS_FILE_STATES = new Set(["pairing-closed", "server-auth-failed", "auth-failed"]);
// The background keeps a Re-pair armed for 2 minutes; the button only shows a short
// waiting label so a failed attempt can be retried without reopening the popup.
const REPAIR_FEEDBACK_MS = 8000;
// "Forget pairing" needs a second click within this window (confirm() is unreliable in popups).
const FORGET_CONFIRM_MS = 4000;
let repairPendingUntil = 0;
let forgetArmedUntil = 0;
let forgetTimer = null;

// Writes only on change: the status poll runs every 2 s and the notice is role="alert",
// so rewriting identical text would make screen readers announce it again.
function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function lastCloseOf(r) {
  const lc = r && r.lastClose && typeof r.lastClose === "object" ? r.lastClose : null;
  if (!lc) return null;
  return {
    code: Number(lc.code) || 0,
    reason: typeof lc.reason === "string" ? lc.reason.slice(0, 200) : "",
  };
}

// Problem states win even while a retry socket is open, so the explanation stays put.
// "paired"/"handshake" need an open socket; a background without pairState (older
// build) is mapped from its `paired` flag.
function pairStateOf(r) {
  const s = r && typeof r.pairState === "string" && PAIR_STATES.has(r.pairState) ? r.pairState : "";
  if (PAIR_PROBLEMS.has(s)) return s;
  if (!r || !r.bridgeConnected) return "none";
  if (s === "paired" || s === "handshake") return s;
  return r.paired === true ? "paired" : "handshake";
}

// serverVersion comes from the peer: rendered via textContent only, and anything
// that does not look like a version string is not shown at all.
function serverVersionOf(r) {
  const v = r && typeof r.serverVersion === "string" ? r.serverVersion.trim().replace(/^v/i, "") : "";
  return /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : "";
}

// Which side to update. The server's 4002 reason carries both protocol numbers
// ("protocol-mismatch:server=3,ext=2"); 4102 "server-outdated" is the extension
// refusing a server that answered without the v3 handshake.
function protocolAdvice(lc) {
  if (lc && (lc.code === 4102 || /server-outdated/.test(lc.reason))) return "server";
  const m = lc ? /server=(\d+)\D+ext=(\d+)/.exec(lc.reason) : null;
  if (m) {
    const srv = Number(m[1]);
    const ext = Number(m[2]);
    if (srv > ext) return "extension";
    if (srv < ext) return "server";
  }
  return "both";
}

function setRepairLabel() {
  const b = $("#repairBtn");
  if (!b) return;
  const pending = Date.now() < repairPendingUntil;
  b.disabled = pending;
  setText(b, pending ? t("btnRepairing", "Waiting for the server…") : t("btnRepair", "Re-pair"));
}

function setForgetLabel() {
  const b = $("#forgetPair");
  if (!b) return;
  const armed = Date.now() < forgetArmedUntil;
  b.classList.toggle("armed", armed);
  setText(b, armed ? t("btnForgetConfirm", "Click again to forget") : t("btnForgetPairing", "Forget pairing"));
}

function setPill(tone, label, title = "") {
  const pill = $("#pill");
  if (pill) {
    pill.className = "badge " + tone;
    // The label may be cut with an ellipsis in long locales; the tooltip keeps it readable.
    pill.title = title || label;
  }
  setText($("#pillTx"), label);
}

function updatePill(r, state) {
  const lc = lastCloseOf(r);
  const code = lc ? lc.code : 0;
  const ver = serverVersionOf(r);
  switch (state) {
    case "paired":
      setPill(
        "on",
        t("statusConnected", "Connected"),
        t("statusPairedTitle", "Paired with the MCP server") + (ver ? ` · ${t("serverVersionLabel", "Server")} v${ver}` : ""),
      );
      return;
    case "handshake":
      setPill("wait", t("statusConnecting", "Connecting…"), t("statusHandshakeTitle", "Connected, waiting for the MCP server handshake"));
      return;
    case "repair-offered":
      setPill("wait", t("statusActionNeeded", "Action needed"));
      return;
    case "server-auth-failed":
      setPill("off", t("statusUntrustedServer", "Unverified server"));
      return;
    case "protocol-mismatch":
      setPill("off", t("statusUpdateNeeded", "Update needed"));
      return;
    case "pairing-closed":
    case "auth-failed":
      setPill("off", t("statusRejected", "Rejected"));
      return;
    default:
      if (code >= 4000 && code <= 4999) setPill("off", t("statusRejected", "Rejected"));
      else setPill("off", t("statusNoServer", "No server"));
  }
}

// One-line pairing status under the header; also hosts "Forget pairing".
function updatePairBar(r, state) {
  const bar = $("#pairBar");
  if (!bar) return;
  const live = state === "paired" || state === "handshake";
  // Without hasKey (older background) only the live states can be described.
  if (!live && !PAIR_PROBLEMS.has(state) && !(r && typeof r.hasKey === "boolean")) {
    bar.hidden = true;
    return;
  }
  const hasKey = !!(r && r.hasKey === true);
  let tone = "";
  let label;
  let tip = "";
  if (state === "paired") {
    tone = "ok";
    label = t("statusPairedTitle", "Paired with the MCP server");
  } else if (state === "handshake") {
    tone = "wait";
    label = t("pairInfoHandshake", "Verifying the MCP server…");
  } else if (hasKey) {
    label = t("pairInfoHasKey", "This browser holds a pairing key");
  } else {
    label = t("pairInfoNoKey", "Not paired yet");
    tip = t("pairInfoNoKeyTitle", "The first MCP server that offers pairing is trusted automatically.");
  }
  if (state === "repair-offered") tone = "wait";
  else if (PAIR_PROBLEMS.has(state)) tone = "bad";
  bar.className = "pair-bar" + (tone ? " " + tone : "");
  const text = $("#pairText");
  setText(text, label);
  if (text) text.title = tip || label;
  const verEl = $("#pairVer");
  const ver = serverVersionOf(r);
  if (verEl) {
    verEl.hidden = !(state === "paired" && ver);
    setText(verEl, ver ? `${t("serverVersionLabel", "Server")} v${ver}` : "");
  }
  const forget = $("#forgetPair");
  if (forget) {
    if (!hasKey) forgetArmedUntil = 0;
    forget.hidden = !hasKey;
    setForgetLabel();
  }
  bar.hidden = false;
}

// Explains pairing problems (pairState) and other application close codes
// (4000-4999) the MCP server sent. 4003 = the server does not trust this extension id.
function updateNotice(r, state) {
  const box = $("#trustBox");
  if (!box) return;
  const lc = lastCloseOf(r);
  const code = lc ? lc.code : 0;
  const connected = !!(r && r.bridgeConnected);
  let kind = "";
  if (PAIR_PROBLEMS.has(state)) kind = state;
  else if (!connected && code === 4003) kind = "untrusted";
  else if (!connected && code >= 4000 && code <= 4999) kind = "closed";
  if (!kind) {
    box.hidden = true;
    return;
  }
  let title;
  let body = "";
  switch (kind) {
    case "repair-offered":
      title = t("pairRepairTitle", "The MCP server asks to pair again");
      body = t("pairRepairBody", "A server on this port offered a new pairing key, but this browser is already paired with another key. Click Re-pair only if you reset or reinstalled the MCP server yourself; otherwise another program may be imitating it.");
      break;
    case "pairing-closed":
      title = t("pairClosedTitle", "Pairing is closed on the MCP server");
      body = t("pairClosedBody", "The server is already paired with another install. Start the server once with --pair (or BROWSER_MCP_PAIR=1), or delete extension-keys.json in the server config directory.");
      break;
    case "server-auth-failed":
      title = t("serverAuthFailedTitle", "The server could not prove its identity");
      body = t("serverAuthFailedBody", "The program on this port does not hold this browser's pairing key, so no commands were run. If you reset the server's pairing data, delete extension-keys.json in the server config directory, restart the server and click Re-pair here when asked. Otherwise another program may be listening on this port.");
      break;
    case "auth-failed":
      title = t("authFailedTitle", "The MCP server rejected this browser's pairing proof");
      body = t("authFailedBody", "The server holds a different pairing key for this browser. Delete extension-keys.json in the server config directory, restart the server and click Re-pair here when asked.");
      break;
    case "protocol-mismatch": {
      title = t("protocolMismatchTitle", "Extension and MCP server versions do not match");
      const side = protocolAdvice(lc);
      body =
        side === "server"
          ? t("protocolUpdateServer", "The MCP server is older than this extension. Update the MCP server to the same release as the extension, then restart it.")
          : side === "extension"
            ? t("protocolUpdateExtension", "This extension is older than the MCP server. Update the extension to the same release as the server, then reload it.")
            : t("protocolUpdateBoth", "The extension and the MCP server use different protocol versions. Update both to the same release.");
      break;
    }
    case "untrusted":
      title = t("trustRejectedTitle", "The MCP server rejected this extension");
      break;
    default:
      title = t("serverClosedTitle", "The MCP server closed the connection");
  }
  box.classList.toggle("warn", kind === "repair-offered");
  setText($("#noticeTitle"), title);
  const bodyEl = $("#noticeBody");
  if (bodyEl) {
    setText(bodyEl, body);
    bodyEl.hidden = !body;
  }
  const keys = $("#noticeKeys");
  if (keys) keys.hidden = !KEYS_FILE_STATES.has(kind);

  const untrusted = kind === "untrusted";
  const id = extensionId();
  const help = $("#trustHelp");
  if (help) help.hidden = !untrusted;
  const idRow = $("#trustIdRow");
  if (idRow) idRow.hidden = !untrusted || !id;
  setText($("#trustEnv"), `BROWSER_MCP_EXTENSION_IDS=${id}`);
  setText($("#extId"), id);

  // Raw close code/reason for diagnosis; the decline that leads to the Re-pair offer
  // (4100 pair-declined) is expected and would only confuse.
  const info = $("#closeInfo");
  if (info) {
    const showInfo = !!lc && code >= 4000 && code <= 4999 && !untrusted && kind !== "repair-offered";
    setText(info, showInfo ? (lc.reason ? `${code} ${lc.reason}` : String(code)) : "");
    info.hidden = !showInfo;
  }
  const actions = $("#noticeActions");
  if (actions) actions.hidden = kind !== "repair-offered";
  setRepairLabel();
  box.hidden = false;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy") === true;
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function refreshStatus() {
  try {
    const r = await bg({ type: "mcp-status" });
    if (r && typeof r.extensionId === "string" && r.extensionId) lastExtensionId = r.extensionId;
    if (r && r.port) {
      currentPort = r.port;
      const inp = $("#portInput");
      if (inp && document.activeElement !== inp) inp.value = String(r.port);
      updateVer(r.port);
    }
    const activeBar = $("#activeBar");
    const activeTitle = $("#activeTitle");
    if (r && r.activeTab && r.activeTab.title) {
      if (activeBar) activeBar.style.display = "flex";
      if (activeTitle) {
        activeTitle.textContent = r.activeTab.title;
        activeTitle.title = `${r.activeTab.url} (Tab #${r.activeTab.id})`;
      }
    } else if (activeBar) {
      activeBar.style.display = "none";
    }
    const state = pairStateOf(r);
    updatePill(r, state);
    updatePairBar(r, state);
    updateNotice(r, state);
  } catch {
    setPill("off", t("statusError", "Error"));
  }
}

// Arms the background to accept the server's next pairing offer (2 minutes) and
// reconnect at once; the status poll then shows the outcome.
async function requestRepair() {
  if (Date.now() < repairPendingUntil) return;
  repairPendingUntil = Date.now() + REPAIR_FEEDBACK_MS;
  setRepairLabel();
  try {
    const res = await bg({ type: "mcp-repair" });
    if (!res || res.ok !== true) repairPendingUntil = 0;
  } catch {
    repairPendingUntil = 0;
  }
  setRepairLabel();
  setTimeout(() => {
    setRepairLabel();
    refreshStatus();
  }, REPAIR_FEEDBACK_MS + 50);
  await refreshStatus();
}

// First click arms, second click (within FORGET_CONFIRM_MS) deletes the stored key.
async function forgetPairing() {
  if (forgetTimer) clearTimeout(forgetTimer);
  forgetTimer = null;
  if (Date.now() >= forgetArmedUntil) {
    forgetArmedUntil = Date.now() + FORGET_CONFIRM_MS;
    setForgetLabel();
    forgetTimer = setTimeout(setForgetLabel, FORGET_CONFIRM_MS + 50);
    return;
  }
  forgetArmedUntil = 0;
  setForgetLabel();
  try {
    await bg({ type: "mcp-forget-pairing" });
  } catch {}
  await refreshStatus();
}

// Apply permission changes ({action: enabled}) and send ONLY the actions whose
// state actually changes, so concurrent changes made elsewhere (another popup,
// or the agent disabling an action) are never overwritten by a stale snapshot.
async function setPerms(changes) {
  const delta = {};
  for (const [a, on] of Object.entries(changes)) {
    if (on === disabled.has(a)) delta[a] = on;
  }
  if (!Object.keys(delta).length) return;
  for (const [a, on] of Object.entries(delta)) {
    if (on) disabled.delete(a);
    else disabled.add(a);
  }
  pendingPermWrites++;
  try {
    const r = await bg({ type: "mcp-perms-set", actions: delta });
    if (r && Array.isArray(r.disabled)) disabled = new Set(r.disabled);
  } catch {
    await reloadPerms();
  } finally {
    pendingPermWrites--;
  }
}

async function reloadPerms() {
  try {
    const r = await bg({ type: "mcp-perms-get" });
    if (r && Array.isArray(r.cats)) CATS = r.cats;
    if (r && Array.isArray(r.disabled)) disabled = new Set(r.disabled);
  } catch {}
}

function allActions() {
  const out = [];
  for (const c of CATS) for (const a of c.actions) out.push(a);
  return out;
}

function render(filter = "") {
  const box = $("#cats");
  const prevScroll = box.scrollTop;
  box.replaceChildren();
  const q = filter.trim().toLowerCase();
  let shown = 0;
  for (const c of CATS) {
    const catTitle = t("cat_" + c.id, c.title);
    const acts = c.actions.filter((a) => !q || a.includes(q) || catTitle.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
    if (!acts.length) continue;
    shown++;
    const on = acts.filter((a) => !disabled.has(a)).length;
    const card = document.createElement("div");
    card.className = "cat" + (openCat === c.id || q ? " open" : "");
    const head = document.createElement("div");
    head.className = "cat-h";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = catTitle;
    const ct = document.createElement("span");
    ct.className = "ct";
    ct.textContent = q ? `${on}/${acts.length}` : `${on}/${c.actions.length}`;
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>`;
    const sw = switchEl(on === acts.length, async (v) => {
      const changes = {};
      for (const a of (q ? acts : c.actions)) changes[a] = v;
      await setPerms(changes);
      render($("#q").value);
    });
    head.append(nm, ct, sw.el, arr);
    head.addEventListener("click", () => {
      const isAlreadyOpen = card.classList.contains("open");
      const allCards = box.querySelectorAll(".cat");
      for (const other of allCards) {
        if (other !== card) other.classList.remove("open");
      }
      card.classList.toggle("open", !isAlreadyOpen);
      openCat = !isAlreadyOpen ? c.id : null;
    });
    card.appendChild(head);
    const tools = document.createElement("div");
    tools.className = "tools";
    for (const a of acts) {
      const row = document.createElement("div");
      row.className = "tool" + (disabled.has(a) ? " off" : "");
      const code = document.createElement("code");
      code.textContent = a;
      const s2 = switchEl(!disabled.has(a), async (v) => {
        await setPerms({ [a]: v });
        render($("#q").value);
      });
      row.append(code, s2.el);
      tools.appendChild(row);
    }
    card.appendChild(tools);
    box.appendChild(card);
  }
  if (!shown) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = t("noResults", "No results");
    box.appendChild(d);
  }
  box.scrollTop = prevScroll;
}

async function applyPort() {
  const inp = $("#portInput");
  if (!inp) return;
  const val = parseInt(inp.value.trim(), 10);
  if (isNaN(val) || val < 1024 || val > 65535) {
    inp.classList.add("err");
    setTimeout(() => inp.classList.remove("err"), 1200);
    return;
  }
  inp.classList.remove("err");
  currentPort = val;
  updateVer(val);
  await bg({ type: "mcp-port-set", port: val });
  await refreshStatus();
}

async function refreshHistory() {
  try {
    const r = await bg({ type: "mcp-history-get" });
    const list = Array.isArray(r?.history) ? r.history : [];
    const badge = $("#histBadge");
    if (badge) badge.textContent = String(list.length);
    const box = $("#histList");
    if (!box) return;
    if (!list.length) {
      box.replaceChildren(el("div", "hist-empty", t("noCommands", "No commands executed yet")));
      return;
    }
    // Built with DOM APIs + textContent only: history entries (action, tabId,
    // error text) originate from bridge peers and must never be parsed as HTML.
    const frag = document.createDocumentFragment();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const ok = !!item.ok;
      const timeStr = new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const dur = Number(item.durationMs);
      const card = el("div", "audit-card" + (ok ? "" : " err"));
      const top = el("div", "audit-top");
      const name = el("div", "audit-name");
      name.append(el("span", "audit-dot"), el("code", null, item.action ?? ""));
      top.append(name, el("span", "audit-time", timeStr));
      const meta = el("div", "audit-meta-row");
      meta.appendChild(el("span", "audit-badge", `${Number.isFinite(dur) ? Math.round(dur) : 0}ms`));
      if (item.tabId) meta.appendChild(el("span", "audit-badge", `${t("tabBadgePrefix", "Tab #")}${item.tabId}`));
      card.append(top, meta);
      if (!ok) card.appendChild(el("div", "audit-err-msg", item.error || t("executionFailed", "Execution failed")));
      frag.appendChild(card);
    }
    box.replaceChildren(frag);
  } catch {}
}

function switchTab(name) {
  const isPerms = name === "perms";
  const btnPerms = $("#navPerms");
  const btnHist = $("#navHistory");
  const panePerms = $("#panePerms");
  const paneHist = $("#paneHistory");
  if (btnPerms) btnPerms.classList.toggle("active", isPerms);
  if (btnHist) btnHist.classList.toggle("active", !isPerms);
  if (panePerms) panePerms.classList.toggle("hidden", !isPerms);
  if (paneHist) paneHist.classList.toggle("hidden", isPerms);
  if (!isPerms) refreshHistory();
}

(async () => {
  if (typeof I18N !== "undefined") {
    await I18N.init();
  }
  await refreshStatus();
  updateVer(currentPort);
  await refreshHistory();
  await reloadPerms();
  render();
  $("#q").addEventListener("input", (e) => render(e.target.value));
  $("#allOn").addEventListener("click", async () => {
    await setPerms(Object.fromEntries(allActions().map((a) => [a, true])));
    render($("#q").value);
  });
  $("#allOff").addEventListener("click", async () => {
    await setPerms(Object.fromEntries(allActions().map((a) => [a, false])));
    render($("#q").value);
  });

  const copyBtn = $("#copyId");
  if (copyBtn) {
    let resetTimer = null;
    copyBtn.addEventListener("click", async () => {
      const id = extensionId();
      if (!id) return;
      const ok = await copyText(id);
      copyBtn.textContent = ok ? t("copied", "Copied") : t("btnCopy", "Copy");
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.textContent = t("btnCopy", "Copy");
      }, 1500);
    });
  }

  const repairBtn = $("#repairBtn");
  if (repairBtn) repairBtn.addEventListener("click", requestRepair);
  const forgetBtn = $("#forgetPair");
  if (forgetBtn) forgetBtn.addEventListener("click", forgetPairing);

  const btnNavPerms = $("#navPerms");
  const btnNavHist = $("#navHistory");
  if (btnNavPerms) btnNavPerms.addEventListener("click", () => switchTab("perms"));
  if (btnNavHist) btnNavHist.addEventListener("click", () => switchTab("history"));

  const btnClearHist = $("#clearHist");
  if (btnClearHist) {
    btnClearHist.addEventListener("click", async () => {
      await bg({ type: "mcp-history-clear" });
      await refreshHistory();
    });
  }

  const portInp = $("#portInput");
  const portSave = $("#portSave");
  const portReset = $("#portReset");
  if (portInp) {
    portInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyPort();
    });
    portInp.addEventListener("change", applyPort);
  }
  if (portSave) {
    portSave.addEventListener("click", applyPort);
  }
  if (portReset) {
    portReset.addEventListener("click", async () => {
      if (portInp) portInp.value = "8765";
      await applyPort();
    });
  }

  const LANG_NAMES = {
    auto: "Auto",
    en: "English",
    tr: "Türkçe",
    es: "Español",
    de: "Deutsch",
    fr: "Français",
    pt_BR: "Português",
    it: "Italiano",
    ru: "Русский",
    ja: "日本語",
    ko: "한국어",
  };

  function updateLangUI() {
    if (typeof I18N === "undefined") return;
    const pref = I18N.getPreference();
    const t = (k, def) => I18N.t(k, def);
    const currentLabel = $("#langCurrentText");
    if (currentLabel) {
      if (pref === "auto") {
        currentLabel.textContent = t("langAuto", "Auto");
      } else {
        currentLabel.textContent = LANG_NAMES[pref] || pref;
      }
    }
    const items = document.querySelectorAll(".lang-item");
    items.forEach((item) => {
      const val = item.getAttribute("data-val");
      item.classList.toggle("selected", val === pref);
    });
  }

  const langBtn = $("#langBtn");
  const langMenu = $("#langMenu");
  if (langBtn && langMenu) {
    updateLangUI();

    langBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = langMenu.classList.contains("show");
      langMenu.classList.toggle("show", !isOpen);
      langBtn.classList.toggle("open", !isOpen);
      langBtn.setAttribute("aria-expanded", String(!isOpen));
    });

    langMenu.querySelectorAll(".lang-item").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const val = el.getAttribute("data-val");
        langMenu.classList.remove("show");
        langBtn.classList.remove("open");
        langBtn.setAttribute("aria-expanded", "false");
        if (typeof I18N !== "undefined") {
          await I18N.setLocale(val);
          updateLangUI();
          render($("#q").value);
          await refreshStatus();
          await refreshHistory();
        }
      });
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#langDropdown")) {
        langMenu.classList.remove("show");
        langBtn.classList.remove("open");
        langBtn.setAttribute("aria-expanded", "false");
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        langMenu.classList.remove("show");
        langBtn.classList.remove("open");
        langBtn.setAttribute("aria-expanded", "false");
      }
    });

    if (typeof I18N !== "undefined") {
      I18N.onChange(() => {
        updateLangUI();
        render($("#q").value);
        refreshStatus();
        refreshHistory();
      });
    }
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      // Permission set changed elsewhere (agent self-restriction, another popup):
      // re-sync so the next toggle never sends a stale state.
      if (area === "local" && changes.mcpDisabled && Array.isArray(changes.mcpDisabled.newValue) && pendingPermWrites === 0) {
        disabled = new Set(changes.mcpDisabled.newValue);
        render($("#q").value);
      }
      if (area === "local" && changes.mcpPort && changes.mcpPort.newValue) {
        const np = Number(changes.mcpPort.newValue);
        if (np > 0 && np < 65536) {
          currentPort = np;
          const inp = $("#portInput");
          if (inp && document.activeElement !== inp) inp.value = String(np);
          updateVer(np);
          refreshStatus();
        }
      }
    });
  }

  // Live badge & history: re-check the bridge while the popup is open
  setInterval(() => {
    refreshStatus();
    refreshHistory();
  }, 2000);
})();
