# Client configuration

The server speaks MCP over `stdio`, so every MCP client that can start a local command works. The examples
below use the **source install** launch command; for the other install options replace `command` and
`args` as shown in the first table. Install options: [installation.md](installation.md).

| Install | `command` | `args` |
|---|---|---|
| Source (clone) | `bun` | `["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]` |
| Standalone binary | `<path>/browser-mcp-windows-x64.exe` (or `dist/browser-mcp`, `browser-mcp-linux-x64` ...) | `[]` |
| bunx (after the first npm release) | `bunx` | `["@taiizor/browser-mcp@0.3.5"]` |

- `<repo>` is the **absolute** path of your clone. On Windows write forward slashes
  (`C:/src/browser-mcp`) or escaped backslashes in JSON.
- Keep `--config=<path>` as one argument with `=`. With a space (`--config <path>`, or `"--config", "<path>"` as two
  entries) Bun still runs the project's `bunfig.toml` preload and then exits without starting the server.
- **PATH:** GUI-launched clients (Claude Desktop, Cursor, Windsurf ...) may not inherit your shell `PATH`. If
  the server fails to start, put the full path of `bun` (`where bun` on Windows, `which bun` on
  macOS/Linux) or of `bunx` in `command`, or use the standalone binary.
- Options go after the launch command (`--port 9000`, `--toolsets core,network`, see
  [configuration.md](configuration.md#command-line-flags)) or into the client's `env` block
  (`BROWSER_MCP_PORT`, `BROWSER_MCP_TOOLSETS` ...). Settings that decide trust (`BROWSER_MCP_EXTENSION_IDS`,
  `BROWSER_MCP_HOME`, `BROWSER_MCP_PAIR` ...) must be set here or in the shell, never in a project `.env`.

| Client | Config file |
|---|---|
| [OpenCode](#opencode) | `opencode.json` / `opencode.jsonc`, or `opencode mcp add` |
| [Claude Code](#claude-code) | `.mcp.json` (project) or the `claude mcp add` CLI |
| [Claude Desktop](#claude-desktop) | `claude_desktop_config.json` |
| [Cursor](#cursor) | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| [Windsurf](#windsurf) | `~/.config/devin/mcp_config.json` |
| [VS Code (Copilot)](#vs-code-copilot) | `.mcp.json` at the workspace root (portable format) |
| [Gemini CLI](#gemini-cli) | `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project), or `gemini mcp add` |
| [Antigravity](#antigravity) | `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace) |
| [Any other client](#any-other-stdio-client) | command + args from the table above |

## OpenCode

OpenCode v2 (`opencode.json` / `opencode.jsonc`), via the CLI:

```sh
opencode mcp add browser -- bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts
```

or by hand:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "browser": {
        "type": "local",
        "command": ["bun", "--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"],
        "environment": {
          "BROWSER_MCP_PORT": "8765"
        }
      }
    }
  }
}
```

`environment` is optional; omit it to use the default port `8765`. OpenCode takes the whole command line as one
array, so with the binary use `"command": ["<path>/browser-mcp-windows-x64.exe"]` and with bunx
`"command": ["bunx", "@taiizor/browser-mcp@0.3.5"]`. Verify with `opencode mcp list` (it should show
`browser connected`). OpenCode v1 nests servers directly under `mcp`, without the `servers` key.

## Claude Code

Via the CLI:

```sh
claude mcp add browser -- bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts
```

Everything after `--` is the server command. Add `--scope project` (before `browser`) to write to `.mcp.json`
instead of the default local scope, or `--scope user` for every project. Binary:
`claude mcp add browser -- <path>/browser-mcp-windows-x64.exe`; bunx:
`claude mcp add browser -- bunx @taiizor/browser-mcp@0.3.5`.

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "browser": {
      "type": "stdio",
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

## Claude Desktop

File: `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on
macOS, `~/.config/Claude/` on Linux). Restart the app after editing.

```json
{
  "mcpServers": {
    "browser": {
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

Claude Desktop is a GUI app: if `bun` is not found, use its full path or the binary.

## Cursor

File: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Restart Cursor and enable the server under
*Settings → Tools & MCP*. Cursor's schema documents an optional `"type": "stdio"` field; the shape below works
as it is.

```json
{
  "mcpServers": {
    "browser": {
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

## Windsurf

File: `~/.config/devin/mcp_config.json` on macOS/Linux, `%APPDATA%\devin\mcp_config.json` on Windows, editable via
*Cascade panel → ⋯ → Open MCP config file* (global only, no project-scope file). Older installs may still use
the legacy `~/.codeium/windsurf/mcp_config.json` path.

```json
{
  "mcpServers": {
    "browser": {
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

## VS Code (Copilot)

Portable `.mcp.json` at the workspace root (recommended):

```json
{
  "mcpServers": {
    "browser": {
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

The legacy VS Code format (`.vscode/mcp.json`) uses a `servers` key with an explicit type:

```json
{
  "servers": {
    "browser": {
      "type": "stdio",
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

## Gemini CLI

File: `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project), with the same `mcpServers` shape:

```json
{
  "mcpServers": {
    "browser": {
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

Or via the CLI. Gemini's own options go before the name, and `--` keeps the server's `--config=...` and
`--no-env-file` from being read as Gemini options:

```sh
gemini mcp add -s user browser bun -- --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts
```

Check the result in `settings.json`: `args` must be exactly the four strings shown above.

## Antigravity

File: `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace), also editable via
*Agent panel → ⋯ → MCP Servers → Manage MCP Servers → View raw config*. The same file is picked up by the
Antigravity CLI (`agy`).

```json
{
  "mcpServers": {
    "browser": {
      "command": "bun",
      "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts"]
    }
  }
}
```

## Any other stdio client

Command and args from the table at the top, optionally with an environment block, for example:

```json
{
  "command": "bun",
  "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts", "--toolsets", "core,network"],
  "env": { "BROWSER_MCP_PORT": "8765" }
}
```

## Several clients at once

Every MCP client session starts its own server process. The first one owns the bridge port (primary), later
ones join it as satellites and share the same browser and extension connection. They must run as the same OS
user with the same `BROWSER_MCP_HOME`. See [bridge-protocol.md](bridge-protocol.md).

## Long-running tools and client timeouts

Some tools can legitimately run longer than the 60 s default request timeout of many SDK-based clients:
`perf_trace_stop` (up to 120 s), `perf_web_vitals` with `reload` and a long `waitMs` (up to about 90 s),
`page_wait` with a long `timeoutMs`, and `tab_audio_capture` (which sends progress notifications every 5 s
when the client asks for them). If your client cuts such calls off, raise its tool timeout.
