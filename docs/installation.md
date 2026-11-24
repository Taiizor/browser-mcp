# Installation

Browser MCP has two parts that must come from the same release: the MCP server (`mcp-server/`), which your
MCP client starts over stdio, and the browser extension (`extension/`), which connects to the server on
`ws://127.0.0.1:8765`. Both speak bridge protocol 3 (see [pairing.md](pairing.md#version-mismatch)).

- [Requirements](#requirements)
- [Server: standalone binary](#option-a-standalone-binary)
- [Server: bunx](#option-b-bunx-after-the-first-npm-release)
- [Server: from source](#option-c-from-source)
- [Why the long bun command](#why-the-long-bun-command)
- [Extension](#extension)
- [Check the installation](#check-the-installation)
- [Updating](#updating)

## Requirements

| Part | Needs |
|---|---|
| Browser | A Chromium browser 116 or newer: Chrome, Edge, Brave, Opera |
| Server, binary | Nothing at runtime. Building it needs [Bun](https://bun.sh) >= 1.4.0 (`bun install` in the checkout; the build itself refuses Bun < 1.3.7) |
| Server, bunx | Bun >= 1.3.3 on `PATH` (1.3.2 and older load project `.env` files despite `--no-env-file`) |
| Server, source | Bun >= 1.4.0 for `bun install` in the checkout (older Bun cannot read `bun.lock`); running it needs Bun >= 1.3.3 |
| Audio conversion (optional) | `ffmpeg`, for tab audio saved as anything other than `.webm` ([configuration](configuration.md#environment-variables)) |

The repository pins the Bun version used by CI in `mcp-server/.bun-version`. `engines.bun` (`>=1.3.3`) is only the
runtime floor for an installed tree: `bun.lock` is a version-2 lockfile, which Bun releases before 1.4.0 do not
understand (a plain `bun install` then resolves fresh versions instead of the tested ones, and
`--frozen-lockfile` fails).

## Server

### Option A: standalone binary

A single executable that embeds the Bun runtime. It is compiled so that it never reads a `bunfig.toml` or
`.env` file from the folder the client starts it in, and it does not depend on `bun` being on `PATH`, which
makes it the best choice for GUI clients and for untrusted projects.

Build it from a checkout (Bun >= 1.3.7, and >= 1.4.0 for `bun install`; the build script refuses older versions,
whose binaries still ran a project's `bunfig.toml` preload):

```sh
git clone https://github.com/Taiizor/browser-mcp.git
cd browser-mcp/mcp-server
bun install
bun run build:binary     # this machine: dist/browser-mcp (dist/browser-mcp.exe on Windows)
bun run build:binaries   # every release target, see below
```

`build:binaries` writes `dist/browser-mcp-windows-x64.exe`, `dist/browser-mcp-linux-x64`,
`dist/browser-mcp-linux-arm64`, `dist/browser-mcp-darwin-x64` and `dist/browser-mcp-darwin-arm64` (about
90-116 MB each). When a GitHub release provides these files, you can download the one for your platform
instead of building it. Move the file wherever you like and point the client at its absolute path:

```json
{ "command": "C:/Tools/browser-mcp-windows-x64.exe", "args": [] }
```

The Windows x64 and Linux x64 binaries have been run; the macOS and Linux arm64 builds have only been
built so far, and whether the macOS binaries need code signing has not been checked yet.

### Option B: bunx (after the first npm release)

The npm package is `@taiizor/browser-mcp` (command `browser-mcp`). These instructions apply once it has been
published to npm.

```sh
bunx @taiizor/browser-mcp@0.4.0
```

Client entry: `{"command": "bunx", "args": ["@taiizor/browser-mcp@0.4.0"]}`, or
`claude mcp add browser -- bunx @taiizor/browser-mcp@0.4.0`.

- **Always pin the version** (`@taiizor/browser-mcp@0.4.0`, not `@taiizor/browser-mcp`). An unversioned `bunx <name>` first runs
  `node_modules/.bin/<name>` of the current folder, which a repository can plant; a versioned spec does not.
- **Use the scoped name.** The unscoped `browser-mcp-server` and `browser-mcp` on npm are different packages,
  not this project.
- **Residual risk.** bunx accepts neither `--config` nor `--no-env-file`, so the project's `bunfig.toml`
  (preload, define) and `.env` files apply to the short-lived launcher process before any package code runs.
  The launcher then starts the server as a child with the package's own `bunfig.toml`, `--no-env-file` and a
  cleaned environment, so the server process itself is clean, and it warns on stderr when it saw a project
  `bunfig.toml`. For untrusted projects use the binary, or run bunx from a folder you trust:
  `bunx --cwd=<absolute trusted folder> @taiizor/browser-mcp@0.4.0`. With `--cwd` the server's working
  directory becomes that folder, which is also one of the default [upload folders](configuration.md#upload-folders-dom_upload).
- Global install: `bun add -g @taiizor/browser-mcp@0.4.0` puts a `browser-mcp` command on `PATH` that
  behaves like the bunx launcher.

### Option C: from source

Installing the dependencies needs Bun >= 1.4.0 (CI uses the version in `mcp-server/.bun-version`); the server
itself then runs on Bun >= 1.3.3.

```sh
git clone https://github.com/Taiizor/browser-mcp.git
cd browser-mcp/mcp-server
bun install
```

The client must run exactly this command, with `<repo>` replaced by the absolute path of the clone (on
Windows write forward slashes, e.g. `C:/src/browser-mcp`):

```sh
bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts
```

As client JSON:

```json
{
  "command": "bun",
  "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
}
```

`bun run start` / `bun run dev` inside `mcp-server/` are for development only; do not use them as the client
command.

### Why the long bun command

MCP clients start the server with the working directory set to whatever project the agent works on, and Bun
applies that folder's files to every process it starts there:

- **`bunfig.toml`** can `preload` a script, which would run inside the server before any of its code.
  `--config=<repo>/mcp-server/bunfig.toml` makes Bun read the (empty) config shipped with the server instead.
  Only the `--config=<path>` form works with Bun 1.4: `--config <path>` and `-c <path>` (with a space) still
  run the project's `bunfig.toml` preload and then exit with code 0 without starting the server, and
  `-c=<path>` applies the project's file and starts the server. A missing `--config` file makes Bun exit with
  code 1. `--no-env-file` alone does not stop a `bunfig.toml` preload.
- **`.env`, `.env.<mode>`, `.env.local`, `.env.<mode>.local`** would be loaded into the server's environment.
  `--no-env-file` skips them. Without the flag the server removes what Bun loaded again at startup, but only
  the harmless settings listed in [configuration.md](configuration.md#project-env-files) may come from a
  project file.

When the server sees that Bun applied a project `bunfig.toml`, it prints
`[browser-mcp] warning: Bun applied <cwd>/bunfig.toml to this process ...` on stderr.

## Extension

**Edge Add-ons:** install [Browser MCP](https://microsoftedge.microsoft.com/addons/detail/hdhibkihdkndmfecegdnbpebolhokkbh).
Its id `hdhibkihdkndmfecegdnbpebolhokkbh` is trusted by the server out of the box.

**Unpacked** (Chrome, Brave, Opera, or development):

1. Open `chrome://extensions` (`edge://extensions`, `brave://extensions`, `opera://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select the `extension/` folder of the checkout.
4. Click the **Browser MCP** toolbar icon. Once an MCP client has started the server, the badge shows
   **Connected**.

An unpacked extension gets an id derived from its folder path. Loading it from another folder, or on another
machine, gives a new id that the server has to trust and pair again: see
[pairing.md](pairing.md#adding-another-browser-or-install).

The extension connects to port 8765 by default. To use another port, set it in the popup footer and start the
server with the same `--port` ([configuration](configuration.md#bridge-port)).

## Check the installation

```sh
<launch command> --version   # prints the server version (the same as the extension's)
<launch command> --help      # lists the command-line options
```

where `<launch command>` is the binary, `bunx @taiizor/browser-mcp@0.4.0`, or the `bun --config=... run ...`
command above. Both exit at once without touching the bridge port. Inside the agent, `browser_status` reports
the connection, mode (primary or satellite), pairing state and both versions.

## Updating

Update the server and the extension together; a server and an extension that speak different bridge
protocols refuse each other (popup: **Update needed**).

- **Binary:** rebuild (`git pull && bun install && bun run build:binary`) or download the new file, then
  restart the MCP clients.
- **bunx:** change the pinned version in the client config, then restart the client.
- **Source:** `git pull && bun install` in `mcp-server/`, then restart the MCP clients.
- **Extension:** the store updates itself; for an unpacked build click the reload icon on the extensions page.

Restart every running `browser-mcp` process after an update (all MCP clients that use it): later processes
join the first one as satellites, so an old primary would keep serving them, and a satellite of a newer release
cannot join a primary of an older one at all (it logs `... refused authentication (stale token, or a primary of
an older browser-mcp release that needs a restart)`).
