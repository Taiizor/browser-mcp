// The REAL extension popup (popup.html + i18n.js + popup.js) in happy-dom with a
// mocked chrome API and fake timers (see helpers/popup-dom.ts): derived
// permission profiles, the high-risk confirmation, the status sub-line, the
// connection notices, live activity, history grouping, Stop agent, Forget
// pairing, the language menu, the themed tooltip and text-only rendering of
// peer-supplied data.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { EXT_VERSION, EXTENSION_DIR, localeText, POPUP_EXT_ID, PopupPage, type HistoryEntry } from "../helpers/popup-dom.js";

const T = 20_000;
const EN = localeText("en");
const HIGH = new Set(["power", "cookies", "storage", "sessions", "clipboard", "browsing_data", "system"]);
const READ_EXTRA = new Set([
  "tabs_list", "tab_create", "tab_activate", "tab_navigate", "tab_reload", "tab_back", "tab_forward",
  "window_list", "frame_list", "frame_focus", "frame_clear", "tab_group_list",
  "page_screenshot", "console_get", "page_metrics", "perf_web_vitals",
]);
const DESC: Record<string, string> = {
  read: EN.profileReadDesc,
  standard: EN.profileStandardDesc,
  full: EN.profileFullDesc,
  custom: EN.profileCustomDesc,
};

const cats = PopupPage.catalog();
const ALL = cats.flatMap((c) => c.actions);
const HIGH_ACTIONS = cats.filter((c) => HIGH.has(c.id)).flatMap((c) => c.actions);
const READ_ON = new Set(cats.flatMap((c) => c.actions.filter((a) => c.id === "read" || READ_EXTRA.has(a))));
const catTitle = (id: string) => EN[`cat_${id}`];
const fill = (s: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), s);

let p: PopupPage | null = null;
afterEach(async () => {
  await p?.close();
  p = null;
});

const permSets = (x: PopupPage) => x.sentOf("mcp-perms-set");

describe("permission profiles", () => {
  test("the selected profile is derived from the disabled set", async () => {
    // Initial load.
    p = await PopupPage.open({ disabled: HIGH_ACTIONS });
    expect(p.checkedProfile()).toBe("standard");
    expect(p.text("#profileDesc")).toBe(DESC.standard);
    // Custom is shown, never applied.
    expect(p.$('#profileSeg [data-profile="custom"]').getAttribute("aria-disabled")).toBe("true");

    // Later changes arrive through chrome.storage.onChanged (mcpDisabled).
    const cases: Array<[string[], string]> = [
      [[], "full"],
      [["not_in_the_catalog"], "full"],
      [HIGH_ACTIONS, "standard"],
      [ALL.filter((a) => !READ_ON.has(a)), "read"],
      [["dom_click"], "custom"],
      [[...HIGH_ACTIONS, "dom_click"], "custom"],
      [HIGH_ACTIONS.slice(1), "custom"],
      [ALL, "custom"],
    ];
    for (const [disabled, expected] of cases) {
      await p.storageWrite({ mcpDisabled: disabled });
      expect({ disabled: disabled.length, profile: p.checkedProfile() }).toEqual({ disabled: disabled.length, profile: expected });
      expect(p.text("#profileDesc")).toBe(DESC[expected]);
      // Exactly one radio is reachable with Tab.
      expect(p.$$("#profileSeg [role=radio]").filter((b) => b.tabIndex === 0).map((b) => b.getAttribute("data-profile"))).toEqual([expected]);
    }
    // Clicking Custom sends nothing.
    await p.click('#profileSeg [data-profile="custom"]');
    expect(permSets(p)).toHaveLength(0);
  }, T);

  test("applying Standard sends only the changed actions, without a confirmation", async () => {
    p = await PopupPage.open({ disabled: ["dom_click", "js_evaluate"] });
    expect(p.checkedProfile()).toBe("custom");
    await p.click('#profileSeg [data-profile="standard"]');
    expect(p.dialogOpen()).toBe(false);
    const sets = permSets(p);
    expect(sets).toHaveLength(1);
    const expected: Record<string, boolean> = { dom_click: true };
    for (const a of HIGH_ACTIONS) if (a !== "js_evaluate") expected[a] = false;
    expect(sets[0].actions).toEqual(expected);
    // The popup re-reads the permissions after its own write.
    const i = p.sent.indexOf(sets[0]);
    expect(p.sent.slice(i + 1).some((m) => m.type === "mcp-perms-get")).toBe(true);
    await p.until(() => p!.checkedProfile() === "standard", "the Standard profile");
    expect(p.text("#profileDesc")).toBe(DESC.standard);

    // Clicking the selected profile again sends nothing; Read only disables, so it never asks.
    await p.click('#profileSeg [data-profile="standard"]');
    expect(permSets(p)).toHaveLength(1);
    await p.click('#profileSeg [data-profile="read"]');
    expect(p.dialogOpen()).toBe(false);
    expect(permSets(p)).toHaveLength(2);
    expect(Object.values(permSets(p)[1].actions).every((v) => v === false)).toBe(true);
    await p.until(() => p!.checkedProfile() === "read", "the Read profile");
  }, T);

  test("enabling a high-risk category asks first; Cancel sends nothing and reverts the switch", async () => {
    p = await PopupPage.open({ disabled: HIGH_ACTIONS });
    const cookieSwitch = () => p!.$('input[data-fkey="catsw:cookies"]');
    expect(cookieSwitch().checked).toBe(false);
    expect(p.$('button[data-fkey="cat:cookies"]').textContent).toContain(EN.riskHigh);
    expect(p.$('button[data-fkey="cat:tabs"]').textContent).not.toContain(EN.riskHigh);

    await p.click(cookieSwitch());
    expect(p.dialogOpen()).toBe(true);
    expect(p.text("#dlgTitle")).toBe(EN.confirmHighRiskTitle);
    expect(p.text("#dlgBody")).toBe(fill(EN.confirmHighRiskBody, { cats: catTitle("cookies") }));
    expect(p.text("#dlgOk")).toBe(EN.confirmAllow);
    expect(p.text("#dlgCancel")).toBe(EN.confirmCancel);
    expect(p.document.activeElement).toBe(p.$("#dlgCancel"));
    expect(permSets(p)).toHaveLength(0);

    await p.click("#dlgCancel");
    expect(p.dialogOpen()).toBe(false);
    expect(permSets(p)).toHaveLength(0);
    expect(cookieSwitch().checked).toBe(false);
    // The focus is back on the (re-rendered) switch.
    expect(p.document.activeElement).toBe(cookieSwitch());

    // Escape cancels as well.
    await p.click(cookieSwitch());
    expect(p.dialogOpen()).toBe(true);
    await p.key("Escape");
    expect(p.dialogOpen()).toBe(false);
    expect(permSets(p)).toHaveLength(0);

    // A single action switch asks too; Allow sends just that action.
    await p.click('button[data-fkey="cat:power"]');
    expect(p.$('button[data-fkey="cat:power"]').getAttribute("aria-expanded")).toBe("true");
    await p.click('input[data-fkey="sw:js_evaluate"]');
    expect(p.dialogOpen()).toBe(true);
    expect(p.text("#dlgBody")).toContain(catTitle("power"));
    await p.click("#dlgOk");
    expect(p.dialogOpen()).toBe(false);
    expect(permSets(p).map((m) => m.actions)).toEqual([{ js_evaluate: true }]);
    await p.until(() => p!.$('input[data-fkey="sw:js_evaluate"]').checked === true, "js_evaluate on");
    expect(p.$('input[data-fkey="catsw:power"]').indeterminate).toBe(true);

    // Full lists every high-risk category that still has a disabled action.
    await p.click('#profileSeg [data-profile="full"]');
    expect(p.dialogOpen()).toBe(true);
    const listed = cats.filter((c) => HIGH.has(c.id)).map((c) => catTitle(c.id));
    expect(p.text("#dlgBody")).toBe(fill(EN.confirmHighRiskBody, { cats: listed.join(", ") }));
    await p.click("#dlgCancel");
    expect(permSets(p)).toHaveLength(1);
    expect(p.checkedProfile()).toBe("custom");

    // Disabling never asks.
    await p.click('input[data-fkey="sw:js_evaluate"]');
    expect(p.dialogOpen()).toBe(false);
    expect(permSets(p).map((m) => m.actions)).toEqual([{ js_evaluate: true }, { js_evaluate: false }]);
    await p.until(() => p!.checkedProfile() === "standard", "the Standard profile");
  }, T);

  test("a change made while the high-risk dialog is open does not widen what gets enabled", async () => {
    p = await PopupPage.open({ disabled: ["cookies_get"] });
    await p.click('#profileSeg [data-profile="full"]');
    expect(p.dialogOpen()).toBe(true);
    expect(p.text("#dlgBody")).toBe(fill(EN.confirmHighRiskBody, { cats: catTitle("cookies") }));
    // Meanwhile the agent switches js_evaluate off (perm_set).
    p.disabled.add("js_evaluate");
    p.agentDisabled.add("js_evaluate");
    await p.storageWrite({ mcpDisabled: [...p.disabled], mcpAgentDisabled: [...p.agentDisabled] });
    expect(p.dialogOpen()).toBe(true);
    await p.click("#dlgOk");
    // Only what the dialog named is enabled; Power was never confirmed.
    expect(permSets(p).map((m) => m.actions)).toEqual([{ cookies_get: true }]);
    await p.until(() => p!.$('input[data-fkey="catsw:cookies"]').checked === true, "cookies on");
    expect(p.checkedProfile()).toBe("custom");
    await p.click('button[data-fkey="cat:power"]');
    const js = p.$('input[data-fkey="sw:js_evaluate"]');
    expect(js.checked).toBe(false);
    expect(js.closest(".tool").querySelector(".agent-off").textContent).toBe(EN.agentDisabledBadge);
  }, T);

  test("actions the agent switched off carry a badge until the user changes them", async () => {
    p = await PopupPage.open({ disabled: ["dom_click", "dom_type"], agentDisabled: ["dom_click"] });
    await p.click('button[data-fkey="cat:interact"]');
    const badgeOf = (a: string) => p!.$(`input[data-fkey="sw:${a}"]`).closest(".tool").querySelector(".agent-off");
    expect(badgeOf("dom_click").textContent).toBe(EN.agentDisabledBadge);
    // The hint is the themed tooltip's text (data-tip), never a native title.
    expect(badgeOf("dom_click").getAttribute("data-tip")).toBe(EN.agentDisabledHint);
    expect(badgeOf("dom_click").hasAttribute("title")).toBe(false);
    expect(badgeOf("dom_type")).toBeNull();
    await p.click('input[data-fkey="sw:dom_click"]');
    expect(permSets(p).map((m) => m.actions)).toEqual([{ dom_click: true }]);
    await p.until(() => p!.$('input[data-fkey="sw:dom_click"]').checked === true, "dom_click on");
    expect(badgeOf("dom_click")).toBeNull();
  }, T);

  test("search matches category descriptions and expands the matching cards", async () => {
    p = await PopupPage.open();
    const q = p.$("#q");
    const search = async (text: string) => {
      q.value = text;
      q.dispatchEvent(new p!.window.Event("input", { bubbles: true }));
      await p!.settle();
    };
    await search("indexeddb");
    const shown = p.$$("#cats .cat");
    expect(shown).toHaveLength(1);
    expect(shown[0].classList.contains("open")).toBe(true);
    expect(shown[0].textContent).toContain(catTitle("storage"));
    expect(p.$("#allOn")).toBeNull();
    expect(p.$("#allOff")).toBeNull();

    // Several matches: clicking one card head collapses only that card.
    await search("_get");
    const open = () => p!.$$("#cats .cat.open .cat-main").map((b) => b.getAttribute("data-fkey"));
    const all = open();
    expect(all.length).toBeGreaterThan(2);
    expect(all).toEqual(p.$$("#cats .cat-main").map((b) => b.getAttribute("data-fkey")));
    const first = () => p!.$(`button[data-fkey="${all[0]}"]`);
    await p.click(first());
    expect(open()).toEqual(all.slice(1));
    expect(first().getAttribute("aria-expanded")).toBe("false");
    // A re-render (a permission change made elsewhere) keeps it collapsed.
    await p.storageWrite({ mcpDisabled: ["dom_click"] });
    expect(open()).toEqual(all.slice(1));
    await p.click(first());
    expect(open()).toEqual(all);
    await p.click(first());
    // A new query expands every match again; clearing it restores the collapsed list.
    await search("_ge");
    expect(open()).toEqual(p.$$("#cats .cat-main").map((b) => b.getAttribute("data-fkey")));
    await search("");
    expect(open()).toEqual([]);
  }, T);
});

describe("status", () => {
  test("there is no version bar: a different server version only shows in the sub-line", async () => {
    p = await PopupPage.open();
    expect(p.$("#verBar")).toBeNull();
    expect(p.document.querySelector(".ver-bar")).toBeNull();
    expect(p.visible("#trustBox")).toBe(false);
    expect(p.text("#subVer")).toBe(`${EN.serverVersionLabel} v${EXT_VERSION}`);

    // A patch or minor difference alone is not a problem: no notice, the pill stays Connected.
    p.status.serverVersion = "9.9.9";
    await p.advance(1000);
    expect(p.text("#subVer")).toBe(`${EN.serverVersionLabel} v9.9.9`);
    expect(p.visible("#trustBox")).toBe(false);
    expect(p.text("#pillTx")).toBe(EN.statusConnected);

    p.status.serverVersion = undefined;
    p.status.bridgeConnected = false;
    p.status.pairState = "none";
    await p.advance(1000);
    expect(p.visible("#subVer")).toBe(false);
    expect(p.visible("#trustBox")).toBe(false);
  }, T);

  test("the sub-line counts agent tabs; the list focuses a tab", async () => {
    p = await PopupPage.open();
    expect(p.text("#subLine")).toBe(`${EN.serverVersionLabel} v${EXT_VERSION} · ${EN.pairedShort} · ${EN.agentTabsNone}`);
    expect(p.document.querySelector("#pairText")?.getAttribute("data-tip")).toBe(EN.statusPairedTitle);
    expect(p.visible("#agentTabsBtn")).toBe(false);

    p.status.agentTabs = [{ id: 4, windowId: 1, title: "Docs", host: "docs.example", active: true }];
    await p.advance(1000);
    expect(p.text("#agentTabsBtn")).toBe(EN.agentTabsOne);
    expect(p.visible("#agentTabsText")).toBe(false);

    p.status.agentTabs = [
      { id: 4, windowId: 1, title: "Docs", host: "docs.example", active: true },
      { id: 7, windowId: 2, title: "A very long title ".repeat(8), host: "shop.example", active: false },
      { id: 9, windowId: 2, title: "", host: "", active: true },
    ];
    await p.advance(1000);
    expect(p.text("#agentTabsBtn")).toBe(fill(EN.agentTabsMany, { n: 3 }));
    expect(p.visible("#agentTabsList")).toBe(false);

    await p.click("#agentTabsBtn");
    expect(p.visible("#agentTabsList")).toBe(true);
    expect(p.$("#agentTabsBtn").getAttribute("aria-expanded")).toBe("true");
    const items = p.$$("#agentTabsItems .at-item");
    expect(items.map((b) => b.querySelector(".at-host").textContent)).toEqual(["docs.example", "shop.example", ""]);
    expect(items[2].querySelector(".at-title").textContent).toBe(`${EN.tabBadgePrefix}9`);
    await p.click(items[1]);
    expect(p.tabUpdates).toEqual([{ id: 7, props: { active: true } }]);
    expect(p.windowUpdates).toEqual([{ id: 2, props: { focused: true } }]);

    // Escape closes the list and returns the focus to its button.
    await p.key("Escape");
    expect(p.visible("#agentTabsList")).toBe(false);
    expect(p.document.activeElement).toBe(p.$("#agentTabsBtn"));
  }, T);

  test("the live activity strip shows running commands and ticks every second", async () => {
    p = await PopupPage.open();
    expect(p.visible("#activity")).toBe(false);
    const now = p.clock.now;
    p.status.running = [
      { id: "c2", action: "dom_click", tabId: 4, host: "example.com", startedAt: now - 4000 },
      { id: "c1", action: "page_snapshot", tabId: 4, host: "example.com", startedAt: now - 9000 },
    ];
    await p.advance(1000);
    expect(p.visible("#activity")).toBe(true);
    expect(p.text("#actLabel")).toBe(EN.activityNow);
    expect(p.text("#actAction")).toBe("dom_click");
    expect(p.text("#actHost")).toBe("example.com");
    expect(p.text("#actTime")).toBe("5s");
    expect(p.text("#actMore")).toBe(fill(EN.activityMore, { n: 1 }));
    // The elapsed time sits outside the part that shrinks (action and host).
    expect(p.$("#actTime").closest(".act-main")).toBeNull();

    // The status poll is stuck: polls do not stack up and the elapsed time still ticks.
    let release: () => void = () => {};
    p.handlers["mcp-status"] = () => new Promise((r) => (release = () => r(undefined)));
    const polls = p.sentOf("mcp-status").length;
    await p.advance(4000);
    expect(p.sentOf("mcp-status")).toHaveLength(polls + 1);
    expect(p.text("#actTime")).toBe("9s");
    // A poll that never answered is retried after the 5 s stall limit.
    await p.advance(2000);
    expect(p.sentOf("mcp-status")).toHaveLength(polls + 2);
    release();
    delete p.handlers["mcp-status"];
    await p.settle();

    p.status.running = [{ id: "c3", action: "tabs_list", tabId: null, host: "", startedAt: p.clock.now }];
    await p.advance(1000);
    expect(p.text("#actAction")).toBe("tabs_list");
    expect(p.visible("#actHost")).toBe(false);
    expect(p.visible("#actMore")).toBe(false);

    p.status.running = [];
    await p.advance(1000);
    expect(p.visible("#activity")).toBe(false);
  }, T);

  test("a stuck history poll does not stack up; polling stops when the popup is hidden", async () => {
    p = await PopupPage.open();
    await p.advance(3000);
    expect(p.sentOf("mcp-status").length).toBeGreaterThan(1);
    expect(p.sentOf("mcp-history-get").length).toBeGreaterThan(1);

    p.handlers["mcp-history-get"] = () => new Promise(() => {});
    const polls = p.sentOf("mcp-history-get").length;
    await p.advance(4500);
    expect(p.sentOf("mcp-history-get")).toHaveLength(polls + 1);

    p.window.dispatchEvent(new p.window.Event("pagehide"));
    const sent = p.sent.length;
    await p.advance(10_000);
    expect(p.sent.length).toBe(sent);
  }, T);
});

const DOCS_URL = "https://github.com/Taiizor/browser-mcp/blob/develop/docs/pairing.md";
// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens.
const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
// File names, environment variables, CLI flags other than --pair and close codes belong in the docs only.
const NOT_IN_NOTICES = /extension-keys\.json|trusted-extensions\.json|BROWSER_MCP_|--extension-id|\b4\d{3}\b/;

// An mcp-status answer (merged over the paired default) after the given close.
const closed = (code: number, reason: string, pairState = "none") => ({
  bridgeConnected: false,
  paired: false,
  pairState,
  lastClose: { code, reason },
});

interface NoticeCase {
  name: string;
  status: Record<string, unknown>;
  /** EN keys */
  pill: string;
  title: string;
  body: string | null;
  pillTone: "off" | "wait";
  /** class of #trustBox: red (plain), amber (warn) or gray (neutral) */
  box: string;
  /** the one primary button, if any */
  action: "repairBtn" | "noticeForget" | "copyId" | null;
  anchor: string;
}

const REPAIR = { pill: "statusActionNeeded", pillTone: "wait", title: "noticeRepairTitle", body: "noticeRepairBody", box: "notice warn", action: "repairBtn", anchor: "pairing-needed" } as const;
const VERSION = { pill: "statusUpdateNeeded", pillTone: "off", title: "noticeVersionTitle", box: "notice warn", action: null, anchor: "versions-do-not-match" } as const;
const NOTICES: NoticeCase[] = [
  { name: "unknown server", status: closed(4101, "server-auth-failed", "server-auth-failed"), pill: "statusUntrustedServer", pillTone: "off", title: "noticeUnknownServerTitle", body: "noticeUnknownServerBody", box: "notice", action: null, anchor: "unknown-server" },
  { name: "new pairing offered", status: closed(4100, "pair-declined", "repair-offered"), ...REPAIR },
  // Re-pair cannot help here (the server challenges the old key instead of offering one).
  { name: "pairing proof rejected", status: closed(4005, "auth-failed", "auth-failed"), ...REPAIR, body: "noticeAuthFailedBody", action: "noticeForget" },
  { name: "pairing closed", status: closed(4004, "pairing-closed", "pairing-closed"), pill: "statusActionNeeded", pillTone: "wait", title: "noticePairClosedTitle", body: "noticePairClosedBody", box: "notice warn", action: null, anchor: "pairing-is-closed" },
  { name: "server without the handshake", status: closed(4102, "server-outdated", "protocol-mismatch"), ...VERSION, body: "noticeVersionServer" },
  { name: "older server protocol", status: closed(4002, "protocol-mismatch:server=2,ext=3", "protocol-mismatch"), ...VERSION, body: "noticeVersionServer" },
  { name: "older extension protocol", status: closed(4002, "protocol-mismatch:server=3,ext=2", "protocol-mismatch"), ...VERSION, body: "noticeVersionExtension" },
  { name: "unknown older side", status: closed(4002, "protocol-mismatch", "protocol-mismatch"), ...VERSION, body: "noticeVersionBoth" },
  { name: "extension not trusted", status: closed(4003, `untrusted-extension:${POPUP_EXT_ID}`), pill: "statusRejected", pillTone: "off", title: "noticeRejectedTitle", body: "noticeRejectedBody", box: "notice", action: "copyId", anchor: "extension-not-recognized" },
  { name: "other close", status: closed(4008, "handshake-timeout"), pill: "statusDisconnected", pillTone: "off", title: "noticeClosedTitle", body: null, box: "notice neutral", action: null, anchor: "connection-closed" },
];

describe("connection notices", () => {
  test("each problem shows a title, one sentence, a Details link to its docs section and at most one action", async () => {
    p = await PopupPage.open();
    expect(p.visible("#trustBox")).toBe(false);
    for (const c of NOTICES) {
      p.status = { ...c.status };
      await p.advance(1000);
      const box = p.$("#trustBox");
      const shownButtons = p.$$("#trustBox button").filter((b) => !b.hidden).map((b) => b.id);
      expect({
        name: c.name,
        shown: p.visible("#trustBox"),
        role: box.getAttribute("role"),
        box: box.className,
        title: p.text("#noticeTitle"),
        body: p.visible("#noticeBody") ? p.text("#noticeBody") : null,
        buttons: shownButtons,
        details: p.text("#noticeDetails"),
        pill: p.text("#pillTx"),
        pillClass: p.$("#pill").className,
      }).toEqual({
        name: c.name,
        shown: true,
        role: "alert",
        box: c.box,
        title: EN[c.title],
        body: c.body ? EN[c.body] : null,
        buttons: c.action ? ["noticeDetails", c.action] : ["noticeDetails"],
        details: EN.btnDetails,
        pill: EN[c.pill],
        pillClass: `badge ${c.pillTone}`,
      });
      // The Details link names the docs heading that carries the notice title.
      expect({ name: c.name, anchor: slug(EN[c.title]) }).toEqual({ name: c.name, anchor: c.anchor });
      // No file paths, environment variables, flags or close codes in the popup.
      const text = String(box.textContent);
      expect({ name: c.name, leaks: text.match(NOT_IN_NOTICES)?.[0] ?? null }).toEqual({ name: c.name, leaks: null });
      expect(box.querySelectorAll("code")).toHaveLength(0);

      const opened = p.tabCreates.length;
      await p.click("#noticeDetails");
      expect(p.tabCreates.slice(opened)).toEqual([{ url: `${DOCS_URL}#${c.anchor}` }]);
    }

    // Back to normal: the notice goes away.
    p.status = {};
    await p.advance(1000);
    expect(p.visible("#trustBox")).toBe(false);
    expect(p.text("#pillTx")).toBe(EN.statusConnected);
  }, T);

  test("Copy ID copies this extension's id and says Copied briefly", async () => {
    p = await PopupPage.open({ status: closed(4003, `untrusted-extension:${POPUP_EXT_ID}`) });
    expect(p.visible("#copyId")).toBe(true);
    expect(p.text("#copyId")).toBe(EN.btnCopyId);
    expect(p.$("#copyId").disabled).toBe(false);
    await p.click("#copyId");
    expect(p.clipboard).toEqual([POPUP_EXT_ID]);
    expect(p.text("#copyId")).toBe(EN.copied);
    await p.advance(1600);
    expect(p.text("#copyId")).toBe(EN.btnCopyId);
    // The menu's Copy keeps its own label.
    await p.click("#menuBtn");
    await p.click("#menuCopyId");
    expect(p.clipboard).toEqual([POPUP_EXT_ID, POPUP_EXT_ID]);
    expect(p.text("#menuCopyId")).toBe(EN.copied);
    await p.advance(1600);
    expect(p.text("#menuCopyId")).toBe(EN.btnCopy);
    expect(p.text("#copyId")).toBe(EN.btnCopyId);
  }, T);

  test("Re-pair sends mcp-repair once and shows the waiting label", async () => {
    for (const status of [closed(4100, "pair-declined", "repair-offered")]) {
      p = await PopupPage.open({ status });
      expect(p.visible("#repairBtn")).toBe(true);
      expect(p.text("#repairBtn")).toBe(EN.btnRepair);
      expect(p.$("#repairBtn").getAttribute("data-tip")).toBe(EN.repairTitle);
      await p.click("#repairBtn");
      expect(p.sentOf("mcp-repair")).toHaveLength(1);
      expect(p.text("#repairBtn")).toBe(EN.btnRepairing);
      expect(p.$("#repairBtn").disabled).toBe(true);
      expect(p.text("#menuRepair")).toBe(EN.btnRepairing);
      // A second click while waiting sends nothing.
      await p.click("#repairBtn");
      expect(p.sentOf("mcp-repair")).toHaveLength(1);
      await p.advance(8100);
      expect(p.text("#repairBtn")).toBe(EN.btnRepair);
      expect(p.$("#repairBtn").disabled).toBe(false);
      await p.close();
      p = null;
    }
  }, T);

  test("a rejected pairing proof offers Forget pairing, behind the confirmation", async () => {
    p = await PopupPage.open({ status: closed(4005, "auth-failed", "auth-failed") });
    expect(p.visible("#repairBtn")).toBe(false);
    expect(p.visible("#noticeForget")).toBe(true);
    expect(p.text("#noticeForget")).toBe(EN.btnForgetPairing);
    // The flag never wraps inside itself; the sentence stays plain text.
    expect(p.text("#noticeBody")).toBe(EN.noticeAuthFailedBody);
    expect(p.$$("#noticeBody .nobr").map((e) => e.textContent)).toEqual(["--pair"]);
    expect(p.$$("#noticeBody *").length).toBe(1);
    expect(p.$("#noticeForget").disabled).toBe(false);
    await p.click("#noticeForget");
    expect(p.dialogOpen()).toBe(true);
    expect(p.text("#dlgTitle")).toBe(EN.confirmForgetTitle);
    await p.click("#dlgCancel");
    expect(p.sentOf("mcp-forget-pairing")).toHaveLength(0);
    await p.click("#noticeForget");
    await p.click("#dlgOk");
    expect(p.sentOf("mcp-forget-pairing")).toHaveLength(1);
    expect(p.sentOf("mcp-repair")).toHaveLength(0);
  }, T);

  test("a close left over from before Re-pair, Forget pairing or a port change shows no notice", async () => {
    // The background resets pairState to "none" and dials again; until the new socket
    // opens, lastClose still names the old close.
    p = await PopupPage.open({ status: closed(4100, "pair-declined", "repair-offered") });
    expect(p.visible("#trustBox")).toBe(true);
    for (const [code, reason] of [[4100, "pair-declined"], [4101, "server-auth-failed"], [4102, "server-outdated"], [4002, "protocol-mismatch:server=3,ext=2"], [4004, "pairing-closed"], [4005, "auth-failed"]] as const) {
      p.status = closed(code, reason);
      await p.advance(1000);
      expect({ code, notice: p.visible("#trustBox"), pill: p.text("#pillTx") }).toEqual({ code, notice: false, pill: EN.statusNoServer });
    }
  }, T);

  test("the notice follows the popup language", async () => {
    p = await PopupPage.open({ status: closed(4004, "pairing-closed", "pairing-closed"), local: { mcpLang: "tr" } });
    const TR = localeText("tr");
    await p.until(() => p!.text("#noticeTitle") === TR.noticePairClosedTitle, "the Turkish notice title");
    expect(p.text("#noticeBody")).toBe(TR.noticePairClosedBody);
    expect(p.text("#noticeDetails")).toBe(TR.btnDetails);
    expect(p.text("#pillTx")).toBe(TR.statusActionNeeded);
  }, T);

  test("every Details anchor is a heading of docs/pairing.md", () => {
    const md = fs.readFileSync(path.join(EXTENSION_DIR, "..", "docs", "pairing.md"), "utf8");
    const headings = new Set([...md.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((m) => slug(m[1])));
    for (const anchor of new Set(NOTICES.map((c) => c.anchor))) {
      expect({ anchor, heading: headings.has(anchor) }).toEqual({ anchor, heading: true });
    }
  });

  test("every locale has the notice texts, without file names, environment variables or close codes", () => {
    const keys = [...new Set(NOTICES.flatMap((c) => [c.title, c.pill, ...(c.body ? [c.body] : [])])), "btnDetails", "btnCopyId", "btnRepair", "btnForgetPairing"];
    const locales = fs.readdirSync(path.join(EXTENSION_DIR, "_locales")).sort();
    expect(locales).toHaveLength(10);
    for (const loc of locales) {
      const L = localeText(loc);
      for (const key of keys) {
        const v = L[key];
        expect({ loc, key, ok: typeof v === "string" && v.trim() !== "", leaks: typeof v === "string" ? (v.match(NOT_IN_NOTICES)?.[0] ?? null) : null }).toEqual({
          loc,
          key,
          ok: true,
          leaks: null,
        });
      }
      // The flag is typed as is in every language.
      for (const key of ["noticePairClosedBody", "noticeAuthFailedBody", "confirmForgetBody"]) {
        expect({ loc, key, pair: String(L[key]).includes("--pair") }).toEqual({ loc, key, pair: true });
      }
    }
  });
});

describe("history", () => {
  test("entries are grouped by host, newest group first, with an Errors filter", async () => {
    const t0 = Date.UTC(2026, 10, 24, 11, 59, 0);
    const history: HistoryEntry[] = [
      { id: "5", action: "dom_click", ok: false, error: "Element not found: #buy", durationMs: 12, time: t0 - 1000, tabId: 7, host: "shop.example", detail: "#buy" },
      { id: "4", action: "page_snapshot", ok: true, durationMs: 40, time: t0 - 2000, tabId: 7, host: "shop.example", detail: "" },
      { id: "3", action: "tabs_list", ok: true, durationMs: 2, time: t0 - 3000, tabId: null, host: "", detail: "" },
      { id: "2", action: "tab_navigate", ok: true, durationMs: 300, time: t0 - 4000, tabId: 9, host: "docs.example", detail: "docs.example" },
      { id: "1", action: "page_text", ok: false, error: "Timed out", durationMs: 5000, time: t0 - 5000, tabId: 9, host: "docs.example" },
    ];
    p = await PopupPage.open({ history });
    expect(p.text("#histBadge")).toBe("5");
    expect(p.text("#navHistory")).toContain(EN.tabRecentCommands);
    await p.click("#navHistory");
    expect(p.visible("#paneHistory")).toBe(true);
    expect(p.visible("#panePerms")).toBe(false);
    const groups = () =>
      p!.$$("#histList .h-group").map((g) => ({
        host: g.querySelector(".h-host").textContent,
        count: g.querySelector(".h-count").textContent,
        actions: Array.from(g.querySelectorAll(".h-action") as ArrayLike<any>).map((c) => c.textContent),
      }));
    expect(groups()).toEqual([
      { host: "shop.example", count: "2", actions: ["dom_click", "page_snapshot"] },
      { host: EN.historyUnknownSite, count: "1", actions: ["tabs_list"] },
      { host: "docs.example", count: "2", actions: ["tab_navigate", "page_text"] },
    ]);
    const first = p.$("#histList .h-entry");
    expect(first.querySelector(".h-detail").textContent).toBe("#buy");
    expect(first.querySelector(".h-dur").textContent).toBe("12ms");

    expect(p.text("#errCount")).toBe("2");
    await p.click("#filterErrors");
    expect(p.$("#filterErrors").getAttribute("aria-pressed")).toBe("true");
    expect(groups()).toEqual([
      { host: "shop.example", count: "1", actions: ["dom_click"] },
      { host: "docs.example", count: "1", actions: ["page_text"] },
    ]);

    // A row toggles its details: error text, tab and detail.
    const row = p.$("#histList .h-row");
    const more = row.parentElement.querySelector(".h-more");
    expect(more.hidden).toBe(true);
    await p.click(row);
    expect(more.hidden).toBe(false);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(more.querySelector(".h-err").textContent).toBe("Element not found: #buy");
    expect(more.textContent).toContain(`${EN.tabBadgePrefix}7`);
    // Expanded rows stay expanded across polls.
    p.history = [{ id: "6", action: "tabs_list", ok: true, durationMs: 1, time: t0, host: "" }, ...history];
    await p.advance(1500);
    expect(p.text("#histBadge")).toBe("6");
    expect(p.$("#histList .h-more").hidden).toBe(false);

    p.history = history.filter((e) => e.ok);
    await p.advance(1500);
    expect(p.text("#histList")).toBe(EN.historyNoErrors);
    expect(p.visible("#errCount")).toBe(false);
    await p.click("#filterAll");
    expect(groups().map((g) => g.host)).toEqual(["shop.example", EN.historyUnknownSite, "docs.example"]);

    await p.click("#clearHist");
    expect(p.sentOf("mcp-history-clear")).toHaveLength(1);
    expect(p.text("#histList")).toBe(EN.noCommands);
    expect(p.text("#histBadge")).toBe("0");
  }, T);

  test("peer-supplied text is rendered as text, never as HTML", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    p = await PopupPage.open({
      history: [
        { id: "<b>id</b>", action: evil, ok: false, error: "<b>bold</b><script>alert(2)</script>", durationMs: 1, time: Date.now(), tabId: 3, host: "<svg onload=alert(3)>", detail: evil },
      ],
      status: {
        running: [{ id: "x", action: evil, tabId: 3, host: "<i>host</i>", startedAt: Date.now() }],
        agentTabs: [{ id: 3, windowId: 1, title: evil, host: "<u>h</u>", active: true }],
        serverVersion: "<b>1</b>",
      },
    });
    await p.click("#navHistory");
    await p.click("#histList .h-row");
    await p.click("#agentTabsBtn");
    expect(p.$("#histList .h-action").textContent).toBe(evil);
    expect(p.$("#histList .h-detail").textContent).toBe(evil);
    expect(p.$("#histList .h-host").textContent).toBe("<svg onload=alert(3)>");
    expect(p.$("#histList .h-err").textContent).toBe("<b>bold</b><script>alert(2)</script>");
    expect(p.text("#actAction")).toBe(evil);
    expect(p.$("#agentTabsItems .at-title").textContent).toBe(evil);
    // Nothing was parsed: the only image is the header logo, no peer markup exists.
    expect(p.$$("img").map((i) => i.getAttribute("src"))).toEqual(["icons/icon.svg"]);
    for (const box of ["#histList", "#activity", "#agentTabsItems", "#subLine"]) {
      expect({ box, parsed: p.$(box).querySelectorAll("script, img, b, i, u, [onerror], [onload]").length }).toEqual({ box, parsed: 0 });
    }
    expect(p.$$("[onerror], [onload], script")).toHaveLength(0);
    // A server version that is not a version string is not shown at all.
    expect(p.visible("#subVer")).toBe(false);
    expect(p.visible("#trustBox")).toBe(false);
  }, T);
});

describe("actions and settings", () => {
  test("Stop agent sends mcp-stop-all at once and confirms briefly", async () => {
    p = await PopupPage.open({ status: { running: [{ id: "c1", action: "dom_click", tabId: 1, host: "example.com", startedAt: Date.now() }] } });
    expect(p.text("#stopAllTx")).toBe(EN.stopAll);
    expect(p.$("#stopAll").getAttribute("data-tip")).toBe(EN.stopAllHint);
    await p.click("#stopAll");
    expect(p.dialogOpen()).toBe(false);
    expect(p.sentOf("mcp-stop-all")).toHaveLength(1);
    expect(p.text("#stopAllTx")).toBe(EN.stopAllDone);
    expect(p.$$('#cats input[data-fkey^="catsw:"]').every((i) => !i.checked && !i.indeterminate)).toBe(true);
    expect(p.visible("#activity")).toBe(false);
    await p.advance(2600);
    expect(p.text("#stopAllTx")).toBe(EN.stopAll);
  }, T);

  test("the settings menu: Forget pairing needs the confirmation; Escape closes the menu", async () => {
    p = await PopupPage.open();
    expect(p.visible("#menu")).toBe(false);
    expect(p.$("#menuBtn").getAttribute("aria-label")).toBe(EN.menuTitle);
    // A disclosure, not an ARIA menu (no arrow-key menu items).
    expect(p.$("#menuBtn").hasAttribute("aria-haspopup")).toBe(false);
    expect(p.$("#menu").getAttribute("role")).toBe("group");
    await p.click("#menuBtn");
    expect(p.visible("#menu")).toBe(true);
    expect(p.$("#menuBtn").getAttribute("aria-expanded")).toBe("true");
    expect(p.text("#menuVer")).toBe(`v${EXT_VERSION}`);
    expect(p.text("#menuExtId")).toBe("abcdefghijklmnopabcdefghijklmnop");

    await p.click("#forgetPair");
    expect(p.dialogOpen()).toBe(true);
    expect(p.text("#dlgTitle")).toBe(EN.confirmForgetTitle);
    expect(p.text("#dlgBody")).toBe(EN.confirmForgetBody);
    expect(p.text("#dlgOk")).toBe(EN.btnForgetPairing);
    expect(p.$("#confirmDlg").getAttribute("role")).toBe("dialog");
    expect(p.$("#confirmDlg").getAttribute("aria-modal")).toBe("true");
    expect(p.sentOf("mcp-forget-pairing")).toHaveLength(0);

    await p.click("#dlgCancel");
    expect(p.dialogOpen()).toBe(false);
    expect(p.sentOf("mcp-forget-pairing")).toHaveLength(0);
    expect(p.visible("#menu")).toBe(true);
    expect(p.document.activeElement).toBe(p.$("#forgetPair"));

    await p.click("#forgetPair");
    await p.click("#dlgOk");
    expect(p.sentOf("mcp-forget-pairing")).toHaveLength(1);
    await p.until(() => p!.$("#forgetPair").disabled === true, "Forget pairing to be disabled without a key");

    // An outside click closes the menu; Escape closes it and returns the focus.
    await p.click("#navHistory");
    expect(p.visible("#menu")).toBe(false);
    await p.click("#menuBtn");
    expect(p.visible("#menu")).toBe(true);
    await p.key("Escape");
    expect(p.visible("#menu")).toBe(false);
    expect(p.document.activeElement).toBe(p.$("#menuBtn"));
  }, T);

  test("the language button has one globe; picking a language re-renders the popup", async () => {
    p = await PopupPage.open();
    await p.click("#menuBtn");
    const btn = p.$("#langBtn");
    expect(btn.querySelectorAll("svg.lang-globe")).toHaveLength(1);
    expect(btn.querySelectorAll("svg")).toHaveLength(2); // globe + arrow
    expect(btn.textContent).not.toContain("🌐");
    expect(p.text("#langCurrentText")).toBe(EN.langAuto);
    expect(p.document.body.textContent).not.toContain("🌐");
    expect(p.visible("#langMenu")).toBe(false);

    await p.click(btn);
    expect(p.visible("#langMenu")).toBe(true);
    expect(p.$$(".lang-item")).toHaveLength(11);
    await p.click('.lang-item[data-val="de"]');
    const DE = localeText("de");
    await p.until(() => p!.text("#langCurrentText") === "Deutsch", "the German label");
    expect(p.local.mcpLang).toBe("de");
    expect(p.visible("#langMenu")).toBe(false);
    expect(p.document.documentElement.lang).toBe("de");
    expect(p.text("#navPerms")).toBe(DE.tabPermissions);
    expect(p.text("#stopAllTx")).toBe(DE.stopAll);
    // Static tooltips follow the language too.
    expect(p.$("#stopAll").getAttribute("data-tip")).toBe(DE.stopAllHint);
    expect(p.$("#menuBtn").getAttribute("data-tip")).toBe(DE.menuTitle);
    expect(p.$('.lang-item[data-val="de"]').getAttribute("aria-pressed")).toBe("true");
  }, T);
});

describe("tooltip", () => {
  const pillTip = `${EN.statusPairedTitle} · ${EN.serverVersionLabel} v${EXT_VERSION}`;
  // Elements whose aria-describedby names the tooltip.
  const described = (x: PopupPage) => x.$$("[aria-describedby]").filter((n) => /(^|\s)tip(\s|$)/.test(n.getAttribute("aria-describedby"))).map((n) => n.id || n.className);

  test("one shared #tip, opened by the Popover API where it exists", async () => {
    p = await PopupPage.open();
    const tip = p.$("#tip");
    expect(p.$$("#tip, [role=tooltip]")).toHaveLength(1);
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.getAttribute("popover")).toBe("manual");
    expect(p.tip()).toEqual({ open: false, text: "" });
  }, T);

  test("hover shows the tip after a delay and describes the target; leaving hides it and restores aria-describedby", async () => {
    p = await PopupPage.open();
    const pill = p.$("#pill");
    expect(pill.getAttribute("data-tip")).toBe(pillTip);
    // The pointer on the label inside the pill: the pill's tip, after the delay.
    await p.hover("#pillTx");
    await p.advance(300);
    expect(p.tip().open).toBe(false);
    await p.advance(60);
    expect(p.tip()).toEqual({ open: true, text: pillTip });
    expect(pill.getAttribute("aria-describedby")).toBe("tip");
    // Moving inside the target keeps the tip open, and so does crossing the gap onto the
    // tip. The tip takes no pointer event (the pointer is over the sub-line under it):
    // its box tells, given here (happy-dom has no layout).
    p.setBox("#tip", 120, 40, 230, 32);
    await p.unhover("#pillTx", pill);
    await p.unhover(pill, p.$("#subLine"), { x: 200, y: 36 });
    await p.move("#subLine", 200, 50);
    await p.advance(1000);
    expect(p.tip().open).toBe(true);
    // Leaving the tip hides it after a short grace.
    await p.move("#subLine", 200, 80);
    await p.advance(200);
    expect(p.tip().open).toBe(false);
    expect(pill.hasAttribute("aria-describedby")).toBe(false);
    delete p.$("#tip").getBoundingClientRect;

    // A previous aria-describedby is kept while shown and restored afterwards.
    const stop = p.$("#stopAll");
    stop.setAttribute("aria-describedby", "other");
    await p.hover(stop);
    await p.advance(400);
    expect(p.tip()).toEqual({ open: true, text: EN.stopAllHint });
    expect(stop.getAttribute("aria-describedby")).toBe("other tip");
    // The next target takes over at once: one tip at a time.
    await p.unhover(stop, pill);
    await p.hover(pill);
    expect(p.tip()).toEqual({ open: true, text: pillTip });
    expect(stop.getAttribute("aria-describedby")).toBe("other");
    expect(described(p)).toEqual(["pill"]);
    await p.unhover(pill);
    await p.advance(200);
    expect(p.tip().open).toBe(false);
    expect(described(p)).toEqual([]);

    // Leaving before the delay shows nothing.
    await p.hover(stop);
    await p.advance(200);
    await p.unhover(stop);
    await p.advance(1000);
    expect(p.tip().open).toBe(false);
  }, T);

  test("keyboard focus shows the tip at once; blur, Escape, a click and a scroll hide it", async () => {
    p = await PopupPage.open();
    const stop = p.$("#stopAll");
    stop.focus();
    await p.settle();
    expect(p.tip()).toEqual({ open: true, text: EN.stopAllHint });
    expect(stop.getAttribute("aria-describedby")).toBe("tip");
    stop.blur();
    await p.settle();
    expect(p.tip().open).toBe(false);
    expect(stop.hasAttribute("aria-describedby")).toBe(false);

    // In the menu, the first Escape closes only the tip, the second the menu.
    await p.click("#menuBtn");
    expect(p.visible("#menu")).toBe(true);
    p.$("#portSave").focus();
    await p.settle();
    expect(p.tip()).toEqual({ open: true, text: EN.portSaveTitle });
    await p.key("Escape");
    expect(p.tip().open).toBe(false);
    expect(p.visible("#menu")).toBe(true);
    expect(p.$("#portSave").hasAttribute("aria-describedby")).toBe(false);
    await p.key("Escape");
    expect(p.visible("#menu")).toBe(false);
    // The focus is back on the icon-only menu button: its tip shows, and is not also its
    // description, because it repeats the aria-label that stays its name.
    expect(p.document.activeElement).toBe(p.$("#menuBtn"));
    expect(p.tip()).toEqual({ open: true, text: EN.menuTitle });
    expect(p.$("#menuBtn").getAttribute("aria-label")).toBe(EN.menuTitle);
    expect(p.$("#menuBtn").hasAttribute("aria-describedby")).toBe(false);
    expect(p.$("#portReset").getAttribute("aria-label")).toBe(EN.portResetTitle);
    await p.key("Escape");
    expect(p.tip().open).toBe(false);

    // A click on the target hides the tip; it stays away until the pointer leaves.
    await p.hover("#pill");
    await p.advance(400);
    expect(p.tip().open).toBe(true);
    await p.click("#pill");
    expect(p.tip().open).toBe(false);
    await p.hover("#pillTx");
    await p.advance(400);
    expect(p.tip().open).toBe(false);
    await p.unhover("#pill");
    await p.hover("#pill");
    await p.advance(400);
    expect(p.tip().open).toBe(true);

    // A scroll (in any list) hides a tip the pointer opened.
    p.$("#cats").dispatchEvent(new p.window.Event("scroll"));
    await p.settle();
    expect(p.tip().open).toBe(false);
  }, T);

  test("no element carries a native title, after init or a status poll; tips follow the status", async () => {
    const now = Date.UTC(2026, 10, 24, 12, 0, 0);
    p = await PopupPage.open({
      status: {
        running: [
          { id: "c2", action: "dom_click", tabId: 4, host: "example.com", startedAt: now - 4000 },
          { id: "c1", action: "page_snapshot", tabId: 4, host: "", startedAt: now - 9000 },
        ],
      },
    });
    const titled = () => p!.$$("[title]").map((n) => n.id || n.className);
    expect(titled()).toEqual([]);
    // Every static tip is a translated data-tip.
    for (const [sel, key] of [["#menuBtn", "menuTitle"], ["#portSave", "portSaveTitle"], ["#portReset", "portResetTitle"], ["#langBtn", "langSelectTitle"], ["#menuRepair", "repairTitle"], ["#forgetPair", "forgetPairingTitle"], ["#stopAll", "stopAllHint"], ["header .t", "extName"]] as const) {
      expect({ sel, tip: p.$(sel).getAttribute("data-tip") }).toEqual({ sel, tip: EN[key] });
    }
    // Several running commands: the strip lists them all.
    expect(p.$("#activity").getAttribute("data-tip")).toBe("dom_click · example.com\npage_snapshot");
    // An action that fits shows the strip's tip; one that is cut shows itself.
    await p.hover("#actAction");
    await p.advance(400);
    expect(p.tip().text).toBe("dom_click · example.com\npage_snapshot");
    await p.unhover("#actAction");
    await p.advance(200);
    p.setCut("#actAction");
    await p.hover("#actAction");
    await p.advance(400);
    expect(p.tip().text).toBe("dom_click");
    await p.unhover("#actAction");
    await p.advance(200);

    // The pill's tip changes with the state, also while it is shown.
    await p.hover("#pill");
    await p.advance(400);
    expect(p.tip()).toEqual({ open: true, text: pillTip });
    p.status = { paired: false, pairState: "handshake", running: [] };
    await p.advance(1000);
    expect(p.$("#pill").getAttribute("data-tip")).toBe(EN.statusHandshakeTitle);
    expect(p.tip()).toEqual({ open: true, text: EN.statusHandshakeTitle });
    expect(p.$("#activity").hasAttribute("data-tip")).toBe(false);
    expect(titled()).toEqual([]);
    // A problem state has no pill tip (the notice explains it): the open tip goes away.
    p.status = closed(4100, "pair-declined", "repair-offered");
    await p.advance(1000);
    expect(p.$("#pill").hasAttribute("data-tip")).toBe(false);
    expect(p.tip().open).toBe(false);
    expect(p.$("#pill").hasAttribute("aria-describedby")).toBe(false);
    expect(p.$("#repairBtn").getAttribute("data-tip")).toBe(EN.repairTitle);
    expect(titled()).toEqual([]);
    // Not paired yet: the sub-line explains it in its tip.
    p.status = { bridgeConnected: false, paired: false, pairState: "none", hasKey: false, lastClose: null };
    await p.advance(1000);
    expect(p.text("#pairText")).toBe(EN.pairInfoNoKey);
    expect(p.$("#pairText").getAttribute("data-tip")).toBe(EN.pairInfoNoKeyTitle);
    expect(titled()).toEqual([]);
    // An explicit tip wins over the element's own cut text.
    p.setCut("#pairText");
    await p.hover("#pairText");
    await p.advance(400);
    expect(p.tip().text).toBe(EN.pairInfoNoKeyTitle);
  }, T);

  test("overflow tips show the full text only while it is cut, and as text only", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    p = await PopupPage.open({
      history: [{ id: "1", action: evil, ok: false, error: "x", durationMs: 1, time: Date.now(), tabId: 3, host: "<b>shop</b>.example", detail: "" }],
    });
    await p.click("#navHistory");
    const action = p.$("#histList .h-action");
    expect(action.hasAttribute("data-tip-overflow")).toBe(true);
    expect(action.hasAttribute("data-tip")).toBe(false);
    // Not cut: no tip.
    await p.hover(action);
    await p.advance(400);
    expect(p.tip().open).toBe(false);
    await p.unhover(action);
    // Cut: its own text, set as text.
    p.setCut(action);
    await p.hover(action);
    await p.advance(400);
    expect(p.tip()).toEqual({ open: true, text: evil });
    expect(p.$("#tip").children).toHaveLength(0);
    expect(p.$$("img").map((i) => i.getAttribute("src"))).toEqual(["icons/icon.svg"]);
    expect(p.$$("[onerror], b")).toHaveLength(0);
    // It only repeats visible text: not a description, and hidden from screen readers.
    expect(action.hasAttribute("aria-describedby")).toBe(false);
    expect(p.$("#tip").getAttribute("aria-hidden")).toBe("true");
    await p.unhover(action);
    await p.advance(200);
    expect(p.tip().open).toBe(false);

    // Keyboard focus on the row shows its cut parts.
    p.setCut("#histList .h-host");
    p.$("#histList .h-row").focus();
    await p.settle();
    expect(p.tip()).toEqual({ open: true, text: evil });
    p.$("#histList .h-row").blur();
    await p.settle();
    // The host in the group head.
    await p.hover("#histList .h-host");
    await p.advance(400);
    expect(p.tip()).toEqual({ open: true, text: "<b>shop</b>.example" });
    expect(p.$("#tip").children).toHaveLength(0);
  }, T);

  test("the tip goes away with its target", async () => {
    p = await PopupPage.open({ status: { agentTabs: [{ id: 4, windowId: 1, title: "A very long title ".repeat(5).trim(), host: "docs.example", active: true }] } });
    await p.click("#agentTabsBtn");
    const title = p.$("#agentTabsItems .at-title");
    expect(title.hasAttribute("data-tip-overflow")).toBe(true);
    expect(p.$("#agentTabsItems .at-item").hasAttribute("data-tip")).toBe(false);
    p.setCut(title);
    await p.hover(title);
    await p.advance(400);
    expect(p.tip()).toEqual({ open: true, text: "A very long title ".repeat(5).trim() });
    // The next status poll replaces the list: the target leaves the DOM.
    p.status.agentTabs = [{ id: 5, windowId: 1, title: "Other", host: "other.example", active: true }];
    await p.advance(1000);
    expect(title.isConnected).toBe(false);
    expect(p.tip().open).toBe(false);
  }, T);

  test("the tip takes no click: one on it reaches the control under it, and the agent tab list stays open", async () => {
    const long = "A very long title ".repeat(5).trim();
    p = await PopupPage.open({
      status: {
        agentTabs: [
          { id: 4, windowId: 1, title: long, host: "docs.example", active: true },
          { id: 5, windowId: 2, title: "Other", host: "other.example", active: false },
        ],
      },
    });
    expect(p.window.getComputedStyle(p.$("#tip")).pointerEvents).toBe("none");
    await p.click("#agentTabsBtn");
    const [row1, row2] = p.$$("#agentTabsItems .at-item");
    const title = row1.querySelector(".at-title");
    p.setCut(title);
    await p.hover(title, { x: 120, y: 120 });
    await p.advance(400);
    expect(p.tip()).toEqual({ open: true, text: long });
    // The tip covers the next row. The pointer moves down onto it: the tip stays while
    // the pointer is on it, even over the cut title of the row under it.
    const title2 = row2.querySelector(".at-title");
    p.setCut(title2);
    p.setBox("#tip", 8, 140, 240, 46);
    await p.unhover(title, title2, { x: 120, y: 150 });
    await p.hover(title2, { x: 120, y: 150 });
    await p.advance(1000);
    expect(p.tip()).toEqual({ open: true, text: long });
    // Off the tip, that title shows its own tip at once.
    await p.move(title2, 120, 190);
    expect(p.tip()).toEqual({ open: true, text: "Other" });
    // A click there is the row's: its tab comes to the front, the list stays open and
    // the tip goes.
    await p.click(row2);
    expect(p.tabUpdates).toEqual([{ id: 5, props: { active: true } }]);
    expect(p.visible("#agentTabsList")).toBe(true);
    expect(p.tip().open).toBe(false);
  }, T);

  test("a tip the focus opened follows its target: through a scroll while in view, and when the layout moves it", async () => {
    const now = Date.UTC(2026, 10, 24, 12, 0, 0);
    p = await PopupPage.open({ status: { running: [{ id: "c1", action: "dom_click", tabId: 4, host: "example.com", startedAt: now - 4000 }] } });
    const tip = p.$("#tip");
    Object.defineProperty(tip, "offsetWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(tip, "offsetHeight", { configurable: true, get: () => 40 });
    const main = p.$("#cats .cat-main");
    const desc = main.querySelector(".cat-desc");
    p.setCut(desc);
    p.setBox("#cats", 0, 200, 360, 300);
    p.setBox(main, 16, 440, 300, 40);
    main.focus();
    await p.settle();
    expect(p.tip()).toEqual({ open: true, text: desc.textContent });
    expect(tip.style.top).toBe("487px");
    // The focus scrolls the list to show its card (Tab): the tip stays, at the new place.
    p.setBox(main, 16, 300, 300, 40);
    p.$("#cats").dispatchEvent(new p.window.Event("scroll"));
    await p.settle();
    expect(p.tip().open).toBe(true);
    expect(tip.style.top).toBe("347px");
    // The activity strip above goes away with the next status poll: the card moves up,
    // and the tip with it.
    expect(p.visible("#activity")).toBe(true);
    p.setBox(main, 16, 260, 300, 40);
    p.status = { running: [] };
    await p.advance(1000);
    expect(p.visible("#activity")).toBe(false);
    expect(p.document.activeElement).toBe(main);
    expect(p.tip().open).toBe(true);
    expect(tip.style.top).toBe("307px");
    // Scrolled out of the list's view: the tip goes.
    p.setBox(main, 16, 150, 300, 40);
    p.$("#cats").dispatchEvent(new p.window.Event("scroll"));
    await p.settle();
    expect(p.tip().open).toBe(false);
  }, T);

  test("the tip sits below its target, above it near the bottom, centred and 8 px inside the popup", async () => {
    p = await PopupPage.open();
    const tip = p.$("#tip");
    // happy-dom has no layout: a 200 x 40 tip and targets at given places.
    Object.defineProperty(tip, "offsetWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(tip, "offsetHeight", { configurable: true, get: () => 40 });
    const at = (sel: string, left: number, top: number, width: number, height: number) => {
      p!.$(sel).getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
    };
    const place = () => ({ left: tip.style.left, top: tip.style.top, side: tip.getAttribute("data-side"), arrow: tip.style.getPropertyValue("--tip-arrow-x") });
    // Near the right edge: kept 8 px inside, the arrow still at the target's centre.
    at("#pill", 300, 12, 52, 20);
    await p.hover("#pill");
    await p.advance(400);
    expect(place()).toEqual({ left: "152px", top: "39px", side: "below", arrow: "174px" });
    // Near the bottom: above the target.
    at("#stopAll", 16, 510, 328, 32);
    await p.unhover("#pill", p.$("#stopAll"));
    await p.hover("#stopAll");
    expect(place()).toEqual({ left: "80px", top: "463px", side: "above", arrow: "100px" });
    // Near the left edge: the arrow stays clear of the rounded corner.
    at("header .t", 0, 10, 20, 18);
    await p.unhover("#stopAll", p.$("header .t"));
    await p.hover("header .t");
    expect(place()).toEqual({ left: "8px", top: "35px", side: "below", arrow: "12px" });
  }, T);
});
