# Configuration

- [Command-line flags](#command-line-flags)
- [Environment variables](#environment-variables)
- [Where settings may come from](#where-settings-may-come-from)
- [Bridge port](#bridge-port)
- [Project .env files](#project-env-files)
- [Browser selection and auto-launch](#browser-selection-and-auto-launch)
- [Config directory](#config-directory)
- [Upload folders (dom_upload)](#upload-folders-dom_upload)
- [Process watchdogs](#process-watchdogs)

Toolsets and the output cap have their own page: [toolsets.md](toolsets.md).

## Command-line flags

Flags go after the launch command (for the source install: after `.../src/index.ts`). `--help` prints the same
list.

| Flag | Purpose |
|---|---|
| `--port <n>`, `-p <n>`, `--port=<n>`, `-p=<n>`, bare `<n>` | Bridge port (an integer 1-65535; an invalid value exits with code 2) |
| `--browser <name>`, `-b <name>`, `--browser=<name>`, `-b=<name>` | Browser for auto-launch: `chrome`, `edge`, `brave`, `opera` (or a path); overrides `BROWSER`. An empty value or one starting with `-` exits with code 2 (`Missing browser name for <flag> ...`) |
| `--extension-id <id>`, `--extension-id=<id>` | Trust an extension id (repeatable, comma separated, `*` = any id); an invalid id exits with code 2 |
| `--pair` | Open the pairing window for one new extension install, for 10 minutes after start ([pairing.md](pairing.md#adding-another-browser-or-install)) |
| `--allow-legacy-extension` | Accept protocol-2 (older 0.3.x) extensions over an **unauthenticated** link; logs a warning ([pairing.md](pairing.md#version-mismatch)) |
| `--toolsets <list>`, `--toolsets=<list>` | Toolsets listed from the start: `core` (default), `all`, or category ids, comma separated; repeatable, lists are merged ([toolsets.md](toolsets.md)). An empty value or one starting with `-` exits with code 2 |
| `-h`, `--help` | Print usage and exit |
| `-v`, `--version` | Print the version and exit |

Unknown arguments only print a warning (`[browser-mcp] ignoring unknown argument: ...`). For `--pair` and
`--allow-legacy-extension`, a flag on the command line wins; without it the environment variable applies.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_MCP_PORT` | `8765` | Bridge port ([precedence](#bridge-port)); the generic `PORT` is never used |
| `BROWSER_MCP_TOOLSETS` | `core` | Start-up toolsets, like `--toolsets` (the flag wins) |
| `BROWSER_MCP_MAX_OUTPUT_CHARS` | `40000` | Text characters one tool result may return inline (minimum 1000); longer text is cut and saved to a private temp folder that is removed when the server exits (cookie, storage, session and clipboard text is cut but never saved); see [toolsets.md](toolsets.md#output-cap) |
| `BROWSER_MCP_EXTENSION_IDS` | none | Comma-separated trusted extension ids (strict: no trust-on-first-use of ids); `*` = accept any id (legacy, logs a warning) |
| `BROWSER_MCP_HOME` | `~/.browser-mcp` | [Config directory](#config-directory) |
| `BROWSER_MCP_PAIR` | off | `1`, `true` or `yes`: same as `--pair` |
| `BROWSER_MCP_ALLOW_LEGACY_EXTENSION` | off | `1`, `true` or `yes`: same as `--allow-legacy-extension` |
| `BROWSER_MCP_UPLOAD_DIRS` | temp, `~/Downloads`, working directory | Folders `dom_upload` may read from ([details](#upload-folders-dom_upload)) |
| `BROWSER` | none | Browser for auto-launch: `chrome`, `edge`, `brave`, `opera` (or a path / exe name) |
| `BROWSER_PATH`, `CHROME_PATH` | none | Full path of the Chromium binary to launch (`CHROME_PATH` is the legacy name) |
| `BROWSER_AUTO_LAUNCH` | `1` | `0` never starts a browser by itself |
| `BROWSER_LAUNCH_TIMEOUT_MS` | `45000` | How long a launch waits for the extension to connect |
| `FFMPEG_PATH` | none | ffmpeg executable for audio conversion (else `PATH`, then common install folders) |
| `BROWSER_MCP_NO_STDIO_EXIT` | unset | `1`: do not exit when stdin closes ([watchdogs](#process-watchdogs)) |
| `BROWSER_MCP_NO_PARENT_CHECK` | unset | `1`: do not exit when the parent process is gone |
| `BROWSER_MCP_PARENT_CHECK_MS` | `10000` | Parent check interval |
| `BROWSER_MCP_NO_CLIENT_PING` | unset | `1`: do not ping the MCP client |
| `BROWSER_MCP_CLIENT_PING_MS` | `30000` | Client ping interval |
| `BROWSER_MCP_CLIENT_PING_TIMEOUT_MS` | `10000` | Timeout of one client ping |
| `BROWSER_MCP_CLIENT_PING_FAILS` | `3` | Consecutive ping timeouts before the server exits |

## Where settings may come from

Set variables in the MCP client's server entry (`env`, or `environment` in OpenCode) or in the shell that
starts the client. A project's `.env` files are not a valid source for most of them, see the next sections.

## Bridge port

Server and extension must use the same port. Server precedence: `--port` → `BROWSER_MCP_PORT` → `8765`.

- The generic `PORT` variable is **never** used. It belongs to the project or shell the client runs in, and
  binding it would take that project's dev-server port and miss the extension. When it is set, the server
  prints a notice on stderr.
- An invalid value (not an integer 1-65535) is fatal: the server exits with code 2 instead of silently using
  another port.
- If the port cannot be bound for a reason other than "already in use" (for example `EACCES` on a Windows
  excluded port range), the server exits with the real cause and a hint
  (`netsh interface ipv4 show excludedportrange protocol=tcp`).
- "Already in use" means another `browser-mcp` process owns the port: this process joins it as a satellite
  ([bridge-protocol.md](bridge-protocol.md)).
- **Extension side:** type the port in the popup footer and click **Set** (or press Enter); **↺** resets it to
  `8765`. The extension reconnects at once, without a reload.

## Project .env files

MCP clients start the server with the working directory set to the project the agent works on, and Bun loads
that project's `.env`, `.env.<mode>`, `.env.local` (not in test mode) and `.env.<mode>.local` into the process
before any code runs (unless started with `--no-env-file`, as the documented launch commands do). The mode is
the `NODE_ENV` of the real environment, or `development` without one. Their values (`PORT`,
`BROWSER`, `CHROME_PATH`, API keys ...) have nothing to do with Browser MCP, so the server removes them again
at startup, before it reads its settings or launches a browser:

- Only exact copies of the file values are removed: a value set by the client config or the shell (it wins
  over the file in Bun) stays. OS essentials such as `PATH`, `HOME` or `USERPROFILE` are never removed.
- Bun chooses the mode before it reads the files, so a `NODE_ENV=production` (or `test`) inside the project's
  `.env` does not stop it from loading `.env.development` and `.env.local`. The server therefore also checks
  the development files whenever they set the current `NODE_ENV`, each mode with its own values. `NODE_ENV`
  itself is kept, and the `ignored ... from <files>` line may then name files of both modes.
- Temp-folder variables (`TEMP`, `TMP`, `TMPDIR`) from the files are removed too, so the folder for saved
  output and the default upload root are never chosen by a project. On Windows a value naming the standard
  `%LOCALAPPDATA%\Temp` is kept.
- Of the server's own variables, a project file may set **only** these harmless ones:
  `BROWSER_MCP_PORT`, `BROWSER_MCP_TOOLSETS`, `BROWSER_MCP_MAX_OUTPUT_CHARS`, `BROWSER_MCP_NO_STDIO_EXIT`,
  `BROWSER_MCP_NO_PARENT_CHECK`, `BROWSER_MCP_PARENT_CHECK_MS`, `BROWSER_MCP_NO_CLIENT_PING`,
  `BROWSER_MCP_CLIENT_PING_MS`, `BROWSER_MCP_CLIENT_PING_TIMEOUT_MS`, `BROWSER_MCP_CLIENT_PING_FAILS`.
  Every other `BROWSER_MCP_*` key (`EXTENSION_IDS`, `HOME`, `PAIR`, `ALLOW_LEGACY_EXTENSION`, `UPLOAD_DIRS`,
  and any key added later) decides whom the server trusts or which files it may read, so it is removed and
  has to come from the client config or the shell.

The server reports what it removed on stderr, names only, never values:

```text
[browser-mcp] ignored 3 variable(s) Bun loaded from .env in /path/to/project (PORT, BROWSER, API_KEY); start the server with "bun --no-env-file run …" to skip loading them
[browser-mcp] ignored BROWSER_MCP_EXTENSION_IDS from .env in /path/to/project: a project's env files may only set BROWSER_MCP_PORT, ...; set the others in the MCP client config or the shell
```

Bun >= 1.3.3 is required for `--no-env-file` to take effect (1.3.2 accepts the flag and still loads the
files). The project's `bunfig.toml` is a separate risk that `--no-env-file` does not cover; see
[installation.md](installation.md#why-the-long-bun-command).

## Browser selection and auto-launch

When a command needs the extension and it is not connected, the server opens a browser in this order:

1. `BROWSER` (`chrome`, `edge`, `brave`, `opera`; CLI `--browser edge`) or `BROWSER_PATH` (full path to any
   Chromium binary; the legacy `CHROME_PATH` also works)
2. The browser that last hosted the extension (remembered per port in the [config directory](#config-directory))
3. A browser that is already running (it is woken instead of opening another one)
4. The OS default browser (Windows registry / `xdg-settings`)
5. Chrome → Edge → Brave → Opera at their well-known install paths (the first one found)

If the extension lives in another browser than the default one, the launcher tries each candidate within the
timeout and remembers the winner; or pin it with `"env": { "BROWSER": "edge" }`.

- `BROWSER_AUTO_LAUNCH=0` disables auto-launch.
- **Reconnect grace:** for 12 s after the bridge starts (or after the extension drops), a command first waits
  for the extension to reconnect when a Chromium browser is already running, instead of opening a new window.
- **Cooldown:** after a failed auto-launch, commands fail fast for 60 s with a clear error; call
  `browser_launch` to retry at once. `browser_launch` waits up to `timeoutMs` (default
  `BROWSER_LAUNCH_TIMEOUT_MS`, 45000).
- Platform notes: on macOS browsers resolve via `/Applications/...app` bundles and `pgrep` process names;
  OS-default detection uses the Windows registry or Linux `xdg-settings` (macOS has no stock equivalent, so
  the sticky / running / PATH heuristics apply there).

## Config directory

`BROWSER_MCP_HOME`, else `~/.browser-mcp` (`%USERPROFILE%\.browser-mcp` on Windows). Created with mode `0700`;
files are written atomically with mode `0600` (on Windows the user-profile ACLs apply). `browser_status`
shows the directory in use (`configDir`).

| File | Content |
|---|---|
| `bridge-<port>.token` | 64 hex chars, regenerated every time a primary bridge starts listening; satellites and scripts prove that they hold it ([scripts](bridge-protocol.md#scripts-and-other-clients)) |
| `trusted-extensions.json` | `{ "ids": ["<extension id>", ...] }`: every extension id that completed a handshake ([trust](pairing.md#extension-ids)) |
| `extension-keys.json` | `{ "version": 1, "installs": [{ "extensionId", "installId", "key", "pairedAt", "browser" }] }`: the pairing key of every paired install ([pairing](pairing.md)). Never logged or returned by any tool |
| `sticky-browser-<port>` | Browser family that last hosted the extension on this port |
| `perms-<port>.json` | Last known list of actions switched off in the popup (used while the extension is silent) |

Deleting `trusted-extensions.json` reopens trust-on-first-use of extension ids once the server restarts;
deleting `extension-keys.json` reopens pairing at once (the file is read on every handshake), and every
install then has to pair again. A corrupt `trusted-extensions.json` keeps trust-on-first-use closed and is
never overwritten; a corrupt `extension-keys.json` keeps pairing closed, and a `--pair` run moves it aside
to `extension-keys.json.corrupt-<time>` before it saves the new key.

## Upload folders (dom_upload)

`dom_upload` hands local files to a page's `<input type=file>`. A prompt-injected page must not be able to
turn that into a way to send your secrets, so the server checks every path before anything reaches the browser:

- The path must be absolute (a drive-letter path on Windows), an existing regular file of at most 100 MiB;
  at most 100 files per call. Symbolic links, junctions and 8.3 names are resolved before the checks.
- It must lie inside an allowed folder. **Default:** the OS temp folder, `~/Downloads` and the server's
  working directory, except a default folder that is a filesystem root or contains the home folder (GUI
  clients often start servers in `/` or `~`). **`BROWSER_MCP_UPLOAD_DIRS`** replaces the defaults: folders
  separated by `;` on Windows and `:` elsewhere, `~` expands to the home folder, `*` allows any folder;
  relative or missing entries are skipped.
- Always refused, whatever the folders say (also with `*`): any path segment starting with `.` (`.ssh`,
  `.env`, `.aws` ...), key or credential file names (`id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `*.kdb`, `*.kdbx`, `*.jks`, `*.keystore`, `credentials*`), and
  any `browser-mcp-spill-*` folder, where the server keeps output it cut from tool results (`[spill-file]`).
- On Windows, network (UNC) and device paths are refused unless an explicit `BROWSER_MCP_UPLOAD_DIRS` entry
  holds them, and alternate data streams (`file.txt:stream`) are refused.

A refusal names the rule, e.g. `dom_upload refused "C:/Users/me/.ssh/id_rsa" [hidden-segment]: ...`; the
"outside the allowed folders" error lists the folders in effect. `BROWSER_MCP_UPLOAD_DIRS` cannot come from a
project `.env` file.

The same rules apply to the file lists `cdp_send` passes to `DOM.setFileInputFiles` (`params.files`) and
`Input.dispatchDragEvent` (`params.data.files`), also when nested in `Target.sendMessageToTarget`; the method name is matched without regard to case, the
resolved paths are sent, and refusals read `cdp_send <method> refused "<path>" [<rule>]: ...`. Other CDP methods
and `js_evaluate` are not limited by these rules: turn **Power** off when they must not run.

## Process watchdogs

stdio MCP servers can be orphaned when a client exits uncleanly, and an orphan would keep the bridge port.
The server therefore exits when:

- stdin closes (the client closed the pipe); opt out with `BROWSER_MCP_NO_STDIO_EXIT=1`;
- the parent process is gone (checked every `BROWSER_MCP_PARENT_CHECK_MS`, 10 s); opt out with
  `BROWSER_MCP_NO_PARENT_CHECK=1`;
- the MCP client stops answering pings (every `BROWSER_MCP_CLIENT_PING_MS`, 30 s, with a
  `BROWSER_MCP_CLIENT_PING_TIMEOUT_MS` of 10 s, after `BROWSER_MCP_CLIENT_PING_FAILS`, 3, timeouts in a row);
  opt out with `BROWSER_MCP_NO_CLIENT_PING=1`.

The bunx launcher applies the same parent check, so the server stops when the client that started bunx dies.
