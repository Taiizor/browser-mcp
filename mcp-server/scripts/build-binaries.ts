/**
 * Builds standalone server executables, so users need neither Bun nor a checkout.
 *
 *   bun run build:binary     dist/browser-mcp[.exe] for this machine
 *   bun run build:binaries   dist/browser-mcp-<os>-<arch>[.exe] for every release target
 *   bun scripts/build-binaries.ts bun-linux-x64 ...   only the given targets
 *
 * A Bun standalone executable reads the working directory's bunfig.toml and .env files at
 * startup unless it is built otherwise, and MCP clients start it inside arbitrary projects.
 * --compile-exec-argv=--no-env-file puts the flag into process.execArgv, which is how
 * isolate-env.ts knows that nothing was loaded and no bunfig.toml was read (env.ts).
 */
import fs from "node:fs";
import path from "node:path";

export const TARGETS = ["bun-windows-x64", "bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64"];

/** Older releases accept --no-compile-autoload-bunfig but the binary still runs a cwd bunfig.toml preload (checked: 1.3.6 does, 1.3.7 does not). */
export const MIN_BUN_COMPILE = "1.3.7";

export const SAFE_COMPILE_FLAGS = [
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--compile-exec-argv=--no-env-file",
];

const root = path.resolve(import.meta.dir, "..");
const entry = path.join(root, "src", "index.ts");
const dist = path.join(root, "dist");

function build(target: string | null): boolean {
  const name = target ? `browser-mcp-${target.replace(/^bun-/, "")}` : "browser-mcp";
  const outfile = path.join(dist, name);
  const cmd = [process.execPath, "build", ...SAFE_COMPILE_FLAGS, ...(target ? [`--target=${target}`] : []), `--outfile=${outfile}`, entry];
  console.error(`[build] ${target ?? "host"} -> ${path.relative(root, outfile)}`);
  const run = Bun.spawnSync({ cmd, cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  return run.exitCode === 0;
}

// Imported by env.test.ts for SAFE_COMPILE_FLAGS: build only when run as a script.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--all" && !TARGETS.includes(a));
  if (unknown.length) {
    console.error(`[build] unknown target(s): ${unknown.join(", ")} (known: ${TARGETS.join(", ")}, --all)`);
    process.exit(2);
  }
  const targets: (string | null)[] = args.includes("--all") ? TARGETS : args.length ? args : [null];
  // Cross-compiled targets embed the runtime of this same Bun version, so one check covers all.
  if (!Bun.semver.satisfies(Bun.version, `>=${MIN_BUN_COMPILE}`)) {
    console.error(`[build] Bun ${Bun.version} builds binaries that still read the working directory's bunfig.toml; use Bun >= ${MIN_BUN_COMPILE}`);
    process.exit(2);
  }

  fs.mkdirSync(dist, { recursive: true });
  const failed = targets.filter((t) => !build(t));
  if (failed.length) {
    console.error(`[build] failed: ${failed.map((t) => t ?? "host").join(", ")}`);
    process.exit(1);
  }
}
