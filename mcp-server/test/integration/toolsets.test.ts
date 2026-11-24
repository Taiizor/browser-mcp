// Toolsets, permission-aware tool hiding (popup switches pushed by the real
// background.js) and the output cap, seen through an MCP client.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { getToolRegistry } from "../../src/server.js";
import { CORE_TOOLS } from "../../src/toolsets.js";
import { toolError } from "../helpers/ext-assert.js";
import { ExtHarness, sleep, waitFor } from "../helpers/ext-harness.js";
import type { McpHandle } from "../helpers/ext-mcp.js";

const T = 20_000;

let h: ExtHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** list_changed notifications are debounced: wait until the count settles. */
async function settledListChanged(m: McpHandle): Promise<number> {
  let last = -1;
  for (;;) {
    await sleep(60);
    const n = m.listChanged();
    if (n === last) return n;
    last = n;
  }
}

describe("browser_toolsets", () => {
  test("core + meta by default; enabling categories sends one list_changed", async () => {
    h = await ExtHarness.create();
    const m = await h.mcp();
    const registry = getToolRegistry(m.server)!;
    const expected = [...registry.values()].filter((t) => CORE_TOOLS.has(t.name) || t.category === "meta").map((t) => t.name);
    expect((await m.listNames()).sort()).toEqual(expected.sort());
    for (const name of CORE_TOOLS) expect(registry.has(name)).toBe(true);

    const before = await settledListChanged(m);
    const r = (await m.call("browser_toolsets", { enable: ["emulation", "performance"] })).json();
    expect(r.shown).toEqual(expect.arrayContaining(["emulation_viewport", "emulation_reset", "perf_trace_start", "perf_web_vitals"]));
    expect((await settledListChanged(m)) - before).toBe(1);
    const listed = await m.listNames();
    for (const t of registry.values()) if (t.category === "emulation" || t.category === "performance") expect(listed).toContain(t.name);

    // A no-op change notifies nobody.
    const mid = await settledListChanged(m);
    expect((await m.call("browser_toolsets", { enable: ["emulation"] })).json().shown).toEqual([]);
    expect((await settledListChanged(m)) - mid).toBe(0);

    // Disabling a category hides its tools, core ones included.
    const off = (await m.call("browser_toolsets", { disable: ["interact"] })).json();
    expect(off.hidden).toEqual(expect.arrayContaining(["dom_click", "dom_type"]));
    expect(await m.listNames()).not.toContain("dom_click");
    expect(await toolError(m, "dom_click", { selector: "#x" })).toMatch(/disabled/i);

    const summary = (await m.call("browser_toolsets", {})).json();
    expect(summary.listedTools).toBe((await m.listNames()).length);
    expect(summary.totalTools).toBe(registry.size);
  }, T);
});

describe("tools switched off in the popup", () => {
  test("disappear from tools/list and come back when re-enabled", async () => {
    h = await ExtHarness.create();
    const m = await h.mcp({ toolsets: ["all"] });
    const before = await settledListChanged(m);

    await h.popup({ type: "mcp-perms-set", action: "dom_click", enabled: false });
    await waitFor(async () => !(await m.listNames()).includes("dom_click"), "dom_click to be hidden");
    expect((await settledListChanged(m)) - before).toBe(1);
    expect(await toolError(m, "dom_click", { selector: "#x" })).toMatch(/disabled/i);

    await h.popup({ type: "mcp-perms-set", action: "dom_click", enabled: true });
    await waitFor(async () => (await m.listNames()).includes("dom_click"), "dom_click to come back");
  }, T);

  test("a composite tool hides with any action or required switch it depends on", async () => {
    h = await ExtHarness.create();
    const m = await h.mcp({ toolsets: ["all"] });
    await h.popup({ type: "mcp-perms-set", actions: { perf_trace_chunk: false, network_requests: false } });
    await waitFor(() => h!.server.knownDisabled()?.includes("network_requests"), "the perms event");
    await waitFor(async () => !(await m.listNames()).includes("perf_trace_stop"), "perf_trace_stop to be hidden");
    const listed = await m.listNames();
    expect(listed).toContain("perf_trace_start");
    for (const name of ["network_requests", "har_export", "network_bodies", "network_response_body"]) expect(listed).not.toContain(name);
    expect(listed).toContain("network_throttle");
  }, T);
});

describe("output cap", () => {
  test("a text result above maxOutputChars is cut and saved in full", async () => {
    h = await ExtHarness.create();
    h.chrome.historyItems = Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      title: `Example page number ${i} with a long title`,
      url: `https://example.com/some/long/path/${i}`,
      lastVisitTime: 1_700_000_000_000 + i,
      visitCount: 1,
    }));
    const m = await h.mcp({ toolsets: ["system"], maxOutputChars: 2_000 });
    const r = await m.call("history_search", { query: "", limit: 300 });
    expect(r.isError).toBe(false);
    // history_search has no paging: the note says how to get less instead.
    expect(r.text).toMatch(/\[output truncated: \d+\/\d+ chars; full output saved to .+; narrow the request [^\]]*\]$/);
    expect(r.text.length).toBeLessThan(2_000 + 400);
    expect(m.saved).toHaveLength(1);
    expect(m.saved[0]).toEndWith("history_search-output.json");
    const full = fs.readFileSync(m.saved[0], "utf8");
    expect(full.length).toBeGreaterThan(2_000);
    expect(full).toContain("Example page number 299");
  }, T);
});
