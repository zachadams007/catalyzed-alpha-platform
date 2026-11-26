import { computePortfolioAnalytics } from "@/engine/portfolioAnalytics";
import type {
  Portfolio,
  PortfolioHolding,
  PortfolioQuote,
  PortfolioValuePoint,
  PricePoint,
  StockSignal,
} from "@/types";

export type PortfolioHistorySource = "recorded" | "reconstructed" | "none";

export interface PortfolioHistoryResult {
  series: PricePoint[];
  source: PortfolioHistorySource;
  coverageCount: number;
  holdingCount: number;
}

const HISTORY_LIMIT = 366;
const RECONSTRUCTED_LIMIT = 90;

/**
 * A recorded series is only "informative" (worth charting verbatim) when it has
 * genuinely moved. The progression chart drew a *straight line* because a book
 * that's opened a handful of times accrues only 2–3 daily snapshots whose value
 * barely changes (the daily SCORE price is static between research runs), so the
 * SVG polyline collapses to one straight segment. We require this many distinct
 * (dollar-rounded) values before trusting recorded snapshots over the dense,
 * true-market reconstruction below.
 */
const MIN_DISTINCT_RECORDED = 4;

const dayKey = (date: string) => date.slice(0, 10);

/** Count distinct dollar-rounded values - a cheap "did this actually move?" test. */
function distinctValueCount(series: PricePoint[]): number {
  const seen = new Set<number>();
  for (const point of series) seen.add(Math.round(point.close));
  return seen.size;
}

interface EligibleHolding {
  shares: number;
  /** Day → close, ascending by day. */
  points: Array<[string, number]>;
  dates: string[];
}

export interface BasketReconstruction {
  series: PricePoint[];
  /** Number of holdings that contributed a real price series. */
  coverageCount: number;
}

/**
 * Reconstruct the TRUE daily value path of a basket from each holding's real
 * price history - the honest, non-faked alternative to interpolating a straight
 * line between sparse snapshots.
 *
 * Robust to misaligned/sparse series (real brokerage tickers rarely share an
 * identical calendar):
 *  • only holdings with shares and ≥2 real closes contribute;
 *  • the plotted window is the OVERLAP `[max(first dates), min(last dates)]` so
 *    every contributing holding is covered across the whole curve (no phantom
 *    step when one series simply starts later);
 *  • interior gaps (holidays, missing prints) are forward-filled with each
 *    holding's most-recent close as of that date - never invented.
 */
export function reconstructBasketSeries(
  holdings: ReadonlyArray<Pick<PortfolioHolding, "ticker" | "shares">>,
  lookupPriceSeries: (ticker: string) => PricePoint[] | undefined,
): BasketReconstruction {
  const eligible: EligibleHolding[] = holdings.flatMap((holding) => {
    if (!holding.shares || holding.shares <= 0) return [];
    const raw = lookupPriceSeries(holding.ticker);
    if (!raw?.length) return [];

    const byDay = new Map<string, number>();
    for (const point of raw) {
      if (Number.isFinite(point.close) && point.close > 0) byDay.set(dayKey(point.date), point.close);
    }
    const points = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return points.length >= 2
      ? [{ shares: holding.shares, points, dates: points.map((p) => p[0]) }]
      : [];
  });

  if (!eligible.length) return { series: [], coverageCount: 0 };

  const windowStart = eligible.reduce(
    (acc, holding) => (holding.dates[0]! > acc ? holding.dates[0]! : acc),
    eligible[0].dates[0]!,
  );
  const windowEnd = eligible.reduce((acc, holding) => {
    const last = holding.dates[holding.dates.length - 1]!;
    return last < acc ? last : acc;
  }, eligible[0].dates[eligible[0].dates.length - 1]!);
  if (windowStart > windowEnd) return { series: [], coverageCount: eligible.length };

  const dateSet = new Set<string>();
  for (const holding of eligible) {
    for (const date of holding.dates) {
      if (date >= windowStart && date <= windowEnd) dateSet.add(date);
    }
  }
  const dates = [...dateSet].sort();

  const series = dates
    .map((date) => {
      let total = 0;
      for (const holding of eligible) {
        // Most-recent close at or before `date` (forward-fill across gaps).
        let close = 0;
        for (const [day, value] of holding.points) {
          if (day <= date) close = value;
          else break;
        }
        total += close * holding.shares;
      }
      return { date, close: total };
    })
    .filter((point) => point.close > 0);

  return { series, coverageCount: eligible.length };
}

/**
 * Derive a portfolio's value-over-time series for the progression chart.
 *
 * Picks the most truthful source available:
 *  1. RECORDED daily snapshots - but only when they're genuinely informative
 *     (long enough AND actually varied). This is the user's measured history.
 *  2. RECONSTRUCTED - the dense true-market curve from each holding's price
 *     history. Preferred whenever recorded snapshots would otherwise render as a
 *     misleading straight/flat line.
 *  3. NONE - honest empty state when there's no share-backed coverage at all.
 */
export function derivePortfolioHistory(
  portfolio: Portfolio,
  lookup: (ticker: string) => StockSignal | undefined,
): PortfolioHistoryResult {
  const holdingCount = portfolio.holdings.length;

  // Clean + de-dupe recorded snapshots (one per day, last write wins).
  const recordedByDay = new Map<string, PortfolioValuePoint>();
  for (const point of (portfolio.valueHistory ?? [])
    .filter((p) => Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date))) {
    recordedByDay.set(dayKey(point.date), point);
  }
  const recordedClean = [...recordedByDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const recordedSeries: PricePoint[] = recordedClean.map((p) => ({ date: p.date, close: p.value }));

  // Dense, honest reconstruction from real price history.
  const recon = reconstructBasketSeries(portfolio.holdings, (ticker) => lookup(ticker)?.priceSeries);
  const reconSeries = recon.series.slice(-RECONSTRUCTED_LIMIT);

  const hasRecorded = recordedSeries.length >= 2;
  const hasRecon = reconSeries.length >= 2;

  // Trust recorded snapshots whenever they actually trace a path - i.e. they hold
  // enough distinct values to not be the flat/2-3-point straight-line artifact.
  // This is the user's REAL measured value (live prices × actual shares, incl.
  // holdings with no price series), so a short-but-varied history still wins over
  // the denser-but-synthetic reconstruction; only a flat/degenerate recorded
  // series defers to it. (distinctValueCount ≥ 4 implies ≥ 4 points.)
  const recordedInformative =
    hasRecorded && distinctValueCount(recordedSeries) >= MIN_DISTINCT_RECORDED;

  if (recordedInformative) {
    return {
      series: recordedSeries,
      source: "recorded",
      coverageCount: recordedClean[recordedClean.length - 1]?.valuedCount ?? holdingCount,
      holdingCount,
    };
  }

  if (hasRecon) {
    return {
      series: reconSeries,
      source: "reconstructed",
      coverageCount: recon.coverageCount,
      holdingCount,
    };
  }

  // Last resort: real-but-sparse snapshots beat showing nothing. These are still
  // measured values (never interpolated), just coarse.
  if (hasRecorded) {
    return {
      series: recordedSeries,
      source: "recorded",
      coverageCount: recordedClean[recordedClean.length - 1]?.valuedCount ?? 0,
      holdingCount,
    };
  }

  return { series: [], source: "none", coverageCount: 0, holdingCount };
}

export function createPortfolioValuePoint(
  portfolio: Portfolio,
  lookup: (ticker: string) => StockSignal | undefined,
  quoteLookup?: (ticker: string) => PortfolioQuote | undefined,
  at = new Date(),
): PortfolioValuePoint | undefined {
  const analytics = computePortfolioAnalytics(portfolio, lookup, quoteLookup);
  const valuedCount = analytics.rows.filter(
    (row) => Number.isFinite(row.marketValue) && (row.marketValue ?? 0) > 0,
  ).length;

  if (analytics.totalValue <= 0 || valuedCount === 0) return undefined;

  return {
    date: at.toISOString(),
    value: analytics.totalValue,
    valuedCount,
  };
}

export function upsertDailyPortfolioValue(
  history: PortfolioValuePoint[] | undefined,
  point: PortfolioValuePoint,
): PortfolioValuePoint[] {
  const targetDay = dayKey(point.date);
  const next = (history ?? []).filter((item) => dayKey(item.date) !== targetDay);
  next.push(point);
  return next.sort((a, b) => a.date.localeCompare(b.date)).slice(-HISTORY_LIMIT);
}
