/**
 * prepack/postpack helper: the npm package is mcp-server/, but README.md and LICENSE live at the
 * repository root, and `files` cannot reach outside the package folder. "copy" puts the root
 * copies next to package.json for the pack and records which ones it created; "clean" removes
 * exactly those, so a package-specific README.md that already exists is neither overwritten nor
 * deleted.
 */
import fs from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dir, "..");
const repoDir = path.resolve(pkgDir, "..");
const record = path.join(pkgDir, ".pack-assets.json");
const ASSETS = ["README.md", "LICENSE"];

const mode = process.argv[2];
if (mode === "copy") {
  const created: string[] = [];
  for (const name of ASSETS) {
    const target = path.join(pkgDir, name);
    const source = path.join(repoDir, name);
    if (fs.existsSync(target) || !fs.existsSync(source)) continue;
    fs.copyFileSync(source, target);
    created.push(name);
  }
  fs.writeFileSync(record, JSON.stringify(created));
} else if (mode === "clean") {
  let created: string[] = [];
  try {
    created = JSON.parse(fs.readFileSync(record, "utf8"));
  } catch {}
  for (const name of created) if (ASSETS.includes(name)) fs.rmSync(path.join(pkgDir, name), { force: true });
  fs.rmSync(record, { force: true });
} else {
  console.error("usage: bun scripts/pack-assets.ts copy|clean");
  process.exit(2);
}
