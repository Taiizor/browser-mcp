// Must stay the first import: drops what Bun loaded from the working directory's .env files
// before any other module reads the environment (see env.ts).
import "./isolate-env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmptyResultSchema, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BridgeClient, ExtensionBridge, type IBridge, SERVER_VERSION } from "./bridge.js";
import { resolvePort as resolveBridgePort } from "./env.js";
import { createServer } from "./server.js";
import { errMessage, pruneStaleSpillDirs, removeSpillDir } from "./tool-kit.js";

// Process entry point: CLI parsing, bridge start-up (primary or satellite),
// the stdio transport and the watchdogs. Tools, resources and prompts are
// built by createServer() in server.ts, which has no side effects of its own.

// ---------- CLI ----------
// Invalid explicit values are fatal: silently falling back to the default
// port would bind (or join) a different bridge than the one the user asked for.
function cliFail(message: string): never {
  console.error(`[browser-mcp] ${message}`);
  process.exit(2);
}

function parsePortValue(raw: string, source: string): number {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) cliFail(`Invalid port from ${source}: "${raw}" (expected an integer 1-65535)`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) cliFail(`Invalid port from ${source}: "${raw}" (expected an integer 1-65535)`);
  return n;
}

const EXTENSION_ID_RE = /^(?:[a-p]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function parseExtensionIdList(raw: string, source: string): string[] {
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase().replace(/^\{|\}$/g, "");
    if (!id) continue;
    // "*" = accept any extension id (legacy mode, same as BROWSER_MCP_EXTENSION_IDS=*).
    if (id !== "*" && !EXTENSION_ID_RE.test(id)) {
      cliFail(`Invalid extension id from ${source}: "${part.trim()}" (expected a 32-char Chromium id a-p, a Firefox UUID, or *)`);
    }
    ids.push(id);
  }
  if (!ids.length) cliFail(`Missing extension id for ${source}`);
  return ids;
}

const USAGE = `browser-mcp ${SERVER_VERSION} - MCP server for the Browser MCP extension (speaks MCP over stdio;
an MCP client starts it, see README.md for client configuration).

Options:
  -p, --port <n>              Bridge port (default: BROWSER_MCP_PORT, else 8765); also --port=<n> or a bare <n>
  -b, --browser <name>        Browser to auto-launch: chrome, edge, brave, opera (overrides BROWSER)
  --extension-id <id>         Trust an extension id (repeatable, comma separated, * = any extension)
  --pair                      Pair one new extension install within 10 minutes (BROWSER_MCP_PAIR=1)
  --allow-legacy-extension    Accept 0.3.x extensions over an UNAUTHENTICATED link (BROWSER_MCP_ALLOW_LEGACY_EXTENSION=1)
  --toolsets <list>           Toolsets to list, comma separated: core (default), all, or categories such as
                              network, cookies, storage, emulation, performance (BROWSER_MCP_TOOLSETS);
                              the browser_toolsets tool lists and changes them at runtime
  -h, --help                  Show this help and exit
  -v, --version               Print the version and exit

Environment: BROWSER_MCP_MAX_OUTPUT_CHARS caps the text of one tool result (default 40000); longer text
is cut and saved to a private temp folder that is removed when the server exits (cookie, storage,
session and clipboard text is cut but never saved).`;

type CliOptions = {
  port?: number;
  browser?: string;
  extensionIds: string[];
  // undefined when the flag is absent, so the bridge falls back to the env
  // switch (an explicit option wins over env).
  pair?: boolean;
  allowLegacyExtension?: boolean;
  // Raw comma lists, validated by createServer (unknown ids: warning).
  toolsets?: string[];
};

function parseCli(argv: string[]): CliOptions {
  const out: CliOptions = { extensionIds: [] };
  const takeValue = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) cliFail(`Missing value for ${flag}`);
    return argv[i + 1];
  };
  const setBrowser = (raw: string, flag: string) => {
    // "-b --pair" must not swallow the next flag as the browser name.
    if (!raw.trim() || raw.startsWith("-")) cliFail(`Missing browser name for ${flag} (chrome, edge, brave, opera or a path)`);
    out.browser ??= raw;
  };
  const addToolsets = (raw: string, flag: string) => {
    // "--toolsets --pair" must not swallow the next flag as the list.
    if (!raw.trim() || raw.startsWith("-")) cliFail(`Missing toolset list for ${flag} (e.g. core,network)`);
    (out.toolsets ??= []).push(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let m: RegExpMatchArray | null;
    if (arg === "--port" || arg === "-p") {
      const port = parsePortValue(takeValue(i, arg), arg);
      out.port ??= port;
      i++;
    } else if ((m = arg.match(/^(--port|-p)=(.*)$/))) {
      const port = parsePortValue(m[2], m[1]);
      out.port ??= port;
    } else if (arg === "--browser" || arg === "-b") {
      setBrowser(takeValue(i, arg), arg);
      i++;
    } else if ((m = arg.match(/^(--browser|-b)=(.*)$/))) {
      setBrowser(m[2], m[1]);
    } else if (arg === "--extension-id") {
      out.extensionIds.push(...parseExtensionIdList(takeValue(i, arg), arg));
      i++;
    } else if ((m = arg.match(/^--extension-id=(.*)$/))) {
      out.extensionIds.push(...parseExtensionIdList(m[1], "--extension-id"));
    } else if (arg === "--pair") {
      out.pair = true;
    } else if (arg === "--allow-legacy-extension") {
      out.allowLegacyExtension = true;
    } else if (arg === "--toolsets") {
      addToolsets(takeValue(i, arg), arg);
      i++;
    } else if ((m = arg.match(/^--toolsets=(.*)$/))) {
      addToolsets(m[1], "--toolsets");
    } else if (arg === "--help" || arg === "-h") {
      // stdout: nothing else runs, so no MCP client is reading it.
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log(SERVER_VERSION);
      process.exit(0);
    } else if (/^[+-]?\d/.test(arg)) {
      // Positional port (legacy form: `index.ts 9000`). Must be a clean integer.
      const port = parsePortValue(arg, "positional argument");
      out.port ??= port;
    } else {
      console.error(`[browser-mcp] ignoring unknown argument: ${arg}`);
    }
  }
  return out;
}

const CLI = parseCli(process.argv.slice(2));

function resolvePort(): number {
  // --port -> BROWSER_MCP_PORT -> 8765. The generic PORT belongs to the project or shell the
  // client runs in and is never used (env.ts).
  const choice = resolveBridgePort(CLI.port, process.env, parsePortValue);
  if (choice.ignoredPort !== undefined && choice.source === "default") {
    console.error(
      `[browser-mcp] ignoring PORT=${choice.ignoredPort} (it belongs to the project or shell the client runs in); ` +
        `using ${choice.port} - set BROWSER_MCP_PORT or --port to choose the bridge port`
    );
  }
  return choice.port;
}

const PORT = resolvePort();

// Multi-agent sharing: the first process owns the WS bridge (primary),
// later processes join it as satellite clients instead of failing on
// EADDRINUSE. All satellites relay through the single extension socket.
// NOTE: stdio MCP requires one OS process per MCP client session, so N agent
// sessions = N processes (1 primary + N-1 satellites) sharing one browser.
// That is expected — see browser_status (mode/pid/peers) to tell them apart.
// Each satellite attempt already retries internally (failover / takeover) for
// a bounded time (~15 s) before ready() rejects, so one extra outer round is
// enough and keeps the worst-case startup failure around half a minute.
const BRIDGE_START_ATTEMPTS = 2;

type BridgeCliOptions = Pick<CliOptions, "extensionIds" | "pair" | "allowLegacyExtension">;

async function createBridge(port: number, { extensionIds, pair, allowLegacyExtension }: BridgeCliOptions): Promise<IBridge> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= BRIDGE_START_ATTEMPTS; attempt++) {
    const primary = new ExtensionBridge(port, { exitOnAddrInUse: false, extensionIds, pair, allowLegacyExtension });
    try {
      await primary.ready();
      console.error(`[browser-mcp:${process.pid}] primary bridge on :${port} (ppid=${process.ppid})`);
      return primary;
    } catch (e) {
      try {
        primary.close();
      } catch {}
      const code = (e as { code?: string })?.code;
      // Only "port already taken" means another bridge may own it. Any other
      // bind error (EACCES on a Windows excluded port range, EADDRNOTAVAIL...)
      // must fail with its real cause instead of a misleading satellite error.
      if (code !== "EADDRINUSE") {
        const hint =
          code === "EACCES"
            ? " The port may be reserved by the OS (Windows: `netsh interface ipv4 show excludedportrange protocol=tcp`)."
            : "";
        throw new Error(
          `Cannot bind the browser-mcp bridge on 127.0.0.1:${port} (${code ?? "error"}: ${errMessage(e)}).${hint} Choose another port with --port or BROWSER_MCP_PORT (and set the same port in the extension popup).`
        );
      }
    }
    console.error(`[browser-mcp:${process.pid}] port ${port} in use, joining as satellite client`);
    // A satellite promoted to primary keeps the same trust list and pairing options.
    const client = new BridgeClient(port, { extensionIds, pair, allowLegacyExtension });
    try {
      await client.ready();
      console.error(`[browser-mcp:${process.pid}] satellite connected to primary on :${port}`);
      return client;
    } catch (e) {
      lastError = e;
      try {
        client.close();
      } catch {}
      if (attempt >= BRIDGE_START_ATTEMPTS) break;
      // The primary may be restarting (old process shutting down): retry the
      // primary bind first, then the satellite link, with backoff.
      const delay = Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      console.error(
        `[browser-mcp:${process.pid}] satellite link failed (${errMessage(e)}), retry ${attempt}/${BRIDGE_START_ATTEMPTS - 1} in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  // "In use" but nobody answers: typically a port reserved by the OS (on
  // Windows, binding an excluded port range can surface as EADDRINUSE).
  const hint = /ECONNREFUSED/.test(errMessage(lastError))
    ? " Binding the port failed although nothing accepts connections on it; it may be reserved by the OS (Windows: `netsh interface ipv4 show excludedportrange protocol=tcp`). Choose another port with --port or BROWSER_MCP_PORT (and set the same port in the extension popup)."
    : "";
  throw new Error(
    `Could not start or join the browser-mcp bridge on :${port} after ${BRIDGE_START_ATTEMPTS} attempts: ${errMessage(lastError)}.${hint}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- start ----------
async function main() {
  // CLI wins over env for browser selection (bridge reads process.env.BROWSER).
  const browserFlag = CLI.browser;
  if (browserFlag && browserFlag.trim()) process.env.BROWSER = browserFlag.trim();
  // Oversized tool output is spilled into one private temp folder per
  // process: remove it on every exit path, and sweep the folders that
  // crashed or killed processes left behind (older than 24 h).
  process.on("exit", removeSpillDir);
  const pruned = pruneStaleSpillDirs();
  if (pruned.length) console.error(`[browser-mcp:${process.pid}] removed ${pruned.length} stale spill folder(s) from the temp folder`);
  const bridge = await createBridge(PORT, {
    extensionIds: [...new Set(CLI.extensionIds)],
    pair: CLI.pair,
    allowLegacyExtension: CLI.allowLegacyExtension,
  });
  // Toolsets: --toolsets wins over BROWSER_MCP_TOOLSETS (read by createServer).
  const server = createServer(bridge, { toolsets: CLI.toolsets });

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[browser-mcp:${process.pid}] shutting down (${reason})`);
    try {
      bridge.close();
    } catch {}
    removeSpillDir();
    // The WS server keeps the event loop alive, so force-exit after a
    // short grace period for sockets to close cleanly.
    setTimeout(() => process.exit(0), 250).unref?.();
  };

  const transport = new StdioServerTransport();
  // Preserved across server.connect() (Protocol wraps a pre-set handler).
  transport.onclose = () => shutdown("transport-close");
  await server.connect(transport);
  console.error(`[browser-mcp:${process.pid}] stdio ready, ws bridge on :${PORT} mode=${bridge.mode}`);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // General fix for orphan servers: disabling the MCP in the agent closes
  // the stdio pipe but StdioServerTransport never calls close() on stdin
  // EOF, so without this the bun process lingers holding :PORT forever.
  // Opt out with BROWSER_MCP_NO_STDIO_EXIT=1.
  if (process.env.BROWSER_MCP_NO_STDIO_EXIT !== "1") {
    try {
      process.stdin.on("close", () => shutdown("stdin-close"));
      process.stdin.on("end", () => shutdown("stdin-end"));
    } catch {}
  }
  // Parent watchdog: if the launching agent died without delivering SIGTERM
  // (kill -9, crash, Task Manager), exit instead of squatting on the port.
  // A satellite whose agent is gone exits here too instead of promoting to
  // primary and living forever. Opt out with BROWSER_MCP_NO_PARENT_CHECK=1.
  const parentPid = process.ppid;
  const parentCheckMs = Number(process.env.BROWSER_MCP_PARENT_CHECK_MS ?? 10000);
  if (
    process.env.BROWSER_MCP_NO_PARENT_CHECK !== "1" &&
    parentPid > 1 &&
    Number.isFinite(parentCheckMs) &&
    parentCheckMs > 0
  ) {
    const timer = setInterval(() => {
      // Orphaned + reparented to init (Unix): original parent is gone.
      try {
        if (process.ppid !== parentPid && process.ppid <= 1) {
          clearInterval(timer);
          shutdown("parent-reparented");
          return;
        }
      } catch {}
      try {
        process.kill(parentPid, 0);
      } catch (e) {
        // ESRCH = no such process (parent gone). EPERM = alive, ignore.
        if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
          clearInterval(timer);
          shutdown("parent-gone");
        }
      }
    }, parentCheckMs);
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {}
  }
  // Client watchdog: the agent can stay alive with our stdio pipe open while
  // tearing down its MCP client (MCP disabled). Then there is no EOF and no
  // dead parent — but a server->client `ping` gets no answer. Exit after
  // consecutive ping timeouts instead of squatting on :PORT forever. Any
  // other reply (even a method error) proves the client lives and resets
  // the counter. Opt out with BROWSER_MCP_NO_CLIENT_PING=1.
  if (process.env.BROWSER_MCP_NO_CLIENT_PING !== "1") {
    const pingEvery = Number(process.env.BROWSER_MCP_CLIENT_PING_MS ?? 30000);
    const pingTimeout = Number(process.env.BROWSER_MCP_CLIENT_PING_TIMEOUT_MS ?? 10000);
    const failsNeededRaw = Number(process.env.BROWSER_MCP_CLIENT_PING_FAILS ?? 3);
    const failsNeeded = Number.isFinite(failsNeededRaw) && failsNeededRaw > 0 ? Math.floor(failsNeededRaw) : 3;
    if (Number.isFinite(pingEvery) && pingEvery > 0 && Number.isFinite(pingTimeout) && pingTimeout > 0) {
      let fails = 0;
      let inFlight = false;
      const timer = setInterval(async () => {
        if (shuttingDown || inFlight) return;
        inFlight = true;
        try {
          await server.server.request({ method: "ping" }, EmptyResultSchema, { timeout: pingTimeout });
          fails = 0;
        } catch (e) {
          // Only a timeout means "nobody home".
          if ((e as { code?: number })?.code === ErrorCode.RequestTimeout) {
            fails++;
            console.error(`[browser-mcp:${process.pid}] MCP client ping timeout (${fails}/${failsNeeded})`);
            if (fails >= failsNeeded) {
              clearInterval(timer);
              shutdown("client-unresponsive");
            }
          } else {
            fails = 0;
          }
        } finally {
          inFlight = false;
        }
      }, pingEvery);
      try {
        (timer as unknown as { unref?: () => void }).unref?.();
      } catch {}
    }
  }
}

main().catch((e) => {
  console.error(`[browser-mcp:${process.pid}] fatal: ${errMessage(e)}`);
  process.exit(1);
});
