// The packed README: relative links and images become absolute GitHub URLs, because npm resolves
// them against repository.directory (mcp-server/), where the docs do not live.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { absolutize, githubBase, rewriteReadme } from "../../scripts/pack-assets";

const BASE = "https://github.com/Taiizor/browser-mcp";
const RAW = "https://raw.githubusercontent.com/Taiizor/browser-mcp/HEAD";

describe("githubBase", () => {
  test("accepts the usual repository URL forms and refuses other hosts", () => {
    expect(githubBase("git+https://github.com/Taiizor/browser-mcp.git")).toBe(BASE);
    expect(githubBase("https://github.com/Taiizor/browser-mcp")).toBe(BASE);
    expect(githubBase("git@github.com:Taiizor/browser-mcp.git")).toBe(BASE);
    expect(githubBase("https://gitlab.com/x/y.git")).toBeNull();
    expect(githubBase(undefined)).toBeNull();
  });
});

describe("absolutize", () => {
  test("links go to blob/HEAD with their anchor, images to raw.githubusercontent.com", () => {
    expect(absolutize("docs/pairing.md#popup-states", BASE, false)).toBe(`${BASE}/blob/HEAD/docs/pairing.md#popup-states`);
    expect(absolutize("./LICENSE", BASE, false)).toBe(`${BASE}/blob/HEAD/LICENSE`);
    expect(absolutize("docs/badges/edge-addons.svg", BASE, true)).toBe(`${RAW}/docs/badges/edge-addons.svg`);
  });
  test("absolute URLs, anchors, root-relative and out-of-repo paths are left alone", () => {
    for (const t of ["https://example.com/a.md", "mailto:x@example.com", "#license", "/docs/x.md", "../outside.md", "data:image/png;base64,AA"]) {
      expect(absolutize(t, BASE, false)).toBe(t);
    }
  });
});

describe("rewriteReadme", () => {
  test("rewrites markdown links, images, badges inside links, reference definitions and HTML attributes", () => {
    const md = [
      "[Docs](docs/installation.md) and [anchor](#license) and [site](https://example.com).",
      "[![Edge](docs/badges/edge-addons.svg)](https://microsoftedge.microsoft.com/addons/detail/x)",
      '![Shot](docs/screenshots/popup-permissions.png "Popup")',
      "[ref]: docs/tools.md",
      '<img src="docs/screenshots/popup-history.png" width="300"> <a href="SECURITY.md">Security</a>',
    ].join("\n");
    const out = rewriteReadme(md, BASE);
    expect(out).toContain(`[Docs](${BASE}/blob/HEAD/docs/installation.md)`);
    expect(out).toContain("[anchor](#license)");
    expect(out).toContain("[site](https://example.com)");
    expect(out).toContain(`[![Edge](${RAW}/docs/badges/edge-addons.svg)](https://microsoftedge.microsoft.com/addons/detail/x)`);
    expect(out).toContain(`![Shot](${RAW}/docs/screenshots/popup-permissions.png "Popup")`);
    expect(out).toContain(`[ref]: ${BASE}/blob/HEAD/docs/tools.md`);
    expect(out).toContain(`<img src="${RAW}/docs/screenshots/popup-history.png" width="300">`);
    expect(out).toContain(`<a href="${BASE}/blob/HEAD/SECURITY.md">`);
  });

  test("fenced code blocks stay untouched", () => {
    const md = "Before [a](docs/a.md)\n```md\n[b](docs/b.md) <img src=\"x.png\">\n```\nAfter [c](docs/c.md)\n";
    const out = rewriteReadme(md, BASE);
    expect(out).toContain("[b](docs/b.md) <img src=\"x.png\">");
    expect(out).toContain(`[a](${BASE}/blob/HEAD/docs/a.md)`);
    expect(out).toContain(`[c](${BASE}/blob/HEAD/docs/c.md)`);
  });

  test("the repository README keeps no relative link or image, and every target exists", () => {
    const repo = path.resolve(import.meta.dir, "../../..");
    const out = rewriteReadme(fs.readFileSync(path.join(repo, "README.md"), "utf8"), BASE);
    const targets = [...out.matchAll(/!?\[[^\]]*\]\(([^)\s]+)[^)]*\)|\s(?:src|href)="([^"]+)"|^\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1] || m[2] || m[3]);
    const relative = targets.filter((u) => !/^(?:https?:|mailto:|#|data:)/.test(u));
    expect(relative).toEqual([]);
    for (const u of targets) {
      const m = /^https:\/\/(?:github\.com\/Taiizor\/browser-mcp\/blob|raw\.githubusercontent\.com\/Taiizor\/browser-mcp)\/HEAD\/([^#]+)/.exec(u);
      if (m) expect(fs.existsSync(path.join(repo, decodeURIComponent(m[1])))).toBe(true);
    }
  });
});
