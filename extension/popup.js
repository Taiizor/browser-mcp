// Popup: status + category-based permission switches.
// Single source is PERM_CATS in background; state syncs via chrome.storage.

// Disable default right-click context menu (prevents "Inspect" in popup)
document.addEventListener("contextmenu", (e) => e.preventDefault());

const $ = (s) => document.querySelector(s);
let CATS = [];
let disabled = new Set();
let openCat = null;

async function bg(msg) {
  return chrome.runtime.sendMessage(msg);
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

function updateVer(port) {
  const v = chrome.runtime.getManifest().version;
  const el = $("#ver");
  if (el) el.textContent = `v${v} · 127.0.0.1:${port}`;
}

async function refreshStatus() {
  const pill = $("#pill");
  const tx = $("#pillTx");
  const set = (on, label) => {
    pill.className = "badge " + (on ? "on" : "off");
    tx.textContent = label;
  };
  try {
    const r = await bg({ type: "mcp-status" });
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
    const t = (k, def) => (typeof I18N !== "undefined" ? I18N.t(k, def) : def);
    if (r && r.bridgeConnected) set(true, t("statusConnected", "Connected"));
    else set(false, t("statusNoServer", "No server"));
  } catch {
    const t = (k, def) => (typeof I18N !== "undefined" ? I18N.t(k, def) : def);
    set(false, t("statusError", "Error"));
  }
}

async function push() {
  // Write current UI state to background
  const actions = {};
  for (const c of CATS) for (const a of c.actions) actions[a] = !disabled.has(a);
  await bg({ type: "mcp-perms-set", actions });
}

function render(filter = "") {
  const t = (k, def) => (typeof I18N !== "undefined" ? I18N.t(k, def) : def);
  const box = $("#cats");
  const prevScroll = box.scrollTop;
  box.innerHTML = "";
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
      for (const a of (q ? acts : c.actions)) {
        if (v) disabled.delete(a);
        else disabled.add(a);
      }
      await push();
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
        if (v) disabled.delete(a);
        else disabled.add(a);
        await push();
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

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refreshHistory() {
  const t = (k, def) => (typeof I18N !== "undefined" ? I18N.t(k, def) : def);
  try {
    const r = await bg({ type: "mcp-history-get" });
    const list = r?.history || [];
    const badge = $("#histBadge");
    if (badge) badge.textContent = String(list.length);
    const box = $("#histList");
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="hist-empty">${t("noCommands", "No commands executed yet")}</div>`;
      return;
    }
    box.innerHTML = list
      .map((item) => {
        const timeStr = new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const tabBadge = item.tabId ? `<span class="audit-badge">${t("tabBadgePrefix", "Tab #")}${item.tabId}</span>` : "";
        const durBadge = `<span class="audit-badge">${item.durationMs}ms</span>`;
        const errMsg = !item.ok ? `<div class="audit-err-msg">${escapeHtml(item.error || t("executionFailed", "Execution failed"))}</div>` : "";
        return `<div class="audit-card ${item.ok ? "" : "err"}">
          <div class="audit-top">
            <div class="audit-name">
              <span class="audit-dot"></span>
              <code>${escapeHtml(item.action)}</code>
            </div>
            <span class="audit-time">${timeStr}</span>
          </div>
          <div class="audit-meta-row">
            ${durBadge}
            ${tabBadge}
          </div>
          ${errMsg}
        </div>`;
      })
      .join("");
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
  try {
    const r = await bg({ type: "mcp-perms-get" });
    CATS = r.cats || [];
    disabled = new Set(r.disabled || []);
  } catch {
    CATS = [];
  }
  render();
  $("#q").addEventListener("input", (e) => render(e.target.value));
  $("#allOn").addEventListener("click", async () => {
    disabled.clear();
    await push();
    render($("#q").value);
  });
  $("#allOff").addEventListener("click", async () => {
    disabled.clear();
    for (const c of CATS) for (const a of c.actions) disabled.add(a);
    await push();
    render($("#q").value);
  });

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
