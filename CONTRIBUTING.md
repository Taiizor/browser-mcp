# Contributing to Browser MCP

Thanks for your interest in contributing! This document explains how to get started.

## Code of Conduct

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml).
- Include your OS, browser version, Bun version, extension version, and MCP server version.
- Provide steps to reproduce, expected vs. actual behavior, and relevant logs.

### Suggesting Features

- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).
- Describe the use case and why existing tools do not cover it.

### Pull Requests

1. Fork the repository and create a branch from `develop`:
   `git checkout -b feat/my-change develop`
2. Make your changes with a minimal diff.
3. Run checks locally (see below).
4. Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
5. Link related issues (`Fixes #123`).

Branch naming: `feat/*`, `fix/*`, `docs/*`, `chore/*`, `refactor/*`.

## Development Setup

Requirements: [Bun](https://bun.sh) >= 1.1, Chrome or Edge (Chromium 116 or newer).

```powershell
cd mcp-server
bun install
bun run typecheck
```

Load the extension from `extension/` via `chrome://extensions` (Developer Mode → Load unpacked).
An unpacked build has its own extension ID: if the server already paired another build, the popup
shows `Rejected`. Set `BROWSER_MCP_EXTENSION_IDS` to the ID shown there, or delete
`~/.browser-mcp/trusted-extensions.json` and restart the server to pair again (see "Pairing & Trust"
in the README).

Bun is the only JavaScript runtime and package manager used here (`bun install`, `bun run`, `bunx`);
there is no Node.js / npm setup.

### Checks

CI (`.github/workflows/ci.yml`) runs two jobs on every push and pull request:

- **Typecheck MCP server:** `bun run typecheck` in `mcp-server/`.
- **Validate extension:**
  - every `extension/*.js` must parse as a classic script (compiled with Bun, never executed);
  - `extension/manifest.json` and every `extension/_locales/*/messages.json` must be valid JSON;
  - every locale must have exactly the keys (and placeholders) of `_locales/en`;
  - every message key used by `manifest.json` (`__MSG_*__`), `popup.html` (`data-i18n*`), `popup.js`
    (`t("key", ...)`) and the permission categories (`cat_<id>` for each `PERM_CATS` entry in
    `background.js`) must exist;
  - the versions in `extension/manifest.json`, `mcp-server/package.json` and the `McpServer`
    constructor in `mcp-server/src/index.ts` must match.

Keep `extension/` dependency-free vanilla JS. When you add or rename a UI string, update all
10 locales in the same change. The check scripts are inlined in `ci.yml`; to run one locally,
copy it from there into a scratch file and run it with `bun <file>` from the repository root.

## Project Structure

```text
mcp-server/   MCP server (Bun, stdio) + WebSocket bridge
extension/    Chrome MV3 extension (background, content, offscreen, popup)
.github/      Issue/PR templates, workflows, label definitions
```

## Commit Messages

Use clear, imperative messages, e.g. `fix: reconnect popup on port change`.
Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:`) is preferred.

## Releases

Maintainers cut releases from `develop` with a version bump in
`mcp-server/package.json`, `extension/manifest.json` and the `McpServer` version in
`mcp-server/src/index.ts` (keep all three in sync; CI fails otherwise).

The WebSocket bridge protocol (v2) is shared by `mcp-server/src/bridge.ts` and
`extension/background.js`: a change on one side usually needs the other side in the same
release. After upgrading, restart every browser-mcp server process and reload the extension.

## License

Contributions are licensed under the [MIT License](LICENSE).
