// Static parity between the MCP tool layer (src/tools/*.ts, tool-kit.ts) and
// the extension (background.js / content.js / _locales). Two hand-kept
// copies of one catalog drift silently; these tests make the drift loud.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ACTIONS, EXTENSION_REQUIRES, toolActions, toolRequires } from "../../src/tool-kit.js";
import { CORE_TOOLS, TOOL_CATEGORIES } from "../../src/toolsets.js";
import { startUnitServer, type UnitServer } from "../helpers/unit-mcp.js";
import {
  actionPayloadReads,
  backgroundCases,
  backgroundSource,
  constBlock,
  contentCases,
  localeMessages,
  parsePermAliases,
  parsePermCats,
  parseRequires,
  stringsOfConst,
  toolSources,
} from "../helpers/unit-source-scan.js";

const bg = backgroundSource();
const PERM_CATS = parsePermCats(bg);
const PERM_ALL = PERM_CATS.flatMap((c) => c.actions);
const PERM_ALL_SET = new Set(PERM_ALL);
const INTERNAL_ACTIONS = stringsOfConst(bg, "INTERNAL_ACTIONS");
const UNGATED_ACTIONS = stringsOfConst(bg, "UNGATED_ACTIONS");
const KNOWN_ACTIONS_0_3_5 = stringsOfConst(bg, "KNOWN_ACTIONS_0_3_5");
const REQUIRES = parseRequires(bg);
const CASES = backgroundCases(bg);
const TOOLS = toolSources();
const CATEGORY_OF = new Map(PERM_CATS.flatMap((c) => c.actions.map((a) => [a, c.id] as const)));

// Mirror of background.js normalizeAction (checked against the source below).
const normalizeAction = (a: string) => (a === "tab_list" ? "tabs_list" : a);
const gated = (a: string) => PERM_ALL_SET.has(normalizeAction(a));

let unit: UnitServer;
let listed: Map<string, Tool>;

beforeAll(async () => {
  unit = await startUnitServer({ server: { toolsets: ["all"] } });
  listed = new Map((await unit.client.listTools()).tools.map((t) => [t.name, t]));
});

afterAll(async () => {
  await unit.close();
});

describe("permission catalog (background.js PERM_CATS) vs tool-kit.ts", () => {
  test("EXTENSION_ACTIONS equals PERM_CATS category by category, in order", () => {
    const fromExtension = Object.fromEntries(PERM_CATS.map((c) => [c.id, c.actions]));
    expect(EXTENSION_ACTIONS as Record<string, readonly string[]>).toEqual(fromExtension);
    expect(Object.keys(EXTENSION_ACTIONS)).toEqual(PERM_CATS.map((c) => c.id));
  });

  test("tool categories are the PERM_CATS ids plus meta", () => {
    expect([...TOOL_CATEGORIES].sort() as string[]).toEqual(["meta", ...PERM_CATS.map((c) => c.id)].sort());
  });

  test("an action belongs to exactly one category", () => {
    expect(PERM_ALL.length).toBe(PERM_ALL_SET.size);
  });

  test("normalizeAction maps only tab_list (mirrored above)", () => {
    expect(bg).toContain('return action === "tab_list" ? "tabs_list" : action;');
  });

  test("EXTENSION_REQUIRES equals REQUIRES, and both name catalog actions", () => {
    expect(EXTENSION_REQUIRES as Record<string, readonly string[]>).toEqual(REQUIRES);
    for (const [action, deps] of Object.entries(REQUIRES)) {
      expect(PERM_ALL_SET.has(action)).toBe(true);
      for (const d of deps) expect(PERM_ALL_SET.has(d)).toBe(true);
    }
  });

  test("PERM_ALIASES agree with toolActions()", () => {
    const aliases = parsePermAliases(bg);
    expect(Object.keys(aliases).length).toBeGreaterThan(0);
    for (const [tool, actions] of Object.entries(aliases)) expect([...toolActions(tool)]).toEqual(actions);
  });

  test("KNOWN_ACTIONS_0_3_5 is a duplicate-free subset of PERM_ALL", () => {
    expect(KNOWN_ACTIONS_0_3_5.length).toBeGreaterThan(100);
    expect(new Set(KNOWN_ACTIONS_0_3_5).size).toBe(KNOWN_ACTIONS_0_3_5.length);
    expect(KNOWN_ACTIONS_0_3_5.filter((a) => !PERM_ALL_SET.has(a))).toEqual([]);
  });
});

describe("command router (background.js handleCommand)", () => {
  test("every case is a catalog action or an INTERNAL_ACTIONS entry", () => {
    const stray = [...CASES.keys()].filter((a) => !PERM_ALL_SET.has(a) && !INTERNAL_ACTIONS.includes(a));
    expect(stray).toEqual([]);
  });

  test("every catalog action and internal action has a case", () => {
    expect(PERM_ALL.filter((a) => !CASES.has(a))).toEqual([]);
    expect(INTERNAL_ACTIONS.filter((a) => !CASES.has(a))).toEqual([]);
  });

  test("ungated actions are internal and not in the catalog", () => {
    expect(UNGATED_ACTIONS.filter((a) => !INTERNAL_ACTIONS.includes(a))).toEqual([]);
    expect(UNGATED_ACTIONS.filter((a) => PERM_ALL_SET.has(a))).toEqual([]);
  });

  test("content.js handles every command the background forwards unchanged", () => {
    const content = contentCases();
    for (const action of CASES.keys()) {
      const reads = actionPayloadReads(action);
      for (const cmd of reads?.contentCommands ?? []) expect({ action, cmd, handled: content.has(cmd) }).toEqual({ action, cmd, handled: true });
    }
  });
});

describe("tools (src/tools/*.ts) vs the extension", () => {
  test("the static scan sees exactly the registered tools, with their categories", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...unit.registry.keys()].sort());
    for (const t of TOOLS) expect({ tool: t.name, category: t.category }).toEqual({ tool: t.name, category: unit.registry.get(t.name)!.category });
  });

  test("every action a tool sends has a handleCommand case", () => {
    const missing = TOOLS.flatMap((t) => t.sends.filter((s) => !CASES.has(s.action)).map((s) => `${t.name} -> ${s.action}`));
    expect(missing).toEqual([]);
  });

  test("only tab_audio_capture's start and stop bypass the request's abort signal", () => {
    const raw = TOOLS.flatMap((t) => t.sends.filter((s) => s.raw).map((s) => `${t.name} -> ${s.action}`));
    // Start and stop: neither may be cut short by a cancel, or a recording keeps running.
    expect(raw.sort()).toEqual(["tab_audio_capture -> tab_audio_record_start", "tab_audio_capture -> tab_audio_record_stop"]);
  });

  test("a tool's category is the PERM_CATS category of every gated action it sends", () => {
    const wrong: string[] = [];
    for (const t of TOOLS) {
      for (const s of t.sends) {
        if (!gated(s.action)) {
          // Ungated sends (perm_list / perm_set) belong to meta tools only.
          if (!(t.category === "meta" && UNGATED_ACTIONS.includes(s.action))) wrong.push(`${t.name} (${t.category}) -> ${s.action} (ungated)`);
          continue;
        }
        const cat = CATEGORY_OF.get(normalizeAction(s.action));
        if (cat !== t.category) wrong.push(`${t.name} (${t.category}) -> ${s.action} (${cat})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("toolActions() is the set of gated actions each tool sends", () => {
    // Documented differences: js_evaluate's cdp_send path is a fallback for
    // extensions older than 0.3.4; browser_close goes through
    // bridge.closeBrowser() but honours the browser_close switch.
    const EXPECTED_DIFFERENCE: Record<string, { sentOnly?: string[]; mappedOnly?: string[] }> = {
      js_evaluate: { sentOnly: ["cdp_send"] },
      browser_close: { mappedOnly: ["browser_close"] },
    };
    const problems: string[] = [];
    for (const t of TOOLS) {
      const sent = [...new Set(t.sends.map((s) => s.action).filter(gated).map(normalizeAction))].sort();
      const mapped = [...toolActions(t.name)].sort();
      const sentOnly = sent.filter((a) => !mapped.includes(a));
      const mappedOnly = mapped.filter((a) => !sent.includes(a));
      const want = EXPECTED_DIFFERENCE[t.name] ?? {};
      if (JSON.stringify(sentOnly) !== JSON.stringify(want.sentOnly ?? []) || JSON.stringify(mappedOnly) !== JSON.stringify(want.mappedOnly ?? [])) {
        problems.push(`${t.name}: sends [${sent}] but toolActions() = [${mapped}]`);
      }
      for (const a of mapped) if (CATEGORY_OF.get(a) !== t.category) problems.push(`${t.name}: action ${a} is not in category ${t.category}`);
    }
    expect(problems).toEqual([]);
  });

  test("toolRequires() follows REQUIRES for the tool's actions", () => {
    for (const t of TOOLS) {
      const own = toolActions(t.name);
      const want = [...new Set(own.flatMap((a) => REQUIRES[a] ?? []))].filter((a) => !own.includes(a)).sort();
      expect({ tool: t.name, requires: [...toolRequires(t.name)].sort() }).toEqual({ tool: t.name, requires: want });
      expect(unit.registry.get(t.name)!.requires).toEqual(toolRequires(t.name));
    }
  });

  test("meta tools reach no switchable action", () => {
    for (const e of unit.registry.values()) if (e.category === "meta") expect({ tool: e.name, actions: e.actions }).toEqual({ tool: e.name, actions: [] });
  });

  test("every CORE_TOOLS name is a registered tool", () => {
    expect([...CORE_TOOLS].filter((n) => !unit.registry.has(n))).toEqual([]);
  });
});

describe("locales", () => {
  test("every PERM_CATS id has a non-empty cat_<id> message in every locale", () => {
    const locales = localeMessages();
    expect(locales.size).toBeGreaterThanOrEqual(10);
    const missing: string[] = [];
    for (const [loc, messages] of locales) {
      for (const c of PERM_CATS) {
        const msg = messages[`cat_${c.id}`]?.message;
        if (typeof msg !== "string" || !msg.trim()) missing.push(`${loc}: cat_${c.id}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------- payload fields ----------
// Each tool's zod input keys against the payload fields the extension reads
// for the actions the tool sends (handleCommand case, background helpers the
// payload is handed to, and the content.js command it is forwarded to).
// A key read by the extension but missing from the schema is a parameter zod
// strips silently (how dom_query limit, page_axtree maxNodes/depth,
// console_clear tabId and history_search endTime got lost); a schema key the
// extension never reads is either handled by the server or a typo.

/** Schema keys the server consumes itself (never part of a payload). */
const SERVER_SIDE_KEYS: Record<string, string[]> = {
  browser_launch: ["timeoutMs"], // bridge.launchBrowser()
  browser_close: ["force"], // bridge.closeBrowser()
  browser_toolsets: ["enable", "disable"], // ToolKit toolset state
  emulation_viewport: ["device"], // server-side presets (DEVICE_PRESETS) expand into width/height/...
  page_pdf: ["savePath"],
  page_snapshot: ["offset", "maxChars"], // the server windows the tree the extension returns whole
  session_state_save: ["savePath", "overwrite"],
  session_state_load: ["filePath"], // read by the server, sent as state
  cookies_export: ["savePath", "overwrite"],
  cookies_import: ["filePath"], // read by the server, sent as cookies
  tab_audio_record_stop: ["savePath", "overwrite"],
  tab_audio_capture: ["durationSeconds", "savePath", "overwrite"], // the wait runs in the server
  perf_trace_stop: ["savePath", "overwrite"],
};

/** Payload fields the extension reads that a tool deliberately does not expose. */
const NOT_EXPOSED: Record<string, string[]> = {
  perf_trace_stop: ["traceId", "index"], // perf_trace_chunk is internal: the server reads every chunk itself
  js_evaluate: ["method", "params"], // cdp_send fallback for extensions older than 0.3.4, built by the server
  // tab_audio_capture names the tab the extension picked (no tabId given) in
  // the stop payload, so it never becomes the command's target tab.
  tab_audio_capture: ["recordingTabId"],
  tab_audio_record_stop: ["recordingTabId"],
  // Known gaps (reported in wave 3; remove the entry when the tool exposes the field):
  network_throttle: ["offline"], // profile "custom" honours offline:true; the "offline" profile covers it
  notification_create: ["id"], // caller-chosen notification id (replaces an existing notification)
};

/** Handlers that read their fields through a lookup table instead of payload.<key>. */
function tableReads(action: string): string[] {
  if (action !== "emulation_media") return [];
  const body = CASES.get(action)!;
  // The handler walks BG2C_MEDIA_FEATURES plus the "media" type: if that changes, revisit this.
  expect(body).toContain("Object.entries(BG2C_MEDIA_FEATURES)");
  expect(body).toContain('["media", [BG2C_MEDIA_TYPES]]');
  expect(body).toContain("payload[key]");
  const table = constBlock(bg, "BG2C_MEDIA_FEATURES");
  return [...[...table.matchAll(/^\s+([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]), "media"];
}

function readsOfTool(name: string): Set<string> {
  const t = TOOLS.find((x) => x.name === name)!;
  const keys = new Set<string>();
  for (const action of new Set(t.sends.map((s) => s.action))) {
    const r = actionPayloadReads(action);
    if (!r) throw new Error(`${name}: no handleCommand case for ${action}`);
    for (const k of r.keys) keys.add(k);
    for (const k of tableReads(action)) keys.add(k);
  }
  return keys;
}

const schemaKeys = (name: string) => Object.keys((listed.get(name)?.inputSchema as { properties?: object })?.properties ?? {});

describe("payload fields (zod schema vs extension handlers)", () => {
  test("the reader finds known fields (self-check)", () => {
    expect([...actionPayloadReads("dom_query")!.keys].sort()).toEqual(["limit", "selector"]);
    expect(actionPayloadReads("page_axtree")!.keys).toContain("maxNodes");
    expect(actionPayloadReads("console_clear")!.keys).toContain("tabId");
    expect(actionPayloadReads("history_search")!.keys).toContain("endTime");
    expect(actionPayloadReads("page_text")!.contentCommands).toEqual(new Set(["page_text"]));
    expect(actionPayloadReads("no_such_action")).toBeNull();
  });

  test("every schema key a tool forwards is read by the extension", () => {
    const problems: string[] = [];
    for (const t of TOOLS) {
      const reads = readsOfTool(t.name);
      const serverSide = SERVER_SIDE_KEYS[t.name] ?? [];
      // tabId travels as the command target (or a filter the handler reads).
      const unread = schemaKeys(t.name).filter((k) => k !== "tabId" && !serverSide.includes(k) && !reads.has(k));
      if (unread.length) problems.push(`${t.name}: ${unread.join(", ")} never read by the extension`);
    }
    expect(problems).toEqual([]);
  });

  test("every payload field the extension reads is in the tool's schema", () => {
    const problems: string[] = [];
    for (const t of TOOLS) {
      const keys = schemaKeys(t.name);
      const allowed = NOT_EXPOSED[t.name] ?? [];
      const stripped = [...readsOfTool(t.name)].filter((k) => !keys.includes(k) && !allowed.includes(k));
      if (stripped.length) problems.push(`${t.name}: the extension reads ${stripped.join(", ")}, the schema drops it`);
    }
    expect(problems).toEqual([]);
  });

  test("allow-list entries are still needed", () => {
    const stale: string[] = [];
    for (const [tool, keys] of Object.entries(SERVER_SIDE_KEYS)) {
      const reads = readsOfTool(tool);
      for (const k of keys) if (!schemaKeys(tool).includes(k) || reads.has(k)) stale.push(`SERVER_SIDE_KEYS ${tool}.${k}`);
    }
    for (const [tool, keys] of Object.entries(NOT_EXPOSED)) {
      const reads = readsOfTool(tool);
      for (const k of keys) if (schemaKeys(tool).includes(k) || !reads.has(k)) stale.push(`NOT_EXPOSED ${tool}.${k}`);
    }
    expect(stale).toEqual([]);
  });
});
