# Tool reference

The server registers **122 tools** in 22 toolsets, plus 4 resources and 4 prompts. Only the `core` toolset
(28 tools, marked **core** below) and the always-listed `meta` tools are advertised by default; the agent adds
more with `browser_toolsets`, or you choose them at start-up with `--toolsets` ([toolsets.md](toolsets.md)).

- [Conventions](#conventions)
- [Reference](#reference) (generated from the server)
- [Tool notes](#tool-notes)

## Conventions

- **`tabId`** comes from `tab_list`. Omitting it targets the focused tab of the last focused window; such a tab
  does not become a full agent tab ([extension.md](extension.md#agent-tabs-dialogs-and-console-capture)).
- **Selectors** accept plain CSS (also searched inside open shadow roots), `css=...`, `xpath=...`,
  `text=...` (case-insensitive substring) or `text="..."` (exact), a shadow-piercing chain `host >>> inner`,
  and snapshot refs from `page_snapshot` / `dom_query` (`e473012`, `ref=e473012` or `[ref=e473012]`). Refs belong
  to one page and frame and expire on navigation; an invalid selector fails with a clear error instead of
  matching nothing.
- **Hints:** every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`), shown below as *read-only*, *destructive*, *changes state*, *idempotent* and *open world*,
  so clients can ask before destructive calls such as `browser_close`, `tab_close`, deletions,
  `browsing_data_clear`, `clipboard_write`, tools that can write or replace a file (`tab_audio_record_stop`,
  `tab_audio_capture`, `perf_trace_stop`, `session_state_save`, `cookies_export`), `js_evaluate` and
  `cdp_send`.
- **Results** are JSON text unless noted (images, audio and PDFs come as MCP image / audio / resource blocks).
  Text above the [output cap](toolsets.md#output-cap) is cut, and the rest is saved to a private file that is
  removed when the server exits; cookie, storage, session and clipboard text is cut but never saved.
- **Cancellation:** cancelling an MCP call sends a cancel to the extension. `page_wait` (including its
  network-idle wait), `dom_type`, `network_response_body`, `perf_web_vitals` and `perf_trace_stop` stop at
  once; other commands run to completion and their result is discarded.
- **Timeouts:** each command carries its server-side timeout to the extension, so long waits (`page_wait`,
  slow `dom_type`, audio, traces) are not cut short by a fixed extension timeout. Some tools can run longer than
  a client's default request timeout ([clients.md](clients.md#long-running-tools-and-client-timeouts)).
- **Hidden tools:** a tool whose action is switched off in the popup is hidden; calling it anyway returns
  `Permission disabled in extension: <action> (enable it from the extension popup). Tool <name> is hidden from
  the tool list while this switch is off; ...` without reaching the extension (the extension answers
  `Permission disabled in extension: <action>` itself when the server has not seen the switch change yet). A
  tool of a toolset that is off returns `Tool <name> is not enabled: it belongs to the "<id>" toolset, which is
  off. Call browser_toolsets {"enable":["<id>"]} ...` ([toolsets.md](toolsets.md#tools-hidden-by-the-popup-switches),
  [extension.md](extension.md#permission-rules)).

## Reference

<!-- BEGIN GENERATED: tool reference (do not edit by hand) -->

Generated from the server's own `tools/list` (browser-mcp 0.3.5, every toolset enabled): **122 tools** in 22 toolsets, 28 of them in the default `core` toolset (marked **core**). Meta tools are always listed.

| Toolset | Tools | In core | Description |
|---|---:|---:|---|
| [`meta`](#toolset-meta) | 5 | 2 | Bridge status, browser launch, permission switches, toolsets (always listed) |
| [`tabs`](#toolset-tabs) | 22 | 8 | Tabs, windows, frames, tab groups, closing the browser |
| [`read`](#toolset-read) | 7 | 6 | Page: read (snapshot, text, HTML, queries, find, wait, accessibility tree) |
| [`interact`](#toolset-interact) | 11 | 9 | Page: interact (click, type, fill, select, hover, scroll, drag, keys, upload) |
| [`media`](#toolset-media) | 5 | 1 | Media (screenshot, PDF, tab audio) |
| [`console`](#toolset-console) | 2 | 1 | Console messages |
| [`network`](#toolset-network) | 7 | 0 | Network: observe (requests, response bodies, HAR, throttling, extra headers) |
| [`mock`](#toolset-mock) | 6 | 0 | Network: intercept (mocked routes) |
| [`downloads`](#toolset-downloads) | 5 | 0 | Downloads |
| [`bookmarks`](#toolset-bookmarks) | 4 | 0 | Bookmarks |
| [`cookies`](#toolset-cookies) | 7 | 0 | Cookies (read, write, import, export) |
| [`storage`](#toolset-storage) | 9 | 0 | Storage (localStorage, sessionStorage, IndexedDB) |
| [`sessions`](#toolset-sessions) | 4 | 0 | Sessions and saved page state |
| [`dialogs`](#toolset-dialogs) | 3 | 1 | JavaScript dialogs (alert, confirm, prompt, beforeunload) |
| [`power`](#toolset-power) | 2 | 0 | Power: arbitrary JavaScript and raw CDP commands |
| [`trusted`](#toolset-trusted) | 5 | 0 | Trusted input through CDP (real mouse and keyboard events) |
| [`clipboard`](#toolset-clipboard) | 2 | 0 | Clipboard |
| [`browsing_data`](#toolset-browsing-data) | 1 | 0 | Clearing browsing data |
| [`notifications`](#toolset-notifications) | 2 | 0 | Desktop notifications |
| [`system`](#toolset-system) | 3 | 0 | System: history, site permissions |
| [`emulation`](#toolset-emulation) | 6 | 0 | Emulation: viewport, color scheme and media, CPU, geolocation |
| [`performance`](#toolset-performance) | 4 | 0 | Performance: metrics, web vitals, traces |

<a id="toolset-meta"></a>

### `meta` (5)

Bridge status, browser launch, permission switches, toolsets (always listed).

#### `browser_status` — Browser status

**core** · read-only

Check whether the browser extension is connected and show bridge status (mode=primary|satellite, pid, peers=satellites sharing this bridge, trusted/rejected extension ids, last known disabled actions)

No parameters.

#### `browser_launch` — Launch browser

changes state, idempotent

Start the browser if needed and wait for the extension to connect. Browser choice follows BROWSER / sticky / running / OS-default order; use when browser_status shows disconnected.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `timeoutMs` | integer | no | 1..600000 | How long to wait for the extension (default 45000) |

#### `permissions_list` — List bridge permissions

read-only

Show permission categories with enabled/total counts and the disabled action list.

No parameters.

#### `permissions_set` — Disable bridge action

changes state, idempotent

Disable one bridge action (self-restriction, synced to the extension popup). Only disabling works over the bridge: enabled:true is rejected, re-enabling is only possible from the extension popup. Disabled actions fail with a clear error.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `action` | string | yes |  | Bridge action name (e.g. dom_click) |
| `enabled` | boolean | yes |  | Must be false (disable). true is rejected: re-enable from the extension popup. |

#### `browser_toolsets` — Toolsets

**core** · changes state, idempotent

List the toolsets (groups of tools) and which are enabled, or enable / disable toolsets at runtime. Only "core" is listed by default (start-up: --toolsets / BROWSER_MCP_TOOLSETS). Call without arguments to see every toolset with its tools, then e.g. {"enable":["network"]}; "all" enables everything. Disabling a category also hides its tools from core / all. Tools switched off in the extension popup (or needing a switch that is off, e.g. har_export needs network_requests) stay hidden whatever is enabled.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `enable` | "core" \| "all" \| "meta" \| "tabs" \| "read" \| "interact" \| "media" \| "console" \| "network" \| "mock" \| "downloads" \| "bookmarks" \| "cookies" \| "storage" \| "sessions" \| "dialogs" \| "power" \| "trusted" \| "clipboard" \| "browsing_data" \| "notifications" \| "system" \| "emulation" \| "performance"[] | no |  | Toolsets to add: core, all, or a category id (case-insensitive) |
| `disable` | "core" \| "all" \| "meta" \| "tabs" \| "read" \| "interact" \| "media" \| "console" \| "network" \| "mock" \| "downloads" \| "bookmarks" \| "cookies" \| "storage" \| "sessions" \| "dialogs" \| "power" \| "trusted" \| "clipboard" \| "browsing_data" \| "notifications" \| "system" \| "emulation" \| "performance"[] | no |  | Toolsets to remove (applied after enable) |

<a id="toolset-tabs"></a>

### `tabs` (22)

Tabs, windows, frames, tab groups, closing the browser.

#### `browser_close` — Close browser

destructive

Close the browser. Graceful mode (default) closes windows via the extension. force:true kills only the browser that hosts the extension (refused when that browser is unknown) and also works when the extension is silent. Respects the browser_close popup switch (last known state when the extension does not answer).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `force` | boolean | no |  | true: kill the process of the browser hosting the extension (also works when the extension is silent) |

#### `tab_list` — List tabs

**core** · read-only

List all open tabs with id, title, URL and active state. Call first to discover tab IDs for other tools.

No parameters.

#### `tab_create` — Open tab

**core** · changes state, open world

Open a new tab, optionally at a URL. Use active:false to keep it in the background. Returns the new tab ID.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `url` | string | no |  | URL to open (default about:blank) |
| `active` | boolean | no |  | Bring to front (default true) |

#### `tab_duplicate` — Duplicate tab

changes state, open world

Duplicate an existing tab into a new tab

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_close` — Close tab

**core** · destructive

Close a tab (default: active). Closing the last tab of the last window quits the browser and needs the browser_close permission.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_activate` — Activate tab

**core** · changes state, idempotent

Bring a tab to the front and focus its window.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | yes |  | Tab ID to activate (see tab_list) |

#### `tab_navigate` — Navigate tab

**core** · changes state, open world

Navigate a tab to a URL. Navigation destroys page context: re-query refs and re-wait afterwards.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `url` | string | yes |  | Target URL |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_reload` — Reload tab

**core** · changes state, open world

Reload a tab (default: active). Page context resets: re-query refs afterwards.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_back` — Go back

**core** · changes state, open world

Go back in tab history.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_forward` — Go forward

**core** · changes state, open world

Go forward in tab history.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_pin` — Pin tab

changes state

Pin/unpin a tab (omit to toggle).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `pinned` | boolean | no |  | Omit to toggle |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_mute` — Mute tab

changes state

Mute/unmute a tab (omit to toggle).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `muted` | boolean | no |  | Omit to toggle |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `window_list` — List windows

read-only

List windows with focus state and their tabs.

No parameters.

#### `window_create` — Open window

changes state, open world

Open a new window, optionally at a URL.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `url` | string | no |  | Initial URL (omit for blank page) |

#### `window_focus` — Focus window

changes state, idempotent

Focus a window by ID.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `windowId` | integer | yes |  | Window ID from window_list |

#### `frame_list` — List frames

read-only

List frames/iframes of a tab as { frameId, parentFrameId, url } (frameId 0 = main frame). Use frameId or a URL substring with frame_focus.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `frame_focus` — Target frame

changes state, idempotent

Route later DOM/page commands for the tab to one frame, chosen by frameId (exact) or URL substring. Returns the resolved { frameId, url }. Cleared by frame_clear or a main-frame navigation.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `frameId` | integer | no | &gt;= 0 | Exact frameId from frame_list (preferred when several frames share a URL) |
| `frameUrl` | string | no |  | URL substring of the target frame (from frame_list) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `frame_clear` — Clear frame target

changes state, idempotent

Clear iframe targeting (commands go to the main frame again).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `tab_group_create` — Create tab group

changes state

Group one or more tabs together with an optional title, color, and collapsed state

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabIds` | integer[] | yes |  | Array of tab IDs to add to the new group |
| `title` | string | no |  | Group title / label |
| `color` | "grey" \| "blue" \| "red" \| "yellow" \| "green" \| "pink" \| "purple" \| "cyan" \| "orange" | no |  | Color of the tab group |
| `collapsed` | boolean | no |  | Whether the tab group is collapsed |

#### `tab_group_list` — List tab groups

read-only

List all tab groups with their member tabs, colors, and collapsed states

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `windowId` | integer | no |  | Filter by window ID |
| `title` | string | no |  | Filter by group title (case-insensitive substring) |

#### `tab_group_update` — Update tab group

changes state, idempotent

Update a tab group's title, color, or collapsed state

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `groupId` | integer | yes |  | Group ID to update |
| `title` | string | no |  | New title for the group |
| `color` | "grey" \| "blue" \| "red" \| "yellow" \| "green" \| "pink" \| "purple" \| "cyan" \| "orange" | no |  | New color for the group |
| `collapsed` | boolean | no |  | Whether to collapse or expand the group |

#### `tab_group_ungroup` — Ungroup tabs

changes state, idempotent

Remove tabs from their tab group

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabIds` | integer[] | yes |  | Array of tab IDs to ungroup |

<a id="toolset-read"></a>

### `read` (7)

Page: read (snapshot, text, HTML, queries, find, wait, accessibility tree).

#### `page_snapshot` — Page snapshot

**core** · read-only, open world

Element tree with refs (e.g. [ref=e473012]; pass e473012 as a selector). Start here before interacting; refs expire on navigation. Lines show tag, key attributes, short text and live state: value= (typed input/textarea value; current= when it differs from the value attribute), filled=true|false (passwords, value never shown), checked[=mixed], selected= (chosen options) or selected, options= (a select's choices), disabled, readonly, required, expanded=, pressed=, value= on sliders/spinbuttons, contenteditable, (hidden). iframes are (frame) markers: read them with frame_list + frame_focus (toolset tabs). A long tree comes in windows of whole lines (default 39744 chars): the first block gives offset, length, totalLength, truncated and nextOffset; call again with offset=nextOffset for the next lines (refs stay the same across calls).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `compact` | boolean | no |  | true (default): interactive elements, ARIA widgets, editable hosts, iframes, forms and h1-h3 (max 400 lines); false: also text blocks and containers (max 1000) |
| `offset` | integer | no | &gt;= 0 | Start index in characters (default 0); pass nextOffset from the previous call to continue |
| `maxChars` | integer | no | 1..500000 | Window size in characters (default 39744, max 500000; never more than the server's output cap allows) |

#### `page_html` — Page HTML

**core** · read-only, open world

Page HTML source (documentElement.outerHTML), one window at a time: at most maxChars characters (default 39744) starting at offset. The first block gives offset, length, totalLength, truncated and nextOffset (null at the end); call again with offset=nextOffset for the rest. Prefer page_snapshot for structure.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `offset` | integer | no | &gt;= 0 | Start index in characters (default 0); pass nextOffset from the previous call to continue |
| `maxChars` | integer | no | 1..500000 | Window size in characters (default 39744, max 500000; never more than the server's output cap allows) |

#### `page_text` — Page text

**core** · read-only, open world

Visible page text (innerText), one window at a time: at most maxChars characters (default 39744) starting at offset. The first block gives offset, length, totalLength, truncated and nextOffset (null at the end); call again with offset=nextOffset for the rest. Best for reading content.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `offset` | integer | no | &gt;= 0 | Start index in characters (default 0); pass nextOffset from the previous call to continue |
| `maxChars` | integer | no | 1..500000 | Window size in characters (default 39744, max 500000; never more than the server's output cap allows) |

#### `dom_query` — Query elements

**core** · read-only, open world

Find elements by CSS/XPath/text/ref. Returns {total, returned, items:[{ref, tag, text, x, y, w, h}]}: total counts every match, items holds the first limit of them (text is whitespace-normalised, at most 200 chars; x/y/w/h in viewport px). Use the refs as selectors for clicks and typing.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `limit` | integer | no | 1..500 | Max items returned (default 20, max 500) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `page_find` — Find text on page

**core** · changes state, open world

Search page text (case-insensitive) and scroll the first match into view.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `text` | string | yes |  | Text to find |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `page_wait` — Wait for page

**core** · read-only, open world

Wait until every given condition holds: an element (selector), page text, URL substring/pattern, readyState, and/or network idle (networkIdle: at most maxInflight requests in flight for idleMs, e.g. after a click that loads data). With no condition it just waits timeoutMs. Fails with a timeout error after timeoutMs (default 15000).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | no |  | Selector to wait for; omit for duration only |
| `timeoutMs` | integer | no | 1..600000 | Maximum wait time in ms (default 15000, max 600000) |
| `text` | string | no |  | Page text to wait for |
| `url` | string | no |  | URL substring to wait for (e.g. after redirects) |
| `urlPattern` | string | no |  | URL regex pattern to wait for |
| `readyState` | "interactive" \| "complete" | no |  | Wait for document readyState ('interactive' or 'complete') |
| `networkIdle` | boolean | no |  | Wait for the tab's network to go quiet (requests tracked by the extension; default true when idleMs or maxInflight is given) |
| `idleMs` | integer | no | 0..600000 | networkIdle: how long the network must stay quiet, in ms (default 500) |
| `maxInflight` | integer | no | 0..1000 | networkIdle: requests that may still be in flight (default 0; 2 tolerates long-polling and analytics) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `page_axtree` — Accessibility tree

read-only, open world

Accessibility tree nodes (roles, names, values) for accessibility audits. Returns {count, truncated, nodes}; maxNodes caps the nodes (default 800) and depth limits how deep the tree is read.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `maxNodes` | integer | no | 1..5000 | Max nodes returned (default 800, max 5000); truncated:true when cut |
| `depth` | integer | no | 1..1000 | Read only the top N levels of the tree (default: all) |

<a id="toolset-interact"></a>

### `interact` (11)

Page: interact (click, type, fill, select, hover, scroll, drag, keys, upload).

#### `dom_click` — Click element

**core** · changes state, open world

Click an element (synthetic mouse events). For bot-protected sites use trusted_click instead (toolset trusted).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `button` | "left" \| "right" \| "middle" | no |  | Mouse button (default left) |
| `doubleClick` | boolean | no |  | Double click (two clicks + dblclick) |

#### `dom_type` — Type text

**core** · changes state, open world

Type into an input, textarea or contenteditable with real per-character key events (keydown/keypress/beforeinput/input/keyup; works with React/Vue controlled inputs). Inserts at the caret if the element has focus, else at the end; keeps existing text unless clearFirst. Honours maxlength; single-line inputs skip newlines. In a textarea or contenteditable a newline is a line break typed as Shift+Enter, so chat boxes do not send early; pressEnter (or keyboard_press) presses a real Enter. Returns value (final value, first 200 chars; never for passwords) and a warning when keys were cancelled, clearFirst failed or maxlength cut text. For many fields use dom_fill.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `text` | string | yes |  | Text to type |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `clearFirst` | boolean | no |  | Clear existing content first (select-all + delete, with input events) |
| `pressEnter` | boolean | no |  | Press Enter after typing |
| `delayMs` | integer | no | 0..5000 | Extra per-keystroke delay in ms (for bot-protected sites; default 0) |

#### `dom_fill` — Fill form fields

**core** · changes state, open world

Fill many form fields at once (selector -&gt; value map). Faster than repeated dom_type.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `fields` | record&lt;string, string&gt; | yes |  | selector -&gt; value map |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `submit` | boolean | no |  | Submit the enclosing form after filling |

#### `dom_select` — Select option

**core** · changes state, open world

Choose a native &lt;select&gt; option by value or visible label (fires input/change). For custom dropdowns click the trigger and the option.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `value` | string | yes |  | Option value or visible label to select |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `dom_check` — Set checkbox

**core** · changes state, open world

Set or toggle a checkbox/radio/switch by clicking it like a user (click, input and change fire).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `checked` | boolean | no |  | Omit to toggle |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `dom_hover` — Hover element

**core** · changes state, open world

Hover an element (opens menus/tooltips). For real pointer input use the trusted_\* tools (toolset trusted).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `dom_focus` — Focus element

changes state, open world

Focus an element (inputs, buttons).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `dom_scroll` — Scroll

**core** · changes state, open world

Scroll the page or an element into view.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | no |  | Omit to scroll the page |
| `direction` | "up" \| "down" \| "top" \| "bottom" | no |  | Scroll direction (default down) |
| `pixels` | integer | no | 1..100000 | Pixels per step (default 500) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `dom_drag` — Drag and drop

changes state, open world

Drag from one element to another (synthetic mouse + HTML5 drag events).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `from` | string | yes |  | Source selector/ref |
| `to` | string | yes |  | Target selector/ref |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `keyboard_press` — Press key

**core** · changes state, open world

Dispatch synthetic key events to the focused element (combos like Ctrl+K are parsed; page key handlers see them). Only Enter, Tab, Space, Backspace/Delete, typing and select-all defaults are emulated; native shortcuts, clipboard, caret movement and scrolling need trusted_key (toolset trusted).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `key` | string | yes |  | Enter, Tab, Escape, ArrowDown, a, A, Ctrl+C ... |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `dom_upload` — Upload files

**core** · changes state, open world

Upload local files into an &lt;input type=file&gt; via CDP (fires input/change). Paths must be absolute, regular files of at most 100 MiB, inside an allowed folder: temp, \~/Downloads or the server's working directory (unless that is a drive root or holds the home folder), or the folders in BROWSER_MCP_UPLOAD_DIRS (set by the user; "\*" = any). Dot-segment paths (.ssh, .env ...), key/credential files (id_rsa\*, \*.pem, \*.key, \*.p12, \*.pfx, \*.ppk, \*.kdbx, credentials\* ...) and this server's spilled output (browser-mcp-spill-\* folders) are always refused; the error names the broken rule.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | selector/ref for the file input |
| `filePaths` | string[] | yes | 1..100 items | Absolute local file paths to upload |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-media"></a>

### `media` (5)

Media (screenshot, PDF, tab audio).

#### `page_screenshot` — Screenshot

**core** · read-only, open world

Capture a screenshot of the visible viewport, full page, or a specific element as an image

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `fullPage` | boolean | no |  | Whether to capture the entire scrollable page |
| `selector` | string | no |  | Omit for viewport: CSS selector or ref of the element to capture |
| `scale` | number | no | &gt; 0, &lt;= 2 | Capture scale for element shots (default 1, max 2) |
| `maxHeight` | integer | no | 256..32768 | fullPage only: maximum captured height in CSS px (default 16384). Taller pages are cut and reported with truncated:true. |

#### `page_pdf` — Save page as PDF

changes state

Render the tab to PDF. Returned as an embedded application/pdf resource, or written to savePath. Slower; for visuals prefer page_screenshot.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `savePath` | string | no |  | Absolute .pdf path to write the file to (an existing file is never overwritten). Omit to return the PDF as an embedded resource. |

#### `tab_audio_record_start` — Start audio recording

changes state

Start capturing/recording audio from a browser tab (e.g. while Spotify, YouTube, or web audio plays). Does not block; use tab_audio_record_stop to stop and collect the audio.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `passthrough` | boolean | no |  | Whether to keep playing audio through speakers while recording (default true) |

#### `tab_audio_record_stop` — Stop audio recording

destructive

Stop an ongoing tab audio recording and return it as an MCP audio block or save it to disk (.webm natively; .mp3 .wav .ogg .opus .m4a .aac .flac via ffmpeg). Omit tabId to stop the only active recording.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID of the recording. Omit when exactly one recording is active. |
| `savePath` | string | no |  | Absolute file path to save the recording (.webm .ogg .opus .mp3 .wav .m4a .aac .flac; formats other than .webm need ffmpeg via FFMPEG_PATH or PATH). An existing file is only replaced with overwrite:true. |
| `overwrite` | boolean | no |  | Replace an existing file at savePath (default false) |

#### `tab_audio_capture` — Record tab audio

destructive

Record tab audio for a specified duration in seconds (convenience tool for songs, clips, etc.). Starts recording, waits for the duration (with progress notifications; cancelling stops early), stops the same tab, and saves or returns the audio.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `durationSeconds` | number | yes | &gt; 0, &lt;= 3600 | Recording duration in seconds (e.g. 30, 252) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `savePath` | string | no |  | Absolute file path to save the recording (.webm .ogg .opus .mp3 .wav .m4a .aac .flac; formats other than .webm need ffmpeg via FFMPEG_PATH or PATH). An existing file is only replaced with overwrite:true. |
| `passthrough` | boolean | no |  | Whether to keep playing audio through speakers while recording (default true) |
| `overwrite` | boolean | no |  | Replace an existing file at savePath (default false) |

<a id="toolset-console"></a>

### `console` (2)

Console messages.

#### `console_get` — Read console

**core** · read-only

Read captured page console logs (filter by level and tab). Falls back to this server's local event buffer, with a warning, when the extension is unreachable.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `level` | "all" \| "log" \| "info" \| "warn" \| "error" \| "debug" | no |  | Log level filter (default all) |
| `limit` | integer | no | 1..5000 | Max entries from the tail (default 200) |
| `tabId` | integer | no |  | Only entries from this tab (see tab_list). Omit for all tabs. |

#### `console_clear` — Clear console

destructive, idempotent

Clear captured console logs (extension + local buffer), for every tab or only one.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Only clear this tab's entries (see tab_list). Omit to clear every tab. |

<a id="toolset-network"></a>

### `network` (7)

Network: observe (requests, response bodies, HAR, throttling, extra headers).

#### `network_requests` — List network requests

read-only

List captured HTTP network requests with optional filters. Falls back to this server's local event buffer, with a warning, when the extension is unreachable.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `filter` | string | no |  | URL substring filter |
| `type` | string | no |  | Resource type: document, xhr, fetch, image, script... |
| `failedOnly` | boolean | no |  | Only return failed requests (status &gt;= 400 or network error) |
| `minStatus` | integer | no | 100..599 | Minimum HTTP status code (e.g. 400 for errors) |
| `limit` | integer | no | 1..5000 | Max number of requests to return (default 200) |
| `tabId` | integer | no |  | Only entries from this tab (see tab_list). Omit for all tabs. |

#### `network_clear` — Clear network log

destructive, idempotent

Clear captured network logs (extension + local buffer).

No parameters.

#### `network_response_body` — Fetch response body

read-only, open world

Re-fetch a recorded GET request's body in page context (webRequest exposes no bodies; the request is sent again, non-GET entries are refused). For exact bodies use network_mock_start + network_bodies. Needs a requestId from network_requests.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `requestId` | string | yes |  | requestId from network_requests |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_throttle` — Throttle network

changes state, idempotent

Emulate network conditions (slow 3G, fast 3G, offline, custom) via CDP. The override stays active (debugger kept attached) until profile 'online' clears it.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `profile` | "online" \| "slow3g" \| "fast3g" \| "offline" \| "custom" | yes |  | Throttling profile ('online' removes throttling) |
| `latency` | number | no | 0..600000 | Custom latency in ms (only for profile: custom) |
| `downloadThroughput` | number | no | &gt;= -1 | Custom download throughput in bytes/s, -1 = unlimited (only for profile: custom) |
| `uploadThroughput` | number | no | &gt;= -1 | Custom upload throughput in bytes/s, -1 = unlimited (only for profile: custom) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_set_headers` — Set request headers

changes state, idempotent

Set extra HTTP request headers attached to all requests in the tab. They stay active (debugger kept attached) until cleared by passing an empty object {}.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `headers` | record&lt;string, string&gt; | yes |  | Key-value header dictionary (e.g. Authorization, User-Agent); {} clears |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_bodies` — Captured request bodies

read-only

Spy-captured request/response bodies (POST data, response snippets). Requires network_mock_start first (no routes needed).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `filter` | string | no |  | URL substring filter |
| `kind` | "request" \| "response" | no |  | Only requests (with POST bodies) or only responses |
| `limit` | integer | no | 1..1000 | Max entries (default 50) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `har_export` — Export HAR

read-only

Export captured traffic for a tab as HAR 1.2 (headers included, no bodies).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `limit` | integer | no | 1..5000 | Max entries (default 300) |

<a id="toolset-mock"></a>

### `mock` (6)

Network: intercept (mocked routes).

#### `network_mock_start` — Start interception

changes state, idempotent

Attach the debugger and start intercepting requests. Spy mode: without routes, unmatched traffic passes through while bodies are recorded.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_mock_stop` — Stop interception

changes state, idempotent

End interception for the tab (the debugger detaches once no other override, e.g. throttling or geolocation, still needs it).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_mock_route` — Add mock route

changes state

Add a block/fulfill/delay rule for matching URLs. Requires network_mock_start first.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `pattern` | string | yes |  | URL pattern, \* wildcard (e.g. \*ads\* or https://api.example.com/\*) |
| `action` | "block" \| "fulfill" \| "delay" | yes |  | block: drop, fulfill: return a mock response, delay: hold then pass through |
| `status` | integer | no | 100..599 | HTTP code for fulfill (default 200) |
| `body` | string | no |  | Body for fulfill |
| `contentType` | string | no |  | Content-Type for fulfill (default application/json) |
| `delayMs` | integer | no | 0..600000 | Hold time in ms for delay |
| `headers` | object[] | no |  | fulfill: added to the mock response headers. delay: merged into the original request headers (a same-name header is replaced, all others are kept). |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_mock_list` — List mock routes

read-only

List active mock routes and session state.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_mock_remove` — Remove mock route

changes state, idempotent

Remove one mock route by ID.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `routeId` | string | yes |  | Route ID from network_mock_list |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `network_mock_clear` — Clear mock routes

changes state, idempotent

Remove all mock routes (keeps the interception session attached).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-downloads"></a>

### `downloads` (5)

Downloads.

#### `downloads_list` — List downloads

read-only

List recent downloads with state, progress and errors.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `limit` | integer | no | 1..1000 | Max entries (default 50) |

#### `downloads_pause` — Pause download

changes state, idempotent

Pause an in-progress download.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `id` | integer | yes |  | Download ID from downloads_list |

#### `downloads_resume` — Resume download

changes state, idempotent

Resume a paused download.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `id` | integer | yes |  | Download ID from downloads_list |

#### `downloads_cancel` — Cancel download

destructive, idempotent

Cancel an in-progress download.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `id` | integer | yes |  | Download ID from downloads_list |

#### `downloads_erase` — Erase download from history

destructive, idempotent

Remove a finished download from history (keeps the file).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `id` | integer | yes |  | Download ID from downloads_list |

<a id="toolset-bookmarks"></a>

### `bookmarks` (4)

Bookmarks.

#### `bookmarks_search` — Search bookmarks

read-only

Search bookmarks by title/URL.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `query` | string | yes |  | Search text |

#### `bookmarks_list` — List bookmarks

read-only

List bookmark children of a folder.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `parentId` | string | no |  | Omit for the bookmarks bar |

#### `bookmarks_add` — Add bookmark

changes state

Create a bookmark (returns its ID).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `title` | string | yes |  | Bookmark title |
| `url` | string | yes |  | Bookmark URL |
| `parentId` | string | no |  | Parent folder ID (omit for default location) |

#### `bookmarks_remove` — Remove bookmark

destructive, idempotent

Delete a bookmark by ID.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `id` | string | yes |  | Bookmark ID |

<a id="toolset-cookies"></a>

### `cookies` (7)

Cookies (read, write, import, export).

#### `cookies_list` — List cookies

read-only

List cookies filtered by domain, url, or name

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `domain` | string | no |  | Domain filter |
| `url` | string | no |  | URL filter (e.g. https://example.com) |
| `name` | string | no |  | Cookie name filter |

#### `cookies_get` — Get cookie

read-only

Get a specific cookie by URL and name

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `url` | string | yes |  | URL of the cookie (e.g. https://example.com) |
| `name` | string | yes |  | Name of the cookie |

#### `cookies_set` — Set cookie

destructive, idempotent

Set or update a browser cookie

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `name` | string | yes |  | Cookie name |
| `value` | string | yes |  | Cookie value |
| `url` | string | yes |  | URL the cookie belongs to (e.g. https://example.com) |
| `domain` | string | no |  | Cookie domain |
| `path` | string | no |  | Cookie path (defaults to /) |
| `secure` | boolean | no |  | Whether the cookie is secure-only |
| `httpOnly` | boolean | no |  | Whether the cookie is HTTP-only |
| `sameSite` | "no_restriction" \| "lax" \| "strict" \| "unspecified" | no |  | SameSite attribute ('unspecified' = no attribute) |
| `expirationDate` | number | no | &gt; 0 | Unix timestamp (seconds) for cookie expiry; omit for a session cookie |

#### `cookies_delete` — Delete cookie

destructive, idempotent

Delete a specific cookie by URL and name

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `url` | string | yes |  | URL of the cookie (e.g. https://example.com) |
| `name` | string | yes |  | Name of the cookie to remove |

#### `cookies_clear` — Clear cookies

destructive, idempotent

Delete all cookies for a domain or URL (irreversible). Clearing every cookie in the browser requires an explicit all:true.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `domain` | string | no |  | Domain to clear cookies for |
| `url` | string | no |  | URL to clear cookies for |
| `all` | boolean | no |  | true: delete EVERY cookie of every site (only when no domain/url is given) |

#### `cookies_export` — Export cookies

destructive, idempotent

Export all cookies for a domain or URL as a portable JSON array ({count, cookies}). With savePath the complete export is written to that .json file and only the count is returned (import it with cookies_import {filePath}); without it the export is returned inline, and one too large for the output cap is refused (never cut): pass savePath then.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `domain` | string | no |  | Domain to export cookies from |
| `url` | string | no |  | URL to export cookies from |
| `savePath` | string | no |  | Absolute .json path to write the complete export to (it holds cookie values: keep it private). An existing file is only replaced with overwrite:true. |
| `overwrite` | boolean | no |  | Replace an existing file at savePath (default false) |

#### `cookies_import` — Import cookies

destructive, idempotent

Import cookies into the browser: an array of cookie objects, or filePath of a cookies_export file written with savePath (exactly one of the two).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `cookies` | object[] | no |  | Array of cookie objects to set (cookies_export output is accepted as-is) |
| `filePath` | string | no |  | Absolute path of a .json file written by cookies_export with savePath (or holding a cookie array) |

<a id="toolset-storage"></a>

### `storage` (9)

Storage (localStorage, sessionStorage, IndexedDB).

#### `storage_get` — Read web storage

read-only, open world

Read all localStorage/sessionStorage entries of the page (values over 2000 chars truncated unless full:true).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `area` | "local" \| "session" | no |  | Storage area (default local) |
| `full` | boolean | no |  | true: return complete values (no 2000-char display truncation) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `storage_set` — Write web storage

destructive, idempotent

Write one storage entry (string values only).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `key` | string | yes |  | Storage key |
| `value` | string | yes |  | String value to store |
| `area` | "local" \| "session" | no |  | Storage area (default local) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `idb_list` — List IndexedDB databases

read-only, open world

List IndexedDB databases on the page (name + version).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `idb_stores` — List IndexedDB stores

read-only, open world

List object stores of an IndexedDB database.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `db` | string | yes |  | Database name (see idb_list) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `idb_read` — Read IndexedDB rows

read-only, open world

Read IndexedDB rows (values truncated for AI readability).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `db` | string | yes |  | Database name (see idb_list) |
| `store` | string | yes |  | Object store name (see idb_stores) |
| `limit` | integer | no | 1..1000 | Max rows when reading all (default 50, max 1000) |
| `key` | any | no |  | Omit to read all (up to limit) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `idb_count` — Count IndexedDB rows

read-only, open world

Count rows in an IndexedDB object store.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `db` | string | yes |  | Database name (see idb_list) |
| `store` | string | yes |  | Object store name (see idb_stores) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `idb_put` — Write IndexedDB row

destructive

Insert or update an IndexedDB row (returns the key).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `db` | string | yes |  | Database name (see idb_list) |
| `store` | string | yes |  | Object store name (see idb_stores) |
| `value` | any | yes |  | Row value to store |
| `key` | any | no |  | Key (omit for auto-keyed stores) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `idb_delete` — Delete IndexedDB row

destructive, idempotent

Delete one IndexedDB row by key.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `db` | string | yes |  | Database name (see idb_list) |
| `store` | string | yes |  | Object store name (see idb_stores) |
| `key` | any | yes |  | Key of the row to delete |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `idb_clear` — Clear IndexedDB store

destructive, idempotent

Delete ALL rows in an IndexedDB object store (destructive).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `db` | string | yes |  | Database name (see idb_list) |
| `store` | string | yes |  | Object store name (see idb_stores) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-sessions"></a>

### `sessions` (4)

Sessions and saved page state.

#### `sessions_recently_closed` — Recently closed tabs

read-only

List recently closed tabs and windows

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `maxResults` | integer | no | 1..25 | Maximum number of entries to return (default 25, max 25) |

#### `sessions_restore` — Restore closed tab

changes state, open world

Restore a recently closed tab or window by its session ID (or the most recent if omitted)

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `sessionId` | string | no |  | Session ID from sessions_recently_closed. Omit for the most recently closed. |

#### `session_state_save` — Save session state

destructive, idempotent

Capture an entire session profile (cookies + localStorage + sessionStorage) of the tab's site. With savePath the complete bundle is written to that .json file and only a summary is returned (restore it with session_state_load {filePath}); without it the bundle is returned inline, and a bundle too large for the output cap is refused (never cut): pass savePath then.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `savePath` | string | no |  | Absolute .json path to write the complete bundle to (it holds session cookies: keep it private). An existing file is only replaced with overwrite:true. |
| `overwrite` | boolean | no |  | Replace an existing file at savePath (default false) |

#### `session_state_load` — Load session state

destructive, idempotent

Restore an entire session profile (cookies + localStorage + sessionStorage) from a saved bundle: the state object from session_state_save, or filePath of a bundle written with savePath (exactly one of the two). Storage is only written when the tab shows the bundle's origin.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `state` | record&lt;string, any&gt; | no |  | Saved session state object from session_state_save |
| `filePath` | string | no |  | Absolute path of a .json bundle written by session_state_save with savePath |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-dialogs"></a>

### `dialogs` (3)

JavaScript dialogs (alert, confirm, prompt, beforeunload).

#### `dialog_policy` — Set dialog policy

**core** · changes state, idempotent

Set auto-handling for JS dialogs: alert is swallowed, confirm/prompt auto-answered.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `accept` | boolean | no |  | Auto-accept confirm/prompt |
| `promptText` | string | no |  | Response text for prompt |
| `blockUnload` | boolean | no |  | true: suppress beforeunload |

#### `dialog_get` — List dialogs

read-only

List captured dialogs (alert/confirm/prompt) with messages and responses. Capture is async: poll briefly after triggering.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `limit` | integer | no | 1..1000 | Max entries (default 50) |

#### `dialog_clear` — Clear dialog history

destructive, idempotent

Clear captured dialog history.

No parameters.

<a id="toolset-power"></a>

### `power` (2)

Power: arbitrary JavaScript and raw CDP commands.

#### `js_evaluate` — Run JavaScript

destructive, open world

Run JavaScript in the page via CDP (bypasses page CSP). Supports `return` statements and top-level await (with awaitPromise). Values must be JSON-serializable.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `expression` | string | yes |  | JS to run: bare expression (2+2) or statements with return. Top-level await needs awaitPromise:true. |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `awaitPromise` | boolean | no |  | Await promises/top-level await before returning |

#### `cdp_send` — Raw CDP command

destructive, open world

Send a raw CDP command to the tab (power tool). Prefer a typed tool when one exists; tab-scoped domains only. File lists of DOM.setFileInputFiles (files) and Input.dispatchDragEvent (data.files) pass dom_upload's path rules.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `method` | string | yes |  | E.g. Network.enable, Page.printToPDF, Runtime.evaluate |
| `params` | record&lt;string, any&gt; | no |  | Method params object (default {}) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-trusted"></a>

### `trusted` (5)

Trusted input through CDP (real mouse and keyboard events).

#### `trusted_click` — Trusted click

changes state, open world

Real OS-level click via CDP Input (bypasses bot detection). Scrolls the target into view first (every selector form works, focused frame included).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `button` | "left" \| "right" \| "middle" | no |  | Mouse button (default left) |
| `doubleClick` | boolean | no |  | Double-click instead of single click |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `trusted_type` — Trusted typing

changes state, open world

Real keystrokes via CDP Input.insertText (bypasses bot detection). The target is resolved and focused first.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `selector` | string | yes |  | CSS selector (also searches open shadow roots; css=... prefix optional), "host &gt;&gt;&gt; inner" (shadow-piercing chain), xpath=..., text=... (substring) / text="..." (exact), or a snapshot ref (e473012 / ref=e473012) |
| `text` | string | yes |  | Text to type |
| `clearFirst` | boolean | no |  | Clear existing content first |
| `pressEnter` | boolean | no |  | Press Enter after typing |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `trusted_key` — Trusted key press

changes state, open world

Press a key as trusted CDP input (works without focus tricks).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `key` | string | yes |  | Enter, Tab, Escape, Backspace, Delete, Arrows, Home, End, PageUp/Down, or a single character |
| `modifiers` | integer | no | 0..15 | Bitmask: alt=1, ctrl=2, meta=4, shift=8 |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `trusted_scroll` — Trusted scroll

changes state, open world

Trusted wheel scroll at a viewport point (defaults to center).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `x` | number | no |  | Omit for viewport center |
| `y` | number | no |  | Omit for viewport center |
| `deltaX` | number | no |  | Horizontal pixels (default 0) |
| `deltaY` | number | no |  | Pixels, negative scrolls up (default 500) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `trusted_drag` — Trusted drag

changes state, open world

Trusted drag between two elements via CDP mouse events (bypasses bot detection).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `from` | string | yes |  | Source selector/ref |
| `to` | string | yes |  | Target selector/ref |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-clipboard"></a>

### `clipboard` (2)

Clipboard.

#### `clipboard_read` — Read clipboard

read-only

Read current text content from the system/browser clipboard

No parameters.

#### `clipboard_write` — Write clipboard

destructive, idempotent

Copy text to the system/browser clipboard

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `text` | string | yes |  | Text string to write to clipboard |

<a id="toolset-browsing-data"></a>

### `browsing_data` (1)

Clearing browsing data.

#### `browsing_data_clear` — Clear browsing data

destructive, idempotent

Clear browser data for every site (irreversible): cache, cookies, history, storage, downloads, form data, passwords. Pass explicit types, or all:true for the common session-data set.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `types` | "appcache" \| "cache" \| "cacheStorage" \| "cookies" \| "downloads" \| "fileSystems" \| "formData" \| "history" \| "indexedDB" \| "localStorage" \| "passwords" \| "serviceWorkers" \| "webSQL"[] | no |  | Types of browsing data to clear (required unless all:true) |
| `all` | boolean | no |  | true without types: clear the common session data (cache, cookies, formData, history, localStorage, indexedDB, serviceWorkers) |
| `since` | number | no | &gt;= 0 | Milliseconds since epoch to clear data since (0 = all time, default) |

<a id="toolset-notifications"></a>

### `notifications` (2)

Desktop notifications.

#### `notification_create` — Show notification

changes state

Display a native desktop notification to the user

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `title` | string | yes |  | Notification title |
| `message` | string | yes |  | Main notification message / body text |
| `contextMessage` | string | no |  | Small context label (defaults to 'MCP Agent') |
| `priority` | integer | no | -2..2 | Priority from -2 to 2 (default 1) |

#### `notification_clear` — Dismiss notification

changes state, idempotent

Dismiss / clear a previously created desktop notification

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `id` | string | yes |  | Notification ID returned from notification_create |

<a id="toolset-system"></a>

### `system` (3)

System: history, site permissions.

#### `history_search` — Search history

read-only

Search browser history by query text (all of history by default, not only the last 24 hours).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `query` | string | yes |  | Search text (empty string matches every page) |
| `limit` | integer | no | 1..10000 | Max results (default 20) |
| `maxResults` | integer | no | 1..10000 | Alias of limit (Chrome API name); wins when both are given |
| `startTime` | number | no | &gt;= 0 | Only visits at or after this time (ms since epoch). Default 0 = all history (Chrome's own default would be the last 24 hours). |
| `endTime` | number | no | &gt;= 0 | Only visits before this time (ms since epoch). Default: now. |

#### `history_delete` — Delete history

destructive, idempotent

Delete a URL, all history, or a time range from the browser history

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `url` | string | no |  | URL to remove from history |
| `all` | boolean | no |  | Set to true to clear all browser history |
| `startTime` | number | no | &gt;= 0 | Start time (ms since epoch) for range deletion |
| `endTime` | number | no | &gt;= 0 | End time (ms since epoch) for range deletion |

#### `permissions_grant` — Set site permission

changes state, idempotent

Allow/block a site permission (geolocation, camera...) for an origin via content settings.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `permission` | "geolocation" \| "notifications" \| "camera" \| "microphone" \| "popups" \| "javascript" \| "images" \| "cookies" | yes |  | Permission type |
| `setting` | "allow" \| "block" \| "ask" | no |  | Default allow |
| `origin` | string | no |  | Omit for the active tab's origin (e.g. https://example.com) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-emulation"></a>

### `emulation` (6)

Emulation: viewport, color scheme and media, CPU, geolocation.

#### `emulation_geolocation` — Spoof geolocation

changes state, idempotent

Spoof geolocation for a tab via CDP (attaches the debugger while active).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `latitude` | number | yes | -90..90 | Latitude in degrees |
| `longitude` | number | yes | -180..180 | Longitude in degrees |
| `accuracy` | number | no | &gt;= 0 | Accuracy in meters (default 50) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `emulation_geolocation_clear` — Clear geolocation override

changes state, idempotent

Remove the geolocation override (detaches the debugger when idle).

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `emulation_viewport` — Emulate device viewport

changes state, idempotent

Emulate a device screen for a tab via CDP: viewport size in CSS px, device pixel ratio, mobile mode and touch input. device picks a preset (iphone-se, iphone-15, iphone-15-pro-max, pixel-8, galaxy-s24, ipad-mini, ipad-pro-11, laptop-1366, desktop-1080p, desktop-1440p); explicit fields override it. The user agent is not changed. reset:true removes the override. Stays active (debugger attached) until reset or emulation_reset.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `device` | "iphone-se" \| "iphone-15" \| "iphone-15-pro-max" \| "pixel-8" \| "galaxy-s24" \| "ipad-mini" \| "ipad-pro-11" \| "laptop-1366" \| "desktop-1080p" \| "desktop-1440p" | no |  | Device preset that fills width/height/deviceScaleFactor/mobile/touch |
| `width` | integer | no | 1..16384 | Viewport width in CSS px (1..16384; required without device) |
| `height` | integer | no | 1..16384 | Viewport height in CSS px (1..16384; required without device) |
| `deviceScaleFactor` | number | no | 0..10 | Device pixel ratio (0 = keep the screen's own; default 0) |
| `mobile` | boolean | no |  | Mobile mode: meta viewport, overlay scrollbars, text autosizing (default false) |
| `touch` | boolean | no |  | Emulate a touch screen (touch events, pointer: coarse) |
| `reset` | boolean | no |  | true: remove the viewport override (other fields are ignored) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `emulation_media` — Emulate media features

changes state, idempotent

Emulate CSS media features for a tab via CDP: prefers-color-scheme, prefers-reduced-motion, forced-colors, and the print/screen media type (e.g. check dark mode or print styles). reset:true removes the media emulation. The result's applied field shows what is in effect.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `colorScheme` | "light" \| "dark" \| "no-preference" | no |  | prefers-color-scheme |
| `reducedMotion` | "reduce" \| "no-preference" | no |  | prefers-reduced-motion |
| `forcedColors` | "active" \| "none" | no |  | forced-colors (high contrast) |
| `media` | "screen" \| "print" | no |  | CSS media type |
| `reset` | boolean | no |  | true: remove the media emulation (other fields are ignored) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `emulation_cpu` — Throttle CPU

changes state, idempotent

Slow down the tab's CPU via CDP by a factor (4 = mid-range phone, 6 = low-end phone, max 20); rate 1 turns throttling off. Useful with perf_web_vitals or perf_trace_start.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `rate` | number | yes | 1..20 | Slowdown factor: 1 = off, 4 = 4x slower ... |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `emulation_reset` — Reset emulation

changes state, idempotent

Clear every emulation override on a tab (viewport, media features, CPU throttling, geolocation) and release the debugger. Returns the cleared kinds.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

<a id="toolset-performance"></a>

### `performance` (4)

Performance: metrics, web vitals, traces.

#### `page_metrics` — Performance metrics

read-only, open world

Blink performance metrics: JS heap, layout counts, FPS-related timings.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `perf_web_vitals` — Measure Web Vitals

changes state, open world

Web Vitals of the tab's current page from buffered PerformanceObservers: lcp, fcp, inp, ttfb (ms), cls (unitless), longTasks {count, totalMs} and navigation {domContentLoaded, load}. reload:true reloads the tab first and measures the fresh load (unsaved page state is lost); waitMs keeps observing that long before reporting. A metric the page has not produced yet (inp needs a user interaction) is reported empty. Combine with emulation_cpu / network_throttle for slow-device numbers.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `waitMs` | integer | no | 0..30000 | Keep observing this long before reporting, in ms (default 0, max 30000) |
| `reload` | boolean | no |  | Reload the tab first and measure the new page load (default false) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `perf_trace_start` — Start performance trace

changes state

Start a Chrome performance trace of the tab via CDP (the debugger stays attached until perf_trace_stop). Reproduce the slow interaction or load, then call perf_trace_stop to save the trace and get a summary.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `categories` | string[] | no | 1..64 items | Trace categories (e.g. devtools.timeline, v8.execute; a leading - excludes one, at least one must be included; max 64). Omit for the extension's default set. |
| `screenshots` | boolean | no |  | Also record filmstrip screenshots (much larger trace; default false) |
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |

#### `perf_trace_stop` — Stop performance trace

destructive

Stop the tab's performance trace and save it as a .json file (open it in Chrome DevTools &gt; Performance &gt; Load profile, or ui.perfetto.dev). Returns the file path, its size and a summary: durationMs, eventCount, the 10 longest main-thread tasks and mainThreadBusyMs. Without savePath the trace goes to a private temp folder. An incomplete trace (Chrome's buffer filled up, or events were dropped) is flagged with dataLossOccurred / droppedEvents / truncated and a note.

| Parameter | Type | Required | Limits | Description |
|---|---|---|---|---|
| `tabId` | integer | no |  | Tab ID from tab_list. Omit for the active tab. |
| `savePath` | string | no |  | Absolute .json path to write the trace to. Omit to save it in a private temp folder. |
| `overwrite` | boolean | no |  | Replace an existing file at savePath (default false) |

### Resources

| URI | Name | Title |
|---|---|---|
| `browser://status` | `status` | Bridge status |
| `browser://tabs` | `tabs` | Open tabs |
| `browser://console/recent` | `console_recent` | Recent console events |
| `browser://network/recent` | `network_recent` | Recent network events |

### Prompts

| Prompt | Title | Arguments | Description |
|---|---|---|---|
| `web_research` | Web research | `url`, `topic` | Structured browser research on a given topic and URL |
| `form_automation` | Form automation | `url`, `fields` | Inspect and fill a form on a given URL |
| `performance_audit` | Performance audit | `url` | Audit page metrics, network requests, and performance on a given URL |
| `accessibility_audit` | Accessibility audit | `url` | Audit accessibility tree and ARIA roles for a webpage |

<!-- END GENERATED: tool reference -->

## Tool notes

**Tabs.** `tab_create`, `tab_navigate` and `window_create` add `https://` to scheme-less URLs (`http://` for
loopback hosts). `tab_back` / `tab_forward` use the browser's history navigation, so they also work on error
pages, and fail when there is no history entry.

**Reading pages.**
- `page_snapshot` lists elements with refs and their live state: the typed value (`value=`, or `current=` when it
  differs from the `value` attribute), `filled=true|false` for passwords (their value is never shown),
  `checked`, `selected`, `disabled`, `readonly`, `required`, `expanded=`, `pressed=`, slider values and
  `contenteditable`. A `<select>` line also lists its option labels after `selected=`:
  `options="Red | Green | Blue"` (at most 15 labels and 120 characters, then ` (+N more)`). Compact mode
  (default) also lists ARIA widgets, editable hosts and iframes; iframes are markers, read them with
  `frame_list` + `frame_focus` (toolset `tabs`).
- Snapshot lines and `dom_query` texts leave out text the page does not render: `display:none` and `hidden`
  subtrees, `visibility:hidden` text (a `visibility:visible` child still counts), the closed part of a
  `<details>` and `content-visibility:hidden` subtrees. An element that is itself hidden still shows its own
  text and the `(hidden)` marker.
- `page_snapshot`, `page_text` and `page_html` return a window (`offset`, `maxChars`) and `nextOffset` to
  continue; `page_snapshot` windows end on whole lines and keep the same refs
  ([paging](toolsets.md#paging-large-pages)).
- `dom_query` returns `{total, returned, items: [{ref, tag, text, x, y, w, h}]}`, `limit` 20 by default (max 500).

**Typing.**
- `dom_type` types character by character with real key events, inserts at the caret when the element already
  has focus (else after the last content, including a trailing non-editable chip such as a mention or tag, or an
  image; a trailing `<br>` does not count), keeps existing text unless `clearFirst`, and honours `maxlength`. It
  reports the final `value` (never for passwords) and a `warning` when keys were cancelled or cut.
- A newline (`\n`) in `text` is typed as **Shift+Enter** and inserted as a line break (`insertLineBreak`; a
  `<br>` in a contenteditable) in textareas and contenteditables, so an Enter-to-send chat composer does not send
  in the middle of the text. Single-line inputs skip newlines. A page that binds Shift+Enter itself (a notebook's
  "run cell") still sees it.
- `pressEnter` presses one plain Enter after all the text: keydown, keypress, the browser's default action
  unless the page cancels it, then keyup. An input inside a form submits it, an input outside a form does
  nothing (the result says so), a textarea gets a line break, a contenteditable a new paragraph, and a composer
  that sends on Enter sends. The result's `enter` field reports `{defaultPrevented, defaultAction}`.
- With the default `delayMs` 0 no timer is used, so long text also finishes in a background tab. `delayMs`
  pauses are timers only while the tab is visible: in a hidden tab (a background tab, or a minimized or covered
  window, where the browser throttles timers) they are skipped, the whole text is still typed, and the result
  carries a `warning` with the number of skipped pauses.
- `dom_fill` sets a whole value in one step without key events; `trusted_type` types through CDP.

**Waiting.** `page_wait` resolves when every given condition holds at the same moment: `selector`, `text`,
`url` / `urlPattern`, `readyState`, and `networkIdle` (at most `maxInflight` requests in flight for `idleMs`,
default 0 for 500 ms; WebSockets, event streams and requests older than 60 s are not counted). URL, readyState
and network conditions are tracked by the background worker and survive navigations. `timeoutMs` defaults to
15000 (max 600000).

**Frames.** `frame_list` returns `{ frameId, parentFrameId, url }` (`frameId` 0 = main frame). `frame_focus`
takes `frameId` (exact) or `frameUrl` (substring; if several frames match, the error lists their ids) and routes
later content-script commands for that tab (`page_snapshot`, `page_html`, `page_text`, `page_find`, `dom_*`
except `dom_upload`, `keyboard_press`, `storage_*`, `idb_*`, selector / text conditions of `page_wait`) to that
one frame, including `trusted_*` input (coordinates are translated from the frame; frames nested inside another
cross-origin frame, identical frames that cannot be told apart, and CSS-transformed iframes are refused there
with a clear error). `dom_upload` and element screenshots (`page_screenshot` with `selector`) always resolve in
the main document (CSS selectors or snapshot refs only), and `js_evaluate` always runs in the main frame. The
focus survives service-worker restarts and is cleared by `frame_clear` or a main-frame navigation. Content
scripts also run in `about:blank`, `srcdoc`, `data:` and `blob:` frames.

**Uploads.** `dom_upload` accepts absolute paths of regular files up to 100 MiB inside the allowed folders and
never dot-folders, key files or this server's spilled output ([configuration.md](configuration.md#upload-folders-dom_upload)).
`cdp_send` applies the same rules to the `files` of `DOM.setFileInputFiles` and the `data.files` of
`Input.dispatchDragEvent`, also when the command is nested in `Target.sendMessageToTarget`, and sends the
resolved paths.

**Screenshots & PDF.**
- `page_screenshot` with `fullPage` captures up to `maxHeight` CSS px (default 16384, max 32768); taller pages
  are cut and reported with `truncated: true`. The image comes with a text block carrying the metadata.
- `page_pdf` returns an embedded `application/pdf` resource, or writes to `savePath` (absolute `.pdf`, an
  existing file is never overwritten). PDFs over 10 MiB without `savePath` go to a private temp file.

**Tab audio.**
- ffmpeg comes from `FFMPEG_PATH`, then `PATH`, then common install locations.
- `savePath` must be absolute and end in `.webm`, `.ogg`, `.opus`, `.mp3`, `.wav`, `.m4a`, `.aac` or `.flac`. It is
  validated before the recording is touched, and an existing file is only replaced with `overwrite: true`.
- Without `savePath` the recording is returned as an MCP `audio` block (`audio/webm`) plus a metadata block.
  Recordings over 10 MiB are written to a private temp file (`browser-mcp-*` in the OS temp folder) instead.
- If conversion fails, the raw audio is saved next to the target as `<savePath>.webm` with a
  `conversionWarning` (ffmpeg's error output included); nothing is overwritten.
- `tab_audio_record_stop` can omit `tabId` when exactly one recording is active; a recording whose tab was closed
  can still be collected this way. Uncollected finished recordings are freed after 30 minutes.
- `tab_audio_capture` records up to 3600 s, always stops the tab it started, sends progress notifications every
  5 s when the client asks for them, and stops early when the call is cancelled. Without `tabId` it records the
  active tab, which stays a fallback tab: it never gets the dialog hook of an agent tab.
- Inside the extension the recording is read from the offscreen document in 6 MiB chunks; it reaches the server
  as one WebSocket message (at most 256 MiB including base64 overhead, so about 190 MiB of audio).

**Network.**
- `network_requests` / `console_get` filter by `tabId` only when given (omit for all tabs). When the extension
  is unreachable they fall back to this server's buffer with `source: "bridge-buffer"` and a warning. Entries
  from the extension include request / response headers (up to 50 each); the server buffer has none.
- `network_throttle` stays active until profile `online`; `network_set_headers` until called with `{}`. While
  such an override (or a mock session, geolocation or other emulation) is active the debugger stays attached
  ([debugger sessions](extension.md#debugger-sessions)).
- `network_mock_route` with `delay` merges its `headers` into the original request; `network_mock_stop` detaches
  the debugger only when nothing else on the tab still needs it.
- `network_response_body` re-sends a recorded **GET** request in the page; for exact bodies (or non-GET
  requests) use `network_mock_start` before the request, then `network_bodies`.

**Emulation.** `emulation_viewport` takes a `device` preset (`iphone-se`, `iphone-15`, `iphone-15-pro-max`,
`pixel-8`, `galaxy-s24`, `ipad-mini`, `ipad-pro-11`, `laptop-1366`, `desktop-1080p`, `desktop-1440p`) or explicit
`width` / `height` (1-16384), `deviceScaleFactor`, `mobile` and `touch` (explicit fields override the preset; the
user agent is not changed). `emulation_media` sets `prefers-color-scheme`, `prefers-reduced-motion`,
`forced-colors` and the print / screen media type; later calls merge with earlier ones. `emulation_cpu` slows
the CPU by a factor of 1-20 (1 = off). `emulation_geolocation` overrides the position. `emulation_reset` clears
all of them on the tab and returns the cleared kinds.

**Performance.**
- `perf_web_vitals` reports `lcp`, `fcp`, `inp`, `ttfb` (ms), `cls`, long tasks and navigation timings from
  buffered PerformanceObservers; `reload: true` measures a fresh load, `waitMs` (max 30000) keeps observing. A
  metric the page has not produced is `null` with a `note`; INP is an approximation.
- `perf_trace_start` records a Chrome trace of the tab (default categories similar to DevTools' Performance
  panel; `categories` up to 64 names, a leading `-` excludes one; `screenshots` optional). It also needs the
  `page_screenshot` switch when it would record page content: `screenshots: true`, or an included category
  pattern that matches `disabled-by-default-devtools.screenshot` or a paint-data category
  (`disabled-by-default-devtools.timeline.picture`, `.timeline.layers`, `.timeline.paint`,
  `disabled-by-default-cc.debug.*`, `disabled-by-default-skia*`), whether by name, through a wildcard (such as
  `disabled-by-default-*`; a bare `*` does not count) or as any pattern naming screenshots, pictures, display
  items, layers or skia. Otherwise the call fails with `Permission disabled in extension: page_screenshot (required by perf_trace_start
  screenshots and paint-data categories; ...)`
  and records nothing. `perf_trace_stop`
  saves it as a `.json` file (to `savePath`, else a private temp folder) that Chrome DevTools or
  ui.perfetto.dev can open, and returns the path plus a summary (duration, event count, the 10 longest
  main-thread tasks, main-thread busy time). Only one trace per tab; an unread trace is dropped after 5 minutes.
- `page_metrics` returns Blink's performance counters (JS heap, layout counts, timings).

**Cookies, history & browsing data.**
- `cookies_clear` needs a `domain` or `url`; wiping every cookie requires `all: true`.
- `browsing_data_clear` needs explicit `types`, or `all: true` for the common session-data set (cache, cookies,
  form data, history, localStorage, IndexedDB, service workers).
- `cookies_set` / `cookies_import` accept `sameSite: "unspecified"`, so `cookies_export` output round-trips
  (including `hostOnly`).
- `history_search` searches all of history by default (`startTime` 0), takes `endTime`, and accepts
  `maxResults` as an alias of `limit`.
- `session_state_save` works on http(s) pages; `session_state_load` refuses to write storage into a tab that is
  not on the saved origin (navigate there first).
- `session_state_save` and `cookies_export` return their bundle inline only while it fits the output cap; a larger
  one is refused with an error asking for `savePath`, never cut. With `savePath` (an absolute `.json` path; an
  existing file is replaced only with `overwrite: true`) they write the complete bundle (mode `0600` on POSIX) and
  return a summary without values (`savedTo`, `sizeBytes`, counts and the call that reads it back).
  `session_state_load {filePath}` and `cookies_import {filePath}` read such a file (exactly one of `state` /
  `cookies` or `filePath`): an absolute `.json` regular file of at most 64 MiB, never a dot-segment path or a
  key file name. `session_state_load` also accepts the inline `{ok, state}` result, `cookies_import` a bare
  cookie array.
- `permissions_grant` takes an exact `http(s)` origin and `allow`, `block` or `ask`.

**Resources.** `browser://status` is the same snapshot as `browser_status`; `browser://tabs` lists every open
tab; `browser://console/recent` and `browser://network/recent` return the last 50 entries of this server
process's own buffer, and an error while `console_get` / `network_requests` is switched off in the popup.

**Dialogs & console capture.** Hooks run only in agent tabs; `dialog_policy` applies to them only. The rules,
including what happens to a tab reached without `tabId`, are in
[extension.md](extension.md#agent-tabs-dialogs-and-console-capture).
