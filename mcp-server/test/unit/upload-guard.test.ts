// dom_upload path guard (src/upload-guard.ts): every rule with an injected
// file system in POSIX and Windows flavours, root resolution from
// BROWSER_MCP_UPLOAD_DIRS and the defaults, and one pass over a real temp dir.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkUploadPaths,
  hiddenSegment,
  isInsideRoot,
  isNetworkPath,
  isStrictAbsolute,
  resolveUploadRoots,
  secretNameRule,
  SPILL_DIR_PREFIX,
  spillSegment,
  UPLOAD_DIRS_ENV,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  type UploadGuardOptions,
  UploadRefusedError,
  type UploadRule,
  uploadGuardOptions,
} from "../../src/upload-guard.js";
import { currentSpillDir, removeSpillDir, spillToPrivateTemp } from "../../src/tool-kit.js";
import { guardCdpFileParams } from "../../src/tools/power.js";
import { FakeBridge } from "../helpers/unit-fake-bridge.js";
import { startUnitServer, texts } from "../helpers/unit-mcp.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/unit-temp.js";

afterAll(cleanupTempDirs);

type Entry = { file: number } | { dir: true } | { link: string };

/**
 * In-memory file system for one platform flavour. Paths are looked up after
 * normalising (case-insensitively for win32); links resolve to their target.
 * Every probe is recorded, so tests can assert a path was never touched.
 */
function fakeFs(platform: "linux" | "win32", entries: Record<string, Entry>) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const key = (p: string) => {
    const n = api.normalize(p).replace(/[\\/]+$/, "") || api.sep;
    return platform === "win32" ? n.toLowerCase() : n;
  };
  const table = new Map<string, { canonical: string; entry: Entry }>();
  for (const [p, entry] of Object.entries(entries)) table.set(key(p), { canonical: api.normalize(p), entry });
  const probes: string[] = [];
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const realpath = (p: string, depth = 0): string => {
    probes.push(p);
    const hit = table.get(key(p));
    if (!hit) {
      // A path below a linked directory resolves through the link.
      for (const [k, v] of table) {
        if ("link" in v.entry && key(p).startsWith(k + (platform === "win32" ? "\\" : "/")) && depth < 8) {
          return realpath(api.join(v.entry.link, p.slice(k.length + 1)), depth + 1);
        }
      }
      throw enoent(p);
    }
    if ("link" in hit.entry) return realpath(hit.entry.link, depth + 1);
    return hit.canonical;
  };
  const stat = (p: string) => {
    probes.push(p);
    const hit = table.get(key(p));
    if (!hit || "link" in hit.entry) throw enoent(p);
    const e = hit.entry;
    return { isFile: () => "file" in e, size: "file" in e ? e.file : 0 };
  };
  return { fs: { realpath: (p: string) => realpath(p), stat }, probes };
}

const POSIX_TREE: Record<string, Entry> = {
  "/": { dir: true },
  "/tmp": { dir: true },
  "/tmp/ok.txt": { file: 10 },
  "/tmp/limit.bin": { file: UPLOAD_MAX_BYTES },
  "/tmp/big.bin": { file: UPLOAD_MAX_BYTES + 1 },
  "/tmp/folder": { dir: true },
  "/tmp/innocent.txt": { link: "/home/u/keys/server.pem" },
  "/tmp/escape.txt": { link: "/home/u/private/notes.txt" },
  "/tmp/sshlink": { link: "/home/u/.ssh" },
  "/home": { dir: true },
  "/home/u": { dir: true },
  "/home/u/Downloads": { dir: true },
  "/home/u/Downloads/report.pdf": { file: 2048 },
  "/home/u/docs": { dir: true },
  "/home/u/docs/cv.pdf": { file: 100 },
  "/home/u/keys/server.pem": { file: 1 },
  "/home/u/private/notes.txt": { file: 1 },
  "/home/u/.ssh/id_ed25519": { file: 1 },
  "/home/u/.ssh/config": { file: 1 },
  "/work/project": { dir: true },
  "/work/project/data.csv": { file: 5 },
  "/srv/shared": { dir: true },
  "/srv/shared/a.txt": { file: 5 },
  "/tmp/browser-mcp-spill-77-AbCdEf": { dir: true },
  "/tmp/browser-mcp-spill-77-AbCdEf/page_text-output.txt": { file: 5 },
  "/tmp/report-link.txt": { link: "/tmp/browser-mcp-spill-77-AbCdEf/page_text-output.txt" },
};

function posix(env: Record<string, string> = {}, over: Partial<UploadGuardOptions> = {}) {
  const f = fakeFs("linux", POSIX_TREE);
  const opts: UploadGuardOptions = { env, cwd: "/work/project", homedir: "/home/u", tmpdir: "/tmp", platform: "linux", fs: f.fs, ...over };
  return { opts, probes: f.probes };
}

const WIN_TEMP = "C:\\Users\\U\\AppData\\Local\\Temp";
const WIN_TREE: Record<string, Entry> = {
  "C:\\": { dir: true },
  "C:\\Users": { dir: true },
  "C:\\Users\\U": { dir: true },
  "C:\\Users\\U\\Downloads": { dir: true },
  "C:\\Users\\U\\Downloads\\Report.pdf": { file: 10 },
  [WIN_TEMP]: { dir: true },
  [`${WIN_TEMP}\\ok.txt`]: { file: 10 },
  [`${WIN_TEMP}\\to-aws.txt`]: { link: "C:\\Users\\U\\.aws\\credentials" },
  "C:\\Users\\U\\.aws\\credentials": { file: 1 },
  "C:\\work\\project": { dir: true },
  "C:\\work\\project\\data.csv": { file: 5 },
  "D:\\My Files": { dir: true },
  "D:\\My Files\\a.txt": { file: 5 },
  "\\\\server\\share": { dir: true },
  "\\\\server\\share\\f.txt": { file: 5 },
};

function win(env: Record<string, string> = {}, over: Partial<UploadGuardOptions> = {}) {
  const f = fakeFs("win32", WIN_TREE);
  const opts: UploadGuardOptions = { env, cwd: "C:\\work\\project", homedir: "C:\\Users\\U", tmpdir: WIN_TEMP, platform: "win32", fs: f.fs, ...over };
  return { opts, probes: f.probes };
}

/** The rule checkUploadPaths refuses `paths` with (null: accepted). */
function ruleOf(paths: string[], opts: UploadGuardOptions): UploadRule | null {
  try {
    checkUploadPaths(paths, opts);
    return null;
  } catch (e) {
    if (!(e instanceof UploadRefusedError)) throw e;
    expect(e.message).toStartWith("dom_upload refused ");
    expect(e.message).toContain(`[${e.rule}]: `);
    return e.rule;
  }
}

function refusal(paths: string[], opts: UploadGuardOptions): UploadRefusedError {
  try {
    checkUploadPaths(paths, opts);
  } catch (e) {
    if (e instanceof UploadRefusedError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("lexical helpers", () => {
  test("isStrictAbsolute", () => {
    expect(isStrictAbsolute("/tmp/a", "linux")).toBe(true);
    expect(isStrictAbsolute("tmp/a", "linux")).toBe(false);
    expect(isStrictAbsolute("C:\\a", "linux")).toBe(false);
    expect(isStrictAbsolute("C:\\a", "win32")).toBe(true);
    expect(isStrictAbsolute("c:/a", "win32")).toBe(true);
    expect(isStrictAbsolute("\\\\srv\\share\\a", "win32")).toBe(true);
    for (const p of ["C:a", "\\a", "/a", "a\\b", "\\\\"]) expect({ p, abs: isStrictAbsolute(p, "win32") }).toEqual({ p, abs: false });
  });

  test("isNetworkPath only on win32", () => {
    for (const p of ["\\\\srv\\share", "//srv/share", "\\\\?\\C:\\a", "\\\\.\\PhysicalDrive0"]) expect(isNetworkPath(p, "win32")).toBe(true);
    expect(isNetworkPath("C:\\a", "win32")).toBe(false);
    expect(isNetworkPath("//srv/share", "linux")).toBe(false);
  });

  test("hiddenSegment finds dot-files, dot-dirs, . and ..", () => {
    expect(hiddenSegment("/home/u/.ssh/id_rsa", "linux")).toBe(".ssh");
    expect(hiddenSegment("/tmp/../etc/passwd", "linux")).toBe("..");
    expect(hiddenSegment("/tmp/./a", "linux")).toBe(".");
    expect(hiddenSegment("/srv/app/.env", "linux")).toBe(".env");
    expect(hiddenSegment("C:\\Users\\U\\.aws/credentials", "win32")).toBe(".aws");
    expect(hiddenSegment("/tmp/a.b/c.txt", "linux")).toBeNull();
    // On POSIX a backslash is part of a name, not a separator.
    expect(hiddenSegment("/tmp/a\\.ssh", "linux")).toBeNull();
  });

  test("secretNameRule matches key and credential names case-insensitively", () => {
    const secret = [
      "id_rsa", "id_rsa.pub", "ID_DSA", "id_ecdsa_sk", "id_ed25519", "server.pem", "TLS.KEY", "cert.p12", "cert.pfx",
      "putty.ppk", "vault.kdbx", "old.kdb", "store.jks", "app.keystore", "credentials", "credentials.json", "Credentials.csv",
      "id_rsa.", "server.pem ",
    ];
    for (const n of secret) expect({ n, rule: secretNameRule(n) !== null }).toEqual({ n, rule: true });
    for (const n of ["report.pdf", "keys.txt", "my_credentials.txt", "monkey.png", "pem.txt", "id.txt"]) {
      expect({ n, rule: secretNameRule(n) }).toEqual({ n, rule: null });
    }
  });

  test("isInsideRoot: segment boundaries, roots, case on win32", () => {
    expect(isInsideRoot("/a/b", "/a/b", "linux")).toBe(true);
    expect(isInsideRoot("/a/b/c", "/a/b/", "linux")).toBe(true);
    expect(isInsideRoot("/a/bc", "/a/b", "linux")).toBe(false);
    expect(isInsideRoot("/a/B/c", "/a/b", "linux")).toBe(false);
    expect(isInsideRoot("/x", "/", "linux")).toBe(true);
    expect(isInsideRoot("C:\\Users\\U\\f", "c:\\users\\u", "win32")).toBe(true);
    expect(isInsideRoot("C:/Users/U/f", "C:\\Users\\U\\", "win32")).toBe(true);
    expect(isInsideRoot("C:\\Users\\Ux\\f", "C:\\Users\\U", "win32")).toBe(false);
    expect(isInsideRoot("D:\\a", "C:\\", "win32")).toBe(false);
    expect(isInsideRoot("C:\\a", "C:\\", "win32")).toBe(true);
  });
});

describe("checkUploadPaths rules (POSIX flavour)", () => {
  test("accepts files inside the default roots and returns canonical paths", () => {
    const { opts } = posix();
    expect(checkUploadPaths(["/tmp/ok.txt", "/home/u/Downloads/report.pdf", "/work/project/data.csv", "/tmp/limit.bin"], opts)).toEqual([
      "/tmp/ok.txt",
      "/home/u/Downloads/report.pdf",
      "/work/project/data.csv",
      "/tmp/limit.bin",
    ]);
    expect(checkUploadPaths(["//tmp//ok.txt"], opts)).toEqual(["/tmp/ok.txt"]);
  });

  test("empty paths, too many files, relative paths", () => {
    const { opts } = posix();
    expect(ruleOf([""], opts)).toBe("empty-path");
    expect(ruleOf(["   "], opts)).toBe("empty-path");
    expect(ruleOf(Array.from({ length: UPLOAD_MAX_FILES + 1 }, () => "/tmp/ok.txt"), opts)).toBe("too-many-files");
    expect(checkUploadPaths(Array.from({ length: UPLOAD_MAX_FILES }, () => "/tmp/ok.txt"), opts)).toHaveLength(UPLOAD_MAX_FILES);
    for (const p of ["tmp/ok.txt", "./ok.txt", "~/Downloads/report.pdf", "C:\\tmp\\ok.txt"]) expect({ p, rule: ruleOf([p], opts) }).toEqual({ p, rule: "not-absolute" });
  });

  test("dot-segments and secret names are refused before the file system is touched", () => {
    const { opts, probes } = posix({ [UPLOAD_DIRS_ENV]: "*" });
    expect(ruleOf(["/home/u/.ssh/config"], opts)).toBe("hidden-segment");
    expect(ruleOf(["/tmp/../home/u/docs/cv.pdf"], opts)).toBe("hidden-segment");
    expect(ruleOf(["/home/u/keys/server.pem"], opts)).toBe("secret-name");
    expect(ruleOf(["/tmp/credentials.json"], opts)).toBe("secret-name");
    expect(probes).toEqual([]);
  });

  test("the resolved path is checked too (symlinks into secrets or out of the roots)", () => {
    const { opts } = posix();
    const viaLink = refusal(["/tmp/innocent.txt"], opts);
    expect(viaLink.rule).toBe("secret-name");
    expect(viaLink.message).toContain('the resolved path "/home/u/keys/server.pem"');
    expect(ruleOf(["/tmp/sshlink/config"], opts)).toBe("hidden-segment");
    const escape = refusal(["/tmp/escape.txt"], opts);
    expect(escape.rule).toBe("outside-roots");
    expect(escape.message).toContain('the resolved path "/home/u/private/notes.txt" is outside the allowed upload folders: /tmp, /home/u/Downloads, /work/project (defaults:');
  });

  test("missing files, folders, oversized files", () => {
    const { opts } = posix();
    expect(ruleOf(["/tmp/missing.txt"], opts)).toBe("not-found");
    expect(ruleOf(["/tmp/folder"], opts)).toBe("not-a-file");
    const big = refusal(["/tmp/big.bin"], opts);
    expect(big.rule).toBe("too-large");
    expect(big.message).toContain(`${UPLOAD_MAX_BYTES + 1} bytes, over the 100 MiB limit`);
    expect(ruleOf(["/tmp/ok.txt"], { ...opts, maxBytes: 9 })).toBe("too-large");
    expect(refusal(["/tmp/ok.txt"], { ...opts, maxBytes: 9 }).message).toContain("over the 9 bytes limit");
    expect(ruleOf(["/tmp/ok.txt"], { ...opts, maxBytes: 10 })).toBeNull();
  });

  test("a stat failure after a successful realpath is reported as not-found", () => {
    const { opts } = posix();
    const denied: UploadGuardOptions = {
      ...opts,
      fs: {
        ...opts.fs,
        stat: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
    };
    const e = refusal(["/tmp/ok.txt"], denied);
    expect(e.rule).toBe("not-found");
    expect(e.message).toContain("cannot read file information (EACCES)");
  });

  test("files outside the roots are refused, with the roots named", () => {
    const { opts } = posix();
    const e = refusal(["/srv/shared/a.txt"], opts);
    expect(e.rule).toBe("outside-roots");
    expect(e.path).toBe("/srv/shared/a.txt");
    expect(e.message).toContain(`set ${UPLOAD_DIRS_ENV} in the MCP client config`);
  });

  test("the first refused path fails the whole call", () => {
    const { opts } = posix();
    expect(ruleOf(["/tmp/ok.txt", "/srv/shared/a.txt", "/tmp/missing.txt"], opts)).toBe("outside-roots");
  });

  test("control characters in a refused path are not echoed", () => {
    const { opts } = posix();
    const e = refusal(["/tmp/a\u0007b\nc.txt"], opts);
    expect(e.message).toContain('"/tmp/a?b?c.txt"');
  });
});

describe("checkUploadPaths rules (Windows flavour)", () => {
  test("accepts drive paths case-insensitively and returns the canonical spelling", () => {
    const { opts } = win();
    expect(checkUploadPaths([`${WIN_TEMP.toUpperCase()}\\OK.TXT`, "c:/users/u/downloads/report.pdf"], opts)).toEqual([
      `${WIN_TEMP}\\ok.txt`,
      "C:\\Users\\U\\Downloads\\Report.pdf",
    ]);
  });

  test("drive-relative and rooted-without-drive paths are not absolute", () => {
    const { opts } = win();
    for (const p of ["C:ok.txt", "\\Users\\U\\ok.txt", "/Users/U/ok.txt", "ok.txt"]) expect({ p, rule: ruleOf([p], opts) }).toEqual({ p, rule: "not-absolute" });
  });

  test("alternate data streams and other ':' forms are refused", () => {
    const { opts, probes } = win();
    expect(ruleOf([`${WIN_TEMP}\\ok.txt:hidden`], opts)).toBe("unsupported-path");
    expect(ruleOf([`${WIN_TEMP}\\ok.txt::$DATA`], opts)).toBe("unsupported-path");
    expect(probes).toEqual([]);
  });

  test("UNC and device paths are refused without touching them, even with '*'", () => {
    const envs: Record<string, string>[] = [{}, { [UPLOAD_DIRS_ENV]: "*" }, { [UPLOAD_DIRS_ENV]: "D:\\My Files" }];
    for (const env of envs) {
      const { opts, probes } = win(env);
      for (const p of ["\\\\server\\share\\f.txt", "//server/share/f.txt", "\\\\?\\C:\\work\\project\\data.csv", "\\\\.\\PhysicalDrive0"]) {
        expect({ p, rule: ruleOf([p], opts) }).toEqual({ p, rule: "network-path" });
      }
      expect(probes.filter((p) => /^[\\/]{2}/.test(p))).toEqual([]);
    }
  });

  test("a share listed explicitly in BROWSER_MCP_UPLOAD_DIRS is allowed", () => {
    const { opts } = win({ [UPLOAD_DIRS_ENV]: "\\\\server\\share" });
    expect(checkUploadPaths(["\\\\server\\share\\f.txt"], opts)).toEqual(["\\\\server\\share\\f.txt"]);
    expect(ruleOf(["\\\\other\\share\\f.txt"], opts)).toBe("network-path");
  });

  test("hidden segments and secret names, also through a link", () => {
    const { opts } = win();
    expect(ruleOf(["C:\\Users\\U\\.aws\\credentials"], opts)).toBe("hidden-segment");
    expect(ruleOf([`${WIN_TEMP}\\ID_RSA`], opts)).toBe("secret-name");
    expect(ruleOf([`${WIN_TEMP}\\id_rsa. `], opts)).toBe("secret-name");
    expect(ruleOf([`${WIN_TEMP}\\to-aws.txt`], opts)).toBe("hidden-segment");
  });
});

describe("upload roots", () => {
  test("defaults: temp, ~/Downloads and the working directory; missing ones are skipped", () => {
    expect(resolveUploadRoots(posix().opts)).toEqual({ any: false, roots: ["/tmp", "/home/u/Downloads", "/work/project"], source: "default", skipped: [] });
    const noDownloads = resolveUploadRoots(posix({}, { homedir: "/home/x", cwd: "/srv/shared" }).opts);
    expect(noDownloads.roots).toEqual(["/tmp", "/srv/shared"]);
    expect(noDownloads.skipped).toEqual(["/home/x/Downloads (does not exist)"]);
  });

  test("a too-broad default root (filesystem root, or one containing home) is skipped", () => {
    const tooBroad = "(a default root may not be a filesystem root or contain the home folder)";
    const fromRoot = resolveUploadRoots(posix({}, { cwd: "/" }).opts);
    expect(fromRoot.roots).toEqual(["/tmp", "/home/u/Downloads"]);
    expect(fromRoot.skipped).toEqual([`/ ${tooBroad}`]);
    const fromHome = resolveUploadRoots(posix({}, { cwd: "/home/u", tmpdir: "/home" }).opts);
    expect(fromHome.roots).toEqual(["/home/u/Downloads"]);
    expect(fromHome.skipped).toEqual([`/home ${tooBroad}`, `/home/u ${tooBroad}`]);
    const winRoot = resolveUploadRoots(win({}, { cwd: "C:\\" }).opts);
    expect(winRoot.skipped).toEqual([`C:\\ ${tooBroad}`]);
    const winUsers = resolveUploadRoots(win({}, { cwd: "c:\\users" }).opts);
    expect(winUsers.skipped).toEqual([`c:\\users ${tooBroad}`]);
    // With home as the working directory, nothing in it is uploadable by default.
    expect(ruleOf(["/home/u/docs/cv.pdf"], posix({}, { cwd: "/home/u" }).opts)).toBe("outside-roots");
  });

  test("BROWSER_MCP_UPLOAD_DIRS replaces the defaults (':' on POSIX), with ~ expansion", () => {
    const r = resolveUploadRoots(posix({ [UPLOAD_DIRS_ENV]: " /srv/shared : ~/docs::relative/dir:/nope:~:/srv/shared/" }).opts);
    expect(r).toEqual({
      any: false,
      roots: ["/srv/shared", "/home/u/docs", "/home/u"],
      source: "env",
      skipped: ["relative/dir (not an absolute path)", "/nope (does not exist)"],
    });
    const { opts } = posix({ [UPLOAD_DIRS_ENV]: "/srv/shared" });
    expect(checkUploadPaths(["/srv/shared/a.txt"], opts)).toEqual(["/srv/shared/a.txt"]);
    expect(ruleOf(["/tmp/ok.txt"], opts)).toBe("outside-roots");
  });

  test("an explicit root may be broad (the user's choice)", () => {
    const r = resolveUploadRoots(posix({ [UPLOAD_DIRS_ENV]: "/" }).opts);
    expect(r.roots).toEqual(["/"]);
    expect(r.skipped).toEqual([]);
    expect(checkUploadPaths(["/srv/shared/a.txt"], posix({ [UPLOAD_DIRS_ENV]: "/" }).opts)).toEqual(["/srv/shared/a.txt"]);
  });

  test("'*' allows any folder but no rule is relaxed", () => {
    const { opts } = posix({ [UPLOAD_DIRS_ENV]: "*" });
    expect(resolveUploadRoots(opts)).toEqual({ any: true, roots: [], source: "env", skipped: [] });
    expect(checkUploadPaths(["/srv/shared/a.txt", "/home/u/docs/cv.pdf"], opts)).toEqual(["/srv/shared/a.txt", "/home/u/docs/cv.pdf"]);
    expect(ruleOf(["/home/u/.ssh/config"], opts)).toBe("hidden-segment");
    expect(ruleOf(["/tmp/innocent.txt"], opts)).toBe("secret-name");
    expect(ruleOf(["/tmp/big.bin"], opts)).toBe("too-large");
  });

  test("Windows: ';' separates entries, quotes are stripped, drive letters keep their ':'", () => {
    const r = resolveUploadRoots(win({ [UPLOAD_DIRS_ENV]: '"D:\\My Files";~\\Downloads; * ;C:relative' }).opts);
    expect(r).toEqual({
      any: true,
      roots: ["D:\\My Files", "C:\\Users\\U\\Downloads"],
      source: "env",
      skipped: ["C:relative (not an absolute path)"],
    });
  });

  test("a blank BROWSER_MCP_UPLOAD_DIRS means the defaults", () => {
    expect(resolveUploadRoots(posix({ [UPLOAD_DIRS_ENV]: "  " }).opts).source).toBe("default");
  });

  test("uploadGuardOptions() reads this process", () => {
    const o = uploadGuardOptions();
    expect(o).toEqual({ env: process.env, cwd: process.cwd(), homedir: os.homedir(), tmpdir: os.tmpdir(), platform: process.platform });
  });
});

describe("real file system (this platform)", () => {
  test("roots from path.delimiter, canonical results, links, folders, size", () => {
    const root = makeTempDir("upload");
    const other = makeTempDir("upload-other");
    const outside = makeTempDir("upload-outside");
    fs.writeFileSync(path.join(root, "ok.txt"), "hello");
    fs.writeFileSync(path.join(other, "b.txt"), "b");
    fs.writeFileSync(path.join(outside, "x.txt"), "x");
    fs.mkdirSync(path.join(root, "sub"));
    fs.mkdirSync(path.join(root, ".private"));
    fs.writeFileSync(path.join(root, ".private", "inner.txt"), "secret");
    fs.writeFileSync(path.join(root, "id_rsa"), "not really a key");

    const opts: UploadGuardOptions = {
      env: { [UPLOAD_DIRS_ENV]: [root, other].join(path.delimiter) },
      cwd: root,
      homedir: os.homedir(),
      tmpdir: os.tmpdir(),
      platform: process.platform,
    };
    const roots = resolveUploadRoots(opts);
    expect(roots.roots).toEqual([fs.realpathSync.native(root), fs.realpathSync.native(other)]);

    const ok = path.join(root, "ok.txt");
    expect(checkUploadPaths([ok, path.join(other, "b.txt")], opts)).toEqual([fs.realpathSync.native(ok), fs.realpathSync.native(path.join(other, "b.txt"))]);
    if (process.platform === "win32") expect(checkUploadPaths([ok.toUpperCase()], opts)).toEqual([fs.realpathSync.native(ok)]);

    expect(ruleOf([path.join(outside, "x.txt")], opts)).toBe("outside-roots");
    expect(ruleOf([path.join(root, "sub")], opts)).toBe("not-a-file");
    expect(ruleOf([path.join(root, "missing.txt")], opts)).toBe("not-found");
    expect(ruleOf([path.join(root, ".private", "inner.txt")], opts)).toBe("hidden-segment");
    expect(ruleOf([path.join(root, "id_rsa")], opts)).toBe("secret-name");
    expect(ruleOf([ok], { ...opts, maxBytes: 4 })).toBe("too-large");
    expect(ruleOf([ok], { ...opts, maxBytes: 5 })).toBeNull();

    // Directory links (junctions on Windows need no privileges).
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let linked = true;
    try {
      fs.symlinkSync(path.join(root, ".private"), path.join(root, "innocent"), linkType);
      fs.symlinkSync(outside, path.join(root, "out"), linkType);
    } catch {
      linked = false;
    }
    if (linked) {
      expect(ruleOf([path.join(root, "innocent", "inner.txt")], opts)).toBe("hidden-segment");
      const escaped = refusal([path.join(root, "out", "x.txt")], opts);
      expect(escaped.rule).toBe("outside-roots");
      expect(escaped.message).toContain("the resolved path");
    }
  });
});

describe("dom_upload tool", () => {
  test("refused paths never reach the browser; accepted ones are sent canonical", async () => {
    const unit = await startUnitServer({ bridge: new FakeBridge() });
    try {
      for (const bad of ["relative.txt", path.join(os.homedir(), ".ssh", "id_rsa")]) {
        const res = await unit.call("dom_upload", { selector: "#f", filePaths: [bad] });
        expect(res.isError).toBe(true);
        expect(texts(res)[0]).toStartWith("dom_upload refused ");
      }
      expect(unit.bridge.callsOf("dom_upload")).toEqual([]);

      // The tool reads this process's roots: a temp file is inside the default
      // temp root unless the developer configured BROWSER_MCP_UPLOAD_DIRS.
      if (process.env[UPLOAD_DIRS_ENV] !== undefined) return;
      const dir = makeTempDir("upload-tool");
      const file = path.join(dir, "photo.png");
      fs.writeFileSync(file, "png");
      const ok = await unit.call("dom_upload", { selector: "#f", filePaths: [file], tabId: 3 });
      expect(ok.isError).toBeFalsy();
      const [cmd] = unit.bridge.callsOf("dom_upload");
      expect(cmd.payload).toEqual({ selector: "#f", filePaths: [fs.realpathSync.native(file)] });
      expect(cmd.tabId).toBe(3);
      expect(cmd.timeoutMs).toBe(60000);
    } finally {
      await unit.close();
    }
  });
});

describe("spill folders and the refusing tool's name", () => {
  test("spillSegment finds this server's spill folders (case-insensitive)", () => {
    expect(SPILL_DIR_PREFIX).toBe("browser-mcp-spill-");
    expect(spillSegment("/tmp/browser-mcp-spill-1-abc/x.txt", "linux")).toBe("browser-mcp-spill-1-abc");
    expect(spillSegment("C:\\Temp\\BROWSER-MCP-SPILL-1-abc\\x.txt", "win32")).toBe("BROWSER-MCP-SPILL-1-abc");
    expect(spillSegment("/tmp/browser-mcp-abc123/trace.json", "linux")).toBeNull();
  });

  test("spilled output is never uploaded, given directly or through a link, even with '*'", () => {
    const envs: Record<string, string>[] = [{}, { [UPLOAD_DIRS_ENV]: "*" }];
    for (const env of envs) {
      const { opts, probes } = posix(env);
      const direct = refusal(["/tmp/browser-mcp-spill-77-AbCdEf/page_text-output.txt"], opts);
      expect(direct.rule).toBe("spill-file");
      expect(direct.message).toContain('is inside "browser-mcp-spill-77-AbCdEf"');
      expect(probes).toEqual([]);
      expect(ruleOf(["/tmp/report-link.txt"], opts)).toBe("spill-file");
    }
  });

  test("a real spill file of this process is refused by dom_upload", async () => {
    const file = spillToPrivateTemp(Buffer.from("spilled"), "page_text-output.txt");
    try {
      const opts: UploadGuardOptions = { env: {}, cwd: os.tmpdir(), homedir: os.homedir(), tmpdir: os.tmpdir(), platform: process.platform };
      expect(refusal([file], opts).rule).toBe("spill-file");
    } finally {
      removeSpillDir();
    }
    expect(currentSpillDir()).toBeNull();
  });

  test("opts.tool names the caller in the message", () => {
    const { opts } = posix();
    const e = refusal(["relative.txt"], { ...opts, tool: "cdp_send DOM.setFileInputFiles" });
    expect(e.message).toStartWith('cdp_send DOM.setFileInputFiles refused "relative.txt" [not-absolute]: ');
  });
});

describe("cdp_send file guard", () => {
  test("guardCdpFileParams: DOM.setFileInputFiles files and Input.dispatchDragEvent data.files are checked; other methods pass", () => {
    const params = { files: ["relative.txt"], backendNodeId: 5 };
    expect(() => guardCdpFileParams("DOM.setFileInputFiles", params)).toThrow(UploadRefusedError);
    expect(() => guardCdpFileParams(" dom.SETFILEINPUTFILES ", params)).toThrow("refused");
    expect(() => guardCdpFileParams("Input.dispatchDragEvent", { type: "drop", x: 1, y: 1, data: { items: [], files: [os.homedir() + "/.ssh/id_rsa"] } })).toThrow(
      "[hidden-segment]"
    );
    expect(() => guardCdpFileParams("DOM.setFileInputFiles", { files: "/tmp/a.txt" })).toThrow("params.files must be an array of absolute file paths");
    expect(() => guardCdpFileParams("Input.dispatchDragEvent", { data: { files: "x" } })).toThrow("params.data.files must be an array");
    // Nothing to check: returned unchanged.
    const noFiles = { type: "dragEnter", data: { items: [] } };
    expect(guardCdpFileParams("Input.dispatchDragEvent", noFiles)).toBe(noFiles);
    const other = { expression: "1" };
    expect(guardCdpFileParams("Runtime.evaluate", other)).toBe(other);
    expect(guardCdpFileParams("DOM.setFileInputFiles", { files: [] })).toEqual({ files: [] });
  });

  test("guardCdpFileParams: a command nested in Target.sendMessageToTarget is checked too", () => {
    const nested = (method: string, params: unknown) => ({ sessionId: "s1", message: JSON.stringify({ id: 1, method, params }) });
    expect(() => guardCdpFileParams("Target.sendMessageToTarget", nested("DOM.setFileInputFiles", { files: ["relative.txt"] }))).toThrow(UploadRefusedError);
    expect(() =>
      guardCdpFileParams("Target.sendMessageToTarget", nested("Input.dispatchDragEvent", { type: "drop", data: { files: [os.homedir() + "/.ssh/id_rsa"] } }))
    ).toThrow("[hidden-segment]");
    // Doubly nested.
    const inner = nested("DOM.setFileInputFiles", { files: ["relative.txt"] });
    expect(() => guardCdpFileParams("Target.sendMessageToTarget", nested("Target.sendMessageToTarget", inner))).toThrow(UploadRefusedError);
    // Other nested commands, unparsable messages and missing messages pass unchanged.
    for (const p of [nested("Runtime.evaluate", { expression: "1" }), { sessionId: "s1", message: "{not json" }, { sessionId: "s1" }]) {
      expect(guardCdpFileParams("Target.sendMessageToTarget", p)).toBe(p);
    }
  });

  test("the cdp_send tool refuses bad paths before the browser and sends canonical ones", async () => {
    const unit = await startUnitServer({ bridge: new FakeBridge(), server: { toolsets: ["power"] } });
    try {
      const res = await unit.call("cdp_send", { method: "DOM.setFileInputFiles", params: { files: [path.join(os.homedir(), ".aws", "credentials")], nodeId: 3 } });
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toStartWith("cdp_send DOM.setFileInputFiles refused ");
      expect(unit.bridge.callsOf("cdp_send")).toEqual([]);

      await unit.call("cdp_send", { method: "Runtime.evaluate", params: { expression: "1" } });
      expect(unit.bridge.callsOf("cdp_send")[0].payload).toEqual({ method: "Runtime.evaluate", params: { expression: "1" } });

      if (process.env[UPLOAD_DIRS_ENV] !== undefined) return;
      const dir = makeTempDir("cdp-upload");
      const file = path.join(dir, "photo.png");
      fs.writeFileSync(file, "png");
      const drag = { type: "drop", x: 5, y: 6, data: { items: [], files: [file], dragOperationsMask: 1 } };
      const ok = await unit.call("cdp_send", { method: "Input.dispatchDragEvent", params: drag, tabId: 2 });
      expect(ok.isError).toBeFalsy();
      const sent = unit.bridge.callsOf("cdp_send")[1];
      expect(sent.payload).toEqual({ method: "Input.dispatchDragEvent", params: { ...drag, data: { ...drag.data, files: [fs.realpathSync.native(file)] } } });
      expect(sent.tabId).toBe(2);
    } finally {
      await unit.close();
    }
  });
});
