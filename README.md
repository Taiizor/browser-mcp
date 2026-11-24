# Browser MCP — Full-Authority Browser Bridge (Chromium)

[![CI](https://github.com/Taiizor/browser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Taiizor/browser-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Chrome MV3](https://img.shields.io/badge/Extension-Chrome%20MV3-blue?logo=googlechrome)](extension/)
[![Edge Add-ons](docs/badges/edge-addons.svg)](https://microsoftedge.microsoft.com/addons/detail/hdhibkihdkndmfecegdnbpebolhokkbh)

An MCP server (`stdio`) and a Chrome/Edge extension that together let an AI agent drive **your own browser**: the
profile, tabs and logins you already use, not a headless copy. Clicking, typing, tab and window management,
network capture and mocking, console, cookies, storage, emulation, Web Vitals and performance traces,
screenshots, PDF, tab audio and raw CDP, with every action behind a switch in the extension popup.

## Features

- **122 tools in 22 category toolsets.** Only the `core` toolset (28 everyday tools, 31 listed with the always-on
  meta tools) is advertised by default; the agent enables more at runtime with `browser_toolsets`.
- **Built for LLM context.** Text results are capped at 40,000 characters (the rest goes to a private temp
  folder that is removed when the server exits; cookie, storage, session and clipboard text is never written
  to disk), `page_snapshot` / `page_text` / `page_html` page with `offset` / `nextOffset`, snapshots show
  live form state and select options, and tools hidden by a toolset or a popup switch disappear from the tool
  list; calling one anyway returns an error that names the fix.
- **Real input.** `dom_type` sends per-character key events that React/Vue inputs accept (newlines are
  Shift+Enter line breaks, so chat composers do not send mid-text); `trusted_*` tools send CDP mouse and
  keyboard events; selectors pierce shadow DOM and frames are addressable.
- **DevTools power.** Network requests, HAR export, mocking and throttling, console capture, viewport /
  media / CPU emulation, Web Vitals, performance traces and network-idle waits.
- **Cancellation.** Cancelling an MCP call stops the command in the browser (`page_wait`, `dom_type`, traces ...).
- **You stay in control.** 21 permission categories with per-action switches and an audit log. The agent can
  switch actions off, never on.
- **Authenticated local bridge.** Loopback only, protocol v3: each extension install and the server prove a
  shared pairing key to each other on every connection; satellites and local scripts prove the per-run bridge
  token, and satellites check the primary's proof first.
- **Safe in untrusted projects.** The server drops what Bun loaded from a project's `.env` (a project may only
  set harmless options such as the port), and the documented launch commands keep the project's `bunfig.toml`
  out of the server process.
- **Several agents, one browser.** Later server processes join the first one as satellites.
- Windows, macOS and Linux; Bun or a standalone binary.

## Architecture

```text
AI client (Claude Code / OpenCode / Cursor / Gemini CLI / any MCP client)
  │  stdio: MCP tools (core toolset by default, browser_toolsets adds more), resources, prompts
  ▼
mcp-server/  (Bun or standalone binary; the first process owns the bridge,
  │           later processes join it as satellites; both sides prove the per-run token)
  │  ws://127.0.0.1:8765  (loopback only; --port / BROWSER_MCP_PORT)
  │  bridge protocol v3: trusted extension id + mutual HMAC proof of a per-install pairing key
  ▼
extension/  (Chromium MV3, 116+)
  ├── background.js → command router, allow-list permission gate, tabs/windows, cookies, history,
  │                   webRequest capture, debugger/CDP (trusted input, screenshots, PDF, mocking,
  │                   throttling, emulation, tracing), cancellation, session teardown
  ├── content.js    → DOM snapshot & refs, selectors, click/type/fill, page_wait, storage & IndexedDB
  ├── offscreen.js  → clipboard, tab audio recording
  └── popup.js      → permission switches, audit log, port, pairing status (Re-pair / Forget pairing)
```

## Quick Start

### 1. Install the server

Pick one. Details and update steps: [docs/installation.md](docs/installation.md).

**A. Standalone binary** (no Bun needed to run it). Build it once with Bun >= 1.4.0, or take the file for your
platform from a GitHub release when one provides binaries:

```sh
git clone https://github.com/Taiizor/browser-mcp.git
cd browser-mcp/mcp-server && bun install && bun run build:binary   # -> dist/browser-mcp(.exe)
```

**B. bunx** (after the first npm release of `@taiizor/browser-mcp`). Always pin the version:

```sh
bunx @taiizor/browser-mcp@0.4.0
```

bunx itself still applies the current project's `bunfig.toml` and `.env` to its short-lived launcher process
(the server process is started clean). In untrusted projects use the binary, or
`bunx --cwd=<trusted folder> @taiizor/browser-mcp@0.4.0`.

**C. From source** (`bun install` needs Bun >= 1.4.0, which reads `bun.lock`; the server then runs on Bun >= 1.3.3):

```sh
git clone https://github.com/Taiizor/browser-mcp.git
cd browser-mcp/mcp-server && bun install
```

The client then runs this command (`<repo>` = absolute path of the clone, forward slashes on Windows).
Only the `--config=<path>` form works, so keep the `=`:

```sh
bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts
```

### 2. Install the extension

Chrome, Edge, Brave or Opera 116 or newer. Install it from
[Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hdhibkihdkndmfecegdnbpebolhokkbh), or load it
unpacked: `chrome://extensions` → **Developer mode** → **Load unpacked** → select the `extension/` folder.
Use an extension from the same release as the server (both speak bridge protocol 3).

### 3. Add it to your MCP client

Most clients take an `mcpServers` entry (per-client files and formats: [docs/clients.md](docs/clients.md)):

```json
{
  "mcpServers": {
    "browser": {
      "command": "bun",
      "args": [
        "--config=<repo>/mcp-server/bunfig.toml",
        "--no-env-file",
        "run",
        "<repo>/mcp-server/src/index.ts"
      ]
    }
  }
}
```

With the binary use `"command": "<path>/browser-mcp(.exe)", "args": []`; with bunx use
`"command": "bunx", "args": ["@taiizor/browser-mcp@0.4.0"]`. Claude Code in one line:

```sh
claude mcp add browser -- bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts
```

GUI clients (Claude Desktop, Cursor, Windsurf) may not see your shell `PATH`: put the full path of `bun` in
`command`, or use the binary.

### First-time pairing

Start the client with the browser open: on a fresh setup the first extension install that connects is
trusted and paired automatically, and the popup badge turns **Connected**. From then on the server and that
install prove a shared pairing key to each other on every connection, so another install (a second browser
or profile, a moved unpacked folder) is refused until you start the server once with `--pair` (or
`BROWSER_MCP_PAIR=1`; add `--extension-id <id>` for an unpacked build with a new id). If the popup shows **Rejected**, **Action needed**, **Unverified server** or
**Update needed**, follow [docs/pairing.md](docs/pairing.md).

## Documentation

| Topic | Contents |
|---|---|
| [Installation](docs/installation.md) | Binary, bunx and source installs, Bun versions, the extension, updating |
| [Client configuration](docs/clients.md) | OpenCode, Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI, Antigravity |
| [Configuration](docs/configuration.md) | CLI flags, environment variables, port, project `.env` rules, browser launch, config directory, upload folders |
| [Toolsets and output budget](docs/toolsets.md) | `core` and other toolsets, `browser_toolsets`, hidden tools, the output cap and paging |
| [Tool reference](docs/tools.md) | All 122 tools with parameters, plus resources and prompts (generated from the server) |
| [Extension and permissions](docs/extension.md) | Popup, permission categories, agent tabs, debugger sessions |
| [Pairing and trust](docs/pairing.md) | Trust model, `--pair`, Re-pair / Forget pairing, popup states, every close code |
| [Multiple agents and scripts](docs/bridge-protocol.md) | Primary / satellites, driving the bridge from your own scripts |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms and fixes |

## Security & Privacy

The bridge listens on `127.0.0.1` only. Web pages are refused at the WebSocket upgrade, extensions must have a
trusted id and complete the pairing-key handshake, and local scripts must prove the per-run bridge token. Every
action can be switched off in the popup; the agent can disable actions but never re-enable them. `js_evaluate`
and `cdp_send` (**Power**) can reach anything the other switches guard: turn **Power** off when the switches
must be a hard boundary.

- Threat model and how to report a vulnerability privately: [SECURITY.md](SECURITY.md)
- What is captured, when, and where it goes: [PRIVACY.md](PRIVACY.md)

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first. Bug reports and feature requests use
issue templates; PRs should target the `develop` branch.

## License

[MIT](LICENSE) © 2026 Taiizor.
