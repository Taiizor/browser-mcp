/**
 * Side-effect module, imported first by index.ts: removes what Bun loaded from the working
 * directory's `.env` files before any other module reads the environment (see env.ts).
 */
import { scrubWorkingDirEnv } from "./env.js";

const scrub = scrubWorkingDirEnv({
  cwd: process.cwd(),
  env: process.env,
  execArgv: process.execArgv,
  isBun: typeof Bun !== "undefined",
});

if (scrub.removed.length) {
  const shown = scrub.removed.slice(0, 8).join(", ") + (scrub.removed.length > 8 ? ", …" : "");
  console.error(
    `[browser-mcp] ignored ${scrub.removed.length} variable(s) Bun loaded from ${scrub.files.join(", ")} in ${process.cwd()} ` +
      `(${shown}); start the server with "bun --no-env-file run …" to skip loading them`
  );
}
