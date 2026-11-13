import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_PORT, autoloadedEnvFiles, parseEnvText, resolvePort, scrubWorkingDirEnv } from "./env";

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
      BROWSER_MCP_PORT: "9000", // this server's own namespace
      PATH: "/usr/bin", // OS essential, even if repeated verbatim
      UNRELATED: "x",
    };
    const result = scrubWorkingDirEnv({
      cwd: "/project",
      env,
      execArgv: [],
      isBun: true,
      readFile: files({
        ".env": "PORT=8000\nSECRET=old\nSHARED=from-file\nBROWSER_MCP_PORT=9000\nPATH=/usr/bin\n",
        ".env.local": "SECRET=s3cret\n",
      }),
    });
    expect(result.files).toEqual([".env", ".env.local"]);
    expect(result.removed.sort()).toEqual(["PORT", "SECRET"]);
    expect(env).toEqual({ SHARED: "from-shell", BROWSER_MCP_PORT: "9000", PATH: "/usr/bin", UNRELATED: "x" });
  });

  test("does nothing when Bun did not load env files", () => {
    for (const options of [{ execArgv: ["--no-env-file"], isBun: true }, { execArgv: [], isBun: false }]) {
      const env: Record<string, string | undefined> = { PORT: "8000" };
      const result = scrubWorkingDirEnv({ cwd: "/p", env, readFile: files({ ".env": "PORT=8000" }), ...options });
      expect(result).toEqual({ files: [], removed: [] });
      expect(env.PORT).toBe("8000");
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

describe("isolate-env.ts in a real Bun process", () => {
  test("a project's .env never reaches the server environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-env-"));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "PORT=8000\nAPI_SECRET=from-project\nSHARED=from-file\nBROWSER_MCP_HOME=/kept\n");
      const module = pathToFileURL(path.join(import.meta.dir, "isolate-env.ts")).href;
      const script = `await import(${JSON.stringify(module)}); console.log(JSON.stringify({ PORT: process.env.PORT ?? null, API_SECRET: process.env.API_SECRET ?? null, SHARED: process.env.SHARED ?? null, HOME: process.env.BROWSER_MCP_HOME ?? null }));`;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "PORT" && k !== "API_SECRET") env[k] = v;
      env.SHARED = "from-shell";
      delete env.BROWSER_MCP_HOME;
      delete env.NODE_ENV; // bun test sets NODE_ENV=test; the server runs without it

      const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout.toString().trim())).toEqual({ PORT: null, API_SECRET: null, SHARED: "from-shell", HOME: "/kept" });
      expect(run.stderr.toString()).toContain("ignored 2 variable(s)");

      // With --no-env-file nothing was loaded, so there is nothing to remove and nothing to log.
      const clean = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      expect(JSON.parse(clean.stdout.toString().trim())).toEqual({ PORT: null, API_SECRET: null, SHARED: "from-shell", HOME: null });
      expect(clean.stderr.toString()).not.toContain("ignored");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
