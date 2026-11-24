# Troubleshooting

Start with `browser_status` (connection, mode, pairing state, versions, last refusal) and the server's stderr,
which most clients show as the MCP server log. The popup badge tells the extension's side
([pairing.md](pairing.md#popup-states)).

- [The client cannot start the server](#the-client-cannot-start-the-server)
- [The popup says No server](#the-popup-says-no-server)
- [The popup says Pairing needed, Unknown server, Update needed or Rejected](#the-popup-says-pairing-needed-unknown-server-update-needed-or-rejected)
- [Port problems](#port-problems)
- [A tool is missing or "Tool ... is not enabled"](#a-tool-is-missing-or-tool--is-not-enabled)
- ["Permission disabled in extension"](#permission-disabled-in-extension)
- [Output ends with "[output truncated ...]"](#output-ends-with-output-truncated-)
- [Long calls are cut off by the client](#long-calls-are-cut-off-by-the-client)
- [dom_upload refuses a file](#dom_upload-refuses-a-file)
- [Messages about .env or bunfig.toml on stderr](#messages-about-env-or-bunfigtoml-on-stderr)
- [A script gets 4001](#a-script-gets-4001)
- [Satellite warnings on stderr](#satellite-warnings-on-stderr)
- [Other symptoms](#other-symptoms)

## The client cannot start the server

- **Run the launch command yourself** with `--version`; it must print the version of the release you installed
  (the `version` in `mcp-server/package.json`):
  `bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts --version`.
- **Nothing printed, exit code 0:** the config flag was written as `--config <path>` or `-c <path>` (with a
  space, for example as two separate `args` entries). Bun then takes the `bunfig.toml` path as the script to
  run and never starts the server, but it has already applied the working directory's `bunfig.toml`: a project
  preload has run once on every start. Write `--config=<path>` as one argument before using the client in that
  project again.
- **Exit code 1 with ENOENT:** the `--config=` file does not exist; check `<repo>`.
- **`bun` not found** (GUI clients such as Claude Desktop, Cursor, Windsurf often do not inherit your shell
  `PATH`): put the full path of `bun` in `command` (`where bun` / `which bun`), or use the
  [standalone binary](installation.md#option-a-standalone-binary).
- **Module not found:** run `bun install` in `mcp-server/`.
- **Relative paths:** the client's working directory is usually your project, so `<repo>` must be absolute.
- **Exit code 2:** an invalid `--port`, `BROWSER_MCP_PORT`, `--extension-id` or `--toolsets` value, or
  `--browser` / `-b` without a browser name; stderr names it.

## The popup says No server

Nothing accepts connections on the popup's port.

- The server runs only while an MCP client runs it: start the client (or a session in it) first.
- Server and popup must use the same port (**Bridge port** in the popup's **⋯** menu vs. `--port` /
  `BROWSER_MCP_PORT`; the generic `PORT` is ignored on purpose). See
  [configuration.md](configuration.md#bridge-port).
- The server's stderr shows `primary bridge on :<port>` or `joining as satellite client` once the bridge is up.

## The popup says Pairing needed, Unknown server, Update needed or Rejected

The server or the extension refused the handshake. The popup notice names the problem in one sentence, and its
**Details** link opens the matching section of [pairing.md](pairing.md#popup-states), where every state and close
code is explained. The most common cases:

| Popup notice | Usual cause | Fix |
|---|---|---|
| **Extension not recognized** (4003) | Unpacked build from a new folder: new id | Click **Copy ID**, then trust the id and pair once: [adding another install](pairing.md#adding-another-browser-or-install) |
| **Pairing is closed** (4004) | Second browser / profile / reinstall | Start the server once with `--pair` ([details](pairing.md#pairing-is-closed)) |
| **Pairing needed** (4100) | You reset the server's config directory | Click **Re-pair** if you did that yourself ([details](pairing.md#pairing-needed)) |
| **Pairing needed** (4005) / **Unknown server** (4101) | Keys differ between the two sides, or (4101) a program that is not your server holds the port | **Forget pairing** + `--pair`, or delete `extension-keys.json` and Re-pair; first check what listens on the port ([details](pairing.md#unknown-server)) |
| **Versions do not match** (4002 / 4102) | Server and extension from different releases | Update the side the popup names ([details](pairing.md#versions-do-not-match)) |

## Port problems

- **`EACCES`** or "binding the port failed although nothing accepts connections": on Windows the port may lie in
  an excluded range (`netsh interface ipv4 show excludedportrange protocol=tcp`). Choose another port with
  `--port` and set the same one in the popup's **⋯** menu (**Bridge port**).
- **The port belongs to something else** (another program answering on 8765): the server cannot become primary
  or join it. Pick another port on both sides.
- **Several clients:** only the first process owns the port; the others are satellites. That is expected
  (`browser_status` → `mode`, `pid`, `peers`).

## A tool is missing or "Tool ... is not enabled"

Only the `core` toolset is listed by default, and tools switched off in the popup are hidden. Calling a hidden
tool anyway returns an error that names the cause:

- `Tool <name> is not enabled: it belongs to the "<id>" toolset, which is off. Call browser_toolsets
  {"enable":["<id>"]} ...`: ask the agent to make that call, or start the server with `--toolsets`.
- `Permission disabled in extension: <action> (enable it from the extension popup). Tool <name> is hidden from
  the tool list while this switch is off; ...`: a popup switch is off (`browser_toolsets` lists such tools under
  `hiddenByPermissions`). Only you can switch it back on, in the popup.

A client that ignores `notifications/tools/list_changed` shows runtime changes only after it reconnects. See
[toolsets.md](toolsets.md).

## "Permission disabled in extension"

The user (or the agent through `permissions_set`) switched that action off in the popup. Only the user can
switch it back on, in the popup. Composite tools also need the switches they read through, e.g. `har_export`
needs `network_requests`, and `perf_trace_start` with screenshots needs `page_screenshot`
([extension.md](extension.md#permission-rules)).

## Output ends with "[output truncated ...]"

The text result was longer than `BROWSER_MCP_MAX_OUTPUT_CHARS` (default 40000). The full text is in the file
the note names, in a `browser-mcp-spill-*` folder that is deleted when the server exits. Cookie, storage,
session and clipboard text is never saved: the note says "the rest is not saved to disk" and how to get the
data on purpose (for example `cookies_export` or `session_state_save` with `savePath`). Page through
`page_snapshot` / `page_text` / `page_html` with `offset` / `nextOffset`, narrow the query (`limit`,
filters), or raise the cap ([toolsets.md](toolsets.md#output-cap)).

`session_state_save` or `cookies_export` failing with "the bundle (or export) has N chars, more than the M-char
output cap" is the same limit: call it again with `savePath` (an absolute `.json` path) and read the file back with
`session_state_load` / `cookies_import` and `filePath`.

## Long calls are cut off by the client

Many SDK-based clients time out a request after 60 s. `perf_trace_stop` can take up to 120 s,
`perf_web_vitals` with `reload` up to about 90 s, and `page_wait` as long as its `timeoutMs`. Raise the client's
tool timeout, or use shorter waits. `tab_audio_capture` sends progress notifications every 5 s, which keeps
clients that reset their timeout on progress happy.

## dom_upload refuses a file

The error names the rule in brackets, e.g. `[outside-roots]`, `[hidden-segment]`, `[secret-name]`,
`[spill-file]`, `[not-absolute]`, `[too-large]`. Copy the file into an allowed folder (the OS temp folder,
`~/Downloads` or the server's working directory by default) or set `BROWSER_MCP_UPLOAD_DIRS` in the client
config. Dot-folders, key files and the server's spilled output (`browser-mcp-spill-*`) are refused in every
folder. `cdp_send` applies the same rules to `DOM.setFileInputFiles` and `Input.dispatchDragEvent`; its
refusals start with `cdp_send <method> refused`. See [configuration.md](configuration.md#upload-folders-dom_upload).

## Messages about .env or bunfig.toml on stderr

- `[browser-mcp] ignored N variable(s) Bun loaded from .env in <project> (...)`: informational. The server
  removed the project's values; add `--no-env-file` to the launch command to skip loading them at all.
- `[browser-mcp] ignored BROWSER_MCP_... from .env in <project>: a project's env files may only set ...`: that
  setting must go into the client config or the shell
  ([configuration.md](configuration.md#project-env-files)).
- `[browser-mcp] warning: Bun applied <project>/bunfig.toml to this process`: the server was started without
  `--config=<repo>/mcp-server/bunfig.toml`, so the project's `bunfig.toml` ran inside it. Fix the launch
  command ([installation.md](installation.md#why-the-long-bun-command)). The bunx launcher prints a similar
  warning about itself; use the binary or `bunx --cwd=<trusted folder>` for untrusted projects.
- `[browser-mcp] ignoring PORT=<n> (it belongs to the project or shell the client runs in) ...`: the generic
  `PORT` is never used; set `BROWSER_MCP_PORT` or `--port`.

## A script gets 4001

The token proof failed, a frame came out of step, or authentication did not finish within 5 s. The token
changes every time a primary starts: read `<config dir>/bridge-<port>.token` right before connecting, connect
without an `Origin` header, and run the v2 flow (`auth` with a nonce, check the `auth_challenge` proof, send
`auth_proof`). The legacy `{"type":"auth","token":...}` first frame still works but hands the token to
whatever listens on the port. See [bridge-protocol.md](bridge-protocol.md#scripts-and-other-clients).

## Satellite warnings on stderr

- `WARNING: satellite not linked: <why>; it was sent no token and no command (...). Retrying with backoff.`: the
  process on the port did not prove the bridge token. Either another program holds the port, or the token file
  is stale or missing (`no bridge token at <file>`): every `browser-mcp` process on one port needs the same
  config directory (`BROWSER_MCP_HOME`). The satellite keeps retrying with a growing delay (up to 30 s more).
- `Primary bridge on :<port> refused authentication (stale token, or a primary of an older browser-mcp release
  that needs a restart)`: a primary started by an older release still owns the port. Restart every
  `browser-mcp` process (close and reopen the MCP clients).

## Other symptoms

- **Chrome shows "is debugging this browser":** a debugger-backed session is active (mocking, throttling, extra
  headers, geolocation, emulation, a trace). `emulation_reset`, `network_throttle` with profile `online`,
  `network_set_headers` with `{}` or `network_mock_stop` end them; switching the action off or closing the
  tab does too ([extension.md](extension.md#debugger-sessions)).
- **Commands fail on `chrome://`, `edge://`, the Web Store or `file://` pages:** browsers do not let extensions
  script these pages (`file://` needs "Allow access to file URLs" on the extensions page).
- **A browser window opens by itself:** auto-launch. Set `BROWSER_AUTO_LAUNCH=0`, or pin the browser with
  `BROWSER` ([configuration.md](configuration.md#browser-selection-and-auto-launch)).
- **Commands fail fast after a failed launch:** a 60 s cooldown; call `browser_launch` to retry at once.
- **The server process stays around after the client closed:** it exits on stdin EOF, a dead parent or
  unanswered pings unless a `BROWSER_MCP_NO_*` switch disables that ([watchdogs](configuration.md#process-watchdogs)).
- **Dialogs are not auto-answered in my own tab:** by design, only tabs the agent created or targeted with an
  explicit `tabId` get the dialog hook ([extension.md](extension.md#agent-tabs-dialogs-and-console-capture)).
- **`dom_type` warns that `delayMs` pauses were skipped:** the tab was hidden (a background tab, or a minimized or
  covered window), where the browser throttles timers. The whole text was typed without pauses; make the tab
  visible to type with pauses. Newlines are typed as Shift+Enter; use `pressEnter` (or `keyboard_press`) to
  press Enter itself ([tools.md](tools.md#tool-notes)).
