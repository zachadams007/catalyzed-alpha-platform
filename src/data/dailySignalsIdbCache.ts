import type { SharedDailySignals } from "./dailySignalsCache";

/**
 * Local (IndexedDB) cache of the published daily board - the client-side half of
 * perf-diagnosis Finding #1 ("cache the daily universe outside localStorage's
 * quota").
 *
 * That safety property must be preserved: this module NEVER touches localStorage or the Zustand
 * persist config. IndexedDB has a much larger, async, per-origin quota (typically hundreds of
 * MB+ in every browser and in Tauri's native webview), so it can hold the full universe without
 * risking that failure mode, and reading/writing it never blocks the main thread.
 *
 * WHY HAND-ROLLED, NOT `idb-keyval`: the surface this module needs is exactly
 * "get one record by key, put one record, delete a few old keys" against a
 * single object store - about a hundred lines either way. Doing it inline
 * avoids adding a new runtime dependency (and its lockfile churn) for one call
 * site; see the perf-diagnosis implementation notes for the same reasoning.
 *
 * GRACEFUL DEGRADATION IS THE WHOLE CONTRACT: every exported function resolves
 * (never throws, never rejects) on ANY failure - private browsing, blocked
 * storage, a quota error, no IndexedDB support at all, a stuck/hanging open()
 * call, or a corrupted record. A cache failure must NEVER cost the user the
 * board: callers always still have the live network path
 * (`fetchRecentSharedSignals`) as the fallback. `readCachedBoard` additionally
 * races the whole read against a short timeout so a hung `indexedDB.open()`
 * (observed in some locked-down/ITP browser configurations) can't stall boot
 * longer than the network path it exists to avoid.
 */

const DB_NAME = "catalyzed-alpha";
/** v2 added the `ai-picks` store. Bump again whenever a store is added; the
 *  upgrade handler below creates whatever is missing, so upgrades are additive. */
const DB_VERSION = 2;
const STORE_NAME = "daily-signals-board";
/** Second store: the AI Pick of the Day rows, keyed by market day. Kept separate
 *  because it has a different record shape AND different freshness semantics -
 *  see readCachedAiPicks. */
const PICKS_STORE = "ai-picks";
/** keyPath field name inside each stored record - the row's own market day. */
const KEY_PATH = "marketDay";
/** Bound how many market-day rows accumulate so IndexedDB usage never grows
 *  unbounded across months of use. marketDay strings ("YYYY-MM-DD") sort
 *  chronologically, so pruning is a plain lexicographic sort + slice. */
const MAX_ENTRIES = 7;
/** A hung `indexedDB.open()` must never cost more than this - comfortably
 *  under the ~600-1300ms the network fetch this cache is meant to preempt. */
const OPEN_TIMEOUT_MS = 400;

interface CachedBoardRecord {
  marketDay: string;
  signals: SharedDailySignals["signals"];
  run: SharedDailySignals["run"];
  computedAt: string;
  regime?: SharedDailySignals["regime"];
  /** When THIS DEVICE wrote the record - for pruning, not the scan time. */
  cachedAt: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

// Memoized across the session: if the first open fails (or IndexedDB isn't
// available at all), that's a static fact about this browser/session, so we
// don't retry on every call - we just keep degrading to the network path.
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === "undefined") {
          resolve(null);
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          try {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
              db.createObjectStore(STORE_NAME, { keyPath: KEY_PATH });
            }
            if (!db.objectStoreNames.contains(PICKS_STORE)) {
              db.createObjectStore(PICKS_STORE, { keyPath: KEY_PATH });
            }
          } catch {
            // If the upgrade itself fails, onsuccess/onerror below still settles
            // this promise (typically onerror) - nothing further to do here.
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        // Another tab holding an older version open - never worth waiting on;
        // degrade to the network path exactly like any other failure.
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function getStore(
  mode: IDBTransactionMode,
  name: string = STORE_NAME,
): Promise<IDBObjectStore | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return db.transaction(name, mode).objectStore(name);
  } catch {
    return null;
  }
}

function isValidRecord(rec: unknown, expectedKey: string): rec is CachedBoardRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Partial<CachedBoardRecord>;
  return (
    r.marketDay === expectedKey &&
    Array.isArray(r.signals) &&
    r.signals.length > 0 &&
    typeof r.run === "object" &&
    r.run !== null &&
    typeof r.computedAt === "string"
  );
}

/**
 * Read the cached board for EXACTLY this market day (no fuzzy/"most recent"
 * matching here - that freshness call belongs to `marketDayKey()` /
 * `isSharedSignalsFresh()` in dailySignalsCache.ts, not a second rule invented
 * here). Resolves null on a miss, a corrupted record, any storage failure, or
 * timeout - every case degrades identically so callers need one fallback path.
 */
export async function readCachedBoard(marketDay: string): Promise<SharedDailySignals | null> {
  const read = (async (): Promise<SharedDailySignals | null> => {
    try {
      const store = await getStore("readonly");
      if (!store) return null;
      return await new Promise<SharedDailySignals | null>((resolve) => {
        try {
          const req = store.get(marketDay);
          req.onsuccess = () => {
            const rec: unknown = req.result;
            if (!isValidRecord(rec, marketDay)) {
              resolve(null);
              return;
            }
            resolve({
              signals: rec.signals,
              run: rec.run,
              computedAt: rec.computedAt,
              marketDay: rec.marketDay,
              regime: rec.regime,
            });
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      return null;
    }
  })();
  return withTimeout(read, OPEN_TIMEOUT_MS, null);
}

/**
 * Fallback read for when today's EXACT market day isn't cached on this device
 * yet, but a recent prior day's board already is.
 *
 * WHY THIS EXISTS: `fetchRecentSharedSignals` (dailySignalsCache.ts) can
 * legitimately return a board dated BEFORE today - pre-scan hours, a delayed
 * or failed nightly Action, a weekend the scan didn't cover - and
 * `writeCachedBoard` correctly keys that record by the row's OWN `marketDay`
 * (never today's, so the record never dishonestly claims to be "computed
 * today"). But that means on a day with no fresh scan yet, the record written
 * after the FIRST network fetch is keyed by yesterday's date, not today's -
 * so a strict `readCachedBoard(todayKey)` lookup misses on EVERY open that
 * day, not just the first, silently forcing a repeat ~5MB network fetch on
 * every single open until the calendar rolls over. That defeats Finding #1's
 * fast path on exactly the days it matters most.
 *
 * This closes that gap without loosening `readCachedBoard`'s own strict,
 * no-fuzzy-matching contract: it's a SEPARATE, explicit "is there anything
 * recent enough already sitting in IndexedDB" check, tried only after the
 * exact-key lookup misses. It mirrors `fetchRecentSharedSignals`'s own
 * "most recent, within maxAgeDays, never future-dated" staleness math
 * client-side - callers should pass the SAME `maxAgeDays` used there
 * ({@link SHARED_BOARD_MAX_AGE_DAYS} in dailySignalsCache.ts) so what counts
 * as "recent enough" never drifts between the two layers. Resolves null on a
 * cold cache, every entry being too stale/future-dated, or any storage
 * failure - degrades exactly like `readCachedBoard`, so callers need one
 * fallback path (the existing network fetch) either way.
 */
export async function readMostRecentCachedBoard(
  todayKey: string,
  maxAgeDays: number,
): Promise<SharedDailySignals | null> {
  const read = (async (): Promise<SharedDailySignals | null> => {
    try {
      const store = await getStore("readonly");
      if (!store) return null;
      const keys = await new Promise<string[]>((resolve) => {
        try {
          const req = store.getAllKeys();
          req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
      if (keys.length === 0) return null;

      // Same staleness math as fetchRecentSharedSignals: reject a future-dated
      // key (clock skew) and anything older than maxAgeDays. Keys are plain
      // "YYYY-MM-DD" strings, so a lexicographic sort orders them chronologically
      // - no Date parsing needed to find the candidate order, only to bound it.
      const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
      const bestKey = keys
        .filter((k) => {
          const keyMs = Date.parse(`${k}T00:00:00Z`);
          const ageDays = (todayMs - keyMs) / 86_400_000;
          return Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= maxAgeDays;
        })
        .sort()
        .pop();
      if (!bestKey) return null;

      return await new Promise<SharedDailySignals | null>((resolve) => {
        try {
          const req = store.get(bestKey);
          req.onsuccess = () => {
            const rec: unknown = req.result;
            if (!isValidRecord(rec, bestKey)) {
              resolve(null);
              return;
            }
            resolve({
              signals: rec.signals,
              run: rec.run,
              computedAt: rec.computedAt,
              marketDay: rec.marketDay,
              regime: rec.regime,
            });
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      return null;
    }
  })();
  return withTimeout(read, OPEN_TIMEOUT_MS, null);
}

/**
 * Write-through cache of a freshly-fetched board (from the network path),
 * keyed by the row's OWN `marketDay` - best-effort, fire-and-forget safe: never
 * throws, resolves regardless of outcome. Callers should `void` this call
 * rather than await it; nothing user-visible should ever depend on it
 * finishing.
 */
export async function writeCachedBoard(board: SharedDailySignals): Promise<void> {
  try {
    const store = await getStore("readwrite");
    if (!store) return;
    const record: CachedBoardRecord = {
      marketDay: board.marketDay,
      signals: board.signals,
      run: board.run,
      computedAt: board.computedAt,
      regime: board.regime,
      cachedAt: new Date().toISOString(),
    };
    await new Promise<void>((resolve) => {
      try {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
    await pruneOldEntries();
  } catch {
    // Never let a cache-write failure surface to the caller.
  }
}

/** Best-effort: keep only the MAX_ENTRIES most recent market-day rows. */
async function pruneOldEntries(): Promise<void> {
  try {
    const store = await getStore("readwrite");
    if (!store) return;
    await new Promise<void>((resolve) => {
      try {
        const req = store.getAllKeys();
        req.onsuccess = () => {
          try {
            const keys = (req.result as IDBValidKey[]).map(String).sort();
            const excess = keys.length - MAX_ENTRIES;
            if (excess > 0) {
              for (const key of keys.slice(0, excess)) {
                try {
                  store.delete(key);
                } catch {
                  // best-effort - a stuck delete just leaves one extra row.
                }
              }
            }
          } finally {
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // Pruning is pure housekeeping; a failure here never affects reads/writes.
  }
}

/* ── AI Pick of the Day ──────────────────────────────────────────────────────
 * Same idea as the board cache, DIFFERENT freshness contract. `daily_signals`
 * is first-writer-wins and immutable for the day, so a board hit is final. The
 * `ai_picks` writer (supabase/functions/ai-pick) DELETES today's rows and
 * re-inserts on every run, so a mid-day re-run can legitimately change the
 * picks. A cached copy is therefore only ever a first paint - the caller MUST
 * still fetch and reconcile (stale-while-revalidate), never treat a hit as
 * final. The win is killing the skeleton flash on every open, not the ~80ms
 * fetch itself.
 */

/** Minimal structural shape we persist - the hero needs the whole row. */
export interface CachedAiPicks<T = unknown> {
  marketDay: string;
  picks: T[];
  cachedAt: string;
}

export async function readCachedAiPicks<T = unknown>(marketDay: string): Promise<T[] | null> {
  const read = (async (): Promise<T[] | null> => {
    try {
      const store = await getStore("readonly", PICKS_STORE);
      if (!store) return null;
      return await new Promise<T[] | null>((resolve) => {
        try {
          const req = store.get(marketDay);
          req.onsuccess = () => {
            const rec = req.result as Partial<CachedAiPicks<T>> | undefined;
            if (!rec || rec.marketDay !== marketDay || !Array.isArray(rec.picks) || rec.picks.length === 0) {
              resolve(null);
              return;
            }
            resolve(rec.picks);
          };
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      return null;
    }
  })();
  return withTimeout(read, OPEN_TIMEOUT_MS, null);
}

/** Best-effort write-through; never throws. Keyed by the rows' OWN market day. */
export async function writeCachedAiPicks<T>(marketDay: string, picks: T[]): Promise<void> {
  if (!marketDay || picks.length === 0) return;
  try {
    const store = await getStore("readwrite", PICKS_STORE);
    if (!store) return;
    const record: CachedAiPicks<T> = { marketDay, picks, cachedAt: new Date().toISOString() };
    await new Promise<void>((resolve) => {
      try {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    // Never surface a cache-write failure.
  }
}
