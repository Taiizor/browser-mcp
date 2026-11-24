// Cancellation end to end: an MCP client abort becomes notifications/cancelled,
// the server's AbortSignal sends {type:"cancel", id} on the extension socket,
// background.js aborts the command's AbortController and tells content.js
// {cmd:"__cancel", payload:{cmdId}}; the waiting content command stops.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ExtHarness, rejectionOf, sleep, waitFor } from "../helpers/ext-harness.js";
import type { McpHandle } from "../helpers/ext-mcp.js";

const T = 20_000;

let h: ExtHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** Starts page_wait on a selector that never appears, aborts it once content.js runs it, and checks every hop. */
async function abortPageWait(x: ExtHarness, m: McpHandle): Promise<void> {
  const ac = new AbortController();
  const call = m.call("page_wait", { selector: "#never", timeoutMs: 20_000 }, { signal: ac.signal });
  await waitFor(() => x.chrome.content.some((c) => c.cmd === "page_wait"), "page_wait to reach content.js");
  const cmd = x.inbound((f) => f.action === "page_wait")[0];
  expect(x.bg.state.runningCmds.has(String(cmd.id))).toBe(true);
  const t0 = Date.now();
  ac.abort("user cancelled");
  expect(await rejectionOf(call)).toBeInstanceOf(Error);

  // server -> extension: one cancel frame for the command's id, on its socket
  await waitFor(() => x.inbound((f) => f.type === "cancel").length > 0, "the cancel frame");
  expect(x.inbound((f) => f.type === "cancel")).toEqual([{ type: "cancel", id: cmd.id }]);
  // extension: the command ended as cancelled, quickly
  await waitFor(() => x.bg.state.commandHistory[0]?.id === cmd.id, "the command to end");
  expect(x.bg.state.commandHistory[0]).toMatchObject({ action: "page_wait", ok: false, error: "cancelled" });
  expect(x.bg.state.runningCmds.size).toBe(0);
  expect(x.outbound((f) => f.id === cmd.id)).toEqual([{ id: cmd.id, ok: false, error: "cancelled" }]);
  // background -> content: __cancel for the same cmdId and frame; the wait stopped there too
  const wait = x.chrome.content.find((c) => c.cmd === "page_wait")!;
  await waitFor(() => x.chrome.content.some((c) => c.cmd === "__cancel"), "__cancel in content.js");
  const cancel = x.chrome.content.find((c) => c.cmd === "__cancel")!;
  expect(typeof wait.cmdId).toBe("string");
  expect(cancel.payload).toEqual({ cmdId: wait.cmdId });
  expect(cancel.frameId).toBe(wait.frameId);
  expect(cancel.response).toEqual({ ok: true, result: { cancelled: true } });
  await waitFor(() => wait.response !== undefined, "content.js page_wait to answer");
  expect(wait.response).toEqual({ ok: false, error: "cancelled" });
  expect(Date.now() - t0).toBeLessThan(5_000);
}

describe("cancellation", () => {
  test("MCP client abort -> cancel frame -> AbortController -> content __cancel", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    await abortPageWait(h, await h.mcp());
  }, T);

  test("the same chain through a satellite BridgeClient (satellite -> primary -> extension)", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    const sat = await h.satellite();
    expect(sat.mode).toBe("satellite");
    await abortPageWait(h, await h.mcp({ bridge: sat }));
  }, T);

  test("dom_type with a delay stops between characters", async () => {
    h = await ExtHarness.create({ html: '<input id="inp">' });
    const m = await h.mcp();
    const input = h.page!.$("#inp");
    const text = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN";
    const ac = new AbortController();
    // 40 characters, 50 ms apart: about 2 s of typing, cancelled after the third.
    const call = m.call("dom_type", { selector: "#inp", text, delayMs: 50 }, { signal: ac.signal });
    await waitFor(() => input.value.length >= 3, "typing to start");
    ac.abort();
    await rejectionOf(call);
    await waitFor(() => h!.chrome.content.some((c) => c.cmd === "__cancel"), "__cancel in content.js");
    const typed = input.value;
    await sleep(200);
    expect(input.value).toBe(typed);
    expect(typed.length).toBeLessThan(text.length);
    expect(text.startsWith(typed)).toBe(true);
    await waitFor(() => h!.chrome.content.find((c) => c.cmd === "dom_type")?.response !== undefined, "dom_type to answer");
    expect(h.chrome.content.find((c) => c.cmd === "dom_type")!.response).toEqual({ ok: false, error: "cancelled" });
  }, T);

  test("page_wait networkIdle (a background-side wait) is cancellable", async () => {
    h = await ExtHarness.create();
    h.chrome.events.beforeRequest.emit({ tabId: 1, requestId: "r1", type: "xmlhttprequest", url: "https://example.com/api" });
    const m = await h.mcp();
    const ac = new AbortController();
    const call = m.call("page_wait", { networkIdle: true, idleMs: 100, timeoutMs: 20_000 }, { signal: ac.signal });
    await waitFor(() => h!.bg.state.runningCmds.size === 1, "page_wait to run");
    await sleep(150);
    ac.abort();
    await rejectionOf(call);
    await waitFor(() => h!.bg.state.commandHistory[0]?.action === "page_wait", "page_wait to end");
    expect(h.bg.state.commandHistory[0]).toMatchObject({ ok: false, error: "cancelled" });
    expect(h.bg.state.commandHistory[0].durationMs).toBeLessThan(5_000);
  }, T);

  test("satellite cancel ids are scoped to the sending socket", async () => {
    h = await ExtHarness.create({ html: "<p>static page</p>" });
    const a = await rawSatellite(h);
    const b = await rawSatellite(h);
    a.ws.send(JSON.stringify({ id: "a1", action: "page_wait", payload: { selector: "#never", timeoutMs: 20_000 }, tabId: 1, timeoutMs: 30_000 }));
    await waitFor(() => h!.chrome.content.some((c) => c.cmd === "page_wait"), "the relayed page_wait to run");

    // Another satellite (and an unknown id) cannot cancel it.
    b.ws.send(JSON.stringify({ type: "cancel", id: "a1" }));
    a.ws.send(JSON.stringify({ type: "cancel", id: "nope" }));
    await sleep(100);
    expect(h.inbound((f) => f.type === "cancel")).toHaveLength(0);
    expect(h.bg.state.runningCmds.size).toBe(1);

    // The owner can.
    a.ws.send(JSON.stringify({ type: "cancel", id: "a1" }));
    await waitFor(() => h!.inbound((f) => f.type === "cancel").length === 1, "the forwarded cancel frame");
    expect(h.inbound((f) => f.type === "cancel")[0].id).toBe(h.inbound((f) => f.action === "page_wait")[0].id);
    await waitFor(() => h!.bg.state.commandHistory[0]?.error === "cancelled", "the command to end cancelled");
    a.ws.close();
    b.ws.close();
  }, T);
});

/** An Origin-less client authenticated with the bridge token, speaking the satellite frames by hand. */
async function rawSatellite(x: ExtHarness): Promise<{ ws: WebSocket; frames: any[] }> {
  const token = fs.readFileSync(path.join(x.configDir, `bridge-${x.server.port}.token`), "utf8").trim();
  const ws = new WebSocket(`ws://127.0.0.1:${x.server.port}`);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => frames.some((f) => f.type === "auth_ok"), "auth_ok");
  return { ws, frames };
}
