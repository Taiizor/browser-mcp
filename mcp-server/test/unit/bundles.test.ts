// Re-importable bundles: session_state_save / cookies_export are never cut by
// the output cap (too large inline = an error that asks for savePath), write
// the complete bundle with savePath, and session_state_load / cookies_import
// read it back with filePath.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { INPUT_FILE_MAX_BYTES, readJsonInputFile } from "../../src/tool-kit.js";
import { cookiesFromFile } from "../../src/tools/cookies.js";
import { stateFromFile } from "../../src/tools/sessions.js";
import { firstJson, startUnitServer, texts, type UnitServer } from "../helpers/unit-mcp.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/unit-temp.js";

afterAll(cleanupTempDirs);

let unit: UnitServer | undefined;
afterEach(async () => {
  await unit?.close();
  unit = undefined;
});

const cookie = (i: number) => ({
  name: `c${i}`,
  value: `value-${i}-${"v".repeat(40)}`,
  domain: ".shop.test",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  hostOnly: false,
  session: false,
  storeId: "0",
  expirationDate: 1_900_000_000,
});

function savedState(cookies: number) {
  return {
    url: "https://shop.test/cart",
    origin: "https://shop.test",
    domain: "shop.test",
    savedAt: 1_700_000_000_000,
    cookies: Array.from({ length: cookies }, (_, i) => cookie(i)),
    localStorage: { token: "secret-token", prefs: "{}" },
    sessionStorage: { step: "2" },
  };
}

async function server(maxOutputChars = 4000) {
  const saved: string[] = [];
  unit = await startUnitServer({
    server: {
      toolsets: ["all"],
      maxOutputChars,
      saveOutput: (_d, name) => {
        saved.push(name);
        return "/must/not/be/used";
      },
    },
  });
  return { unit, saved };
}

describe("session_state_save / session_state_load", () => {
  test("a small bundle is returned inline as before", async () => {
    const { unit: u } = await server();
    const state = savedState(2);
    u.bridge.responder = () => ({ ok: true, state });
    expect(firstJson(await u.call("session_state_save", {}))).toEqual({ ok: true, state });
  });

  test("a bundle over the cap is refused, never cut and never spilled", async () => {
    const { unit: u, saved } = await server(2000);
    u.bridge.responder = () => ({ ok: true, state: savedState(40) });
    const res = await u.call("session_state_save", {});
    expect(res.isError).toBe(true);
    const [msg] = texts(res);
    expect(msg).toStartWith("session_state_save: the bundle has ");
    expect(msg).toContain("more than the 2000-char output cap");
    expect(msg).toContain("savePath");
    expect(msg).toContain('session_state_load {"filePath": ...}');
    expect(msg).not.toContain("secret-token");
    expect(saved).toEqual([]);
  });

  test("savePath writes the complete bundle and returns a summary without values; filePath restores it", async () => {
    const { unit: u, saved } = await server(2000);
    const state = savedState(40);
    u.bridge.responder = (cmd) => (cmd.action === "session_state_save" ? { ok: true, state } : { ok: true, restored: true });
    const dir = makeTempDir("bundle");
    const file = path.join(dir, "nested", "shop-state.json");
    const res = await u.call("session_state_save", { savePath: file, tabId: 4 });
    expect(res.isError).toBeFalsy();
    const body = firstJson(res);
    expect(body).toMatchObject({ ok: true, savedTo: file, cookies: 40, localStorageKeys: 2, sessionStorageKeys: 1, origin: "https://shop.test" });
    expect(texts(res).join("")).not.toContain("secret-token");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(state);
    expect(body.sizeBytes).toBe(fs.statSync(file).size);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(u.bridge.callsOf("session_state_save")[0].tabId).toBe(4);

    // An existing file is only replaced with overwrite:true (checked before the extension is asked).
    const again = await u.call("session_state_save", { savePath: file });
    expect(again.isError).toBe(true);
    expect(texts(again)[0]).toContain("File already exists");
    expect(u.bridge.callsOf("session_state_save")).toHaveLength(1);
    expect((await u.call("session_state_save", { savePath: file, overwrite: true })).isError).toBeFalsy();

    const load = await u.call("session_state_load", { filePath: file, tabId: 4 });
    expect(load.isError).toBeFalsy();
    const sent = u.bridge.callsOf("session_state_load")[0];
    expect(sent.payload).toEqual({ state });
    expect(sent.tabId).toBe(4);
    expect(saved).toEqual([]);
  });

  test("session_state_load takes exactly one of state / filePath; bad files are refused before the extension is asked", async () => {
    const { unit: u } = await server();
    const dir = makeTempDir("bundle");
    const wrapped = path.join(dir, "wrapped.json");
    fs.writeFileSync(wrapped, JSON.stringify({ ok: true, state: savedState(1) }));
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "needs exactly one of state"],
      [{ state: { url: "https://a.test" }, filePath: wrapped }, "needs exactly one of state"],
      [{ filePath: "relative/state.json" }, "filePath must be an absolute path"],
      [{ filePath: path.join(dir, "state.txt") }, "must name a .json file"],
      [{ filePath: path.join(dir, ".hidden", "state.json") }, 'dot-segment ".hidden"'],
      [{ filePath: path.join(dir, "credentials.json") }, "key/credential file name"],
      [{ filePath: path.join(dir, "missing.json") }, "cannot open"],
    ];
    for (const [args, message] of cases) {
      const res = await u.call("session_state_load", args);
      expect({ args, isError: res.isError, has: texts(res)[0].includes(message) }).toEqual({ args, isError: true, has: true });
    }
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, '{"cookies": [ secret-not-json');
    const badRes = await u.call("session_state_load", { filePath: bad });
    expect(texts(badRes)[0]).toContain("is not valid JSON");
    expect(texts(badRes)[0]).not.toContain("secret-not-json");
    expect(u.bridge.callsOf("session_state_load")).toEqual([]);

    // The inline result {ok, state} pasted to a file is accepted too.
    expect((await u.call("session_state_load", { filePath: wrapped })).isError).toBeFalsy();
    expect(u.bridge.callsOf("session_state_load")[0].payload).toEqual({ state: savedState(1) });
  });

  test("stateFromFile accepts the bundle or the {ok, state} wrapper and refuses anything else", () => {
    const s = savedState(1);
    expect(stateFromFile(s, "filePath")).toBe(s);
    expect(stateFromFile({ ok: true, state: s }, "filePath")).toBe(s);
    expect(() => stateFromFile([s], "filePath")).toThrow("must hold a session state object");
    expect(() => stateFromFile("x", "filePath")).toThrow("must hold a session state object");
  });
});

describe("cookies_export / cookies_import", () => {
  test("an export over the cap is refused (never cut, never spilled); savePath writes it whole; filePath imports it", async () => {
    const { unit: u, saved } = await server(2000);
    const cookies = Array.from({ length: 50 }, (_, i) => cookie(i));
    u.bridge.responder = (cmd) => (cmd.action === "cookies_export" ? { count: cookies.length, cookies } : { ok: true, imported: 50 });
    const refused = await u.call("cookies_export", { domain: "shop.test" });
    expect(refused.isError).toBe(true);
    expect(texts(refused)[0]).toContain('cookies_import {"filePath": ...}');
    expect(texts(refused)[0]).not.toContain("value-0");

    const dir = makeTempDir("bundle");
    const file = path.join(dir, "cookies.json");
    const res = await u.call("cookies_export", { domain: "shop.test", savePath: file });
    expect(firstJson(res)).toMatchObject({ ok: true, savedTo: file, count: 50 });
    expect(texts(res).join("")).not.toContain("value-0");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ count: 50, cookies });
    expect(u.bridge.callsOf("cookies_export").map((c) => c.payload)).toEqual([
      { domain: "shop.test", url: undefined },
      { domain: "shop.test", url: undefined },
    ]);

    const imp = await u.call("cookies_import", { filePath: file });
    expect(imp.isError).toBeFalsy();
    const sent = u.bridge.callsOf("cookies_import")[0].payload as { cookies: Array<Record<string, unknown>> };
    expect(sent.cookies).toHaveLength(50);
    // Same shape as the inline parameter: fields the schema does not know are dropped.
    expect(sent.cookies[0]).toEqual({
      name: "c0",
      value: cookies[0].value,
      domain: ".shop.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      hostOnly: false,
      expirationDate: 1_900_000_000,
    });
    expect(saved).toEqual([]);
  });

  test("a small export is still returned inline; cookies_import takes exactly one source", async () => {
    const { unit: u } = await server();
    u.bridge.responder = () => ({ count: 1, cookies: [cookie(1)] });
    expect(firstJson(await u.call("cookies_export", {}))).toEqual({ count: 1, cookies: [cookie(1)] });
    for (const args of [{}, { cookies: [], filePath: "/x.json" }]) {
      const res = await u.call("cookies_import", args);
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toContain("needs exactly one of cookies");
    }
  });

  test("cookiesFromFile: export object or bare array, invalid entries named without their values", () => {
    expect(cookiesFromFile([{ name: "a", value: "1" }], "filePath")).toEqual([{ name: "a", value: "1" }]);
    expect(cookiesFromFile({ count: 1, cookies: [{ name: "a", value: "1" }] }, "filePath")).toHaveLength(1);
    expect(() => cookiesFromFile({ nope: 1 }, "filePath")).toThrow("must hold a cookie array");
    let err = "";
    try {
      cookiesFromFile([{ name: "a", value: "1" }, { name: "b", value: 42, secretField: "do-not-echo" }], "filePath");
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toBe("filePath: cookie 1 is invalid (value: invalid_type)");
  });
});

describe("readJsonInputFile", () => {
  test("size limit, regular files only, BOM, and the resolved path is checked too", () => {
    const dir = makeTempDir("bundle");
    const ok = path.join(dir, "ok.json");
    fs.writeFileSync(ok, "\ufeff" + JSON.stringify({ a: 1 }));
    expect(readJsonInputFile(ok, "filePath")).toEqual({ a: 1 });
    expect(() => readJsonInputFile(ok, "filePath", 3)).toThrow("over the 3-byte limit");
    fs.mkdirSync(path.join(dir, "dir.json"));
    expect(() => readJsonInputFile(path.join(dir, "dir.json"), "filePath")).toThrow("is not a regular file");
    expect(INPUT_FILE_MAX_BYTES).toBe(64 * 1024 * 1024);

    // A directory link whose target is a dot-directory.
    const hidden = path.join(dir, ".secret");
    fs.mkdirSync(hidden);
    fs.writeFileSync(path.join(hidden, "s.json"), "{}");
    let linked = true;
    try {
      fs.symlinkSync(hidden, path.join(dir, "plain"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false;
    }
    if (linked) expect(() => readJsonInputFile(path.join(dir, "plain", "s.json"), "filePath")).toThrow('dot-segment ".secret"');
  });
});
