/**
 * Environment hygiene for a server that runs inside other people's projects.
 *
 * MCP clients (Claude Code, OpenCode, Cursor, Gemini CLI, ...) start this server with the
 * working directory set to whatever project the agent is working on, and Bun loads that
 * project's `.env` files into `process.env` before any code runs (unless it was started with
 * `bun --no-env-file`). Their `PORT`, `BROWSER`, `CHROME_PATH` or secrets belong to that
 * project, not to this server: `scrubWorkingDirEnv` removes them again, and the bridge port
 * never comes from the generic `PORT` variable (see `resolvePort`).
 *
 * Bun also applies the working directory's `bunfig.toml` (preload, define) to every process it
 * starts there, before any of this code runs. Only `bun --config=<trusted file>` (with `=`),
 * a launcher that re-runs the server that way (`bin/browser-mcp.js`) or a standalone binary built
 * with `--no-compile-autoload-bunfig` avoids that; `findUntrustedBunfig` lets the server warn.
 *
 * Everything here is pure (no process exit, no logging) so it can be unit-tested;
 * `isolate-env.ts` applies it to the real process at startup.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PORT = 8765;

/**
 * The files Bun loads automatically, lowest precedence first (checked against Bun 1.4):
 * `.env`, `.env.<mode>`, `.env.local` (not in test mode) and `.env.<mode>.local`, where the
 * mode is `NODE_ENV` or `development` when it is unset (the real environment's `NODE_ENV`:
 * Bun picks the mode before it loads the files, see `scrubWorkingDirEnv`).
 */
export function autoloadedEnvFiles(nodeEnv: string | undefined): string[] {
  const mode = (nodeEnv ?? "").trim() || "development";
  const files = [".env", `.env.${mode}`];
  if (mode !== "test") files.push(".env.local");
  files.push(`.env.${mode}.local`);
  return files;
}

function closingQuote(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (body[i] === quote) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
}

/**
 * A small dotenv parser for the plain forms Bun accepts: `KEY=value`, `export KEY=value`,
 * spaces around `=`, `# comments`, and single, double or backtick quoted values (double quoted
 * ones may span lines and use `\n`-style escapes). It does not expand `$VAR`. A value it reads
 * differently from Bun merely fails the equality check in `scrubWorkingDirEnv` and is kept,
 * so a parser gap can never remove a real variable.
 */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let body = rest.slice(1);
      let end = closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += "\n" + lines[++i];
        end = closingQuote(body, quote);
      }
      if (end < 0) continue; // unterminated quote: not recognised
      const raw = body.slice(0, end);
      out.set(key, quote === '"' ? unescapeDoubleQuoted(raw) : raw);
      continue;
    }
    const comment = rest.search(/(^|\s)#/);
    out.set(key, (comment >= 0 ? rest.slice(0, comment) : rest).trim());
  }
  return out;
}

/** OS essentials that are never removed, even if a project's env file repeats them verbatim. */
const KEEP = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "NODE_ENV",
]);

/**
 * Temp directory variables. `os.tmpdir()` reads them live from `process.env` (checked with Bun
 * 1.3.3 and 1.4.5 on Windows, 1.4.4 on Linux): `TEMP`, then `TMP`, then `%SystemRoot%\temp` on
 * Windows; `TMPDIR`, `TMP`, `TEMP`, then `/tmp` elsewhere. The temp directory receives saved
 * tool output and is a default upload root, so a project's env file must not pick it.
 *
 * Bun never lets an env file override a variable the real environment has (on Windows whatever
 * the case of the name), so a temp variable holding the file's value was either missing from the
 * real environment (usual for TMPDIR on Linux, and in an MCP client's default environment on
 * macOS) or is a verbatim repeat. Both are removed like any other project variable; os.tmpdir()
 * then falls back to a real variable or /tmp, never to a directory the project chose.
 *
 * Windows defines TEMP and TMP in every session (and libuv, under Node- or Bun-based clients, hands
 * every child the parent's TEMP even when the client's env leaves it out), and env dumps repeat
 * them, so there a value that names the standard per-user temp directory (`%LOCALAPPDATA%\Temp`)
 * stays; any other value the files gave is removed (os.tmpdir() falls back to the other variable
 * or `%SystemRoot%\temp`).
 */
const WINDOWS_TEMP_VARS = new Set(["TEMP", "TMP"]);

function windowsPathKey(p: string, realpath: (file: string) => string | null): string {
  // realpath also expands 8.3 short names (C:\Users\FIRSTN~1\...) and fixes the case.
  return (realpath(p) ?? path.win32.resolve(p)).replace(/[\\/]+$/, "").toLowerCase();
}

/** Whether a Windows temp variable names the user's standard temp directory. */
function isStandardWindowsTemp(
  value: string,
  env: Record<string, string | undefined>,
  realpath: (file: string) => string | null,
): boolean {
  const local = env.LOCALAPPDATA;
  if (!local || !path.win32.isAbsolute(local) || !path.win32.isAbsolute(value)) return false;
  return windowsPathKey(value, realpath) === windowsPathKey(path.win32.join(local, "Temp"), realpath);
}

/**
 * The only `BROWSER_MCP_*` settings a project's env file may provide: they pick the port, the
 * tool selection, the output budget and watchdog timings. Every other key of the namespace
 * decides whom the server trusts or where its secrets live (`EXTENSION_IDS`, `HOME`, `PAIR`,
 * `ALLOW_LEGACY_EXTENSION`, `UPLOAD_DIRS`, and any key added later), so it has to come from the
 * client config or the shell, never from a repository the agent happens to work in.
 */
export const PROJECT_ENV_ALLOWED: readonly string[] = [
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
];

const ALLOWED_OWN = new Set(PROJECT_ENV_ALLOWED);

export type EnvScrub = {
  /** Env files of the working directory that were read (relative names). */
  files: string[];
  /** Variables removed from the environment, in file order (`BROWSER_MCP_*` ones are in `blocked`). */
  removed: string[];
  /** `BROWSER_MCP_*` settings outside `PROJECT_ENV_ALLOWED` that were removed, in file order. */
  blocked: string[];
};

export type ScrubOptions = {
  cwd: string;
  /** The environment to clean in place (`process.env` at startup). */
  env: Record<string, string | undefined>;
  /** Runtime flags (`process.execArgv`): `--no-env-file` means nothing was loaded. */
  execArgv: readonly string[];
  /** Only Bun loads env files on its own. */
  isBun: boolean;
  /** `Bun.version`; older releases accept `--no-env-file` but load the files anyway. */
  bunVersion?: string;
  /** Decides how the temp variables are judged (default `process.platform`). */
  platform?: NodeJS.Platform;
  readFile?: (file: string) => string | null;
  /** Canonical path of an existing file or null (default: `fs.realpathSync.native`). */
  realpath?: (file: string) => string | null;
};

/** The first Bun release whose `--no-env-file` really skips the files (1.3.2 accepts the flag and still loads them). */
export const MIN_BUN_NO_ENV_FILE = "1.3.3";

function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(/[.+-]/).map((n) => Number.parseInt(n, 10));
  const b = min.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < b.length; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

/** Whether Bun skipped the working directory's env files for this process. */
export function envFilesSkipped(execArgv: readonly string[], bunVersion: string | undefined): boolean {
  if (!execArgv.includes("--no-env-file")) return false;
  return bunVersion === undefined || versionAtLeast(bunVersion, MIN_BUN_NO_ENV_FILE);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function nativeRealpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
}

/**
 * Removes what Bun loaded from the working directory's env files. A variable goes only when
 * its current value is exactly the one the files define: the real environment wins over env
 * files in Bun, so a different value came from the client config or the shell and stays.
 * Of this server's own `BROWSER_MCP_*` settings only the harmless `PROJECT_ENV_ALLOWED` ones
 * may come from those files; the others are removed and reported separately (`blocked`).
 * The temp directory variables follow the same rule, except a standard one on Windows (`WINDOWS_TEMP_VARS`).
 *
 * Bun picks the mode from the real `NODE_ENV` before it loads anything, so a `NODE_ENV` the files
 * set themselves does not name the files Bun read: with none in the real environment Bun loaded
 * the development set, whatever `NODE_ENV` it ends up with. When the development set defines the
 * current `NODE_ENV`, that mode is checked as well. Each mode is judged on its own merged values
 * (what Bun would have applied for it), never on a merge of both, where a later file of one mode
 * could hide the value Bun took from the other.
 */
export function scrubWorkingDirEnv(options: ScrubOptions): EnvScrub {
  const result: EnvScrub = { files: [], removed: [], blocked: [] };
  if (!options.isBun || envFilesSkipped(options.execArgv, options.bunVersion)) return result;
  const read = options.readFile ?? readOrNull;
  const platform = options.platform ?? process.platform;
  const parsed = new Map<string, Map<string, string> | null>();
  const load = (name: string): Map<string, string> | null => {
    if (!parsed.has(name)) {
      const text = read(path.join(options.cwd, name));
      parsed.set(name, text === null ? null : parseEnvText(text));
    }
    return parsed.get(name) ?? null;
  };
  /** The values Bun applies for one mode, and the files they come from. */
  const modeValues = (nodeEnv: string | undefined) => {
    const defined = new Map<string, string>();
    const files: string[] = [];
    for (const name of autoloadedEnvFiles(nodeEnv)) {
      const vars = load(name);
      if (!vars) continue;
      files.push(name);
      for (const [key, value] of vars) defined.set(key, value); // later files win, like Bun
    }
    return { defined, files };
  };

  const current = options.env.NODE_ENV;
  const modes = [modeValues(current)];
  if (current !== undefined && autoloadedEnvFiles(current).join("|") !== autoloadedEnvFiles(undefined).join("|")) {
    const development = modeValues(undefined);
    const setsCurrent = [...development.defined].some(
      ([key, value]) => (platform === "win32" ? key.toUpperCase() === "NODE_ENV" : key === "NODE_ENV") && value === current,
    );
    if (setsCurrent) modes.push(development);
  }
  for (const mode of modes) {
    for (const name of mode.files) if (!result.files.includes(name)) result.files.push(name);
  }

  for (const { defined } of modes) {
    for (const [key, value] of defined) {
      const upper = key.toUpperCase(); // Windows env names are case-insensitive
      if (KEEP.has(upper) || ALLOWED_OWN.has(upper)) continue;
      if (options.env[key] !== value) continue; // also skips a key an earlier mode removed
      if (
        platform === "win32" &&
        WINDOWS_TEMP_VARS.has(upper) &&
        isStandardWindowsTemp(value, options.env, options.realpath ?? nativeRealpathOrNull)
      ) {
        continue;
      }
      delete options.env[key];
      (upper.startsWith("BROWSER_MCP_") ? result.blocked : result.removed).push(key);
    }
  }
  return result;
}

/**
 * The stderr lines that report a scrub: names only, never values (they can be secrets).
 * Removed `BROWSER_MCP_*` settings get their own line, listed in full, because they are the
 * security-relevant ones.
 */
export function describeScrub(scrub: EnvScrub, cwd: string): string[] {
  const lines: string[] = [];
  const from = `${scrub.files.join(", ")} in ${cwd}`;
  if (scrub.removed.length) {
    const shown = scrub.removed.slice(0, 8).join(", ") + (scrub.removed.length > 8 ? ", …" : "");
    lines.push(
      `[browser-mcp] ignored ${scrub.removed.length} variable(s) Bun loaded from ${from} (${shown}); ` +
        `start the server with "bun --no-env-file run …" to skip loading them`,
    );
  }
  if (scrub.blocked.length) {
    lines.push(
      `[browser-mcp] ignored ${scrub.blocked.join(", ")} from ${from}: a project's env files may only set ` +
        `${PROJECT_ENV_ALLOWED.join(", ")}; set the others in the MCP client config or the shell`,
    );
  }
  return lines;
}

export type BunfigCheckOptions = {
  cwd: string;
  /** Runtime flags (`process.execArgv`). */
  execArgv: readonly string[];
  /** Only Bun reads bunfig.toml. */
  isBun: boolean;
  /** `Bun.main`: the entry file, inside Bun's virtual `/$bunfs/` (`B:/~BUN/` on Windows) in a standalone binary. */
  main: string;
  /** The bunfig.toml shipped with this server (`mcp-server/bunfig.toml`). */
  trustedConfig: string;
  readFile?: (file: string) => string | null;
  realpath?: (file: string) => string | null;
};

/** `--config=<file>` is the only form Bun 1.4 honours: `--config <file>`, `-c <file>` and `-c=<file>` still read the cwd file, so a project's bunfig.toml preload runs. */
export function hasExplicitConfig(execArgv: readonly string[]): boolean {
  return execArgv.some((arg) => arg.startsWith("--config="));
}

/** A `bun build --compile` executable runs its entry from a virtual file system, never from disk. */
export function isStandaloneExecutable(main: string): boolean {
  return /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main);
}

function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The working directory's bunfig.toml when Bun has (probably) applied it to this process, or null.
 * Bun reads `$cwd/bunfig.toml` (not a parent's, not `.bunfig.toml`) unless it was started with
 * `--config=<file>`; a standalone binary built by `scripts/build-binaries.ts` reads none (it is
 * compiled with `--no-compile-autoload-bunfig` and `--compile-exec-argv=--no-env-file`; the
 * latter is how a binary from that script is recognised). The shipped config itself, or a
 * byte-identical copy, is harmless.
 */
export function findUntrustedBunfig(options: BunfigCheckOptions): string | null {
  if (!options.isBun || hasExplicitConfig(options.execArgv)) return null;
  if (isStandaloneExecutable(options.main) && options.execArgv.includes("--no-env-file")) return null;
  const read = options.readFile ?? readOrNull;
  const real = options.realpath ?? realpathOrNull;
  const file = path.join(options.cwd, "bunfig.toml");
  const text = read(file);
  if (text === null) return null;
  const trusted = real(options.trustedConfig);
  if (trusted !== null && real(file) === trusted) return null;
  if (text === read(options.trustedConfig)) return null;
  return file;
}

export type PortChoice = {
  port: number;
  source: "cli" | "BROWSER_MCP_PORT" | "default";
  /** A generic PORT that was present and deliberately not used. */
  ignoredPort?: string;
};

/**
 * Bridge port: `--port` → `BROWSER_MCP_PORT` → 8765. The generic `PORT` is never used: it is
 * the HTTP port of whatever project the client runs in (its `.env`, its dev scripts), and
 * binding it would both take that project's port and miss the extension (default 8765).
 */
export function resolvePort(
  cliPort: number | undefined,
  env: Record<string, string | undefined>,
  parse: (raw: string, source: string) => number,
): PortChoice {
  const generic = (env.PORT ?? "").trim();
  const ignoredPort = generic ? generic : undefined;
  if (cliPort !== undefined) return { port: cliPort, source: "cli", ignoredPort };
  const own = env.BROWSER_MCP_PORT;
  if (own !== undefined && own.trim() !== "") {
    return { port: parse(own, "BROWSER_MCP_PORT"), source: "BROWSER_MCP_PORT", ignoredPort };
  }
  return { port: DEFAULT_PORT, source: "default", ignoredPort };
}
