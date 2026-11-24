// CLI parsing of src/index.ts. index.ts does not export its parser (importing
// it starts the server), so it runs as a subprocess the way the docs launch
// it: bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run src/index.ts.
// --help / --version exit inside the parser, after every earlier flag was
// parsed, which makes "flags... --help" a side-effect-free parse check.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { MCP_ROOT } from "../helpers/unit-source-scan.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/unit-temp.js";

afterAll(cleanupTempDirs);

// Each test starts several Bun processes at once: give slow CI runners room.
const SPAWN_TIMEOUT_MS = 30000;

const ENTRY = path.join(MCP_ROOT, "src", "index.ts");
const BUNFIG = path.join(MCP_ROOT, "bunfig.toml");

/** This process's environment without BROWSER_MCP_* (a developer's settings must not leak in). */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^BROWSER_MCP_/i.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function spawnServer(args: string[], env: Record<string, string> = cleanEnv()) {
  return Bun.spawn([process.execPath, `--config=${BUNFIG}`, "--no-env-file", "run", ENTRY, ...args], {
    cwd: MCP_ROOT,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Environment for a parse check: an empty temp config dir and a free port, so
 * a parser regression that lets the server start (instead of exiting) can
 * never touch the developer's ~/.browser-mcp or a live bridge on 8765
 * (CONTRIBUTING: tests must not use the real config directory or the default
 * port). Watchdogs off: such a server must still exit when stdin closes.
 */
async function isolatedEnv(): Promise<Record<string, string>> {
  return cleanEnv({
    BROWSER_MCP_HOME: makeTempDir("cli-home"),
    BROWSER_MCP_PORT: String(await freePort()),
    BROWSER_AUTO_LAUNCH: "0",
    BROWSER_MCP_NO_CLIENT_PING: "1",
    BROWSER_MCP_NO_PARENT_CHECK: "1",
  });
}

/** Runs the CLI to completion (it must exit by itself within the timeout). */
async function runCli(args: string[], timeoutMs = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnServer(args, await isolatedEnv());
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

describe("help and version", () => {
  test("--help / -h print the usage on stdout and exit 0", async () => {
    const [long, short] = await Promise.all([runCli(["--help"]), runCli(["-h"])]);
    for (const r of [long, short]) {
      expect(r.code).toBe(0);
      expect(r.stdout).toStartWith(`browser-mcp ${pkg.version} - `);
      for (const flag of ["--port <n>", "--browser <name>", "--extension-id <id>", "--pair", "--allow-legacy-extension", "--toolsets <list>", "--help", "--version", "BROWSER_MCP_MAX_OUTPUT_CHARS"]) {
        expect(r.stdout).toContain(flag);
      }
      expect(r.stderr).not.toContain("ignoring unknown argument");
    }
    expect(short.stdout).toBe(long.stdout);
  }, SPAWN_TIMEOUT_MS);

  test("--version / -v print the package version and exit 0", async () => {
    const [long, short] = await Promise.all([runCli(["--version"]), runCli(["-v"])]);
    for (const r of [long, short]) {
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(pkg.version);
    }
  }, SPAWN_TIMEOUT_MS);
});

describe("flag parsing", () => {
  test("valid flags in every form are accepted silently", async () => {
    const forms = [
      ["--port", "9123", "--help"],
      ["-p", "9123", "--help"],
      ["--port=9123", "--help"],
      ["-p=9123", "--help"],
      ["9123", "--help"],
      ["--pair", "--allow-legacy-extension", "--help"],
      ["--toolsets", "core,network", "--toolsets=cookies", "--help"],
      ["--browser", "edge", "-b=chrome", "--extension-id", "abcdefghijklmnopabcdefghijklmnop,*", "--help"],
    ];
    const results = await Promise.all(forms.map((f) => runCli(f)));
    results.forEach((r, i) => {
      expect({ args: forms[i], code: r.code, stderr: r.stderr }).toEqual({ args: forms[i], code: 0, stderr: "" });
    });
  }, SPAWN_TIMEOUT_MS);

  test("parse checks run with an isolated config dir and port", async () => {
    const env = await isolatedEnv();
    expect(env.BROWSER_MCP_HOME).not.toBe("");
    expect(fs.readdirSync(env.BROWSER_MCP_HOME)).toEqual([]);
    expect(Number(env.BROWSER_MCP_PORT)).not.toBe(8765);
    expect(Number(env.BROWSER_MCP_PORT)).toBeGreaterThan(0);
  });

  test("unknown arguments are reported and ignored", async () => {
    const r = await runCli(["--bogus", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("[browser-mcp] ignoring unknown argument: --bogus");
  }, SPAWN_TIMEOUT_MS);

  test("invalid values exit 2 with a message naming the source", async () => {
    const cases: Array<[string[], string]> = [
      [["--port", "abc"], 'Invalid port from --port: "abc" (expected an integer 1-65535)'],
      [["-p", "70000"], 'Invalid port from -p: "70000"'],
      [["--port=0"], 'Invalid port from --port: "0"'],
      [["99999"], 'Invalid port from positional argument: "99999"'],
      [["-5"], 'Invalid port from positional argument: "-5"'],
      [["--port"], "Missing value for --port"],
      [["--toolsets"], "Missing value for --toolsets"],
      [["--toolsets", "--pair"], "Missing toolset list for --toolsets (e.g. core,network)"],
      [["--toolsets="], "Missing toolset list for --toolsets (e.g. core,network)"],
      [["--extension-id", "not-an-id"], 'Invalid extension id from --extension-id: "not-an-id"'],
      // --browser / -b must not swallow the next flag (-b --pair would drop --pair).
      [["-b", "--pair"], "Missing browser name for -b (chrome, edge, brave, opera or a path)"],
      [["--browser", "--toolsets", "all"], "Missing browser name for --browser"],
      [["--browser"], "Missing value for --browser"],
      [["--browser="], "Missing browser name for --browser"],
      [["-b=", "--help"], "Missing browser name for -b"],
      // An invalid value fails even when --help follows: parsing is in order.
      [["--port", "abc", "--help"], 'Invalid port from --port: "abc"'],
    ];
    const results = await Promise.all(cases.map(([args]) => runCli(args)));
    results.forEach((r, i) => {
      const [args, message] = cases[i];
      expect({ args, code: r.code, stdout: r.stdout }).toEqual({ args, code: 2, stdout: "" });
      expect(r.stderr).toContain(`[browser-mcp] ${message}`);
    });
  }, SPAWN_TIMEOUT_MS);
});

/** A port nobody listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("flags reach the server", () => {
  test("--port, --pair, --allow-legacy-extension and --toolsets take effect (MCP over stdio)", async () => {
    const home = makeTempDir("cli-home");
    // One install is paired already, so only --pair can open the pairing window.
    fs.writeFileSync(
      path.join(home, "extension-keys.json"),
      JSON.stringify({
        version: 1,
        installs: [{ extensionId: "abcdefghijklmnopabcdefghijklmnop", installId: "unit-test-install", key: "ab".repeat(32), pairedAt: new Date(0).toISOString(), browser: "chrome" }],
      })
    );
    const port = await freePort();
    const proc = spawnServer(
      ["--port", String(port), "--pair", "--allow-legacy-extension", "--toolsets", "network,bogus", "--toolsets=cookies"],
      cleanEnv({ BROWSER_MCP_HOME: home, BROWSER_MCP_NO_CLIENT_PING: "1", BROWSER_MCP_NO_PARENT_CHECK: "1" })
    );
    const killer = setTimeout(() => proc.kill(), 20000);
    let stderr = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true });
    })();

    // Newline-delimited JSON-RPC over stdio.
    const pending = new Map<number, (msg: any) => void>();
    const stdoutDone = (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
        }
      }
    })();
    let nextId = 1;
    const request = (method: string, params: unknown = {}) =>
      new Promise<any>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    try {
      const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "0" } });
      expect(init.result.serverInfo).toEqual({ name: "browser-mcp", version: pkg.version });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const list = await request("tools/list");
      const names: string[] = list.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("har_export");
      expect(names).toContain("cookies_list");
      expect(names).toContain("browser_status");
      expect(names).not.toContain("dom_click");

      const status = await request("tools/call", { name: "browser_status", arguments: {} });
      const body = JSON.parse(status.result.content[0].text);
      expect(body).toMatchObject({ connected: false, wsPort: port, mode: "primary", pairingOpen: true, pairedInstalls: 1, legacyExtensionAllowed: true });
      expect(path.resolve(body.configDir)).toBe(path.resolve(home));

      expect(stderr).toContain("pairing open for one new extension install for 10 min (--pair)");
      expect(stderr).toContain("WARNING: protocol-2 extensions are accepted WITHOUT authentication (--allow-legacy-extension)");
      expect(stderr).toContain("ignoring unknown toolset(s) from --toolsets: bogus");
      expect(stderr).toContain(`ws bridge on :${port} mode=primary`);
      expect(stderr).not.toContain("ignoring unknown argument");
    } finally {
      // Closing stdin is how a client goes away: the server must shut down by itself.
      proc.stdin.end();
      const code = await proc.exited;
      clearTimeout(killer);
      await Promise.all([stdoutDone, stderrDone]);
      expect(code).toBe(0);
      expect(stderr).toContain("shutting down (stdin-");
    }
  }, SPAWN_TIMEOUT_MS);
});
