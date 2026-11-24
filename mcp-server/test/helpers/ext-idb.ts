// A minimal IndexedDB for background.js in Bun (which has none): open with
// upgradeneeded, object stores with out-of-line keys, get / put / delete in
// readonly / readwrite transactions. Requests and transaction events fire
// asynchronously, like the real API. The data lives in a plain object that a
// ChromeStore carries, so two background instances over one store (a worker
// restart) see the same databases. Only what the extension uses is modelled.

export interface IdbDatabaseData {
  version: number;
  stores: Record<string, Map<unknown, unknown>>;
}

/** Databases by name. */
export type IdbData = Record<string, IdbDatabaseData>;

export interface FakeIdbOptions {
  /** When it returns true, open() fails with an error event (a broken profile). */
  fail?: () => boolean;
}

type Handler = ((ev: { target: unknown }) => void) | null;

const later = (fn: () => void) => setTimeout(fn, 0);

class FakeRequest {
  result: unknown = undefined;
  error: Error | null = null;
  readyState: "pending" | "done" = "pending";
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;

  succeed(result: unknown): void {
    this.readyState = "done";
    this.result = result;
    this.onsuccess?.({ target: this });
  }

  fail(error: Error): void {
    this.readyState = "done";
    this.error = error;
    this.onerror?.({ target: this });
  }
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: Map<unknown, unknown>
  ) {}

  get(key: unknown): FakeRequest {
    return this.tx.request(() => structuredClone(this.data.get(key)));
  }

  put(value: unknown, key: unknown): FakeRequest {
    this.tx.requireWrite();
    return this.tx.request(() => {
      this.data.set(key, structuredClone(value));
      return key;
    });
  }

  delete(key: unknown): FakeRequest {
    this.tx.requireWrite();
    return this.tx.request(() => {
      this.data.delete(key);
      return undefined;
    });
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private pending = 0;
  private finished = false;

  constructor(
    private readonly db: FakeDatabase,
    private readonly names: string[],
    private readonly mode: string
  ) {
    // A transaction with no request completes on its own.
    later(() => this.maybeComplete());
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) throw new DOMException(`No objectStore named ${name} in this transaction`, "NotFoundError");
    return new FakeObjectStore(this, this.db.data.stores[name]);
  }

  requireWrite(): void {
    if (this.mode !== "readwrite" && this.mode !== "versionchange") throw new DOMException("The transaction is read-only.", "ReadOnlyError");
  }

  request(op: () => unknown): FakeRequest {
    const req = new FakeRequest();
    this.pending++;
    later(() => {
      try {
        req.succeed(op());
      } catch (e) {
        req.fail(e as Error);
        this.error = e as Error;
        this.onerror?.({ target: this });
      }
      this.pending--;
      this.maybeComplete();
    });
    return req;
  }

  private maybeComplete(): void {
    if (this.finished || this.pending > 0) return;
    // Let follow-up requests made from onsuccess handlers join first.
    later(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      if (this.error) this.onabort?.({ target: this });
      else this.oncomplete?.({ target: this });
    });
  }
}

class FakeDatabase {
  onversionchange: Handler = null;
  onclose: Handler = null;
  closed = false;

  constructor(
    readonly name: string,
    readonly data: IdbDatabaseData
  ) {}

  get version(): number {
    return this.data.version;
  }

  get objectStoreNames(): { contains(n: string): boolean; length: number } {
    const names = Object.keys(this.data.stores);
    return { contains: (n: string) => names.includes(n), length: names.length };
  }

  createObjectStore(name: string): void {
    if (this.data.stores[name]) throw new DOMException(`Object store ${name} already exists`, "ConstraintError");
    this.data.stores[name] = new Map();
  }

  transaction(names: string | string[], mode = "readonly"): FakeTransaction {
    if (this.closed) throw new DOMException("The database connection is closing.", "InvalidStateError");
    const list = ([] as string[]).concat(names);
    for (const n of list) {
      if (!this.data.stores[n]) throw new DOMException(`No objectStore named ${n}`, "NotFoundError");
    }
    return new FakeTransaction(this, list, mode);
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeIndexedDB {
  /** open() calls, in order: [name, version]. */
  readonly opens: Array<[string, number]> = [];

  constructor(
    private readonly data: IdbData,
    private readonly opts: FakeIdbOptions = {}
  ) {}

  open(name: string, version?: number): FakeRequest {
    const req = new FakeRequest();
    const want = version ?? 1;
    this.opens.push([name, want]);
    later(() => {
      if (this.opts.fail?.()) {
        req.fail(new DOMException("Internal error opening backing store for indexedDB.open.", "UnknownError"));
        return;
      }
      let entry = this.data[name];
      const upgrade = !entry || entry.version < want;
      if (!entry) entry = this.data[name] = { version: 0, stores: {} };
      if (entry.version > want) {
        req.fail(new DOMException("The requested version is less than the existing version.", "VersionError"));
        return;
      }
      const db = new FakeDatabase(name, entry);
      req.result = db;
      if (upgrade) {
        entry.version = want;
        req.onupgradeneeded?.({ target: req });
      }
      req.succeed(db);
    });
    return req;
  }
}
