import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchRun, StockSignal } from "@/types";
import type { SharedDailySignals } from "@/data/dailySignalsCache";

/**
 * Tests for the IndexedDB write-through cache backing the cold-load fast path
 * (perf-diagnosis Finding #1). `vitest.config.ts` runs this suite under
 * `environment: "node"`, which has no real IndexedDB, so these tests install a
 * small hand-rolled fake on `globalThis.indexedDB` that mirrors exactly the
 * slice of the API the module under test calls (open/onupgradeneeded,
 * transaction/objectStore, get/put/getAllKeys/delete). This exercises the REAL
 * module code end to end rather than mocking it away.
 */

interface FakeRecord {
  [key: string]: unknown;
}

function createFakeIndexedDB() {
  const databases = new Map<
    string,
    { stores: Map<string, Map<string, FakeRecord>>; keyPaths: Map<string, string> }
  >();

  class FakeRequest {
    onsuccess: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result: unknown;
  }

  class FakeStore {
    constructor(
      private map: Map<string, FakeRecord>,
      private keyPath: string,
    ) {}
    get(key: string) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        req.result = this.map.get(key);
        req.onsuccess?.();
      });
      return req;
    }
    put(value: FakeRecord) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        this.map.set(String(value[this.keyPath]), value);
        req.result = value[this.keyPath];
        req.onsuccess?.();
      });
      return req;
    }
    getAllKeys() {
      const req = new FakeRequest();
      queueMicrotask(() => {
        req.result = [...this.map.keys()];
        req.onsuccess?.();
      });
      return req;
    }
    delete(key: string) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        this.map.delete(key);
        req.onsuccess?.();
      });
      return req;
    }
  }

  class FakeDb {
    stores = new Map<string, Map<string, FakeRecord>>();
    keyPaths = new Map<string, string>();
    objectStoreNames = {
      contains: (name: string) => this.stores.has(name),
    };
    createObjectStore(name: string, opts: { keyPath: string }) {
      this.stores.set(name, new Map());
      this.keyPaths.set(name, opts.keyPath);
    }
    transaction(name: string) {
      const store = this.stores.get(name)!;
      const keyPath = this.keyPaths.get(name)!;
      return { objectStore: () => new FakeStore(store, keyPath) };
    }
  }

  return {
    open(name: string) {
      const req = new FakeRequest() as FakeRequest & { onupgradeneeded: (() => void) | null };
      req.onupgradeneeded = null;
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) {
          db = { stores: new Map(), keyPaths: new Map() } as unknown as {
            stores: Map<string, Map<string, FakeRecord>>;
            keyPaths: Map<string, string>;
          };
        }
        const fakeDb = Object.assign(new FakeDb(), db);
        databases.set(name, fakeDb);
        req.result = fakeDb;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

function signal(ticker: string): StockSignal {
  return { ticker, priceHistory: [1, 2, 3] } as unknown as StockSignal;
}

const RUN: ResearchRun = {
  id: "run_idb_test",
  startedAt: "2026-09-15T13:00:00.000Z",
  finishedAt: "2026-09-15T13:02:00.000Z",
  provider: "Shared daily compute",
  universeSize: 1,
  signalsGenerated: 1,
  trigger: "scheduled",
  status: "complete",
  stages: [],
};

function board(marketDay: string, tickers: string[] = ["AAPL"]): SharedDailySignals {
  return {
    signals: tickers.map(signal),
    run: RUN,
    computedAt: `${marketDay}T13:02:00.000Z`,
    marketDay,
  };
}

const originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;

async function freshModule() {
  // Force a fresh module instance per test: the module intentionally memoizes
  // its `dbPromise` for the session (see dailySignalsIdbCache.ts) so it
  // doesn't retry a broken IndexedDB on every call - but that means, across
  // tests, it would otherwise keep pointing at a PRIOR test's fake database
  // even after `beforeEach` installs a brand-new fake on `globalThis.indexedDB`.
  // `resetModules()` clears that memoized state so each test's `openDb()` call
  // re-checks `indexedDB` fresh.
  vi.resetModules();
  const mod = await import("@/data/dailySignalsIdbCache");
  return mod;
}

describe("dailySignalsIdbCache", () => {
  beforeEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();
  });

  afterEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
  });

  it("writes a board then reads it back for the SAME market day", async () => {
    const { readCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-15", ["AAPL", "MSFT"]));
    const out = await readCachedBoard("2026-09-15");
    expect(out).not.toBeNull();
    expect(out!.signals.map((s) => s.ticker)).toEqual(["AAPL", "MSFT"]);
    expect(out!.run.id).toBe("run_idb_test");
    expect(out!.marketDay).toBe("2026-09-15");
  });

  it("returns null for a DIFFERENT market day — no fuzzy/'most recent' matching", async () => {
    const { readCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-12")); // e.g. last Friday's fallback board
    // Today (a later day) must NOT get served Friday's cached row from this
    // strict lookup - that freshness call belongs to marketDayKey()/
    // isSharedSignalsFresh(), not a second rule invented in this cache.
    expect(await readCachedBoard("2026-09-15")).toBeNull();
  });

  it("returns null on a cold cache (nothing written yet)", async () => {
    const { readCachedBoard } = await freshModule();
    expect(await readCachedBoard("2026-09-15")).toBeNull();
  });

  it("degrades to null/no-op when IndexedDB is unavailable", async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    const { readCachedBoard, writeCachedBoard } = await freshModule();
    await expect(writeCachedBoard(board("2026-09-15"))).resolves.toBeUndefined();
    await expect(readCachedBoard("2026-09-15")).resolves.toBeNull();
  });

  it("treats an empty signals array as no cache (never serves a broken record)", async () => {
    const { readCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-15", []));
    expect(await readCachedBoard("2026-09-15")).toBeNull();
  });

  it("prunes to the most recent entries once the bound is exceeded", async () => {
    const { readCachedBoard, writeCachedBoard } = await freshModule();
    const days = [
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
    ]; // 9 days written, cap is 7 - the oldest 2 should be evicted.
    for (const d of days) {
      await writeCachedBoard(board(d));
    }
    expect(await readCachedBoard("2026-09-01")).toBeNull();
    expect(await readCachedBoard("2026-09-02")).toBeNull();
    expect(await readCachedBoard("2026-09-11")).not.toBeNull();
    expect(await readCachedBoard("2026-09-08")).not.toBeNull();
  });
});

describe("dailySignalsIdbCache — readMostRecentCachedBoard (fallback-day tier)", () => {
  beforeEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();
  });
  afterEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
  });

  it("finds a recent prior day when today's exact day was never cached", async () => {
    const { readMostRecentCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-16", ["AAPL"])); // yesterday's fallback board
    const out = await readMostRecentCachedBoard("2026-09-17", 5);
    expect(out).not.toBeNull();
    expect(out!.marketDay).toBe("2026-09-16");
    expect(out!.signals.map((s) => s.ticker)).toEqual(["AAPL"]);
  });

  it("picks the MOST RECENT day when several are cached, not the oldest", async () => {
    const { readMostRecentCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-12", ["OLD"]));
    await writeCachedBoard(board("2026-09-15", ["NEWER"]));
    await writeCachedBoard(board("2026-09-14", ["MIDDLE"]));
    const out = await readMostRecentCachedBoard("2026-09-17", 5);
    expect(out!.marketDay).toBe("2026-09-15");
    expect(out!.signals.map((s) => s.ticker)).toEqual(["NEWER"]);
  });

  it("rejects a cached day older than maxAgeDays — a months-dead row never resurfaces", async () => {
    const { readMostRecentCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-08-01")); // ~47 days before 2026-09-17
    expect(await readMostRecentCachedBoard("2026-09-17", 5)).toBeNull();
  });

  it("rejects a future-dated cached day (clock skew) exactly like fetchRecentSharedSignals does", async () => {
    const { readMostRecentCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-20")); // "today" is 2026-09-17 in this call
    expect(await readMostRecentCachedBoard("2026-09-17", 5)).toBeNull();
  });

  it("still uses the exact-today record when it's the only (and most recent) one cached", async () => {
    const { readMostRecentCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-17", ["TODAY"]));
    const out = await readMostRecentCachedBoard("2026-09-17", 5);
    expect(out!.marketDay).toBe("2026-09-17");
  });

  it("returns null on a cold cache (nothing written yet)", async () => {
    const { readMostRecentCachedBoard } = await freshModule();
    expect(await readMostRecentCachedBoard("2026-09-17", 5)).toBeNull();
  });

  it("degrades to null when IndexedDB is unavailable", async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    const { readMostRecentCachedBoard } = await freshModule();
    await expect(readMostRecentCachedBoard("2026-09-17", 5)).resolves.toBeNull();
  });

  it("treats an empty signals array on the best-matching record as no cache", async () => {
    const { readMostRecentCachedBoard, writeCachedBoard } = await freshModule();
    await writeCachedBoard(board("2026-09-16", []));
    expect(await readMostRecentCachedBoard("2026-09-17", 5)).toBeNull();
  });
});

describe("dailySignalsIdbCache — ai-picks store", () => {
  beforeEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = createFakeIndexedDB();
  });
  afterEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
  });

  const pick = (rank: number, ticker: string) => ({ rank, ticker, market_day: "2026-09-17", created_at: "t1" });

  it("writes picks then reads them back for the SAME market day", async () => {
    const { readCachedAiPicks, writeCachedAiPicks } = await freshModule();
    await writeCachedAiPicks("2026-09-17", [pick(0, "DAKT"), pick(1, "COIN")]);
    const out = await readCachedAiPicks<{ ticker: string }>("2026-09-17");
    expect(out?.map((p) => p.ticker)).toEqual(["DAKT", "COIN"]);
  });

  it("a different market day is a miss — yesterday's picks never masquerade as today's", async () => {
    const { readCachedAiPicks, writeCachedAiPicks } = await freshModule();
    await writeCachedAiPicks("2026-09-16", [pick(0, "OLD")]);
    expect(await readCachedAiPicks("2026-09-17")).toBeNull();
  });

  it("lives beside the board store without colliding on the shared day key", async () => {
    const { readCachedBoard, writeCachedBoard, readCachedAiPicks, writeCachedAiPicks } = await freshModule();
    await writeCachedBoard(board("2026-09-17", ["AAPL"]));
    await writeCachedAiPicks("2026-09-17", [pick(0, "DAKT")]);
    expect((await readCachedBoard("2026-09-17"))?.signals.map((s) => s.ticker)).toEqual(["AAPL"]);
    expect((await readCachedAiPicks<{ ticker: string }>("2026-09-17"))?.map((p) => p.ticker)).toEqual(["DAKT"]);
  });

  it("degrades to null / no-op when IndexedDB is unavailable", async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    const { readCachedAiPicks, writeCachedAiPicks } = await freshModule();
    await expect(writeCachedAiPicks("2026-09-17", [pick(0, "X")])).resolves.toBeUndefined();
    expect(await readCachedAiPicks("2026-09-17")).toBeNull();
  });

  it("an empty list is never cached (a hit must always be renderable)", async () => {
    const { readCachedAiPicks, writeCachedAiPicks } = await freshModule();
    await writeCachedAiPicks("2026-09-17", []);
    expect(await readCachedAiPicks("2026-09-17")).toBeNull();
  });
});
