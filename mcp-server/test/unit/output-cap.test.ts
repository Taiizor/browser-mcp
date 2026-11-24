// The output cap: the pure capToolOutput(), the cap resolution, and the cap
// applied to every tool by ToolKit.define (saved file included).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  capToolOutput,
  currentSpillDir,
  DEFAULT_MAX_OUTPUT_CHARS,
  MIN_OUTPUT_CHARS,
  NARROW_HINT,
  PAGING_HINT,
  pruneStaleSpillDirs,
  removeSpillDir,
  resolveMaxOutputChars,
  SENSITIVE_HINT,
  SENSITIVE_OUTPUT_CATEGORIES,
  SPILL_DIR_PREFIX,
  SPILL_MAX_AGE_MS,
  spillToPrivateTemp,
} from "../../src/tool-kit.js";
import { startUnitServer, texts, type UnitServer } from "../helpers/unit-mcp.js";
import { cleanupTempDirs, makeTempDir, trackTempPath } from "../helpers/unit-temp.js";

const NOTE_RE = /\[output truncated: (\d+)\/(\d+) chars; full output saved to (.+?); ([^\]]+)\]$/;
/** The note of a cut whose rest was not saved (sensitive categories). */
const WITHHELD_RE = /\[output truncated: (\d+)\/(\d+) chars; the rest is not saved to disk \(([^)]+)\); ([^\]]+)\]$/;

/** A save callback that records what it got and returns a fake path. */
function recorder() {
  const saved: Array<{ text: string; ext: string }> = [];
  const save = (text: string, ext: ".txt" | ".json") => {
    saved.push({ text, ext });
    return `/saved/out${ext}`;
  };
  return { saved, save };
}

const text = (t: string) => ({ type: "text" as const, text: t });
const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
const audio = { type: "audio" as const, data: "GkXfow==", mimeType: "audio/webm" };

afterAll(cleanupTempDirs);

describe("capToolOutput (pure)", () => {
  test("at or under the cap the very same result comes back and nothing is saved", () => {
    const { saved, save } = recorder();
    const exact: CallToolResult = { content: [text("a".repeat(600)), image, text("b".repeat(400))] };
    expect(capToolOutput(exact, 1000, save)).toBe(exact);
    const empty: CallToolResult = { content: [] };
    expect(capToolOutput(empty, 1000, save)).toBe(empty);
    const imagesOnly: CallToolResult = { content: [image, audio] };
    expect(capToolOutput(imagesOnly, 1000, save)).toBe(imagesOnly);
    expect(saved).toEqual([]);
  });

  test("one char over the cap: head of exactly maxChars plus the note; the full text is saved", () => {
    const { saved, save } = recorder();
    const full = "x".repeat(1001);
    const out = capToolOutput({ content: [text(full)] }, 1000, save);
    expect(out.content).toHaveLength(1);
    const t = texts(out)[0];
    const [head, note] = [t.slice(0, t.indexOf("\n")), t.slice(t.indexOf("\n") + 1)];
    expect(head).toBe("x".repeat(1000));
    expect(note).toBe(`[output truncated: 1000/1001 chars; full output saved to /saved/out.txt; ${NARROW_HINT}]`);
    expect(saved).toEqual([{ text: full, ext: ".txt" }]);
  });

  test("JSON output is saved as .json, anything else as .txt", () => {
    const { saved, save } = recorder();
    const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ ref: `e${i}`, text: "item" })) });
    capToolOutput({ content: [text(json)] }, 1000, save);
    capToolOutput({ content: [text(`  [${"1,".repeat(600)}1]`)] }, 1000, save);
    capToolOutput({ content: [text(`{"broken": ${"1".repeat(1200)}`)] }, 1000, save);
    // Two JSON parts joined by "\n" are not one JSON document.
    capToolOutput({ content: [text('{"a":1}'), text(json)] }, 1000, save);
    expect(saved.map((s) => s.ext)).toEqual([".json", ".json", ".txt", ".txt"]);
    expect(JSON.parse(saved[0].text)).toEqual(JSON.parse(json));
  });

  test("several parts: whole parts while they fit, the cut part's head, later text dropped, non-text kept in place", () => {
    const { saved, save } = recorder();
    const a = "a".repeat(600);
    const b = "b".repeat(600);
    const c = "c".repeat(10);
    const out = capToolOutput({ content: [text(a), image, text(b), audio, text(c)], isError: false }, 1000, save);
    expect(out.content).toHaveLength(4);
    expect(out.content[0]).toEqual(text(a));
    expect(out.content[1]).toBe(image);
    expect(out.content[3]).toBe(audio);
    const cut = texts(out)[1];
    expect(cut.startsWith(`${"b".repeat(400)}\n[output truncated: 1000/1210 chars;`)).toBe(true);
    expect(saved[0].text).toBe([a, b, c].join("\n"));
    expect(out.isError).toBe(false);
  });

  test("a cut that falls exactly on a part boundary replaces the next part with the note", () => {
    const { save } = recorder();
    const out = capToolOutput({ content: [text("m".repeat(1000)), text("n".repeat(50))] }, 1000, save);
    expect(texts(out)).toEqual(["m".repeat(1000), `[output truncated: 1000/1050 chars; full output saved to /saved/out.txt; ${NARROW_HINT}]`]);
  });

  test("never splits a surrogate pair", () => {
    const { save } = recorder();
    const full = `${"a".repeat(999)}\u{1F600}${"z".repeat(100)}`;
    const t = texts(capToolOutput({ content: [text(full)] }, 1000, save))[0];
    const head = t.slice(0, t.indexOf("\n"));
    expect(head).toBe("a".repeat(999));
    expect(t).toContain("[output truncated: 999/1101 chars;");
  });

  test("isError results are capped too and stay errors", () => {
    const { save } = recorder();
    const out = capToolOutput({ content: [text("E".repeat(5000))], isError: true }, 1000, save);
    expect(out.isError).toBe(true);
    expect(texts(out)[0]).toMatch(NOTE_RE);
    expect(texts(out)[0].length).toBeLessThan(1300);
  });

  test("a failing save is reported in the note instead of a path", () => {
    const out = capToolOutput({ content: [text("q".repeat(2000))] }, 1000, () => {
      throw new Error("disk full");
    });
    expect(texts(out)[0]).toEndWith(`[output truncated: 1000/2000 chars; saving the full output failed (disk full); ${NARROW_HINT}]`);
  });

  test("options form: a custom hint, and no saver means the rest is withheld (save is never called)", () => {
    const { saved, save } = recorder();
    const hinted = capToolOutput({ content: [text("h".repeat(1500))] }, 1000, { save, hint: "page with offset" });
    expect(texts(hinted)[0]).toEndWith("[output truncated: 1000/1500 chars; full output saved to /saved/out.txt; page with offset]");
    const withheld = capToolOutput({ content: [text("s".repeat(1500))] }, 1000, { save: null, withheld: "cookies data is sensitive", hint: "narrow it" });
    expect(texts(withheld)[0]).toEndWith("[output truncated: 1000/1500 chars; the rest is not saved to disk (cookies data is sensitive); narrow it]");
    const bare = capToolOutput({ content: [text("s".repeat(1500))] }, 1000, {});
    expect(texts(bare)[0]).toEndWith(`[output truncated: 1000/1500 chars; the rest is not saved to disk; ${NARROW_HINT}]`);
    expect(saved).toHaveLength(1);
  });

  test("other result fields survive (structuredContent, _meta)", () => {
    const { save } = recorder();
    const out = capToolOutput({ content: [text("w".repeat(3000))], structuredContent: { n: 1 }, _meta: { k: "v" } }, 1000, save);
    expect(out.structuredContent).toEqual({ n: 1 });
    expect(out._meta).toEqual({ k: "v" });
  });
});

describe("resolveMaxOutputChars", () => {
  test("explicit > BROWSER_MCP_MAX_OUTPUT_CHARS > default; minimum enforced; bad env ignored", () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    expect(resolveMaxOutputChars(undefined, {}, log)).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(40000);
    expect(resolveMaxOutputChars(undefined, { BROWSER_MCP_MAX_OUTPUT_CHARS: " 2500 " }, log)).toBe(2500);
    expect(resolveMaxOutputChars(5000, { BROWSER_MCP_MAX_OUTPUT_CHARS: "2500" }, log)).toBe(5000);
    expect(logs).toEqual([]);
    expect(resolveMaxOutputChars(undefined, { BROWSER_MCP_MAX_OUTPUT_CHARS: "12k" }, log)).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(resolveMaxOutputChars(undefined, { BROWSER_MCP_MAX_OUTPUT_CHARS: "-5" }, log)).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(resolveMaxOutputChars(undefined, { BROWSER_MCP_MAX_OUTPUT_CHARS: "10" }, log)).toBe(MIN_OUTPUT_CHARS);
    expect(resolveMaxOutputChars(1, {}, log)).toBe(MIN_OUTPUT_CHARS);
    expect(resolveMaxOutputChars(Number.NaN, {}, log)).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(logs).toEqual([
      'ignoring BROWSER_MCP_MAX_OUTPUT_CHARS="12k" (expected a whole number); using 40000',
      'ignoring BROWSER_MCP_MAX_OUTPUT_CHARS="-5" (expected a whole number); using 40000',
      "BROWSER_MCP_MAX_OUTPUT_CHARS=10 is below the minimum; using 1000",
      "maxOutputChars=1 is below the minimum; using 1000",
    ]);
  });
});

describe("the cap on real tools (ToolKit.define)", () => {
  let unit: UnitServer | undefined;
  afterEach(async () => {
    await unit?.close();
    unit = undefined;
    cleanupTempDirs();
  });

  test("createServer reads the cap from env and from opts", async () => {
    unit = await startUnitServer({ server: { env: { BROWSER_MCP_MAX_OUTPUT_CHARS: "1500" } } });
    expect(unit.kit.maxOutputChars).toBe(1500);
    await unit.close();
    unit = await startUnitServer({ server: { maxOutputChars: 3000, env: { BROWSER_MCP_MAX_OUTPUT_CHARS: "1500" } } });
    expect(unit.kit.maxOutputChars).toBe(3000);
  });

  test("a large JSON result is cut and saved in full through the default saver (the process's spill folder)", async () => {
    unit = await startUnitServer({ server: { maxOutputChars: 2000, saveOutput: undefined } });
    const items = Array.from({ length: 400 }, (_, i) => ({ ref: `e${i}`, tag: "a", text: `link number ${i}` }));
    unit.bridge.responder = () => ({ total: 400, returned: 400, items });
    const res = await unit.call("dom_query", { selector: "a", limit: 400 });
    const [only] = texts(res);
    expect(res.content).toHaveLength(1);
    const m = only.match(NOTE_RE);
    expect(m).not.toBeNull();
    const [, shown, total, savedTo, hint] = m!;
    expect(Number(shown)).toBe(2000);
    // dom_query has no offset parameter: the note must not promise paging.
    expect(hint).toBe(NARROW_HINT);
    expect(only.length).toBeLessThan(2000 + 300);
    trackTempPath(path.dirname(savedTo));
    expect(path.basename(savedTo)).toBe("dom_query-output.json");
    expect(path.resolve(path.dirname(path.dirname(savedTo)))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(path.dirname(savedTo))).toStartWith(`${SPILL_DIR_PREFIX}${process.pid}-`);
    expect(path.dirname(savedTo)).toBe(currentSpillDir()!);
    const full = fs.readFileSync(savedTo, "utf8");
    expect(full.length).toBe(Number(total));
    expect(JSON.parse(full).items).toEqual(items);
    if (process.platform !== "win32") expect(fs.statSync(savedTo).mode & 0o777).toBe(0o600);

    // A second spill of the same tool lands in the same folder under a new name.
    const again = texts(await unit.call("dom_query", { selector: "a", limit: 400 }))[0].match(NOTE_RE)!;
    expect(path.dirname(again[3])).toBe(path.dirname(savedTo));
    expect(path.basename(again[3])).toBe("dom_query-output-2.json");
    expect(fs.existsSync(savedTo)).toBe(true);
  });

  test("a two-part page window is cut in the text part and saved as .txt; metadata kept", async () => {
    const dir = makeTempDir("cap");
    const saved: string[] = [];
    unit = await startUnitServer({
      server: {
        maxOutputChars: 1000,
        saveOutput: (data, baseName) => {
          const file = path.join(dir, baseName);
          fs.writeFileSync(file, data);
          saved.push(file);
          return file;
        },
      },
    });
    // An extension that returns more than the window the server asked for.
    unit.bridge.responder = () => ({ tabId: 7, text: "T".repeat(5000), offset: 0, length: 5000, totalLength: 5000, truncated: false, nextOffset: null });
    const res = await unit.call("page_text", {});
    expect(unit.bridge.calls[0].payload).toEqual({ offset: undefined, maxChars: 1000 - 256 });
    const [meta, body] = texts(res);
    expect(JSON.parse(meta)).toMatchObject({ tabId: 7, totalLength: 5000 });
    expect(body).toMatch(NOTE_RE);
    expect(body.match(NOTE_RE)![4]).toBe(PAGING_HINT);
    expect(meta.length + body.slice(0, body.lastIndexOf("\n")).length).toBe(1000);
    expect(saved.map((f) => path.basename(f))).toEqual(["page_text-output.txt"]);
    expect(fs.readFileSync(saved[0], "utf8")).toBe(`${meta}\n${"T".repeat(5000)}`);
  });

  test("images pass the cap untouched", async () => {
    unit = await startUnitServer({ server: { maxOutputChars: 1000, saveOutput: () => "/unused" } });
    const big = Buffer.alloc(50_000, 7).toString("base64");
    unit.bridge.responder = () => ({ tabId: 1, dataUrl: `data:image/png;base64,${big}` });
    const res = await unit.call("page_screenshot", {});
    const img = res.content.find((p) => p.type === "image") as { data: string } | undefined;
    expect(img?.data).toBe(big);
  });

  test("an oversized thrown error becomes a capped isError result; a short one keeps the SDK error path", async () => {
    const dir = makeTempDir("cap");
    unit = await startUnitServer({
      server: {
        maxOutputChars: 1000,
        saveOutput: (data, baseName) => {
          const file = path.join(dir, baseName);
          fs.writeFileSync(file, data);
          return file;
        },
      },
    });
    unit.bridge.responder = () => {
      throw new Error(`Page JS error: ${"E".repeat(3000)}`);
    };
    const big = await unit.call("page_text", {});
    expect(big.isError).toBe(true);
    expect(texts(big)[0]).toMatch(NOTE_RE);
    expect(fs.readFileSync(path.join(dir, "page_text-output.txt"), "utf8")).toBe(`Page JS error: ${"E".repeat(3000)}`);

    unit.bridge.responder = () => {
      throw new Error("short failure");
    };
    const small = await unit.call("page_text", {});
    expect(small.isError).toBe(true);
    expect(texts(small)).toEqual(["short failure"]);
  });
});

describe("sensitive categories are never spilled", () => {
  let unit: UnitServer | undefined;
  afterEach(async () => {
    await unit?.close();
    unit = undefined;
  });

  test("the sensitive set is cookies, storage, sessions and clipboard", () => {
    expect([...SENSITIVE_OUTPUT_CATEGORIES].sort()).toEqual(["clipboard", "cookies", "sessions", "storage"]);
  });

  test("cut text of cookies / storage / sessions / clipboard tools is not saved; the note says how to get the rest", async () => {
    const saved: string[] = [];
    unit = await startUnitServer({
      server: {
        toolsets: ["all"],
        maxOutputChars: 1000,
        saveOutput: (_data, baseName) => {
          saved.push(baseName);
          return "/must/not/be/used";
        },
      },
    });
    const big = { values: Array.from({ length: 200 }, (_, i) => ({ name: `k${i}`, value: "secret-value-".repeat(3) })) };
    unit.bridge.responder = () => big;
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["cookies_list", {}, "cookies", "narrow it with domain, url or name"],
      ["storage_get", { full: true }, "storage", "omit full:true"],
      ["idb_read", { db: "d", store: "s" }, "storage", "lower limit, or read one row by key"],
      ["clipboard_read", {}, "clipboard", "clipboard text is never written to disk"],
      ["sessions_recently_closed", {}, "sessions", "lower maxResults"],
      ["cookies_get", { url: "https://a.test", name: "n" }, "cookies", SENSITIVE_HINT],
    ];
    for (const [tool, args, category, hint] of cases) {
      const res = await unit.call(tool, args);
      expect({ tool, isError: !!res.isError }).toEqual({ tool, isError: false });
      const t = texts(res).join("\n");
      const m = t.match(WITHHELD_RE);
      expect({ tool, note: m ? [m[3], m[4].startsWith(hint)] : null }).toEqual({ tool, note: [`${category} data is sensitive`, true] });
      expect(t.length).toBeLessThan(1000 + 400);
    }
    expect(saved).toEqual([]);
  });

  test("other categories still spill (history, network)", async () => {
    const saved: string[] = [];
    unit = await startUnitServer({
      server: {
        toolsets: ["all"],
        maxOutputChars: 1000,
        saveOutput: (_data, baseName) => {
          saved.push(baseName);
          return `/saved/${baseName}`;
        },
      },
    });
    unit.bridge.responder = () => ({ items: "x".repeat(5000) });
    await unit.call("history_search", { query: "" });
    await unit.call("network_requests", {});
    expect(saved).toEqual(["history_search-output.json", "network_requests-output.json"]);
  });

  test("a tool's own capHint replaces the default hint", async () => {
    unit = await startUnitServer({ server: { toolsets: ["all"], maxOutputChars: 1000, saveOutput: () => "/saved/x.txt" } });
    unit.kit.define({
      name: "zz_hinted",
      title: "Hinted",
      description: "test tool",
      category: "read",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      capHint: "ask for less",
      handler: async () => ({ content: [{ type: "text", text: "y".repeat(3000) }] }),
    });
    const t = texts(await unit.call("zz_hinted"))[0];
    expect(t).toEndWith("full output saved to /saved/x.txt; ask for less]");
  });
});

describe("the spill folder", () => {
  afterEach(() => {
    removeSpillDir();
    cleanupTempDirs();
  });

  test("one private folder per process, created on first use, removed by removeSpillDir and recreated after", () => {
    removeSpillDir();
    expect(currentSpillDir()).toBeNull();
    const a = spillToPrivateTemp(Buffer.from("a"), "t-output.txt");
    const dir = currentSpillDir()!;
    expect(path.dirname(a)).toBe(dir);
    expect(path.basename(dir)).toStartWith(`${SPILL_DIR_PREFIX}${process.pid}-`);
    expect(path.resolve(path.dirname(dir))).toBe(path.resolve(os.tmpdir()));
    const b = spillToPrivateTemp(Buffer.from("b"), "t-output.txt");
    const c = spillToPrivateTemp(Buffer.from("c"), "u-output.json");
    expect([path.basename(a), path.basename(b), path.basename(c)]).toEqual(["t-output.txt", "t-output-2.txt", "u-output.json"]);
    expect(fs.readFileSync(b, "utf8")).toBe("b");
    if (process.platform !== "win32") expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    removeSpillDir();
    expect(fs.existsSync(dir)).toBe(false);
    expect(currentSpillDir()).toBeNull();
    removeSpillDir(); // a second call is a no-op

    // Something else removed the folder: the next spill recreates one.
    const d = spillToPrivateTemp(Buffer.from("d"), "t-output.txt");
    fs.rmSync(path.dirname(d), { recursive: true, force: true });
    const e = spillToPrivateTemp(Buffer.from("e"), "t-output.txt");
    expect(fs.readFileSync(e, "utf8")).toBe("e");
  });

  test("the start-up sweep removes only stale spill folders of dead processes and old one-file spill folders", () => {
    const root = makeTempDir("prune");
    const now = Date.now();
    const old = (now - SPILL_MAX_AGE_MS - 60_000) / 1000;
    const mk = (name: string, files: Record<string, string> = {}, aged = true) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
      if (aged) fs.utimesSync(dir, old, old);
      return dir;
    };
    const deadOld = mk(`${SPILL_DIR_PREFIX}111-AbC123`, { "dom_query-output.json": "{}" });
    const aliveOld = mk(`${SPILL_DIR_PREFIX}222-AbC123`, { "page_text-output.txt": "t" });
    const deadNew = mk(`${SPILL_DIR_PREFIX}333-AbC123`, { "page_text-output.txt": "t" }, false);
    const legacy = mk("browser-mcp-Xy12Zq", { "cookies_list-output.json": "[]" });
    const legacyNew = mk("browser-mcp-Qq12Zq", { "cookies_list-output.json": "[]" }, false);
    const trace = mk("browser-mcp-Tr12Zq", { "trace-5-1700000000000.json": "{}" });
    const twoFiles = mk("browser-mcp-Tw12Zq", { "a-output.json": "{}", "b-output.json": "{}" });
    const audio = mk("browser-mcp-Au12Zq", { "tab-4-1700000000000.webm": "x" });
    const unrelated = mk("browser-mcp-unit-abc", { "dom_query-output.json": "{}" });
    const notADir = path.join(root, `${SPILL_DIR_PREFIX}444-AbC123`);
    fs.writeFileSync(notADir, "file");
    fs.utimesSync(notADir, old, old);

    const removed = pruneStaleSpillDirs({ tmpdir: root, now, isAlive: (pid) => pid === 222 });
    expect(removed.sort()).toEqual([deadOld, legacy].sort());
    for (const kept of [aliveOld, deadNew, legacyNew, trace, twoFiles, audio, unrelated, notADir]) expect({ kept, exists: fs.existsSync(kept) }).toEqual({ kept, exists: true });
    expect(pruneStaleSpillDirs({ tmpdir: path.join(root, "missing") })).toEqual([]);
  });
});
