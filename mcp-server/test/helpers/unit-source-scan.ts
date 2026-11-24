// Static readers for the parity tests: pull the permission catalog, the
// command router and the payload fields each handler reads out of the
// extension sources, and the tool definitions out of src/tools/*.ts.
// Deliberately regex and indentation based (the extension is dependency-free
// vanilla JS with 2-space indents, and the test needs no parser dependency):
// when the code is reshaped so that a reader no longer finds what it
// expects, the reader throws with a clear message instead of returning an
// empty result.
import fs from "node:fs";
import path from "node:path";

export const MCP_ROOT = path.resolve(import.meta.dir, "../..");
export const REPO_ROOT = path.resolve(MCP_ROOT, "..");
export const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
export const TOOLS_DIR = path.join(MCP_ROOT, "src", "tools");

const cache = new Map<string, string>();
/** File contents with CRLF normalised, cached per path. */
export function readSource(file: string): string {
  let text = cache.get(file);
  if (text === undefined) {
    text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    cache.set(file, text);
  }
  return text;
}

export const backgroundSource = () => readSource(path.join(EXTENSION_DIR, "background.js"));
export const contentSource = () => readSource(path.join(EXTENSION_DIR, "content.js"));

/** Drops // line comments and /* block comments *\/ (good enough for this code base: keeps "https://..." strings). */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/** The text of a top-level `const NAME = <open> ... <close>;` declaration (open: "[", "{" or "new Set(["). */
export function constBlock(src: string, name: string): string {
  const start = src.search(new RegExp(`^const ${name} = `, "m"));
  if (start < 0) throw new Error(`const ${name} not found`);
  const end = src.indexOf(";\n", start);
  if (end < 0) throw new Error(`end of const ${name} not found`);
  return src.slice(start, end + 1);
}

/** Every double-quoted string inside the declaration of `name`. */
export function stringsOfConst(src: string, name: string): string[] {
  const block = stripComments(constBlock(src, name).replace(/^const \w+ = /, ""));
  return [...block.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
}

export interface PermCategory {
  id: string;
  title: string;
  actions: string[];
}

/** PERM_CATS of background.js, in order. */
export function parsePermCats(src = backgroundSource()): PermCategory[] {
  const block = constBlock(src, "PERM_CATS");
  const cats: PermCategory[] = [];
  for (const m of block.matchAll(/\{\s*id:\s*"([^"]+)",\s*title:\s*"([^"]*)",\s*actions:\s*\[([\s\S]*?)\]\s*\}/g)) {
    cats.push({ id: m[1], title: m[2], actions: [...m[3].matchAll(/"([^"]+)"/g)].map((a) => a[1]) });
  }
  if (!cats.length) throw new Error("PERM_CATS: no category parsed");
  return cats;
}

/** REQUIRES of background.js: composite action -> actions it also needs. */
export function parseRequires(src = backgroundSource()): Record<string, string[]> {
  const block = stripComments(constBlock(src, "REQUIRES"));
  const out: Record<string, string[]> = {};
  for (const m of block.matchAll(/([A-Za-z_][\w]*)\s*:\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((a) => a[1]);
  }
  if (!Object.keys(out).length) throw new Error("REQUIRES: no entry parsed");
  return out;
}

/** PERM_ALIASES of background.js: MCP tool name -> catalog actions. */
export function parsePermAliases(src = backgroundSource()): Record<string, string[]> {
  const block = stripComments(constBlock(src, "PERM_ALIASES"));
  const out: Record<string, string[]> = {};
  for (const m of block.matchAll(/([A-Za-z_][\w]*)\s*:\s*\[([^\]]*)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((a) => a[1]);
  }
  return out;
}

interface FnInfo {
  params: string[];
  body: string;
}

/**
 * Every `function name(...)` declaration (any nesting level) by name; the
 * first wins. A body ends at the first closing brace line with the
 * declaration's own indentation.
 */
export function functionIndex(src: string): Map<string, FnInfo> {
  const lines = src.split("\n");
  const map = new Map<string, FnInfo>();
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
    if (!m || map.has(m[2])) return;
    const indent = m[1];
    let end = -1;
    if (/\{.*\}\s*;?\s*$/.test(line.slice(m[0].length))) end = i;
    else {
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k] === `${indent}}` || lines[k] === `${indent}};`) {
          end = k;
          break;
        }
      }
    }
    if (end < 0) return;
    const params = m[3]
      .split(",")
      .map((p) => p.trim().replace(/=[\s\S]*$/, "").replace(/^\.\.\./, "").trim());
    map.set(m[2], { params, body: stripComments(lines.slice(i, end + 1).join("\n")) });
  });
  return map;
}

/**
 * The bodies of a `switch` dispatcher's cases, by case label. Fall-through
 * labels share the body of the case they fall into. `caseIndent` is the
 * exact indentation of the case lines.
 */
export function switchCases(fnBody: string, caseIndent: string): Map<string, string> {
  const map = new Map<string, string>();
  const caseRe = new RegExp(`^${caseIndent}case\\s+"([^"]+)":`);
  const defaultRe = new RegExp(`^${caseIndent}default:`);
  let labels: string[] = [];
  let body: string[] = [];
  const flushCase = () => {
    for (const l of labels) map.set(l, stripComments(body.join("\n")));
  };
  for (const line of fnBody.split("\n")) {
    const m = line.match(caseRe);
    if (m) {
      const onlyLabels = body.every((b) => !b.trim() || caseRe.test(b));
      if (labels.length && onlyLabels) {
        labels.push(m[1]);
        body.push(line);
        continue;
      }
      flushCase();
      labels = [m[1]];
      body = [line];
      continue;
    }
    if (defaultRe.test(line)) {
      flushCase();
      labels = [];
      body = [];
      continue;
    }
    if (labels.length) body.push(line);
  }
  flushCase();
  return map;
}

const fnIndexCache = new Map<string, Map<string, FnInfo>>();
/** functionIndex() memoised per source text. */
function functionsOf(src: string): Map<string, FnInfo> {
  let idx = fnIndexCache.get(src);
  if (!idx) fnIndexCache.set(src, (idx = functionIndex(src)));
  return idx;
}

/** Parsed switch cases per source text. */
const casesCache = new Map<string, Map<string, string>>();

/** handleCommand's cases in background.js (the bridge action router). */
export function backgroundCases(src = backgroundSource()): Map<string, string> {
  const hit = casesCache.get(src);
  if (hit) return hit;
  const fn = functionsOf(src).get("handleCommand");
  if (!fn) throw new Error("background.js: function handleCommand not found");
  const cases = switchCases(fn.body, "    ");
  if (cases.size < 50) throw new Error(`background.js: only ${cases.size} handleCommand cases parsed`);
  casesCache.set(src, cases);
  return cases;
}

/** runCommand's cases in content.js (the content-script command router). */
export function contentCases(src = contentSource()): Map<string, string> {
  const hit = casesCache.get(src);
  if (hit) return hit;
  const fn = functionsOf(src).get("runCommand");
  if (!fn) throw new Error("content.js: function runCommand not found");
  const cases = switchCases(fn.body, "      ");
  if (cases.size < 10) throw new Error(`content.js: only ${cases.size} runCommand cases parsed`);
  casesCache.set(src, cases);
  return cases;
}

const escapeId = (id: string) => id.replace(/[$]/g, "\\$");

/** Fields read from the object named `id` directly in `text`. */
export function directReads(text: string, id: string): Set<string> {
  const I = escapeId(id);
  const keys = new Set<string>();
  const add = (re: RegExp, pick: (m: RegExpMatchArray) => string | string[]) => {
    for (const m of text.matchAll(re)) for (const k of [pick(m)].flat()) if (k) keys.add(k);
  };
  // payload.key / payload?.key
  add(new RegExp(`(?<![\\w$.])${I}\\??\\.([A-Za-z_$][\\w$]*)`, "g"), (m) => m[1]);
  // payload["key"]
  add(new RegExp(`(?<![\\w$.])${I}\\??\\.?\\[\\s*["']([^"']+)["']\\s*\\]`, "g"), (m) => m[1]);
  // helper(payload, "key", ...) such as bg2cInt(payload, "width", 1, 16384)
  add(new RegExp(`\\(\\s*${I}\\s*,\\s*["']([\\w$]+)["']`, "g"), (m) => m[1]);
  // "key" in payload
  add(new RegExp(`["']([\\w$]+)["']\\s+in\\s+${I}\\b`, "g"), (m) => m[1]);
  // const { a, b: c, d = 1 } = payload
  add(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${I}\\b`, "g"), (m) =>
    m[1]
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("..."))
      .map((p) => p.split(/[:=\s]/)[0])
  );
  return keys;
}

export interface PayloadReads {
  /** Fields of the bridge payload read by the handler (background case, helpers it passes the payload to, content command). */
  keys: Set<string>;
  /** Content-script commands the payload is forwarded to unchanged. */
  contentCommands: Set<string>;
}

/** Calls in `text` that pass the identifier `id` itself as an argument: [function name, argument index]. */
function callsPassing(text: string, id: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  for (const m of text.matchAll(re)) {
    const args = m[2].split(",").map((a) => a.trim());
    args.forEach((a, i) => {
      if (a === id) out.push([m[1], i]);
    });
  }
  return out;
}

function collectReads(
  text: string,
  id: string,
  fns: Map<string, FnInfo>,
  action: string,
  out: PayloadReads,
  seen: Set<string>,
  depth: number
): void {
  for (const k of directReads(text, id)) out.keys.add(k);
  // Forwarded to the content script as is: toContent(tab, "cmd" | action | cmd, payload, ...).
  const I = escapeId(id);
  for (const m of text.matchAll(new RegExp(`toContent\\w*\\(\\s*[^,()]+,\\s*(?:"([^"]+)"|[A-Za-z_$][\\w$]*)\\s*,\\s*${I}\\s*[,)]`, "g"))) {
    out.contentCommands.add(m[1] ?? action);
  }
  if (depth >= 5) return;
  for (const [name, index] of callsPassing(text, id)) {
    const fn = fns.get(name);
    const param = fn?.params[index];
    if (!fn || !param || !/^[A-Za-z_$][\w$]*$/.test(param)) continue;
    const key = `${name}#${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    collectReads(fn.body, param, fns, action, out, seen, depth + 1);
  }
}

/**
 * The payload fields the extension reads for bridge action `action`: the
 * handleCommand case, every background helper the payload object is passed
 * to (following parameter renames), and the content.js command it is
 * forwarded to unchanged. null when the action has no case.
 */
export function actionPayloadReads(action: string): PayloadReads | null {
  const bg = backgroundSource();
  const body = backgroundCases(bg).get(action);
  if (body === undefined) return null;
  const bgFns = functionsOf(bg);
  const out: PayloadReads = { keys: new Set(), contentCommands: new Set() };
  collectReads(body, "payload", bgFns, action, out, new Set(), 0);
  if (out.contentCommands.size) {
    const ct = contentSource();
    const cases = contentCases(ct);
    const ctFns = functionsOf(ct);
    for (const cmd of out.contentCommands) {
      const cbody = cases.get(cmd);
      if (cbody === undefined) throw new Error(`content.js has no runCommand case for "${cmd}" (forwarded by ${action})`);
      collectReads(cbody, "payload", ctFns, cmd, out, new Set(), 0);
    }
  }
  return out;
}

export interface ToolSend {
  action: string;
  /** Sent through ctx.bridge.send (no abort signal) instead of ctx.send. */
  raw: boolean;
}

export interface ToolSource {
  file: string;
  name: string;
  category: string;
  sends: ToolSend[];
  /** Source of the kit.define({...}) block. */
  block: string;
}

/** Every kit.define block in src/tools/*.ts with the actions it sends. */
export function toolSources(): ToolSource[] {
  const out: ToolSource[] = [];
  for (const file of fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort()) {
    const src = stripComments(readSource(path.join(TOOLS_DIR, file)));
    const starts = [...src.matchAll(/kit\.define\(\{/g)].map((m) => m.index!);
    // Sends in helpers above the first definition would belong to no tool.
    if (/\.send\s*(?:<[^>()]*>)?\s*\(/.test(src.slice(0, starts[0] ?? src.length))) {
      throw new Error(`${file}: a bridge send outside any kit.define block; teach toolSources() about the helper`);
    }
    starts.forEach((start, i) => {
      const block = src.slice(start, starts[i + 1] ?? src.length);
      const name = block.match(/\bname:\s*"([^"]+)"/)?.[1];
      const category = block.match(/\bcategory:\s*"([^"]+)"/)?.[1];
      if (!name || !category) throw new Error(`${file}: a kit.define block without a literal name/category`);
      const sends: ToolSend[] = [];
      for (const m of block.matchAll(/\b(ctx\.send|ctx\.bridge\.send)\s*(?:<[^>()]*>)?\s*\(\s*("([^"]*)"|[^,)\s]+)/g)) {
        if (m[3] === undefined) throw new Error(`${file} ${name}: ${m[1]} with a non-literal action (${m[2]})`);
        sends.push({ action: m[3], raw: m[1] === "ctx.bridge.send" });
      }
      out.push({ file, name, category, sends, block });
    });
  }
  return out;
}

/** Message keys of every extension locale: locale -> key -> message. */
export function localeMessages(): Map<string, Record<string, { message?: string }>> {
  const dir = path.join(EXTENSION_DIR, "_locales");
  const out = new Map<string, Record<string, { message?: string }>>();
  for (const loc of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, loc, "messages.json");
    if (fs.existsSync(file)) out.set(loc, JSON.parse(readSource(file)));
  }
  return out;
}
