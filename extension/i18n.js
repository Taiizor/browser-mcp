// Internationalization (i18n) helper for Browser MCP Extension
// Supports 10 popular LTR languages with Auto (System) detection and manual switching.

const I18N = (() => {
  const SUPPORTED = ["en", "tr", "es", "de", "fr", "pt_BR", "it", "ru", "ja", "ko"];
  const listeners = new Set();

  let preference = "auto";
  let activeLocale = "en";
  let messages = {};
  let fallbackMessages = {};

  function normalizeLocale(code) {
    if (!code || typeof code !== "string") return "en";
    const cleaned = code.trim().replace(/-/g, "_");
    if (SUPPORTED.includes(cleaned)) return cleaned;
    const base = cleaned.split("_")[0].toLowerCase();
    if (base === "pt") return "pt_BR";
    const match = SUPPORTED.find((lang) => lang.toLowerCase() === base);
    return match || "en";
  }

  async function fetchMessages(locale) {
    try {
      const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      console.warn(`[i18n] Failed to load messages for "${locale}":`, err);
    }
    return null;
  }

  function getSystemLocale() {
    const sys = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) ||
      navigator.language ||
      "en";
    return normalizeLocale(sys);
  }

  async function resolveAndLoad() {
    activeLocale = preference === "auto" ? getSystemLocale() : normalizeLocale(preference);

    const [loaded, fallback] = await Promise.all([
      fetchMessages(activeLocale),
      activeLocale !== "en" ? fetchMessages("en") : null,
    ]);

    messages = loaded || {};
    if (fallback) fallbackMessages = fallback;
    else if (activeLocale === "en") fallbackMessages = messages;
  }

  function t(key, fallback = "") {
    if (messages[key] && typeof messages[key].message === "string") {
      return messages[key].message;
    }
    if (fallbackMessages[key] && typeof fallbackMessages[key].message === "string") {
      return fallbackMessages[key].message;
    }
    if (chrome.i18n && chrome.i18n.getMessage) {
      const native = chrome.i18n.getMessage(key);
      if (native) return native;
    }
    return fallback || key;
  }

  function applyToDOM() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) el.textContent = t(key, el.textContent);
    });

    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (key) el.placeholder = t(key, el.placeholder);
    });

    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) el.title = t(key, el.title);
    });

    const langSel = document.getElementById("langSelect");
    if (langSel && document.activeElement !== langSel) {
      langSel.value = preference;
    }
  }

  async function setLocale(newPref) {
    preference = newPref;
    try {
      if (chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ mcpLang: newPref });
      }
    } catch {}

    await resolveAndLoad();
    applyToDOM();
    listeners.forEach((fn) => {
      try { fn(activeLocale, preference); } catch {}
    });
  }

  async function init() {
    try {
      if (chrome.storage && chrome.storage.local) {
        const stored = await chrome.storage.local.get("mcpLang");
        if (stored && stored.mcpLang) {
          preference = stored.mcpLang;
        }
      }
    } catch {}

    await resolveAndLoad();
    applyToDOM();

    // Listen to storage changes from other views/contexts if any
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.mcpLang && changes.mcpLang.newValue !== preference) {
          preference = changes.mcpLang.newValue;
          resolveAndLoad().then(() => {
            applyToDOM();
            listeners.forEach((fn) => {
              try { fn(activeLocale, preference); } catch {}
            });
          });
        }
      });
    }
  }

  return {
    init,
    t,
    setLocale,
    applyToDOM,
    getLocale: () => activeLocale,
    getPreference: () => preference,
    onChange: (fn) => listeners.add(fn),
    SUPPORTED,
  };
})();
