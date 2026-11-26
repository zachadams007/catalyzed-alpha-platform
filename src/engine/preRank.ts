/**
 * Cross-sectional pre-rank - the cheap funnel from "the whole US market" to the
 * ~N names worth the full scoring pass.
 *
 * The daily broad-universe scan bulk-snapshots thousands of common stocks (one
 * Alpaca call per batch), then this PURE function picks which top-N get the
 * expensive real enrichment (price history, fundamentals, news) + the full
 * scoring engine. It is deliberately NOT a megacap sort:
 *
 *   • A liquidity FLOOR + price FLOOR drop untradeable/sub-penny junk.
 *   • Ranking favors realized volatility (range) and the day's move - the
 *     "high-potential, high-volatility" thesis - which surfaces active small- and
 *     mid-caps over sleepy mega-caps.
 *   • Liquidity is only a SATURATING qualifier: once a name is liquid enough it
 *     stops earning rank, so a $2T mega-cap gets no edge over a $3B mid-cap on
 *     size alone.
 *   • An `alwaysInclude` seed set (the curated universe / the user's watchlist)
 *     is guaranteed a slot, bypassing the floors.
 *
 * Pure and deterministic: same snapshots + config always yield the same list, so
 * the daily cache stays stable and the funnel is fully explainable (no hidden
 * model, no randomness).
 */

export interface PreRankInput {
  ticker: string;
  /** Last price (USD). */
  price: number;
  /** Prior session close (USD). */
  prevClose: number;
  /** Day change as a ratio (0.034 = +3.4%). */
  dayChange: number;
  /** Most recent complete-session dollar volume (USD). */
  dollarVolume: number;
  /** Prior session high-low range as a fraction of close (realized-vol proxy). */
  rangePct: number;
}

export interface PreRankConfig {
  /** How many names to return (seeds + top-scored, deduped). */
  target: number;
  /** Minimum last price - excludes sub-penny/illiquid junk. Default $1.50. */
  minPrice?: number;
  /** Optional upper price bound (rarely needed). */
  maxPrice?: number;
  /** Minimum complete-session dollar volume to be tradable. Default $2M/day. */
  minDollarVolume?: number;
  /** Tickers always included regardless of the floors (curated set / watchlist). */
  alwaysInclude?: string[];
}

export interface PreRankRow extends PreRankInput {
  /** 0..1 blended pre-rank score (only meaningful within one run's set). */
  score: number;
  /** True when force-included via `alwaysInclude` (bypassed the floors). */
  seeded: boolean;
}

export interface PreRankResult {
  /** Final ordered ticker list (seeds first, then top-scored), capped at target. */
  tickers: string[];
  /** Full scored rows for the selected names (telemetry / explainability). */
  rows: PreRankRow[];
  /** Every scored row eligible for selection before the target cap is applied. */
  eligibleRows: PreRankRow[];
  /** How many names passed the floors. */
  gatedCount: number;
  /** How many names were considered (had a usable snapshot). */
  consideredCount: number;
  /** The dollar-volume floor applied. */
  floorDollarVolume: number;
}

const DEFAULT_MIN_PRICE = 1.5;
const DEFAULT_MIN_DOLLAR_VOLUME = 2_000_000;
/** Liquidity saturates at ~$1B/day - being "liquid enough" maxes the term. */
const LIQUIDITY_SATURATION = 1_000_000_000;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Percentile rank of every value in `values`, returned as a parallel array in
 * [0,1]. Ties share the fraction of values at-or-below them. Pure.
 */
function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => (n === 1 ? 1 : 0));
  const sorted = [...values].sort((a, b) => a - b);
  // For each value, the fraction of entries <= it (upper bound of the tie block).
  return values.map((v) => {
    // binary search for the last index with sorted[idx] <= v
    let lo = 0;
    let hi = n - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= v) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return (last + 1) / n;
  });
}

/** Saturating liquidity qualifier in [0,1]: 0 at the floor, 1 at ~$1B/day. */
function liquidityScore(dollarVolume: number, floor: number): number {
  if (dollarVolume <= floor) return 0;
  const span = Math.log10(LIQUIDITY_SATURATION) - Math.log10(floor);
  if (span <= 0) return 1;
  return clamp01((Math.log10(dollarVolume) - Math.log10(floor)) / span);
}

function normalizeSeeds(alwaysInclude: string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const raw of alwaysInclude ?? []) {
    const t = raw?.trim().toUpperCase();
    if (t) set.add(t);
  }
  return set;
}

/**
 * Rank a snapshot universe and return the top-N tickers to fully score.
 *
 * Blend (within the gated set): 45% realized volatility (range), 35% absolute
 * day move, 20% saturating liquidity. Seeds are force-included first; the rest of
 * the slots are filled by score.
 */
export function preRankUniverse(rows: PreRankInput[], config: PreRankConfig): PreRankResult {
  const minPrice = config.minPrice ?? DEFAULT_MIN_PRICE;
  const maxPrice = config.maxPrice ?? Infinity;
  const floor = config.minDollarVolume ?? DEFAULT_MIN_DOLLAR_VOLUME;
  const target = Math.max(0, Math.floor(config.target));
  const seeds = normalizeSeeds(config.alwaysInclude);

  // De-dupe by ticker, keep the row with the most dollar volume if duplicated.
  const byTicker = new Map<string, PreRankInput>();
  for (const r of rows) {
    const t = r.ticker?.trim().toUpperCase();
    if (!t || !Number.isFinite(r.price) || r.price <= 0) continue;
    const prev = byTicker.get(t);
    if (!prev || (r.dollarVolume ?? 0) > (prev.dollarVolume ?? 0)) {
      byTicker.set(t, { ...r, ticker: t });
    }
  }
  const considered = [...byTicker.values()];

  const passesFloors = (r: PreRankInput): boolean =>
    r.price >= minPrice &&
    r.price <= maxPrice &&
    r.prevClose > 0 &&
    r.dollarVolume >= floor;

  // The scoring pool = floor-passers PLUS seeds (seeds bypass the floors). We
  // score everyone so seeds still get a meaningful score for ordering ties.
  const gated = considered.filter(passesFloors);
  const gatedSet = new Set(gated.map((r) => r.ticker));
  const pool = considered.filter((r) => gatedSet.has(r.ticker) || seeds.has(r.ticker));

  const moveRanks = percentileRanks(pool.map((r) => Math.abs(r.dayChange)));
  const rangeRanks = percentileRanks(pool.map((r) => Math.max(0, r.rangePct)));

  const scored: PreRankRow[] = pool.map((r, i) => ({
    ...r,
    seeded: seeds.has(r.ticker),
    score:
      0.45 * (rangeRanks[i] ?? 0) +
      0.35 * (moveRanks[i] ?? 0) +
      0.2 * liquidityScore(r.dollarVolume, floor),
  }));

  const scoreOf = new Map(scored.map((r) => [r.ticker, r]));

  // Seeds first (in their given order, only those we actually have data for),
  // then the highest-scored non-seed names, until we hit the target.
  const result: PreRankRow[] = [];
  const taken = new Set<string>();

  for (const t of seeds) {
    const row = scoreOf.get(t);
    if (row && !taken.has(t)) {
      result.push(row);
      taken.add(t);
    }
  }

  const rest = scored
    .filter((r) => !taken.has(r.ticker))
    .sort((a, b) => b.score - a.score || b.dollarVolume - a.dollarVolume);

  for (const row of rest) {
    if (result.length >= target) break;
    result.push(row);
    taken.add(row.ticker);
  }

  // If seeds alone already exceed the target we still return them all - the
  // curated/watchlist set is a floor on coverage, never trimmed away.
  return {
    tickers: result.map((r) => r.ticker),
    rows: result,
    eligibleRows: scored,
    gatedCount: gated.length,
    consideredCount: considered.length,
    floorDollarVolume: floor,
  };
}
