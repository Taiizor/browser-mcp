import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_PORT,
  PROJECT_ENV_ALLOWED,
  autoloadedEnvFiles,
  describeScrub,
  envFilesSkipped,
  findUntrustedBunfig,
  hasExplicitConfig,
  isStandaloneExecutable,
  parseEnvText,
  resolvePort,
  scrubWorkingDirEnv,
} from "./env";
import { MIN_BUN_COMPILE, SAFE_COMPILE_FLAGS } from "../scripts/build-binaries";

const MCP_DIR = path.resolve(import.meta.dir, "..");
const TRUSTED_BUNFIG = path.join(MCP_DIR, "bunfig.toml");
const ISOLATE_ENV_URL = pathToFileURL(path.join(import.meta.dir, "isolate-env.ts")).href;

const parse = (raw: string, source: string): number => {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`bad port from ${source}`);
  return n;
};

describe("autoloadedEnvFiles", () => {
  test("follows Bun's order and mode rules", () => {
    expect(autoloadedEnvFiles(undefined)).toEqual([".env", ".env.development", ".env.local", ".env.development.local"]);
    expect(autoloadedEnvFiles("production")).toEqual([".env", ".env.production", ".env.local", ".env.production.local"]);
    expect(autoloadedEnvFiles("test")).toEqual([".env", ".env.test", ".env.test.local"]);
  });
});

describe("parseEnvText", () => {
  test("reads the plain forms the way Bun does", () => {
    const values = parseEnvText(
      [
        "# comment",
        "PORT=8000",
        "export EXPORTED=1",
        "SPACED = spaced value ",
        "TRAILING=1 # comment",
        'DOUBLE="q # not a comment"',
        "SINGLE='x y'",
        "TICK=`t`",
        'ESCAPED="line1\\nline2"',
        "EMPTY=",
        'MULTI="a',
        'b"',
        "not a variable line",
      ].join("\r\n"),
    );
    expect(Object.fromEntries(values)).toEqual({
      PORT: "8000",
      EXPORTED: "1",
      SPACED: "spaced value",
      TRAILING: "1",
      DOUBLE: "q # not a comment",
      SINGLE: "x y",
      TICK: "t",
      ESCAPED: "line1\nline2",
      EMPTY: "",
      MULTI: "a\nb",
    });
  });

  test("skips an unterminated quote and a leading BOM", () => {
    expect(Object.fromEntries(parseEnvText('\uFEFFA=1\nB="open'))).toEqual({ A: "1" });
  });
});

describe("scrubWorkingDirEnv", () => {
  const files = (map: Record<string, string>) => (file: string) => map[path.basename(file)] ?? null;

  test("removes values that came from the env files and keeps the rest", () => {
    const env: Record<string, string | undefined> = {
      PORT: "8000", // from .env
      SECRET: "s3cret", // from .env.local (overrides .env)
      SHARED: "from-shell", // real env wins over the file, so it differs
      BROWSER_MCP_PORT: "9000", // a harmless setting of this server: allowed from project files
      BROWSER_MCP_TOOLSETS: "all", // allowed as well
      BROWSER_MCP_HOME: ".bmcp", // moves the token and trust store: never from project files
      BROWSER_MCP_EXTENSION_IDS: "*", // turns off the extension id check: never from project files
      PATH: "/usr/bin", // OS essential, even if repeated verbatim
      UNRELATED: "x",
    };
    const result = scrubWorkingDirEnv({
      cwd: "/project",
      env,
      execArgv: [],
      isBun: true,
      readFile: files({
        ".env":
          "PORT=8000\nSECRET=old\nSHARED=from-file\nBROWSER_MCP_PORT=9000\nBROWSER_MCP_TOOLSETS=all\n" +
          "BROWSER_MCP_HOME=.bmcp\nBROWSER_MCP_EXTENSION_IDS=*\nPATH=/usr/bin\n",
        ".env.local": "SECRET=s3cret\n",
      }),
    });
    expect(result.files).toEqual([".env", ".env.local"]);
    expect(result.removed.sort()).toEqual(["PORT", "SECRET"]);
    expect(result.blocked).toEqual(["BROWSER_MCP_HOME", "BROWSER_MCP_EXTENSION_IDS"]);
    expect(env).toEqual({
      SHARED: "from-shell",
      BROWSER_MCP_PORT: "9000",
      BROWSER_MCP_TOOLSETS: "all",
      PATH: "/usr/bin",
      UNRELATED: "x",
    });
  });

  test("keeps a BROWSER_MCP_* value that came from the client config, and blocks future keys", () => {
    const env: Record<string, string | undefined> = {
      BROWSER_MCP_HOME: "/home/me/.browser-mcp", // client config: differs from the file
      BROWSER_MCP_SOMETHING_NEW: "1", // not on the allow-list, so blocked by default
      browser_mcp_pair: "1", // names are case-insensitive on Windows
      browser_mcp_port: "9001",
    };
    const result = scrubWorkingDirEnv({
      cwd: "/p",
      env,
      execArgv: [],
      isBun: true,
      readFile: files({
        ".env": "BROWSER_MCP_HOME=.evil\nBROWSER_MCP_SOMETHING_NEW=1\nbrowser_mcp_pair=1\nbrowser_mcp_port=9001\n",
      }),
    });
    expect(result.blocked).toEqual(["BROWSER_MCP_SOMETHING_NEW", "browser_mcp_pair"]);
    expect(result.removed).toEqual([]);
    expect(env).toEqual({ BROWSER_MCP_HOME: "/home/me/.browser-mcp", browser_mcp_port: "9001" });
  });

  test("the allow-list holds only the harmless settings", () => {
    expect([...PROJECT_ENV_ALLOWED].sort()).toEqual(
      [
        "BROWSER_MCP_PORT",
        "BROWSER_MCP_TOOLSETS",
        "BROWSER_MCP_MAX_OUTPUT_CHARS",
        "BROWSER_MCP_NO_STDIO_EXIT",
        "BROWSER_MCP_NO_PARENT_CHECK",
        "BROWSER_MCP_PARENT_CHECK_MS",
        "BROWSER_MCP_NO_CLIENT_PING",
        "BROWSER_MCP_CLIENT_PING_MS",
        "BROWSER_MCP_CLIENT_PING_TIMEOUT_MS",
        "BROWSER_MCP_CLIENT_PING_FAILS",
      ].sort(),
    );
    for (const key of ["BROWSER_MCP_EXTENSION_IDS", "BROWSER_MCP_HOME", "BROWSER_MCP_PAIR", "BROWSER_MCP_ALLOW_LEGACY_EXTENSION", "BROWSER_MCP_UPLOAD_DIRS"]) {
      expect(PROJECT_ENV_ALLOWED).not.toContain(key);
    }
  });

  test("does nothing when Bun did not load env files", () => {
    for (const options of [
      { execArgv: ["--no-env-file"], isBun: true },
      { execArgv: ["--no-env-file"], isBun: true, bunVersion: "1.3.3" },
      { execArgv: ["--no-env-file"], isBun: true, bunVersion: "1.4.5" },
      { execArgv: [], isBun: false },
    ]) {
      const env: Record<string, string | undefined> = { PORT: "8000" };
      const result = scrubWorkingDirEnv({ cwd: "/p", env, readFile: files({ ".env": "PORT=8000" }), ...options });
      expect(result).toEqual({ files: [], removed: [], blocked: [] });
      expect(env.PORT).toBe("8000");
    }
  });

  test("still scrubs under a Bun that accepts --no-env-file but loads the files anyway", () => {
    expect(envFilesSkipped(["--no-env-file"], "1.3.2")).toBe(false);
    expect(envFilesSkipped(["--no-env-file"], "1.3.3")).toBe(true);
    expect(envFilesSkipped(["--no-env-file"], "1.10.0")).toBe(true);
    expect(envFilesSkipped(["--no-env-file"], "2.0.0-canary.1")).toBe(true);
    expect(envFilesSkipped([], "1.4.5")).toBe(false);
    const env: Record<string, string | undefined> = { PORT: "8000" };
    scrubWorkingDirEnv({ cwd: "/p", env, execArgv: ["--no-env-file"], isBun: true, bunVersion: "1.3.2", readFile: files({ ".env": "PORT=8000" }) });
    expect(env.PORT).toBeUndefined();
  });

  test("temp directory variables from env files are removed outside Windows", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const env: Record<string, string | undefined> = {
        TMPDIR: "/home/me", // missing from the real environment, so Bun applied the file's value
        TMP: "/home/me",
        TEMP: "/real/temp", // real environment: Bun kept it, so it differs from the file
        LOCALAPPDATA: "/home/me/AppData/Local",
      };
      const result = scrubWorkingDirEnv({
        cwd: "/p",
        env,
        execArgv: [],
        isBun: true,
        platform,
        realpath: () => null,
        readFile: files({ ".env": "TMPDIR=/home/me\nTMP=/home/me\nTEMP=/home/me\n" }),
      });
      expect(result.removed).toEqual(["TMPDIR", "TMP"]);
      expect(env).toEqual({ TEMP: "/real/temp", LOCALAPPDATA: "/home/me/AppData/Local" });
    }
  });

  test("on Windows a repeated TEMP/TMP stays only when it is the standard per-user temp directory", () => {
    const local = "C:\\Users\\me\\AppData\\Local";
    const options = (env: Record<string, string | undefined>, envFile: string, realpath: (f: string) => string | null = () => null) => ({
      cwd: "C:\\p",
      env,
      execArgv: [] as string[],
      isBun: true,
      platform: "win32" as const,
      realpath,
      readFile: files({ ".env": envFile }),
    });

    // An env dump repeats the standard directory (spelled differently): kept. A directory the
    // project picked is removed, and TMPDIR (unused by os.tmpdir() on Windows) goes as well.
    const env: Record<string, string | undefined> = {
      LOCALAPPDATA: local,
      TEMP: "c:\\users\\me\\appdata\\local\\temp\\",
      TMP: "C:\\Users\\me",
      TMPDIR: "C:\\Users\\me",
    };
    const result = scrubWorkingDirEnv(
      options(env, `LOCALAPPDATA=${local}\nTEMP=c:\\users\\me\\appdata\\local\\temp\\\nTMP=C:\\Users\\me\nTMPDIR=C:\\Users\\me\n`),
    );
    expect(result.removed).toEqual(["TMP", "TMPDIR"]);
    expect(env).toEqual({ LOCALAPPDATA: local, TEMP: "c:\\users\\me\\appdata\\local\\temp\\" });

    // 8.3 short names are compared by their real path.
    const short = "C:\\Users\\FIRSTN~1\\AppData\\Local\\Temp";
    const long = "C:\\Users\\First Name\\AppData\\Local";
    const real = (f: string) => (f === short ? `${long}\\Temp` : f === `${long}\\Temp` ? f : null);
    const shortEnv: Record<string, string | undefined> = { LOCALAPPDATA: long, TEMP: short };
    expect(scrubWorkingDirEnv(options(shortEnv, `TEMP=${short}\n`, real)).removed).toEqual([]);
    expect(shortEnv.TEMP).toBe(short);

    // Without a usable LOCALAPPDATA nothing counts as standard; a relative value never does.
    for (const env2 of [{ TEMP: `${local}\\Temp` }, { LOCALAPPDATA: "relative", TEMP: "relative\\Temp" }] as Record<string, string | undefined>[]) {
      expect(scrubWorkingDirEnv(options(env2, `TEMP=${env2.TEMP}\n`)).removed).toEqual(["TEMP"]);
      expect(env2.TEMP).toBeUndefined();
    }
  });

  test("uses the NODE_ENV mode to pick the files", () => {
    const env: Record<string, string | undefined> = { NODE_ENV: "test", A: "1", B: "2" };
    scrubWorkingDirEnv({
      cwd: "/p",
      env,
      execArgv: [],
      isBun: true,
      readFile: files({ ".env.test": "A=1", ".env.local": "B=2" }), // .env.local is not loaded in test mode
    });
    expect(env).toEqual({ NODE_ENV: "test", B: "2" });
  });

  test("a NODE_ENV set by the files does not hide the development files Bun loaded", () => {
    // No NODE_ENV in the real environment: Bun loaded .env, .env.development and .env.local, and
    // NODE_ENV=production came from .env. .env.production repeats a key with another value: a merge
    // of both modes would hide the value Bun applied.
    const env: Record<string, string | undefined> = {
      NODE_ENV: "production",
      FOO: "bar",
      DEVLOCAL: "1",
      BROWSER_MCP_EXTENSION_IDS: "*",
      BROWSER_MCP_ALLOW_LEGACY_EXTENSION: "1",
      BROWSER_MCP_UPLOAD_DIRS: "*",
      BROWSER_MCP_PORT: "9001",
    };
    const result = scrubWorkingDirEnv({
      cwd: "/p",
      env,
      execArgv: [],
      isBun: true,
      readFile: files({
        ".env": "NODE_ENV=production\nFOO=bar\n",
        ".env.development":
          "BROWSER_MCP_EXTENSION_IDS=*\nBROWSER_MCP_ALLOW_LEGACY_EXTENSION=1\nBROWSER_MCP_UPLOAD_DIRS=*\nBROWSER_MCP_PORT=9001\n",
        ".env.production": "BROWSER_MCP_UPLOAD_DIRS=/elsewhere\nPRODVAR=1\n",
        ".env.local": "DEVLOCAL=1\n",
      }),
    });
    expect(result.files).toEqual([".env", ".env.production", ".env.local", ".env.development"]);
    expect(result.removed).toEqual(["FOO", "DEVLOCAL"]);
    expect(result.blocked).toEqual(["BROWSER_MCP_EXTENSION_IDS", "BROWSER_MCP_ALLOW_LEGACY_EXTENSION", "BROWSER_MCP_UPLOAD_DIRS"]);
    // NODE_ENV is an OS-level name this scrub never removes; the allowed port stays.
    expect(env).toEqual({ NODE_ENV: "production", BROWSER_MCP_PORT: "9001" });
  });

  test("NODE_ENV=test from the files does not hide .env.local", () => {
    const env: Record<string, string | undefined> = { NODE_ENV: "test", BROWSER_MCP_PAIR: "1", SECRET: "x" };
    const result = scrubWorkingDirEnv({
      cwd: "/p",
      env,
      execArgv: [],
      isBun: true,
      readFile: files({ ".env": "NODE_ENV=test\n", ".env.local": "BROWSER_MCP_PAIR=1\nSECRET=x\n" }),
    });
    expect(result.files).toEqual([".env", ".env.local"]);
    expect(result.blocked).toEqual(["BROWSER_MCP_PAIR"]);
    expect(result.removed).toEqual(["SECRET"]);
    expect(env).toEqual({ NODE_ENV: "test" });
  });

  test("a NODE_ENV from the real environment alone picks the files", () => {
    // The client set NODE_ENV=production; the development files define another NODE_ENV, so Bun
    // never loaded them and a variable that happens to repeat their value stays.
    const env: Record<string, string | undefined> = { NODE_ENV: "production", BROWSER_MCP_UPLOAD_DIRS: "/real", X: "1" };
    const result = scrubWorkingDirEnv({
      cwd: "/p",
      env,
      execArgv: [],
      isBun: true,
      readFile: files({ ".env.development": "NODE_ENV=development\nBROWSER_MCP_UPLOAD_DIRS=/real\nX=1\n" }),
    });
    expect(result).toEqual({ files: [], removed: [], blocked: [] });
    expect(env).toEqual({ NODE_ENV: "production", BROWSER_MCP_UPLOAD_DIRS: "/real", X: "1" });
  });
});

describe("describeScrub", () => {
  test("names the removed variables but never their values", () => {
    const lines = describeScrub(
      { files: [".env"], removed: ["API_SECRET"], blocked: ["BROWSER_MCP_EXTENSION_IDS", "BROWSER_MCP_HOME"] },
      "/project",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ignored 1 variable(s) Bun loaded from .env in /project (API_SECRET)");
    expect(lines[1]).toStartWith("[browser-mcp] ignored BROWSER_MCP_EXTENSION_IDS, BROWSER_MCP_HOME from .env in /project:");
    expect(describeScrub({ files: [".env"], removed: [], blocked: [] }, "/project")).toEqual([]);
  });
});

describe("findUntrustedBunfig", () => {
  const cwd = path.resolve("/project");
  const projectFile = path.join(cwd, "bunfig.toml");
  const trusted = path.resolve("/opt/browser-mcp/mcp-server/bunfig.toml");
  const fakeFs = (files: Record<string, string>, links: Record<string, string> = {}) => ({
    readFile: (file: string) => files[file] ?? null,
    realpath: (file: string) => (file in files ? (links[file] ?? file) : null),
  });
  const base = { cwd, execArgv: [] as string[], isBun: true, main: "/opt/browser-mcp/mcp-server/src/index.ts", trustedConfig: trusted };

  test("reports a working-directory bunfig.toml Bun applied", () => {
    const fsx = fakeFs({ [projectFile]: 'preload = ["./x.ts"]', [trusted]: "# trusted" });
    expect(findUntrustedBunfig({ ...base, ...fsx })).toBe(projectFile);
    // Only "--config=<file>" stops Bun 1.4 from reading the cwd file.
    expect(findUntrustedBunfig({ ...base, ...fsx, execArgv: ["-c=/elsewhere/bunfig.toml"] })).toBe(projectFile);
    expect(findUntrustedBunfig({ ...base, ...fsx, execArgv: [`--config=${trusted}`, "--no-env-file"] })).toBeNull();
  });

  test("stays quiet when there is nothing to report", () => {
    expect(findUntrustedBunfig({ ...base, ...fakeFs({ [trusted]: "# trusted" }) })).toBeNull(); // no project file
    expect(findUntrustedBunfig({ ...base, isBun: false, ...fakeFs({ [projectFile]: "x" }) })).toBeNull();
    // Started inside mcp-server/: the cwd file is the trusted one, or a byte-identical copy.
    expect(findUntrustedBunfig({ ...base, ...fakeFs({ [projectFile]: "# trusted", [trusted]: "# other" }, { [projectFile]: trusted }) })).toBeNull();
    expect(findUntrustedBunfig({ ...base, ...fakeFs({ [projectFile]: "# trusted", [trusted]: "# trusted" }) })).toBeNull();
  });

  test("trusts a standalone binary only when it was built with the safe flags", () => {
    const fsx = fakeFs({ [projectFile]: 'preload = ["./x.ts"]' });
    for (const main of ["/$bunfs/root/browser-mcp", "B:/~BUN/root/browser-mcp", "B:\\~BUN\\root\\browser-mcp"]) {
      expect(isStandaloneExecutable(main)).toBe(true);
      expect(findUntrustedBunfig({ ...base, ...fsx, main, execArgv: ["--no-env-file"] })).toBeNull();
      expect(findUntrustedBunfig({ ...base, ...fsx, main })).toBe(projectFile);
    }
    expect(isStandaloneExecutable("/home/me/browser-mcp/src/index.ts")).toBe(false);
    expect(isStandaloneExecutable("C:\\Users\\me\\src\\index.ts")).toBe(false);
  });

  test("hasExplicitConfig accepts only the form Bun honours", () => {
    expect(hasExplicitConfig(["--config=/x/bunfig.toml"])).toBe(true);
    expect(hasExplicitConfig(["--config", "/x/bunfig.toml"])).toBe(false);
    expect(hasExplicitConfig(["-c=/x/bunfig.toml"])).toBe(false);
    expect(hasExplicitConfig(["-c/x/bunfig.toml"])).toBe(false);
  });
});

describe("resolvePort", () => {
  test("--port, then BROWSER_MCP_PORT, then the default; PORT is never used", () => {
    expect(resolvePort(9100, { PORT: "8000", BROWSER_MCP_PORT: "9000" }, parse)).toEqual({ port: 9100, source: "cli", ignoredPort: "8000" });
    expect(resolvePort(undefined, { PORT: "8000", BROWSER_MCP_PORT: "9000" }, parse)).toEqual({
      port: 9000,
      source: "BROWSER_MCP_PORT",
      ignoredPort: "8000",
    });
    expect(resolvePort(undefined, { PORT: "8000" }, parse)).toEqual({ port: DEFAULT_PORT, source: "default", ignoredPort: "8000" });
    expect(resolvePort(undefined, { BROWSER_MCP_PORT: "  " }, parse)).toEqual({ port: DEFAULT_PORT, source: "default" });
  });
});

// ---------- real Bun processes ----------

/** The parent environment without anything a test controls (bun test sets NODE_ENV=test; the server runs without it). */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^BROWSER_MCP_/i.test(k) || ["PORT", "API_SECRET", "SHARED", "LEAK", "NODE_ENV"].includes(k.toUpperCase())) continue;
    env[k] = v;
  }
  return env;
}

/** A temporary folder with the given files; removed by the returned cleanup. */
function tempDir(prefix: string, files: Record<string, string> = {}): string {
  // The canonical path, as Bun reports it for the working directory and import.meta.dir:
  // macOS temp folders sit behind /var -> /private/var, and a Windows TEMP may use 8.3 names.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

/** A project folder whose bunfig.toml preloads code that records every process it runs in. */
function hostileProject(extra: Record<string, string> = {}): { dir: string; log: string } {
  const dir = tempDir("browser-mcp-hostile-", {
    "bunfig.toml": 'preload = ["./pre.js"]\n',
    "pre.js":
      'globalThis.__BMCP_PRELOADED = true;\n' +
      'require("node:fs").appendFileSync(require("node:path").join(__dirname, "preload.log"), JSON.stringify(process.argv) + "\\n");\n',
    ...extra,
  });
  return { dir, log: path.join(dir, "preload.log") };
}

const preloadRuns = (log: string): string[][] =>
  fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const spawn = (cmd: string[], cwd: string, env: Record<string, string>) => {
  const run = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString().trim(), stderr: run.stderr.toString() };
};

describe("isolate-env.ts in a real Bun process", () => {
  test("a project's .env never reaches the server environment", () => {
    const dir = tempDir("browser-mcp-env-", { ".env": "PORT=8000\nAPI_SECRET=from-project\nSHARED=from-file\n" });
    try {
      const script = `await import(${JSON.stringify(ISOLATE_ENV_URL)}); console.log(JSON.stringify({ PORT: process.env.PORT ?? null, API_SECRET: process.env.API_SECRET ?? null, SHARED: process.env.SHARED ?? null }));`;
      const env = { ...baseEnv(), SHARED: "from-shell" };

      const run = spawn([process.execPath, "-e", script], dir, env);
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ PORT: null, API_SECRET: null, SHARED: "from-shell" });
      expect(run.stderr).toContain("ignored 2 variable(s)");

      // With --no-env-file nothing was loaded, so there is nothing to remove and nothing to log.
      const clean = spawn([process.execPath, "--no-env-file", "-e", script], dir, env);
      expect(JSON.parse(clean.stdout)).toEqual({ PORT: null, API_SECRET: null, SHARED: "from-shell" });
      expect(clean.stderr).not.toContain("ignored");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a project's .env cannot set the security-relevant BROWSER_MCP_* settings", () => {
    const dir = tempDir("browser-mcp-env-", {
      ".env": "BROWSER_MCP_EXTENSION_IDS=*\nBROWSER_MCP_HOME=.bmcp-home\nBROWSER_MCP_PAIR=1\nBROWSER_MCP_PORT=9123\n",
    });
    try {
      const script =
        `await import(${JSON.stringify(ISOLATE_ENV_URL)}); const e = process.env; ` +
        `console.log(JSON.stringify({ ids: e.BROWSER_MCP_EXTENSION_IDS ?? null, home: e.BROWSER_MCP_HOME ?? null, pair: e.BROWSER_MCP_PAIR ?? null, port: e.BROWSER_MCP_PORT ?? null }));`;
      const run = spawn([process.execPath, "-e", script], dir, baseEnv());
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ids: null, home: null, pair: null, port: "9123" });
      const line = run.stderr.split("\n").find((l) => l.includes("BROWSER_MCP_EXTENSION_IDS")) ?? "";
      expect(line).toContain("ignored BROWSER_MCP_EXTENSION_IDS, BROWSER_MCP_HOME, BROWSER_MCP_PAIR from .env");
      expect(run.stderr).not.toContain(".bmcp-home"); // names only, never values
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a NODE_ENV in the project's .env does not let the other mode's files through", () => {
    const script =
      `const before = { ...process.env }; await import(${JSON.stringify(ISOLATE_ENV_URL)}); const e = process.env; ` +
      `const pick = (o) => ({ mode: o.NODE_ENV ?? null, ids: o.BROWSER_MCP_EXTENSION_IDS ?? null, legacy: o.BROWSER_MCP_ALLOW_LEGACY_EXTENSION ?? null, ` +
      `up: o.BROWSER_MCP_UPLOAD_DIRS ?? null, pair: o.BROWSER_MCP_PAIR ?? null, home: o.BROWSER_MCP_HOME ?? null, foo: o.FOO ?? null, prod: o.PRODVAR ?? null }); ` +
      `console.log(JSON.stringify({ before: pick(before), after: pick(e) }));`;

    // NODE_ENV=production in .env: Bun still loads .env.development (it picks the mode first).
    const prod = tempDir("browser-mcp-env-", {
      ".env": "NODE_ENV=production\nFOO=bar\n",
      ".env.development": "BROWSER_MCP_EXTENSION_IDS=*\nBROWSER_MCP_ALLOW_LEGACY_EXTENSION=1\nBROWSER_MCP_UPLOAD_DIRS=*\n",
      ".env.production": "BROWSER_MCP_UPLOAD_DIRS=/elsewhere\nPRODVAR=1\n",
    });
    // NODE_ENV=test in .env: Bun still loads .env.local, which test mode would skip.
    const testMode = tempDir("browser-mcp-env-", {
      ".env": "NODE_ENV=test\n",
      ".env.local": "BROWSER_MCP_PAIR=1\nBROWSER_MCP_HOME=.bmcp-home\n",
    });
    try {
      const a = spawn([process.execPath, "-e", script], prod, baseEnv());
      expect(a.exitCode).toBe(0);
      const outA = JSON.parse(a.stdout);
      // The premise: what Bun loaded before the scrub ran.
      expect(outA.before).toMatchObject({ mode: "production", ids: "*", legacy: "1", up: "*", foo: "bar", prod: null });
      expect(outA.after).toEqual({ mode: "production", ids: null, legacy: null, up: null, pair: null, home: null, foo: null, prod: null });
      expect(a.stderr).toContain("ignored BROWSER_MCP_EXTENSION_IDS, BROWSER_MCP_ALLOW_LEGACY_EXTENSION, BROWSER_MCP_UPLOAD_DIRS from");
      expect(a.stderr).toContain(".env.development");

      const b = spawn([process.execPath, "-e", script], testMode, baseEnv());
      expect(b.exitCode).toBe(0);
      const outB = JSON.parse(b.stdout);
      expect(outB.before).toMatchObject({ mode: "test", pair: "1", home: ".bmcp-home" });
      expect(outB.after).toMatchObject({ mode: "test", pair: null, home: null });
      expect(b.stderr).toContain("ignored BROWSER_MCP_PAIR, BROWSER_MCP_HOME from .env, .env.local");
    } finally {
      fs.rmSync(prod, { recursive: true, force: true });
      fs.rmSync(testMode, { recursive: true, force: true });
    }
  });

  test("a project's .env cannot move the temp directory", () => {
    const dir = tempDir("browser-mcp-env-");
    fs.writeFileSync(path.join(dir, ".env"), `TMPDIR=${dir}\nTMP=${dir}\nTEMP=${dir}\n`);
    try {
      const script =
        `await import(${JSON.stringify(ISOLATE_ENV_URL)}); const os = await import("node:os"); const e = process.env; ` +
        `console.log(JSON.stringify({ tmpdir: os.tmpdir(), TMPDIR: e.TMPDIR ?? null, TMP: e.TMP ?? null, TEMP: e.TEMP ?? null }));`;

      // The client passed its temp variables: the files cannot override them.
      const withTemp = spawn([process.execPath, "-e", script], dir, baseEnv());
      expect(withTemp.exitCode).toBe(0);
      expect(JSON.parse(withTemp.stdout).tmpdir).toBe(os.tmpdir());

      // The client passed none: Bun applied the project's values, and the scrub takes them out again.
      const bare = Object.fromEntries(Object.entries(baseEnv()).filter(([k]) => !/^(TMPDIR|TMP|TEMP)$/i.test(k)));
      const without = spawn([process.execPath, "-e", script], dir, bare);
      expect(without.exitCode).toBe(0);
      const out = JSON.parse(without.stdout);
      if (process.platform === "win32") {
        // libuv (Bun.spawn here, Node-based MCP clients too) always hands a child the parent's
        // TEMP on Windows, so only TMP and TMPDIR came from the file.
        expect(out).toEqual({ tmpdir: os.tmpdir(), TMPDIR: null, TMP: null, TEMP: process.env.TEMP });
        expect(without.stderr).toContain("(TMPDIR, TMP)");
      } else {
        expect(out).toEqual({ tmpdir: "/tmp", TMPDIR: null, TMP: null, TEMP: null });
        expect(without.stderr).toContain("(TMPDIR, TMP, TEMP)");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a project's bunfig.toml is applied unless the server starts with --config=", () => {
    const project = hostileProject();
    const probeDir = tempDir("browser-mcp-probe-", {
      "probe.ts": `import ${JSON.stringify(ISOLATE_ENV_URL)}; console.log(JSON.stringify({ preloaded: (globalThis as any).__BMCP_PRELOADED ?? false }));\n`,
    });
    const probe = path.join(probeDir, "probe.ts");
    try {
      // What the README used to document: the project's preload runs inside the server, and it warns.
      const plain = spawn([process.execPath, "run", probe], project.dir, baseEnv());
      expect(JSON.parse(plain.stdout)).toEqual({ preloaded: true });
      expect(plain.stderr).toContain(`warning: Bun applied ${path.join(project.dir, "bunfig.toml")}`);

      // --no-env-file alone does not help.
      const noEnv = spawn([process.execPath, "--no-env-file", "run", probe], project.dir, baseEnv());
      expect(JSON.parse(noEnv.stdout)).toEqual({ preloaded: true });

      // The documented launch: the trusted config replaces the project's file.
      const safe = spawn([process.execPath, `--config=${TRUSTED_BUNFIG}`, "--no-env-file", "run", probe], project.dir, baseEnv());
      expect(safe.exitCode).toBe(0);
      expect(JSON.parse(safe.stdout)).toEqual({ preloaded: false });
      expect(safe.stderr).not.toContain("warning");
      expect(preloadRuns(project.log)).toHaveLength(2); // plain + noEnv, never the safe launch
    } finally {
      fs.rmSync(project.dir, { recursive: true, force: true });
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });
});

describe("bin/browser-mcp.js launcher", () => {
  /** A copy of the package with a stand-in server, so the launcher is tested without starting a bridge. */
  const launcherPackage = () =>
    tempDir("browser-mcp-pkg-", {
      "bin/browser-mcp.js": fs.readFileSync(path.join(MCP_DIR, "bin", "browser-mcp.js"), "utf8"),
      "src/env.ts": fs.readFileSync(path.join(MCP_DIR, "src", "env.ts"), "utf8"),
      "bunfig.toml": fs.readFileSync(TRUSTED_BUNFIG, "utf8"),
      "src/index.ts":
        "const e = process.env;\n" +
        "console.log(JSON.stringify({ preloaded: (globalThis as any).__BMCP_PRELOADED ?? false, execArgv: process.execArgv, args: process.argv.slice(2), \n" +
        "  LEAK: e.LEAK ?? null, home: e.BROWSER_MCP_HOME ?? null, port: e.BROWSER_MCP_PORT ?? null, main: import.meta.main,\n" +
        "  ids: e.BROWSER_MCP_EXTENSION_IDS ?? null, legacy: e.BROWSER_MCP_ALLOW_LEGACY_EXTENSION ?? null, up: e.BROWSER_MCP_UPLOAD_DIRS ?? null }));\n" +
        "process.exit(7);\n",
    });

  test("runs the server as a child with the trusted config, without env files, and forwards the exit code", () => {
    const pkg = launcherPackage();
    const project = hostileProject({ ".env": "LEAK=from-project\nBROWSER_MCP_HOME=.bmcp-home\nBROWSER_MCP_PORT=9124\n" });
    try {
      // What bunx does: run the package bin with bun, in the client's working directory.
      const run = spawn([process.execPath, path.join(pkg, "bin", "browser-mcp.js"), "--port", "1234"], project.dir, baseEnv());
      expect(run.exitCode).toBe(7);
      const child = JSON.parse(run.stdout);
      expect(child).toMatchObject({ preloaded: false, args: ["--port", "1234"], LEAK: null, home: null, port: "9124", main: true });
      expect(child.execArgv).toEqual([`--config=${path.join(pkg, "bunfig.toml")}`, "--no-env-file"]);
      // The residual risk: the preload ran in the launcher process, and only there.
      const runs = preloadRuns(project.log);
      expect(runs).toHaveLength(1);
      expect(runs[0].join(" ")).toContain("browser-mcp.js");
      expect(run.stderr).toContain("warning: Bun applied");
      expect(run.stderr).toContain("(LEAK)");
      expect(run.stderr).toContain("ignored BROWSER_MCP_HOME from .env");
      expect(run.stderr).not.toContain("from-project");
    } finally {
      fs.rmSync(project.dir, { recursive: true, force: true });
      fs.rmSync(pkg, { recursive: true, force: true });
    }
  }, 30_000);

  test("a NODE_ENV in the project's .env does not let .env.development settings reach the server", () => {
    const pkg = launcherPackage();
    const project = tempDir("browser-mcp-env-", {
      ".env": "NODE_ENV=production\n",
      ".env.development": "BROWSER_MCP_EXTENSION_IDS=*\nBROWSER_MCP_ALLOW_LEGACY_EXTENSION=1\nBROWSER_MCP_UPLOAD_DIRS=*\nBROWSER_MCP_PORT=9125\n",
    });
    try {
      const run = spawn([process.execPath, path.join(pkg, "bin", "browser-mcp.js")], project, baseEnv());
      expect(run.exitCode).toBe(7);
      expect(JSON.parse(run.stdout)).toMatchObject({ ids: null, legacy: null, up: null, port: "9125" });
      expect(run.stderr).toContain("ignored BROWSER_MCP_EXTENSION_IDS, BROWSER_MCP_ALLOW_LEGACY_EXTENSION, BROWSER_MCP_UPLOAD_DIRS from");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(pkg, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("standalone binary", () => {
  // Older Bun builds binaries that ignore --no-compile-autoload-bunfig; the build script refuses them.
  test.skipIf(!Bun.semver.satisfies(Bun.version, `>=${MIN_BUN_COMPILE}`))("built with SAFE_COMPILE_FLAGS it reads neither the project's bunfig.toml nor its .env", () => {
    const build = tempDir("browser-mcp-compile-", {
      "probe.ts":
        // The bundler resolves a plain path, not a file: URL.
        `import ${JSON.stringify(path.join(import.meta.dir, "isolate-env.ts"))};\n` +
        "console.log(JSON.stringify({ preloaded: (globalThis as any).__BMCP_PRELOADED ?? false, LEAK: process.env.LEAK ?? null, execArgv: process.execArgv }));\n",
    });
    const project = hostileProject({ ".env": "LEAK=from-project\n" });
    try {
      const outfile = path.join(build, "probe");
      const compiled = spawn([process.execPath, "build", ...SAFE_COMPILE_FLAGS, `--outfile=${outfile}`, path.join(build, "probe.ts")], build, baseEnv());
      expect(compiled.exitCode).toBe(0);
      const exe = process.platform === "win32" ? `${outfile}.exe` : outfile;
      const run = spawn([exe], project.dir, baseEnv());
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ preloaded: false, LEAK: null, execArgv: ["--no-env-file"] });
      expect(run.stderr).toBe("");
      expect(preloadRuns(project.log)).toHaveLength(0);
    } finally {
      fs.rmSync(project.dir, { recursive: true, force: true });
      fs.rmSync(build, { recursive: true, force: true });
    }
  }, 60_000);
});
