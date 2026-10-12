# Privacy Policy — Browser MCP Bridge

**Effective date:** October 12, 2026

Browser MCP Bridge ("the extension") is a local automation bridge that lets your own
AI assistant (any MCP-compatible client, such as OpenCode or Claude) read and control
browser tabs on your behalf.

## Data we access

When — and only when — you instruct your AI assistant to perform a task, the extension
may access the following categories of data **locally on your device**:

- **Web history** — visited page URLs, titles, and visit times (e.g. `history_search`,
  tab listing).
- **User activity** — clicks, typing, scrolling, and navigation performed as part of
  the automation task you requested.
- **Website content** — text, images, links, and other page content needed to complete
  the task (e.g. DOM snapshots, screenshots).

## How your data is used

- Data is used **solely to carry out the single task you asked your assistant to do**.
- All communication between the extension and the MCP server stays on your local
  machine over a loopback WebSocket (`127.0.0.1`). **The extension itself talks to no
  remote servers, collects no analytics, and includes no tracking code.**
- Any data sent to an AI model is sent by **your own MCP client configuration**, not
  by this extension. Review your AI provider's privacy terms for how they handle data.

## What we never do

- We do **not** sell or transfer your data to third parties.
- We do **not** use your data for purposes unrelated to the automation task at hand.
- We do **not** use your data to determine creditworthiness or for lending purposes.

## Data retention

The extension keeps a short in-memory buffer of recent console/network events and a
command audit log (up to 50 entries) for transparency. This data never leaves your
device and is cleared when the browser session ends or when you press **Clear** in
the popup.

## Contact

Questions about this policy: open an issue at
[https://github.com/Taiizor/browser-mcp/issues](https://github.com/Taiizor/browser-mcp/issues).
