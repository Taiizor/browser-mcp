/**
 * prepack/postpack helper: the npm package is mcp-server/, but README.md and LICENSE live at the
 * repository root, and `files` cannot reach outside the package folder. "copy" puts the root
 * copies next to package.json for the pack and records which ones it created; "clean" removes
 * exactly those, so a package-specific README.md that already exists is neither overwritten nor
 * deleted.
 *
 * The packed README is rewritten so that its relative links and images point at the repository on
 * GitHub: npm resolves relative paths against repository.directory (mcp-server/), where the docs
 * do not live.
 */
import fs from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dir, "..");
const repoDir = path.resolve(pkgDir, "..");
const record = path.join(pkgDir, ".pack-assets.json");
const ASSETS = ["README.md", "LICENSE"];

/** "https://github.com/<owner>/<repo>" from package.json repository.url, or null for other hosts. */
export function githubBase(repositoryUrl: unknown): string | null {
  if (typeof repositoryUrl !== "string") return null;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(repositoryUrl.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

// A scheme (https:, mailto:, data: ...), an in-page anchor, a protocol-relative or a root-relative URL.
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;

/** A README-relative target (the README sits at the repository root) as an absolute GitHub URL. */
export function absolutize(target: string, base: string, image: boolean): string {
  if (!target || NOT_RELATIVE.test(target)) return target;
  const hashAt = target.indexOf("#");
  const file = hashAt >= 0 ? target.slice(0, hashAt) : target;
  const hash = hashAt >= 0 ? target.slice(hashAt) : "";
  const clean = path.posix.normalize(file);
  if (clean === "." || clean.startsWith("../")) return target;
  if (image) return `${base.replace("https://github.com/", "https://raw.githubusercontent.com/")}/HEAD/${clean}`;
  return `${base}/blob/HEAD/${clean}${hash}`;
}

function rewriteOutsideCode(text: string, base: string): string {
  const fix = (target: string, image: boolean) =>
    target.startsWith("<") && target.endsWith(">") ? `<${absolutize(target.slice(1, -1), base, image)}>` : absolutize(target, base, image);
  return (
    text
      // ![alt](target "title")
      .replace(/!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?)\s*\)/g, (_m, alt, target, title) => `![${alt}](${fix(target, true)}${title})`)
      // [text](target "title"), also around an image: [![alt](img)](target)
      .replace(
        /(^|[^!])\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?)\s*\)/gm,
        (_m, lead, label, target, title) => `${lead}[${label}](${fix(target, false)}${title})`
      )
      // [id]: target
      .replace(/^( {0,3}\[[^\]]+\]:[ \t]*)(<[^>]*>|\S+)/gm, (_m, head, target) => `${head}${fix(target, false)}`)
      // <img src="..."> and <a href="...">
      .replace(/(<img\b[^>]*?\ssrc=)(["'])([^"']*)\2/gi, (_m, head, q, target) => `${head}${q}${absolutize(target, base, true)}${q}`)
      .replace(/(<a\b[^>]*?\shref=)(["'])([^"']*)\2/gi, (_m, head, q, target) => `${head}${q}${absolutize(target, base, false)}${q}`)
  );
}

/** The README with every relative link and image made absolute; fenced code blocks stay as they are. */
export function rewriteReadme(markdown: string, base: string): string {
  const parts = markdown.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m);
  return parts.map((part, i) => (i % 2 === 1 ? part : rewriteOutsideCode(part, base))).join("");
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "copy") {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const base = githubBase(pkg.repository?.url ?? pkg.repository);
    const created: string[] = [];
    for (const name of ASSETS) {
      const target = path.join(pkgDir, name);
      const source = path.join(repoDir, name);
      if (fs.existsSync(target) || !fs.existsSync(source)) continue;
      if (name === "README.md" && base) fs.writeFileSync(target, rewriteReadme(fs.readFileSync(source, "utf8"), base));
      else fs.copyFileSync(source, target);
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
}
