import type { ResearchRun, StockSignal } from "@/types";
import { supabase } from "@/data/supabase/client";

/**
 * Shared daily compute - the read/write seam for the `daily_signals` cache.
 *
 * The free-tier rate-limit fix: the day's universe scan runs ONCE (the first
 * tester to open the app that market day computes it locally), then uploads the
 * finished {@link StockSignal}[] here. Every other tester that day READS this
 * cache instead of scanning - ZERO vendor API calls, no per-device Finnhub
 * 60/min burst. A reader's app is fully functional: the stored `signals` are the
 * exact published feed, so the same cards / scores / feeds render - the device
 * simply skips the compute.
 *
 * Uses the shared Supabase client (Tauri-aware fetch, public anon key) - these
 * are infrastructure reads/writes, NOT vendor market calls, so they deliberately
 * bypass the `httpText` vendor ledger / sample-mode gate. Every path degrades to
 * null/false on any error so the cache is a pure optimization: a miss just falls
 * back to a local scan, never a broken feed.
 */

const TABLE = "daily_signals";

/** True when Supabase is configured (web/phone bundle + desktop both qualify). */
export function isDailySignalsCacheConfigured(): boolean {
  return supabase !== null;
}

/**
 * The canonical shared "market day" key: the US/Eastern calendar date
 * (YYYY-MM-DD). Eastern time aligns every tester on the same US market day
 * regardless of their own timezone, so they all read/write the same row.
 */
export function marketDayKey(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; America/New_York is the US market calendar.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The market-regime read the SCAN scored this board with (published in meta so the
 *  client banner shows the same numbers the ranking used). Absent on older rows. */
export interface BoardRegimeMeta {
  riskOffness?: number;
  label?: string;
  fearGreed?: number;
  fearGreedLabel?: "extreme-fear" | "fear" | "neutral" | "greed" | "extreme-greed";
  fearGreedSource?: "cnn" | "internal";
  reason?: string;
}

export interface SharedDailySignals {
  signals: StockSignal[];
  /** The run that produced these signals (synthesized if the row predates it). */
  run: ResearchRun;
  /** ISO timestamp the first opener finished computing this day's scan. */
  computedAt: string;
  marketDay: string;
  /** Scan-time market regime (fear & greed + risk-offness); undefined on old rows. */
  regime?: BoardRegimeMeta;
}

/**
 * Freshness guard. The shared cache must NEVER let a reader present a prior
 * market day's signals as today's - a stale row under a "Live" badge is exactly
 * the fabricated-data class we forbid. A result is fresh only when its
 * `marketDay` equals the current US/Eastern market day. Callers should treat a
 * non-fresh (or absent) result as "today's scan hasn't landed yet" and show a
 * skeleton, rather than silently rendering whatever was computed last.
 */
export function isSharedSignalsFresh(
  shared: SharedDailySignals | null,
  now: Date = new Date(),
): shared is SharedDailySignals {
  return shared !== null && shared.marketDay === marketDayKey(now);
}

interface DailySignalsRow {
  market_day?: string;
  signals?: unknown;
  run?: unknown;
  computed_at?: string;
  meta?: { provider?: string; universeSize?: number; regime?: BoardRegimeMeta } | null;
}

/** Parse the scan-published regime meta, tolerating absent/garbage rows. */
function regimeFromMeta(meta: DailySignalsRow["meta"]): BoardRegimeMeta | undefined {
  const r = meta?.regime;
  if (!r || typeof r !== "object") return undefined;
  return r;
}

/** Build a minimal, valid ResearchRun for a cached row that didn't store one. */
function synthesizeRun(
  day: string,
  computedAt: string,
  signalCount: number,
  provider?: string,
): ResearchRun {
  return {
    id: `shared_${day}`,
    startedAt: computedAt,
    finishedAt: computedAt,
    provider: provider ?? "Shared daily compute",
    universeSize: signalCount,
    signalsGenerated: signalCount,
    trigger: "scheduled",
    status: "complete",
    stages: [],
  };
}

/**
 * Read today's already-computed signals from the shared cache. Returns null when
 * the cache isn't configured, there's no row for today yet (this device should
 * compute), or anything goes wrong - never throws.
 */
/**
 * Repair unsized market caps on a cached board.
 *
 * The FMP/HTTP layer is pulled in LAZILY rather than imported at module scope:
 * this seam only matters for the handful of foreign listings that came back
 * unsized, and a static import would drag the whole live-data + auth graph into
 * every consumer of this cache module (including tests that only care about the
 * Supabase read).
 */
async function withRepairedCaps(signals: StockSignal[]): Promise<StockSignal[]> {
  try {
    const { repairSignalMarketCaps } = await import("@/data/fundamentals/enrichMarketCap");
    return await repairSignalMarketCaps(signals);
  } catch {
    // Never let a cap backfill failure cost us the board itself.
    return signals;
  }
}

export async function fetchTodaySharedSignals(
  now: Date = new Date(),
): Promise<SharedDailySignals | null> {
  if (!supabase) return null;
  const day = marketDayKey(now);
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("market_day, signals, run, computed_at, meta")
      .eq("market_day", day)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as DailySignalsRow;

    // Freshness defense-in-depth: the query filters on today's `market_day`, but
    // never trust a row whose stored day disagrees with today - serving a prior
    // day's signals as "today" is the stale-data-under-a-Live-badge bug. Treat a
    // mismatch as a miss so the caller falls back to a fresh local scan/skeleton.
    if (typeof row.market_day === "string" && row.market_day !== day) return null;

    const signals = row.signals;
    if (!Array.isArray(signals) || signals.length === 0) return null;

    const computedAt =
      typeof row.computed_at === "string" ? row.computed_at : now.toISOString();
    const run =
      row.run && typeof row.run === "object"
        ? (row.run as ResearchRun)
        : synthesizeRun(day, computedAt, signals.length, row.meta?.provider);

    return {
      // Boards published BEFORE the currency-aware cap fix carry marketCap 0 for
      // foreign listings (Finnhub reported them in KRW/JPY/etc). Repair on read so
      // a $1.26T name stops rendering as "cap - " and stops slipping through the
      // user's market-cap filter, instead of waiting for the next scheduled scan.
      signals: await withRepairedCaps(signals as StockSignal[]),
      run,
      computedAt,
      marketDay: day,
      regime: regimeFromMeta(row.meta),
    };
  } catch {
    return null;
  }
}

/**
 * How many days old a published board may be and still count as "the most
 * recent" one worth showing (see {@link fetchRecentSharedSignals}). Exported
 * so the client-side IndexedDB fallback read (`readMostRecentCachedBoard` in
 * dailySignalsIdbCache.ts) uses the EXACT same staleness window instead of a
 * second hand-copied `5` that could silently drift from this one.
 */
export const SHARED_BOARD_MAX_AGE_DAYS = 5;

/**
 * Read the MOST RECENT published board, even if today's scan hasn't landed yet.
 *
 * The daily board is a once-per-day SNAPSHOT: scores are computed by the scheduled
 * scan and the live-price overlay (Alpaca) keeps the displayed prices current, so
 * showing yesterday's (or the last weekday's) board - carrying its OWN scan date -
 * is the correct, honest behavior, NOT the "stale-data-under-a-Live-badge" bug the
 * strict {@link fetchTodaySharedSignals} guards against: the returned `marketDay`
 * is the row's REAL date, so the UI labels it "as of <date>" rather than claiming
 * it's this instant's data. We still reject a genuinely STALE board (older than
 * `maxAgeDays`) so a months-dead row never resurfaces - a miss then falls through
 * to the honest empty state. This is what makes the app "boot straight to the
 * cached board" instead of showing an empty "scan now" prompt the morning before
 * the day's scan runs.
 */
export async function fetchRecentSharedSignals(
  now: Date = new Date(),
  maxAgeDays = SHARED_BOARD_MAX_AGE_DAYS,
): Promise<SharedDailySignals | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("market_day, signals, run, computed_at, meta")
      .order("market_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as DailySignalsRow;
    if (typeof row.market_day !== "string") return null;

    // Reject a genuinely stale board: a few days old (weekend / delayed run) is
    // fine, a months-old row is not "the latest" - it's stale. Future-dated rows
    // (clock skew) are rejected too.
    const todayMs = Date.parse(`${marketDayKey(now)}T00:00:00Z`);
    const rowMs = Date.parse(`${row.market_day}T00:00:00Z`);
    const ageDays = (todayMs - rowMs) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > maxAgeDays) return null;

    const signals = row.signals;
    if (!Array.isArray(signals) || signals.length === 0) return null;

    const computedAt =
      typeof row.computed_at === "string" ? row.computed_at : now.toISOString();
    const run =
      row.run && typeof row.run === "object"
        ? (row.run as ResearchRun)
        : synthesizeRun(row.market_day, computedAt, signals.length, row.meta?.provider);

    return {
      // Same repair as the strict path above - a cached board from before the
      // currency-aware cap fix must not render foreign listings as "cap - ".
      signals: await withRepairedCaps(signals as StockSignal[]),
      run,
      computedAt,
      marketDay: row.market_day,
      regime: regimeFromMeta(row.meta),
    };
  } catch {
    return null;
  }
}

/**
 * Publishing the shared daily feed is a TRUSTED, SERVER-ONLY operation - it is
 * NOT done from the client bundle.
 *
 * SECURITY (daily_signals trusted-writer hardening, migration 0013): the shipped
 * web bundle carries the public anon key, so any client that could INSERT into
 * `daily_signals` could pre-poison the day's shared feed with a fabricated but
 * shape-valid StockSignal[]. Because `market_day` is a first-writer-wins PRIMARY
 * KEY with no client UPDATE/DELETE, that poisoned row would then be read by every
 * other tester under a "Live" badge and stay immutable for the whole market day -
 * a violation of the no-fabricated-data rule.
 * So anon/authenticated INSERT was revoked; the ONLY writer is the trusted
 * broad-universe scan using the service-role key
 * (`scripts/universe_scan/upload.mjs`, run from the scheduled job / an edge
 * function), which bypasses RLS.
 *
 * This client-side function is therefore a deliberate no-op: it performs NO
 * network write and always returns false. It is kept (rather than deleted) so the
 * research-run call site stays a single fire-and-forget seam and so the contract
 * "the client never publishes" is explicit and testable. Reads still come from
 * {@link fetchTodaySharedSignals}; a device with a fresh local scan simply uses
 * its own feed until the trusted writer's row lands.
 */
export async function uploadTodaySharedSignals(
  _signals: StockSignal[],
  _run: ResearchRun | undefined,
  _now: Date = new Date(),
): Promise<boolean> {
  // Intentionally never writes from the client. Publishing is server-only via the
  // service-role key (see the doc comment above and migration 0013). Returning
  // false documents "this device did not publish" without touching the network.
  return false;
}
