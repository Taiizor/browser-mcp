# Multiple agents and scripts

- [Primary and satellites](#primary-and-satellites)
- [Scripts and other clients](#scripts-and-other-clients)
- [Extension handshake](#extension-handshake)

## Primary and satellites

stdio MCP runs one server process per client session. The first process binds the bridge port (**primary**)
and holds the single extension connection; later processes on the same port join it as **satellites** and
relay their commands through it. A satellite and the primary prove the per-run bridge token to each other
automatically (the token itself never crosses the socket), so every process must run as the same OS user with
the same `BROWSER_MCP_HOME`.

- The satellite checks the primary first. When the process on the port cannot prove the token (another program
  holds the port, or the token file is stale or missing), the satellite sends it no token and no command, logs
  `WARNING: satellite not linked: <why>; it was sent no token and no command (...). Retrying with backoff.`
  (at most once a minute), and retries with a growing extra delay of up to 30 s.
- If the primary exits, a satellite promotes itself and keeps the same trust list. A promoted satellite uses
  its own `--pair` / `--allow-legacy-extension` options.
- Cancelling a call in a satellite cancels the relayed command in the extension too, and when a satellite
  disconnects the primary cancels that satellite's commands that are still running.
- `browser_status` shows `mode` (`primary` or `satellite`), `pid` and `peers` (authenticated satellites and
  scripts on the primary).
- After an update, restart every `browser-mcp` process. A satellite of this release cannot join a primary of
  an older release (that primary only knows the legacy token frame below): it is refused with `4001` and
  reports `Primary bridge on :<port> refused authentication (stale token, or a primary of an older browser-mcp
  release that needs a restart)` until that primary is restarted.

## Scripts and other clients

Any local process can drive the bridge like a satellite. Client authentication is a mutual HMAC proof of the
per-run token, in which the primary proves itself first:

1. Read the token from `<config dir>/bridge-<port>.token` (64 hex characters) right before connecting: it
   changes every time a primary starts. The HMAC key is the hex-decoded token (32 bytes); HMAC means
   HMAC-SHA256 with lowercase hex output, and nonces are 32 random bytes as 64 lowercase hex characters.
2. Connect to `ws://127.0.0.1:<port>` **without** an `Origin` header and send
   `{ "type": "auth", "v": 2, "nonce": "<Nc>" }` as the **first** frame.
3. The primary answers `{ "type": "auth_challenge", "nonce": "<Np>", "proof": "<proof>" }` with
   `proof = HMAC("browser-mcp/client|server|<port>|<Nc>|<Np>")`. Check it (`<port>` is the decimal port you
   connected to). If it does not match, close the socket and send nothing: the process on the port does not
   hold the token.
4. Send `{ "type": "auth_proof", "proof": HMAC("browser-mcp/client|client|<port>|<Np>|<Nc>") }` and wait for
   `{ "type": "auth_ok", "pid": <primary pid> }`.
5. Send commands `{ id, action, payload?, tabId?, timeoutMs?, launch? }` (`id` must be a string;
   `timeoutMs` defaults to 30000). Replies are `{ id, ok, result?, error? }`.
6. To give up on a command, send `{ "type": "cancel", "id": "<your id>" }`; the extension stops it where it
   can, and no reply follows.

A wrong proof, a malformed nonce, any frame out of step, a second `auth`, or 5 s without a completed
authentication closes the socket with `4001 auth-required`.

**Legacy token frame.** The primary still accepts `{ "type": "auth", "token": "<token>" }` as the first frame
(older scripts and server processes) and answers `auth_ok`. It hands the raw token to whatever process
listens on the port and checks nothing about that process: a program that holds the port (for example while no
primary runs) learns the token, can then pass the satellites' check until a primary writes a new one, and
receives the script's commands. Use the v2 flow above.

- `action` is the extension's action name. It matches the tool name except `tabs_list` (tool `tab_list`),
  `perm_list` / `perm_set` (`permissions_list` / `permissions_set`; `perm_set` can only disable) and the
  server-side tools: `__bridge_status`, `__launchBrowser` (`payload.timeoutMs`, `payload.browser`) and
  `__closeBrowser` (`payload.force`) are handled by the primary itself; `tab_audio_capture` is
  `tab_audio_record_start` + `tab_audio_record_stop` (without a `tabId`, the stop names the recording with
  `payload.recordingTabId` instead of a command `tabId`, so the active tab does not become an agent tab), and
  `perf_trace_stop` returns a `traceId` whose data is read with `perf_trace_chunk` `{ traceId, index }`.
- **Browser auto-launch:** if the extension is not connected, the primary first waits for it to reconnect
  (only within 12 s of the primary starting or the extension dropping, and only while a browser is running),
  then auto-launches a browser and waits up to `BROWSER_LAUNCH_TIMEOUT_MS` for the extension before running
  the command (`timeoutMs` covers only the command itself). A frame can carry
  `launch: { auto?: boolean, browser?: "chrome" | "edge" | "brave" | "opera" }`; `launch.auto` overrides the
  primary's `BROWSER_AUTO_LAUNCH`, so send `launch: { auto: false }` to never open a browser window (the
  command then fails with "not connected").
- Results are raw extension results: no file saving, output cap, ffmpeg conversion, path checks (`dom_upload`'s
  rules apply only to the MCP tools) or MCP image/audio/PDF blocks.
- The popup switches apply as usual.
- Other frames you receive (`{ "type": "event", "kind": "console" | "network" | "perms", "data": ... }`) are
  the extension's events, broadcast to every satellite.

```ts
// list-tabs.ts: bun list-tabs.ts
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.BROWSER_MCP_PORT ?? 8765);
const dir = process.env.BROWSER_MCP_HOME || path.join(os.homedir(), ".browser-mcp");
const token = (await Bun.file(path.join(dir, `bridge-${port}.token`)).text()).trim();
const hmac = (msg: string) => crypto.createHmac("sha256", Buffer.from(token, "hex")).update(msg).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const nc = crypto.randomBytes(32).toString("hex");
let verified = false; // true once the primary proved the token

const ws = new WebSocket(`ws://127.0.0.1:${port}`); // no Origin header
ws.onopen = () => ws.send(JSON.stringify({ type: "auth", v: 2, nonce: nc }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === "auth_challenge" && !verified) {
    const np = String(msg.nonce);
    const proof = String(msg.proof);
    const expected = hmac(`browser-mcp/client|server|${port}|${nc}|${np}`);
    if (!HEX64.test(np) || !HEX64.test(proof) || !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(proof, "hex"))) {
      console.error("the process on the port cannot prove the bridge token: not sending anything");
      return ws.close();
    }
    verified = true;
    ws.send(JSON.stringify({ type: "auth_proof", proof: hmac(`browser-mcp/client|client|${port}|${np}|${nc}`) }));
  } else if (msg.type === "auth_ok" && verified) {
    ws.send(JSON.stringify({ id: "1", action: "tabs_list", payload: {}, timeoutMs: 30000 }));
  } else if (!verified) {
    console.error("unexpected frame before authentication: not sending anything");
    ws.close();
  } else if (msg.id === "1") {
    console.log(msg.ok ? msg.result : `error: ${msg.error}`);
    ws.close();
  } // other frames ({ type: "event", ... }) are broadcast console/network/perms events
};
ws.onclose = (ev) => {
  if (ev.code === 4001) console.error("refused: token missing or stale (server restarted?)");
};
```

## Extension handshake

Extension sockets use bridge protocol 3 instead of the token: a trusted extension id plus a mutual HMAC proof
of the install's pairing key (`hello` → `challenge` / `auth` or `pair` / `pair_accept` → `welcome`). Both
proofs bind the extension id, the install id, both nonces and the TCP port: the server signs with the port it is
bound to, the extension with the port it dialed, so a challenge relayed from a server on another port never
verifies (`4101`). After the handshake the server sends commands `{ id, action, tabId?, payload?, timeoutMs }`,
the extension answers `{ id, ok, result?, error? }` on the same socket, and `{ "type": "cancel", "id" }` stops
a command. Only the socket a command was sent to may answer it, and an extension socket can never send
commands. The user-facing side (pairing window, `--pair`, close codes) is in [pairing.md](pairing.md); the
trust model and every frame in [SECURITY.md](../SECURITY.md#bridge-trust-model-protocol-v3) and at the top of
`mcp-server/src/bridge.ts`.
