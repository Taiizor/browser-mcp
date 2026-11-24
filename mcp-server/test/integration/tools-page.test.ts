// Page tools end to end: MCP client -> createServer -> ExtensionBridge ->
// background.js -> content.js in a happy-dom page.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolError } from "../helpers/ext-assert.js";
import { ExtHarness } from "../helpers/ext-harness.js";

const T = 20_000;

let h: ExtHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const paragraphs = (n: number, words = 6) =>
  Array.from({ length: n }, (_, i) => `<p>Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(words)}</p>`).join("");

describe("page_text / page_html paging", () => {
  test("offset/maxChars windows reassemble the whole text; nextOffset is null at the end", async () => {
    h = await ExtHarness.create({ html: `<h1>Title</h1>${paragraphs(40)}` });
    const full = (await h.page!.command("page_text", { maxChars: 500_000 })).result.text as string;
    expect(full.length).toBeGreaterThan(2_000);
    const m = await h.mcp();
    const parts: string[] = [];
    let offset = 0;
    for (let i = 0; i < 100; i++) {
      const r = await m.call("page_text", { offset, maxChars: 500 });
      expect(r.isError).toBe(false);
      expect(r.texts).toHaveLength(2);
      const meta = r.json(0);
      expect(meta).toMatchObject({ tabId: 1, offset, totalLength: full.length });
      expect(r.texts[1]).toHaveLength(meta.length);
      parts.push(r.texts[1]);
      if (meta.nextOffset === null) {
        expect(meta.truncated).toBe(false);
        break;
      }
      expect(meta).toMatchObject({ truncated: true, length: 500, nextOffset: offset + 500 });
      offset = meta.nextOffset;
    }
    expect(parts.join("")).toBe(full);
    expect(h.inbound((f) => f.action === "page_text").at(-1).payload).toEqual({ offset, maxChars: 500 });
  }, T);

  test("the default window fits the output cap without being cut", async () => {
    h = await ExtHarness.create({ html: paragraphs(1200) });
    const m = await h.mcp();
    const r = await m.call("page_text", {});
    const meta = r.json(0);
    expect(meta.totalLength).toBeGreaterThan(40_000);
    expect(meta.truncated).toBe(true);
    expect(meta.nextOffset).toBe(meta.length);
    expect(r.texts.join("").length).toBeLessThanOrEqual(40_000);
    expect(r.text).not.toContain("[output truncated");
    expect(h.inbound((f) => f.action === "page_text").at(-1).payload.maxChars).toBeLessThanOrEqual(40_000);

    const html = await m.call("page_html", { maxChars: 30 });
    expect(html.json(0)).toMatchObject({ offset: 0, length: 30, truncated: true, nextOffset: 30 });
    expect(html.texts[1]).toHaveLength(30);
  }, T);
});

describe("dom_query", () => {
  test("limit and the {total, returned, items} shape; refs work as selectors", async () => {
    h = await ExtHarness.create({ html: `<ul>${Array.from({ length: 30 }, (_, i) => `<li class="row">Row ${i}</li>`).join("")}</ul>` });
    const m = await h.mcp();
    const r = (await m.call("dom_query", { selector: "li.row", limit: 3 })).json();
    expect(r).toMatchObject({ tabId: 1, total: 30, returned: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toMatchObject({ tag: "li", text: "Row 0" });
    expect(Object.keys(r.items[0]).sort()).toEqual(["h", "ref", "tag", "text", "w", "x", "y"]);
    expect(h.inbound((f) => f.action === "dom_query").at(-1).payload).toMatchObject({ selector: "li.row", limit: 3 });

    expect((await m.call("dom_query", { selector: "li.row" })).json()).toMatchObject({ total: 30, returned: 20 });
    const byRef = (await m.call("dom_query", { selector: r.items[1].ref })).json();
    expect(byRef).toMatchObject({ total: 1, returned: 1 });
    expect(byRef.items[0].text).toBe("Row 1");
    expect(await toolError(m, "dom_query", { selector: "li", limit: 501 })).toMatch(/limit|500|Invalid/i);
  }, T);
});

describe("dom_type", () => {
  const record = (el: any) => {
    const events: string[] = [];
    for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup"]) {
      el.addEventListener(type, (e: any) => events.push([type, e.key ?? "", e.inputType ?? "", e.data ?? ""].join(":")));
    }
    return events;
  };

  test("an input gets real per-character key events; clearFirst deletes with input events", async () => {
    h = await ExtHarness.create({ html: '<input id="name" value="ab">' });
    const m = await h.mcp();
    const input = h.page!.$("#name");
    const events = record(input);

    const r = (await m.call("dom_type", { selector: "#name", text: "Hi" })).json();
    expect(r).toMatchObject({ tabId: 1, ok: true, value: "abHi" });
    expect(input.value).toBe("abHi");
    const perChar = (c: string) => [`keydown:${c}::`, `keypress:${c}::`, `beforeinput::insertText:${c}`, `input::insertText:${c}`, `keyup:${c}::`];
    expect(events).toEqual([...perChar("H"), ...perChar("i")]);

    events.length = 0;
    expect((await m.call("dom_type", { selector: "#name", text: "ok", clearFirst: true })).json().value).toBe("ok");
    expect(input.value).toBe("ok");
    expect(events.slice(0, 4)).toEqual(["keydown:Backspace::", "beforeinput::deleteContentBackward:", "input::deleteContentBackward:", "keyup:Backspace::"]);
    expect(events.slice(4)).toEqual([...perChar("o"), ...perChar("k")]);
    // The budget covers per-character typing (server-side timeout).
    expect(h.inbound((f) => f.action === "dom_type").at(-1).timeoutMs).toBeGreaterThanOrEqual(30_000);
  }, T);

  test("a contenteditable keeps its text unless clearFirst", async () => {
    h = await ExtHarness.create({ html: '<div id="ed" contenteditable="true">Hello</div>' });
    const m = await h.mcp();
    const ed = h.page!.$("#ed");
    const events = record(ed);
    expect((await m.call("dom_type", { selector: "#ed", text: " world" })).isError).toBe(false);
    expect(ed.textContent).toBe("Hello world");
    expect(events.filter((e) => e.startsWith("beforeinput"))).toHaveLength(6);
    expect((await m.call("dom_type", { selector: "#ed", text: "X", clearFirst: true })).isError).toBe(false);
    expect(ed.textContent).toBe("X");
  }, T);
  test("a newline is Shift+Enter with a line break: an Enter-to-send composer does not send; pressEnter sends", async () => {
    h = await ExtHarness.create({ html: '<textarea id="ta"></textarea><div id="ed" contenteditable="true"></div>' });
    const page = h.page!;
    const sent: string[] = [];
    const keys: string[] = [];
    for (const id of ["#ta", "#ed"]) {
      const el = page.$(id);
      // A chat composer: Enter sends, Shift+Enter is a new line.
      el.addEventListener("keydown", (e: any) => {
        if (e.key !== "Enter") return;
        keys.push(`${id}:${e.shiftKey ? "Shift+" : ""}Enter`);
        if (!e.shiftKey) {
          e.preventDefault();
          sent.push(id);
        }
      });
    }
    const ta = page.$("#ta");
    const events = record(ta);
    const m = await h.mcp();

    const r = (await m.call("dom_type", { selector: "#ta", text: "Hello team\nSecond line" })).json();
    expect(sent).toEqual([]);
    expect(keys).toEqual(["#ta:Shift+Enter"]);
    expect(ta.value).toBe("Hello team\nSecond line");
    expect(r).toMatchObject({ ok: true, value: "Hello team\nSecond line" });
    expect(r.warning).toBeUndefined();
    expect(events.filter((e) => e.includes("Enter") || e.includes("LineBreak"))).toEqual([
      "keydown:Enter::",
      "keypress:Enter::",
      "beforeinput::insertLineBreak:",
      "input::insertLineBreak:",
      "keyup:Enter::",
    ]);

    const ed = page.$("#ed");
    const edEvents = record(ed);
    expect((await m.call("dom_type", { selector: "#ed", text: "Line one\nLine two" })).isError).toBe(false);
    expect(sent).toEqual([]);
    expect(ed.innerHTML).toBe("Line one<br>Line two");
    expect(edEvents.filter((e) => e.startsWith("beforeinput") && e.includes("LineBreak"))).toEqual(["beforeinput::insertLineBreak:"]);

    // pressEnter: one plain Enter after the text, the key that sends.
    const sentBy = (await m.call("dom_type", { selector: "#ta", text: "!", pressEnter: true })).json();
    expect(sent).toEqual(["#ta"]);
    expect(sentBy.enter).toMatchObject({ defaultPrevented: true });
    expect(ta.value).toBe("Hello team\nSecond line!");
  }, T);

  test("no timer paces the default path; in a hidden tab delayMs pauses are skipped with a warning", async () => {
    h = await ExtHarness.create({ html: '<textarea id="ta"></textarea>' });
    const page = h.page!;
    const win = page.window as any;
    // A hidden or occluded tab: the browser holds every timer back for a second or more.
    const realSetTimeout = win.setTimeout.bind(win);
    let timers = 0;
    win.setTimeout = (fn: () => void, ms?: number, ...args: unknown[]) => {
      timers++;
      return realSetTimeout(fn, Math.max(1000, Number(ms) || 0), ...args);
    };
    let visibility = "hidden";
    Object.defineProperty(page.document, "visibilityState", { get: () => visibility, configurable: true });
    const ta = page.$("#ta");
    const m = await h.mcp();

    // 400 characters: 7 task yields, none of them a timer.
    const text = "abcdefghij".repeat(40);
    const t0 = Date.now();
    const r = (await m.call("dom_type", { selector: "#ta", text })).json();
    // (With timers this would take 7 s and more.)
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ta.value).toBe(text);
    expect(r).toMatchObject({ ok: true, valueLength: 400 });
    expect(r.warning).toBeUndefined();
    expect(timers).toBe(0);

    // delayMs in the hidden tab: typed in full without the (throttled) pauses.
    const slow = (await m.call("dom_type", { selector: "#ta", text: "xyz", delayMs: 50, clearFirst: true })).json();
    expect(ta.value).toBe("xyz");
    expect(slow.warning).toMatch(/tab was hidden.*throttles timers: 2 delayMs pauses were skipped/);
    expect(timers).toBe(0);

    // Visible again: the pauses are timers, as asked (which also shows that
    // content.js's timers go through the patched setTimeout above).
    visibility = "visible";
    win.setTimeout = (fn: () => void, ms?: number, ...args: unknown[]) => {
      timers++;
      return realSetTimeout(fn, ms, ...args);
    };
    const paced = (await m.call("dom_type", { selector: "#ta", text: "12", delayMs: 5 })).json();
    expect(ta.value).toBe("xyz12");
    expect(paced.warning).toBeUndefined();
    expect(timers).toBe(1);
  }, T);

  test("appending to a contenteditable goes after a trailing non-editable chip", async () => {
    h = await ExtHarness.create({
      html:
        '<div id="a" contenteditable="true"><p>Hello <span contenteditable="false">@John</span></p></div>' +
        '<div id="b" contenteditable="true"><p>Ping <span contenteditable="false">@Ann</span> </p></div>' +
        '<div id="c" contenteditable="true"><p>Hi <span contenteditable="false">@Bo</span><br></p></div>' +
        '<div id="d" contenteditable="true"><p>Plain <b>text</b></p>\n</div>',
    });
    const page = h.page!;
    const m = await h.mcp();
    const type = async (selector: string, text: string) => expect((await m.call("dom_type", { selector, text })).isError).toBe(false);

    await type("#a", " please");
    expect(page.$("#a").innerHTML).toBe('<p>Hello <span contenteditable="false">@John</span> please</p>');
    // The space a mention editor puts after the chip is part of the end.
    await type("#b", "please");
    expect(page.$("#b").innerHTML).toBe('<p>Ping <span contenteditable="false">@Ann</span> please</p>');
    // A trailing <br> (ProseMirror) is not content: the text goes before it, after the chip.
    await type("#c", " ok");
    expect(page.$("#c").innerHTML).toBe('<p>Hi <span contenteditable="false">@Bo</span> ok<br></p>');
    // Formatting whitespace outside the last block is not the end either.
    await type("#d", "!");
    expect(page.$("#d").innerHTML).toBe("<p>Plain <b>text!</b></p>\n");
  }, T);
});

describe("page_snapshot", () => {
  test("live state is reported; a password's live value never is", async () => {
    h = await ExtHarness.create({
      html:
        '<input id="user" value="initial"><input id="pw" type="password"><input id="pw2" type="password">' +
        '<input type="checkbox" id="cb"><select id="sel"><option>One</option><option selected>Two</option></select>' +
        '<button disabled>Off</button><div role="button" aria-expanded="true">Menu</div><textarea id="ta">start</textarea>' +
        '<div contenteditable="true">Edit me</div><iframe src="https://frame.example/x" title="F"></iframe>',
    });
    const page = h.page!;
    page.$("#user").value = "typed by user";
    page.$("#pw").value = "hunter2-live-secret";
    page.$("#cb").checked = true;
    page.$("#ta").value = "edited";
    const m = await h.mcp();
    for (const compact of [true, false]) {
      // Two blocks: the window metadata, then the tree text.
      const r = await m.call("page_snapshot", { compact });
      expect(r.json(0)).toMatchObject({ tabId: 1, offset: 0, truncated: false, nextOffset: null });
      const text = r.texts[1];
      const line = (needle: string) => text.split("\n").find((l) => l.includes(needle)) ?? "";
      expect(text).not.toContain("hunter2-live-secret");
      expect(line('id="user"')).toContain('value="initial" current="typed by user"');
      expect(line('id="pw"')).toContain("filled=true");
      expect(line('id="pw2"')).toContain("filled=false");
      expect(line('id="cb"')).toContain("checked");
      expect(line('id="sel"')).toContain('selected="Two"');
      expect(line('"Off"')).toContain("disabled");
      expect(line('"Menu"')).toContain("expanded=true");
      expect(line('id="ta"')).toContain('value="edited"');
      expect(line("Edit me")).toContain("contenteditable");
      expect(line("<iframe>")).toContain("(frame)");
      expect(text.split("\n")[0]).toContain("frames=1");
    }
  }, T);
  test("text the page does not render stays out of snapshot and dom_query text", async () => {
    h = await ExtHarness.create({
      html:
        '<form id="login"><label>User <input name="u"></label><div class="err" style="display:none">Wrong password</div>' +
        '<button id="sv">Save<span style="display:none">Saving now please wait</span></button>' +
        '<span style="visibility:hidden">secret<b style="visibility:visible">shown</b></span>' +
        '<details><summary>More</summary><p>Folded text</p></details>' +
        '<a id="docs" href="/docs">Docs<span hidden>attr-hidden</span></a></form>' +
        '<style>.mobile { display: none }</style><h2 id="title">Desktop title<span class="mobile">Mobile title</span></h2>' +
        '<div style="display:none"><button id="inner">Inner label</button></div>',
    });
    const m = await h.mcp();
    const HIDDEN = ["Saving now", "Wrong password", "secret", "Folded text", "attr-hidden", "Mobile title"];
    for (const compact of [true, false]) {
      const text = (await m.call("page_snapshot", { compact })).texts[1];
      const line = (needle: string) => text.split("\n").find((l) => l.includes(needle)) ?? "";
      // Compact lists none of the hidden elements; full mode lists them on lines of their own.
      for (const hidden of HIDDEN) {
        if (compact) expect(text).not.toContain(hidden);
        else for (const l of text.split("\n").filter((x) => x.includes(hidden))) expect(l).toMatch(/^\[ref=e\d+\] <(span|div|p)> "/);
      }
      expect(line('id="sv"')).toContain('"Save"');
      expect(line('id="docs"')).toContain('"Docs"');
      expect(line('id="title"')).toContain('"Desktop title"');
      // A visibility:visible child of a visibility:hidden parent is rendered; a closed <details> shows its summary.
      expect(line('id="login"')).toContain("shown");
      expect(line('id="login"')).toContain("More");
      // An element that is itself not rendered still reports its own text (marked hidden).
      expect(line('id="inner"')).toContain('"Inner label"');
    }
    const q = (await m.call("dom_query", { selector: "#sv, #title" })).json();
    expect(q.items.map((i: any) => i.text)).toEqual(["Save", "Desktop title"]);
  }, T);

  test("a select lists its option labels (at most 15)", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `<option value="v${i}">A${i}</option>`).join("");
    h = await ExtHarness.create({
      html:
        '<select id="c" name="color"><option>Red</option><option selected>Green</option><option value="b"> Blue </option></select>' +
        `<select id="many">${many}</select>`,
    });
    const m = await h.mcp();
    const text = (await m.call("page_snapshot", {})).texts[1];
    const line = (needle: string) => text.split("\n").find((l) => l.includes(needle)) ?? "";
    expect(line('id="c"')).toContain('selected="Green" options="Red | Green | Blue"');
    expect(line('id="c"')).not.toContain("more)");
    const first15 = Array.from({ length: 15 }, (_, i) => `A${i}`).join(" | ");
    expect(line('id="many"')).toContain(`options="${first15}" (+5 more)`);
  }, T);
});

describe("dom_upload guard", () => {
  test("refused paths never reach the extension", async () => {
    h = await ExtHarness.create({ html: '<input id="f" type="file">' });
    const m = await h.mcp();
    const pem = h.tempPath("server.pem");
    fs.writeFileSync(pem, "-----BEGIN PRIVATE KEY-----");
    const cases: Array<[string, RegExp]> = [
      [path.join(os.homedir(), ".ssh", "id_rsa"), /\[hidden-segment\]/],
      ["relative/file.txt", /\[not-absolute\]/],
      [pem, /\[secret-name\]/],
      [h.tempPath("missing.txt"), /\[not-found\]/],
    ];
    for (const [file, rule] of cases) {
      const err = await toolError(m, "dom_upload", { selector: "#f", filePaths: [file] });
      expect(err).toMatch(/dom_upload refused/);
      expect(err).toMatch(rule);
    }
    expect(h.inbound((f) => f.action === "dom_upload")).toHaveLength(0);
    expect(h.chrome.cdpCalls("DOM.setFileInputFiles")).toHaveLength(0);
  }, T);

  test.skipIf(!!process.env.BROWSER_MCP_UPLOAD_DIRS)("a regular file in the temp folder is sent as its canonical path", async () => {
    h = await ExtHarness.create({ html: '<input id="f" type="file">' });
    const m = await h.mcp();
    const file = h.tempPath("upload.txt");
    fs.writeFileSync(file, "hello");
    const r = await m.call("dom_upload", { selector: "#f", filePaths: [file] });
    expect(r.isError).toBe(false);
    expect(h.chrome.cdpCalls("DOM.setFileInputFiles").at(-1)?.params.files).toEqual([fs.realpathSync.native(file)]);
  }, T);
});

describe("live-browser regressions", () => {
  test("a multi-line live value stays on its snapshot line", async () => {
    h = await ExtHarness.create({ html: '<textarea id="ta"></textarea><button id="b">Go</button>' });
    h.page!.$("#ta").value = "first\nsecond\r\nthird";
    const m = await h.mcp();
    const text = (await m.call("page_snapshot", {})).texts[1];
    const line = text.split("\n").find((l) => l.includes('id="ta"')) ?? "";
    expect(line).toContain('value="first\\nsecond\\nthird"');
    expect(text).not.toMatch(/^(second|third)/m);
  }, T);

  test("a viewport screenshot that fails twice falls back to the debugger", async () => {
    h = await ExtHarness.create();
    let captures = 0;
    h.chrome.api.tabs.captureVisibleTab = async () => {
      captures++;
      throw new Error("Failed to capture tab: image readback failed");
    };
    h.chrome.cdpHandler = (c) => (c.method === "Page.captureScreenshot" ? { data: "iVBORw0KGgo=" } : undefined);
    const m = await h.mcp();
    const r = await m.call("page_screenshot", {});
    expect(r.isError).toBe(false);
    expect(captures).toBe(2);
    expect(r.raw.content[0]).toMatchObject({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(h.chrome.cdpCalls("Page.captureScreenshot", 1).length).toBe(1);
  }, T);

  test("a page with another extension's frame gets an actionable debugger error", async () => {
    h = await ExtHarness.create();
    h.chrome.api.debugger.attach = async () => {
      throw new Error("Cannot access a chrome-extension:// URL of different extension");
    };
    const m = await h.mcp({ toolsets: ["power"] });
    const err = await toolError(m, "js_evaluate", { expression: "1" });
    expect(err).toContain("frame of another extension");
    expect(err).toContain("URL of different extension");
  }, T);
});
