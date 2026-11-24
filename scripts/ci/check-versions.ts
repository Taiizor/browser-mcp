/**
 * Release consistency checks (no install needed).
 *
 *   bun scripts/ci/check-versions.ts                 repository checks (below)
 *   bun scripts/ci/check-versions.ts --bun=pinned    the running Bun is mcp-server/.bun-version
 *   bun scripts/ci/check-versions.ts --bun=minimum   the running Bun is the engines.bun minimum
 *
 * Repository checks:
 * - extension/manifest.json and mcp-server/package.json carry the same version;
 * - the server derives its version from package.json: bridge.ts exports
 *   SERVER_VERSION from the imported package.json, every new McpServer(...) uses
 *   SERVER_VERSION, and no server source hard-codes the version string;
 * - docs pin the npm package as <name>@<version> with the current name and version, at
 *   least once (zero pins means the name changed under the docs), and no doc pins another
 *   *browser-mcp package name; version phrases ("prints 1.2.3", "Server v1.2.3",
 *   "browser-mcp 1.2.3") name the current version;
 * - mcp-server/.bun-version satisfies engines.bun, and the CI job for the minimum
 *   Bun (a matrix entry with a literal bun-version) runs exactly the engines minimum;
 * - every oven-sh/setup-bun step in ci.yml names its Bun: bun-version-file pointing at an
 *   existing file, or bun-version as x.y.z or a ${{ matrix.* }} expression (setup-bun
 *   silently installs the latest Bun otherwise).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SERVER = path.join(ROOT, "mcp-server");
const GHA = process.env.GITHUB_ACTIONS === "true";

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const read = (file: string) => fs.readFileSync(file, "utf8");
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let failed = 0;
function fail(file: string | null, msg: string) {
  failed++;
  const where = file ? rel(file) : null;
  if (GHA) console.log(where ? `::error file=${where}::${esc(msg)}` : `::error::${esc(msg)}`);
  else console.log(where ? `error ${where}: ${msg}` : `error: ${msg}`);
}

const manifestFile = path.join(ROOT, "extension", "manifest.json");
const pkgFile = path.join(SERVER, "package.json");
const bunVersionFile = path.join(SERVER, ".bun-version");
const ciFile = path.join(ROOT, ".github", "workflows", "ci.yml");

const pkg = JSON.parse(read(pkgFile));
const pinnedBun = read(bunVersionFile).trim();
const enginesBun: string = pkg.engines?.bun ?? "";
// The lower bound of engines.bun (">=1.3.3" -> "1.3.3"); other range forms need a script update.
const minBun = /^>=\s*v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(enginesBun.trim())?.[1] ?? null;

// ---------- --bun=pinned|minimum: is this job running the Bun it claims? ----------
// setup-bun silently falls back to the latest release when it cannot read the
// version file, which would turn the pinned and minimum jobs into "latest" jobs.
const bunArg = process.argv.slice(2).find((a) => a.startsWith("--bun="));
if (bunArg) {
  const mode = bunArg.slice("--bun=".length);
  const want = mode === "pinned" ? pinnedBun : mode === "minimum" ? minBun : null;
  if (mode !== "pinned" && mode !== "minimum") fail(null, `unknown ${bunArg} (expected --bun=pinned or --bun=minimum)`);
  else if (!want) fail(pkgFile, `engines.bun must be ">=<version>" to derive the minimum Bun (got ${JSON.stringify(enginesBun)})`);
  else if (Bun.version !== want) {
    fail(mode === "pinned" ? bunVersionFile : pkgFile, `this job should run Bun ${want} (${mode}) but runs ${Bun.version}`);
  } else console.log(`ok    Bun ${Bun.version} (${mode})`);
  process.exit(failed ? 1 : 0);
}

// ---------- manifest.json == package.json ----------
const manifestVersion = JSON.parse(read(manifestFile)).version;
console.log(`extension/manifest.json   ${manifestVersion}`);
console.log(`mcp-server/package.json   ${pkg.version}`);
if (manifestVersion !== pkg.version) {
  fail(manifestFile, `version ${manifestVersion} differs from mcp-server/package.json ${pkg.version}: releases bump both together`);
}

// ---------- the server's version comes from package.json ----------
function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (/\.(?:ts|js)$/.test(entry.name) && !/\.test\.(?:ts|js)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

const bridgeFile = path.join(SERVER, "src", "bridge.ts");
const bridgeSrc = read(bridgeFile);
const pkgImport = /^import\s+(\w+)\s+from\s+["']\.\.\/package\.json["']/m.exec(bridgeSrc)?.[1];
const versionInit = /^export\s+const\s+SERVER_VERSION\b[^=]*=\s*([^;]+);/m.exec(bridgeSrc)?.[1];
if (!pkgImport) fail(bridgeFile, 'bridge.ts must import ../package.json (import pkg from "../package.json" with { type: "json" })');
else if (!versionInit) fail(bridgeFile, "bridge.ts must export const SERVER_VERSION");
else if (!new RegExp(`\\b${pkgImport}\\.version\\b`).test(versionInit)) {
  fail(bridgeFile, `SERVER_VERSION must be derived from ${pkgImport}.version (found: ${versionInit.trim()})`);
} else console.log(`SERVER_VERSION (bridge.ts) ${pkgImport}.version`);

const sources = [...listTs(path.join(SERVER, "src")), ...listTs(path.join(SERVER, "bin")), ...listTs(path.join(SERVER, "scripts"))];
let servers = 0;
for (const file of sources) {
  const src = read(file);
  for (const m of src.matchAll(/new\s+McpServer\s*\(\s*\{([^}]*)\}/g)) {
    servers++;
    const version = /\bversion\s*:\s*([^,\n]+)/.exec(m[1])?.[1]?.trim();
    if (!version || !/\bSERVER_VERSION\b/.test(version) || /^["'`]/.test(version)) {
      fail(file, `new McpServer({ version: ${version ?? "<missing>"} }) must use SERVER_VERSION from bridge.ts`);
    } else if (file !== bridgeFile && !/import\s*\{[^}]*\bSERVER_VERSION\b[^}]*\}\s*from\s*["']\.\/bridge(?:\.js|\.ts)?["']/.test(src)) {
      fail(file, "SERVER_VERSION must be imported from ./bridge.js (one version source)");
    } else console.log(`McpServer (${rel(file)}) version: ${version}`);
  }
  // A literal copy of the current version drifts on the next release.
  const literal = new RegExp(`["'\`]v?${reEscape(pkg.version)}["'\`]`);
  src.split(/\r?\n/).forEach((line, i) => {
    if (literal.test(line) && !/^\s*(?:\/\/|\*)/.test(line)) {
      fail(file, `line ${i + 1} hard-codes the version ${pkg.version}: derive it from package.json (SERVER_VERSION)`);
    }
  });
}
if (!servers) fail(path.join(SERVER, "src", "server.ts"), "no new McpServer({ ... }) found in mcp-server/src: update check-versions.ts");

// ---------- docs pin the current package version ----------
const docs: string[] = [];
for (const dir of [ROOT, path.join(ROOT, "docs"), SERVER]) {
  if (!fs.existsSync(dir)) continue;
  const walk = (d: string, deep: boolean) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && deep && entry.name !== "node_modules") walk(full, deep);
      // A changelog may name older releases on purpose.
      else if (entry.isFile() && /\.md$/i.test(entry.name) && !/^changelog/i.test(entry.name)) docs.push(full);
    }
  };
  walk(dir, dir !== ROOT && dir !== SERVER);
}
// Name-agnostic: any (scoped) *browser-mcp name followed by @<version>, so a renamed package
// whose docs still pin the old name fails instead of matching nothing.
const pinRe = /(?<![\w./@-])((?:@[\w.-]+\/)?[\w.-]*browser-mcp[\w.-]*)@(v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/g;
// Bare version phrases that go stale on the next release.
const phraseRes = [
  /\bprints?\s+`?v?(\d+\.\d+\.\d+)\b/g,
  /\bServer v(\d+\.\d+\.\d+)\b/g,
  /\bbrowser-mcp v?(\d+\.\d+\.\d+)\b/g,
];
let pins = 0;
for (const file of docs.sort()) {
  read(file).split(/\r?\n/).forEach((line, i) => {
    for (const [, name, ver] of line.matchAll(pinRe)) {
      if (name !== pkg.name) {
        fail(file, `line ${i + 1} pins ${name}@${ver}, but the package is ${pkg.name}`);
        continue;
      }
      pins++;
      if (ver !== pkg.version) fail(file, `line ${i + 1} pins ${pkg.name}@${ver}; the package is ${pkg.version}`);
    }
    for (const re of phraseRes) {
      for (const [phrase, ver] of line.matchAll(re)) {
        if (ver !== pkg.version) fail(file, `line ${i + 1} says "${phrase}"; the package is ${pkg.version}`);
      }
    }
  });
}
console.log(`docs pinning ${pkg.name}@<version>: ${pins} occurrence(s) in ${docs.length} markdown files`);
if (!pins) fail(null, `no doc pins ${pkg.name}@${pkg.version}: did the package name change? Update the bunx commands in the docs`);

// ---------- Bun versions: .bun-version, engines and the CI minimum job ----------
console.log(`mcp-server/.bun-version   ${pinnedBun}`);
console.log(`engines.bun               ${enginesBun || "<missing>"}`);
if (!minBun) fail(pkgFile, `engines.bun must be ">=<version>" (got ${JSON.stringify(enginesBun)})`);
if (!/^\d+\.\d+\.\d+$/.test(pinnedBun)) fail(bunVersionFile, `expected an exact Bun version, got ${JSON.stringify(pinnedBun)}`);
else if (enginesBun && !Bun.semver.satisfies(pinnedBun, enginesBun)) fail(bunVersionFile, `Bun ${pinnedBun} does not satisfy engines.bun ${enginesBun}`);

if (fs.existsSync(ciFile)) {
  let ci: any = null;
  try {
    ci = Bun.YAML.parse(read(ciFile));
  } catch (e) {
    fail(ciFile, `cannot parse: ${(e as Error).message}`);
  }
  const literalBuns: string[] = [];
  for (const [jobName, job] of Object.entries<any>(ci?.jobs ?? {})) {
    for (const entry of job?.strategy?.matrix?.include ?? []) {
      const v = entry?.["bun-version"];
      if (typeof v === "string" || typeof v === "number") literalBuns.push(String(v));
    }
    for (const step of job?.steps ?? []) {
      if (typeof step?.uses !== "string" || !step.uses.startsWith("oven-sh/setup-bun")) continue;
      // setup-bun silently installs the latest Bun when it gets no version or cannot read the file.
      const where = `job ${jobName}, setup-bun step${step.name ? ` "${step.name}"` : ""}`;
      const v = step.with?.["bun-version"];
      const vf = step.with?.["bun-version-file"];
      if (v === undefined && vf === undefined) {
        fail(ciFile, `${where} names no Bun (it would install the latest): add bun-version-file: mcp-server/.bun-version`);
      } else if (v !== undefined) {
        const s = String(v).trim();
        if (!/^\d+\.\d+\.\d+$/.test(s) && !/^\$\{\{\s*matrix\.[\w-]+\s*\}\}$/.test(s)) {
          fail(ciFile, `${where} uses bun-version: ${s}; use bun-version-file: mcp-server/.bun-version, an exact x.y.z or \${{ matrix.<key> }}`);
        }
      } else if (typeof vf !== "string" || /\$\{\{/.test(vf) || !fs.existsSync(path.join(ROOT, vf))) {
        fail(ciFile, `${where} uses bun-version-file: ${vf}, which does not exist (paths are from the repository root)`);
      }
    }
  }
  if (!literalBuns.length) fail(ciFile, "no matrix entry with a literal bun-version: the minimum Bun from engines.bun is not tested");
  for (const v of literalBuns) {
    if (minBun && v !== minBun) fail(ciFile, `the minimum-Bun job runs ${v} but engines.bun is ${enginesBun}: keep them in sync`);
  }
  if (literalBuns.length) console.log(`CI minimum-Bun job       ${literalBuns.join(", ")}`);
}

if (failed) console.log(`${failed} version check(s) failed`);
else console.log("ok    versions are in sync");
process.exit(failed ? 1 : 0);
