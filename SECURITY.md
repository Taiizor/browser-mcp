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
(`debugger`, `<all_urls>`, clipboard, browsing data). The threat model assumes:

- The MCP server only listens on loopback (`127.0.0.1`).
- The WebSocket bridge rejects non-local `Origin` headers.
- Only trusted local MCP clients should be configured to run this server.

If you run the bridge on a shared machine or expose the port beyond loopback,
that configuration is out of scope for security support.
