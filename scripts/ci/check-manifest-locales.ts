/**
 * Validates the extension's manifest.json and locales:
 * - manifest.json and every _locales/<locale>/messages.json parse;
 * - every file the manifest or an extension page (script src, link href) points
 *   at exists, so a rename cannot ship an extension that fails to load;
 * - every locale has exactly the key set (and placeholders) of the default locale;
 * - every message key referenced by the manifest, the HTML pages, popup.js and the
 *   permission categories in background.js exists in the default locale.
 *
 *   bun scripts/ci/check-manifest-locales.ts        (from any directory)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const EXT = path.join(ROOT, "extension");
const GHA = process.env.GITHUB_ACTIONS === "true";

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

let failed = 0;
function fail(file: string, msg: string) {
  failed++;
  const name = rel(file);
  console.log(GHA ? `::error file=${name}::${esc(msg)}` : `error ${name}: ${msg}`);
}
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(file, `invalid JSON: ${(e as Error).message}`);
    return null;
  }
}
const read = (file: string) => fs.readFileSync(file, "utf8");

// ---------- manifest.json ----------
const manifestFile = path.join(EXT, "manifest.json");
const manifest = readJson(manifestFile);
if (manifest) {
  if (manifest.manifest_version !== 3) fail(manifestFile, "manifest_version must be 3");
  if (typeof manifest.version !== "string" || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    fail(manifestFile, `invalid version: ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.background?.type === "module") {
    fail(manifestFile, "background.type is \"module\": check-syntax.ts parses every script as a classic script; update it first");
  }
  console.log(`ok    ${rel(manifestFile)} (v${manifest.version})`);
}

// ---------- files the manifest and the pages reference ----------
function referencedByManifest(m: any): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  const addIcons = (v: unknown) => {
    if (typeof v === "string") add(v);
    else if (v && typeof v === "object") Object.values(v).forEach(add);
  };
  addIcons(m.icons);
  add(m.background?.service_worker);
  for (const cs of m.content_scripts ?? []) [...(cs.js ?? []), ...(cs.css ?? [])].forEach(add);
  add(m.action?.default_popup);
  addIcons(m.action?.default_icon);
  add(m.options_page);
  add(m.options_ui?.page);
  add(m.side_panel?.default_path);
  add(m.devtools_page);
  for (const war of m.web_accessible_resources ?? []) {
    for (const r of war.resources ?? []) if (!/[*?]/.test(r)) add(r); // globs may match nothing on purpose
  }
  return out;
}

const pages = fs.readdirSync(EXT).filter((f) => f.endsWith(".html")).sort();
const checkedRefs = new Set<string>();
function checkRef(from: string, ref: string) {
  // Only local files: skip URLs, data: and fragment-only references.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return;
  const clean = ref.split(/[?#]/)[0];
  const target = clean.startsWith("/") ? path.join(EXT, clean) : path.join(path.dirname(from), clean);
  const key = `${from}|${target}`;
  if (checkedRefs.has(key)) return;
  checkedRefs.add(key);
  if (!target.startsWith(EXT + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    fail(from, `references a missing file: ${ref}`);
  }
}
if (manifest) for (const ref of referencedByManifest(manifest)) checkRef(manifestFile, ref);
for (const page of pages) {
  const file = path.join(EXT, page);
  for (const [, ref] of read(file).matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) checkRef(file, ref);
}
console.log(`checked ${checkedRefs.size} file references (manifest.json, ${pages.join(", ")})`);

// ---------- locales ----------
const defaultLocale: string = manifest?.default_locale ?? "en";
const baseFile = path.join(EXT, "_locales", defaultLocale, "messages.json");
const base = fs.existsSync(baseFile) ? readJson(baseFile) : (fail(baseFile, "default locale has no messages.json"), null);
if (!base) process.exit(1);
const baseKeys = Object.keys(base).sort();
const placeholderKeys = (m: any, k: string) => JSON.stringify(Object.keys(m?.[k]?.placeholders ?? {}).sort());

for (const loc of fs.readdirSync(path.join(EXT, "_locales")).sort()) {
  const file = path.join(EXT, "_locales", loc, "messages.json");
  if (!fs.existsSync(file)) {
    fail(file, "missing messages.json");
    continue;
  }
  const m = readJson(file);
  if (!m) continue;
  const before = failed;
  const missing = baseKeys.filter((k) => !(k in m));
  const extra = Object.keys(m).filter((k) => !(k in base));
  if (missing.length) fail(file, `missing keys: ${missing.join(", ")}`);
  if (extra.length) fail(file, `keys not in ${defaultLocale}: ${extra.join(", ")}`);
  for (const [k, v] of Object.entries<any>(m)) {
    if (typeof v?.message !== "string") fail(file, `${k}: "message" must be a string`);
    if (k in base && placeholderKeys(m, k) !== placeholderKeys(base, k)) fail(file, `${k}: placeholders differ from ${defaultLocale}`);
  }
  if (failed === before) console.log(`ok    ${rel(file)} (${Object.keys(m).length} keys)`);
}

// ---------- referenced message keys ----------
const used = new Map<string, string>();
for (const [, k] of read(manifestFile).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) used.set(k, manifestFile);
for (const page of pages) {
  const file = path.join(EXT, page);
  for (const [, k] of read(file).matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) used.set(k, file);
}
// popup.js wraps I18N.t as t(key, fallback); other scripts call I18N.t directly.
const popupJs = path.join(EXT, "popup.js");
if (fs.existsSync(popupJs)) {
  for (const [, k] of read(popupJs).matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"\s*[,)]/g)) used.set(k, popupJs);
}
for (const f of fs.readdirSync(EXT).filter((f) => f.endsWith(".js"))) {
  const file = path.join(EXT, f);
  for (const [, k] of read(file).matchAll(/\b(?:I18N\.t|chrome\.i18n\.getMessage)\(\s*"([A-Za-z0-9_@]+)"/g)) used.set(k, file);
}
// Permission category titles are looked up as cat_<id> (see PERM_CATS in background.js).
const bgFile = path.join(EXT, "background.js");
const bg = read(bgFile);
const catStart = bg.indexOf("const PERM_CATS");
const catEnd = bg.indexOf("const PERM_ALL", catStart);
if (catStart < 0 || catEnd < 0) {
  fail(bgFile, "cannot find the PERM_CATS ... PERM_ALL block (update check-manifest-locales.ts if it moved)");
} else {
  const ids = [...bg.slice(catStart, catEnd).matchAll(/\{\s*id:\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  if (!ids.length) fail(bgFile, "PERM_CATS has no { id: \"...\" } entries");
  for (const id of ids) used.set(`cat_${id}`, bgFile);
}
for (const [k, file] of used) {
  if (!k.startsWith("@@") && !(k in base)) fail(file, `message key "${k}" is not defined in _locales/${defaultLocale}/messages.json`);
}
console.log(`checked ${used.size} referenced message keys`);
process.exit(failed ? 1 : 0);
