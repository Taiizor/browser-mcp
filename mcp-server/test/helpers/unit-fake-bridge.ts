// Fake IBridge for unit tests: records every send() and answers through a
// replaceable responder, with a controllable popup permission snapshot.
// No sockets, no files, no timers.
import type { BridgeStatusInfo, IBridge, SendOptions } from "../../src/bridge.js";

/** One bridge.send() call as the fake saw it. */
export interface SentCommand {
  action: string;
  payload: unknown;
  tabId?: number;
  timeoutMs?: number;
  /** The 5th argument exactly as given (undefined when the caller passed none). */
  opts?: SendOptions;
  /** Shortcut for opts?.signal. */
  signal?: AbortSignal;
}

export type Responder = (cmd: SentCommand) => unknown | Promise<unknown>;

/** An Error shaped like the real bridge's cancellation (name AbortError, message "cancelled"). */
export function abortError(): Error {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}

/**
 * Responder that never answers by itself: it settles only when the command's
 * signal aborts (rejecting like the real bridge does). Commands sent without
 * a signal stay pending forever, so use it only for abortable sends.
 */
export const untilAborted: Responder = (cmd) =>
  new Promise((_resolve, reject) => {
    const signal = cmd.signal;
    if (!signal) return;
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });

export class FakeBridge implements IBridge {
  port = 8765;
  connected = true;
  readonly mode = "primary" as const;
  consoleEvents: unknown[] = [];
  networkEvents: unknown[] = [];
  /** Every send() in call order. */
  readonly calls: SentCommand[] = [];
  /** Answers send(); a thrown error or rejected promise becomes the send() rejection. */
  responder: Responder = () => ({ ok: true });
  launches = 0;
  closes = 0;
  private disabled: string[] | null;
  private readonly listeners = new Set<(disabled: string[] | null) => void>();

  constructor(opts: { disabled?: readonly string[] | null } = {}) {
    this.disabled = opts.disabled ? [...opts.disabled] : null;
  }

  status(): BridgeStatusInfo {
    return { mode: "primary", pid: process.pid, peers: 0 };
  }

  knownDisabled(): string[] | null {
    return this.disabled ? [...this.disabled] : null;
  }

  onPermsChange(cb: (disabled: string[] | null) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Subscribers of onPermsChange right now (0 once every server unsubscribed). */
  get permListenerCount(): number {
    return this.listeners.size;
  }

  /** Simulates a popup change reported by the extension (perms event). */
  setDisabled(disabled: readonly string[] | null): void {
    this.disabled = disabled ? [...disabled] : null;
    for (const cb of [...this.listeners]) cb(this.knownDisabled());
  }

  send<T = unknown>(action: string, payload?: unknown, tabId?: number, timeoutMs?: number, opts?: SendOptions): Promise<T> {
    const cmd: SentCommand = { action, payload, tabId, timeoutMs, opts, signal: opts?.signal };
    this.calls.push(cmd);
    try {
      return Promise.resolve(this.responder(cmd)) as Promise<T>;
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Calls of one action, in order. */
  callsOf(action: string): SentCommand[] {
    return this.calls.filter((c) => c.action === action);
  }

  async launchBrowser(): Promise<{ connected: boolean; launched: boolean; detail: string }> {
    this.launches++;
    return { connected: true, launched: false, detail: "fake bridge" };
  }

  async closeBrowser(): Promise<{ closed: boolean; detail: string }> {
    this.closes++;
    return { closed: true, detail: "fake bridge" };
  }

  close(): void {}
}
