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

## Scope Notes

Browser MCP intentionally holds powerful browser permissions
(`debugger`, `<all_urls>`, cookies, clipboard, browsing data). Whoever can drive
the bridge can act as you in your browser, so the design limits who may talk to it:

- **Loopback only.** The bridge listens on `127.0.0.1:<port>` (default `8765`).
- **Web pages are refused.** A WebSocket upgrade whose `Origin` is not
  `chrome-extension://` or `moz-extension://` is rejected with HTTP 403, so a
  page cannot connect (or tell the bridge apart from a closed port).
- **Only trusted extensions.** An extension socket is identified by the id in
  its `Origin`. Trusted ids: the Edge Add-ons store id
  (`hdhibkihdkndmfecegdnbpebolhokkbh`), `BROWSER_MCP_EXTENSION_IDS`,
  `--extension-id`, and `trusted-extensions.json` in the config directory
  (`BROWSER_MCP_HOME` or `~/.browser-mcp`). Without an explicit list, the first
  extension that completes the handshake is paired and saved (trust on first
  use), which closes pairing; with an explicit list there is no trust on first
  use. Any other extension is closed with `4003 untrusted-extension:<id>`.
  An extension socket may only send its `hello`, events, and replies to
  commands that were sent to that same socket; it can never send commands.
- **Local clients need a token.** Sockets without an `Origin` (additional
  browser-mcp server processes, scripts) must first send
  `{ "type": "auth", "token": "<token>" }`. The token is 32 random bytes,
  regenerated whenever a primary bridge starts, stored in
  `bridge-<port>.token` in the config directory (directory `0700`, file `0600`
  on POSIX systems; on Windows the user-profile ACLs apply) and compared in
  constant time. A wrong or missing token, any other first message, or 5 s of
  silence closes the socket with `4001 auth-required`. Such sockets can never
  act as the extension.
- **The agent can only restrict itself.** Over the bridge, permissions can be
  disabled but never re-enabled; turning a switch back on is only possible in
  the extension popup. The background worker answers popup operations only for
  the extension's own pages, never for content scripts or web pages, and, while
  it runs, reverts any `chrome.storage.local` write that would turn a switch
  back on. Web pages have no access to the extension's storage.
- **Narrow page hooks.** Console and dialog hooks are installed only in tabs
  the agent works in (see [PRIVACY.md](PRIVACY.md)).

Known limits (not vulnerabilities):

- Software running as your OS user can read the config directory (token and
  trusted ids) and connect like a local client. Protect your user account.
- Trust on first use pins whichever extension completes the handshake first.
  Check `trustedExtensionIds` in `browser_status` and remove unexpected ids
  from `trusted-extensions.json` (then restart the server), or set `BROWSER_MCP_EXTENSION_IDS` before the
  first connection (strict mode, no trust on first use).
- `BROWSER_MCP_EXTENSION_IDS=*` turns the extension check off (legacy mode;
  the server logs a warning on startup). Do not use it on shared machines.
- `js_evaluate` and `cdp_send` (popup category **Power**) run arbitrary code
  in pages and can reach anything the other categories guard. Disable
  **Power** when the switches must be a hard boundary.
- Page content returned to the model is untrusted input and may contain
  prompt-injection attempts. Only configure MCP clients and models you trust,
  and use the popup switches to limit what the agent can do.

If you run the bridge on a shared machine, expose the port beyond loopback
(port forwarding, proxies, containers with published ports), or use the
legacy accept-any mode, that configuration is out of scope for security support.
