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

// Shows why the MCP server closed the connection (application close codes 4000-4999).
// 4003 = the server does not trust this extension id; anything else is shown generically.
function updateCloseNotice(r) {
  const box = $("#trustBox");
  if (!box) return;
  const lc = r && !r.bridgeConnected && r.lastClose && typeof r.lastClose === "object" ? r.lastClose : null;
  const code = lc ? Number(lc.code) : 0;
  if (!lc || !(code >= 4000 && code <= 4999)) {
    box.hidden = true;
    return;
  }
  const untrusted = code === 4003;
  const id = extensionId();
  const title = $("#noticeTitle");
  if (title) {
    title.textContent = untrusted
      ? t("trustRejectedTitle", "The MCP server rejected this extension")
      : t("serverClosedTitle", "The MCP server closed the connection");
  }
  const help = $("#trustHelp");
  if (help) help.hidden = !untrusted;
  const idRow = $("#trustIdRow");
  if (idRow) idRow.hidden = !untrusted || !id;
  const env = $("#trustEnv");
  if (env) env.textContent = `BROWSER_MCP_EXTENSION_IDS=${id}`;
  const idEl = $("#extId");
  if (idEl) idEl.textContent = id;
  const info = $("#closeInfo");
  if (info) {
    const reason = typeof lc.reason === "string" ? lc.reason.slice(0, 200) : "";
    info.textContent = reason ? `${code} ${reason}` : String(code);
    info.hidden = untrusted;
  }
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
  const pill = $("#pill");
  const tx = $("#pillTx");
  const set = (on, label, title = "") => {
    pill.className = "badge " + (on ? "on" : "off");
    tx.textContent = label;
    pill.title = title;
  };
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
    updateCloseNotice(r);
    const closeCode = r && r.lastClose && typeof r.lastClose === "object" ? Number(r.lastClose.code) : 0;
    if (r && r.bridgeConnected) {
      // `paired` = the server answered our hello with a welcome (protocol 2).
      const title =
        r.paired === true
          ? t("statusPairedTitle", "Paired with the MCP server")
          : r.paired === false
            ? t("statusHandshakeTitle", "Connected, waiting for the MCP server handshake")
            : "";
      set(true, t("statusConnected", "Connected"), title);
    } else if (closeCode >= 4000 && closeCode <= 4999) {
      set(false, t("statusRejected", "Rejected"));
    } else {
      set(false, t("statusNoServer", "No server"));
    }
  } catch {
    set(false, t("statusError", "Error"));
  }
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
