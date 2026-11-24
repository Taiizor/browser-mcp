// Toolsets and permission-aware hiding: the pure rules in src/toolsets.ts and
// the runtime behaviour through browser_toolsets and the bridge's popup
// snapshot (tools/list plus notifications/tools/list_changed).
import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveToolsets } from "../../src/server.js";
import { ToolKit } from "../../src/tool-kit.js";
import {
  CORE_TOOLS,
  changeSelection,
  DEFAULT_TOOLSETS,
  hiddenToolMessage,
  isToolVisible,
  normalizeToolsetId,
  parseToolsets,
  selectionOf,
  summarizeToolsets,
  TOOL_CATEGORIES,
  TOOLSET_IDS,
  type ToolsetMember,
} from "../../src/toolsets.js";
import { FakeBridge } from "../helpers/unit-fake-bridge.js";
import { firstJson, flush, startUnitServer, texts, type UnitServer } from "../helpers/unit-mcp.js";

const META_TOOLS = ["browser_launch", "browser_status", "browser_toolsets", "permissions_list", "permissions_set"];

let unit: UnitServer | undefined;
afterEach(async () => {
  await unit?.close();
  unit = undefined;
});

/** Toolset change through the tool, then let the debounced notification land. */
async function toolsets(u: UnitServer, args: { enable?: string[]; disable?: string[] }) {
  const before = u.listChanged;
  const res = await u.call("browser_toolsets", args);
  await flush();
  return { res, body: res.isError ? null : firstJson(res), notifications: u.listChanged - before };
}

describe("pure toolset rules", () => {
  test("parseToolsets normalises case and '-', dedupes, and reports unknown ids as written", () => {
    expect(parseToolsets("core, Network,browsing-data,,bogus,core")).toEqual({ ids: ["core", "network", "browsing_data"], unknown: ["bogus"] });
    expect(parseToolsets(["core", "cookies,storage", "Bogus,bogus"])).toEqual({ ids: ["core", "cookies", "storage"], unknown: ["Bogus", "bogus"] });
    expect(normalizeToolsetId("  Browsing-Data ")).toBe("browsing_data");
  });

  test("every category is a toolset id, next to core and all", () => {
    expect([...TOOLSET_IDS]).toEqual(["core", "all", ...TOOL_CATEGORIES]);
    expect([...DEFAULT_TOOLSETS]).toEqual(["core"]);
  });

  test("resolveToolsets: explicit list > BROWSER_MCP_TOOLSETS > core; unknown ids are logged", () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    expect(resolveToolsets(undefined, {}, log)).toEqual(["core"]);
    expect(resolveToolsets(undefined, { BROWSER_MCP_TOOLSETS: "  " }, log)).toEqual(["core"]);
    expect(logs).toEqual([]);
    expect(resolveToolsets(undefined, { BROWSER_MCP_TOOLSETS: "network,cookies" }, log)).toEqual(["network", "cookies"]);
    expect(resolveToolsets(["tabs", "read"], { BROWSER_MCP_TOOLSETS: "network" }, log)).toEqual(["tabs", "read"]);
    expect(logs).toEqual([]);

    expect(resolveToolsets(["core,bogus"], {}, log)).toEqual(["core"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith("ignoring unknown toolset(s) from --toolsets: bogus (known: core, all, meta,");

    logs.length = 0;
    expect(resolveToolsets(undefined, { BROWSER_MCP_TOOLSETS: "nope" }, log)).toEqual(["core"]);
    expect(logs).toEqual([
      expect.stringContaining("ignoring unknown toolset(s) from BROWSER_MCP_TOOLSETS: nope"),
      "no valid toolset in BROWSER_MCP_TOOLSETS; using core",
    ]);
  });

  test("changeSelection: enable runs first, 'all' lifts exclusions, disabling a category beats core/all, meta is ignored", () => {
    const sel = changeSelection(selectionOf(["core"]), { enable: ["all"], disable: ["power"] });
    expect([...sel.include].sort()).toEqual(["all", "core"]);
    expect([...sel.exclude]).toEqual(["power"]);
    const again = changeSelection(sel, { enable: ["power"] });
    expect([...again.exclude]).toEqual([]);
    expect([...again.include]).toContain("power");
    const noCore = changeSelection(selectionOf(["core", "network"]), { disable: ["core", "meta"] });
    expect([...noCore.include]).toEqual(["network"]);
    expect([...noCore.exclude]).toEqual([]);
    const cleared = changeSelection(changeSelection(selectionOf(["core"]), { disable: ["interact", "read"] }), { enable: ["all"] });
    expect([...cleared.exclude]).toEqual([]);
  });

  test("isToolVisible: meta always, exclusions win, actions and required actions hide", () => {
    const tool = (name: string, category: ToolsetMember["category"], actions: string[] = [], requires: string[] = []): ToolsetMember => ({
      name,
      category,
      actions,
      requires,
    });
    const core = selectionOf(["core"]);
    expect(isToolVisible(tool("browser_status", "meta"), changeSelection(core, { disable: ["core"] }), null)).toBe(true);
    expect(isToolVisible(tool("dom_click", "interact", ["dom_click"]), core, null)).toBe(true);
    expect(isToolVisible(tool("dom_click", "interact", ["dom_click"]), changeSelection(core, { disable: ["interact"] }), null)).toBe(false);
    expect(isToolVisible(tool("dom_drag", "interact", ["dom_drag"]), core, null)).toBe(false);
    const har = tool("har_export", "network", ["har_export"], ["network_requests"]);
    const network = selectionOf(["network"]);
    expect(isToolVisible(har, network, null)).toBe(true);
    expect(isToolVisible(har, network, new Set())).toBe(true);
    expect(isToolVisible(har, network, new Set(["network_requests"]))).toBe(false);
    expect(isToolVisible(har, network, new Set(["har_export"]))).toBe(false);
    const summary = summarizeToolsets([har], network, new Set(["network_requests"]));
    expect(summary.hiddenByPermissions).toEqual([{ tool: "har_export", actions: ["network_requests"] }]);
    expect(summary.permissionsKnown).toBe(true);
    expect(summarizeToolsets([har], network, null).permissionsKnown).toBe(false);
  });

  test("CORE_TOOLS holds the curated set (28 names)", () => {
    expect(CORE_TOOLS.size).toBe(28);
    for (const n of ["browser_status", "browser_toolsets", "page_snapshot", "dom_upload", "page_screenshot", "console_get", "dialog_policy"]) {
      expect(CORE_TOOLS.has(n)).toBe(true);
    }
  });
});

describe("browser_toolsets at runtime", () => {
  test("without arguments it lists every toolset and changes nothing", async () => {
    unit = await startUnitServer();
    const { body, notifications } = await toolsets(unit, {});
    expect(notifications).toBe(0);
    expect(body.toolsets.map((t: { id: string }) => t.id)).toEqual([...TOOLSET_IDS]);
    expect(body.listedTools).toBe(31);
    expect(body.totalTools).toBe(unit.registry.size);
    expect(body.selection).toEqual({ enabled: ["core"], excluded: [] });
    expect(body.permissionsKnown).toBe(false);
    const core = body.toolsets.find((t: { id: string }) => t.id === "core");
    expect(core).toMatchObject({ enabled: true, tools: 28, listed: 28 });
    const all = body.toolsets.find((t: { id: string }) => t.id === "all");
    expect(all.names).toBeUndefined();
    expect(all.enabled).toBe(false);
    expect(body.toolsets.find((t: { id: string }) => t.id === "meta").enabled).toBe(true);
  });

  test("enable shows a category with one list_changed; a repeat changes nothing", async () => {
    unit = await startUnitServer();
    const first = await toolsets(unit, { enable: ["network"] });
    expect(first.notifications).toBe(1);
    const networkTools = [...unit.registry.values()].filter((e) => e.category === "network").map((e) => e.name);
    expect(first.body.shown.sort()).toEqual(networkTools.sort());
    expect(first.body.hidden).toEqual([]);
    const names = await unit.listNames();
    for (const n of networkTools) expect(names).toContain(n);

    const repeat = await toolsets(unit, { enable: ["network"] });
    expect(repeat.notifications).toBe(0);
    expect(repeat.body).toMatchObject({ shown: [], hidden: [], note: "No tool was added or removed." });
  });

  test("disabling a category hides its core tools too, and enabling brings them back", async () => {
    unit = await startUnitServer();
    const off = await toolsets(unit, { disable: ["interact"] });
    expect(off.notifications).toBe(1);
    expect(off.body.hidden).toContain("dom_click");
    const names = await unit.listNames();
    expect(names).not.toContain("dom_click");
    expect(names).toContain("page_text");
    const call = await unit.call("dom_click", { selector: "a" });
    expect(call.isError).toBe(true);
    expect(texts(call)).toEqual([
      'Tool dom_click is not enabled: its toolset "interact" was disabled with browser_toolsets. Call browser_toolsets {"enable":["interact"]} to list it again, then call dom_click again.',
    ]);
    expect(unit.bridge.callsOf("dom_click")).toEqual([]);

    const on = await toolsets(unit, { enable: ["interact"] });
    expect(on.notifications).toBe(1);
    expect(on.body.shown).toContain("dom_click");
    expect(on.body.shown).toContain("dom_drag");
    expect(await unit.listNames()).toContain("dom_drag");
  });

  test("enable all + disable power in one call: one notification, power hidden", async () => {
    unit = await startUnitServer();
    const r = await toolsets(unit, { enable: ["all"], disable: ["power"] });
    expect(r.notifications).toBe(1);
    const names = await unit.listNames();
    const power = [...unit.registry.values()].filter((e) => e.category === "power").map((e) => e.name);
    expect(power.length).toBeGreaterThan(0);
    expect(names.length).toBe(unit.registry.size - power.length);
    for (const n of power) expect(names).not.toContain(n);
  });

  test("meta tools stay listed whatever is disabled", async () => {
    unit = await startUnitServer();
    const r = await toolsets(unit, { disable: ["core", "all", "meta"] });
    expect(r.notifications).toBe(1);
    expect(await unit.listNames()).toEqual(META_TOOLS);
    expect(r.body.selection).toEqual({ enabled: [], excluded: [] });
  });

  test("unknown ids are refused by the schema and change nothing", async () => {
    unit = await startUnitServer();
    const before = await unit.listNames();
    const r = await toolsets(unit, { enable: ["bogus"] });
    expect(r.res.isError).toBe(true);
    expect(texts(r.res)[0]).toContain("Input validation error");
    expect(r.notifications).toBe(0);
    expect(await unit.listNames()).toEqual(before);
  });

  test("ids are case-insensitive and '-' counts as '_', like --toolsets; the schema still lists the exact ids", async () => {
    unit = await startUnitServer();
    const on = await toolsets(unit, { enable: ["Network", "Browsing-Data", " EMULATION "] });
    expect(on.res.isError).toBeFalsy();
    expect(on.body.selection.enabled).toEqual(["core", "network", "browsing_data", "emulation"]);
    const names = await unit.listNames();
    for (const n of ["har_export", "browsing_data_clear", "emulation_viewport"]) expect(names).toContain(n);
    const off = await toolsets(unit, { disable: ["NETWORK"] });
    expect(off.body.selection.excluded).toEqual(["network"]);
    const { tools } = await unit.client.listTools();
    const schema = tools.find((t) => t.name === "browser_toolsets")!.inputSchema as any;
    expect(schema.properties.enable.items.enum).toEqual([...TOOLSET_IDS]);
    expect(schema.properties.disable.items.enum).toEqual([...TOOLSET_IDS]);
  });

  test("tools registered later fall under the current selection", async () => {
    unit = await startUnitServer();
    await toolsets(unit, { disable: ["emulation"] });
    unit.kit.define({
      name: "zz_late_tool",
      title: "Late tool",
      description: "registered after start-up",
      category: "emulation",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: async () => ({ content: [{ type: "text", text: "late" }] }),
    });
    await flush();
    expect(await unit.listNames()).not.toContain("zz_late_tool");
    await toolsets(unit, { enable: ["emulation"] });
    expect(await unit.listNames()).toContain("zz_late_tool");
  });
});

describe("permission-aware hiding (popup switches)", () => {
  test("a switch that is off at start hides its tool; the listing says why", async () => {
    unit = await startUnitServer({ bridge: new FakeBridge({ disabled: ["dom_click"] }) });
    const names = await unit.listNames();
    expect(names).not.toContain("dom_click");
    expect(names).toContain("dom_type");
    const { body } = await toolsets(unit, {});
    expect(body.permissionsKnown).toBe(true);
    expect(body.hiddenByPermissions).toEqual([{ tool: "dom_click", actions: ["dom_click"] }]);
  });

  test("composite tools hide when a required switch is off (REQUIRES), and come back when it is on", async () => {
    unit = await startUnitServer({ server: { toolsets: ["all"] } });
    const all = await unit.listNames();
    unit.bridge.setDisabled(["network_requests"]);
    await flush();
    expect(unit.listChanged).toBe(1);
    const afterNetwork = await unit.listNames();
    expect(all.filter((n) => !afterNetwork.includes(n)).sort()).toEqual(["har_export", "network_bodies", "network_requests", "network_response_body"]);

    unit.bridge.setDisabled(["storage_get"]);
    await flush();
    const afterStorage = await unit.listNames();
    expect(all.filter((n) => !afterStorage.includes(n)).sort()).toEqual(["session_state_save", "storage_get"]);

    unit.bridge.setDisabled(["cookies_set"]);
    await flush();
    const afterCookies = await unit.listNames();
    expect(all.filter((n) => !afterCookies.includes(n)).sort()).toEqual(["cookies_import", "cookies_set", "session_state_load"]);

    const { body } = await toolsets(unit, {});
    expect(body.hiddenByPermissions).toContainEqual({ tool: "session_state_load", actions: ["cookies_set"] });

    unit.bridge.setDisabled([]);
    await flush();
    expect(await unit.listNames()).toEqual(all);
    expect(unit.listChanged).toBe(4);
  });

  test("multi-action tools hide when any of their actions is off", async () => {
    unit = await startUnitServer({ server: { toolsets: ["all"] } });
    const all = await unit.listNames();
    unit.bridge.setDisabled(["tab_audio_record_stop", "perf_trace_chunk", "tabs_list"]);
    await flush();
    const now = await unit.listNames();
    expect(all.filter((n) => !now.includes(n)).sort()).toEqual(["perf_trace_stop", "tab_audio_capture", "tab_audio_record_stop", "tab_list"]);
  });

  test("an unknown snapshot (null) hides nothing; a batch of changes sends one notification", async () => {
    unit = await startUnitServer({ bridge: new FakeBridge({ disabled: ["dom_click", "dom_type", "page_text"] }) });
    expect(await unit.listNames()).not.toContain("page_text");
    unit.bridge.setDisabled(null);
    await flush();
    expect(unit.listChanged).toBe(1);
    const names = await unit.listNames();
    for (const n of ["dom_click", "dom_type", "page_text"]) expect(names).toContain(n);
  });

  test("re-enabling a switch does not override a toolset choice", async () => {
    unit = await startUnitServer();
    await toolsets(unit, { disable: ["interact"] });
    unit.bridge.setDisabled(["dom_click"]);
    await flush();
    unit.bridge.setDisabled([]);
    await flush();
    expect(await unit.listNames()).not.toContain("dom_click");
  });

  test("meta tools are never hidden by switches", async () => {
    unit = await startUnitServer({ bridge: new FakeBridge({ disabled: ["perm_list", "perm_set", "browser_close"] }) });
    const names = await unit.listNames();
    for (const n of META_TOOLS) expect(names).toContain(n);
  });
});

describe("calling a hidden tool", () => {
  test("a toolset that is off: the error names browser_toolsets; tools/list still hides the tool; nothing reaches the bridge", async () => {
    unit = await startUnitServer();
    expect(await unit.listNames()).not.toContain("frame_list");
    const res = await unit.call("frame_list", {});
    expect(res.isError).toBe(true);
    expect(texts(res)).toEqual([
      'Tool frame_list is not enabled: it belongs to the "tabs" toolset, which is off. Call browser_toolsets {"enable":["tabs"]} to list it, then call frame_list again.',
    ]);
    expect(unit.bridge.calls).toEqual([]);
    // Following the advice works.
    await toolsets(unit, { enable: ["tabs"] });
    const ok = await unit.call("frame_list", {});
    expect(ok.isError).toBeFalsy();
    expect(unit.bridge.callsOf("frame_list")).toHaveLength(1);
  });

  test("hidden tools are refused before input validation (no schema error leaks out)", async () => {
    unit = await startUnitServer();
    const res = await unit.call("trusted_click", { bogus: 1 });
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toStartWith('Tool trusted_click is not enabled: it belongs to the "trusted" toolset');
  });

  test("a popup switch: the error keeps the 'Permission disabled' wording and says to ask the user", async () => {
    unit = await startUnitServer({ bridge: new FakeBridge({ disabled: ["dom_click"] }) });
    const res = await unit.call("dom_click", { selector: "a" });
    expect(res.isError).toBe(true);
    expect(texts(res)).toEqual([
      "Permission disabled in extension: dom_click (enable it from the extension popup). Tool dom_click is hidden from the tool list while this switch is off; " +
        "only the user can switch it back on, so ask the user instead of retrying.",
    ]);
    expect(unit.bridge.calls).toEqual([]);
  });

  test("a required switch of another tool, and a switch plus a toolset that is off", async () => {
    unit = await startUnitServer({ bridge: new FakeBridge({ disabled: ["network_requests"] }) });
    const har = texts(await unit.call("har_export", {}))[0];
    expect(har).toStartWith("Permission disabled in extension: network_requests (enable it from the extension popup). Tool har_export is hidden");
    expect(har).toContain('(its toolset "network" is off as well: browser_toolsets {"enable":["network"]})');
    await toolsets(unit, { enable: ["network"] });
    const again = texts(await unit.call("har_export", {}))[0];
    expect(again).not.toContain("toolset");
    expect(unit.bridge.callsOf("har_export")).toEqual([]);
  });

  test("a switch turned off at runtime is reported at once; unknown tools keep the SDK error", async () => {
    unit = await startUnitServer();
    unit.bridge.setDisabled(["page_text"]);
    await flush();
    expect(texts(await unit.call("page_text", {}))[0]).toStartWith("Permission disabled in extension: page_text");
    const unknown = await unit.call("no_such_tool", {});
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)[0]).toContain("Tool no_such_tool not found");
  });

  test("hiddenToolMessage (pure): null for a listed tool, the switch wins over the toolset", () => {
    const tool: ToolsetMember = { name: "dom_drag", category: "interact", actions: ["dom_drag"] };
    const all = selectionOf(["all"]);
    expect(hiddenToolMessage(tool, all, null)).toBeNull();
    expect(hiddenToolMessage(tool, all, new Set(["dom_click"]))).toBeNull();
    expect(hiddenToolMessage(tool, selectionOf(["core"]), null)).toContain('browser_toolsets {"enable":["interact"]}');
    const both = hiddenToolMessage(tool, selectionOf(["core"]), new Set(["dom_drag"]))!;
    expect(both).toStartWith("Permission disabled in extension: dom_drag");
    expect(hiddenToolMessage({ ...tool, requires: ["a", "b"] }, all, new Set(["a", "b"]))).toContain("while these switches are off");
  });

  test("ToolKit refuses an McpServer whose tool handlers are already installed", () => {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: { listChanged: true } } });
    expect(() => new ToolKit(server, new FakeBridge())).toThrow("ToolKit needs an McpServer without tool handlers");
    const fresh = new McpServer({ name: "t", version: "0" });
    expect(() => new ToolKit(fresh, new FakeBridge())).not.toThrow();
  });
});
