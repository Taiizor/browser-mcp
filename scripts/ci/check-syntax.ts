/**
 * Syntax-checks every .js file under extension/ the way Chrome loads it: as a classic
 * script (service worker, content script, popup and offscreen pages are not ES
 * modules). Each file is compiled with new vm.Script(src) and never executed. (new
 * Function would compile it as a function body, which accepts a top-level return or
 * new.target that a classic script rejects.)
 *
 *   bun scripts/ci/check-syntax.ts        (from any directory)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const EXT = path.join(ROOT, "extension");
const GHA = process.env.GITHUB_ACTIONS === "true";

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
// Workflow-command escaping, so a multi-line message stays one annotation.
const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function listScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listScripts(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out.sort();
}

const files = listScripts(EXT);
if (!files.length) {
  console.log(GHA ? "::error::no extension/*.js files found" : "error: no extension/*.js files found");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const name = rel(file);
  try {
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: name }); // compile only: never run
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    const msg = (e as Error).message;
    console.log(GHA ? `::error file=${name}::${esc(msg)}` : `error ${name}: ${msg}`);
  }
}
console.log(`${files.length - failed}/${files.length} extension scripts parse`);
process.exit(failed ? 1 : 0);
