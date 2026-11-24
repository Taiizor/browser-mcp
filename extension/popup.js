// Popup: connection status, live agent activity, permission profiles and
// switches, command history and settings. The permission catalog is PERM_CATS
// in background.js (sent with mcp-perms-get); state syncs via chrome.storage
// and the privileged mcp-* messages. Every dynamic value is rendered with
// textContent / DOM APIs (history, hosts and titles come from bridge peers and
// web pages and must never be parsed as HTML). Tooltips are the themed #tip (see
// "tooltip" below), never the native title attribute.

// Disable default right-click context menu (prevents "Inspect" in popup)
document.addEventListener("contextmenu", (e) => e.preventDefault());

const $ = (s) => document.querySelector(s);
const t = (k, def) => (typeof I18N !== "undefined" ? I18N.t(k, def) : def);
// Optional message: "" when the key is missing (I18N.t falls back to the key itself).
function tOpt(key) {
  const v = t(key, "");
  return v && v !== key ? v : "";
}
// I18N.t has no substitutions: {name} placeholders are replaced here.
function fill(text, vars) {
  let out = String(text);
  for (const [k, v] of Object.entries(vars)) out = out.split("{" + k + "}").join(String(v));
  return out;
}

const STATUS_POLL_MS = 1000;
const HISTORY_POLL_MS = 1500;
const ACTIVITY_TICK_MS = 1000;
const STOP_DONE_MS = 2500;
// A poll whose answer never came is retried after this long.
const POLL_STALL_MS = 5000;

// Profiles and risk (catalog ids from mcp-perms-get; actions missing from the catalog are ignored).
const HIGH_RISK_CATS = new Set(["power", "cookies", "storage", "sessions", "clipboard", "browsing_data", "system"]);
const READ_PROFILE_ACTIONS = new Set([
  "tabs_list", "tab_create", "tab_activate", "tab_navigate", "tab_reload", "tab_back", "tab_forward",
  "window_list", "frame_list", "frame_focus", "frame_clear", "tab_group_list",
  "page_screenshot", "console_get", "page_metrics", "perf_web_vitals",
]);
const PROFILES = ["read", "standard", "full"];

let CATS = [];
let disabled = new Set();
let agentDisabled = new Set();
let openCat = null;
// Cards the user collapsed while a search query is shown (a search expands every match).
const searchCollapsed = new Set();
// Number of permission writes in flight; storage echoes are ignored meanwhile
// because the write's own response carries the authoritative state.
let pendingPermWrites = 0;
let lastExtensionId = "";
let currentPort = 8765;
let activePane = "perms";
let running = [];
let agentTabs = [];
let agentTabsSig = "";
let historyList = [];
let historySig = "";
let histFilter = "all";
const openHistory = new Set();
const timers = [];

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

const SVG_NS = "http://www.w3.org/2000/svg";
function chevron(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d || "m9 6 6 6-6 6");
  svg.appendChild(p);
  return svg;
}

// Writes only on change: the status poll runs every second and the notice is
// role="alert", so rewriting identical text would make screen readers announce it again.
function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

// setText for sentences that name a command-line flag (--pair): the flag sits in a
// nowrap span so a line never breaks inside it. Built from text nodes, never HTML.
function setFlagText(node, text) {
  if (!node || node.textContent === text) return;
  node.textContent = "";
  for (const part of text.split(/(--[a-z][a-z-]*)/)) {
    if (!part) continue;
    if (part.startsWith("--")) {
      const flag = document.createElement("span");
      flag.className = "nobr";
      flag.textContent = part;
      node.appendChild(flag);
    } else {
      node.appendChild(document.createTextNode(part));
    }
  }
}

// Finds the element carrying data-fkey="key" without building a selector from
// peer-supplied text (history ids).
function findByKey(root, key) {
  for (const n of root.querySelectorAll("[data-fkey]")) if (n.getAttribute("data-fkey") === key) return n;
  return null;
}

function setHidden(node, hidden) {
  if (node && node.hidden !== hidden) node.hidden = hidden;
}

// The tooltip text of an element (data-tip, shown by #tip); "" removes it. Writes only
// on change, so the status poll does not wake the tooltip's MutationObserver.
function setTip(node, text) {
  if (!node) return;
  const v = text ? String(text) : "";
  if (v) {
    if (node.getAttribute("data-tip") !== v) node.setAttribute("data-tip", v);
  } else if (node.hasAttribute("data-tip")) {
    node.removeAttribute("data-tip");
  }
}

// Marks an element whose text can be cut (an ellipsis or a line clamp): #tip shows
// its full text while, and only while, it is cut.
function tipOverflow(node) {
  if (node) node.setAttribute("data-tip-overflow", "");
  return node;
}

function switchEl(on, mixed, label, fkey, onChange) {
  const l = document.createElement("label");
  l.className = "sw";
  const inp = document.createElement("input");
  inp.type = "checkbox";
  inp.checked = on;
  inp.indeterminate = !!mixed;
  inp.setAttribute("aria-label", label);
  inp.setAttribute("data-fkey", fkey);
  inp.addEventListener("change", (e) => {
    e.stopPropagation();
    onChange(inp.checked);
  });
  l.appendChild(inp);
  l.appendChild(document.createElement("i"));
  l.addEventListener("click", (e) => e.stopPropagation());
  return l;
}

function extensionId() {
  return lastExtensionId || (chrome.runtime && chrome.runtime.id) || "";
}

function manifestVersion() {
  try {
    const v = chrome.runtime.getManifest().version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

// ---------- pairing state ----------

// Bridge pairing states reported by the background (mcp-status.pairState, protocol v3).
const PAIR_STATES = new Set(["none", "handshake", "paired", "repair-offered", "pairing-closed", "server-auth-failed", "auth-failed", "protocol-mismatch"]);
// States that need the user's attention; each one is explained in the notice box.
const PAIR_PROBLEMS = new Set(["repair-offered", "pairing-closed", "server-auth-failed", "auth-failed", "protocol-mismatch"]);
// Problem states the user solves by pairing again ("Pairing needed").
const PAIRING_NEEDED = new Set(["repair-offered", "auth-failed", "pairing-closed"]);
// Every notice's Details link opens a section of this page (one heading per notice).
const DOCS_URL = "https://github.com/Taiizor/browser-mcp/blob/develop/docs/pairing.md";
// The background keeps a Re-pair armed for 2 minutes; the button only shows a short
// waiting label so a failed attempt can be retried without reopening the popup.
const REPAIR_FEEDBACK_MS = 8000;
let repairPendingUntil = 0;
// Server close codes explained by a pairState of their own. With pairState "none" they
// (like the extension's own 4100-4102) are left over from before a Re-pair, Forget
// pairing or port change that is reconnecting now, so they explain nothing.
const STATE_CLOSE_CODES = new Set([4002, 4004, 4005]);

function lastCloseOf(r) {
  const lc = r && r.lastClose && typeof r.lastClose === "object" ? r.lastClose : null;
  if (!lc) return null;
  return {
    code: Number(lc.code) || 0,
    reason: typeof lc.reason === "string" ? lc.reason.slice(0, 200) : "",
  };
}

// The code of a server close (4000-4099) that has no pairState of its own and still
// describes the connection (no socket is up), or 0. 4003 = the server does not trust
// this extension id; anything else is shown as "Connection closed".
function serverCloseCode(r) {
  const lc = lastCloseOf(r);
  const code = lc ? lc.code : 0;
  if ((r && r.bridgeConnected) || code < 4000 || code > 4099 || STATE_CLOSE_CODES.has(code)) return 0;
  return code;
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
  const pending = Date.now() < repairPendingUntil;
  for (const b of [$("#repairBtn"), $("#menuRepair")]) {
    if (!b) continue;
    b.disabled = pending;
    setText(b, pending ? t("btnRepairing", "Waiting for the server…") : t("btnRepair", "Re-pair"));
  }
}

function setPill(tone, label, title = "") {
  const pill = $("#pill");
  if (pill) {
    const cls = "badge " + tone;
    if (pill.className !== cls) pill.className = cls;
    // The label itself is not repeated; a label cut in a long locale shows through #pillTx.
    setTip(pill, title);
  }
  setText($("#pillTx"), label);
}

function updatePill(r, state) {
  const ver = serverVersionOf(r);
  switch (state) {
    case "paired":
      setPill(
        "on",
        t("statusConnected", "Connected"),
        t("statusPairedTitle", "Paired with the MCP server") + (ver ? " · " + t("serverVersionLabel", "Server") + " v" + ver : ""),
      );
      return;
    case "handshake":
      setPill("wait", t("statusConnecting", "Connecting…"), t("statusHandshakeTitle", "Connected, waiting for the MCP server handshake"));
      return;
    case "repair-offered":
    case "auth-failed":
    case "pairing-closed":
      setPill("wait", t("statusActionNeeded", "Pairing needed"));
      return;
    case "server-auth-failed":
      setPill("off", t("statusUntrustedServer", "Unknown server"));
      return;
    case "protocol-mismatch":
      setPill("off", t("statusUpdateNeeded", "Update needed"));
      return;
    default: {
      const code = serverCloseCode(r);
      if (code === 4003) setPill("off", t("statusRejected", "Rejected"));
      else if (code) setPill("off", t("statusDisconnected", "Disconnected"));
      else setPill("off", t("statusNoServer", "No server"));
    }
  }
}

// The pairing part of the sub-line ("" when it cannot be described).
function pairInfo(r, state) {
  const live = state === "paired" || state === "handshake";
  // Without hasKey (older background) only the live states can be described.
  if (!live && !PAIR_PROBLEMS.has(state) && !(r && typeof r.hasKey === "boolean")) return null;
  const hasKey = !!(r && r.hasKey === true);
  if (state === "paired") return { tone: "ok", label: t("pairedShort", "paired"), tip: t("statusPairedTitle", "Paired with the MCP server") };
  if (state === "handshake") return { tone: "wait", label: t("pairInfoHandshake", "Verifying the MCP server…"), tip: "" };
  const tone = PAIRING_NEEDED.has(state) ? "wait" : PAIR_PROBLEMS.has(state) ? "bad" : "";
  // A stored key needs no words here: the pill and, for a problem, the notice say what is wrong.
  if (hasKey || PAIR_PROBLEMS.has(state)) return { tone, label: "", tip: "" };
  return {
    tone,
    label: t("pairInfoNoKey", "Not paired yet"),
    tip: t("pairInfoNoKeyTitle", "The first MCP server that offers pairing is trusted automatically."),
  };
}

// One line under the header: "Server v1.2.3 · <pairing> · <agent tabs>".
function updateSubLine(r, state) {
  const line = $("#subLine");
  if (!line) return;
  const ver = serverVersionOf(r);
  const verEl = $("#subVer");
  setText(verEl, ver ? t("serverVersionLabel", "Server") + " v" + ver : "");
  setHidden(verEl, !ver);
  setHidden($("#sepVer"), !ver);
  const info = pairInfo(r, state);
  const text = $("#pairText");
  const shown = !!(info && info.label);
  setText(text, shown ? info.label : "");
  // The label shows in full through data-tip-overflow when it is cut.
  setTip(text, shown ? info.tip : "");
  setHidden(text, !shown);
  setHidden($("#sepPair"), !shown);
  const cls = "sub" + (info && info.tone ? " " + info.tone : "");
  if (line.className !== cls) line.className = cls;
  // Forget pairing needs a stored key (an older background without hasKey keeps it enabled).
  const forget = $("#forgetPair");
  if (forget) forget.disabled = !!(r && r.hasKey === false);
}

// The notice for a pairing problem (pairState) or another close code the MCP server
// sent (see serverCloseCode), or null. Each notice is a title, at most one sentence, a
// Details link to the docs/pairing.md section with the same heading and at most one
// action; remedies that need files, environment variables or flags live in the docs only.
function noticeOf(r, state) {
  const lc = lastCloseOf(r);
  switch (state) {
    case "server-auth-failed":
      return {
        tone: "bad",
        title: t("noticeUnknownServerTitle", "Unknown server"),
        body: t("noticeUnknownServerBody", "The program on this port is not the server you paired with. No commands were run."),
        action: "",
        anchor: "unknown-server",
      };
    case "repair-offered":
      return {
        tone: "warn",
        title: t("noticeRepairTitle", "Pairing needed"),
        body: t("noticeRepairBody", "If you reset the server yourself, pair again."),
        action: "repair",
        anchor: "pairing-needed",
      };
    // The server still knows this install and challenges its old key instead of
    // offering a new one, so Re-pair cannot help: the key has to go first.
    case "auth-failed":
      return {
        tone: "warn",
        title: t("noticeRepairTitle", "Pairing needed"),
        body: t("noticeAuthFailedBody", "Forget pairing, then start the server once with --pair."),
        action: "forget",
        anchor: "pairing-needed",
      };
    case "pairing-closed":
      return {
        tone: "warn",
        title: t("noticePairClosedTitle", "Pairing is closed"),
        body: t("noticePairClosedBody", "Start the server once with --pair."),
        action: "",
        anchor: "pairing-is-closed",
      };
    case "protocol-mismatch": {
      const side = protocolAdvice(lc);
      return {
        tone: "warn",
        title: t("noticeVersionTitle", "Versions do not match"),
        body:
          side === "server"
            ? t("noticeVersionServer", "Update the MCP server to this extension's release.")
            : side === "extension"
              ? t("noticeVersionExtension", "Update this extension to the MCP server's release.")
              : t("noticeVersionBoth", "Update the extension and the MCP server to the same release."),
        action: "",
        anchor: "versions-do-not-match",
      };
    }
  }
  const code = serverCloseCode(r);
  if (!code) return null;
  if (code === 4003) {
    return {
      tone: "bad",
      title: t("noticeRejectedTitle", "Extension not recognized"),
      body: t("noticeRejectedBody", "Add this extension's ID to the server's trusted list."),
      action: "copy",
      anchor: "extension-not-recognized",
    };
  }
  return { tone: "neutral", title: t("noticeClosedTitle", "Connection closed"), body: "", action: "", anchor: "connection-closed" };
}

// The docs section of the notice on screen ("" while none is shown).
let noticeAnchor = "";

function updateNotice(r, state) {
  const box = $("#trustBox");
  if (!box) return;
  const n = noticeOf(r, state);
  noticeAnchor = n ? n.anchor : "";
  if (!n) {
    setHidden(box, true);
    return;
  }
  const cls = n.tone === "bad" ? "notice" : "notice " + n.tone;
  if (box.className !== cls) box.className = cls;
  setText($("#noticeTitle"), n.title);
  const bodyEl = $("#noticeBody");
  if (bodyEl) {
    setFlagText(bodyEl, n.body);
    setHidden(bodyEl, !n.body);
  }
  setHidden($("#repairBtn"), n.action !== "repair");
  const forget = $("#noticeForget");
  setHidden(forget, n.action !== "forget");
  if (forget) forget.disabled = !!(r && r.hasKey === false);
  const copy = $("#copyId");
  setHidden(copy, n.action !== "copy");
  if (copy) copy.disabled = !extensionId();
  setRepairLabel();
  setHidden(box, false);
}

function openNoticeDetails() {
  if (!noticeAnchor) return;
  try {
    Promise.resolve(chrome.tabs.create({ url: DOCS_URL + "#" + noticeAnchor })).catch(() => {});
  } catch {}
}

function updateMenuInfo() {
  setText($("#menuVer"), "v" + manifestVersion());
  const id = extensionId();
  const idEl = $("#menuExtId");
  setText(idEl, id);
  const btn = $("#menuCopyId");
  if (btn) btn.disabled = !id;
}

// ---------- live activity and agent tabs ----------

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function runningOf(r) {
  const arr = r && Array.isArray(r.running) ? r.running : [];
  const out = [];
  for (const c of arr.slice(0, 10)) {
    if (!c || typeof c !== "object" || typeof c.action !== "string" || !c.action) continue;
    out.push({
      action: str(c.action, 80),
      host: str(c.host, 253),
      startedAt: Number.isFinite(c.startedAt) ? c.startedAt : Date.now(),
    });
  }
  return out;
}

function agentTabsOf(r) {
  const arr = r && Array.isArray(r.agentTabs) ? r.agentTabs : [];
  const out = [];
  for (const c of arr.slice(0, 20)) {
    if (!c || typeof c !== "object" || !Number.isInteger(c.id)) continue;
    out.push({
      id: c.id,
      windowId: Number.isInteger(c.windowId) ? c.windowId : null,
      title: str(c.title, 120),
      host: str(c.host, 253),
      active: c.active === true,
    });
  }
  return out;
}

// "Now: dom_click · example.com · 4s" (+n more); the elapsed time ticks every second.
function renderActivity() {
  const box = $("#activity");
  if (!box) return;
  if (!running.length) {
    setTip(box, "");
    setHidden(box, true);
    return;
  }
  const c = running[0];
  const secs = Math.max(0, Math.floor((Date.now() - c.startedAt) / 1000));
  // The message carries the colon, so each language uses its own punctuation ("En cours :").
  setText($("#actLabel"), t("activityNow", "Now:"));
  setText($("#actAction"), c.action);
  setText($("#actHost"), c.host);
  setHidden($("#actHost"), !c.host);
  setHidden($("#actHostSep"), !c.host);
  setText($("#actTime"), secs + "s");
  const more = $("#actMore");
  const extra = running.length - 1;
  setText(more, extra > 0 ? fill(t("activityMore", "+{n} more"), { n: extra }) : "");
  setHidden(more, extra <= 0);
  // Every running command, one per line; a single one is on the strip already
  // (its action and host show in full through their overflow tips).
  setTip(box, running.length > 1 ? running.map((r) => r.action + (r.host ? " · " + r.host : "")).join("\n") : "");
  setHidden(box, false);
}

function agentTabsLabel(n) {
  if (n === 0) return t("agentTabsNone", "no agent tabs");
  if (n === 1) return t("agentTabsOne", "1 agent tab");
  return fill(t("agentTabsMany", "{n} agent tabs"), { n });
}

function setAgentTabsOpen(open, restoreFocus) {
  const list = $("#agentTabsList");
  const btn = $("#agentTabsBtn");
  if (!list || !btn) return;
  const show = open && agentTabs.length > 0;
  setHidden(list, !show);
  btn.setAttribute("aria-expanded", String(show));
  if (!show && restoreFocus && !btn.hidden) btn.focus();
}

async function focusAgentTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch {}
  if (tab.windowId !== null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {}
  }
}

function renderAgentTabs() {
  const n = agentTabs.length;
  const label = agentTabsLabel(n);
  const span = $("#agentTabsText");
  const btn = $("#agentTabsBtn");
  setText(span, n ? "" : label);
  setHidden(span, n > 0);
  setText($("#agentTabsBtnTx"), n ? label : "");
  setHidden(btn, n === 0);
  if (!n) setAgentTabsOpen(false, false);
  const sig = JSON.stringify(agentTabs);
  if (sig === agentTabsSig) return;
  agentTabsSig = sig;
  const box = $("#agentTabsItems");
  if (!box) return;
  const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute("data-fkey") : null;
  const frag = document.createDocumentFragment();
  for (const tab of agentTabs) {
    const b = el("button", "at-item" + (tab.active ? " active" : ""));
    b.type = "button";
    b.setAttribute("data-fkey", "tab:" + tab.id);
    const dot = el("span", "at-dot");
    dot.setAttribute("aria-hidden", "true");
    const title = tipOverflow(el("span", "at-title", tab.title || tab.host || t("tabBadgePrefix", "Tab #") + tab.id));
    const host = tipOverflow(el("span", "at-host", tab.host));
    b.append(dot, title, host);
    b.addEventListener("click", () => focusAgentTab(tab));
    frag.appendChild(b);
  }
  box.replaceChildren(frag);
  if (focused) {
    const again = findByKey(box, focused);
    if (again) again.focus();
  }
}

// ---------- status ----------

let statusSince = 0;

function applyStatus(r) {
  if (r && typeof r.extensionId === "string" && r.extensionId) lastExtensionId = r.extensionId;
  if (r && r.port) {
    currentPort = r.port;
    const inp = $("#portInput");
    if (inp && document.activeElement !== inp) inp.value = String(r.port);
  }
  updateMenuInfo();
  const state = pairStateOf(r);
  updatePill(r, state);
  updateSubLine(r, state);
  updateNotice(r, state);
  running = runningOf(r);
  renderActivity();
  agentTabs = agentTabsOf(r);
  renderAgentTabs();
}

async function refreshStatus() {
  // One request at a time: a slow worker must not pile up polls.
  if (statusSince && Date.now() - statusSince < POLL_STALL_MS) return;
  const mine = (statusSince = Date.now());
  try {
    applyStatus(await bg({ type: "mcp-status" }));
  } catch {
    setPill("off", t("statusError", "Error"));
    running = [];
    renderActivity();
  } finally {
    if (statusSince === mine) statusSince = 0;
  }
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

// Copies the extension id; the button says "Copied" briefly, then its own label again.
function wireCopy(btn, labelKey, labelDefault) {
  if (!btn) return;
  let resetTimer = null;
  btn.addEventListener("click", async () => {
    const id = extensionId();
    if (!id) return;
    const ok = await copyText(id);
    btn.textContent = ok ? t("copied", "Copied") : t(labelKey, labelDefault);
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      btn.textContent = t(labelKey, labelDefault);
    }, 1500);
  });
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

// Deletes the stored pairing key after the confirm dialog.
async function forgetPairing() {
  const ok = await confirmDialog({
    title: t("confirmForgetTitle", "Forget pairing?"),
    body: t("confirmForgetBody", "This deletes the pairing key in this browser. To connect again, start the server once with --pair."),
    ok: t("btnForgetPairing", "Forget pairing"),
  });
  if (!ok) return;
  try {
    await bg({ type: "mcp-forget-pairing" });
  } catch {}
  await refreshStatus();
}

// ---------- confirm dialog ----------

let confirmState = null; // { resolve, opener, openerKey }

function confirmDialog({ title, body, ok }) {
  const dlg = $("#confirmDlg");
  if (!dlg) return Promise.resolve(false);
  if (confirmState) closeConfirm(false);
  setText($("#dlgTitle"), title);
  setFlagText($("#dlgBody"), body);
  setText($("#dlgOk"), ok);
  setText($("#dlgCancel"), t("confirmCancel", "Cancel"));
  const opener = document.activeElement;
  // A re-render while the dialog is open replaces the opener; its data-fkey finds the new one.
  const openerKey = opener && typeof opener.getAttribute === "function" ? opener.getAttribute("data-fkey") : null;
  return new Promise((resolve) => {
    confirmState = { resolve, opener, openerKey };
    try {
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    } catch {
      dlg.setAttribute("open", "");
    }
    // The safe action gets the focus.
    const cancel = $("#dlgCancel");
    if (cancel) cancel.focus();
  });
}

function closeConfirm(result) {
  const st = confirmState;
  if (!st) return;
  confirmState = null;
  const dlg = $("#confirmDlg");
  try {
    if (typeof dlg.close === "function") dlg.close();
  } catch {}
  dlg.removeAttribute("open");
  const o = st.opener && st.opener.isConnected ? st.opener : st.openerKey ? findByKey(document, st.openerKey) : null;
  if (o && typeof o.focus === "function") o.focus();
  st.resolve(result);
}

function dialogOpen() {
  const dlg = $("#confirmDlg");
  return !!(dlg && (dlg.open || dlg.hasAttribute("open")));
}

// ---------- permissions ----------

function validCats(list) {
  return list.filter((c) => c && typeof c.id === "string" && Array.isArray(c.actions)).map((c) => ({
    id: c.id,
    title: typeof c.title === "string" ? c.title : c.id,
    actions: c.actions.filter((a) => typeof a === "string"),
  }));
}

async function reloadPerms() {
  try {
    const r = await bg({ type: "mcp-perms-get" });
    if (r && Array.isArray(r.cats)) CATS = validCats(r.cats);
    if (r && Array.isArray(r.disabled)) disabled = new Set(r.disabled);
    if (r) agentDisabled = new Set(Array.isArray(r.agentDisabled) ? r.agentDisabled.filter((a) => typeof a === "string") : []);
  } catch {}
}

// Only the actions whose state actually changes.
function deltaOf(changes) {
  const delta = {};
  for (const [a, on] of Object.entries(changes)) {
    if (on === disabled.has(a)) delta[a] = on;
  }
  return delta;
}

// Apply permission changes ({action: enabled}) and send ONLY the actions whose
// state actually changes, so concurrent changes made elsewhere (another popup,
// or the agent disabling an action) are never overwritten by a stale snapshot.
async function setPerms(changes) {
  const delta = deltaOf(changes);
  if (!Object.keys(delta).length) return;
  for (const [a, on] of Object.entries(delta)) {
    if (on) disabled.delete(a);
    else disabled.add(a);
  }
  pendingPermWrites++;
  try {
    const r = await bg({ type: "mcp-perms-set", actions: delta });
    if (r && Array.isArray(r.disabled)) disabled = new Set(r.disabled);
  } catch {}
  try {
    // Re-read: the agent-disabled marks change with every user write.
    await reloadPerms();
  } finally {
    pendingPermWrites--;
  }
}

// High-risk categories in which `delta` enables at least one action.
function highRiskEnabledBy(delta) {
  return CATS.filter((c) => HIGH_RISK_CATS.has(c.id) && c.actions.some((a) => delta[a] === true));
}

// Every user change goes through here: enabling a high-risk action asks first
// (Cancel reverts the switches); disabling never asks.
async function changePerms(changes) {
  const delta = deltaOf(changes);
  if (!Object.keys(delta).length) {
    render();
    return false;
  }
  const risky = highRiskEnabledBy(delta);
  if (risky.length) {
    const ok = await confirmDialog({
      title: t("confirmHighRiskTitle", "Allow high-risk access?"),
      body: fill(t("confirmHighRiskBody", "The agent will be able to use: {cats}. These can read or change private data such as logins, cookies, storage, clipboard and history, or run any code in pages."), {
        cats: risky.map(catTitle).join(", "),
      }),
      ok: t("confirmAllow", "Allow"),
    });
    if (!ok) {
      render();
      return false;
    }
  }
  // Only the delta the user saw: a change made elsewhere while the dialog was open
  // (the agent switching an action off) must not widen what gets enabled.
  await setPerms(delta);
  render();
  return true;
}

function catalogActions() {
  const out = [];
  for (const c of CATS) for (const a of c.actions) out.push(a);
  return out;
}

function profileSet(p) {
  const out = new Set();
  for (const c of CATS) {
    for (const a of c.actions) {
      if (p === "full" || (p === "standard" && !HIGH_RISK_CATS.has(c.id)) || (p === "read" && (c.id === "read" || READ_PROFILE_ACTIONS.has(a)))) out.add(a);
    }
  }
  return out;
}

// The selected profile is derived from the disabled set (custom when none matches).
function derivedProfile() {
  const all = catalogActions();
  if (!all.length) return "custom";
  for (const p of PROFILES) {
    const on = profileSet(p);
    if (all.every((a) => on.has(a) === !disabled.has(a))) return p;
  }
  return "custom";
}

function applyProfile(p) {
  const on = profileSet(p);
  return changePerms(Object.fromEntries(catalogActions().map((a) => [a, on.has(a)])));
}

function profileDesc(p) {
  switch (p) {
    case "read":
      return t("profileReadDesc", "Browse and read pages, take screenshots. Nothing is clicked or typed.");
    case "standard":
      return t("profileStandardDesc", "Also click, type, network and developer tools. No high-risk access.");
    case "full":
      return t("profileFullDesc", "Everything, including running code, cookies, storage and history.");
    default:
      return t("profileCustomDesc", "Your own selection.");
  }
}

function profileButtons() {
  return Array.from(document.querySelectorAll("#profileSeg [data-profile]"));
}

function renderProfiles() {
  const cur = derivedProfile();
  for (const b of profileButtons()) {
    const sel = b.getAttribute("data-profile") === cur;
    b.setAttribute("aria-checked", String(sel));
    b.tabIndex = sel ? 0 : -1;
  }
  setText($("#profileDesc"), profileDesc(cur));
}

function catTitle(c) {
  return t("cat_" + c.id, c.title);
}

function currentQuery() {
  const q = $("#q");
  return q ? q.value : "";
}

function render(filter = currentQuery()) {
  renderProfiles();
  const box = $("#cats");
  if (!box) return;
  const active = document.activeElement;
  const focusKey = active && box.contains(active) ? active.getAttribute("data-fkey") : null;
  const prevScroll = box.scrollTop;
  box.replaceChildren();
  const q = filter.trim().toLowerCase();
  let shown = 0;
  for (const c of CATS) {
    const title = catTitle(c);
    const desc = tOpt("catDesc_" + c.id);
    const catMatch = !q || title.toLowerCase().includes(q) || c.title.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
    const acts = catMatch ? c.actions : c.actions.filter((a) => a.includes(q));
    if (!acts.length) continue;
    shown++;
    const high = HIGH_RISK_CATS.has(c.id);
    const open = q ? !searchCollapsed.has(c.id) : openCat === c.id;
    const on = acts.filter((a) => !disabled.has(a)).length;
    const card = el("div", "cat" + (open ? " open" : "") + (high ? " high" : ""));
    const head = el("div", "cat-h");
    const bodyId = "cat-body-" + c.id;
    const main = el("button", "cat-main");
    main.type = "button";
    main.setAttribute("aria-expanded", String(open));
    main.setAttribute("aria-controls", bodyId);
    main.setAttribute("data-fkey", "cat:" + c.id);
    const row = el("span", "cat-row");
    // Long names wrap to two lines; the tooltip covers anything cut after that.
    const nm = tipOverflow(el("span", "nm", title));
    row.appendChild(nm);
    if (high) row.appendChild(el("span", "risk", t("riskHigh", "High risk")));
    main.appendChild(row);
    if (desc) {
      const d = tipOverflow(el("span", "cat-desc", desc));
      main.appendChild(d);
    }
    const arr = el("span", "arr");
    arr.setAttribute("aria-hidden", "true");
    arr.appendChild(chevron());
    const sw = switchEl(on === acts.length, on > 0 && on < acts.length, title, "catsw:" + c.id, (v) => {
      changePerms(Object.fromEntries(acts.map((a) => [a, v])));
    });
    head.append(main, el("span", "ct", on + "/" + acts.length), sw, arr);
    head.addEventListener("click", () => {
      const isOpen = card.classList.contains("open");
      if (q) {
        // A search expands every match: only the clicked card toggles.
        if (isOpen) searchCollapsed.add(c.id);
        else searchCollapsed.delete(c.id);
      } else {
        for (const other of box.querySelectorAll(".cat.open")) {
          if (other === card) continue;
          other.classList.remove("open");
          const b = other.querySelector(".cat-main");
          if (b) b.setAttribute("aria-expanded", "false");
        }
        openCat = isOpen ? null : c.id;
      }
      card.classList.toggle("open", !isOpen);
      main.setAttribute("aria-expanded", String(!isOpen));
    });
    card.appendChild(head);
    const tools = el("div", "tools");
    tools.id = bodyId;
    for (const a of acts) {
      const off = disabled.has(a);
      const toolRow = el("div", "tool" + (off ? " off" : ""));
      const code = tipOverflow(el("code", null, a));
      toolRow.appendChild(code);
      if (off && agentDisabled.has(a)) {
        const badge = el("span", "agent-off", t("agentDisabledBadge", "off by agent"));
        setTip(badge, t("agentDisabledHint", "The agent switched this off. Only you can switch it back on."));
        toolRow.appendChild(badge);
      }
      toolRow.appendChild(switchEl(!off, false, a, "sw:" + a, (v) => changePerms({ [a]: v })));
      tools.appendChild(toolRow);
    }
    card.appendChild(tools);
    box.appendChild(card);
  }
  if (!shown) box.appendChild(el("div", "empty", t("noResults", "No results")));
  box.scrollTop = prevScroll;
  if (focusKey) {
    const again = findByKey(box, focusKey);
    if (again) again.focus();
  }
}

// ---------- stop agent ----------

let stopTimer = null;

async function stopAgent() {
  const btn = $("#stopAll");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  let ok = false;
  pendingPermWrites++;
  try {
    const r = await bg({ type: "mcp-stop-all" });
    ok = !!(r && r.ok === true);
    if (r && Array.isArray(r.disabled)) disabled = new Set(r.disabled);
  } catch {}
  try {
    await reloadPerms();
  } finally {
    pendingPermWrites--;
  }
  render();
  btn.disabled = false;
  if (ok) {
    btn.classList.add("done");
    setStopLabel();
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = null;
      btn.classList.remove("done");
      setStopLabel();
    }, STOP_DONE_MS);
  }
  refreshStatus();
}

function setStopLabel() {
  const btn = $("#stopAll");
  const done = !!(btn && btn.classList.contains("done"));
  setText($("#stopAllTx"), done ? t("stopAllDone", "Everything is off") : t("stopAll", "Stop agent"));
}

// ---------- history ----------

function historyOf(r) {
  const list = r && Array.isArray(r.history) ? r.history : [];
  const out = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const dur = Number(item.durationMs);
    const time = Number(item.time);
    const tabId = Number(item.tabId);
    out.push({
      id: item.id !== undefined && item.id !== null ? String(item.id).slice(0, 64) : "i" + i,
      action: str(item.action, 120),
      ok: !!item.ok,
      error: str(item.error, 4000),
      durationMs: Number.isFinite(dur) ? Math.max(0, Math.round(dur)) : 0,
      time: Number.isFinite(time) ? time : 0,
      tabId: Number.isInteger(tabId) && tabId > 0 ? tabId : null,
      host: str(item.host, 253),
      detail: str(item.detail, 240),
    });
  });
  return out;
}

let historySince = 0;

async function refreshHistory(force = false) {
  if (!force && historySince && Date.now() - historySince < POLL_STALL_MS) return;
  const mine = (historySince = Date.now());
  try {
    const r = await bg({ type: "mcp-history-get" });
    historyList = historyOf(r);
    setText($("#histBadge"), String(historyList.length));
    const errors = historyList.filter((e) => !e.ok).length;
    const errEl = $("#errCount");
    setText(errEl, errors ? String(errors) : "");
    setHidden(errEl, !errors);
    if (activePane === "history") renderHistory(force);
  } catch {
  } finally {
    if (historySince === mine) historySince = 0;
  }
}

function timeOf(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function dateTimeOf(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function toggleHistoryEntry(wrap, row, more, id) {
  const open = !wrap.classList.contains("open");
  wrap.classList.toggle("open", open);
  row.setAttribute("aria-expanded", String(open));
  more.hidden = !open;
  if (open) openHistory.add(id);
  else openHistory.delete(id);
}

function historyEntry(e) {
  const isOpen = openHistory.has(e.id);
  const wrap = el("div", "h-entry" + (e.ok ? "" : " err") + (isOpen ? " open" : ""));
  const row = el("button", "h-row");
  row.type = "button";
  row.setAttribute("aria-expanded", String(isOpen));
  row.setAttribute("data-fkey", "h:" + e.id);
  const dot = el("span", "h-dot");
  dot.setAttribute("aria-hidden", "true");
  const main = el("span", "h-main");
  main.appendChild(tipOverflow(el("code", "h-action", e.action)));
  if (!e.ok) main.appendChild(el("span", "sr-only", t("executionFailed", "Execution failed")));
  if (e.detail) main.appendChild(tipOverflow(el("span", "h-detail", e.detail)));
  row.append(dot, main, el("span", "h-dur", e.durationMs + "ms"), el("span", "h-time", timeOf(e.time)));
  const more = el("div", "h-more");
  more.hidden = !isOpen;
  if (!e.ok) more.appendChild(el("div", "h-err", e.error || t("executionFailed", "Execution failed")));
  const meta = el("div", "h-meta");
  if (e.tabId !== null) meta.appendChild(el("span", "h-badge", t("tabBadgePrefix", "Tab #") + e.tabId));
  meta.appendChild(el("span", "h-badge", dateTimeOf(e.time)));
  more.appendChild(meta);
  if (e.detail) more.appendChild(el("div", "h-full", e.detail));
  row.addEventListener("click", () => toggleHistoryEntry(wrap, row, more, e.id));
  wrap.append(row, more);
  return wrap;
}

// Grouped by host (newest group first); rebuilt only when the list, the filter
// or the language changed, so scrolling and focus survive the polls.
function renderHistory(force = false) {
  const box = $("#histList");
  if (!box) return;
  const locale = typeof I18N !== "undefined" ? I18N.getLocale() : "";
  const sig = JSON.stringify([histFilter, locale, historyList]);
  if (!force && sig === historySig) return;
  historySig = sig;
  const active = document.activeElement;
  const focusKey = active && box.contains(active) ? active.getAttribute("data-fkey") : null;
  const prevScroll = box.scrollTop;
  const ids = new Set(historyList.map((e) => e.id));
  for (const id of Array.from(openHistory)) if (!ids.has(id)) openHistory.delete(id);
  const items = histFilter === "errors" ? historyList.filter((e) => !e.ok) : historyList;
  if (!historyList.length) {
    box.replaceChildren(el("div", "hist-empty", t("noCommands", "No commands executed yet")));
    return;
  }
  if (!items.length) {
    box.replaceChildren(el("div", "hist-empty", t("historyNoErrors", "No failed commands")));
    return;
  }
  const groups = new Map();
  for (const e of items) {
    let g = groups.get(e.host);
    if (!g) groups.set(e.host, (g = { host: e.host, newest: 0, entries: [] }));
    g.entries.push(e);
    if (e.time > g.newest) g.newest = e.time;
  }
  const ordered = Array.from(groups.values()).sort((a, b) => b.newest - a.newest);
  const frag = document.createDocumentFragment();
  for (const g of ordered) {
    g.entries.sort((a, b) => b.time - a.time);
    const sec = el("section", "h-group");
    const head = el("div", "h-group-head");
    const host = tipOverflow(el("span", "h-host" + (g.host ? "" : " unknown"), g.host || t("historyUnknownSite", "No page")));
    head.append(host, el("span", "h-count", String(g.entries.length)));
    sec.appendChild(head);
    for (const e of g.entries) sec.appendChild(historyEntry(e));
    frag.appendChild(sec);
  }
  box.replaceChildren(frag);
  box.scrollTop = prevScroll;
  if (focusKey) {
    const again = findByKey(box, focusKey);
    if (again) again.focus();
  }
}

function setHistFilter(f) {
  histFilter = f === "errors" ? "errors" : "all";
  for (const b of document.querySelectorAll(".chip[data-filter]")) {
    b.setAttribute("aria-pressed", String(b.getAttribute("data-filter") === histFilter));
  }
  renderHistory(true);
}

function switchTab(name) {
  activePane = name === "history" ? "history" : "perms";
  const isPerms = activePane === "perms";
  const btnPerms = $("#navPerms");
  const btnHist = $("#navHistory");
  if (btnPerms) {
    btnPerms.setAttribute("aria-selected", String(isPerms));
    btnPerms.tabIndex = isPerms ? 0 : -1;
  }
  if (btnHist) {
    btnHist.setAttribute("aria-selected", String(!isPerms));
    btnHist.tabIndex = isPerms ? -1 : 0;
  }
  setHidden($("#panePerms"), !isPerms);
  setHidden($("#paneHistory"), isPerms);
  if (!isPerms) {
    renderHistory(true);
    refreshHistory(true);
  }
}

// ---------- port ----------

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
  try {
    await bg({ type: "mcp-port-set", port: val });
  } catch {}
  await refreshStatus();
}

// ---------- settings menu and language ----------

const LANG_NAMES = {
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
  setText($("#langCurrentText"), pref === "auto" ? t("langAuto", "Auto") : LANG_NAMES[pref] || pref);
  for (const item of document.querySelectorAll(".lang-item")) {
    item.setAttribute("aria-pressed", String(item.getAttribute("data-val") === pref));
  }
}

function menuIsOpen() {
  const menu = $("#menu");
  return !!(menu && !menu.hidden);
}

function setLangOpen(open, restoreFocus) {
  const list = $("#langMenu");
  const btn = $("#langBtn");
  if (!list || !btn) return;
  setHidden(list, !open);
  btn.setAttribute("aria-expanded", String(open));
  if (open) {
    const sel = list.querySelector('.lang-item[aria-pressed="true"]') || list.querySelector(".lang-item");
    if (sel) sel.focus();
  } else if (restoreFocus) {
    btn.focus();
  }
}

function setMenuOpen(open, focusInside, restoreFocus) {
  const menu = $("#menu");
  const btn = $("#menuBtn");
  if (!menu || !btn) return;
  if (!open) setLangOpen(false, false);
  setHidden(menu, !open);
  btn.setAttribute("aria-expanded", String(open));
  if (open) {
    updateMenuInfo();
    updateLangUI();
    if (focusInside) {
      const first = menu.querySelector("button:not([disabled]), input");
      if (first) first.focus();
    }
  } else if (restoreFocus) {
    btn.focus();
  }
}

function onLocaleChanged() {
  updateLangUI();
  render();
  renderHistory(true);
  renderActivity();
  agentTabsSig = "";
  renderAgentTabs();
  setStopLabel();
  setRepairLabel();
  updateMenuInfo();
  refreshStatus();
}

// ---------- tooltip ----------

// One themed tooltip (#tip, role="tooltip") for the whole popup; no element carries a
// native title. An element's tip is its data-tip (setTip, or data-i18n-tip in
// popup.html) or, with data-tip-overflow, its own full text while that text is cut by
// an ellipsis or a line clamp; an explicit data-tip wins. The pointer shows it after
// TIP_DELAY_MS (at once when another tip is open), keyboard focus (:focus-visible) at
// once. Leaving the target, blur, a scroll, a click, the target leaving the DOM and
// Escape hide it; a tip the focus opened follows its target through a scroll instead,
// while the target is in view. Escape while a tip is open closes only the tip: the
// menu, the agent tab list or the dialog under it stays open until the next Escape.
// The tip opens in the top layer (Popover API) so it sits above the menu and the open
// dialog; without showPopover it is a fixed element with a high z-index. It lets every
// pointer event through (pointer-events: none), as the native title did: a click on it
// reaches the control under it. Its text is set with textContent only.
const TIP_DELAY_MS = 350;
// Time to move the pointer across the gap onto the tip, which stays open while the
// pointer is on it (WCAG 1.4.13; see pointerOnTip).
const TIP_HIDE_MS = 120;
// Distance from the popup edges and from the target (room for the arrow).
const TIP_MARGIN = 8;
const TIP_GAP = 7;

const tipState = {
  el: null,
  // The element the tip is shown for, and how it was opened ("pointer" or "focus").
  target: null,
  source: "",
  // The element waiting for the hover delay.
  pending: null,
  showTimer: null,
  hideTimer: null,
  // { node, prev } while node's aria-describedby points at the tip.
  described: null,
  // A target whose tip was dismissed (click, Escape): no tip until the pointer or the focus leaves it.
  suppressed: null,
  observer: null,
};

function textOf(node) {
  return String(node.textContent || "").replace(/\s+/g, " ").trim();
}

// Text cut by an ellipsis (width) or a line clamp (height).
function isCut(node) {
  return node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight + 1;
}

// The tip of node itself as { text, overflow }, or null. With parts, a control without
// a tip of its own shows the cut texts inside it (keyboard focus lands on the control,
// not on its parts).
function tipOf(node, parts) {
  if (!node || node.nodeType !== 1) return null;
  const own = node.getAttribute("data-tip");
  if (own) return { text: own, overflow: false };
  if (node.hasAttribute("data-tip-overflow") && isCut(node)) {
    const text = textOf(node);
    if (text) return { text, overflow: true };
  }
  if (parts) {
    const cut = [];
    for (const d of node.querySelectorAll("[data-tip-overflow]")) {
      const text = isCut(d) ? textOf(d) : "";
      if (text) cut.push(text);
    }
    if (cut.length) return { text: cut.join(" · "), overflow: true };
  }
  return null;
}

// The innermost element under the pointer that has a tip right now.
function hoverTipOf(node) {
  for (let n = node; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    const info = tipOf(n, false);
    if (info) return { node: n, text: info.text, overflow: info.overflow };
  }
  return null;
}

function accessibleNameOf(node) {
  const ids = (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  if (ids.length) {
    return ids
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map(textOf)
      .join(" ");
  }
  return (node.getAttribute("aria-label") || "").trim() || textOf(node);
}

function undescribeTip() {
  const d = tipState.described;
  if (!d) return;
  tipState.described = null;
  if (d.prev === null) d.node.removeAttribute("aria-describedby");
  else d.node.setAttribute("aria-describedby", d.prev);
}

// While the tip is shown its target is described by it. Not for a tip that only
// repeats what the target already says (an overflow tip, or a tip equal to the name of
// an icon-only button): screen readers would read it twice.
function describeTip(node, info) {
  undescribeTip();
  if (info.overflow) return;
  const name = accessibleNameOf(node).toLowerCase();
  if (name && name.includes(info.text.replace(/\s+/g, " ").trim().toLowerCase())) return;
  const prev = node.getAttribute("aria-describedby");
  tipState.described = { node, prev };
  const ids = (prev || "").split(/\s+/).filter((id) => id && id !== "tip");
  ids.push("tip");
  node.setAttribute("aria-describedby", ids.join(" "));
}

// Below the target, or above it when there is no room below; centred on the target
// and kept TIP_MARGIN inside the popup (360 x 550, which can be smaller than the
// window while the popup opens).
function placeTip() {
  const el = tipState.el;
  const node = tipState.target;
  if (!el || !node) return;
  el.style.left = "0px";
  el.style.top = "0px";
  const r = node.getBoundingClientRect();
  const page = document.body.getBoundingClientRect();
  const vw = Math.min(window.innerWidth || 360, page.width || Infinity);
  const vh = Math.min(window.innerHeight || 550, page.height || Infinity);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const roomBelow = vh - TIP_MARGIN - (r.bottom + TIP_GAP);
  const roomAbove = r.top - TIP_GAP - TIP_MARGIN;
  const side = roomBelow >= h || roomBelow >= roomAbove ? "below" : "above";
  const top = Math.max(TIP_MARGIN, Math.min(side === "below" ? r.bottom + TIP_GAP : r.top - TIP_GAP - h, vh - TIP_MARGIN - h));
  const center = r.left + r.width / 2;
  const left = Math.max(TIP_MARGIN, Math.min(center - w / 2, vw - TIP_MARGIN - w));
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
  // The arrow points at the target's centre, but never past the rounded corners.
  el.style.setProperty("--tip-arrow-x", Math.round(Math.max(12, Math.min(w - 12, center - left))) + "px");
  if (el.getAttribute("data-side") !== side) el.setAttribute("data-side", side);
}

function showTip(node, info, source) {
  const el = tipState.el;
  if (!el) return;
  clearTimeout(tipState.showTimer);
  clearTimeout(tipState.hideTimer);
  tipState.showTimer = tipState.hideTimer = null;
  tipState.pending = null;
  tipState.target = node;
  tipState.source = source;
  setText(el, info.text);
  if (info.overflow) el.setAttribute("aria-hidden", "true");
  else el.removeAttribute("aria-hidden");
  describeTip(node, info);
  if (!el.classList.contains("show")) {
    el.classList.add("show");
    if (typeof el.showPopover === "function") {
      try {
        el.showPopover();
      } catch {}
    }
    watchTip(true);
  }
  placeTip();
}

function hideTip() {
  clearTimeout(tipState.showTimer);
  clearTimeout(tipState.hideTimer);
  tipState.showTimer = tipState.hideTimer = null;
  tipState.pending = null;
  tipState.target = null;
  tipState.source = "";
  undescribeTip();
  const el = tipState.el;
  if (!el || !el.classList.contains("show")) return;
  watchTip(false);
  if (typeof el.hidePopover === "function") {
    try {
      el.hidePopover();
    } catch {}
  }
  el.classList.remove("show");
  el.textContent = "";
}

// While a tip is shown, it follows its target: a new text (a status poll, the
// language), a text that is no longer cut, a target that was hidden or removed.
function refreshTip() {
  const node = tipState.target;
  if (!node) return;
  if (!node.isConnected || node.closest("[hidden]")) {
    hideTip();
    return;
  }
  const info = tipOf(node, tipState.source === "focus");
  if (!info) hideTip();
  else if (info.text !== tipState.el.textContent) showTip(node, info, tipState.source);
  // The same text, but the target may have moved (the activity strip, a notice or the
  // agent tab list shown or hidden above it).
  else placeTip();
}

function watchTip(on) {
  if (!on) {
    if (tipState.observer) tipState.observer.disconnect();
    return;
  }
  if (typeof MutationObserver !== "function") return;
  if (!tipState.observer) tipState.observer = new MutationObserver(refreshTip);
  tipState.observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-tip", "data-tip-overflow", "hidden"],
  });
}

function cancelPendingTip() {
  clearTimeout(tipState.showTimer);
  tipState.showTimer = null;
  tipState.pending = null;
}

function keepTip() {
  clearTimeout(tipState.hideTimer);
  tipState.hideTimer = null;
}

// Whether the pointer of e is on the shown tip. The tip lets every pointer event through
// to the control under it (pointer-events: none), so only its box tells.
function pointerOnTip(e) {
  const el = tipState.el;
  if (!el || !el.classList.contains("show")) return false;
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
}

function onTipPointerOver(e) {
  if (e.pointerType === "touch") return;
  // On the tip, over whatever it covers: the tip stays.
  if (pointerOnTip(e)) {
    keepTip();
    return;
  }
  const found = hoverTipOf(e.target);
  if (!found) {
    cancelPendingTip();
    return;
  }
  if (found.node === tipState.target) {
    keepTip();
    return;
  }
  if (found.node === tipState.suppressed || found.node === tipState.pending) return;
  // From one tip to the next: no second delay.
  if (tipState.target) {
    showTip(found.node, found, "pointer");
    return;
  }
  cancelPendingTip();
  tipState.pending = found.node;
  tipState.showTimer = setTimeout(() => {
    const target = tipState.pending;
    tipState.showTimer = null;
    tipState.pending = null;
    const info = target && target.isConnected ? tipOf(target, false) : null;
    if (info) showTip(target, info, "pointer");
  }, TIP_DELAY_MS);
}

function onTipPointerOut(e) {
  if (e.pointerType === "touch") return;
  const to = e.relatedTarget;
  const holds = (n) => !!(n && to && n.contains(to));
  if (tipState.suppressed && !holds(tipState.suppressed)) tipState.suppressed = null;
  if (tipState.pending && !holds(tipState.pending)) cancelPendingTip();
  // A tip opened by the focus stays until blur; one opened by the pointer stays while
  // the pointer is on the target or on the tip.
  if (!tipState.target || tipState.source !== "pointer") return;
  if (holds(tipState.target) || pointerOnTip(e) || tipState.hideTimer) return;
  tipState.hideTimer = setTimeout(hideTip, TIP_HIDE_MS);
}

// The pointer moving onto or off the tip within one element under it fires no
// pointerover or pointerout.
function onTipPointerMove(e) {
  if (e.pointerType === "touch" || tipState.source !== "pointer") return;
  const node = tipState.target;
  if (!node || node.contains(e.target) || pointerOnTip(e)) {
    keepTip();
    return;
  }
  if (tipState.hideTimer) return;
  // Off the tip: what is under the pointer takes over, as if just entered.
  onTipPointerOver(e);
  if (tipState.target === node && !tipState.hideTimer) tipState.hideTimer = setTimeout(hideTip, TIP_HIDE_MS);
}

function onTipFocusIn(e) {
  const node = e.target;
  if (!node || node.nodeType !== 1 || node === tipState.el) return;
  let visible = true;
  try {
    visible = node.matches(":focus-visible");
  } catch {}
  const info = visible && node !== tipState.suppressed ? tipOf(node, true) : null;
  if (info) showTip(node, info, "focus");
  else if (tipState.source === "focus") hideTip();
}

function onTipFocusOut(e) {
  if (e.target === tipState.suppressed) tipState.suppressed = null;
  if (e.target === tipState.target) hideTip();
}

// A press anywhere hides it (a press on the tip goes to the control under it); on the
// target, the tip stays away until the pointer or the focus leaves it.
function onTipPress(e) {
  const node = tipState.target || tipState.pending;
  if (node && node.contains(e.target)) tipState.suppressed = node;
  hideTip();
}

function onTipKeyDown(e) {
  if (e.key !== "Escape") return;
  cancelPendingTip();
  const node = tipState.target;
  if (!node) return;
  // The tip closes first, alone: the menu, the list or the dialog under it stays open.
  e.preventDefault();
  e.stopImmediatePropagation();
  tipState.suppressed = node;
  hideTip();
}

// Whether node shows, at least in part, in the box that scrolled (an element, or the
// document in the viewport). Another box scrolling leaves it where it was.
function inScrollView(node, box) {
  const inner = !!box && box.nodeType === 1;
  if (inner && !box.contains(node)) return true;
  const r = node.getBoundingClientRect();
  const b = inner ? box.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  return r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right;
}

// A scroll hides the tip, but not one the focus opened: moving the focus scrolls its
// target into view (Tab in a list), and the tip follows it while it is in view.
function onTipScroll(e) {
  const node = tipState.target;
  if (node && tipState.source === "focus" && node === document.activeElement && inScrollView(node, e.target)) {
    placeTip();
    return;
  }
  hideTip();
}

function initTips() {
  const el = $("#tip");
  if (!el) return;
  tipState.el = el;
  document.addEventListener("pointerover", onTipPointerOver);
  document.addEventListener("pointerout", onTipPointerOut);
  document.addEventListener("pointermove", onTipPointerMove);
  document.addEventListener("focusin", onTipFocusIn);
  document.addEventListener("focusout", onTipFocusOut);
  // Capture: before the target's own handlers, which may re-render or open the dialog.
  document.addEventListener("pointerdown", onTipPress, true);
  document.addEventListener("click", onTipPress, true);
  // Capture: before the Escape handler below, so one Escape closes only the tip.
  document.addEventListener("keydown", onTipKeyDown, true);
  // Scroll events do not bubble: the capture phase sees every scrolling list.
  document.addEventListener("scroll", onTipScroll, true);
  window.addEventListener("blur", () => hideTip());
}

// ---------- wiring ----------

function wire() {
  initTips();

  const q = $("#q");
  if (q) {
    q.addEventListener("input", () => {
      // A new query expands every match again.
      searchCollapsed.clear();
      render();
    });
  }

  // Profiles: Read / Standard / Full apply; Custom only shows that the selection is custom.
  const seg = $("#profileSeg");
  if (seg) {
    for (const b of profileButtons()) {
      b.addEventListener("click", () => {
        const p = b.getAttribute("data-profile");
        if (!PROFILES.includes(p) || p === derivedProfile()) return;
        applyProfile(p);
      });
    }
    // Arrow keys only move the focus (applying a profile is an explicit Enter/Space/click).
    seg.addEventListener("keydown", (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: "first", End: "last" };
      if (!(e.key in keys)) return;
      const btns = profileButtons().filter((b) => b.getAttribute("aria-disabled") !== "true" || b.getAttribute("aria-checked") === "true");
      if (!btns.length) return;
      e.preventDefault();
      let i = btns.indexOf(document.activeElement);
      const k = keys[e.key];
      if (k === "first") i = 0;
      else if (k === "last") i = btns.length - 1;
      else i = (i + k + btns.length) % btns.length;
      for (const b of profileButtons()) b.tabIndex = -1;
      btns[i].tabIndex = 0;
      btns[i].focus();
    });
  }

  wireCopy($("#copyId"), "btnCopyId", "Copy ID");
  wireCopy($("#menuCopyId"), "btnCopy", "Copy");
  const details = $("#noticeDetails");
  if (details) details.addEventListener("click", openNoticeDetails);

  const repairBtn = $("#repairBtn");
  if (repairBtn) repairBtn.addEventListener("click", requestRepair);
  const menuRepair = $("#menuRepair");
  if (menuRepair) menuRepair.addEventListener("click", requestRepair);
  const forgetBtn = $("#forgetPair");
  if (forgetBtn) forgetBtn.addEventListener("click", forgetPairing);
  const noticeForget = $("#noticeForget");
  if (noticeForget) noticeForget.addEventListener("click", forgetPairing);

  const navPerms = $("#navPerms");
  const navHist = $("#navHistory");
  if (navPerms) navPerms.addEventListener("click", () => switchTab("perms"));
  if (navHist) navHist.addEventListener("click", () => switchTab("history"));
  const nav = document.querySelector(".tab-nav");
  if (nav) {
    nav.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const next = activePane === "perms" ? "history" : "perms";
      switchTab(next);
      const b = next === "perms" ? navPerms : navHist;
      if (b) b.focus();
    });
  }

  for (const chip of document.querySelectorAll(".chip[data-filter]")) {
    chip.addEventListener("click", () => setHistFilter(chip.getAttribute("data-filter")));
  }
  const clearHist = $("#clearHist");
  if (clearHist) {
    clearHist.addEventListener("click", async () => {
      try {
        await bg({ type: "mcp-history-clear" });
      } catch {}
      openHistory.clear();
      await refreshHistory(true);
    });
  }

  const stopBtn = $("#stopAll");
  if (stopBtn) stopBtn.addEventListener("click", stopAgent);

  const portInp = $("#portInput");
  if (portInp) {
    portInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyPort();
    });
    portInp.addEventListener("change", applyPort);
  }
  const portSave = $("#portSave");
  if (portSave) portSave.addEventListener("click", applyPort);
  const portReset = $("#portReset");
  if (portReset) {
    portReset.addEventListener("click", async () => {
      if (portInp) portInp.value = "8765";
      await applyPort();
    });
  }

  const menuBtn = $("#menuBtn");
  const menu = $("#menu");
  if (menuBtn && menu) {
    // detail 0: activated from the keyboard, so the focus moves into the menu.
    menuBtn.addEventListener("click", (e) => setMenuOpen(!menuIsOpen(), e.detail === 0, false));
    // Tabbing out of the menu closes it (not while its confirm dialog is open).
    menu.addEventListener("focusout", (e) => {
      const to = e.relatedTarget;
      if (!to || dialogOpen()) return;
      if (menu.contains(to) || menuBtn.contains(to)) return;
      setMenuOpen(false, false, false);
    });
  }

  const langBtn = $("#langBtn");
  if (langBtn) {
    langBtn.addEventListener("click", () => setLangOpen(langBtn.getAttribute("aria-expanded") !== "true", false));
  }
  for (const item of document.querySelectorAll(".lang-item")) {
    item.addEventListener("click", async () => {
      const val = item.getAttribute("data-val");
      setLangOpen(false, true);
      // I18N.setLocale notifies onChange, which re-renders everything.
      if (typeof I18N !== "undefined" && val) await I18N.setLocale(val);
    });
  }

  const atBtn = $("#agentTabsBtn");
  if (atBtn) atBtn.addEventListener("click", () => setAgentTabsOpen(atBtn.getAttribute("aria-expanded") !== "true", false));

  const dlg = $("#confirmDlg");
  if (dlg) {
    $("#dlgOk").addEventListener("click", () => closeConfirm(true));
    $("#dlgCancel").addEventListener("click", () => closeConfirm(false));
    // Escape (close request) and any other close count as Cancel.
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeConfirm(false);
    });
    dlg.addEventListener("close", () => {
      if (!dlg.open) closeConfirm(false);
    });
  }

  // Outside clicks close the menu and the agent tab list.
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || typeof target.closest !== "function") return;
    if (dialogOpen() || target.closest("#confirmDlg")) return;
    if (menuIsOpen() && !target.closest("#menu") && !target.closest("#menuBtn")) setMenuOpen(false, false, false);
    const list = $("#agentTabsList");
    if (list && !list.hidden && !target.closest("#agentTabsList") && !target.closest("#agentTabsBtn")) setAgentTabsOpen(false, false);
  });

  // Escape closes the innermost open layer and returns the focus to its opener.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (confirmState) {
      e.preventDefault();
      closeConfirm(false);
      return;
    }
    const langBtnEl = $("#langBtn");
    if (menuIsOpen() && langBtnEl && langBtnEl.getAttribute("aria-expanded") === "true") {
      e.preventDefault();
      setLangOpen(false, true);
      return;
    }
    if (menuIsOpen()) {
      e.preventDefault();
      setMenuOpen(false, false, true);
      return;
    }
    const list = $("#agentTabsList");
    if (list && !list.hidden) {
      e.preventDefault();
      setAgentTabsOpen(false, true);
    }
  });

  if (typeof I18N !== "undefined") I18N.onChange(onLocaleChanged);

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // Permission set changed elsewhere (agent self-restriction, another popup):
      // re-sync so the next toggle never sends a stale state.
      if (changes.mcpDisabled && Array.isArray(changes.mcpDisabled.newValue) && pendingPermWrites === 0) {
        disabled = new Set(changes.mcpDisabled.newValue);
        render();
      }
      // The agent-disabled marks: the background's answer is authoritative, the
      // storage event only says that they changed.
      if (changes.mcpAgentDisabled && pendingPermWrites === 0) {
        reloadPerms().then(() => {
          if (pendingPermWrites === 0) render();
        });
      }
      if (changes.mcpPort && changes.mcpPort.newValue) {
        const np = Number(changes.mcpPort.newValue);
        if (np > 0 && np < 65536) {
          currentPort = np;
          const inp = $("#portInput");
          if (inp && document.activeElement !== inp) inp.value = String(np);
          refreshStatus();
        }
      }
    });
  }
}

function startPolling() {
  timers.push(
    setInterval(refreshStatus, STATUS_POLL_MS),
    setInterval(() => refreshHistory(), HISTORY_POLL_MS),
    setInterval(renderActivity, ACTIVITY_TICK_MS),
  );
}

function stopPolling() {
  for (const id of timers.splice(0)) clearInterval(id);
}

(async () => {
  if (typeof I18N !== "undefined") {
    try {
      await I18N.init();
    } catch {}
  }
  wire();
  updateMenuInfo();
  updateLangUI();
  setStopLabel();
  await Promise.all([refreshStatus(), reloadPerms()]);
  render();
  await refreshHistory(true);
  startPolling();
  window.addEventListener("pagehide", stopPolling);
  window.addEventListener("unload", stopPolling);
})();
