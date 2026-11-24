# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

Only the latest minor release receives security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, report privately via one of these channels:

1. [GitHub Security Advisories](https://github.com/Taiizor/browser-mcp/security/advisories/new)
   (preferred — private by default), or
2. A direct message to the maintainer.

Include:

- A description of the vulnerability and affected component (`extension/` or `mcp-server/`)
- Steps to reproduce or a proof of concept
- The potential impact

You can expect an initial response within 7 days. Once a fix is available, we
will publish a GitHub Security Advisory and credit the reporter (unless
anonymity is requested).

## Threat Model

Browser MCP intentionally holds powerful browser permissions
(`debugger`, `<all_urls>`, cookies, clipboard, browsing data). Whoever can drive
the bridge can act as you in your browser, so the design limits who may talk to it:

1. Only a paired Browser MCP extension install may act as the extension, and the
   extension only obeys a server that proves it holds the same pairing key.
2. Only local programs that hold the per-run bridge token may send commands
   through the bridge.
3. The popup switches bound what the agent can do, and the agent can only narrow them.

It does not defend against software that already runs as your OS user (see
[Known limits](#known-limits)). For the user-facing pairing steps and every popup
state, see [docs/pairing.md](docs/pairing.md).

## Bridge Trust Model (protocol v3)

The protocol is implemented in `mcp-server/src/bridge.ts` (server) and
`extension/background.js` (extension); the header comments of both files list
every frame.

### Connection gate

- **Loopback only.** The bridge listens on `127.0.0.1:<port>` (default `8765`).
- **Web pages are refused.** A WebSocket upgrade whose `Origin` is not
  `chrome-extension://` or `moz-extension://` is rejected with HTTP 403, so a
  page cannot connect (or tell the bridge apart from a closed port).
- **Extension ids are a filter.** An extension socket is identified by the id in
  its `Origin`. Trusted ids: the Edge Add-ons store id
  (`hdhibkihdkndmfecegdnbpebolhokkbh`), `BROWSER_MCP_EXTENSION_IDS`,
  `--extension-id`, and `trusted-extensions.json` in the config directory.
  Every id that completes a handshake is saved in that file. Without an explicit
  list, any id is accepted while the file is missing or empty (trust on first
  use), so the first id that completes a handshake closes it; with an explicit
  list there is no trust on first use. Any other id is closed right after
  connecting with `4003 untrusted-extension:<id>`. Any local process can send
  any `Origin` header, so the id alone proves nothing: the per-install key
  below does.
- **Local clients prove a token.** Sockets without an `Origin` (additional
  browser-mcp server processes, scripts) must first authenticate with the
  per-run bridge token: 32 random bytes, regenerated whenever a primary bridge
  starts and stored in `bridge-<port>.token` in the config directory. The
  client sends `{ type: "auth", v: 2, nonce: Nc }`; the primary answers
  `{ type: "auth_challenge", nonce: Np, proof }` with
  `HMAC("browser-mcp/client|server|<port>|<Nc>|<Np>")`; only after checking
  that proof does the client send `{ type: "auth_proof", proof }` with
  `HMAC("browser-mcp/client|client|<port>|<Np>|<Nc>")`, and the primary
  answers `{ type: "auth_ok", pid }` (HMAC-SHA256 keyed with the hex-decoded
  token; nonces are 32 random bytes as lowercase hex; proofs are compared in
  constant time). The token never crosses the socket. A wrong proof, a
  malformed nonce, any frame out of step, or 5 s without a completed
  authentication closes the socket with `4001 auth-required`. Such sockets can
  never act as the extension. The primary still accepts the legacy first frame
  `{ type: "auth", token: "<token>" }` (scripts, older processes); see below
  for what that costs.

### Mutual authentication

Each extension install has its own 32-byte key K (64 lowercase hex characters).
The extension keeps `{ installId, key }` in its own origin's IndexedDB
(database `browser-mcp`, object store `pairing`, record `current`), which
content scripts and web pages cannot open on any Chrome version. `installId` is
a `crypto.randomUUID()` made once per install and kept when the key is replaced.
Builds before this one kept the record in `chrome.storage.local` under
`mcpPairing`; on its first start the extension copies that record into
IndexedDB (only while IndexedDB holds none) and deletes it from
`chrome.storage.local` once the copy is committed. Later `mcpPairing` values in
`chrome.storage.local` are ignored and removed, so a value planted there is
never trusted. If IndexedDB cannot be opened, the extension does not fall back
to `chrome.storage.local`: it stays unpaired (pairing offers are declined) and
logs `[mcp] pairing store (IndexedDB) unavailable: ...`. The server keeps the
same key in `extension-keys.json` (see [Keys file](#keys-file)).

Every connection runs this handshake (Ne / Ns are fresh 32-byte random nonces,
HMAC is HMAC-SHA256 keyed with the hex-decoded K, `<port>` is the TCP port as a
decimal string: the port the server is bound to, and the port the extension
dialed for this socket):

```text
EXT -> MCP  hello      { protocol: 3, installId, nonce: Ne, hasKey, ... }
MCP -> EXT  challenge  { nonce: Ns, proof: HMAC("browser-mcp/v3|server|<extId>|<installId>|<port>|<Ne>|<Ns>") }
EXT -> MCP  auth       { proof: HMAC("browser-mcp/v3|extension|<extId>|<installId>|<port>|<Ns>|<Ne>") }
MCP -> EXT  welcome    { protocol: 3, pid, serverVersion }
```

The extension checks the server proof before it sends its own. When the server
has no key for the install and its pairing window is open, it sends
`{ type: "pair", nonce: Ns, key: K }` with a fresh key instead of a challenge;
the extension stores K and answers `pair_accept` with the extension proof, and
only then does the server save K. Both proofs bind the extension id, the install
id, the port and both nonces, and carry a side label, so a proof cannot be
replayed on another socket, relayed from a server on another port, or
reflected back. The server compares proofs with
`crypto.timingSafeEqual`, the extension with a constant-time comparison. Keys
are never logged, never returned by `browser_status`, and travel over the socket
only once, in the `pair` frame.

What it protects against:

- **A process that forges the extension's `Origin`.** Without the install's key it
  fails the challenge (`4005 auth-failed`); posing as a new install it is
  refused while the pairing window is closed (`4004 pairing-closed`).
- **A program squatting on the bridge port** (started before the real server, or
  while it is down). It cannot produce the server proof, so the extension closes
  with `4101 server-auth-failed` and runs nothing. Relaying the extension to a
  real browser-mcp server on another port does not help it: that server's proof
  is bound to its own port, which is not the one the extension dialed (`4101`).
  Satellites check the primary's token proof before they send anything, so they
  give such a program neither the token nor a command. A `welcome` without the v3
  handshake is refused with `4102 server-outdated`. A pairing offer to an
  extension that already holds a key is declined with `4100 pair-declined`,
  unless you clicked **Re-pair** in the popup within the last 2 minutes.
- **Replayed handshakes.** Both sides contribute a fresh nonce on every socket.

What it does not protect against:

- **Processes running as your OS user.** They can read the config directory
  (`extension-keys.json` holds the key of every paired install, the token file
  lets them connect as a local client) and the browser profile on disk, where
  the extension's IndexedDB keeps its key. Such a process can impersonate
  either side. Protect your user account.
- **The first pairing (trust on first use).** While `extension-keys.json` has
  no install, the server hands a key to the first install that connects, and an
  extension without a key accepts the first pairing offer from whatever listens
  on its port. A local attacker active at that moment can pair instead of you.
  The real side then shows it: the real extension is refused with
  `4004 pairing-closed`, or, when a fake server paired it, it declines the real
  server's offer (`4100`, **Re-pair** offered). Pair right after installing,
  and treat an unexpected **Pairing is closed** or **Re-pair** prompt as a
  warning.
- **An open `--pair` window.** For up to 10 minutes it admits one new install
  that nobody vouched for, the same way.
- **Legacy mode** (`--allow-legacy-extension`), which accepts 0.3.x extensions
  without any key (see [Legacy and accept-any modes](#legacy-and-accept-any-modes)).
- **Local clients that use the legacy token frame.** A script (or a server
  process of an older release) that sends `{ type: "auth", token }` hands the
  raw token to whatever listens on the port, without checking it. A program
  that takes the port first, or grabs it while the primary restarts, receives
  that client's commands (including text to type and cookie values), can answer
  with forged results, and, holding the token, can pass the satellites' check
  until a primary writes a new token. It still cannot make the extension run
  anything. Any local user can bind a free loopback port; scripts should use
  the v2 flow ([docs/bridge-protocol.md](docs/bridge-protocol.md#scripts-and-other-clients)).
- **The traffic itself.** The loopback link is not encrypted, and only the
  handshake is authenticated, not each later message. Reading or injecting
  loopback traffic needs administrator rights on common systems and is out of scope.

### Pairing window

A new install (one the server holds no key for) gets a key only while the
pairing window is open:

- **First setup:** `extension-keys.json` is missing or lists no install. A
  corrupt file, or one with an unknown `version`, does not count as empty:
  pairing stays closed unless the pair option is given (the unreadable file is
  then moved aside to `extension-keys.json.corrupt-<ms>` when the new key is saved).
- **Pair option:** `--pair`, `BROWSER_MCP_PAIR=1` (`true` and `yes` work too) or
  `ExtensionBridgeOptions.pair`. The window lasts 10 minutes from the start of the
  process and closes after the first pairing in that process, so each run admits
  one install. An explicit option wins over the environment variable.

Further rules:

- An install that the server holds a key for always gets a challenge, never a
  pairing offer. An extension that sends `hasKey: false` (after **Forget
  pairing**) is treated as a new install.
- `pair_accept` is checked against the window again: if another install paired
  in the meantime, the socket is closed with `4004`.
- Only the primary bridge pairs. `--pair` on a satellite (a second server on the
  same port) only takes effect if that satellite takes over as primary; until
  then it logs `--pair has no effect here: the primary bridge on :<port> (another
  browser-mcp process) decides; ...`.
- `BROWSER_MCP_PAIR` set in a project `.env` file is ignored (see
  [Project `.env` files](#project-env-files)).
- On start the server logs either `no extension install paired yet; the first
  install that connects gets a pairing key (<keys file>)` or `pairing open for
  one new extension install for 10 min (--pair)`, and every pairing as
  `paired extension <id> install <installId> (<keys file>)`.

### Keys file

- Location: `<configDir>/extension-keys.json`, where `<configDir>` is
  `BROWSER_MCP_HOME` or `~/.browser-mcp` (Windows: `%USERPROFILE%\.browser-mcp`).
  `browser_status` reports it as `configDir`.
- Format: `{ "version": 1, "installs": [ { "extensionId", "installId", "key",
  "pairedAt", "browser" } ] }`, at most 100 installs (the oldest pairing is dropped).
- Permissions: the config directory is created with mode `0700` and the file is
  written with mode `0600` through a temporary file and a rename (the same
  helper writes the token and `trusted-extensions.json`). On Windows these
  modes do not apply; the ACLs of your user profile protect the folder.
- The file is read again on every handshake and status call. Deleting it
  reopens the first-setup window at once; every install then has to pair again.
  If it cannot be written, the new key is kept in memory for the life of the
  process and the server logs `could not save the pairing of extension <id> in
  <file> (kept for this session only)`.
- Other files in the config directory: `bridge-<port>.token`,
  `trusted-extensions.json`, `perms-<port>.json` (the last permission snapshot)
  and `sticky-browser-<port>`.

### Before the handshake completes

- **Server:** until the handshake is done, an extension socket may only send the
  frame of its current step (`hello`, then `auth` or `pair_accept`); events,
  permission snapshots and replies are ignored. Commands go only to the active
  authenticated extension socket, and a reply is accepted only from the socket
  the command went to. A socket that has not finished within 5 s is closed with
  `4008 handshake-timeout`; the same install connecting again closes its older
  socket with `4006 replaced`.
- **Extension:** every frame with an `id` and an `action` (a command) and every
  `cancel` frame is ignored until `welcome` arrives after the extension verified
  the server proof or completed pairing on that socket. Only one `challenge` or
  `pair` is accepted per socket. Console, network and permission events are
  streamed, MAIN-world page hooks installed and network data captured only while
  the bridge is paired.

### Close codes

| Code | Reason | Sent by | Meaning | Popup state |
| ---- | ------ | ------- | ------- | ----------- |
| `4001` | `auth-required` | server | Origin-less client that did not prove the bridge token (or sent a wrong legacy token) | - |
| `4002` | `protocol-mismatch:server=3,ext=<n>` | server | the extension speaks another protocol (`<n>` is `none` when missing) | Update needed |
| `4003` | `untrusted-extension:<id>` | server | extension id not trusted and trust on first use closed | Rejected |
| `4004` | `pairing-closed` | server | no key for this install and the pairing window is closed | Rejected (Pairing is closed) |
| `4005` | `auth-failed` | server | the extension's proof did not match the stored key | Rejected |
| `4006` | `replaced` | server | the same install completed a newer handshake | - |
| `4008` | `handshake-timeout` | server | handshake not finished within 5 s | Rejected (code shown) |
| `1008` | `bad-hello` | server | malformed v3 `hello` (install id or nonce) | No server |
| `4100` | `pair-declined` | extension | pairing offer while the extension holds a key and no **Re-pair** was clicked | Action needed (Re-pair) |
| `4101` | `server-auth-failed` | extension | wrong or missing server proof (also one bound to another port), malformed frame, second challenge/pair, or `welcome` before the proof | Unverified server |
| `4102` | `server-outdated` | extension | `welcome` without a completed v3 handshake (a 0.3.x server) | Update needed |

After `4001`-`4005` and `4100`-`4102` the extension retries every 30 s;
after other closes it retries with a backoff from 1 s to 10 s. The server
records the last refused extension handshake as `lastExtensionRefusal` in
`browser_status`: its own closes, and an extension close only when it answers
this server's own handshake step (`4101` after a challenge or a pairing offer,
`4100` after a pairing offer). Anything with an extension `Origin` can close
with any code and text, so other closes (`4102`, which only answers a
`welcome` without a handshake that this server never sends, or a code out of
step) are not recorded, and the stored reason is the code's fixed name
(`pair-declined`, `server-auth-failed`), never the peer's text. For 10 minutes
the `Browser extension not connected` error adds what to do about it. For the
remedy of each state, see [docs/pairing.md](docs/pairing.md).

### Legacy and accept-any modes

- `--allow-legacy-extension` / `BROWSER_MCP_ALLOW_LEGACY_EXTENSION=1` accepts a
  protocol-2 `hello` (0.3.x extensions) without any key and answers
  `{ type: "welcome", protocol: 2, pid }`. The link is then **not**
  authenticated: any local process that sends a trusted `Origin` can pose as the
  extension. The id check still applies. The server warns at start
  (`WARNING: protocol-2 extensions are accepted WITHOUT authentication
  (--allow-legacy-extension); update the extension and drop this option`) and
  on such connections. Use it only while migrating. The reverse direction has
  no legacy mode: a current extension never runs commands from a 0.3.x server
  (`4102`).
- `BROWSER_MCP_EXTENSION_IDS=*` turns the extension id check off (the server
  logs a warning on startup and records no ids). Protocol-3 extensions still
  need a key. Do not use it on shared machines.

## Extension Controls

### Permission switches

- **Allow-list gate.** `handleCommand` routes only actions that appear in the
  popup catalog (`PERM_CATS`) or in `INTERNAL_ACTIONS` (`perm_list`, `perm_set`,
  `tab_list`); anything else fails with `Unknown command: <action>`, so a handler
  without a catalog entry can never bypass the switches. Every action except
  `perm_list` / `perm_set` is checked against the switches, and composite
  actions also need the switches they read through (`REQUIRES`, for example
  `har_export` needs `network_requests`). `perf_trace_start` also needs
  `page_screenshot` when it would record page content (paint data can be replayed into
  page content): `screenshots: true`, or an included category pattern that matches
  `disabled-by-default-devtools.screenshot` or a paint-data category
  (`disabled-by-default-devtools.timeline.picture`, `.timeline.layers`, `.timeline.paint`,
  `disabled-by-default-cc.debug.*`, `disabled-by-default-skia*`), whether by name, through a
  wildcard (such as `disabled-by-default-*`; a bare `*` does not count) or as any pattern
  naming screenshots, pictures, display items, layers or skia. This condition depends
  on the arguments, so it is checked when the call runs and is not part of
  `REQUIRES`.
- **New actions after an update.** The catalog the popup last saw is stored as
  `mcpKnownActions`. An action added by an update starts disabled when every
  previously known action of its category is disabled, so a category you turned
  off stays off. An upgrade from 0.3.5, which stored no list, compares against
  the embedded 0.3.5 catalog.
- **The agent can only restrict itself.** Over the bridge, `perm_set` can disable
  permissions but never re-enable them; turning a switch back on is only
  possible in the popup. The background worker answers popup operations
  (`mcp-status`, `mcp-perms-set`, `mcp-repair`, `mcp-forget-pairing`, ...) only
  for the extension's own pages, never for content scripts or web pages. While
  it runs, it reverts any `chrome.storage.local` write that would turn a switch
  back on. `chrome.storage.local` (switches, port) is set to
  `TRUSTED_CONTEXTS`, which Chromium honours only from version 140; on 116-139
  content scripts can still read and write it, so nothing read from it is
  trusted blindly: switches only tighten, a stored port is applied only at
  start-up, and the pairing key lives in IndexedDB instead.
- The MCP server hides tools whose actions are switched off, but the extension
  is the enforcement point.

### Debugger session teardown

Every debugger-backed state the agent can leave on a tab is registered in one
registry in `background.js`: network mocks and spies (`network_mock_start`,
`network_mock_route`), throttling (`network_throttle`), extra headers
(`network_set_headers`), geolocation, viewport, media and CPU emulation
(`emulation_*`) and running performance traces (`perf_trace_start`,
`perf_trace_stop`). The state is cleared and the debugger released:

- when you switch off one of its controlling actions in the popup;
- when the bridge has not been paired for 30 s (the moment it went down is kept
  in `chrome.storage.session`, so a service-worker restart keeps the deadline);
- when the debugger detaches or the tab closes, and through the matching
  stop / clear / reset actions.

After a service-worker restart nothing is re-armed without a paired bridge.
Parked network-mock sessions are restored only once a paired bridge is back and
their switches are still on; other leftovers are detached. Ending a running
trace this way discards its data.

### `permissions_grant`

- `permission` must be one of `geolocation`, `notifications`, `camera`,
  `microphone`, `popups`, `javascript`, `images`, `cookies`.
- `setting` must be `allow`, `block` or `ask` (default `allow`); anything else
  fails with `Invalid setting: ... (use allow, block or ask)`.
- `origin` must be one exact http(s) origin: `new URL(origin).origin === origin`,
  no `*`, no path, no trailing slash, no other scheme. Anything else fails with
  `Invalid origin: ... (give one exact http(s) origin such as
  https://example.com: no wildcards, paths or patterns)`. Without `origin` the
  target tab's http(s) origin is used. The setting is applied to `<origin>/*`
  only, never browser-wide.

### Agent tabs and the active-tab fallback

- Console and dialog hooks go only into the main frame of *agent tabs*: tabs the
  agent created (`tab_create`, `tab_duplicate`, `window_create`) or targeted
  with an explicit `tabId`, and only while the bridge is paired.
- A command without a `tabId` runs in the active tab, which becomes only a
  *fallback tab*: it gets the console hook (when `console_get` is allowed) but
  never the dialog auto-accept hook. Its status ends on a cross-origin
  main-frame navigation the agent did not cause (no navigating command touched
  the tab in the last 10 s and none is running on it), when the tab closes, and
  15 s after the bridge goes down. Targeting it later with an explicit `tabId`
  makes it a full agent tab.
- 15 s after the bridge goes down, agent tabs get native dialogs back and
  console capture stops. See [PRIVACY.md](PRIVACY.md).

## Server Controls

### `dom_upload` path guard

`dom_upload` checks every path in the server (`mcp-server/src/upload-guard.ts`)
before anything reaches the browser, and sends the resolved paths:

- at most 100 files per call, each an absolute path (on Windows with a drive
  letter); UNC and device paths (`\\server\share`, `\\?\`, `\\.\`) are refused
  before any file access unless an explicit `BROWSER_MCP_UPLOAD_DIRS` entry holds
  them; `:` after the drive letter (alternate data streams) is refused;
- no path segment starting with a dot (`.ssh`, `.env`, `.aws`, `..`, ...), no
  key or credential file name (`id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`,
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`, `*.kdb`, `*.kdbx`, `*.jks`,
  `*.keystore`, `credentials*`) and no `browser-mcp-spill-*` segment (this
  server's [spilled output](#files-the-server-writes), refused as `[spill-file]`
  even with `BROWSER_MCP_UPLOAD_DIRS=*`), checked on the given and on the
  resolved (`realpath`) path;
- the resolved path must lie inside an allowed folder and be a regular file of
  at most 100 MiB. File contents are never read.

Allowed folders: `BROWSER_MCP_UPLOAD_DIRS` (separated by `;` on Windows and
`:` elsewhere; `~` expands to the home folder; `*` allows any folder) replaces
the defaults: the temp folder, `~/Downloads` and the server's working
directory. A default folder that is a filesystem root or contains your home
folder (a server started from `/` or `~`) is skipped. Refusals read
`dom_upload refused "<path>" [<rule>]: ...`. `BROWSER_MCP_UPLOAD_DIRS` from a
project `.env` file is ignored.

The guard is part of the server's tool layer. `dom_upload` uses it, and so does
`cdp_send` (category **Power**) for the two CDP methods that hand local files to
a page: the `files` of `DOM.setFileInputFiles` and the `data.files` of
`Input.dispatchDragEvent`, also when such a command is nested in the JSON
`message` of `Target.sendMessageToTarget` (the method name is matched without regard to case;
refusals read `cdp_send <method> refused "<path>" [<rule>]: ...`, and the
resolved paths are sent). Other CDP methods, `js_evaluate`, and local clients
that hold the bridge token (they talk to the extension without the tool layer)
are not limited by it.

### Files the server writes

- `savePath` must be an absolute path with an allowed extension. An existing
  file is replaced only with `overwrite: true` where a tool offers it
  (`tab_audio_record_stop`, `tab_audio_capture`, `perf_trace_stop`), and those
  tools are annotated as destructive.
- `session_state_save` and `cookies_export` take `savePath` (an absolute
  `.json` path) and `overwrite`: they write the complete bundle (cookie values
  included) with mode `0600` and return only a summary without values. Without
  `savePath`, a bundle larger than the output cap is refused (an error that
  asks for `savePath`); it is never cut and never written to disk unasked. Both
  tools are annotated as destructive because they can replace a file.
- Spilled text output: the full text of a tool result cut at
  `BROWSER_MCP_MAX_OUTPUT_CHARS` (default 40000) goes to one private folder per
  server process, `browser-mcp-spill-<pid>-<random>` in the system temp
  directory (created with `mkdtemp`, mode `0700`; files `<tool>-output.json` /
  `.txt`, then `-2`, `-3` ..., created exclusively with mode `0600`). The
  folder is deleted when the server shuts down or exits. At start-up the server
  deletes spill folders older than 24 h whose process is gone, and old
  `browser-mcp-XXXXXX` folders of earlier builds that hold nothing but one
  `<tool>-output.*` file. `dom_upload` and `cdp_send` refuse every path inside a
  spill folder.
- Text of the sensitive categories (cookies, storage, sessions, clipboard) is
  never spilled: it is cut, and the note says that the rest is not saved and how
  to get the full data explicitly (for example `cookies_export` or
  `session_state_save` with `savePath`).
- Without `savePath`, performance traces and PDFs or audio recordings over
  10 MiB go to a fresh private folder in the system temp directory
  (`browser-mcp-*`, created with `mkdtemp`, mode `0700`; files created
  exclusively with mode `0600`). These folders are kept: they hold what the
  tool result points to.
- The temp directory cannot be chosen by a project: `TEMP`, `TMP` and `TMPDIR`
  values loaded from a project `.env` file are removed (on Windows a value that
  names the standard `%LOCALAPPDATA%\Temp` stays).

### Files the server reads

`session_state_load` and `cookies_import` take `filePath` as an alternative to
the inline `state` / `cookies` (exactly one of the two). The file must be an
absolute path to a `.json` regular file of at most 64 MiB (a leading BOM is
allowed). Dot-segment paths and key or credential file names (the `dom_upload`
list) are refused on the given and on the resolved path, and error messages
never quote the file's content. Imported cookies are validated like the inline
parameter.

### Project `.env` files

MCP clients start the server inside the project the agent works on, and Bun
loads that project's `.env` files into the environment. At startup the server
removes every variable whose value equals what those files define (a different
value came from the client config or the shell and stays). Bun picks the
`.env.<mode>` files from the real `NODE_ENV` before it loads anything, so a
`NODE_ENV` set inside a project file does not change which files were loaded:
the server checks the files of the development mode as well whenever they set
the current `NODE_ENV`, judging each mode on its own values. `NODE_ENV` itself
is kept. Of its own
`BROWSER_MCP_*` settings, a project file may only set `BROWSER_MCP_PORT`,
`BROWSER_MCP_TOOLSETS`, `BROWSER_MCP_MAX_OUTPUT_CHARS`,
`BROWSER_MCP_NO_STDIO_EXIT`, `BROWSER_MCP_NO_PARENT_CHECK`,
`BROWSER_MCP_PARENT_CHECK_MS`, `BROWSER_MCP_NO_CLIENT_PING`,
`BROWSER_MCP_CLIENT_PING_MS`, `BROWSER_MCP_CLIENT_PING_TIMEOUT_MS` and
`BROWSER_MCP_CLIENT_PING_FAILS`. Every other `BROWSER_MCP_*` key
(`EXTENSION_IDS`, `HOME`, `PAIR`, `ALLOW_LEGACY_EXTENSION`, `UPLOAD_DIRS` and
any future key) must come from the client config or the shell; the server logs
the names it removed, never the values:

```text
[browser-mcp] ignored BROWSER_MCP_PAIR, BROWSER_MCP_HOME from .env in <cwd>: a project's env files may only set BROWSER_MCP_PORT, ...
```

The bridge port never comes from the generic `PORT` variable.

### Project `bunfig.toml`

Bun applies the working directory's `bunfig.toml` (`preload`, `define`, ...) to
every process it starts there, before any server code runs. A hostile project
could therefore run its own code inside the server, with access to the bridge
token and the pairing keys. Mitigations:

- **Safe launch command** (Bun >= 1.3.3):

  ```text
  bun --config=<repo>/mcp-server/bunfig.toml --no-env-file run <repo>/mcp-server/src/index.ts
  ```

  `mcp-server/bunfig.toml` is deliberately empty. Only the `--config=<path>`
  form works (checked with Bun 1.4.5): `--config <path>` and `-c <path>` still
  run the project's preload and then do not start the server, and `-c=<path>`
  applies the project's file as if no option were given. `--no-env-file` alone
  does not stop a project `bunfig.toml`.
- **Standalone binary:** `bun run build:binary` (this machine) or
  `bun run build:binaries` (all release targets) in `mcp-server/` builds
  `dist/browser-mcp[-<os>-<arch>][.exe]` with `--no-compile-autoload-dotenv
  --no-compile-autoload-bunfig --compile-exec-argv=--no-env-file`. The binary
  reads neither `bunfig.toml` nor `.env` from the working directory and needs no
  Bun at run time. Building it needs Bun >= 1.3.7 (binaries from older Bun
  releases still run a project preload).
- **bunx caveat:** always pin the version (`bunx @taiizor/browser-mcp@0.4.0`).
  An unversioned `bunx <name>` first runs `node_modules/.bin/<name>` from the
  working directory, which a project can plant. Never run `bunx
  browser-mcp-server`: that name belongs to an unrelated package. bunx accepts
  neither `--config` nor `--no-env-file`, so a project's `bunfig.toml` and
  `.env` still apply to the short-lived launcher; the launcher
  (`bin/browser-mcp.js`) starts the server as a child with the package's own
  `bunfig.toml`, `--no-env-file` and a cleaned environment, so the server
  process is clean, but a project preload has already run once as you. For
  untrusted projects use the standalone binary or
  `bunx --cwd=<absolute trusted folder> @taiizor/browser-mcp@0.4.0` (the server's
  working directory, one of the default upload folders, then becomes that folder).
- **Warning:** when Bun applied a project `bunfig.toml`, the server logs
  `[browser-mcp] warning: Bun applied <cwd>/bunfig.toml to this process ...`
  (the bunx launcher: `... to the launcher process ...`). It is a warning, not a
  refusal: the preload has already run by then.

## Known Limits

These are not vulnerabilities:

- Software running as your OS user can read the config directory (token,
  trusted ids, pairing keys) and the browser profile, and can connect as a local
  client. Protect your user account.
- Pairing is trust on first use: the first install (or the one install admitted
  by `--pair`) is whoever completes the handshake first. Check
  `pairedInstalls`, `trustedExtensionIds` and `lastExtensionRefusal` in
  `browser_status` when something looks wrong.
- `--allow-legacy-extension` and `BROWSER_MCP_EXTENSION_IDS=*` weaken the gate
  as described above.
- `js_evaluate` and `cdp_send` (popup category **Power**) run arbitrary code in
  pages and arbitrary DevTools commands, and can reach anything the other
  categories guard. `cdp_send`'s file lists for `DOM.setFileInputFiles` and
  `Input.dispatchDragEvent` pass the `dom_upload` path rules, but that is a
  guard against one obvious misuse, not a boundary. Disable **Power** when the
  switches must be a hard boundary.
- Page content returned to the model is untrusted input and may contain
  prompt-injection attempts. Only configure MCP clients and models you trust,
  and use the popup switches to limit what the agent can do.

If you run the bridge on a shared machine, expose the port beyond loopback
(port forwarding, proxies, containers with published ports), or use the
legacy or accept-any modes, that configuration is out of scope for security support.
