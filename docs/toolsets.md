# Toolsets and output budget

Every tool definition the client lists costs context on every request, and one unbounded tool result can
fill the rest. The server therefore lists a small tool set by default, lets the agent add more at runtime,
hides tools the user switched off, and caps the text of every result.

- [Toolsets](#toolsets)
- [Choosing toolsets at start-up](#choosing-toolsets-at-start-up)
- [Changing toolsets at runtime](#changing-toolsets-at-runtime)
- [Tools hidden by the popup switches](#tools-hidden-by-the-popup-switches)
- [Output cap](#output-cap)
- [Paging large pages](#paging-large-pages)

## Toolsets

A toolset is `core`, `all`, or one of the 22 categories. A category is the permission category of the
extension action the tool runs, so toolsets line up with the switches in the popup; `meta` holds the tools
that run no switchable action.

| Toolset | Contents |
|---|---|
| `core` (default) | 28 everyday tools: `browser_status`, `browser_toolsets`, `tab_list`, `tab_create`, `tab_close`, `tab_activate`, `tab_navigate`, `tab_reload`, `tab_back`, `tab_forward`, `page_snapshot`, `page_text`, `page_html`, `dom_query`, `page_find`, `page_wait`, `dom_click`, `dom_type`, `dom_fill`, `dom_select`, `dom_check`, `dom_hover`, `dom_scroll`, `keyboard_press`, `dom_upload`, `page_screenshot`, `console_get`, `dialog_policy` |
| `all` | Every tool (122) |
| `meta` | Bridge status, browser launch, permission switches, toolsets. **Always listed** |
| `tabs`, `read`, `interact`, `media`, `console`, `network`, `mock`, `downloads`, `bookmarks`, `cookies`, `storage`, `sessions`, `dialogs`, `power`, `trusted`, `clipboard`, `browsing_data`, `notifications`, `system`, `emulation`, `performance` | One category each |

With the default selection the client sees 31 tools: the 28 core tools plus the meta tools `browser_launch`,
`permissions_list` and `permissions_set`. The per-toolset tool lists are in [tools.md](tools.md).

Ids are case-insensitive, `-` counts as `_` and surrounding spaces are ignored (`Browsing-Data` = `browsing_data`),
both at start-up and in `browser_toolsets`.

## Choosing toolsets at start-up

`--toolsets <list>` (repeatable; lists are merged) or `BROWSER_MCP_TOOLSETS`; the flag wins. Examples:

```sh
... src/index.ts --toolsets core,network,cookies   # core plus two categories
... src/index.ts --toolsets all                    # every tool, as before toolsets existed
```

```json
"env": { "BROWSER_MCP_TOOLSETS": "core,emulation,performance" }
```

Unknown ids are reported on stderr (`ignoring unknown toolset(s) from --toolsets: ...`) and ignored; when no
valid id is left, `core` is used. `BROWSER_MCP_TOOLSETS` may also come from a project's `.env` file.

## Changing toolsets at runtime

The `browser_toolsets` tool (always listed):

- without arguments returns every toolset with its title, whether it is enabled, how many of its tools exist
  and are listed, the tool names, and the tools hidden by popup switches;
- `{"enable": ["network"]}` / `{"disable": ["interact"]}` change the selection (`enable` runs first) and return
  the tools that were shown or hidden.

Rules: enabling a category lists all of its tools; enabling `all` lists everything and lifts every exclusion.
Disabling a category hides its tools even from `core` and `all` (`{"enable":["all"], "disable":["power"]}` =
everything except `js_evaluate` and `cdp_send`). Disabling `core` or `all` only drops that selection.
`meta` cannot be switched off.

The server sends one `notifications/tools/list_changed` per change. A client that ignores this notification
shows the new tool list only after it reconnects; choose toolsets at start-up for such clients. Calling a tool
that is not listed anyway returns an error result that names the fix, and nothing reaches the extension:

```text
Tool network_requests is not enabled: it belongs to the "network" toolset, which is off. Call browser_toolsets {"enable":["network"]} to list it, then call network_requests again.
```

A toolset switched off with `browser_toolsets` reads `Tool <name> is not enabled: its toolset "<id>" was
disabled with browser_toolsets. Call browser_toolsets {"enable":["<id>"]} to list it again, then call <name>
again.` A name the server does not know at all still gets the SDK's "not found" error. The server's
instructions tell the model that `browser_toolsets` exists and that such errors name the fix, and the built-in
prompts name it where they need a non-core tool; descriptions of core tools that point to another tool name
its toolset (for example `dom_click`: "use trusted_click instead (toolset trusted)").

## Tools hidden by the popup switches

A tool is listed only while every extension action it runs is switched on in the popup (for example
`tab_audio_capture` needs `tab_audio_record_start` and `tab_audio_record_stop`), together with the switches
those actions read through: `har_export`, `network_bodies` and `network_response_body` also need
`network_requests`, `cookies_export` needs `cookies_list`, `cookies_import` needs `cookies_set`,
`session_state_save` needs `cookies_list` + `storage_get`, and `session_state_load` needs `cookies_set` +
`storage_set`. (`perf_trace_start` with screenshots also needs `page_screenshot`, but that depends on its
arguments, so the tool stays listed and the call itself is refused.) When the user switches an
action off, its tools disappear from the list (with a `list_changed` notification); switching it back on
lists them again. Until the extension reports its switches, the last list this server saw (saved in `perms-<port>.json`)
applies; without one, nothing is hidden. Hidden tools appear under
`hiddenByPermissions` in the `browser_toolsets` listing. Calling one anyway returns an error result without
reaching the extension:

```text
Permission disabled in extension: network_requests (enable it from the extension popup). Tool har_export is hidden from the tool list while this switch is off; only the user can switch it back on, so ask the user instead of retrying.
```

When the tool's toolset is off as well, the message adds ` (its toolset "<id>" is off as well:
browser_toolsets {"enable":["<id>"]})`. The extension answers `Permission disabled in extension: <action>` by
itself when the server has not seen the switch change yet.

## Output cap

Every tool result goes through one cap: the text parts of a result may hold at most
`BROWSER_MCP_MAX_OUTPUT_CHARS` characters (default **40000**, minimum 1000; a value that is not a whole
number is ignored with a warning). Images, audio and embedded resources are not counted and pass unchanged.

When the text is longer, the server keeps the head, appends a note, and saves the **full** text to a private
file: one folder per server process in the OS temp folder, `browser-mcp-spill-<pid>-<random>` (mode `0700`),
file `<tool>-output.json` (when the text is JSON) or `<tool>-output.txt` (mode `0600`; a second spill of the
same tool becomes `<tool>-output-2.json` and so on). The folder is deleted when the server exits, and a later
server start deletes folders that a crashed process left behind for more than 24 hours. `dom_upload` and
`cdp_send` never upload a file from it. The note looks like this:

```text
[output truncated: 40000/183512 chars; full output saved to /tmp/browser-mcp-spill-4242-AbC123/history_search-output.json; narrow the request (a filter, limit or selector) to get less at once]
```

The last part is a hint: `use offset/maxChars to read the rest` for tools with an `offset` parameter
(`page_snapshot`, `page_text`, `page_html`), a tool's own hint where it has one, and otherwise the narrowing
hint above. If saving fails, the note says `saving the full output failed (<reason>)` instead.

**Sensitive results are never written to disk.** Text of the `cookies`, `storage`, `sessions` and `clipboard`
toolsets is cut but not saved, and the note says how to get the full data on purpose:

```text
[output truncated: 40000/91234 chars; the rest is not saved to disk (cookies data is sensitive); narrow it with domain, url or name, or write every cookie to a file of your choice with cookies_export {"savePath": "<absolute .json path>"}]
```

`session_state_save` and `cookies_export` are never cut: without `savePath` a bundle larger than the cap is
refused with an error that asks for `savePath` (an absolute `.json` path); with it the complete bundle is
written there and only a summary is returned. `session_state_load` and `cookies_import` read such a file back
with `filePath` ([tools.md](tools.md#tool-notes)).

Error results are capped the same way. Lower the cap to save context, raise it for clients with large windows:

```json
"env": { "BROWSER_MCP_MAX_OUTPUT_CHARS": "20000" }
```

## Paging large pages

`page_snapshot`, `page_text` and `page_html` never return a whole large page. They return a window of
`maxChars` characters (at most 500000) starting at `offset`, as two text blocks: first metadata
(`{tabId, offset, length, totalLength, truncated, nextOffset}`), then the raw text. Continue with
`offset = nextOffset` until `nextOffset` is `null`. The server sizes the window so that it plus its metadata
fits the output cap: at the default cap the default window is 39744 characters, and an explicit `maxChars`
above the cap is reduced (the metadata then carries a `note`).

`page_snapshot` windows end after a whole line, so a ref is never split, and refs stay the same across calls.
Only a single line longer than the window is cut inside it (never inside a surrogate pair). If the page changed
between two calls and `nextOffset` now falls inside a line, the window starts at the beginning of that line;
inside an over-long line it continues from there, so paging always moves forward.

Other size controls: `dom_query` `limit` (default 20, at most 500; the result reports `total` and
`returned`), `page_axtree` `maxNodes` / `depth`, `console_get` and `network_requests` `limit`, and
`page_snapshot` `compact`. Binary results are not capped but have their own limits: full-page screenshots
stop at `maxHeight`, and PDFs and audio recordings over 10 MiB are written to private temp files instead of
being returned inline; see [tools.md](tools.md#tool-notes).
