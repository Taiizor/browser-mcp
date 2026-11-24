/**
 * Smoke test for the standalone server binary (bun run build:binary).
 *
 * Starts the binary the way an MCP client does: over stdio, with a free --port and
 * a throwaway BROWSER_MCP_HOME, inside a hostile project folder whose bunfig.toml
 * preloads a script and whose .env sets BROWSER_MCP_TOOLSETS=all. Two sessions:
 *   1. default toolsets: one MCP initialize request must get a JSON-RPC result
 *      naming browser-mcp at the package.json version; tools/list must answer;
 *   2. --toolsets all: tools/list must list more tools than session 1, which shows
 *      that the whole tool layer is in the bundle and that session 1 did not pick
 *      up the project's .env;
 * each session must exit with code 0 when stdin closes (EOF), and the project's
 * bunfig.toml preload must never run. No browser and no extension are needed.
 * Works on Windows, Linux and macOS.
 *
 *   bun scripts/ci/smoke-binary.ts [path/to/binary]
 *   (default: mcp-server/dist/browser-mcp, or browser-mcp.exe on Windows)
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const T0 = performance.now();
const elapsed = () => `${((performance.now() - T0) / 1000).toFixed(1)}s`;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp-server", "package.json"), "utf8"));
const binary = path.resolve(
  process.argv[2] ?? path.join(ROOT, "mcp-server", "dist", process.platform === "win32" ? "browser-mcp.exe" : "browser-mcp")
);

// A cold start of a ~100 MB executable can be slow on CI (virus scanning on Windows).
const START_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 15_000;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "browser-mcp-smoke-"));
const project = path.join(work, "project");
const marker = path.join(work, "preload-ran");

function cleanup() {
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
}

function die(msg: string, stderr?: string): never {
  if (stderr !== undefined) {
    console.log("---- server stderr ----");
    console.log(stderr.trim() || "(empty)");
  }
  cleanup(); // best effort: Windows may still hold the folder of a dying process
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(process.env.GITHUB_ACTIONS === "true" ? `::error::${esc(msg)}` : `error: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(binary)) die(`binary not found: ${binary} (run bun run build:binary in mcp-server first)`);

fs.mkdirSync(project);
// The binary is built with --no-compile-autoload-bunfig and --no-compile-autoload-dotenv:
// a project's bunfig.toml must not run code in the server, and its .env must not
// configure it (BROWSER_MCP_TOOLSETS is one of the keys env.ts would let through).
fs.writeFileSync(path.join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
fs.writeFileSync(
  path.join(project, "preload.ts"),
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`
);
fs.writeFileSync(path.join(project, ".env"), "BROWSER_MCP_TOOLSETS=all\n");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// Deterministic environment: nothing from the developer's own browser-mcp setup.
function sessionEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^BROWSER/i.test(k)) env[k] = v;
  }
  return { ...env, BROWSER_MCP_HOME: home, BROWSER_AUTO_LAUNCH: "0", BROWSER_MCP_NO_CLIENT_PING: "1" };
}

type Session = { init: any; tools: { name: string }[] };

async function session(label: string, extraArgs: string[]): Promise<Session> {
  const home = path.join(work, `home-${label}`);
  fs.mkdirSync(home);
  const port = await freePort();
  console.log(`[${label}] ${path.basename(binary)} --port ${port} ${extraArgs.join(" ")}`.trimEnd());
  const proc = Bun.spawn([binary, "--port", String(port), ...extraArgs], {
    cwd: project,
    env: sessionEnv(home),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stderr = "";
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) stderr += dec.decode(chunk, { stream: true });
  })();

  // stdout carries newline-delimited JSON-RPC messages only.
  const messages: any[] = [];
  // An object, so TypeScript does not narrow a callback set in another closure to null.
  const waiter: { wake: (() => void) | null } = { wake: null };
  let stdoutClosed = false;
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          messages.push({ __invalid: line });
        }
        waiter.wake?.();
      }
    }
    stdoutClosed = true;
    waiter.wake?.();
  })();

  const fail = (msg: string): never => {
    try {
      proc.kill();
    } catch {}
    die(`[${label}] ${msg}`, stderr);
  };

  const reply = async (id: number, timeoutMs: number): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const bad = messages.find((m) => m.__invalid);
      if (bad) fail(`stdout is not JSON-RPC: ${String(bad.__invalid).slice(0, 200)}`);
      const m = messages.find((m) => m.id === id && ("result" in m || "error" in m));
      if (m) return m;
      if (stdoutClosed || proc.exitCode !== null) fail(`the server exited (code ${proc.exitCode}) before answering request ${id}`);
      const left = deadline - Date.now();
      if (left <= 0) fail(`no reply to request ${id} within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 250));
        waiter.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      waiter.wake = null;
    }
  };

  const send = (msg: object) => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
    proc.stdin.flush();
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browser-mcp-ci-smoke", version: "0" } },
  });
  const init = await reply(1, START_TIMEOUT_MS);
  if (init.jsonrpc !== "2.0" || !init.result) fail(`initialize did not return a result: ${JSON.stringify(init).slice(0, 500)}`);
  const info = init.result.serverInfo ?? {};
  console.log(`[${label}] initialize: ${info.name} ${info.version}, protocol ${init.result.protocolVersion} (${elapsed()})`);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await reply(2, REPLY_TIMEOUT_MS);
  const tools: { name: string }[] = list.result?.tools;
  if (!Array.isArray(tools) || !tools.length) fail(`tools/list returned no tools: ${JSON.stringify(list).slice(0, 500)}`);
  console.log(`[${label}] tools/list: ${tools.length} tools (${elapsed()})`);

  // stdin EOF must end the server cleanly (MCP clients close the pipe to stop it).
  proc.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    proc.exited,
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), EXIT_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
  if (code === null) fail(`the server did not exit within ${EXIT_TIMEOUT_MS} ms after stdin EOF`);
  if (code !== 0) fail(`the server exited with code ${code} after stdin EOF, expected 0`);
  console.log(`[${label}] exit code 0 after stdin EOF (${elapsed()})`);
  return { init, tools };
}

const core = await session("default", []);
const info = core.init.result.serverInfo ?? {};
if (info.name !== "browser-mcp") die(`serverInfo.name is ${JSON.stringify(info.name)}, expected "browser-mcp"`);
if (info.version !== pkg.version) die(`serverInfo.version is ${JSON.stringify(info.version)}, expected package.json ${pkg.version}`);
if (!core.init.result.capabilities?.tools) die("the initialize result has no tools capability");
if (!core.tools.some((t) => t.name === "browser_status")) die("the default tool list has no browser_status");
if (fs.existsSync(marker)) die("the binary ran the working directory's bunfig.toml preload");

const all = await session("all", ["--toolsets", "all"]);
if (all.tools.length <= core.tools.length) {
  die(
    `the default session listed ${core.tools.length} tools and --toolsets all ${all.tools.length}: ` +
      "either the bundle lacks tools or the binary loaded BROWSER_MCP_TOOLSETS=all from the project's .env"
  );
}

if (fs.existsSync(marker)) die("the binary ran the working directory's bunfig.toml preload");
console.log("project bunfig.toml preload and .env were ignored");

cleanup();
console.log("ok    standalone binary smoke test passed");
process.exit(0);
