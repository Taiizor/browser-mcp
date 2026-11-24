/**
 * Generates the reference part of docs/tools.md from the server itself: createServer with a
 * fake bridge and every toolset enabled, then the MCP tools/list, resources/list and
 * prompts/list of an in-memory client. Tools are grouped by toolset (the permission category of
 * their action), core tools are marked, and the totals come from the registry.
 *
 *   bun run docs:tools          rewrite the generated block of docs/tools.md
 *   bun run docs:tools:check    exit 1 when docs/tools.md is stale (CI)
 *
 * Only the text between the BEGIN / END GENERATED markers is replaced. The check mode also
 * checks the tool counts quoted in README.md, docs/toolsets.md and docs/tools.md, and the core
 * tool list in docs/toolsets.md, so prose cannot drift from the registry.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IBridge } from "../src/bridge.js";
import { createServer, getToolRegistry } from "../src/server.js";
import { CORE_TOOLS, TOOL_CATEGORIES, TOOLSET_TITLES, type ToolCategory } from "../src/toolsets.js";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const TOOLS_MD = path.join(ROOT, "docs", "tools.md");
const BEGIN = "<!-- BEGIN GENERATED: tool reference (do not edit by hand) -->";
const END = "<!-- END GENERATED: tool reference -->";
const check = process.argv.includes("--check");

// A bridge that is never reached: listing tools sends nothing to the extension.
const fakeBridge: IBridge = {
  port: 8765,
  connected: false,
  mode: "primary",
  consoleEvents: [],
  networkEvents: [],
  status: () => ({ mode: "primary", pid: 0, peers: 0 }),
  knownDisabled: () => null,
  onPermsChange: () => () => {},
  send: async () => {
    throw new Error("gen-tools-doc: the fake bridge does not run commands");
  },
  launchBrowser: async () => ({ connected: false, launched: false, detail: "fake bridge" }),
  closeBrowser: async () => ({ closed: false, detail: "fake bridge" }),
  close: () => {},
};

// env: {} keeps BROWSER_MCP_TOOLSETS / BROWSER_MCP_MAX_OUTPUT_CHARS of the shell out of the output.
const server = createServer(fakeBridge, {
  toolsets: ["all"],
  env: {},
  log: () => {},
  saveOutput: () => {
    throw new Error("gen-tools-doc: nothing is saved");
  },
});
const registry = getToolRegistry(server);
if (!registry) throw new Error("createServer returned a server without a tool registry");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "gen-tools-doc", version: "0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const tools = (await client.listTools()).tools;
const resources = (await client.listResources()).resources;
const prompts = (await client.listPrompts()).prompts;
const info = client.getServerVersion();
await client.close();
await server.close();

type Tool = (typeof tools)[number];
type Schema = Record<string, any>;

const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
if (byName.size !== registry.size) throw new Error(`tools/list has ${byName.size} tools, the registry ${registry.size}`);
for (const name of CORE_TOOLS) if (!registry.has(name)) throw new Error(`CORE_TOOLS names ${name}, which is not registered`);

const oneLine = (s: unknown) => String(s ?? "").replace(/\r?\n/g, " ").trim();
// Markdown-safe text: no raw HTML, emphasis or strikethrough from tool descriptions.
const escText = (s: unknown) =>
  oneLine(s)
    .replace(/\\/g, "\\\\")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "\\*")
    .replace(/~/g, "\\~")
    .replace(/(^|[^A-Za-z0-9])_/g, "$1\\_");
// Table cells also escape the column separator.
const esc = (s: unknown) => escText(s).replace(/\|/g, "\\|");

function typeOf(s: Schema | undefined): string {
  if (!s || typeof s !== "object") return "any";
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts)) return alts.map(typeOf).join(" | ");
  let t: string = Array.isArray(s.type) ? s.type.join(" | ") : s.type || "any";
  if (t === "array") t = `${typeOf(s.items)}[]`;
  if (t === "object" && s.additionalProperties && typeof s.additionalProperties === "object") {
    t = `record<string, ${typeOf(s.additionalProperties)}>`;
  }
  return t;
}

function limits(s: Schema | undefined): string {
  if (!s || typeof s !== "object") return "";
  const out: string[] = [];
  const SAFE = Number.MAX_SAFE_INTEGER;
  const isInt = s.type === "integer";
  let lo: number | string | undefined = s.minimum;
  if (lo === undefined && s.exclusiveMinimum !== undefined) lo = isInt ? s.exclusiveMinimum + 1 : `> ${s.exclusiveMinimum}`;
  let hi: number | string | undefined = s.maximum;
  if (hi === undefined && s.exclusiveMaximum !== undefined) hi = isInt ? s.exclusiveMaximum - 1 : `< ${s.exclusiveMaximum}`;
  if (lo === -SAFE) lo = undefined;
  if (hi === SAFE) hi = undefined;
  if (typeof lo === "number" && typeof hi === "number") out.push(`${lo}..${hi}`);
  else {
    if (lo !== undefined) out.push(typeof lo === "number" ? `>= ${lo}` : lo);
    if (hi !== undefined) out.push(typeof hi === "number" ? `<= ${hi}` : hi);
  }
  if (s.minLength !== undefined || s.maxLength !== undefined) out.push(`length ${s.minLength ?? 0}..${s.maxLength ?? "∞"}`);
  if (s.minItems !== undefined || s.maxItems !== undefined) out.push(`${s.minItems ?? 0}..${s.maxItems ?? "∞"} items`);
  if (s.items && typeof s.items === "object") {
    const inner = limits(s.items);
    if (inner) out.push(`each ${inner}`);
  }
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
  return out.join(", ");
}

function hints(a: Tool["annotations"]): string {
  if (!a) return "";
  const h: string[] = [];
  if (a.readOnlyHint) h.push("read-only");
  if (a.destructiveHint) h.push("destructive");
  else if (a.readOnlyHint === false) h.push("changes state");
  if (a.idempotentHint) h.push("idempotent");
  if (a.openWorldHint) h.push("open world");
  return h.join(", ");
}

const groups = new Map<ToolCategory, string[]>(TOOL_CATEGORIES.map((c) => [c, []]));
for (const [name, entry] of registry) {
  const group = groups.get(entry.category);
  if (!group) throw new Error(`tool ${name} has the unknown category ${entry.category}`);
  group.push(name);
}
const usedGroups = [...groups].filter(([, names]) => names.length);
const core = [...registry.keys()].filter((n) => CORE_TOOLS.has(n));
const meta = groups.get("meta") ?? [];
const anchor = (cat: string) => `toolset-${cat.replace(/_/g, "-")}`;

const lines: string[] = [];
lines.push(
  `Generated from the server's own \`tools/list\` (${info?.name} ${info?.version}, every toolset enabled): ` +
    `**${tools.length} tools** in ${usedGroups.length} toolsets, ${core.length} of them in the default \`core\` toolset ` +
    `(marked **core**). Meta tools are always listed.`
);
lines.push("");
lines.push("| Toolset | Tools | In core | Description |");
lines.push("|---|---:|---:|---|");
for (const [cat, names] of usedGroups) {
  const inCore = names.filter((n) => CORE_TOOLS.has(n)).length;
  lines.push(`| [\`${cat}\`](#${anchor(cat)}) | ${names.length} | ${inCore} | ${esc(TOOLSET_TITLES[cat])} |`);
}
lines.push("");
for (const [cat, names] of usedGroups) {
  lines.push(`<a id="${anchor(cat)}"></a>`, "");
  lines.push(`### \`${cat}\` (${names.length})`, "");
  lines.push(escText(TOOLSET_TITLES[cat]) + ".", "");
  for (const name of names) {
    const t = byName.get(name);
    if (!t) throw new Error(`registered tool ${name} is missing from tools/list`);
    const tags = [CORE_TOOLS.has(name) ? "**core**" : null, hints(t.annotations) || null].filter(Boolean).join(" · ");
    lines.push(`#### \`${name}\`${t.title ? ` — ${esc(t.title)}` : ""}`, "");
    if (tags) lines.push(tags, "");
    lines.push(escText(t.description), "");
    const props: Record<string, Schema> = (t.inputSchema?.properties ?? {}) as Record<string, Schema>;
    const required = new Set<string>((t.inputSchema?.required ?? []) as string[]);
    const keys = Object.keys(props);
    if (!keys.length) {
      lines.push("No parameters.");
    } else {
      lines.push("| Parameter | Type | Required | Limits | Description |");
      lines.push("|---|---|---|---|---|");
      for (const k of keys) {
        const p = props[k];
        lines.push(`| \`${k}\` | ${esc(typeOf(p))} | ${required.has(k) ? "yes" : "no"} | ${esc(limits(p))} | ${esc(p.description)} |`);
      }
    }
    lines.push("");
  }
}
lines.push("### Resources", "");
lines.push("| URI | Name | Title |");
lines.push("|---|---|---|");
for (const r of resources) lines.push(`| \`${r.uri}\` | \`${r.name}\` | ${esc(r.title)} |`);
lines.push("");
lines.push("### Prompts", "");
lines.push("| Prompt | Title | Arguments | Description |");
lines.push("|---|---|---|---|");
for (const p of prompts) {
  const args = (p.arguments ?? []).map((a) => `\`${a.name}\`${a.required ? "" : " (optional)"}`).join(", ");
  lines.push(`| \`${p.name}\` | ${esc(p.title)} | ${args} | ${esc(p.description)} |`);
}
const generated = lines.join("\n");

// ---------- splice into docs/tools.md (line endings as the checkout has them) ----------
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const existingRaw = fs.readFileSync(TOOLS_MD, "utf8");
const existing = lf(existingRaw);
const a = existing.indexOf(BEGIN);
const b = existing.indexOf(END);
if (a < 0 || b < a) {
  console.error(`[docs:tools] ${path.relative(ROOT, TOOLS_MD)} has no ${BEGIN} ... ${END} block`);
  process.exit(1);
}
const next = existing.slice(0, a + BEGIN.length) + "\n\n" + generated + "\n\n" + existing.slice(b);

// ---------- counts quoted in prose ----------
// [file, pattern, expected values of its capture groups]
const listedByDefault = core.length + meta.filter((n) => !CORE_TOOLS.has(n)).length;
const proseChecks: Array<[string, RegExp, number[]]> = [
  ["README.md", /\*\*(\d+) tools in (\d+) category toolsets\.\*\*/, [tools.length, usedGroups.length]],
  ["README.md", /`core` toolset \((\d+) everyday tools, (\d+) listed/, [core.length, listedByDefault]],
  ["README.md", /All (\d+) tools with parameters/, [tools.length]],
  ["docs/toolsets.md", /one of the (\d+) categories/, [usedGroups.length]],
  ["docs/toolsets.md", /\| (\d+) everyday tools:/, [core.length]],
  ["docs/toolsets.md", /Every tool \((\d+)\)/, [tools.length]],
  ["docs/toolsets.md", /the client sees (\d+) tools: the (\d+) core tools/, [listedByDefault, core.length]],
  ["docs/tools.md", /registers \*\*(\d+) tools\*\* in (\d+) toolsets, plus (\d+) resources and (\d+) prompts/, [tools.length, usedGroups.length, resources.length, prompts.length]],
  ["docs/tools.md", /`core` toolset\s+\((\d+) tools, marked/, [core.length]],
];
const problems: string[] = [];
for (const [rel, re, want] of proseChecks) {
  const m = re.exec(lf(fs.readFileSync(path.join(ROOT, rel), "utf8")));
  if (!m) {
    problems.push(`${rel}: the phrase ${re} is gone; update gen-tools-doc.ts together with the wording`);
    continue;
  }
  const got = m.slice(1).map(Number);
  if (got.some((v, i) => v !== want[i])) problems.push(`${rel}: "${m[0]}" should say ${want.join(" / ")}`);
}
// The core row of the toolsets table names every core tool.
const coreRow = /^\| `core` \(default\) \|.*$/m.exec(lf(fs.readFileSync(path.join(ROOT, "docs", "toolsets.md"), "utf8")))?.[0];
if (!coreRow) problems.push("docs/toolsets.md: the `core` (default) row of the toolsets table is gone");
else {
  const listed = new Set([...coreRow.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]).filter((n) => n !== "core"));
  const missing = core.filter((n) => !listed.has(n));
  const extra = [...listed].filter((n) => !CORE_TOOLS.has(n));
  if (missing.length || extra.length) {
    problems.push(`docs/toolsets.md: core row${missing.length ? ` misses ${missing.join(", ")}` : ""}${extra.length ? ` lists non-core ${extra.join(", ")}` : ""}`);
  }
}

const summary = `${tools.length} tools, ${core.length} core, ${usedGroups.length} toolsets, ${resources.length} resources, ${prompts.length} prompts`;
if (check) {
  const stale = next !== existing;
  if (stale) console.error("[docs:tools] docs/tools.md is stale: run `bun run docs:tools` in mcp-server/ and commit the result");
  for (const p of problems) console.error(`[docs:tools] ${p}`);
  if (stale || problems.length) process.exit(1);
  console.error(`[docs:tools] docs/tools.md is up to date (${summary})`);
} else {
  const eol = existingRaw.includes("\r\n") ? "\r\n" : "\n";
  const out = eol === "\n" ? next : next.replace(/\n/g, eol);
  if (out !== existingRaw) fs.writeFileSync(TOOLS_MD, out);
  console.error(`[docs:tools] ${out !== existingRaw ? "wrote" : "unchanged:"} docs/tools.md (${summary})`);
  for (const p of problems) console.error(`[docs:tools] warning: ${p}`);
}
process.exit(0);
