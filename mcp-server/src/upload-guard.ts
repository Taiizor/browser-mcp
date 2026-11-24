// dom_upload path guard. A prompt-injected page or agent must not be able to
// turn a file input into an exfiltration channel for local secrets, so every
// path is checked here, in the server, before anything reaches the browser.
// Pure apart from the file-system probes (realpath / stat), which callers may
// replace, and with the environment passed in, so the rules can be unit tested
// for any platform.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Largest file dom_upload accepts (100 MiB). */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Most files one dom_upload call accepts. */
export const UPLOAD_MAX_FILES = 100;

/** Path-delimiter separated list of allowed upload folders; "*" allows any folder. */
export const UPLOAD_DIRS_ENV = "BROWSER_MCP_UPLOAD_DIRS";

/** Names of the rules a path can fail; carried by UploadRefusedError.rule. */
export type UploadRule =
  | "empty-path"
  | "too-many-files"
  | "not-absolute"
  | "unsupported-path"
  | "network-path"
  | "hidden-segment"
  | "secret-name"
  | "spill-file"
  | "not-found"
  | "outside-roots"
  | "not-a-file"
  | "too-large";

/** A path quoted for an error message: control characters replaced, long ones cut. */
function showPath(p: string): string {
  const clean = p.replace(/[\u0000-\u001f\u007f]/g, "?");
  return `"${clean.length > 300 ? clean.slice(0, 299) + "…" : clean}"`;
}

export class UploadRefusedError extends Error {
  constructor(
    readonly rule: UploadRule,
    readonly path: string,
    detail: string,
    /** Who refused, for the message (default "dom_upload"). */
    tool = "dom_upload"
  ) {
    super(`${tool} refused ${path ? showPath(path) : "the request"} [${rule}]: ${detail}`);
    this.name = "UploadRefusedError";
  }
}

/** File-system probes the guard needs (injectable for tests). */
export interface UploadFs {
  /** Canonical path (symlinks, junctions, 8.3 names and case resolved); throws when missing. */
  realpath(p: string): string;
  stat(p: string): { isFile(): boolean; size: number };
}

export interface UploadGuardOptions {
  /** Environment to read BROWSER_MCP_UPLOAD_DIRS from. */
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  homedir: string;
  tmpdir: string;
  /** process.platform value: "win32" switches to Windows path rules and case-insensitive roots. */
  platform: string;
  /** Size cap in bytes (default UPLOAD_MAX_BYTES). */
  maxBytes?: number;
  /** Replaces the real file-system probes. */
  fs?: Partial<UploadFs>;
  /** Names the caller in refusals (default "dom_upload"; cdp_send passes "cdp_send <method>"). */
  tool?: string;
}

export interface UploadRoots {
  /** BROWSER_MCP_UPLOAD_DIRS contains "*": any local folder is allowed. */
  any: boolean;
  /** Allowed folders, canonical (realpath), existing ones only. */
  roots: string[];
  source: "env" | "default";
  /** Configured or default entries that are not used, with the reason. */
  skipped: string[];
}

const realFs: UploadFs = {
  realpath: (p) => fs.realpathSync.native(p),
  stat: (p) => fs.statSync(p),
};

/** Guard options for this process (its env, cwd, home and temp folders). */
export function uploadGuardOptions(): UploadGuardOptions {
  return { env: process.env, cwd: process.cwd(), homedir: os.homedir(), tmpdir: os.tmpdir(), platform: process.platform };
}

function pathApi(platform: string): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function probes(opts: UploadGuardOptions): UploadFs {
  return { ...realFs, ...opts.fs };
}

/**
 * Absolute in the strict sense: a drive-letter path or a UNC path on Windows
 * (a drive-relative "\foo" or "C:foo" depends on per-drive state), "/..." elsewhere.
 */
export function isStrictAbsolute(p: string, platform: string): boolean {
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return p.startsWith("/");
}

/** UNC (\\server\share) or Win32 device namespace (\\?\, \\.\) path. */
export function isNetworkPath(p: string, platform: string): boolean {
  return platform === "win32" && /^[\\/]{2}/.test(p);
}

/** Path segments, split on both separators on Windows. */
function segments(p: string, platform: string): string[] {
  return p.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean);
}

/**
 * The first segment that starts with "." (".ssh", ".env", ".aws", but also
 * "." and ".."), or null. Dot-files and dot-directories hold most local
 * secrets and tool state, so they are never uploaded, whatever the roots say.
 */
export function hiddenSegment(p: string, platform: string): string | null {
  for (const s of segments(p, platform)) if (s.startsWith(".")) return s;
  return null;
}

// Private keys, certificates with keys, key stores, password databases and
// credential files. Matched case-insensitively against the file name.
const SECRET_NAME_RULES: ReadonlyArray<[RegExp, string]> = [
  [/^id_(rsa|dsa|ecdsa|ed25519)/, "id_rsa* / id_dsa* / id_ecdsa* / id_ed25519* (SSH keys)"],
  [/\.pem$/, "*.pem"],
  [/\.key$/, "*.key"],
  [/\.p12$/, "*.p12"],
  [/\.pfx$/, "*.pfx"],
  [/\.ppk$/, "*.ppk (PuTTY keys)"],
  [/\.kdbx?$/, "*.kdbx (password databases)"],
  [/\.(jks|keystore)$/, "*.jks / *.keystore"],
  [/^credentials/, "credentials*"],
];

/**
 * Name prefix of the per-process folders the output cap spills cut text into
 * (browser-mcp-spill-<pid>-<random> in the OS temp folder, see tool-kit.ts).
 */
export const SPILL_DIR_PREFIX = "browser-mcp-spill-";

/**
 * The first segment that is a spill folder, or null. Spilled tool output
 * (page text, network bodies of other sites ...) is printed in tool results,
 * so a page could ask for it by path: it is never uploaded.
 */
export function spillSegment(p: string, platform: string): string | null {
  for (const s of segments(p, platform)) if (s.toLowerCase().startsWith(SPILL_DIR_PREFIX)) return s;
  return null;
}

/** Description of the secret-name rule `name` matches, or null. */
export function secretNameRule(name: string): string | null {
  // Windows ignores trailing dots and spaces in names ("id_rsa." opens id_rsa).
  const n = name.toLowerCase().replace(/[. ]+$/, "");
  for (const [re, label] of SECRET_NAME_RULES) if (re.test(n)) return label;
  return null;
}

/** Comparable form of a canonical path: normalized separators, no trailing separator (except a root), lower case on Windows. */
function normalizeForCompare(p: string, platform: string): string {
  const api = pathApi(platform);
  let n = api.normalize(p);
  const root = api.parse(n).root;
  while (n.length > root.length && (n.endsWith("/") || (platform === "win32" && n.endsWith("\\")))) n = n.slice(0, -1);
  return platform === "win32" ? n.toLowerCase() : n;
}

/** child is root itself or inside it (case-insensitive on Windows). Both must already be canonical. */
export function isInsideRoot(child: string, root: string, platform: string): boolean {
  const c = normalizeForCompare(child, platform);
  const r = normalizeForCompare(root, platform);
  if (c === r) return true;
  const sep = platform === "win32" ? "\\" : "/";
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** A filesystem root ("/", "C:\", "\\server\share\"). */
function isFsRoot(p: string, platform: string): boolean {
  const api = pathApi(platform);
  return normalizeForCompare(p, platform) === normalizeForCompare(api.parse(api.normalize(p)).root || p, platform);
}

/**
 * The allowed upload folders. BROWSER_MCP_UPLOAD_DIRS (path.delimiter
 * separated; "~" expands to the home folder; "*" = any folder) replaces the
 * defaults: the temp folder, ~/Downloads and the working directory. Every root
 * is canonicalised (realpath) so symlinked, 8.3 or differently cased spellings
 * compare equal; folders that do not exist are skipped.
 * A default root that is a filesystem root or contains the home folder (a
 * server started from "/" or from ~, as GUI clients often do) is skipped too:
 * it would open the whole disk or home folder to uploads. An explicit
 * BROWSER_MCP_UPLOAD_DIRS entry is the user's choice and is kept.
 */
export function resolveUploadRoots(opts: UploadGuardOptions): UploadRoots {
  const api = pathApi(opts.platform);
  const io = probes(opts);
  const raw = opts.env[UPLOAD_DIRS_ENV];
  const fromEnv = typeof raw === "string" && raw.trim() !== "";
  const skipped: string[] = [];
  let any = false;
  let candidates: string[];
  if (fromEnv) {
    candidates = [];
    for (const part of raw.split(opts.platform === "win32" ? ";" : ":")) {
      let entry = part.trim().replace(/^"(.*)"$/, "$1");
      if (!entry) continue;
      if (entry === "*") {
        any = true;
        continue;
      }
      if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\")) entry = api.join(opts.homedir, entry.slice(1));
      if (!isStrictAbsolute(entry, opts.platform)) {
        skipped.push(`${entry} (not an absolute path)`);
        continue;
      }
      candidates.push(entry);
    }
  } else {
    candidates = [opts.tmpdir, api.join(opts.homedir, "Downloads"), opts.cwd];
  }
  let home: string | null = null;
  try {
    home = io.realpath(opts.homedir);
  } catch {
    home = opts.homedir || null;
  }
  const roots: string[] = [];
  for (const c of candidates) {
    let real: string;
    try {
      real = io.realpath(c);
    } catch {
      skipped.push(`${c} (does not exist)`);
      continue;
    }
    if (!fromEnv && (isFsRoot(real, opts.platform) || (home && isInsideRoot(home, real, opts.platform)))) {
      skipped.push(`${c} (a default root may not be a filesystem root or contain the home folder)`);
      continue;
    }
    if (!roots.some((r) => normalizeForCompare(r, opts.platform) === normalizeForCompare(real, opts.platform))) roots.push(real);
  }
  return { any, roots, source: fromEnv ? "env" : "default", skipped };
}

function describeRoots(r: UploadRoots): string {
  const list = r.roots.length ? r.roots.join(", ") : "none";
  const origin =
    r.source === "env"
      ? `from ${UPLOAD_DIRS_ENV}`
      : `defaults: temp folder, ~/Downloads, working directory; set ${UPLOAD_DIRS_ENV} in the MCP client config to change them`;
  return `allowed upload folders: ${list} (${origin})`;
}

/**
 * Checks the paths dom_upload was given and returns their canonical forms,
 * which are what must be sent to the browser (no symlink is followed later).
 * Throws UploadRefusedError naming the first rule a path fails:
 * absolute path only (with a drive letter on Windows); no network / device
 * path on Windows unless an explicit root holds it; no dot-segment, no
 * spill folder of this server and no secret file name, in the given path and
 * in the resolved one; the resolved
 * path must lie inside an allowed root and be a regular file of at most
 * maxBytes. File contents are never read.
 * (A file swapped after this check is outside the threat model: that needs
 * local write access already.)
 */
export function checkUploadPaths(paths: readonly string[], opts: UploadGuardOptions): string[] {
  const platform = opts.platform;
  const io = probes(opts);
  const maxBytes = opts.maxBytes ?? UPLOAD_MAX_BYTES;
  const refuse = (rule: UploadRule, p: string, detail: string) => new UploadRefusedError(rule, p, detail, opts.tool);
  if (paths.length > UPLOAD_MAX_FILES) {
    throw refuse("too-many-files", "", `at most ${UPLOAD_MAX_FILES} files per call (got ${paths.length})`);
  }
  let roots: UploadRoots | null = null;
  const rootsOnce = () => (roots ??= resolveUploadRoots(opts));
  const out: string[] = [];
  for (const given of paths) {
    const p = typeof given === "string" ? given : "";
    if (!p.trim()) throw refuse("empty-path", p, "empty file path");
    // Lexical rules first: a refused path is never even touched on disk.
    if (!isStrictAbsolute(p, platform)) {
      throw refuse(
        "not-absolute",
        p,
        platform === "win32" ? "only absolute paths with a drive letter (C:\\...) are accepted" : "only absolute paths are accepted"
      );
    }
    // Windows: resolving or stat-ing a UNC path already connects to that host
    // (and can hand it the user's NTLM credentials); \\?\ and \\.\ reach devices.
    // Only an explicit root that holds the path lexically allows it; "*" does not.
    if (isNetworkPath(p, platform)) {
      const r = rootsOnce();
      const allowed = r.source === "env" && r.roots.some((root) => isNetworkPath(root, platform) && isInsideRoot(p, root, platform));
      if (!allowed) {
        throw refuse("network-path", p, `network and device paths are refused unless ${UPLOAD_DIRS_ENV} lists that share`);
      }
    }
    if (platform === "win32" && p.indexOf(":", 2) !== -1) {
      throw refuse("unsupported-path", p, "alternate data streams and other ':' forms are not accepted");
    }
    const checkName = (candidate: string, what: string) => {
      const hidden = hiddenSegment(candidate, platform);
      if (hidden) {
        throw refuse(
          "hidden-segment",
          p,
          `${what} contains the dot-segment "${hidden}"; dot-files and dot-directories (.ssh, .env, .aws ...) are never uploaded`
        );
      }
      const spill = spillSegment(candidate, platform);
      if (spill) {
        throw refuse(
          "spill-file",
          p,
          `${what} is inside "${spill}", a folder of output this server cut from tool results; such files are never uploaded`
        );
      }
      const base = pathApi(platform).basename(candidate);
      const secret = secretNameRule(base);
      if (secret) {
        throw refuse("secret-name", p, `${what} has a key/credential file name (${secret}); such files are never uploaded`);
      }
    };
    checkName(p, "the path");
    let real: string;
    try {
      real = io.realpath(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      throw refuse("not-found", p, `cannot resolve the path (${code || "error"})`);
    }
    if (real !== p) checkName(real, `the resolved path ${showPath(real)}`);
    const r = rootsOnce();
    if (!r.any && !r.roots.some((root) => isInsideRoot(real, root, platform))) {
      throw refuse("outside-roots", p, `${real === p ? "the file" : `the resolved path ${showPath(real)}`} is outside the ${describeRoots(r)}`);
    }
    let st: { isFile(): boolean; size: number };
    try {
      st = io.stat(real);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      throw refuse("not-found", p, `cannot read file information (${code || "error"})`);
    }
    if (!st.isFile()) throw refuse("not-a-file", p, "not a regular file (directories, devices and pipes are refused)");
    if (st.size > maxBytes) {
      const limit = maxBytes % (1024 * 1024) === 0 ? `${maxBytes / (1024 * 1024)} MiB` : `${maxBytes} bytes`;
      throw refuse("too-large", p, `the file has ${st.size} bytes, over the ${limit} limit`);
    }
    out.push(real);
  }
  return out;
}
