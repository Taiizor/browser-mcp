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

Requirements: [Bun](https://bun.sh) >= 1.1, Chrome or Edge (Chromium).

```powershell
cd mcp-server
bun install
bun run typecheck
```

Load the extension from `extension/` via `chrome://extensions` (Developer Mode → Load unpacked).

### Checks

- `bun run typecheck` in `mcp-server/` (runs in CI).
- Keep `extension/` dependency-free vanilla JS; validate `manifest.json` stays valid JSON.

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
`mcp-server/package.json` and `extension/manifest.json` (keep them in sync).

## License

Contributions are licensed under the [MIT License](LICENSE).
