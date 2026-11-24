// Bridge protocol v3 between the REAL extension/background.js and the REAL
// ExtensionBridge: pairing, challenge, Forget pairing / --pair, refusals in
// both directions, legacy (protocol 2) handling, and a fake server on the port.

import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsSocket } from "ws";
import { BRIDGE_PROTOCOL, SERVER_VERSION } from "../../src/bridge.js";
import { EXT_ID, EXT_ORIGIN, ExtHarness, rejectionOf, sleep, waitFor } from "../helpers/ext-harness.js";

const T = 20_000;
const HEX64 = /^[0-9a-f]{64}$/;

let h: ExtHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** HMAC-SHA256 as SPEC section 1 defines it (key = hex-decoded K, lowercase hex output). */
function hmac(keyHex: string, message: string): string {
  return crypto.createHmac("sha256", Buffer.from(keyHex, "hex")).update(message, "utf8").digest("hex");
}

/** serverProof / extProof of protocol 3: bound to the port the extension dialed. */
const serverProof = (key: string, installId: string, port: number, ne: string, ns: string) =>
  hmac(key, `browser-mcp/v3|server|${EXT_ID}|${installId}|${port}|${ne}|${ns}`);
const extProof = (key: string, installId: string, port: number, ns: string, ne: string) =>
  hmac(key, `browser-mcp/v3|extension|${EXT_ID}|${installId}|${port}|${ns}|${ne}`);

describe("pairing and authentication", () => {
  test("first pairing: trust on first use stores the same key on both sides", async () => {
    h = await ExtHarness.create();
    const st = h.bg.state;
    expect(st.pairState).toBe("paired");
    expect(st.serverInfo).toEqual({ version: SERVER_VERSION, protocol: BRIDGE_PROTOCOL, pid: process.pid });
    expect(st.pairing.key).toMatch(HEX64);

    const hello = h.outbound((f) => f.type === "hello")[0];
    expect(hello).toMatchObject({ role: "extension", protocol: 3, extensionId: EXT_ID, hasKey: false, installId: st.pairing.installId });
    expect(hello.nonce).toMatch(HEX64);
    const offer = h.inbound((f) => f.type === "pair")[0];
    expect(offer.key).toBe(st.pairing.key);
    // pair_accept proves the extension holds K: extProof over port|Ns|Ne.
    const accept = h.outbound((f) => f.type === "pair_accept")[0];
    expect(accept.proof).toBe(extProof(offer.key, hello.installId, h.server.port, offer.nonce, hello.nonce));
    expect(h.inbound((f) => f.type === "welcome")[0]).toEqual({ type: "welcome", protocol: 3, pid: process.pid, serverVersion: SERVER_VERSION });

    const keys = h.readKeys();
    expect(keys.version).toBe(1);
    expect(keys.installs).toHaveLength(1);
    expect(keys.installs[0]).toMatchObject({ extensionId: EXT_ID, installId: st.pairing.installId, key: st.pairing.key });
    // The record lives in the extension origin's IndexedDB, never in storage.local.
    expect(h.pairingRecord()).toEqual({ installId: st.pairing.installId, key: st.pairing.key });
    expect(h.store.local.mcpPairing).toBeUndefined();

    const status = h.server.status();
    expect(status).toMatchObject({ extensionProtocol: 3, pairedInstalls: 1, pairingOpen: false, extensionVersion: h.chrome.api.runtime.getManifest().version });
    expect(status.trustedExtensionIds).toContain(EXT_ID);
    // Keys never reach the log.
    expect(h.serverLog.join("\n")).not.toContain(st.pairing.key);
    // The link carries commands now.
    const perms = await h.server.send<{ disabled: string[] }>("perm_list", {});
    expect(perms.disabled).toEqual([]);
  }, T);

  test("reconnect: the server proves the stored key in a challenge, the extension answers with auth", async () => {
    h = await ExtHarness.create();
    const { installId, key } = h.bg.state.pairing;
    h.bg.frames.length = 0;
    h.bg.state.reconnectNow();
    await h.waitPaired();

    const hello = h.outbound((f) => f.type === "hello")[0];
    expect(hello.hasKey).toBe(true);
    const challenge = h.inbound((f) => f.type === "challenge")[0];
    expect(challenge.proof).toBe(serverProof(key, installId, h.server.port, hello.nonce, challenge.nonce));
    const auth = h.outbound((f) => f.type === "auth")[0];
    expect(auth.proof).toBe(extProof(key, installId, h.server.port, challenge.nonce, hello.nonce));
    expect(h.inbound((f) => f.type === "pair")).toHaveLength(0);
    expect(h.bg.state.pairing.key).toBe(key);
    expect(h.readKeys().installs).toHaveLength(1);
  }, T);

  test("Forget pairing -> 4004 pairing-closed -> a --pair server pairs the same install again", async () => {
    h = await ExtHarness.create();
    const { installId, key: oldKey } = h.bg.state.pairing;

    expect(await h.popup({ type: "mcp-forget-pairing" })).toEqual({ ok: true });
    await waitFor(() => h!.bg.state.pairState === "pairing-closed", "pairing-closed");
    expect(h.bg.state.lastClose.code).toBe(4004);
    expect(h.pairingRecord()).toEqual({ installId });
    expect(h.outbound((f) => f.type === "hello").at(-1).hasKey).toBe(false);
    const status = await h.popup({ type: "mcp-status" });
    expect(status).toMatchObject({ pairState: "pairing-closed", hasKey: false, paired: false });
    expect(h.server.connected).toBe(false);

    // Same config dir, started with --pair: hasKey:false gets a pair offer.
    const pairServer = await h.startServer({ pair: true });
    expect(pairServer.status().pairingOpen).toBe(true);
    expect(await h.popup({ type: "mcp-port-set", port: pairServer.port })).toMatchObject({ ok: true });
    await h.waitPaired();
    const { key: newKey } = h.bg.state.pairing;
    expect(newKey).toMatch(HEX64);
    expect(newKey).not.toBe(oldKey);
    const installs = h.readKeys().installs;
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ installId, key: newKey });
    // One new install per --pair run.
    expect(pairServer.status().pairingOpen).toBe(false);
  }, T);

  test("a server holding the wrong key is refused with 4101 and gets no command answered", async () => {
    h = await ExtHarness.create();
    const keys = h.readKeys();
    keys.installs[0].key = "0".repeat(64);
    fs.writeFileSync(h.keysFile(), JSON.stringify(keys));
    h.bg.frames.length = 0;
    h.bg.state.reconnectNow();

    await waitFor(() => h!.bg.state.pairState === "server-auth-failed", "server-auth-failed");
    expect(h.bg.state.lastClose).toMatchObject({ code: 4101, reason: "server-auth-failed" });
    expect(h.inbound((f) => f.type === "challenge")).toHaveLength(1);
    expect(h.outbound((f) => f.type === "auth")).toHaveLength(0);
    await waitFor(() => h!.server.status().lastExtensionRefusal?.code === 4101, "the server to record the 4101 refusal");
    expect(h.server.connected).toBe(false);
    expect((await rejectionOf(h.server.send("perm_list", {}))).message).toMatch(/not connected/i);
  }, T);

  test("a pair offer to an install that keeps its key is declined (4100); Re-pair accepts the next one", async () => {
    h = await ExtHarness.create();
    const oldKey = h.bg.state.pairing.key;
    // Zero installs again: the server's first-setup window offers a new key.
    fs.writeFileSync(h.keysFile(), JSON.stringify({ version: 1, installs: [] }));
    h.bg.state.reconnectNow();

    await waitFor(() => h!.bg.state.pairState === "repair-offered", "repair-offered");
    expect(h.bg.state.lastClose).toMatchObject({ code: 4100, reason: "pair-declined" });
    expect(h.bg.state.pairing.key).toBe(oldKey);
    await waitFor(() => h!.server.status().lastExtensionRefusal?.code === 4100, "the server to record the 4100 refusal");
    expect(h.readKeys().installs).toHaveLength(0);
    expect(await h.popup({ type: "mcp-status" })).toMatchObject({ pairState: "repair-offered", hasKey: true });

    expect(await h.popup({ type: "mcp-repair" })).toEqual({ ok: true });
    await h.waitPaired();
    const newKey = h.bg.state.pairing.key;
    expect(newKey).not.toBe(oldKey);
    expect(h.readKeys().installs[0].key).toBe(newKey);
    // The Re-pair window is consumed by the accepted offer.
    expect(h.bg.state.acceptPairUntil).toBe(0);
  }, T);

  test("the Re-pair window closes after 2 minutes (extension clock)", async () => {
    h = await ExtHarness.create();
    const oldKey = h.bg.state.pairing.key;
    // Server gone: Re-pair is clicked while nothing can make an offer.
    h.server.close();
    await waitFor(() => !h!.bg.state.paired, "the extension to notice the closed server");
    expect(await h.popup({ type: "mcp-repair" })).toEqual({ ok: true });
    expect(h.bg.state.acceptPairUntil).toBeGreaterThan(h.bg.clock.now());
    await h.bg.clock.advance(121_000);

    // A server in its first-setup window now offers a key: no longer accepted.
    fs.writeFileSync(h.keysFile(), JSON.stringify({ version: 1, installs: [] }));
    const offering = await h.startServer();
    expect(await h.popup({ type: "mcp-port-set", port: offering.port })).toMatchObject({ ok: true });
    await waitFor(() => h!.bg.state.pairState === "repair-offered", "repair-offered after the window expired");
    expect(h.bg.state.lastClose.code).toBe(4100);
    expect(h.bg.state.pairing.key).toBe(oldKey);
  }, T);
});

describe("protocol versions", () => {
  /** A hand-written 0.3.x extension: hello with protocol 2, answers commands. */
  async function legacyExtension(port: number) {
    const received: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: EXT_ORIGIN } } as unknown as string[]);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      received.push(msg);
      if (typeof msg.id === "string" && msg.action) ws.send(JSON.stringify({ id: msg.id, ok: true, result: { legacy: true, action: msg.action } }));
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.send(JSON.stringify({ type: "hello", role: "extension", protocol: 2, browser: "chrome", extensionId: EXT_ID, version: "0.3.4", perms: { disabled: [] } }));
    return { ws, received, closed };
  }

  test("a protocol-2 extension is refused with 4002 by default", async () => {
    h = await ExtHarness.create();
    const plain = await h.startServer();
    const legacy = await legacyExtension(plain.port);
    const closed = await legacy.closed;
    expect(closed.code).toBe(4002);
    // (Bun 1.3.x hands an empty close reason to the client side as well.)
    if (closed.reason) expect(closed.reason).toBe("protocol-mismatch:server=3,ext=2");
    expect(legacy.received.filter((m) => m.type === "welcome")).toHaveLength(0);
    expect(plain.connected).toBe(false);
  }, T);

  test("allowLegacyExtension accepts protocol 2 without a key, with a warning; a v3 extension still authenticates", async () => {
    h = await ExtHarness.create();
    const legacyOk = await h.startServer({ allowLegacyExtension: true });
    const legacy = await legacyExtension(legacyOk.port);
    await waitFor(() => legacyOk.connected, "the legacy extension to be accepted");
    expect(legacy.received.find((m) => m.type === "welcome")).toEqual({ type: "welcome", protocol: 2, pid: process.pid });
    expect(legacyOk.status()).toMatchObject({ extensionProtocol: 2, legacyExtensionAllowed: true });
    expect(h.serverLog.some((l) => /protocol 2; accepted WITHOUT authentication/.test(l))).toBe(true);
    expect(await legacyOk.send("tabs_list", {})).toEqual({ legacy: true, action: "tabs_list" });
    legacy.ws.close();
    await waitFor(() => !legacyOk.connected, "the legacy extension to leave");

    // The real (v3) extension on the same server: still challenged, never downgraded.
    h.bg.frames.length = 0;
    expect(await h.popup({ type: "mcp-port-set", port: legacyOk.port })).toMatchObject({ ok: true });
    await h.waitPaired();
    expect(h.inbound((f) => f.type === "challenge")).toHaveLength(1);
    expect(legacyOk.status().extensionProtocol).toBe(3);
  }, T);
});

describe("a fake server on the bridge port", () => {
  /** A WebSocket server that speaks just enough of the protocol to misbehave. */
  async function fakeServer(onHello: (ws: WsSocket, hello: any) => void) {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    const closes: Array<{ code: number }> = [];
    wss.on("connection", (ws) => {
      ws.on("close", (code) => closes.push({ code }));
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === "hello") onHello(ws, msg);
      });
    });
    return { wss, port: (wss.address() as { port: number }).port, closes };
  }

  const COMMANDS = [
    { id: "evil-1", action: "perm_list", payload: {} },
    { id: "evil-2", action: "tabs_list", payload: {} },
    { id: "evil-3", action: "perm_set", payload: { action: "dom_click", enabled: false } },
  ];

  test("commands before welcome are ignored; a welcome without the v3 handshake is refused (4102)", async () => {
    h = await ExtHarness.create({ noServer: true });
    const fake = await fakeServer((ws) => {
      for (const c of COMMANDS) ws.send(JSON.stringify(c));
      ws.send(JSON.stringify({ type: "cancel", id: "evil-1" }));
      setTimeout(() => ws.send(JSON.stringify({ type: "welcome", protocol: 3, pid: 1, serverVersion: "9.9.9" })), 50);
    });
    try {
      expect(await h.popup({ type: "mcp-port-set", port: fake.port })).toMatchObject({ ok: true });
      await waitFor(() => h!.bg.state.pairState === "protocol-mismatch", "protocol-mismatch");
      expect(h.bg.state.lastClose).toMatchObject({ code: 4102, reason: "server-outdated" });
      expect(h.bg.state.paired).toBe(false);
      await waitFor(() => fake.closes.some((c) => c.code === 4102), "the fake server to see 4102");
      // Nothing ran and nothing was answered.
      expect(h.outbound((f) => typeof f.id === "string")).toHaveLength(0);
      expect(h.bg.state.commandHistory).toHaveLength(0);
      expect([...h.bg.state.disabledActions]).toEqual([]);
    } finally {
      fake.wss.close();
    }
  }, T);

  test("a challenge with a forged proof is refused (4101); later commands are ignored", async () => {
    h = await ExtHarness.create({ noServer: true });
    const fake = await fakeServer((ws) => {
      ws.send(JSON.stringify({ type: "challenge", nonce: crypto.randomBytes(32).toString("hex"), proof: crypto.randomBytes(32).toString("hex") }));
      for (const c of COMMANDS) ws.send(JSON.stringify(c));
    });
    try {
      expect(await h.popup({ type: "mcp-port-set", port: fake.port })).toMatchObject({ ok: true });
      await waitFor(() => h!.bg.state.pairState === "server-auth-failed", "server-auth-failed");
      expect(h.bg.state.lastClose.code).toBe(4101);
      await sleep(50);
      expect(h.outbound((f) => f.type === "auth" || typeof f.id === "string")).toHaveLength(0);
      expect(h.bg.state.commandHistory).toHaveLength(0);
    } finally {
      fake.wss.close();
    }
  }, T);

  test("a genuine challenge relayed from a primary on another port is refused (4101)", async () => {
    // The extension dials a squatter on port R, which pipes the socket to the
    // real primary on port P (same config dir, so it holds the key). The
    // primary signs its challenge for P: the extension expects R.
    h = await ExtHarness.create();
    const { installId, key } = h.bg.state.pairing;
    const primaryPort = h.server.port;
    const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => relay.once("listening", r));
    const relayPort = (relay.address() as { port: number }).port;
    relay.on("connection", (inc) => {
      const out = new WsClient(`ws://127.0.0.1:${primaryPort}`, { headers: { Origin: EXT_ORIGIN } });
      const queued: string[] = [];
      inc.on("message", (d) => (out.readyState === WsClient.OPEN ? out.send(String(d)) : queued.push(String(d))));
      out.on("open", () => {
        for (const q of queued.splice(0)) out.send(q);
      });
      out.on("message", (d) => inc.readyState === WsClient.OPEN && inc.send(String(d)));
      inc.on("close", () => out.close());
      out.on("close", () => inc.close());
    });
    try {
      h.bg.frames.length = 0;
      expect(await h.popup({ type: "mcp-port-set", port: relayPort })).toMatchObject({ ok: true });
      await waitFor(() => h!.bg.state.pairState === "server-auth-failed", "server-auth-failed");
      expect(h.bg.state.lastClose).toMatchObject({ code: 4101, reason: "server-auth-failed" });
      // The relayed challenge was genuine, for the primary's own port.
      const hello = h.outbound((f) => f.type === "hello")[0];
      const challenge = h.inbound((f) => f.type === "challenge")[0];
      expect(challenge.proof).toBe(serverProof(key, installId, primaryPort, hello.nonce, challenge.nonce));
      expect(challenge.proof).not.toBe(serverProof(key, installId, relayPort, hello.nonce, challenge.nonce));
      // No proof of ours went out, nothing was welcomed, nothing ran.
      expect(h.outbound((f) => f.type === "auth" || f.type === "pair_accept" || typeof f.id === "string")).toHaveLength(0);
      expect(h.inbound((f) => f.type === "welcome")).toHaveLength(0);
      await sleep(50);
      expect(h.server.connected).toBe(false);
    } finally {
      relay.close();
    }
  }, T);
});

describe("pairing record (extension origin IndexedDB)", () => {
  test("a record from storage.local (builds before the move) is migrated once, then removed", async () => {
    h = await ExtHarness.create();
    const { installId, key } = h.bg.state.pairing;
    // The state an earlier build left: the record in storage.local only.
    delete h.store.idb["browser-mcp"];
    h.store.local.mcpPairing = { installId, key };
    h.restartWorker();
    await h.waitPaired();

    expect(h.bg.state.pairing).toEqual({ installId, key });
    expect(h.pairingRecord()).toEqual({ installId, key });
    expect(h.store.local.mcpPairing).toBeUndefined();
    // Same key on both sides: a challenge, no new pairing.
    expect(h.inbound((f) => f.type === "challenge")).toHaveLength(1);
    expect(h.inbound((f) => f.type === "pair")).toHaveLength(0);
    expect(h.readKeys().installs).toHaveLength(1);
  }, T);

  test("a storage.local record written after the move is never trusted", async () => {
    h = await ExtHarness.create();
    const { installId, key } = h.bg.state.pairing;
    // What a content script could write on Chromium < 140.
    h.store.local.mcpPairing = { installId: "planted-install-id", key: "1".repeat(64) };
    h.restartWorker();
    await h.waitPaired();

    expect(h.bg.state.pairing).toEqual({ installId, key });
    expect(h.pairingRecord()).toEqual({ installId, key });
    await waitFor(() => h!.store.local.mcpPairing === undefined, "the planted record to be removed");
    const hello = h.outbound((f) => f.type === "hello").at(-1);
    expect(hello).toMatchObject({ installId, hasKey: true });
  }, T);

  test("without IndexedDB the worker stays unpaired and keeps the old record for the next start", async () => {
    h = await ExtHarness.create();
    const { installId, key } = h.bg.state.pairing;
    delete h.store.idb["browser-mcp"];
    h.store.local.mcpPairing = { installId, key };
    h.store.idbBroken = true;
    h.restartWorker();

    // Never read from storage.local: a fresh, key-less install the server does not know.
    await waitFor(() => h!.bg.state.pairState === "pairing-closed", "pairing-closed");
    const hello = h.outbound((f) => f.type === "hello").at(-1);
    expect(hello.hasKey).toBe(false);
    expect(hello.installId).not.toBe(installId);
    expect(h.bg.log.some((l) => l.includes("pairing store (IndexedDB) unavailable"))).toBe(true);
    expect(h.store.local.mcpPairing).toEqual({ installId, key });

    // IndexedDB back: the next start migrates and pairs with the old key.
    h.store.idbBroken = false;
    h.restartWorker();
    await h.waitPaired();
    expect(h.bg.state.pairing).toEqual({ installId, key });
    expect(h.pairingRecord()).toEqual({ installId, key });
    expect(h.store.local.mcpPairing).toBeUndefined();
  }, T);
});
