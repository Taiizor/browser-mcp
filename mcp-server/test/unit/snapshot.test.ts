// page_snapshot paging: the pure line-aligned window (snapshotWindow) and the
// tool, which windows the tree the extension returns whole so the result
// always fits the output cap (metadata block + raw text block, like page_text).
import { afterEach, describe, expect, test } from "bun:test";
import { snapshotWindow } from "../../src/tools/read.js";
import { startUnitServer, texts, type UnitServer } from "../helpers/unit-mcp.js";

/** A tree like content.js builds: a header line, then one line per element. */
function tree(lines: number, width = 120): string {
  const out = ['url=https://news.example/ title="News" interactive=' + lines];
  for (let i = 0; i < lines; i++) out.push(`[ref=e${100000000 + i}] <a> href="/story/${i}" ${"x".repeat(Math.max(0, width - 40))}`);
  return out.join("\n");
}

describe("snapshotWindow (pure)", () => {
  test("windows end after a whole line, and joined in order they give the tree back", () => {
    const full = tree(400);
    const parts: string[] = [];
    let offset: number | undefined = 0;
    let calls = 0;
    while (offset !== undefined) {
      const w = snapshotWindow(full, offset, 5000);
      expect(w.offset).toBe(offset);
      expect(w.length).toBe(w.text.length);
      expect(w.length).toBeLessThanOrEqual(5000);
      expect(w.totalLength).toBe(full.length);
      if (w.truncated) {
        expect(w.text.endsWith("\n")).toBe(true);
        expect(w.nextOffset).toBe(offset + w.length);
      } else {
        expect(w.nextOffset).toBeNull();
      }
      parts.push(w.text);
      offset = w.nextOffset ?? undefined;
      calls++;
    }
    expect(parts.join("")).toBe(full);
    expect(calls).toBeGreaterThan(5);
  });

  test("a tree that fits comes back whole", () => {
    const full = tree(3);
    expect(snapshotWindow(full, undefined, 40000)).toEqual({
      text: full,
      offset: 0,
      length: full.length,
      totalLength: full.length,
      truncated: false,
      nextOffset: null,
    });
  });

  test("an offset inside a line moves back to the start of that line", () => {
    const full = "aaaa\nbbbb\ncccc";
    const w = snapshotWindow(full, 7, 100);
    expect(w.offset).toBe(5);
    expect(w.text).toBe("bbbb\ncccc");
  });

  test("offsets past the end and odd sizes are clamped", () => {
    const full = "abc\ndef";
    expect(snapshotWindow(full, 99, 10)).toMatchObject({ offset: 7, text: "", truncated: false, nextOffset: null });
    expect(snapshotWindow(full, -5, 10).offset).toBe(0);
  });

  test("a single line longer than the window is cut inside, never between a surrogate pair", () => {
    const full = `${"a".repeat(9)}\u{1F600}${"b".repeat(20)}\nshort`;
    const w = snapshotWindow(full, 0, 10);
    expect(w.text).toBe("a".repeat(9));
    expect(w.nextOffset).toBe(9);
    const next = snapshotWindow(full, 9, 10);
    expect(next.offset).toBe(9);
    expect(next.text.startsWith("\u{1F600}")).toBe(true);
    // Paging through the long line always advances and ends with the whole text.
    const parts: string[] = [];
    let at: number | null = 0;
    for (let i = 0; at !== null && i < 20; i++) {
      const win = snapshotWindow(full, at, 10);
      parts.push(win.text);
      at = win.nextOffset;
    }
    expect(at).toBeNull();
    expect(parts.join("")).toBe(full);
  });
});

describe("page_snapshot tool", () => {
  let unit: UnitServer | undefined;
  afterEach(async () => {
    await unit?.close();
    unit = undefined;
  });

  test("a large tree is paged at the output cap: never cut by it, no file written, the payload unchanged", async () => {
    const saved: string[] = [];
    unit = await startUnitServer({
      server: {
        maxOutputChars: 5000,
        saveOutput: (_d, name) => {
          saved.push(name);
          return "/unused";
        },
      },
    });
    const full = tree(400);
    unit.bridge.responder = () => ({ tabId: 9, text: full });
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const res = await unit.call("page_snapshot", offset ? { offset } : {});
      expect(res.isError).toBeFalsy();
      const [metaText, body] = texts(res);
      expect(metaText.length + body.length).toBeLessThanOrEqual(5000);
      expect(body).not.toContain("[output truncated");
      const meta = JSON.parse(metaText);
      expect(meta).toMatchObject({ tabId: 9, offset, totalLength: full.length });
      parts.push(body);
      offset = meta.nextOffset;
    }
    expect(parts.join("")).toBe(full);
    expect(saved).toEqual([]);
    for (const c of unit.bridge.callsOf("page_snapshot")) expect(c.payload).toEqual({ compact: true });
  });

  test("maxChars picks a smaller window; one above the cap is limited and says so", async () => {
    unit = await startUnitServer({ server: { maxOutputChars: 3000 } });
    const full = tree(100);
    unit.bridge.responder = () => ({ tabId: 1, text: full });
    const small = await unit.call("page_snapshot", { maxChars: 500, compact: false });
    const smallMeta = JSON.parse(texts(small)[0]);
    expect(smallMeta.length).toBeLessThanOrEqual(500);
    expect(smallMeta.truncated).toBe(true);
    expect(texts(small)[1].endsWith("\n")).toBe(true);
    expect(unit.bridge.calls[0].payload).toEqual({ compact: false });
    const big = await unit.call("page_snapshot", { maxChars: 100000 });
    const bigMeta = JSON.parse(texts(big)[0]);
    expect(bigMeta.note).toBe(`window limited to ${3000 - 256} chars by the output cap`);
    expect(bigMeta.length).toBeLessThanOrEqual(3000 - 256);
  });

  test("the input schema offers offset/maxChars, and a result without text passes through", async () => {
    unit = await startUnitServer();
    const { tools } = await unit.client.listTools();
    const props = Object.keys((tools.find((t) => t.name === "page_snapshot")!.inputSchema as any).properties).sort();
    expect(props).toEqual(["compact", "maxChars", "offset", "tabId"]);
    unit.bridge.responder = () => ({ error: "no page" });
    expect(JSON.parse(texts(await unit.call("page_snapshot", {}))[0])).toEqual({ error: "no page" });
  });
});
