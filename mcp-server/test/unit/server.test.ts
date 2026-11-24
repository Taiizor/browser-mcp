// createServer() through a real MCP client (InMemoryTransport) and a fake
// bridge: what tools/list shows, server metadata, resources and prompts.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../../src/server.js";
import { CORE_TOOLS } from "../../src/toolsets.js";
import { FakeBridge } from "../helpers/unit-fake-bridge.js";
import { startUnitServer, type UnitServer } from "../helpers/unit-mcp.js";
import { MCP_ROOT } from "../helpers/unit-source-scan.js";

// The default ("core") listing: CORE_TOOLS plus the meta tools, which are always listed.
const DEFAULT_LISTING = [
  "browser_launch",
  "browser_status",
  "browser_toolsets",
  "console_get",
  "dialog_policy",
  "dom_check",
  "dom_click",
  "dom_fill",
  "dom_hover",
  "dom_query",
  "dom_scroll",
  "dom_select",
  "dom_type",
  "dom_upload",
  "keyboard_press",
  "page_find",
  "page_html",
  "page_screenshot",
  "page_snapshot",
  "page_text",
  "page_wait",
  "permissions_list",
  "permissions_set",
  "tab_activate",
  "tab_back",
  "tab_close",
  "tab_create",
  "tab_forward",
  "tab_list",
  "tab_navigate",
  "tab_reload",
];

let unit: UnitServer | undefined;
afterEach(async () => {
  await unit?.close();
  unit = undefined;
});

describe("tools/list", () => {
  test("defaults to the core toolset plus the meta tools", async () => {
    unit = await startUnitServer();
    expect(await unit.listNames()).toEqual(DEFAULT_LISTING);
    const meta = [...unit.registry.values()].filter((e) => e.category === "meta").map((e) => e.name);
    expect(DEFAULT_LISTING).toEqual([...new Set([...CORE_TOOLS, ...meta])].sort());
    expect(unit.logs).toEqual([]);
  });

  test('"all" lists every registered tool', async () => {
    unit = await startUnitServer({ server: { toolsets: ["all"] } });
    const names = await unit.listNames();
    expect(names).toEqual([...unit.registry.keys()].sort());
    expect(names.length).toBeGreaterThanOrEqual(122);
  });

  test("BROWSER_MCP_TOOLSETS selects the start-up toolsets; an explicit list wins", async () => {
    unit = await startUnitServer({ server: { env: { BROWSER_MCP_TOOLSETS: "network" } } });
    const fromEnv = await unit.listNames();
    expect(fromEnv).toContain("har_export");
    expect(fromEnv).not.toContain("dom_click");
    await unit.close();
    unit = await startUnitServer({ server: { env: { BROWSER_MCP_TOOLSETS: "network" }, toolsets: ["cookies"] } });
    const explicit = await unit.listNames();
    expect(explicit).toContain("cookies_list");
    expect(explicit).not.toContain("har_export");
  });

  test("every tool has a title, a description and annotations", async () => {
    unit = await startUnitServer({ server: { toolsets: ["all"] } });
    const { tools } = await unit.client.listTools();
    const problems = tools.flatMap((t) => [
      ...(typeof t.title === "string" && t.title.trim() ? [] : [`${t.name}: no title`]),
      ...(typeof t.description === "string" && t.description.trim() ? [] : [`${t.name}: no description`]),
      ...(typeof t.annotations?.readOnlyHint === "boolean" ? [] : [`${t.name}: no readOnlyHint`]),
      ...(t.inputSchema?.type === "object" ? [] : [`${t.name}: input schema is not an object`]),
    ]);
    expect(problems).toEqual([]);
    expect(new Set(tools.map((t) => t.title)).size).toBe(tools.length);
  });

  test("the default listing stays small (LLM context budget)", async () => {
    unit = await startUnitServer();
    const { tools } = await unit.client.listTools();
    // About 26k chars today against about 90k for every tool. The budget only
    // catches a regression back towards "everything is listed".
    expect(JSON.stringify(tools).length).toBeLessThan(40000);
  });
});

describe("server metadata", () => {
  test("name, version (package.json), listChanged capability and instructions", async () => {
    unit = await startUnitServer();
    expect(unit.client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: pkg.version });
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(unit.client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(unit.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toContain("browser_toolsets");
  });

  test("opts.version overrides the reported version", async () => {
    unit = await startUnitServer({ server: { version: "9.9.9-test" } });
    expect(unit.client.getServerVersion()?.version).toBe("9.9.9-test");
  });

  test("resources and prompts are registered with titles", async () => {
    unit = await startUnitServer();
    const { resources } = await unit.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "browser://console/recent",
      "browser://network/recent",
      "browser://status",
      "browser://tabs",
    ]);
    for (const r of resources) expect(r.title).toBeTruthy();
    const { prompts } = await unit.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["accessibility_audit", "form_automation", "performance_audit", "web_research"]);
    for (const p of prompts) expect(p.title).toBeTruthy();
  });

  test("the network resource honours the popup switch", async () => {
    const bridge = new FakeBridge({ disabled: ["network_requests"] });
    bridge.networkEvents.push({ url: "https://example.test/" });
    unit = await startUnitServer({ bridge });
    const res = await unit.client.readResource({ uri: "browser://network/recent" });
    const body = JSON.parse(String((res.contents[0] as { text?: string }).text));
    expect(body.error).toContain("Permission disabled in extension: network_requests");
  });

  test("closing the server stops following the bridge's permission snapshot", async () => {
    const bridge = new FakeBridge();
    unit = await startUnitServer({ bridge });
    expect(bridge.permListenerCount).toBe(1);
    await unit.close();
    unit = undefined;
    expect(bridge.permListenerCount).toBe(0);
  });
});

describe("registration API", () => {
  const srcFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return srcFiles(p);
      return d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") ? [p] : [];
    });

  test("no deprecated server.tool / server.resource / server.prompt calls", () => {
    const hits: string[] = [];
    for (const file of srcFiles(path.join(MCP_ROOT, "src"))) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/\.(tool|resource|prompt)\s*\(/.test(line)) hits.push(`${path.relative(MCP_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("registerTool is called in exactly one place (ToolKit.define)", () => {
    const hits = srcFiles(path.join(MCP_ROOT, "src")).flatMap((file) =>
      [...fs.readFileSync(file, "utf8").matchAll(/\.registerTool\s*\(/g)].map(() => path.relative(MCP_ROOT, file).replace(/\\/g, "/"))
    );
    expect(hits).toEqual(["src/tool-kit.ts"]);
  });
});
