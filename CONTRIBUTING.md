# Contributing to Browser MCP

Thanks for your interest in contributing! This document explains how to get started.

## Code of Conduct

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml).
- Include your OS, browser version, Bun version, extension version, and MCP server version.
- Provide steps to reproduce, expected vs. actual behavior, and relevant logs (the
  server logs to stderr; the popup shows the pairing state and close code).
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

### Suggesting Features

- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).
- Describe the use case and why existing tools do not cover it.

### Pull Requests

1. Fork the repository and create a branch from `develop`:
   `git checkout -b feat/my-change develop`
2. Make your changes with a minimal diff.
3. Run the checks locally (see [Checks](#checks)).
4. Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
5. Link related issues (`Fixes #123`).

Branch naming: `feat/*`, `fix/*`, `docs/*`, `chore/*`, `refactor/*`.

## Development Setup

Requirements:

- [Bun](https://bun.sh). CI uses the version in `mcp-server/.bun-version`; the oldest
  supported runtime is the `engines.bun` minimum in `mcp-server/package.json`
  (`>=1.3.3`), and building the standalone binary needs Bun 1.3.7 or newer.
- Chrome or Edge (Chromium 116 or newer).

Install the dependencies with the pinned Bun; the `engines.bun` minimum is a runtime floor
(the minimum-Bun CI job installs with the pinned Bun and runs the tests on the minimum).
Bun is the only JavaScript runtime and package manager used here (`bun install`, `bun run`,
`bunx`); there is no Node.js / npm setup.

```sh
cd mcp-server
bun install
bun run typecheck
bun run test
```

### Running your checkout

`bun run start` (or `bun run dev` for watch mode) inside `mcp-server/` is fine for a
quick manual run: the working directory is then `mcp-server/`, whose `bunfig.toml` is the
trusted, empty one.

To let an MCP client run your checkout, use the safe launch command. The client starts the
server inside whatever project the agent works on, and Bun would otherwise apply that
project's `bunfig.toml` and `.env` files to the server (see
[SECURITY.md](SECURITY.md#project-bunfigtoml)):

```json
{
  "command": "bun",
  "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
}
```

Only the `--config=<path>` form works: `--config <path>` and `-c <path>` still run the
project's preload and then never start the server, and `-c=<path>` applies the project's
file. Never publish a setup that runs `bun run src/index.ts` from the user's project folder.

Use a separate config directory while you develop, so your everyday pairing stays intact:
set `BROWSER_MCP_HOME` to a scratch folder in the client config or the shell. A project
`.env` file cannot set it (the server ignores it there).

`bun run build:binary` builds `mcp-server/dist/browser-mcp[.exe]` for your machine;
`bun run build:binaries` builds every release target.

### Loading the extension

Load `extension/` via `chrome://extensions` (Developer Mode → Load unpacked). An unpacked
build has its own extension ID (it depends on the folder) and is its own install, so:

- with a fresh config directory it pairs automatically on the first connection;
- otherwise the popup shows **Extension not recognized** (`4003`) or **Pairing is closed**
  (`4004`). Start the server once with `--extension-id <id> --pair` (**Copy ID** in the
  notice copies the ID), then drop both flags: the ID is saved in `trusted-extensions.json`
  and the key in `extension-keys.json`.

See [docs/pairing.md](docs/pairing.md) for every popup state. Reloading the extension keeps
its pairing. After changing server code, restart every browser-mcp process on the port
(every MCP client session that runs it); after changing extension code, reload the
extension.

## Tests

`bun run test` in `mcp-server/` runs every `*.test.ts` below it. Run one file with
`bun test test/unit/toolsets.test.ts`, or filter by name with `bun test -t "pair"`.

| Location | What it covers | How |
| -------- | -------------- | --- |
| `mcp-server/src/*.test.ts` | the module next to it: `bridge.test.ts` (protocol v3 handshake, close codes, pairing window, satellites, cancellation), `env.test.ts` (`.env` scrub, `bunfig.toml` detection, compile flags) | real WebSockets on port 0, temporary config directories |
| `mcp-server/test/unit/` | the server and tool layer: `createServer`, toolsets and hidden-tool errors, output cap and spill folders, `page_snapshot` paging, bundle files (`savePath` / `filePath`), cancellation, the `dom_upload` / `cdp_send` path guard, the CLI, and parity between the tool layer and the extension's catalog, `REQUIRES` and locales | a fake `IBridge` (`test/helpers/unit-fake-bridge.ts`) and an in-memory MCP client |
| `mcp-server/test/integration/` | the real `extension/background.js` talking to the real `ExtensionBridge`: protocol v3 pairing and refusals in both directions, the IndexedDB pairing store and its migration (`protocol.test.ts`), the permission gate, session teardown, `permissions_grant` and the active-tab fallback (`permissions.test.ts`), optionally with `extension/content.js` in a page | mocked `chrome.*` and IndexedDB, a real WebSocket, [happy-dom](https://github.com/capricorn86/happy-dom) pages (`test/helpers/ext-*.ts`) |

Rules:

- Tests must not use the real config directory, the default port or a real browser:
  use port `0`, temporary directories (`configDir` / `BROWSER_MCP_HOME`), `env: {}` for
  `createServer`, and `autoLaunch: false` or a stub launcher for bridges. Tests that spawn
  the server process (`test/unit/cli.test.ts`) give it an isolated environment: an empty
  temporary `BROWSER_MCP_HOME`, a free port, `BROWSER_AUTO_LAUNCH=0` and no watchdog pings.
- Shared helpers live in `mcp-server/test/helpers/`. A helper under `src/` must be named
  `*.test.ts`: the npm package publishes everything else in `src/`.
- happy-dom has no layout (element boxes are 0×0) and no `execCommand`; code paths that
  need a real browser are checked by hand in Chrome.

## Checks

CI (`.github/workflows/ci.yml`) runs on every push and pull request:

- **Typecheck MCP server:** `bun run typecheck` in `mcp-server/`, the CI scripts
  (`bunx tsc -p ../scripts/ci/tsconfig.json` from `mcp-server/`), and `bun run
  docs:tools:check` (`docs/tools.md` matches the server's `tools/list`).
- **Test:** `bun run test:unit` and `bun run test:integration` on Ubuntu, Windows and macOS
  with the pinned Bun; `test:unit` only on Ubuntu with the `engines.bun` minimum (the
  happy-dom harness of the integration tests needs Bun >= 1.4).
- **Standalone binary:** `bun run build:binary` and a smoke test on all three OSes.
- **Validate extension:** syntax, manifest, locales and version sync.

Every job first checks that it runs the Bun it claims (`check-versions.ts --bun=pinned` or
`--bun=minimum`), because setup-bun silently installs the latest Bun when it cannot read a
version.

Every check is a script in `scripts/ci/` and runs locally from the repository root:

```sh
bun scripts/ci/check-syntax.ts            # every extension/*.js parses as a classic script
bun scripts/ci/check-manifest-locales.ts  # manifest.json, referenced files, locales, message keys
bun scripts/ci/check-versions.ts          # version sync (manifest, package.json, server, docs, Bun)
cd mcp-server && bun run typecheck && bunx tsc -p ../scripts/ci/tsconfig.json
cd mcp-server && bun run docs:tools:check       # docs/tools.md is up to date
cd mcp-server && bun run test:unit && bun run test:integration
cd mcp-server && bun run build:binary && cd .. && bun scripts/ci/smoke-binary.ts
```

- `check-syntax.ts` compiles (never runs) each extension script with `new vm.Script(src)`,
  the way Chrome loads classic scripts (`new Function` would accept a top-level `return`).
- `check-manifest-locales.ts`: `manifest.json` and every `_locales/*/messages.json` parse,
  files the manifest and pages reference exist, every locale has exactly the keys (and
  placeholders) of `_locales/en`, and every message key used by `manifest.json`
  (`__MSG_*__`), the HTML pages (`data-i18n*`), `popup.js` (`t("key", ...)`) and the
  permission categories (`cat_<id>` for each `PERM_CATS` entry in `background.js`) exists.
- `check-versions.ts`: see [Versions](#versions). `--bun=pinned` / `--bun=minimum` checks
  that the running Bun is the one the CI job claims.
- `mcp-server/scripts/gen-tools-doc.ts` (`bun run docs:tools` / `docs:tools:check` in
  `mcp-server/`) builds the server with a fake bridge and every toolset, and writes the
  reference block of `docs/tools.md` from its `tools/list`, `resources/list` and
  `prompts/list`, grouped by toolset with the core tools marked. The check mode fails when
  that block is stale, when a tool count quoted in `README.md`, `docs/toolsets.md` or
  `docs/tools.md` is wrong, or when the `core` row of `docs/toolsets.md` misses a core tool.
- `smoke-binary.ts [path]` starts the binary inside a folder with a hostile
  `bunfig.toml` preload, sends MCP `initialize` and `tools/list`, expects exit code 0 on
  stdin EOF and checks that the preload never ran.

## Change Rules

### Extension

- Keep `extension/` dependency-free vanilla JS. Scripts are classic scripts (no ES
  modules), and `content.js` stays one IIFE.
- A new bridge action needs an entry in `PERM_CATS` in `background.js`: the command gate is
  an allow-list and refuses anything else with `Unknown command: <action>`. Mirror it in
  `EXTENSION_ACTIONS` (and `REQUIRES` in `EXTENSION_REQUIRES`) in
  `mcp-server/src/tool-kit.ts`; the parity tests fail when the two drift. Never edit
  `KNOWN_ACTIONS_0_3_5`: it is the 0.3.5 catalog that upgrades compare against.
- Debugger-backed state that outlives a command (overrides, throttles, traces) must be
  registered with `registerDebugSession`, so switching it off in the popup and losing the
  bridge tear it down.
- New MCP tools go through `kit.define` in `mcp-server/src/tools/<group>.ts` with the
  category of their action, so cancellation, the output cap, toolsets and permission-aware
  hiding apply to them. A changed tool, parameter or description needs `bun run docs:tools`
  in `mcp-server/` (it rewrites the reference block of `docs/tools.md`; CI fails when it is
  stale), and a new tool also the counts it reports in `README.md` and `docs/toolsets.md`.

### Locales

Every new or changed UI string goes into all 10 locales (`de`, `en`, `es`, `fr`, `it`,
`ja`, `ko`, `pt_BR`, `ru`, `tr`) in the same change, with real translations and the same
placeholders as `_locales/en`. A new permission category needs a `cat_<id>` key.

### Bridge protocol

The protocol is shared by `mcp-server/src/bridge.ts`, `extension/background.js` and the
popup (`popup.js`, `popup.html`, locales), and a change to it goes into all three in the
same pull request:

- bump `BRIDGE_PROTOCOL` in `bridge.ts` and `PROTOCOL_VERSION` in `background.js`
  together, so an older peer gets a clear refusal (`4002` / `4102`) and the popup tells the
  user which side to update, instead of a silent failure;
- keep the frame list and close codes in sync: the header comments of both files,
  `refusalText` in `bridge.ts`, `CLOSE_PAIR_STATES` and `SLOW_RETRY_CODES` in
  `background.js`, `PAIR_STATES` and the notices in `popup.js` (each notice's **Details**
  link opens its heading in docs/pairing.md), and the tables in
  [SECURITY.md](SECURITY.md), [docs/pairing.md](docs/pairing.md) and
  [docs/bridge-protocol.md](docs/bridge-protocol.md) (client authentication and the script
  example);
- extend `src/bridge.test.ts` and the integration tests.

After upgrading, restart every browser-mcp server process and reload the extension.

### Versions

- Releases bump `extension/manifest.json` and `mcp-server/package.json` together.
- The server reads its version from `package.json` (`SERVER_VERSION` in `bridge.ts`, used
  in the bridge `welcome` and in the MCP `initialize` result). Never hard-code the version
  in server sources.
- Docs that pin the npm package (`@taiizor/browser-mcp@<version>`) must pin the current
  name and version, and at least one doc must pin it. Version phrases (`prints <version>`,
  `Server v<version>`, `browser-mcp <version>`) must name the current version.
- `mcp-server/.bun-version` must satisfy `engines.bun`, and the minimum-Bun CI job must run
  exactly the `engines.bun` minimum.
- Every `oven-sh/setup-bun` step in `ci.yml` names its Bun: `bun-version-file` pointing at
  an existing file, or `bun-version` as an exact `x.y.z` or a `${{ matrix.* }}` expression.

`scripts/ci/check-versions.ts` enforces all of these.

### Configuration

A new `BROWSER_MCP_*` setting is ignored when it comes from a project `.env` file, unless
it is listed in `PROJECT_ENV_ALLOWED` in `mcp-server/src/env.ts`. Add only harmless
settings there, never ones that decide trust, paths or secrets.

## Project Structure

```text
mcp-server/       MCP server (Bun, stdio) + WebSocket bridge
  src/            index.ts (CLI), server.ts, tool-kit.ts, toolsets.ts, bridge.ts, env.ts,
                  upload-guard.ts, tools/ (one file per tool group)
  test/           unit/, integration/, helpers/
  bin/            browser-mcp.js (package launcher)
  scripts/        build-binaries.ts, pack-assets.ts, gen-tools-doc.ts (docs/tools.md)
extension/        Chrome MV3 extension (background, content, offscreen, popup)
scripts/ci/       CI checks (run from the repository root)
docs/             User documentation
.github/          Issue/PR templates, workflows, label definitions
```

## Commit Messages

Use clear, imperative messages, e.g. `fix: reconnect popup on port change`.
Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:`) is preferred.

## Releases

Maintainers cut releases from `develop` with a version bump in `mcp-server/package.json`
and `extension/manifest.json` (and the pinned version in the docs, plus `bun run docs:tools`,
whose header names the version); CI fails when they differ. `bun run build:binaries` in `mcp-server/` builds the standalone executables for the
release.

## License

Contributions are licensed under the [MIT License](LICENSE).
