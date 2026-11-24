#!/usr/bin/env bun
/**
 * Package entry point: `bunx @taiizor/browser-mcp@<version>`, or `browser-mcp` after
 * `bun add -g @taiizor/browser-mcp`.
 *
 * MCP clients start this command inside whatever project the agent works on, and Bun applies
 * that folder's bunfig.toml (preload, define) and .env files to every process it starts there;
 * bunx accepts neither --config nor --no-env-file. So the server never runs in this process:
 * it runs as a child started with this package's own bunfig.toml and without env file loading
 * (the documented safe launch), and this process only waits for it, forwarding its exit code
 * and termination signals. The child is src/index.ts itself, never this file again, so no
 * re-entry marker is needed and index.ts stays the main module.
 *
 * Residual risk this cannot remove: a project bunfig.toml preload runs in THIS process before
 * the first line here (bunx/bun read it before any package code). For untrusted projects use
 * the standalone binary, or give bunx a trusted folder: `bunx --cwd=<folder> ...`.
 */
import path from "node:path";
import { describeScrub, findUntrustedBunfig, scrubWorkingDirEnv } from "../src/env.js";

const pkgDir = path.resolve(import.meta.dir, "..");
const trustedConfig = path.join(pkgDir, "bunfig.toml");
const entry = path.join(pkgDir, "src", "index.ts");
const cwd = process.cwd();

// The child inherits this environment, so drop what Bun loaded from the project's env files
// here; --no-env-file alone would not help once the values are part of the real environment.
const scrub = scrubWorkingDirEnv({ cwd, env: process.env, execArgv: process.execArgv, isBun: true, bunVersion: Bun.version });
for (const line of describeScrub(scrub, cwd)) console.error(line);
const bunfig = findUntrustedBunfig({ cwd, execArgv: process.execArgv, isBun: true, main: Bun.main, trustedConfig });
if (bunfig) {
  console.error(
    `[browser-mcp] warning: Bun applied ${bunfig} to the launcher process (bunx cannot skip it; the server itself runs ` +
      `without it); for untrusted projects use the standalone binary or "bunx --cwd=<trusted folder> ..."`,
  );
}

const child = Bun.spawn({
  cmd: [process.execPath, `--config=${trustedConfig}`, "--no-env-file", "run", entry, ...process.argv.slice(2)],
  // Under `bunx --bun` process.execPath is bunx(.exe), which treats every flag as a package
  // flag; argv0 "bun" makes the same binary behave as bun.
  argv0: "bun",
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

// Forward termination signals and wait for the child to exit. Not on Windows: there a console
// Ctrl+C already reaches the child directly, and kill() would be a hard TerminateProcess.
// (A Ctrl+C that reaches both on POSIX is harmless: the server's shutdown runs once.)
if (process.platform !== "win32") {
  for (const signal of /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {}
    });
  }
}

// The server's parent watchdog only sees this launcher, so watch the real client here: when it
// died without closing our stdio (kill -9, crash), stop the server instead of leaving it on the
// port. Same switches as the server's own watchdog.
const parentPid = process.ppid;
const parentCheckMs = Number(process.env.BROWSER_MCP_PARENT_CHECK_MS ?? 10000);
if (process.env.BROWSER_MCP_NO_PARENT_CHECK !== "1" && parentPid > 1 && Number.isFinite(parentCheckMs) && parentCheckMs > 0) {
  const timer = setInterval(() => {
    let gone = false;
    try {
      gone = process.ppid !== parentPid && process.ppid <= 1; // reparented to init (POSIX)
    } catch {}
    try {
      process.kill(parentPid, 0);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "ESRCH") gone = true; // EPERM means it is alive
    }
    if (gone) {
      clearInterval(timer);
      try {
        child.kill();
      } catch {}
    }
  }, parentCheckMs);
  timer.unref?.();
}

const code = await child.exited;
process.exit(child.signalCode ? 1 : (code ?? 1));
