# Privacy Policy — Browser MCP Bridge

**Effective date:** October 12, 2026
**Last updated:** November 11, 2026

Browser MCP Bridge ("the extension") is a local automation bridge that lets your own
AI assistant (any MCP-compatible client, such as OpenCode or Claude) read and control
browser tabs on your behalf. It works together with the Browser MCP server, which runs
on your own computer.

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
- **Browser data the task asks for** — cookies, site storage (localStorage,
  sessionStorage, IndexedDB), bookmarks, downloads, the clipboard, or a tab's audio,
  each only when the matching tool is called.

### While the extension is connected to the MCP server

Some data is recorded in the background so that log tools can answer later. You can stop
each kind of capture with its switch in the extension popup; your assistant can turn
switches off but never back on.

- **Network request metadata** (switch `network_requests`) — recorded for all tabs, but
  only while the extension is connected to the MCP server: request URL (up to 8,192
  characters, including the query string), method, resource type, tab ID, status code,
  cache flag, error text and time. This is sent to the local MCP server as it happens.
  Request and response headers (as exposed by Chrome's webRequest API, up to 50 of each per
  request; they can contain tokens or other credentials) are not streamed: they stay inside
  the extension and are handed out when your assistant calls `network_requests` or
  `har_export`.
- **Console messages** (switch `console_get`) — only from the main frame of *agent tabs*
  (tabs your assistant targeted or opened), only while the extension is connected (after
  15 seconds without the server, capture stops until it reconnects), and only messages
  logged after the tab became an agent tab. Each message is capped at 4,000 characters and
  rate limited. Messages are sent to the local MCP server as they happen.
- **JavaScript dialogs** (switch `dialog_get`) — on agent tabs, the text of
  alert/confirm/prompt dialogs and the automatic answer are kept inside the extension until
  your assistant reads them with `dialog_get`.
- **Request and response bodies** — only for a tab where your assistant started
  `network_mock_start`, kept inside the extension until that session ends.

## How your data is used

- Data is used **solely to carry out the tasks you asked your assistant to do**.
- All communication between the extension and the MCP server stays on your local
  machine over a loopback WebSocket (`127.0.0.1`). The server only accepts the paired
  Browser MCP extension and local programs that hold its private access token; web pages
  cannot connect.
- **The extension itself talks to no remote servers, collects no analytics, and includes
  no tracking code.** Requests it makes for a task (opening pages, or re-sending a
  recorded GET request for `network_response_body`) go only to the websites involved.
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
- a command audit log (up to 50 entries) shown in the popup, cleared with **Clear**;
- tab audio recordings until your assistant collects them (unclaimed finished recordings
  are discarded after 30 minutes).

In the extension's browser storage: the port, the permission switches and the popup
language (`chrome.storage.local`), and, until the browser closes, the dialog policy, the
list of agent tabs, focused frames and network-mock routes (`chrome.storage.session`).

In the MCP server on your computer:

- up to 1,000 recent console and 1,000 network events in memory per server process, lost
  when it exits and cleared with `console_clear` / `network_clear` or when the matching
  switch is turned off;
- a configuration folder (`~/.browser-mcp`, or `BROWSER_MCP_HOME`) holding the access
  token, the trusted extension IDs and the last browser used — no browsing data;
- files only where your assistant asks to save them (`savePath`). Large PDFs or audio
  recordings returned without a `savePath` are written to a private folder in your
  system's temporary directory (`browser-mcp-*`), which is not deleted automatically.

## Contact

Questions about this policy: open an issue at
[https://github.com/Taiizor/browser-mcp/issues](https://github.com/Taiizor/browser-mcp/issues).
