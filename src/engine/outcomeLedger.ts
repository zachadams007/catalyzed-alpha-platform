import type { ScoreCategoryKey, StockSignal } from "@/types";
import { ENGINE_VARIANTS, type EngineVariantId } from "./challenger";
import { round } from "@/lib/math";

/**
 * The outcome ledger - Phase 0 of the adaptive-algorithm program
 * (see docs/program/adaptive-algorithm-brief.md §5).
 *
 * It is the *measurement substrate*: an append-only record of how every
 * published signal was scored, so that over time we can answer the only
 * question that matters - **did a higher opportunity score actually predict a
 * better forward return?** Nothing here changes scoring, weights, bands, or
 * ranking. It is purely observational and additive.
 *
 * Everything in this file is a PURE function (project law): same input always
 * yields the same output, no side effects, no `Date.now()` inside - the caller
 * supplies `nowISO`. That keeps it trivially unit-testable and lets the learning
 * loop move server-side later untouched.
 *
 * No look-ahead bias: forward returns are only ever filled from prices observed
 * AT OR AFTER the window has elapsed, never reconstructed from the future.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The forward-return windows we track, in days. */
export const WINDOW_DAYS = { d7: 7, d20: 20, d30: 30, d90: 90, d252: 252 } as const;

export type ForwardWindow = keyof typeof WINDOW_DAYS;

export const FORWARD_WINDOWS: ForwardWindow[] = ["d7", "d20", "d30", "d90", "d252"];

export const WINDOW_LABEL: Record<ForwardWindow, string> = {
  d7: "7-day",
  d20: "20-day",
  d30: "30-day",
  d90: "90-day",
  d252: "12-month",
};

/** Realized forward returns (as ratios; 0.12 = +12%), filled in once elapsed. */
export interface ForwardReturns {
  d7?: number;
  d20?: number;
  d30?: number;
  d90?: number;
  d252?: number;
}

/** The engine variants whose scores are recorded against the same outcome. */
export type ModelId = "champion" | "challenger";

/** One model's view of a pick at publish - its score + per-category snapshot. */
export interface OutcomeModelScore {
  /** Blended opportunity score, 0..100, under this model. */
  opportunityScore: number;
  /** Per-category sub-scores (0..100) under this model - the feature snapshot. */
  categoryScores: Partial<Record<ScoreCategoryKey, number>>;
}

/**
 * One published pick, snapshotted at publish time. The feature snapshot
 * (`opportunityScore`, `confidence`, `categoryScores`) is frozen so a later
 * recalibration can correlate it against the forward returns without any
 * look-ahead.
 *
 * The forward returns are model-agnostic (same price, same window), so a single
 * entry can carry BOTH models' scores via `modelScores` and the champion/
 * challenger comparison correlates each against the identical realized outcome.
 * The top-level `opportunityScore`/`categoryScores` remain the CHAMPION snapshot
 * for back-compat with the existing performance view.
 */
export interface OutcomeEntry {
  /** Uppercase ticker. */
  ticker: string;
  /** Company name at publish (for display in the performance view). */
  name: string;
  /** ISO timestamp this pick was published (the research run's finish time). */
  publishedAtISO: string;
  /** Blended opportunity score, 0..100, at publish (CHAMPION). */
  opportunityScore: number;
  /** Confidence, 0..100, at publish. */
  confidence: number;
  /** Per-category sub-scores (0..100) at publish (CHAMPION) - the feature snapshot. */
  categoryScores: Partial<Record<ScoreCategoryKey, number>>;
  /**
   * Both engine variants' scores for this same pick (same price, same forward
   * returns). Absent on entries recorded before the champion/challenger upgrade.
   */
  modelScores?: Partial<Record<ModelId, OutcomeModelScore>>;
  /**
   * WHICH ENGINE VERSION MADE THIS PICK (v3). The ledger already stored both
   * models' scores for every pick, but never which variant was actually LIVE
   * when the pick was published - so the Track Record could not separate a V5
   * call from a V7 call, and a new version's results were mixed into the old
   * version's history. Absent on entries recorded before this field existed;
   * the UI shows those as "untagged" rather than guessing.
   */
  liveVariant?: EngineVariantId;
  /** Spot price at publish, USD (the cost basis for forward returns). */
  priceAtPublish: number;
  /** Forward returns, filled in run-by-run as each window elapses. */
  forwardReturns: ForwardReturns;
}

/** The append-only, size-bounded ledger persisted in the store. */
export interface OutcomeLedger {
  /** Schema version for forward migrations of the entry shape itself. */
  schemaVersion: number;
  /** Tracked picks, oldest → newest. */
  entries: OutcomeEntry[];
  /** Count of entries the size cap has rotated out (transparency: no silent caps). */
  droppedCount: number;
}

/** Schema version of an individual entry's shape. v2 added `modelScores`; v3 added `liveVariant`. */
export const LEDGER_SCHEMA_VERSION = 3;

/**
 * Max entries retained. Bounds the persisted size (localStorage-backed). At
 * roughly ~0.3KB/entry this caps the ledger near ~1.5MB. When exceeded we keep
 * the most recent N and surface the dropped count - never a silent truncation.
 */
export const DEFAULT_MAX_ENTRIES = 5000;

/** Below this many measured outcomes, decile patterns are not yet trustworthy. */
export const MIN_MEANINGFUL_SAMPLE = 30;

const DAY_MS = 86_400_000;

/** A fresh, empty ledger - the default for new and migrated stores. */
export function emptyLedger(): OutcomeLedger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [], droppedCount: 0 };
}

/**
 * Coerce an unknown persisted value into a valid ledger. Tolerant by design so
 * a corrupt or partial blob degrades to empty rather than throwing at runtime.
 */
export function normalizeLedger(value: unknown): OutcomeLedger {
  if (!value || typeof value !== "object") return emptyLedger();
  const v = value as Partial<OutcomeLedger>;
  if (!Array.isArray(v.entries)) return emptyLedger();
  return {
    schemaVersion:
      typeof v.schemaVersion === "number" ? v.schemaVersion : LEDGER_SCHEMA_VERSION,
    entries: v.entries.filter(isValidEntry).map(coerceLiveVariant),
    droppedCount: typeof v.droppedCount === "number" && v.droppedCount >= 0 ? v.droppedCount : 0,
  };
}

/**
 * Forward-migrate `liveVariant`: an unknown value (a variant id retired in a
 * later build) is dropped rather than failing the whole entry, so history is
 * never lost to a rename - it just reads as untagged.
 */
function coerceLiveVariant(e: OutcomeEntry): OutcomeEntry {
  const v = (e as { liveVariant?: unknown }).liveVariant;
  if (v == null) return e;
  if ((ENGINE_VARIANTS as readonly string[]).includes(v as string)) return e;
  const { liveVariant: _dropped, ...rest } = e;
  return rest;
}

/** The Track Record's version filter: every pick, one engine version, or the pre-tagging ones. */
export type LedgerVersionFilter = "all" | "untagged" | EngineVariantId;

/**
 * Restrict a ledger to picks made by one engine version (or to the untagged,
 * pre-v3 picks). Pure: returns a NEW ledger; `droppedCount` is carried through
 * unchanged because it describes the whole history, not the slice.
 */
export function filterLedgerByVariant(ledger: OutcomeLedger, filter: LedgerVersionFilter): OutcomeLedger {
  const base = normalizeLedger(ledger);
  if (filter === "all") return base;
  const entries = base.entries.filter((e) =>
    filter === "untagged" ? e.liveVariant == null : e.liveVariant === filter,
  );
  return { ...base, entries };
}

/** Which versions actually appear in a ledger, in engine order, plus whether untagged picks exist. */
export function ledgerVersionsPresent(ledger: OutcomeLedger): {
  variants: EngineVariantId[];
  hasUntagged: boolean;
} {
  const base = normalizeLedger(ledger);
  const seen = new Set<EngineVariantId>();
  let hasUntagged = false;
  for (const e of base.entries) {
    if (e.liveVariant) seen.add(e.liveVariant);
    else hasUntagged = true;
  }
  return { variants: ENGINE_VARIANTS.filter((v) => seen.has(v)), hasUntagged };
}

function isValidEntry(e: unknown): e is OutcomeEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<OutcomeEntry>;
  return (
    typeof x.ticker === "string" &&
    typeof x.publishedAtISO === "string" &&
    typeof x.opportunityScore === "number" &&
    typeof x.priceAtPublish === "number" &&
    !!x.forwardReturns &&
    typeof x.forwardReturns === "object"
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The calendar day a timestamp belongs to (UTC), used for daily dedupe. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function entryKey(ticker: string, iso: string): string {
  return `${ticker}@${dayKey(iso)}`;
}

/** Build a ticker → current price map from a set of signals (price > 0 only). */
function priceMap(signals: StockSignal[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of signals) {
    if (s && typeof s.price === "number" && s.price > 0) {
      map.set(s.ticker, s.price);
    }
  }
  return map;
}

function snapshotCategoryScores(signal: StockSignal): Partial<Record<ScoreCategoryKey, number>> {
  const out: Partial<Record<ScoreCategoryKey, number>> = {};
  for (const cat of signal.score?.categories ?? []) {
    out[cat.key] = cat.score;
  }
  return out;
}

function signalToEntry(
  signal: StockSignal,
  nowISO: string,
  models?: Partial<Record<ModelId, OutcomeModelScore>>,
  liveVariant?: EngineVariantId,
): OutcomeEntry {
  // The CHAMPION model is the top-level snapshot (back-compat). When a model map
  // is supplied, prefer its champion view; otherwise fall back to the signal.
  const champion = models?.champion;
  return {
    ticker: signal.ticker,
    name: signal.name,
    publishedAtISO: nowISO,
    opportunityScore: champion?.opportunityScore ?? signal.score.opportunityScore,
    confidence: signal.confidence ?? signal.score.confidence,
    categoryScores: champion?.categoryScores ?? snapshotCategoryScores(signal),
    priceAtPublish: signal.price,
    forwardReturns: {},
    ...(models ? { modelScores: models } : {}),
    ...(liveVariant ? { liveVariant } : {}),
  };
}

/** Most-recent-first comparator with a stable ticker tiebreak. */
function byRecencyDesc(a: OutcomeEntry, b: OutcomeEntry): number {
  if (a.publishedAtISO !== b.publishedAtISO) {
    return a.publishedAtISO < b.publishedAtISO ? 1 : -1;
  }
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}

function byRecencyAsc(a: OutcomeEntry, b: OutcomeEntry): number {
  return -byRecencyDesc(a, b);
}

// ---------------------------------------------------------------------------
// 1. appendOutcomes - record this run's published picks
// ---------------------------------------------------------------------------

/**
 * Append a research run's published signals to the ledger as fresh outcome
 * entries, deduped by ticker + publish-day (re-running the same day never
 * double-records a ticker). Signals without a usable price are skipped - there's
 * nothing to measure a forward return against.
 *
 * Pure: returns a NEW ledger; the input is never mutated. When the result would
 * exceed `maxEntries`, the most recent N are kept and `droppedCount` grows by
 * the number rotated out.
 */
export function appendOutcomes(
  ledger: OutcomeLedger,
  signals: StockSignal[],
  nowISO: string,
  opts: {
    maxEntries?: number;
    /** Per-ticker champion+challenger scores recorded against this run's picks. */
    models?: Map<string, Partial<Record<ModelId, OutcomeModelScore>>>;
    /** The engine variant that was LIVE when these picks were published. */
    liveVariant?: EngineVariantId;
  } = {},
): OutcomeLedger {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const base = normalizeLedger(ledger);

  const existingKeys = new Set(base.entries.map((e) => entryKey(e.ticker, e.publishedAtISO)));
  const additions: OutcomeEntry[] = [];

  for (const signal of signals) {
    if (!signal?.ticker || !(signal.price > 0)) continue;
    if (!signal.score || typeof signal.score.opportunityScore !== "number") continue;
    const key = entryKey(signal.ticker, nowISO);
    if (existingKeys.has(key)) continue; // already recorded this ticker today
    existingKeys.add(key);
    additions.push(signalToEntry(signal, nowISO, opts.models?.get(signal.ticker), opts.liveVariant));
  }

  if (additions.length === 0) return base;

  let entries = [...base.entries, ...additions];
  let droppedCount = base.droppedCount;

  if (entries.length > maxEntries) {
    const dropped = entries.length - maxEntries;
    // Keep the most recent N, then restore chronological (oldest → newest) order.
    entries = entries.sort(byRecencyDesc).slice(0, maxEntries).sort(byRecencyAsc);
    droppedCount += dropped;
  }

  return { schemaVersion: base.schemaVersion, entries, droppedCount };
}

// ---------------------------------------------------------------------------
// 2. updateForwardReturns - fill returns whose windows have elapsed
// ---------------------------------------------------------------------------

/**
 * Fill the d7/d30/d90 forward return of any past entry whose window has elapsed,
 * using the ticker's CURRENT price (from this run's signals) versus its
 * price-at-publish. Already-filled windows are never overwritten - the first
 * realized read for a window is kept, so the value reflects the price observed
 * once that window first closed (no look-ahead, no churn).
 *
 * A missed run means a window may first be read slightly after its exact
 * boundary; that's an honest approximation, not a fabrication.
 *
 * Pure: returns a NEW ledger; entries that don't change keep their identity.
 */
export function updateForwardReturns(
  ledger: OutcomeLedger,
  currentSignals: StockSignal[],
  nowISO: string,
): OutcomeLedger {
  const base = normalizeLedger(ledger);
  const nowMs = Date.parse(nowISO);
  if (Number.isNaN(nowMs)) return base;

  const prices = priceMap(currentSignals);
  if (prices.size === 0) return base;

  let changed = false;
  const entries = base.entries.map((entry) => {
    const publishedMs = Date.parse(entry.publishedAtISO);
    if (Number.isNaN(publishedMs) || entry.priceAtPublish <= 0) return entry;

    const currentPrice = prices.get(entry.ticker);
    if (currentPrice == null) return entry; // no fresh price → leave pending

    const elapsedDays = (nowMs - publishedMs) / DAY_MS;
    let next: ForwardReturns | null = null;

    for (const window of FORWARD_WINDOWS) {
      if (entry.forwardReturns[window] != null) continue; // first read wins
      if (elapsedDays < WINDOW_DAYS[window]) continue; // window hasn't closed yet
      const ret = round((currentPrice - entry.priceAtPublish) / entry.priceAtPublish, 4);
      next = { ...(next ?? entry.forwardReturns), [window]: ret };
    }

    if (!next) return entry;
    changed = true;
    return { ...entry, forwardReturns: next };
  });

  if (!changed) return base;
  return { schemaVersion: base.schemaVersion, entries, droppedCount: base.droppedCount };
}

// ---------------------------------------------------------------------------
// 3. summarizePerformance - the honest "how are our picks doing?" read
// ---------------------------------------------------------------------------

/** One score band (decile/quintile/…) with its realized performance. */
export interface ScoreBucketStat {
  /** 1-based rank within the bucketing (1 = lowest scores). */
  index: number;
  /** Total buckets in this summary (10 = deciles, 5 = quintiles, …). */
  of: number;
  /** Opportunity-score range covered by this bucket. */
  scoreRange: { min: number; max: number };
  /** Measured outcomes in this bucket. */
  count: number;
  /** Fraction with a positive forward return, 0..1. */
  hitRate: number;
  /** Mean forward return (ratio) in this bucket. */
  avgForwardReturn: number;
}

/** A single best/worst pick, for the highlights rails. */
export interface OutcomeHighlight {
  ticker: string;
  name: string;
  opportunityScore: number;
  /** The forward return used (the summary's primary window), as a ratio. */
  forwardReturn: number;
  window: ForwardWindow;
  publishedAtISO: string;
  /** Engine version that made the pick; absent for pre-tagging history. */
  liveVariant?: EngineVariantId;
}

export interface PerformanceSummary {
  /** Total picks recorded (whether or not a window has closed yet). */
  totalTracked: number;
  /** Picks with at least one realized forward return on the primary window. */
  measuredCount: number;
  /** The window the deciles + highlights are computed on (best-covered). */
  primaryWindow: ForwardWindow;
  /** Measured-outcome counts per window (for "d7: 40 · d30: 12 · d90: 0"). */
  windowCoverage: Record<ForwardWindow, number>;
  /** Score bands, lowest → highest, on the primary window. */
  byScoreDecile: ScoreBucketStat[];
  /** Top-decile avg return minus bottom-decile avg return (the lift). */
  lift?: number;
  /** Overall hit rate across measured picks, 0..1. */
  overallHitRate: number;
  /** Overall mean forward return (ratio). */
  overallAvgReturn: number;
  topHits: OutcomeHighlight[];
  worstMisses: OutcomeHighlight[];
  /** True when the measured sample is too small for the bands to be conclusive. */
  lowSample: boolean;
  /** Entries rotated out of the capped ledger. */
  droppedCount: number;
  /** Plain-English honesty about coverage, small samples, and rotation. */
  coverageNote: string;
}

interface Measured {
  entry: OutcomeEntry;
  ret: number;
}

function chooseBucketCount(n: number): number {
  if (n >= 100) return 10; // deciles
  if (n >= 50) return 5; // quintiles
  if (n >= 20) return 4; // quartiles
  if (n >= 10) return 2; // halves
  return n >= 1 ? 1 : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Split rank-sorted measured outcomes into `count` near-equal score bands. */
function bucketize(sortedAsc: Measured[], count: number): ScoreBucketStat[] {
  if (count <= 0 || sortedAsc.length === 0) return [];
  const total = sortedAsc.length;
  const buckets: ScoreBucketStat[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * total) / count);
    const end = Math.floor(((i + 1) * total) / count);
    const slice = sortedAsc.slice(start, end);
    if (slice.length === 0) continue;
    const rets = slice.map((m) => m.ret);
    const scores = slice.map((m) => m.entry.opportunityScore);
    buckets.push({
      index: i + 1,
      of: count,
      scoreRange: { min: Math.min(...scores), max: Math.max(...scores) },
      count: slice.length,
      hitRate: round(slice.filter((m) => m.ret > 0).length / slice.length, 4),
      avgForwardReturn: round(mean(rets), 4),
    });
  }
  return buckets;
}

function pickPrimaryWindow(coverage: Record<ForwardWindow, number>): ForwardWindow {
  // Most-covered window wins; ties prefer the longer (more meaningful) horizon.
  let best: ForwardWindow = "d7";
  for (const w of FORWARD_WINDOWS) {
    if (coverage[w] > coverage[best] || (coverage[w] === coverage[best] && WINDOW_DAYS[w] > WINDOW_DAYS[best])) {
      best = w;
    }
  }
  return best;
}

function toHighlight(m: Measured, window: ForwardWindow): OutcomeHighlight {
  return {
    ticker: m.entry.ticker,
    name: m.entry.name,
    opportunityScore: m.entry.opportunityScore,
    forwardReturn: m.ret,
    window,
    ...(m.entry.liveVariant ? { liveVariant: m.entry.liveVariant } : {}),
    publishedAtISO: m.entry.publishedAtISO,
  };
}

/**
 * Reduce the ledger to an honest performance read: per-score-band hit rate and
 * average forward return (decile lift), best hits, worst misses - and, crucially,
 * a `coverageNote` + `lowSample` flag that refuse to imply confidence the data
 * doesn't support.
 *
 * Pure and deterministic: depends only on the ledger.
 */
export function summarizePerformance(ledger: OutcomeLedger): PerformanceSummary {
  const base = normalizeLedger(ledger);
  const entries = base.entries;
  const totalTracked = entries.length;
  const droppedCount = base.droppedCount;

  const windowCoverage: Record<ForwardWindow, number> = { d7: 0, d20: 0, d30: 0, d90: 0, d252: 0 };
  for (const e of entries) {
    for (const w of FORWARD_WINDOWS) {
      if (e.forwardReturns[w] != null) windowCoverage[w] += 1;
    }
  }

  const primaryWindow = pickPrimaryWindow(windowCoverage);

  const measured: Measured[] = [];
  for (const entry of entries) {
    const ret = entry.forwardReturns[primaryWindow];
    if (ret != null && Number.isFinite(ret)) measured.push({ entry, ret });
  }
  const measuredCount = measured.length;

  const overallHitRate =
    measuredCount > 0 ? round(measured.filter((m) => m.ret > 0).length / measuredCount, 4) : 0;
  const overallAvgReturn = measuredCount > 0 ? round(mean(measured.map((m) => m.ret)), 4) : 0;

  const sortedByScore = [...measured].sort(
    (a, b) => a.entry.opportunityScore - b.entry.opportunityScore,
  );
  const bucketCount = chooseBucketCount(measuredCount);
  const byScoreDecile = bucketize(sortedByScore, bucketCount);
  const lift =
    byScoreDecile.length >= 2
      ? round(
          byScoreDecile[byScoreDecile.length - 1].avgForwardReturn - byScoreDecile[0].avgForwardReturn,
          4,
        )
      : undefined;

  const byReturnDesc = [...measured].sort((a, b) => b.ret - a.ret);
  const topHits = byReturnDesc.slice(0, 5).map((m) => toHighlight(m, primaryWindow));
  const worstMisses = byReturnDesc
    .slice(-5)
    .reverse()
    .filter((m) => !topHits.some((h) => h.ticker === m.entry.ticker && h.publishedAtISO === m.entry.publishedAtISO))
    .map((m) => toHighlight(m, primaryWindow));

  const lowSample = measuredCount < MIN_MEANINGFUL_SAMPLE;

  return {
    totalTracked,
    measuredCount,
    primaryWindow,
    windowCoverage,
    byScoreDecile,
    lift,
    overallHitRate,
    overallAvgReturn,
    topHits,
    worstMisses,
    lowSample,
    droppedCount,
    coverageNote: buildCoverageNote({
      totalTracked,
      measuredCount,
      primaryWindow,
      lowSample,
      droppedCount,
      earliestISO: entries.length > 0 ? entries.reduce((min, e) => (e.publishedAtISO < min ? e.publishedAtISO : min), entries[0].publishedAtISO) : undefined,
    }),
  };
}

function buildCoverageNote(args: {
  totalTracked: number;
  measuredCount: number;
  primaryWindow: ForwardWindow;
  lowSample: boolean;
  droppedCount: number;
  earliestISO?: string;
}): string {
  const { totalTracked, measuredCount, primaryWindow, lowSample, droppedCount, earliestISO } = args;
  if (totalTracked === 0) {
    return "No picks tracked yet — the ledger starts recording on your next research run.";
  }

  const dropNote =
    droppedCount > 0
      ? ` ${droppedCount.toLocaleString("en-US")} oldest record${droppedCount === 1 ? "" : "s"} have rotated out of the capped ledger.`
      : "";

  if (measuredCount === 0) {
    const since = earliestISO ? ` since ${dayKey(earliestISO)}` : "";
    return `Tracking ${totalTracked.toLocaleString("en-US")} pick${totalTracked === 1 ? "" : "s"}${since}. Forward returns appear once each holding window (7 / 30 / 90 days) elapses — the first reads land about a week after the earliest run.${dropNote}`;
  }

  const base = `Measured ${measuredCount.toLocaleString("en-US")} of ${totalTracked.toLocaleString("en-US")} tracked pick${totalTracked === 1 ? "" : "s"} on the ${WINDOW_LABEL[primaryWindow]} window.`;
  const sampleNote = lowSample
    ? ` Sample is still small — read the score-band pattern as directional, not conclusive (about ${MIN_MEANINGFUL_SAMPLE}+ measured outcomes makes it meaningful).`
    : "";
  return `${base}${sampleNote}${dropNote}`;
}
