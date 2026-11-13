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
 * Everything here is pure (no process exit, no logging) so it can be unit-tested;
 * `isolate-env.ts` applies it to the real process at startup.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PORT = 8765;

/**
 * The files Bun loads automatically, lowest precedence first (checked against Bun 1.4):
 * `.env`, `.env.<mode>`, `.env.local` (not in test mode) and `.env.<mode>.local`, where the
 * mode is `NODE_ENV` or `development` when it is unset.
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
  "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "NODE_ENV",
]);

export type EnvScrub = {
  /** Env files of the working directory that were read (relative names). */
  files: string[];
  /** Variables removed from the environment, in file order. */
  removed: string[];
};

export type ScrubOptions = {
  cwd: string;
  /** The environment to clean in place (`process.env` at startup). */
  env: Record<string, string | undefined>;
  /** Runtime flags (`process.execArgv`): `--no-env-file` means nothing was loaded. */
  execArgv: readonly string[];
  /** Only Bun loads env files on its own. */
  isBun: boolean;
  readFile?: (file: string) => string | null;
};

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Removes what Bun loaded from the working directory's env files. A variable goes only when
 * its current value is exactly the one the files define: the real environment wins over env
 * files in Bun, so a different value came from the client config or the shell and stays.
 * `BROWSER_MCP_*` variables are this server's own settings and stay as well.
 */
export function scrubWorkingDirEnv(options: ScrubOptions): EnvScrub {
  const result: EnvScrub = { files: [], removed: [] };
  if (!options.isBun || options.execArgv.includes("--no-env-file")) return result;
  const read = options.readFile ?? readOrNull;
  const defined = new Map<string, string>();
  for (const name of autoloadedEnvFiles(options.env.NODE_ENV)) {
    const text = read(path.join(options.cwd, name));
    if (text === null) continue;
    result.files.push(name);
    for (const [key, value] of parseEnvText(text)) defined.set(key, value); // later files win, like Bun
  }
  for (const [key, value] of defined) {
    if (/^BROWSER_MCP_/i.test(key) || KEEP.has(key.toUpperCase())) continue;
    if (options.env[key] === value) {
      delete options.env[key];
      result.removed.push(key);
    }
  }
  return result;
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
