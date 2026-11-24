# Privacy Policy — Browser MCP Bridge

**Effective date:** October 12, 2026
**Last updated:** November 24, 2026

Browser MCP Bridge ("the extension") is a local automation bridge that lets your own
AI assistant (any MCP-compatible client, such as OpenCode or Claude) read and control
browser tabs on your behalf. It works together with the Browser MCP server, which runs
on your own computer.

**In short:** everything described here stays on your computer. Neither the extension
nor the MCP server sends data to the developer or to any other remote service. Data
reaches an AI model only through the MCP client you configured.

## Data we access

### When your assistant runs a tool

When — and only when — you instruct your AI assistant to perform a task, the extension
may access the following categories of data **locally on your device**, limited to what
the tool that was called needs:

- **Web history** — visited page URLs, titles, and visit times (e.g. `history_search`,
  tab listing).
- **User activity** — clicks, typing, scrolling, and navigation performed as part of
  the automation task you requested.
- **Website content** — text, images, links, and other page content needed to complete
  the task (e.g. DOM snapshots, screenshots, PDFs, the accessibility tree).
- **Performance data** — page timings and Web Vitals (`perf_web_vitals`) and
  performance traces (`perf_trace_start` / `perf_trace_stop`), which contain the
  URLs, script activity and timings of the traced tab and, if requested, screenshots.
- **Browser data the task asks for** — cookies, site storage (localStorage,
  sessionStorage, IndexedDB), bookmarks, downloads, the clipboard, or a tab's audio,
  each only when the matching tool is called.

### While the extension is connected to the MCP server

Some data is recorded in the background so that log tools can answer later. You can stop
each kind of capture with its switch in the extension popup; your assistant can turn
switches off but never back on. Nothing is recorded or streamed before the extension and
the server have completed their pairing handshake.

- **Network request metadata** (switch `network_requests`) — recorded for all tabs, but
  only while the extension is connected to the MCP server: request URL (up to 8,192
  characters, including the query string), method, resource type, tab ID, status code,
  cache flag, error text and time. This is sent to the local MCP server as it happens.
  Request and response headers (as exposed by Chrome's webRequest API, up to 50 of each per
  request; they can contain tokens or other credentials) are not streamed: they stay inside
  the extension and are handed out when your assistant calls `network_requests` or
  `har_export`.
- **Console messages** (switch `console_get`) — only from the main frame of *agent tabs*
  (tabs your assistant opened or targeted, and the active tab while your assistant works in
  it without naming a tab), only while the extension is connected (after 15 seconds without
  the server, capture stops until it reconnects), and only messages logged after the tab
  became an agent tab. Each message is capped at 4,000 characters and rate limited.
  Messages are sent to the local MCP server as they happen.
- **JavaScript dialogs** (switch `dialog_get`) — on tabs your assistant opened or
  targeted by ID, the text of alert/confirm/prompt dialogs and the automatic answer are
  kept inside the extension until your assistant reads them with `dialog_get`.
- **Request and response bodies** — only for a tab where your assistant started
  `network_mock_start`, kept inside the extension until that session ends.
- **Requests in flight** — for `page_wait` with `networkIdle`, the extension counts each
  tab's running requests by request ID and start time only (no URLs). The counts stay in
  the extension's memory and are never sent anywhere.

## How your data is used

- Data is used **solely to carry out the tasks you asked your assistant to do**.
- All communication between the extension and the MCP server stays on your local
  machine over a loopback WebSocket (`127.0.0.1`). Web pages cannot connect. The server
  accepts only extension installs that hold a pairing key it issued, and local programs
  that hold its private access token; the extension runs commands only for a server that
  proves it holds the same pairing key (see [docs/pairing.md](docs/pairing.md)).
- **The extension itself talks to no remote servers, collects no analytics, and includes
  no tracking code.** Requests it makes for a task (opening or reloading pages, or
  re-sending a recorded GET request for `network_response_body`) go only to the websites
  involved.
- Any data sent to an AI model is sent by **your own MCP client configuration**, not
  by this extension or the MCP server. Tool results, including recorded logs, reach your
  MCP client only when your assistant calls a tool or the client reads one of the server's
  resources (such as `browser://network/recent`). Review your AI provider's privacy terms
  for how they handle data.

## What we never do

- We do **not** sell or transfer your data to third parties.
- We do **not** use your data for purposes unrelated to the automation task at hand.
- We do **not** use your data to determine creditworthiness or for lending purposes.

## Data retention

In the extension (memory only, lost when the browser or the extension's background
worker restarts):

- up to 1,000 recent network entries, 1,000 console messages and 1,000 dialog events,
  cleared with `network_clear`, `console_clear` and `dialog_clear`; while a capture switch
  is off, nothing new of that kind is recorded and the matching read tool is blocked;
- a command history (up to 50 entries) shown in the popup, cleared with **Clear**: for
  each command the action, whether it succeeded (with the error text when it failed),
  its duration and time, the tab ID, the hostname of the tab it acted on, and a short
  summary such as the selector, the length of typed text or code, the number of files,
  the target hostname or cookie domain, the name of a special key (such as `Enter`) or
  a DevTools (CDP) method name. The summary never contains typed text, field values,
  cookie or storage values, clipboard text, code, file paths, or URL paths and queries.
  The error text is kept as the extension reported it and can quote a page URL, a value
  the command was given or a JavaScript exception message;
- tab audio recordings until your assistant collects them (unclaimed finished recordings
  are discarded after 30 minutes);
- finished performance traces until the MCP server has read them, at most 5 minutes
  (at most 4 traces and 256 MiB at a time).

In the extension's browser storage (web pages cannot read either store):

- `chrome.storage.local`: the port, the permission switches, the popup language, the list
  of permission names the popup last showed (`mcpKnownActions`, used to keep new
  permissions of a category you turned off switched off after an update), and the names of
  the permissions your assistant switched off itself (`mcpAgentDisabled`, action names
  only, used for the popup's **Off by agent** badge). From Chromium 140 only the
  extension's own pages and background worker can read it; on older versions the
  extension's content scripts technically can too, which is why the pairing key is not kept
  there;
- the extension's own IndexedDB (database `browser-mcp`), which only the extension's pages
  and background worker can open: the pairing record, a random install ID and the pairing
  key the local MCP server issued. The key never leaves the extension; it is only used to
  compute proofs during the handshake. **Forget pairing** in the popup deletes the key;
  uninstalling the extension deletes the whole record. Earlier builds kept this record in
  `chrome.storage.local` (`mcpPairing`); the extension moves it to IndexedDB on its first
  start and deletes the old copy.

Until the browser closes (`chrome.storage.session`): the dialog policy, the list of agent
tabs (with the origin of tabs used only as the active tab), focused frames, network-mock
routes, the tabs that hold a debugger session or a running trace, a pending **Re-pair**
deadline, and the time the server connection was lost.

In the MCP server on your computer:

- up to 1,000 recent console and 1,000 network events in memory per server process, lost
  when it exits and cleared with `console_clear` / `network_clear` or when the matching
  switch is turned off;
- a configuration folder (`~/.browser-mcp`, or `BROWSER_MCP_HOME`) holding the access
  token, the trusted extension IDs, the pairing keys of your extension installs
  (`extension-keys.json`: extension ID, install ID, key, pairing time and browser name),
  the last permission switches the extension reported and the last browser used — no
  browsing data;
- the full text of a tool result that was longer than the output limit
  (`BROWSER_MCP_MAX_OUTPUT_CHARS`, 40,000 characters by default), in one private folder
  per server process in your system's temporary directory (`browser-mcp-spill-*`, readable
  only by your user account). It contains whatever that tool returned, for example page
  text or network data, and the folder is deleted when the server exits (folders left
  behind by a crashed server are deleted at a later start, after 24 hours). Results with
  cookies, site storage, session bundles or clipboard text are never written there: they
  are only cut;
- files only where your assistant asks to save them (`savePath`), for example a cookie
  export or a session bundle (`cookies_export`, `session_state_save`), which contain cookie
  values and site storage. Nothing deletes these files; you decide where they go;
- otherwise, in a private folder in your system's temporary directory (`browser-mcp-*`,
  readable only by your user account), which is not deleted automatically:
  - performance traces saved without a `savePath`;
  - PDFs and audio recordings over 10 MiB returned without a `savePath`.

Screenshots and Web Vitals results are returned to your MCP client directly; the server
does not write them to disk.

## Contact

Questions about this policy: open an issue at
[https://github.com/Taiizor/browser-mcp/issues](https://github.com/Taiizor/browser-mcp/issues).
