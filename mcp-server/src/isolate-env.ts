/**
 * Side-effect module, imported first by index.ts: removes what Bun loaded from the working
 * directory's `.env` files before any other module reads the environment, and warns when Bun
 * applied the working directory's bunfig.toml to this process (see env.ts).
 */
import path from "node:path";
import { describeScrub, findUntrustedBunfig, scrubWorkingDirEnv } from "./env.js";

const isBun = typeof Bun !== "undefined";

const scrub = scrubWorkingDirEnv({
  cwd: process.cwd(),
  env: process.env,
  execArgv: process.execArgv,
  isBun,
  bunVersion: isBun ? Bun.version : undefined,
});
for (const line of describeScrub(scrub, process.cwd())) console.error(line);

// A warning, not a refusal: by the time this runs the file's preload/define already did whatever
// it does, and refusing to start would only break projects with an innocent bunfig.toml.
const trustedConfig = isBun ? path.resolve(import.meta.dir, "..", "bunfig.toml") : "";
const bunfig = isBun
  ? findUntrustedBunfig({ cwd: process.cwd(), execArgv: process.execArgv, isBun, main: Bun.main, trustedConfig })
  : null;
if (bunfig) {
  console.error(
    `[browser-mcp] warning: Bun applied ${bunfig} to this process (a project's preload/define runs inside the server); ` +
      `start it with "bun --config=${trustedConfig} --no-env-file run ${Bun.main}" ` +
      `or use the standalone binary`,
  );
}
