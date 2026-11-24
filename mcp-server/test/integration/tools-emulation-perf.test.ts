// Emulation, performance and network-idle tools end to end against the real
// background.js; CDP (chrome.debugger) and MAIN-world scripting are mocked.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { toolError } from "../helpers/ext-assert.js";
import { ExtHarness, sleep, waitFor } from "../helpers/ext-harness.js";

const T = 20_000;

let h: ExtHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe("emulation_*", () => {
  test("viewport preset, media, cpu and reset drive the matching CDP calls", async () => {
    h = await ExtHarness.create();
    const m = await h.mcp({ toolsets: ["emulation"] });

    const vp = (await m.call("emulation_viewport", { device: "iphone-15" })).json();
    expect(vp).toMatchObject({ tabId: 1, device: "iphone-15", applied: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true } });
    expect(h.chrome.cdpCalls("Emulation.setDeviceMetricsOverride", 1).at(-1)?.params).toMatchObject({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    expect(h.chrome.cdpCalls("Emulation.setTouchEmulationEnabled", 1).at(-1)?.params).toEqual({ enabled: true, maxTouchPoints: 5 });

    // Outside the extension's range: refused (by the schema or the extension), nothing applied.
    expect(await toolError(m, "emulation_viewport", { width: 20_000, height: 800 })).toMatch(/16384|width|Invalid|too_big/i);
    expect(h.chrome.cdpCalls("Emulation.setDeviceMetricsOverride").some((c) => c.params.width === 20_000)).toBe(false);

    expect((await m.call("emulation_media", { colorScheme: "dark", reducedMotion: "reduce" })).isError).toBe(false);
    const media = h.chrome.cdpCalls("Emulation.setEmulatedMedia", 1).at(-1)?.params as { features: Array<{ name: string; value: string }> };
    expect(media.features).toEqual(
      expect.arrayContaining([
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ])
    );
    expect((await m.call("emulation_cpu", { rate: 4 })).json()).toMatchObject({ tabId: 1, rate: 4 });
    expect(h.chrome.cdpCalls("Emulation.setCPUThrottlingRate", 1).at(-1)?.params).toEqual({ rate: 4 });
    // One persistent "emulation" attach for all of it.
    expect(h.chrome.debuggerOps.filter((o) => o.op === "attach")).toHaveLength(1);

    const reset = (await m.call("emulation_reset", {})).json();
    expect(reset.cleared.slice().sort()).toEqual(["cpu", "media", "viewport"]);
    expect(h.chrome.cdpCalls("Emulation.clearDeviceMetricsOverride", 1)).toHaveLength(1);
    expect(h.chrome.cdpCalls("Emulation.setEmulatedMedia", 1).at(-1)?.params).toEqual({ media: "", features: [] });
    expect(h.chrome.cdpCalls("Emulation.setCPUThrottlingRate", 1).at(-1)?.params).toEqual({ rate: 1 });
    await waitFor(() => h!.chrome.debuggerOps.some((o) => o.op === "detach" && o.tabId === 1), "the emulation holder to detach");
    expect(h.bg.state.viewportSessions.size + h.bg.state.mediaSessions.size + h.bg.state.cpuSessions.size).toBe(0);
  }, T);
});

describe("perf_web_vitals", () => {
  // What bg2cWebVitalsMain would report from the page (raw, unrounded).
  const vitals = {
    url: "https://example.com/",
    lcp: 1234.567,
    fcp: 800.12,
    cls: 0.012345,
    inp: null,
    ttfb: 100.04,
    longTasks: { count: 2, totalMs: 150 },
    navigation: { domContentLoaded: 900, load: 1500 },
    interactions: 0,
    supported: {},
  };

  test("measures in the MAIN world with buffered observers and normalises the numbers", async () => {
    h = await ExtHarness.create();
    h.chrome.scriptHandler = (d) => (d.func?.name === "bg2cWebVitalsMain" ? [{ frameId: 0, result: vitals }] : undefined);
    const m = await h.mcp({ toolsets: ["performance"] });

    const r = (await m.call("perf_web_vitals", { waitMs: 250 })).json();
    expect(r).toMatchObject({
      tabId: 1,
      url: "https://example.com/",
      lcp: 1234.6,
      fcp: 800.1,
      cls: 0.0123,
      inp: null,
      ttfb: 100,
      longTasks: { count: 2, totalMs: 150 },
      navigation: { domContentLoaded: 900, load: 1500 },
      observedMs: 250,
      reloaded: false,
    });
    expect(r.note).toContain("inp:");
    const call = h.chrome.scripts.find((s) => s.func === "bg2cWebVitalsMain")!;
    expect(call).toMatchObject({ tabId: 1, world: "MAIN", frameIds: [0], args: [250] });
    expect(h.inbound((f) => f.action === "perf_web_vitals").at(-1).timeoutMs).toBe(30_250);

    const reloaded = (await m.call("perf_web_vitals", { reload: true })).json();
    expect(reloaded.reloaded).toBe(true);
    expect(reloaded.note ?? "").not.toContain("had not finished loading");
  }, T);

  test("waits for a pending navigation to commit; a commit during the measurement fails fast", async () => {
    h = await ExtHarness.create();
    let injectedAt = 0;
    let hang = false;
    h.chrome.scriptHandler = (d) => {
      if (d.func?.name !== "bg2cWebVitalsMain") return undefined;
      injectedAt = Date.now();
      // A script left in a document that unloads never answers.
      return hang ? new Promise(() => {}) : [{ frameId: 0, result: vitals }];
    };
    const m = await h.mcp({ toolsets: ["performance"] });

    // tab_navigate returned while the navigation is still uncommitted.
    const tab = h.chrome.tabs.get(1) as unknown as Record<string, unknown>;
    tab.pendingUrl = "https://example.com/next";
    const started = Date.now();
    setTimeout(() => delete tab.pendingUrl, 300);
    expect((await m.call("perf_web_vitals", {})).json().tabId).toBe(1);
    expect(injectedAt - started).toBeGreaterThanOrEqual(250);

    hang = true;
    setTimeout(() => h?.chrome.events.navCommitted.emit({ tabId: 1, frameId: 0, url: "https://example.com/other", transitionType: "link" }), 200);
    const t0 = Date.now();
    expect(await toolError(m, "perf_web_vitals", { waitMs: 100 })).toContain("navigated during the measurement");
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, T);
});

describe("perf_trace_*", () => {
  /** Answers Tracing.end like Chrome: dataCollected batches, then tracingComplete. */
  function emitTrace(x: ExtHarness, events: unknown[], complete: Record<string, unknown> = { dataLossOccurred: false }) {
    x.chrome.cdpHandler = (c) => {
      if (c.method !== "Tracing.end") return undefined;
      setTimeout(() => {
        const half = Math.ceil(events.length / 2);
        x.chrome.events.debuggerEvent.emit({ tabId: c.tabId }, "Tracing.dataCollected", { value: events.slice(0, half) });
        x.chrome.events.debuggerEvent.emit({ tabId: c.tabId }, "Tracing.dataCollected", { value: events.slice(half) });
        x.chrome.events.debuggerEvent.emit({ tabId: c.tabId }, "Tracing.tracingComplete", complete);
      }, 10);
      return {};
    };
  }

  test("a multi-chunk trace is read chunk by chunk and written to savePath", async () => {
    h = await ExtHarness.create();
    const events: unknown[] = [{ name: "thread_name", ph: "M", pid: 10, tid: 20, args: { name: "CrRendererMain" } }];
    let ts = 1_000_000;
    // ~6 MB of JSON: more than one 4 MiB chunk.
    for (let i = 0; i < 26_000; i++) {
      const dur = i % 500 === 0 ? 80_000 : 500;
      events.push({ name: "RunTask", ph: "X", pid: 10, tid: 20, ts, dur, cat: "devtools.timeline", args: { data: { frame: "FRAME1", pad: "p".repeat(100) } } });
      ts += 1000;
    }
    emitTrace(h, events);
    const m = await h.mcp({ toolsets: ["performance"] });

    expect((await m.call("perf_trace_start", { categories: ["devtools.timeline", "-v8"] })).json()).toMatchObject({ tabId: 1, started: true });
    const cfg = h.chrome.cdpCalls("Tracing.start", 1).at(-1)?.params.traceConfig as Record<string, string[]>;
    expect(cfg.includedCategories).toEqual(["devtools.timeline"]);
    expect(cfg.excludedCategories).toEqual(expect.arrayContaining(["v8", "*"]));

    const savePath = h.tempPath("trace.json");
    const r = (await m.call("perf_trace_stop", { savePath })).json();
    expect(r).toMatchObject({ ok: true, tabId: 1, chunks: 2 });
    expect(r.summary.eventCount).toBe(events.length);
    expect(r.summary.longTasks.length).toBeGreaterThan(0);
    expect(r.warning).toBeUndefined();
    expect(h.inbound((f) => f.action === "perf_trace_chunk").map((f) => f.payload.index)).toEqual([0, 1]);
    const written = JSON.parse(fs.readFileSync(r.path, "utf8"));
    expect(written.traceEvents).toHaveLength(events.length);
    expect(fs.statSync(r.path).size).toBe(r.size);
    // Everything read: the extension dropped the trace and released the "perf" attach.
    expect(h.bg.state.traceStore.size).toBe(0);
    expect(h.bg.state.traceSessions.size).toBe(0);
    await waitFor(() => h!.chrome.debuggerOps.some((o) => o.op === "detach"), "the perf holder to detach");
  }, T);

  test("an incomplete trace is flagged; extension refusals reach the caller", async () => {
    h = await ExtHarness.create();
    emitTrace(h, [{ name: "RunTask", ph: "X", pid: 1, tid: 1, ts: 1, dur: 60_000 }], { dataLossOccurred: true });
    const m = await h.mcp({ toolsets: ["performance"] });
    expect(await toolError(m, "perf_trace_stop", {})).toMatch(/No trace is running/);
    await m.call("perf_trace_start", {});
    expect(await toolError(m, "perf_trace_start", {})).toMatch(/already running/);
    const r = (await m.call("perf_trace_stop", { savePath: h.tempPath("lossy.json") })).json();
    expect(r.dataLossOccurred).toBe(true);
    expect(await toolError(m, "perf_trace_start", { categories: ["foo bar"] })).toMatch(/categor|Invalid/i);
  }, T);

  test("screenshots in a trace need the page_screenshot switch too", async () => {
    h = await ExtHarness.create();
    emitTrace(h, [{ name: "RunTask", ph: "X", pid: 1, tid: 1, ts: 1, dur: 10 }]);
    const m = await h.mcp({ toolsets: ["performance"] });
    await h.popup({ type: "mcp-perms-set", action: "page_screenshot", enabled: false });
    // Filmstrip frames are page images: refused, also through wildcard categories Chrome glob-matches.
    for (const args of [
      { screenshots: true },
      { categories: ["devtools.timeline", "disabled-by-default-devtools.screenshot"] },
      { categories: ["disabled-by-default-*"] },
      { categories: ["disabled-by-default-devtools.*", "-disabled-by-default-devtools.screenshot"] },
      // Paint data (SkPicture / display items / layers) can be replayed into page content.
      { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline.picture"] },
      { categories: ["disabled-by-default-cc.debug.display_items"] },
      { categories: ["disabled-by-default-devtools.timeline.layers"] },
      { categories: ["disabled-by-default-skia*"] },
    ]) {
      expect(await toolError(m, "perf_trace_start", args)).toContain(
        "Permission disabled in extension: page_screenshot (required by perf_trace_start screenshots"
      );
    }
    expect(h.chrome.cdpCalls("Tracing.start")).toHaveLength(0);
    expect(h.bg.state.traceSessions.size).toBe(0);

    // Without screenshots (a bare "*" never enables disabled-by-default categories) the trace runs.
    expect((await m.call("perf_trace_start", { categories: ["*", "disabled-by-default-devtools.timeline"] })).json()).toMatchObject({ started: true });
    expect((await m.call("perf_trace_stop", { savePath: h.tempPath("a.json") })).json()).toMatchObject({ ok: true });

    // Media back on: the screenshot category is traced.
    await h.popup({ type: "mcp-perms-set", action: "page_screenshot", enabled: true });
    expect((await m.call("perf_trace_start", { screenshots: true })).json()).toMatchObject({ started: true });
    const cfg = h.chrome.cdpCalls("Tracing.start").at(-1)?.params.traceConfig as Record<string, string[]>;
    expect(cfg.includedCategories).toContain("disabled-by-default-devtools.screenshot");
    expect((await m.call("perf_trace_stop", { savePath: h.tempPath("b.json") })).json()).toMatchObject({ ok: true });
  }, T);
});

describe("page_wait networkIdle", () => {
  test("resolves once the tab has had no request in flight for idleMs", async () => {
    h = await ExtHarness.create();
    const m = await h.mcp();
    h.chrome.events.beforeRequest.emit({ tabId: 1, requestId: "r1", type: "xmlhttprequest", url: "https://example.com/api" });
    const t0 = Date.now();
    const pending = m.call("page_wait", { networkIdle: true, idleMs: 100, timeoutMs: 5_000 });
    await sleep(300);
    h.chrome.events.requestCompleted.emit({ tabId: 1, requestId: "r1" });
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ ok: true, inflight: 0 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);
    expect(h.inbound((f) => f.action === "page_wait").at(-1).payload).toMatchObject({ networkIdle: true, idleMs: 100 });
  }, T);

  test("times out while a request stays in flight; idleMs >= timeoutMs is refused before sending", async () => {
    h = await ExtHarness.create();
    const m = await h.mcp();
    h.chrome.events.beforeRequest.emit({ tabId: 1, requestId: "slow", type: "fetch", url: "https://example.com/slow" });
    expect(await toolError(m, "page_wait", { networkIdle: true, idleMs: 100, timeoutMs: 400 })).toMatch(/never stayed idle/);
    const sent = h.inbound((f) => f.action === "page_wait").length;
    expect(await toolError(m, "page_wait", { idleMs: 3000, timeoutMs: 3000 })).toMatch(/idleMs/);
    expect(h.inbound((f) => f.action === "page_wait")).toHaveLength(sent);
  }, T);
});
