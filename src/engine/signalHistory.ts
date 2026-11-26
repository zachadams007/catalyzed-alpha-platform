import { clamp, ewma, round, scaleLinear } from "@/lib/math";
import type { NormalizationContext } from "./normalizeUniverse";

/**
 * Daily signal history - the persisted substrate for the challenger's two
 * time-aware refinements (Mission 4 data-deps):
 *
 *   • EWMA smoothing of the `news` / `social` sub-scores, so one loud headline
 *     can't dominate a name's day-to-day reading (a spike decays gracefully).
 *   • Estimate-revision momentum: a daily snapshot of the consensus forward EPS
 *     estimate lets the engine detect upward/downward revision trends (the PEAD /
 *     pre-earnings-drift effect) that a single point-in-time read can't see.
 *
 * Live providers cannot give us deltas (an API returns the *current* consensus,
 * not how it moved), so we record one snapshot per ticker per research day and
 * derive the trend ourselves. This file is the PURE half - append, prune, and
 * the two scorers - so it's trivially testable and deterministic. The localStorage
 * read/write lives in `src/data/history/signalHistoryStore.ts`.
 *
 * Pure & deterministic (project law): the caller supplies the calendar day; no
 * `Date.now()` here, so the daily research cache stays stable (reopen → identical
 * feed). Cold-start safe by construction: a brand-new ticker with one snapshot
 * smooths to itself and scores revision-neutral, so day 1 changes nothing.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One ticker's recorded state for a single research day. */
export interface SignalSnapshot {
  /** Research day this snapshot belongs to (YYYY-MM-DD, UTC). */
  date: string;
  /** Raw news sub-score that day, 0..100. */
  news: number;
  /** Raw social sub-score that day, 0..100. */
  social: number;
  /** Consensus forward EPS estimate that day (per share), or null if unknown. */
  eps: number | null;
}

/** Append-only, per-ticker daily history, persisted in localStorage. */
export interface SignalHistory {
  /** Schema version for forward migrations of the snapshot shape. */
  schemaVersion: number;
  /** Per-ticker snapshot series, each oldest → newest. */
  series: Record<string, SignalSnapshot[]>;
}

/** The shape one ticker contributes to a fresh daily snapshot. */
export interface SnapshotInput {
  ticker: string;
  news: number;
  social: number;
  eps: number | null;
}

export const SIGNAL_HISTORY_VERSION = 1;

/**
 * Half-life (in research days) for the news/social EWMA. A spike's weight halves
 * after this many daily runs, so a single headline fades over a few days rather
 * than dominating. Steps are research-days (≈ calendar days, since research runs
 * about daily); a missed day just compresses the decay slightly.
 */
export const NEWS_SOCIAL_HALF_LIFE_DAYS = 3;

/** Max snapshots retained per ticker - bounds storage to ~one quarter of trend. */
export const MAX_SERIES_LENGTH = 90;

/**
 * Relative EPS-estimate revision that spans the full 0..100 revision score: a
 * +15% revision reads ~100, −15% reads ~0, flat reads 50. Bounds the signal so a
 * near-zero estimate base (huge percentage swings) can't blow it up.
 */
export const REVISION_BAND = 0.15;

/** Floor on |reference EPS| in the revision ratio, to avoid divide-by-near-zero. */
const EPS_FLOOR = 0.01;

/** Revision score for a name with no usable revision trend (neutral). */
export const REVISION_NEUTRAL = 50;

// ---------------------------------------------------------------------------
// Construction & coercion
// ---------------------------------------------------------------------------

export function emptySignalHistory(): SignalHistory {
  return { schemaVersion: SIGNAL_HISTORY_VERSION, series: {} };
}

function isValidSnapshot(v: unknown): v is SignalSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<SignalSnapshot>;
  return (
    typeof s.date === "string" &&
    typeof s.news === "number" &&
    Number.isFinite(s.news) &&
    typeof s.social === "number" &&
    Number.isFinite(s.social) &&
    (s.eps === null || (typeof s.eps === "number" && Number.isFinite(s.eps)))
  );
}

/**
 * Coerce an unknown persisted value into a valid history. Tolerant by design so a
 * corrupt or partial blob degrades to a clean store rather than throwing - each
 * series is filtered to valid snapshots and re-sorted oldest → newest.
 */
export function normalizeSignalHistory(value: unknown): SignalHistory {
  if (!value || typeof value !== "object") return emptySignalHistory();
  const v = value as Partial<SignalHistory>;
  if (!v.series || typeof v.series !== "object") return emptySignalHistory();
  const series: Record<string, SignalSnapshot[]> = {};
  for (const [ticker, raw] of Object.entries(v.series)) {
    if (!Array.isArray(raw)) continue;
    const cleaned = raw.filter(isValidSnapshot).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (cleaned.length > 0) series[ticker] = cleaned.slice(-MAX_SERIES_LENGTH);
  }
  return { schemaVersion: SIGNAL_HISTORY_VERSION, series };
}

// ---------------------------------------------------------------------------
// Append (write path, called once per research run)
// ---------------------------------------------------------------------------

/**
 * Record today's snapshot for every ticker in `inputs`, returning a NEW history
 * (the input is never mutated). Re-running the same day REPLACES that day's
 * snapshot (deduped by date) so a manual re-run never double-counts. Each series
 * is capped at {@link MAX_SERIES_LENGTH}; when `pruneBeforeDay` is supplied,
 * tickers whose newest snapshot predates it are dropped so the store can't grow
 * without bound as the funnel's universe churns.
 */
export function appendSnapshots(
  history: SignalHistory,
  inputs: SnapshotInput[],
  day: string,
  pruneBeforeDay?: string,
): SignalHistory {
  const base = normalizeSignalHistory(history);
  const series: Record<string, SignalSnapshot[]> = { ...base.series };

  for (const input of inputs) {
    if (!input.ticker) continue;
    const prior = (series[input.ticker] ?? []).filter((s) => s.date !== day);
    const snapshot: SignalSnapshot = {
      date: day,
      news: round(input.news, 2),
      social: round(input.social, 2),
      eps: input.eps != null && Number.isFinite(input.eps) ? round(input.eps, 4) : null,
    };
    series[input.ticker] = [...prior, snapshot].slice(-MAX_SERIES_LENGTH);
  }

  if (pruneBeforeDay) {
    for (const ticker of Object.keys(series)) {
      const last = series[ticker]!;
      const newest = last[last.length - 1]?.date;
      if (!newest || newest < pruneBeforeDay) delete series[ticker];
    }
  }

  return { schemaVersion: SIGNAL_HISTORY_VERSION, series };
}

// ---------------------------------------------------------------------------
// Scorers (read path, pure)
// ---------------------------------------------------------------------------

/** Neutral 0..100 sub-score, mirroring the `?? 50` default in normalizeUniverse. */
const NEUTRAL_SUBSCORE = 50;

/**
 * EWMA-smoothed current value for a dimension: the historical daily values
 * (oldest → newest) with today's `current` appended, run through {@link ewma}.
 * A name with no history smooths to `current` (single-point series returns
 * itself), so day 1 is a no-op. Always returns a finite value: a non-finite
 * EWMA falls back to `current`, and a non-finite `current` falls back to the
 * neutral sub-score - so the ranking input is never NaN.
 */
export function smoothedValue(pastSeries: number[], current: number, halfLife = NEWS_SOCIAL_HALF_LIFE_DAYS): number {
  const smoothed = ewma([...pastSeries, current], halfLife);
  const out = Number.isFinite(smoothed) ? smoothed : current;
  return Number.isFinite(out) ? round(out, 2) : NEUTRAL_SUBSCORE;
}

/**
 * Estimate-revision momentum, 0..100 (50 = neutral). Compares the OLDEST EPS
 * estimate in the window to the most recent: an upward consensus revision scores
 * above 50 (PEAD tailwind), a cut scores below. Needs ≥2 finite estimates - fewer
 * returns neutral (cold-start safe). The relative change is floored on the
 * denominator and clamped to {@link REVISION_BAND} so a near-zero base can't
 * dominate.
 */
export function revisionMomentumScore(epsSeries: number[]): number {
  const finite = epsSeries.filter((e) => Number.isFinite(e));
  if (finite.length < 2) return REVISION_NEUTRAL;
  const reference = finite[0]!;
  const current = finite[finite.length - 1]!;
  if (reference === current) return REVISION_NEUTRAL;
  const denom = Math.max(Math.abs(reference), EPS_FLOOR);
  const revisionPct = (current - reference) / denom;
  return round(clamp(scaleLinear(revisionPct, -REVISION_BAND, REVISION_BAND, 0, 100), 0, 100));
}

// ---------------------------------------------------------------------------
// Context builder (bridges the persisted history into the normalization pass)
// ---------------------------------------------------------------------------

/**
 * Build the {@link NormalizationContext} the challenger's normalization pass
 * consumes: per-ticker EWMA-smoothed news/social, plus the estimate-revision
 * score. Uses only PAST days from the history (today's snapshot, if already
 * present from an earlier same-day run, is excluded) and appends `today`'s live
 * value - so a same-day re-run is idempotent. Pure: history + today in, context
 * out.
 */
export function buildNormalizationContext(
  history: SignalHistory,
  today: SnapshotInput[],
  day: string,
): NormalizationContext {
  const base = normalizeSignalHistory(history);
  const smoothed: Record<string, { news: number; social: number }> = {};
  const revision: Record<string, number> = {};

  for (const input of today) {
    const past = (base.series[input.ticker] ?? []).filter((s) => s.date !== day);
    smoothed[input.ticker] = {
      news: smoothedValue(past.map((s) => s.news), input.news),
      social: smoothedValue(past.map((s) => s.social), input.social),
    };
    const epsSeries = [...past.map((s) => s.eps), input.eps].filter(
      (e): e is number => e != null && Number.isFinite(e),
    );
    revision[input.ticker] = revisionMomentumScore(epsSeries);
  }

  return { smoothed, revision };
}
