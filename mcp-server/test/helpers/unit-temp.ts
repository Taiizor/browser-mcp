// Temp directories for unit tests, always removed again (call cleanupTempDirs
// from afterEach / afterAll).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const created: string[] = [];

/** A fresh private directory under os.tmpdir(), removed by cleanupTempDirs(). */
export function makeTempDir(prefix = "unit"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `browser-mcp-${prefix}-`));
  created.push(dir);
  return dir;
}

/** Registers a path created elsewhere (e.g. by saveToPrivateTemp) for removal. */
export function trackTempPath(p: string): void {
  created.push(p);
}

export function cleanupTempDirs(): void {
  while (created.length) {
    const p = created.pop()!;
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp dir must not fail an unrelated test.
    }
  }
}
