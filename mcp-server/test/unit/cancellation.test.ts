// Cancellation: a client cancelling tools/call must reach bridge.send's abort
// signal (ctx.send), while deliberate cleanup (tab_audio_capture's start and
// stop) runs without one, so a cancel can never leave a recording behind.
import { afterEach, describe, expect, test } from "bun:test";
import { type SentCommand, untilAborted } from "../helpers/unit-fake-bridge.js";
import { flush, startUnitServer, texts, type UnitServer } from "../helpers/unit-mcp.js";

let unit: UnitServer | undefined;
afterEach(async () => {
  await unit?.close();
  unit = undefined;
});

/** Polls until `pred` holds (the server keeps working after the client gave up). */
async function waitFor(pred: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await flush(5);
  }
}

describe("ctx.send carries the request's abort signal", () => {
  test("cancelling the client request aborts the signal bridge.send got", async () => {
    unit = await startUnitServer();
    unit.bridge.responder = untilAborted;
    const ac = new AbortController();
    const pending = unit.call("page_wait", { selector: "#late" }, { signal: ac.signal }).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`
    );
    await waitFor(() => unit!.bridge.calls.length === 1, "page_wait to reach the bridge");
    const cmd = unit.bridge.calls[0];
    expect(cmd.action).toBe("page_wait");
    expect(cmd.signal).toBeInstanceOf(AbortSignal);
    expect(cmd.signal!.aborted).toBe(false);
    expect(cmd.timeoutMs).toBe(15000 + 5000);

    ac.abort("user cancelled");
    expect(await pending).toStartWith("rejected");
    await waitFor(() => cmd.signal!.aborted, "the bridge signal to abort");
  });

  test("each request has its own signal: cancelling one leaves the other running", async () => {
    unit = await startUnitServer();
    const gates = new Map<string, (v: unknown) => void>();
    unit.bridge.responder = (cmd: SentCommand) =>
      cmd.action === "page_wait"
        ? untilAborted(cmd)
        : new Promise((resolve) => gates.set(cmd.action, resolve));
    const ac = new AbortController();
    const waiting = unit.call("page_wait", {}, { signal: ac.signal }).catch(() => "rejected");
    const typing = unit.call("dom_type", { selector: "#q", text: "hello" });
    await waitFor(() => unit!.bridge.calls.length === 2, "both commands");
    ac.abort();
    expect(await waiting).toBe("rejected");
    const typeCmd = unit.bridge.callsOf("dom_type")[0];
    expect(typeCmd.signal?.aborted).toBe(false);
    gates.get("dom_type")!({ ok: true, ref: "e1" });
    const res = await typing;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(texts(res)[0])).toEqual({ ok: true, ref: "e1" });
    expect(unit.bridge.callsOf("page_wait")[0].signal?.aborted).toBe(true);
  });

  test("ordinary tool calls pass a (not aborted) signal as the 5th argument", async () => {
    unit = await startUnitServer();
    await unit.call("dom_click", { selector: "a" });
    await unit.call("tab_navigate", { url: "https://example.test/" });
    for (const cmd of unit.bridge.calls) {
      expect(cmd.opts?.signal).toBeInstanceOf(AbortSignal);
      expect(cmd.signal?.aborted).toBe(false);
    }
  });
});

describe("tab_audio_capture cleanup", () => {
  const stopResult = { ok: true, tabId: 42, base64: "GkXfo59ChoEBQveBAQ==", mimeType: "audio/webm", durationMs: 50 };

  function audioResponder(cmd: SentCommand): unknown {
    if (cmd.action === "tab_audio_record_start") return { ok: true, tabId: 42 };
    if (cmd.action === "tab_audio_record_stop") return stopResult;
    return { ok: true };
  }

  test("start and stop are sent without a signal; the stop names the started tab in its payload", async () => {
    unit = await startUnitServer({ server: { toolsets: ["media"] } });
    unit.bridge.responder = audioResponder;
    const res = await unit.call("tab_audio_capture", { durationSeconds: 0.05 });
    expect(unit.bridge.calls.map((c) => c.action)).toEqual(["tab_audio_record_start", "tab_audio_record_stop"]);
    for (const c of unit.bridge.calls) expect(c.opts).toBeUndefined();
    const [start, stop] = unit.bridge.calls;
    expect(start.tabId).toBeUndefined();
    // The extension chose the active tab: it is named in the payload, never as
    // the command target (a command tabId would make it a full agent tab).
    expect(stop.tabId).toBeUndefined();
    expect(stop.payload).toEqual({ recordingTabId: 42 });
    expect(stop.timeoutMs).toBe(50 + 60000);
    expect(res.content.some((p) => p.type === "audio")).toBe(true);
  });

  test("with an explicit tabId the stop targets that tab and the payload stays empty", async () => {
    unit = await startUnitServer({ server: { toolsets: ["media"] } });
    unit.bridge.responder = audioResponder;
    await unit.call("tab_audio_capture", { durationSeconds: 0.05, tabId: 42 });
    const [start, stop] = unit.bridge.calls;
    expect(start.tabId).toBe(42);
    expect(stop.tabId).toBe(42);
    expect(stop.payload).toEqual({});
  });

  test("an extension that reports no tab id: the stop falls back to the single recording", async () => {
    unit = await startUnitServer({ server: { toolsets: ["media"] } });
    unit.bridge.responder = (cmd) => (cmd.action === "tab_audio_record_start" ? { ok: true } : audioResponder(cmd));
    await unit.call("tab_audio_capture", { durationSeconds: 0.05 });
    const stop = unit.bridge.callsOf("tab_audio_record_stop")[0];
    expect(stop.tabId).toBeUndefined();
    expect(stop.payload).toEqual({});
  });

  test("a cancel during the recording still stops it, without a signal", async () => {
    unit = await startUnitServer({ server: { toolsets: ["media"] } });
    unit.bridge.responder = audioResponder;
    const ac = new AbortController();
    const pending = unit.call("tab_audio_capture", { durationSeconds: 600, tabId: 42 }, { signal: ac.signal }).catch(() => "rejected");
    await waitFor(() => unit!.bridge.callsOf("tab_audio_record_start").length === 1, "the recording to start");
    const startedAt = Date.now();
    ac.abort();
    expect(await pending).toBe("rejected");
    await waitFor(() => unit!.bridge.callsOf("tab_audio_record_stop").length === 1, "the cleanup stop");
    expect(Date.now() - startedAt).toBeLessThan(2000);
    const stop = unit.bridge.callsOf("tab_audio_record_stop")[0];
    expect(stop.opts).toBeUndefined();
    expect(stop.tabId).toBe(42);
  });

  test("a cancel while the start is still running cannot skip the stop", async () => {
    unit = await startUnitServer({ server: { toolsets: ["media"] } });
    let releaseStart!: () => void;
    unit.bridge.responder = (cmd) =>
      cmd.action === "tab_audio_record_start"
        ? new Promise((resolve) => (releaseStart = () => resolve({ ok: true, tabId: 42 })))
        : audioResponder(cmd);
    const ac = new AbortController();
    const pending = unit.call("tab_audio_capture", { durationSeconds: 600 }, { signal: ac.signal }).catch(() => "rejected");
    await waitFor(() => unit!.bridge.callsOf("tab_audio_record_start").length === 1, "the start command");
    ac.abort();
    expect(await pending).toBe("rejected");
    releaseStart();
    await waitFor(() => unit!.bridge.callsOf("tab_audio_record_stop").length === 1, "the cleanup stop");
    const stop = unit.bridge.callsOf("tab_audio_record_stop")[0];
    expect(stop.opts).toBeUndefined();
    expect(stop.tabId).toBeUndefined();
    expect(stop.payload).toEqual({ recordingTabId: 42 });
  });
});
