// Permission gate, known-actions migration, debugger-session teardown,
// permissions_grant validation and the active-tab fallback rule of the REAL
// extension/background.js, driven over the real bridge.

import { afterEach, describe, expect, test } from "bun:test";
import { ExtHarness, rejectionOf, sleep, waitFor } from "../helpers/ext-harness.js";

const T = 20_000;

let h: ExtHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const disabledOf = (x: ExtHarness) => new Set<string>(x.bg.state.disabledActions);

describe("permission gate", () => {
  test("only catalog actions are routed; switches and REQUIRES are enforced", async () => {
    h = await ExtHarness.create();
    for (const action of ["totally_unknown_action", "__ping", "__cancel", "eval", "constructor"]) {
      expect((await rejectionOf(h.server.send(action, {}))).message).toContain(`Unknown command: ${action}`);
    }
    // tab_list is the MCP name of tabs_list and is gated as tabs_list.
    expect(Array.isArray(await h.server.send("tab_list", {}))).toBe(true);

    expect(await h.popup({ type: "mcp-perms-set", action: "tabs_list", enabled: false })).toMatchObject({ ok: true });
    expect((await rejectionOf(h.server.send("tab_list", {}))).message).toContain("Permission disabled in extension: tab_list");
    expect((await rejectionOf(h.server.send("tabs_list", {}))).message).toContain("Permission disabled in extension: tabs_list");
    await waitFor(() => h!.server.knownDisabled()?.includes("tabs_list"), "the perms event to reach the server");

    // Composite actions need their data sources switched on as well.
    await h.popup({ type: "mcp-perms-set", action: "network_requests", enabled: false });
    expect((await rejectionOf(h.server.send("har_export", {}))).message).toContain("Permission disabled in extension: network_requests (required by har_export");

    // Over the bridge a switch can only be turned off.
    expect((await rejectionOf(h.server.send("perm_set", { action: "tabs_list", enabled: true }))).message).toMatch(/only possible from the extension popup/);
    expect(await h.server.send("perm_set", { action: "dom_click", enabled: false })).toMatchObject({ ok: true, enabled: false });
    expect(disabledOf(h).has("dom_click")).toBe(true);
    expect(h.store.local.mcpDisabled).toEqual(expect.arrayContaining(["tabs_list", "network_requests", "dom_click"]));
  }, T);

  test("upgrade from 0.3.5: new actions of a category switched off entirely start disabled", async () => {
    // 0.3.5 stored no mcpKnownActions. Both geolocation switches were off, so
    // the new emulation_* actions start off; page_metrics was on, so perf_* stay on.
    h = await ExtHarness.create({ local: { mcpDisabled: ["emulation_geolocation", "emulation_geolocation_clear", "history_search"] } });
    const off = h.server.knownDisabled() ?? [];
    for (const a of ["emulation_viewport", "emulation_media", "emulation_cpu", "emulation_reset"]) expect(off).toContain(a);
    for (const a of ["perf_web_vitals", "perf_trace_start", "page_metrics", "history_delete", "permissions_grant"]) expect(off).not.toContain(a);
    const known = h.store.local.mcpKnownActions as string[];
    expect(known).toEqual(expect.arrayContaining(["emulation_viewport", "perf_trace_chunk", "tabs_list"]));
    expect(h.store.local.mcpDisabled).toEqual(expect.arrayContaining(["emulation_viewport", "emulation_reset"]));
    const refused = await rejectionOf(h.server.send("emulation_viewport", { width: 400, height: 300 }, 1));
    expect(refused.message).toContain("Permission disabled in extension: emulation_viewport");
    await h.close();

    // page_metrics off -> the performance additions start off.
    h = await ExtHarness.create({ local: { mcpDisabled: ["page_metrics"] } });
    expect(h.server.knownDisabled()).toEqual(expect.arrayContaining(["perf_web_vitals", "perf_trace_start", "perf_trace_stop", "perf_trace_chunk"]));
    expect(h.server.knownDisabled()).not.toContain("emulation_viewport");
    await h.close();

    // The current catalog already known: a switched-off category stays as the user left it.
    h = await ExtHarness.create({ local: { mcpKnownActions: known, mcpDisabled: ["emulation_geolocation", "emulation_geolocation_clear"] } });
    expect(h.server.knownDisabled()?.slice().sort()).toEqual(["emulation_geolocation", "emulation_geolocation_clear"]);
  }, T);
});

describe("debugger session teardown", () => {
  test("switching off a controlling action tears down only its session", async () => {
    h = await ExtHarness.create();
    await h.server.send("emulation_viewport", { width: 500, height: 600 }, 1);
    await h.server.send("emulation_cpu", { rate: 4 }, 1);
    expect(h.bg.state.viewportSessions.has(1)).toBe(true);
    expect(h.bg.state.cpuSessions.has(1)).toBe(true);
    const mark = h.chrome.cdp.length;

    await h.popup({ type: "mcp-perms-set", action: "emulation_viewport", enabled: false });
    await waitFor(
      () => !h!.bg.state.viewportSessions.has(1) && h!.chrome.cdp.slice(mark).some((c) => c.method === "Emulation.setTouchEmulationEnabled" && c.params.enabled === false),
      "the viewport teardown"
    );
    const after = h.chrome.cdp.slice(mark).map((c) => c.method);
    expect(after).toContain("Emulation.clearDeviceMetricsOverride");
    expect(after).not.toContain("Emulation.setCPUThrottlingRate");
    expect(h.bg.state.cpuSessions.has(1)).toBe(true);
    // The shared "emulation" holder stays while cpu throttling uses it.
    expect(h.chrome.debuggerOps.filter((o) => o.op === "detach")).toHaveLength(0);
    expect((await rejectionOf(h.server.send("emulation_viewport", { width: 1, height: 1 }, 1))).message).toMatch(/Permission disabled/);

    await h.popup({ type: "mcp-perms-set", action: "emulation_cpu", enabled: false });
    await waitFor(() => h!.chrome.debuggerOps.some((o) => o.op === "detach" && o.tabId === 1), "the debugger to detach");
    expect(h.chrome.cdpCalls("Emulation.setCPUThrottlingRate").at(-1)?.params).toEqual({ rate: 1 });
    expect(h.bg.state.cpuSessions.size).toBe(0);
  }, T);

  test("sessions are torn down after the bridge has been down for 30 s (warped extension clock)", async () => {
    h = await ExtHarness.create();
    await h.server.send("emulation_viewport", { width: 500, height: 600 }, 1);
    await h.server.send("emulation_media", { colorScheme: "dark" }, 1);
    await h.server.send("network_mock_start", {}, 1);
    expect(h.bg.state.fetchSessions.has(1)).toBe(true);

    h.server.close();
    await waitFor(() => !h!.bg.state.paired, "the extension to notice the closed server");
    await waitFor(() => typeof h!.store.session.mcpBridgeDownAt === "number", "mcpBridgeDownAt");
    await h.bg.clock.advance(29_000);
    await sleep(30);
    expect(h.chrome.cdpCalls("Emulation.clearDeviceMetricsOverride")).toHaveLength(0);
    expect(h.bg.state.viewportSessions.has(1)).toBe(true);

    await h.bg.clock.advance(2_000);
    await waitFor(
      () => h!.bg.state.viewportSessions.size + h!.bg.state.mediaSessions.size + h!.bg.state.fetchSessions.size === 0,
      "every session to be torn down"
    );
    await waitFor(() => h!.chrome.debuggerOps.some((o) => o.op === "detach" && o.tabId === 1), "the debugger to detach");
    expect(h.chrome.cdpCalls("Emulation.clearDeviceMetricsOverride", 1)).toHaveLength(1);
    expect(h.chrome.cdpCalls("Emulation.setEmulatedMedia", 1).at(-1)?.params).toEqual({ media: "", features: [] });
    expect(h.chrome.cdpCalls("Fetch.disable", 1)).toHaveLength(1);
    expect(h.store.session.mcpMock).toEqual([]);
  }, T);

  test("a reconnect within the grace period keeps the sessions", async () => {
    h = await ExtHarness.create();
    await h.server.send("emulation_viewport", { width: 500, height: 600 }, 1);
    h.bg.state.reconnectNow();
    await h.waitPaired();
    await h.bg.clock.advance(31_000);
    await sleep(50);
    expect(h.bg.state.viewportSessions.has(1)).toBe(true);
    expect(h.chrome.cdpCalls("Emulation.clearDeviceMetricsOverride")).toHaveLength(0);
    expect(h.store.session.mcpBridgeDownAt).toBeUndefined();
  }, T);

  test("after a worker restart, parked sessions wait for a paired bridge and are dropped after 30 s without one", async () => {
    h = await ExtHarness.create();
    await h.server.send("network_mock_start", {}, 1);
    await h.server.send("network_mock_route", { pattern: "*://api.example/*", action: "block" }, 1);
    expect(h.store.session.mcpMock).toEqual([expect.objectContaining({ tabId: 1 })]);
    expect(h.store.session.mcpDbgTabs).toEqual([1]);

    // The worker dies while the bridge is up; then the server goes away too.
    h.bg.dispose();
    h.server.close();
    const worker = h.startWorker();
    await sleep(200);
    // Nothing is re-armed without a paired bridge.
    expect(h.chrome.cdpCalls("Fetch.enable")).toHaveLength(0);
    expect(h.chrome.debuggerOps).toHaveLength(0);
    expect(worker.state.fetchSessions.size).toBe(0);

    await worker.clock.advance(31_000);
    await waitFor(() => h!.chrome.debuggerOps.some((o) => o.op === "detach" && o.tabId === 1), "the leftover attach to be detached");
    await waitFor(() => Array.isArray(h!.store.session.mcpMock) && (h!.store.session.mcpMock as unknown[]).length === 0, "mcpMock to be cleared");
    expect(h.store.session.mcpDbgTabs).toEqual([]);
    expect(h.chrome.cdpCalls("Fetch.enable")).toHaveLength(0);
  }, T);

  test("after a worker restart, a paired bridge re-arms the parked mock session", async () => {
    h = await ExtHarness.create();
    await h.server.send("network_mock_start", {}, 1);
    await h.server.send("network_mock_route", { pattern: "*://api.example/*", action: "block" }, 1);
    const worker = h.restartWorker();
    await h.waitPaired();
    await waitFor(() => worker.state.fetchSessions.has(1), "the mock session to be re-armed");
    expect(h.chrome.cdpCalls("Fetch.enable", 1)).toHaveLength(1);
    expect(worker.state.fetchSessions.get(1).routes).toEqual([expect.objectContaining({ pattern: "*://api.example/*", action: "block" })]);
  }, T);
});

describe("permissions_grant", () => {
  test("only one exact http(s) origin and allow|block|ask are accepted", async () => {
    h = await ExtHarness.create();
    const bad = [
      "https://*",
      "*://*/*",
      "https://*.example.com",
      "https://example.com/",
      "https://example.com/path",
      "https://example.com:443",
      "HTTPS://EXAMPLE.COM",
      "chrome://settings",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://example.com https://other.example",
    ];
    for (const origin of bad) {
      expect((await rejectionOf(h.server.send("permissions_grant", { permission: "geolocation", origin }, 1))).message).toMatch(/^Invalid origin/);
    }
    for (const setting of ["allow-all", "ALLOW", "", 1]) {
      const err = await rejectionOf(h.server.send("permissions_grant", { permission: "camera", origin: "https://example.com", setting }, 1));
      expect(err.message).toMatch(/^Invalid setting/);
    }
    expect(h.chrome.contentSettings).toHaveLength(0);

    expect(await h.server.send("permissions_grant", { permission: "geolocation", origin: "https://example.com", setting: "block" }, 1)).toEqual({
      ok: true,
      permission: "geolocation",
      origin: "https://example.com",
      setting: "block",
    });
    // No origin: the tab's own origin.
    await h.server.send("permissions_grant", { permission: "camera" }, 1);
    expect(h.chrome.contentSettings).toEqual([
      { type: "location", primaryPattern: "https://example.com/*", setting: "block" },
      { type: "camera", primaryPattern: "https://example.com/*", setting: "allow" },
    ]);

    // The MCP tool passes the extension's refusal on.
    const m = await h.mcp({ toolsets: ["system"] });
    const r = await m.call("permissions_grant", { permission: "camera", origin: "https://*" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invalid origin");
  }, T);
});

describe("active-tab fallback", () => {
  const dialogHooks = (x: ExtHarness, tabId: number) => x.chrome.scripts.filter((s) => s.func === "mcpDialogHookMain" && s.tabId === tabId);
  const pageHooks = (x: ExtHarness, tabId: number) => x.chrome.scripts.filter((s) => s.func === "mcpPageHookMain" && s.tabId === tabId);

  test("a command without tabId never gives the user's tab the dialog hook; an explicit tabId does", async () => {
    h = await ExtHarness.create({ html: "<p>user page</p>" });
    await h.server.send("page_text", {});
    await waitFor(() => h!.bg.state.fallbackTabs.has(1), "tab 1 to become a fallback tab");
    await waitFor(() => pageHooks(h!, 1).length > 0, "the console hook");
    await h.server.send("dialog_policy", { accept: true });
    await sleep(50);
    expect(h.bg.state.agentTabs.has(1)).toBe(false);
    expect(dialogHooks(h, 1)).toHaveLength(0);

    // A cross-origin navigation the agent did not cause ends the fallback status.
    h.chrome.navigate(1, "https://bank.example/");
    await waitFor(() => !h!.bg.state.fallbackTabs.has(1), "the fallback status to end");
    const hooksBefore = pageHooks(h, 1).length;
    await sleep(50);
    expect(pageHooks(h, 1)).toHaveLength(hooksBefore);
    expect(dialogHooks(h, 1)).toHaveLength(0);

    // Targeting the tab explicitly makes it an agent tab with the dialog hook.
    await h.server.send("page_text", {}, 1);
    expect(h.bg.state.agentTabs.has(1)).toBe(true);
    await waitFor(() => dialogHooks(h!, 1).length > 0, "the dialog hook on an explicit target");
  }, T);

  test("tab_audio_capture without tabId stops its own recording by payload; the user's tab stays a fallback tab", async () => {
    h = await ExtHarness.create({ html: "<p>user page</p>" });
    const stops: number[] = [];
    h.chrome.runtimeHandler = (msg) => {
      switch (msg?.type) {
        case "mcp-offscreen-audio-start":
          return { ok: true, startedAt: 1, mimeType: "audio/webm" };
        case "mcp-offscreen-audio-list":
          // Another recording runs as well: only an explicit target picks this one.
          return { ok: true, tabIds: [1, 7] };
        case "mcp-offscreen-audio-stop":
          stops.push(msg.tabId);
          return { ok: true, base64: "AAAA", mimeType: "audio/webm", durationMs: 50, sizeBytes: 3 };
        case "mcp-offscreen-audio-release":
          return { ok: true };
        default:
          return undefined;
      }
    };
    const m = await h.mcp({ toolsets: ["media"] });
    const r = await m.call("tab_audio_capture", { durationSeconds: 0.05 });
    expect(r.isError).toBe(false);
    expect(stops).toEqual([1]);
    // The server named the recording in the payload, never as the command's tab.
    const stop = h.inbound((f) => f.action === "tab_audio_record_stop").at(-1);
    expect(stop.tabId).toBeUndefined();
    expect(stop.payload).toEqual({ recordingTabId: 1 });
    expect(h.bg.state.agentTabs.has(1)).toBe(false);
    expect(h.bg.state.fallbackTabs.has(1)).toBe(true);
    await sleep(50);
    expect(dialogHooks(h, 1)).toHaveLength(0);

    // Directly over the bridge: the payload picks the recording, a target tab still wins.
    expect(await h.server.send("tab_audio_record_stop", { recordingTabId: 7 })).toMatchObject({ ok: true, tabId: 7 });
    expect(h.bg.state.agentTabs.has(7)).toBe(false);
    expect((await rejectionOf(h.server.send("tab_audio_record_stop", {}))).message).toMatch(/Several tab audio recordings are active/);
    expect(await h.server.send("tab_audio_record_stop", { recordingTabId: 7 }, 1)).toMatchObject({ ok: true, tabId: 1 });
    expect(stops).toEqual([1, 7, 1]);
  }, T);

  test("a same-origin navigation keeps the fallback status; the bridge down for 15 s ends it", async () => {
    h = await ExtHarness.create({ html: "<p>user page</p>" });
    await h.server.send("page_text", {});
    await waitFor(() => h!.bg.state.fallbackTabs.has(1), "tab 1 to become a fallback tab");
    h.chrome.navigate(1, "https://example.com/next");
    await sleep(50);
    expect(h.bg.state.fallbackTabs.has(1)).toBe(true);

    h.server.close();
    await waitFor(() => !h!.bg.state.paired, "the extension to notice the closed server");
    await h.bg.clock.advance(16_000);
    await waitFor(() => h!.bg.state.fallbackTabs.size === 0, "the fallback tabs to be dropped");
    await waitFor(() => h!.chrome.scripts.some((s) => s.func === "mcpHooksOffMain" && s.tabId === 1), "the page hooks to be switched off");
  }, T);
});
