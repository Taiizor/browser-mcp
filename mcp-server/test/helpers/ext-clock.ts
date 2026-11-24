// Warpable clock for code loaded from extension/*.js (background.js).
//
// background.js runs its timers through setTimeout / setInterval and reads the
// time through Date.now(): 30 s session teardown, 15 s passthrough grace,
// 2 min Re-pair window, slow retries. The script is evaluated with these names
// bound to a WarpClock (see ext-background.ts), so a test can jump the
// extension's time forward without waiting and without fake-timering the rest
// of the process (the real server, WebSockets and happy-dom keep real time).
//
// Time flows normally; advance(ms) moves "now" forward and fires every timer
// that became due, in due order. dispose() cancels everything and turns later
// timer calls into no-ops, so a dropped background instance cannot reconnect
// or keep the test process busy.

type TimerFn = (...args: unknown[]) => void;

interface WarpTimer {
  fn: TimerFn;
  args: unknown[];
  due: number;
  interval: number | null;
  real: ReturnType<typeof setTimeout> | null;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const RealDate = globalThis.Date;

export class WarpClock {
  private offset = 0;
  private seq = 0;
  private readonly timers = new Map<number, WarpTimer>();
  private disposed = false;

  /** Current warped time in ms (real time plus every advance()). */
  now(): number {
    return RealDate.now() + this.offset;
  }

  /** Pending timer count (intervals included). */
  get pending(): number {
    return this.timers.size;
  }

  readonly setTimeout = (fn: TimerFn, ms?: number, ...args: unknown[]): number => this.add(fn, ms, args, false);

  readonly setInterval = (fn: TimerFn, ms?: number, ...args: unknown[]): number => this.add(fn, ms, args, true);

  readonly clearTimeout = (id?: number | null): void => {
    if (id == null) return;
    const t = this.timers.get(id);
    if (!t) return;
    if (t.real) realClearTimeout(t.real);
    this.timers.delete(id);
  };

  readonly clearInterval = this.clearTimeout;

  /** A Date class whose clock is this one (new Date() and Date.now()). */
  readonly Date: DateConstructor = makeDate(this);

  /**
   * Moves the clock forward by ms and fires every timer that is due by then,
   * earliest first (an interval fires once per advance at most). Resolves
   * after the fired callbacks' microtasks had a chance to run.
   */
  async advance(ms: number): Promise<void> {
    if (this.disposed) return;
    this.offset += ms;
    const now = this.now();
    const due = [...this.timers.entries()].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due);
    for (const [id] of due) {
      const t = this.timers.get(id);
      if (!t || t.due > now) continue;
      this.fire(id, t);
    }
    // Re-arm what is left against the new time.
    for (const [id, t] of this.timers) this.arm(id, t);
    await new Promise((r) => realSetTimeout(r, 0));
  }

  /** Cancels every timer; later timer calls are ignored. */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) if (t.real) realClearTimeout(t.real);
    this.timers.clear();
  }

  private add(fn: TimerFn, ms: number | undefined, args: unknown[], repeat: boolean): number {
    const id = ++this.seq;
    if (this.disposed || typeof fn !== "function") return id;
    const delay = Math.max(0, Number(ms) || 0);
    const t: WarpTimer = { fn, args, due: this.now() + delay, interval: repeat ? Math.max(1, delay) : null, real: null };
    this.timers.set(id, t);
    this.arm(id, t);
    return id;
  }

  private arm(id: number, t: WarpTimer): void {
    if (t.real) realClearTimeout(t.real);
    t.real = realSetTimeout(() => {
      t.real = null;
      if (this.timers.get(id) === t) this.fire(id, t);
    }, Math.max(0, t.due - this.now()));
  }

  private fire(id: number, t: WarpTimer): void {
    if (t.real) {
      realClearTimeout(t.real);
      t.real = null;
    }
    if (t.interval !== null) {
      t.due = this.now() + t.interval;
      this.arm(id, t);
    } else {
      this.timers.delete(id);
    }
    try {
      t.fn(...t.args);
    } catch (e) {
      // A throwing timer callback must not break the clock (background.js
      // timers never throw on purpose; surface it for the test log).
      console.error("[warp-clock] timer callback threw:", e);
    }
  }
}

function makeDate(clock: WarpClock): DateConstructor {
  class WarpDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now());
      else super(...(args as [string | number | Date]));
    }

    static override now(): number {
      return clock.now();
    }
  }
  return WarpDate as unknown as DateConstructor;
}
