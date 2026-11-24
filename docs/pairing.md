# Pairing and trust

Browser MCP lets an AI agent act in your browser, so the extension and the MCP server check each other before
any command runs. The bridge is a WebSocket server on `127.0.0.1`, and three kinds of peers can knock:

| Peer | Check | Refusal |
|---|---|---|
| Web pages (any `Origin` that is not `chrome-extension://` / `moz-extension://`) | Refused during the HTTP upgrade | HTTP 403 |
| The extension | Trusted extension id, then the protocol-3 handshake with a per-install pairing key | close codes 4002-4008 |
| Local scripts and other server processes (no `Origin`) | Proof of the per-run bridge token from the config directory | close code 4001 |

This page covers the day-to-day side: how pairing works, every state the extension popup can show, and how to
fix each one. The threat model and the exact frames are in
[SECURITY.md](../SECURITY.md#bridge-trust-model-protocol-v3); scripts and satellites are in
[bridge-protocol.md](bridge-protocol.md).

- [How pairing works](#how-pairing-works)
- [Extension ids](#extension-ids)
- [First setup](#first-setup)
- [Popup states](#popup-states)
- [Common tasks](#common-tasks)
- [Close codes](#close-codes)
- [Diagnostics](#diagnostics)

## How pairing works

- Every extension **install** (each browser profile with the extension, a reinstalled extension, an unpacked
  build loaded from another folder) has its own random 32-byte pairing key and a random install id. The
  extension keeps both in its own IndexedDB storage inside the browser profile, where web pages and content
  scripts cannot reach them. The server keeps the key in `extension-keys.json` in its
  [config directory](configuration.md#config-directory): `~/.browser-mcp` (Windows:
  `%USERPROFILE%\.browser-mcp`), or `BROWSER_MCP_HOME` when set. The key is never logged or returned by any
  tool.
- On every connection both sides prove that they hold the same key (HMAC-SHA256 over fresh nonces, the
  extension id, the install id and the port). The extension checks the server's proof first and runs no
  command until the server has proved itself and sent `welcome`; the server sends no command to an extension
  that cannot prove the key either.
- The handshake has to finish within 5 seconds of connecting (`4008` otherwise). When the same install
  connects again, its older socket is closed with `4006` (normal after a reconnect).
- A key is handed out only while the server's **pairing window** is open:
  - **first setup:** `extension-keys.json` is missing or lists no install, so the first install that connects
    gets a key automatically;
  - **`--pair`** (or `BROWSER_MCP_PAIR=1`): for 10 minutes after the process started, and only until one new
    install has paired in that run.
- The extension accepts a key on its own only when it holds none (a fresh install, or after **Forget
  pairing**). An extension that already holds a key never replaces it on its own: it declines the offer
  (`4100`) and asks you first (**Re-pair**).

## Extension ids

Before the handshake, the extension is identified by the id in its `Origin` header. Trusted ids are:

- the Edge Add-ons store id `hdhibkihdkndmfecegdnbpebolhokkbh` (built in);
- ids from `BROWSER_MCP_EXTENSION_IDS` (comma separated) and `--extension-id` (repeatable);
- ids saved in `trusted-extensions.json` in the config directory. Every extension that completes a handshake
  is recorded there.

**Trust on first use:** without an explicit list, while `trusted-extensions.json` is missing or empty, the
first extension that completes the handshake is trusted and saved; after that, no other id is accepted.
**Explicit list = strict:** with `BROWSER_MCP_EXTENSION_IDS` or `--extension-id` there is no trust on first use;
only the built-in id, the listed ids and ids already in the file are accepted. **Legacy accept-any:**
`BROWSER_MCP_EXTENSION_IDS=*` (or `--extension-id "*"`) accepts any id, logs a warning on startup and records
nothing. An untrusted id is closed with `4003 untrusted-extension:<id>` as soon as it connects.

Any local process can send any `Origin` header, so the id is only a filter. What authenticates the extension
(and the server to the extension) is the pairing key. An unpacked build has its own id, which depends on the
folder it was loaded from.

## First setup

1. Install the MCP server and the extension from the same release ([installation.md](installation.md)).
2. Start your MCP client with the browser open; the client starts the server. The server logs
   `no extension install paired yet; the first install that connects gets a pairing key (<path>/extension-keys.json)`.
3. The extension connects, its id is trusted on first use and it receives a key. The popup badge shows
   **Connected**, and the line under the header shows **Paired with the MCP server** and the server version.
   The server logs `paired extension <id> install <installId> (...)`; `trusted-extensions.json` and
   `extension-keys.json` now exist in the config directory.

Nothing else is needed; both files are reused on every later start. Pair right after installing: during first
setup, whatever connects first is paired.

**Upgrading from 0.3.x:** update both the server and the extension. The new server starts without
`extension-keys.json`, so the first browser that connects pairs automatically; every further browser needs
[`--pair`](#start-the-server-once-with---pair).

## Popup states

The badge is in the popup header. The line under it shows the server version once paired, the pairing state and
the number of agent tabs. A problem shows a notice: a short title, one sentence, at most one button (**Re-pair**,
**Forget pairing** or **Copy ID**) and a **Details** link that opens the matching section below, with the full fix. A problem state
stays on screen across the slow retries until a handshake succeeds or you act.

| Badge | Notice / line under the header | Close code | What to do |
|---|---|---|---|
| **Connected** | Server v… · Paired | - | [Connected](#connected) |
| **Connecting…** | Verifying the MCP server… | - | [Connecting](#connecting) |
| **No server** | Not paired yet (nothing when this browser already holds a key) | none | [No server](#no-server) |
| **Unknown server** | Unknown server | `4101` | [Unknown server](#unknown-server) |
| **Pairing needed** | Pairing needed (**Re-pair** button) | `4100` | [Pairing needed](#pairing-needed) |
| **Pairing needed** | Pairing needed (**Forget pairing** button) | `4005` | [Pairing needed](#pairing-needed) |
| **Pairing needed** | Pairing is closed | `4004` | [Pairing is closed](#pairing-is-closed) |
| **Update needed** | Versions do not match | `4002`, `4102` | [Versions do not match](#versions-do-not-match) |
| **Rejected** | Extension not recognized (**Copy ID** button) | `4003` | [Extension not recognized](#extension-not-recognized) |
| **Disconnected** | Connection closed | `4008` and others | [Connection closed](#connection-closed) |
| **Error** | - | - | The popup could not read the extension's status: reopen the popup, or reload the extension |

After a refusal the extension tries again every 30 seconds. Reloading the extension in `chrome://extensions`
(or `edge://extensions`) reconnects at once and keeps its pairing.

<!-- The popup's Details links (DOCS_URL in extension/popup.js) open the notice headings below by their GitHub
anchors: keep these titles in sync with the notice titles. -->

### Connected

Everything works. If the agent still reports `Browser extension not connected`, its server process may use
another port: compare the port in the popup's **⋯** menu (**Bridge port**) with `--port` / `BROWSER_MCP_PORT`
of the server.

### Connecting

The socket is open and the handshake is running; this normally lasts a fraction of a second (a real server
closes an unfinished handshake after 5 s). If it does not go away, the program on the port accepts WebSocket
connections but is not a browser-mcp server. Nothing runs on such a connection. Check what listens on the port
(Windows: `netstat -ano | findstr :8765`, macOS/Linux: `lsof -iTCP:8765 -sTCP:LISTEN`).

### No server

Nothing accepted the connection:

- The server runs only while an MCP client runs it. Start a client session, or run the launch command from the
  README in a terminal.
- The port in the popup's **⋯** menu (**Bridge port**) must match the server's port (`--port`,
  `BROWSER_MCP_PORT`, default `8765`). Change it there if needed.
- If the server cannot bind its port, it logs `Cannot bind the browser-mcp bridge on 127.0.0.1:<port> ...` (on
  Windows the port may be in a reserved range).
- The line under the header still shows whether this browser holds a pairing key (**This browser holds a
  pairing key**) or not (**Not paired yet**: the first server that offers pairing will be trusted
  automatically).

### Unknown server

The program on the port is not the server this browser paired with: it could not prove that it holds this
browser's pairing key, so the extension closed the connection (`4101 server-auth-failed`) and ran no command.
Typical causes:

- this browser was paired with another server or config directory since (for example two MCP clients with
  different `BROWSER_MCP_HOME` on the same port);
- the server's `extension-keys.json` was replaced or restored from an older copy, or you reset the server's
  pairing data;
- a program that is not your server listens on the port (also one that relays the connection to a real
  browser-mcp server on another port: the proofs are bound to the port the extension dialed).

Fix:

1. Check what listens on the port (see [Connecting](#connecting)). If it is not your server, stop that program or
   move both sides to another port, and do not pair with it.
2. When the server is yours, either click **Forget pairing** in the popup's **⋯** menu and
   [start the server once with `--pair`](#start-the-server-once-with---pair) (or `BROWSER_MCP_PAIR=1`), or
   delete `extension-keys.json` in the server's [config directory](configuration.md#config-directory) and click
   **Re-pair** when the popup shows [Pairing needed](#pairing-needed). The server reads the file on every
   connection, so no restart is needed; deleting it unpairs every browser
   ([Reset all pairings](#reset-all-pairings)).
3. Make every server process on this port use the same config directory
   ([Several MCP clients or agents](#several-mcp-clients-or-agents)).

### Pairing needed

This browser's pairing key and the server's do not match, and pairing again fixes it. Two closes lead here, and
the notice shows the button that fixes each one (**Re-pair** after `4100`, **Forget pairing** after `4005`); both
are also in the popup's **⋯** menu under **Pairing**:

- **The server offered a new key** (`4100 pair-declined`): the server on the port does not know this browser's
  key and offered a new one, but this browser already holds one, so the extension declined. This happens when
  the server lost its keys: `extension-keys.json` was deleted, the server runs with another `BROWSER_MCP_HOME`,
  under another OS user, or on a reinstalled system.
- **The server rejected this browser's proof** (`4005 auth-failed`): the server holds a different key for this
  install than the extension does. The server logs `extension <id> failed authentication (install <installId>)`.

Fix after `4100`:

- If you reset or moved the server yourself, click **Re-pair**. The button shows **Waiting for the server…**;
  the extension reconnects at once and accepts the server's next pairing offer within 2 minutes, replacing its
  old key.
- If you did not, do **not** click it: another program may be imitating the server. Check what listens on the
  port (see [Connecting](#connecting)).

Fix after `4005`: **Re-pair** alone does not help, because the server still knows this install and asks for
its old key instead of offering a new one. Click **Forget pairing** in the notice (or in the popup's **⋯** menu) and
[start the server once with `--pair`](#start-the-server-once-with---pair) (or `BROWSER_MCP_PAIR=1`); or delete
`extension-keys.json` in the server's [config directory](configuration.md#config-directory) and click **Re-pair**
when the popup asks (no restart needed). Deleting the file unpairs every browser
([Reset all pairings](#reset-all-pairings)).

If **Re-pair** ends in [Pairing is closed](#pairing-is-closed), another install paired first or the server's
pairing window closed in the meantime: start the server once with `--pair` and click **Re-pair** again.

The extension also declines with `4100` when it cannot store a key at all: if its IndexedDB storage cannot be
opened, the service worker console shows `[mcp] pairing store (IndexedDB) unavailable: ...` and every
pairing offer is declined. **Re-pair** does not help then; reload the extension or restart the browser.

### Pairing is closed

The server already has paired installs and does not know this one, and its pairing window is closed
(`4004 pairing-closed`); the badge shows **Pairing needed**. The server logs `refused new install of extension
<id>: pairing is closed (start the server once with --pair or BROWSER_MCP_PAIR=1, or delete
<path>/extension-keys.json)`. Typical causes:

- a second browser or browser profile;
- the extension was removed and installed again (that is a new install);
- **Forget pairing** was used while the server's window was closed.

Fix: [start the server once with `--pair`](#start-the-server-once-with---pair) (or `BROWSER_MCP_PAIR=1`) and
let this browser connect within 10 minutes. A browser without a key then pairs automatically; one that still
holds a key (the line under the header then shows no pairing text) shows
[Pairing needed](#pairing-needed) first: click **Re-pair**. Deleting `extension-keys.json` in the server's
config directory also works but unpairs every browser (see [Reset all pairings](#reset-all-pairings)).

### Versions do not match

The extension and the MCP server speak different bridge protocols, which in practice means different releases;
the badge shows **Update needed**. A different version number alone (a patch release on one side) is not a
problem and shows no notice. The notice says which side to update:

- **Update the MCP server to this extension's release** (`4102 server-outdated`, or `4002` with a lower server
  number): a 0.3.x server answered without the protocol-3 handshake. Update the server, then restart it (close
  every MCP client session that runs it on this port and start one again). This is common after the store
  updated the extension on its own.
- **Update this extension to the MCP server's release** (`4002 protocol-mismatch:server=3,ext=<n>`): update the
  extension, then reload it in `chrome://extensions` (or `edge://extensions`). The server logs `refused
  extension <id>: it speaks bridge protocol <n>, this server speaks 3 (update the extension)`. A 0.3.x extension
  shows **Rejected** and **The MCP server closed the connection** with `4002 protocol-mismatch:server=3,ext=2`
  instead.
- **Update the extension and the MCP server to the same release**: the close did not say which side is older.
  Update both, restart the server and reload the extension.

See [Extension updates and server updates](#extension-updates-and-server-updates) and
[Legacy mode](#legacy-mode).

### Extension not recognized

The server does not trust this extension id (`4003 untrusted-extension:<id>`); see
[Extension ids](#extension-ids). The badge shows **Rejected**. This happens with an unpacked build loaded from
another folder, a second extension id next to the store version, or an id that is not on an explicit list.

Fix: click **Copy ID** in the notice (the **⋯** menu shows the id under **Extension** too). Then either:

- set `BROWSER_MCP_EXTENSION_IDS=<id>` in the MCP client config (not in a project `.env` file, which cannot set
  it) or pass `--extension-id <id>`; or
- delete `trusted-extensions.json` in the config directory, so the next id that connects is trusted;

and restart the server. A new id is also a new install, so unless `extension-keys.json` is empty, add
`--pair` for that start (`--extension-id <id> --pair`). After one successful connection the id is saved in
`trusted-extensions.json` and the flags are no longer needed.

### Connection closed

The server closed the connection during the handshake for a reason that has no notice of its own; the badge
shows **Disconnected**. The popup does not show the close code: `browser_status` reports it as
`lastExtensionRefusal` (see [Diagnostics](#diagnostics)).

- `4008 handshake-timeout`: the extension did not finish the handshake within 5 seconds (for example while the
  browser was busy). It reconnects by itself.
- Any other code: see [Close codes](#close-codes) and [Diagnostics](#diagnostics).

## Common tasks

### Pair another browser or profile

<a id="adding-another-browser-or-install"></a>

Every browser profile with the extension is its own install. With one install already paired, a second one
shows **Pairing is closed**. Start the server once with `--pair` (next section) and let the second browser
connect within 10 minutes; it pairs automatically because it holds no key yet. Each run admits one install, so
repeat it for every further browser. If the second browser uses another extension id (an unpacked build next to
the store version, or one loaded from a new folder), see
[Extension not recognized](#extension-not-recognized) as well.

### Start the server once with --pair

Only the server process that owns the port (the *primary*) can pair. Other server processes on the same port
join it as satellites, and a satellite started with `--pair` logs `--pair has no effect here: the primary bridge
on :<port> (another browser-mcp process) decides; ...` (it uses its own option only if it later becomes the
primary). So first close the MCP client sessions that run browser-mcp on this port, then use one of:

- **MCP client config:** add `"--pair"` to the server's `args`, start one client session, connect the browser,
  then remove `--pair` again. For example:

  ```json
  {
    "command": "bun",
    "args": ["--config=<repo>/mcp-server/bunfig.toml", "--no-env-file", "run", "<repo>/mcp-server/src/index.ts", "--pair"]
  }
  ```

- **Environment:** `BROWSER_MCP_PAIR=1` in the client config's `env` block or in the shell. A project `.env`
  file cannot set it.
- **Terminal:** run the server's launch command with `--pair` while no client is running, wait until the popup
  shows **Connected**, then stop it with Ctrl+C (without an MCP client answering its pings it also exits on its
  own after about two minutes).

The server logs `pairing open for one new extension install for 10 min (--pair)` and, when it worked,
`paired extension <id> install <installId> (...)`. The extension retries every 30 seconds; reload it to
connect at once. Do not leave `--pair` in your configuration: the window closes after one install or
10 minutes, but a permanent flag reopens it on every start and admits one install nobody checked.

### Re-pair

**Re-pair** is in the popup's **⋯** menu under **Pairing**, and the **Pairing needed** notice after `4100` shows it
as well.
It keeps the old key until the server's next pairing offer (within 2 minutes) replaces it, and reconnects right
away. It never pairs with a server whose pairing window is closed.

### Forget pairing

**Forget pairing** is in the popup's **⋯** menu under **Pairing**, and the **Pairing needed** notice after `4005`
shows it as well; it is disabled while this browser holds no key. It asks for confirmation in a dialog, then deletes this browser's key (the install id stays) and
reconnects.
The server then treats the browser as a new install: it pairs at once if the server's pairing window is open (no
install paired yet, or `--pair`), otherwise the popup shows **Pairing is closed**. Use it to move a browser to
another server or config directory, or to recover from **Unknown server** and a rejected
proof (**Pairing needed** after `4005`).

### Reset all pairings

Delete `extension-keys.json` in the server's config directory (`browser_status` shows it as `configDir`). The
server reads the file on every connection, so no restart is needed. Then:

- a browser without a key pairs automatically;
- a browser that still holds a key shows **Pairing needed**: click **Re-pair**;
- only the first one pairs this way; every further browser needs
  [`--pair`](#start-the-server-once-with---pair).

`trusted-extensions.json` (extension ids) is a separate file; keep it unless the ids should be pinned again.
Deleting both files and restarting the server is the big hammer: the next extension that connects is paired as
on first setup.

### Extension updates and server updates

- The store version of the extension updates itself. The server updates only when you update it: `git pull`
  and `bun install`, a new standalone binary, or a new pinned version in `bunx @taiizor/browser-mcp@<version>`.
- Updates keep the pairing on both sides: the extension's key survives extension updates and reloads, and the
  server's key lives in the config directory, not in the installation. An extension updated from a build that
  kept the key in `chrome.storage.local` moves it to IndexedDB on its first start and deletes the old copy.
- The pairing is lost when the extension is removed and installed again, when it is loaded unpacked from
  another folder (also a new id), in a new browser profile, and when the server's config directory changes.
- When one side is updated to a new bridge protocol before the other, the popup shows **Update needed** and
  names the side to update ([Versions do not match](#versions-do-not-match)). The popup's **⋯** menu shows the
  extension version, and the line under the header shows the server version once paired; different version
  numbers alone (a patch release on one side) are not a problem.

### Legacy mode

A current server refuses 0.3.x extensions (`4002`). While you cannot update such an extension yet, start the
server with `--allow-legacy-extension` (or `BROWSER_MCP_ALLOW_LEGACY_EXTENSION=1` in the client config or
shell). It then accepts the old protocol **without any key**: any program on your computer that sends the
extension's id could pose as the extension. The server warns about it at every start. Update the extension and
remove the option as soon as you can. There is no legacy mode the other way round: a current extension never
runs commands from a 0.3.x server.

### Several MCP clients or agents

The first server process on a port owns the bridge and does the pairing; the others relay through it as
satellites ([bridge-protocol.md](bridge-protocol.md)). Give every server process on the same port the same
config directory (the same `BROWSER_MCP_HOME`, or none). Otherwise the popup can switch between **Connected**
and **Unknown server** or **Pairing needed**, depending on which process owns the port, and a satellite
cannot verify the primary (it logs `WARNING: satellite not linked: ...`).

## Close codes

| Code | Reason | Sent by | Meaning | Popup |
|---|---|---|---|---|
| 4001 | `auth-required` | server | A script or satellite did not prove the bridge token (or sent nothing within 5 s); never sent to the extension ([bridge-protocol.md](bridge-protocol.md#scripts-and-other-clients)) | - |
| 4002 | `protocol-mismatch:server=3,ext=<n>` | server | The extension speaks another bridge protocol (`<n>` = `none` when its hello has none) | Update needed |
| 4003 | `untrusted-extension:<id>` | server | Extension id not trusted and trust on first use closed | Rejected (Extension not recognized) |
| 4004 | `pairing-closed` | server | New install, but the pairing window is closed (also when another install paired first during the handshake) | Pairing needed (Pairing is closed) |
| 4005 | `auth-failed` | server | The extension's proof does not match the key the server holds for this install | Pairing needed (Forget pairing) |
| 4006 | `replaced` | server | The same install connected again; the older socket is closed (normal) | (not shown) |
| 4008 | `handshake-timeout` | server | The handshake did not finish within 5 s | Disconnected (Connection closed) |
| 1008 | `bad-hello` | server | Malformed protocol-3 hello (install id or nonce) | No server |
| 4100 | `pair-declined` | extension | A key was offered, but this browser holds one and Re-pair was not clicked (or the key could not be stored) | Pairing needed (Re-pair) |
| 4101 | `server-auth-failed` | extension | The server's proof is wrong, missing or bound to another port, a frame was malformed or out of order; no command was run | Unknown server |
| 4102 | `server-outdated` | extension | The server answered `welcome` without a protocol-3 handshake (an older server) | Update needed |

After 4002-4005 and 4100-4102 the extension retries every 30 s; after any other close it reconnects with a
backoff from 1 s up to 10 s. A `chrome.alarms` heartbeat every 30 s wakes the service worker to reconnect.

## Diagnostics

- The server logs to stderr with a `[bridge:<pid>]` prefix; most MCP clients show it in their MCP server logs.
  Typical lines: `refused untrusted extension <id> (...)`, `refused new install of extension <id>: pairing is
  closed (...)`, `paired extension <id> install <installId> (...)`, and, when the extension refuses this
  server, `extension <id> refused this server (<code> <reason>): <what to do>`.
- `browser_status` reports `extensionVersion`, `extensionProtocol`, `serverVersion`, `bridgeProtocol`,
  `pairingOpen`, `pairedInstalls`, `legacyExtensionAllowed`, `trustedExtensionIds`, `rejectedExtensionIds`,
  `tofuOpen`, `configDir` and `lastExtensionRefusal` (`{ code, reason, extensionId, at }`).
- `lastExtensionRefusal` holds the server's own refusals and the extension's `4100` / `4101`, but only a close
  that answers this server's own handshake step (`4101` after a challenge or a pairing offer, `4100` after a
  pairing offer). Its `reason` is then the code's fixed name (`pair-declined`, `server-auth-failed`), never
  text the peer sent. A `4102` is not recorded: it only answers a `welcome` without a handshake, which this
  server never sends.
- For 10 minutes after a refusal, the agent's `Browser extension not connected` error says what to do about
  it.
