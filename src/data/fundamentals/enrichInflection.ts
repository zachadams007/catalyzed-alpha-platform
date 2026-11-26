import type { CompanyData } from "@/types";
import { finnhubKey, httpJson } from "@/data/http";
import { pooledMap } from "@/lib/concurrency";

/**
 * v2 INFLECTION FOLD - real QUARTERLY-financials inputs for the `inflection`
 * dimension (revenue/margin RE-acceleration off a depressed base).
 *
 * SOURCE: Finnhub `/stock/metric?metric=all` - its `series.quarterly` block gives
 * clean per-quarter margin + sales series on the FREE tier (FMP's v3 statement
 * endpoints were deprecated Aug-2025 and FMP free now serves annual-only, so it
 * can't feed a QoQ re-acceleration signal). Finnhub is already in the key pool.
 * One call per name; pooled + paced (Finnhub free is 60/min) and the caller passes
 * only the top-N by prelim score, so the spend lands on the names that surface.
 *
 * Pure compute + a no-op-without-a-key enrichment. The math emits only the fields
 * the available quarters support, so a thin history never fabricates a trend
 * (absent fields stay undefined; the scorer averages over what IS present, and the
 * dimension stays a neutral 50 for the rest of the universe - never faked).
 */

const FINNHUB = "https://finnhub.io/api/v1";

interface SeriesPoint {
  period?: string;
  v?: number | null;
}
interface FinnhubMetricResponse {
  metric?: Record<string, number | null | undefined>;
  series?: { quarterly?: Record<string, SeriesPoint[] | undefined> };
}

/** Quarterly metric series we read, normalized to newest-first numeric arrays. */
export interface QuarterlyMetrics {
  grossMargin: (number | undefined)[];
  operatingMargin: (number | undefined)[];
  /** Revenue-per-share - the QoQ/YoY revenue-GROWTH proxy (share-count-adjusted). */
  salesPerShare: (number | undefined)[];
  /** SG&A / sales - the opex-leverage proxy. */
  sgaToSale: (number | undefined)[];
  /** TTM EV/Sales (or P/S as a fallback) - a value tell. */
  evToSalesTTM?: number;
}

const numOrU = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Finnhub returns quarterly series newest-first; map to a numeric array. */
function vals(s: SeriesPoint[] | undefined): (number | undefined)[] {
  return (s ?? []).map((p) => numOrU(p.v));
}

/** QoQ growth at index i (newest-first): (x[i]-x[i+1])/x[i+1]. */
function qoq(x: (number | undefined)[], i: number): number | undefined {
  const a = x[i];
  const b = x[i + 1];
  return a != null && b != null && b > 0 ? (a - b) / b : undefined;
}
/** YoY growth at index i: (x[i]-x[i+4])/x[i+4]. */
function yoy(x: (number | undefined)[], i: number): number | undefined {
  const a = x[i];
  const b = x[i + 4];
  return a != null && b != null && b > 0 ? (a - b) / b : undefined;
}

/**
 * Compute the v2 inflection inputs from the quarterly metric series. Pure.
 * Returns only the fields the available quarters support.
 */
export function computeInflectionInputs(
  q: QuarterlyMetrics,
): NonNullable<CompanyData["inflection"]> | undefined {
  const inflection: NonNullable<CompanyData["inflection"]> = {};

  // Revenue 2nd-derivative (re-acceleration) from sales-per-share growth.
  //
  // SEASONALLY MATCHED. This used to be g0 − mean(g1, g2): the latest sequential
  // growth against the prior two transitions. For a seasonal business that is
  // not a second derivative, it is the calendar. A retailer's Q4→Q1 drop read as
  // a violent deceleration on every spring/summer board and its Q3→Q4 holiday
  // jump as a re-acceleration on every winter one: Amazon carried revAccelQoQ
  // −27.7% and an inflection of 24/100 on the 2026-07-29 board while its YoY
  // growth was accelerating and its margins expanding; Meta read −18.6% the same
  // way. The latest transition is now compared with the SAME transition one year
  // earlier (g0 − g4: this Q4→Q1 against last Q4→Q1), which cancels the season
  // and keeps the early-warning sensitivity of a sequential read. It needs six
  // quarters; with fewer the field is left absent - the YoY-acceleration leg
  // still scores - rather than published from a seasonal artifact.
  const g0 = qoq(q.salesPerShare, 0);
  const g4 = qoq(q.salesPerShare, 4);
  if (g0 != null && g4 != null) inflection.revAccelQoQ = g0 - g4;

  // YoY growth acceleration (this-q YoY minus prior-q YoY).
  const y0 = yoy(q.salesPerShare, 0);
  const y1 = yoy(q.salesPerShare, 1);
  if (y0 != null && y1 != null) inflection.revYoYAccel = y0 - y1;

  // Gross-margin change YoY (this fiscal quarter vs the year-ago quarter).
  if (q.grossMargin[0] != null && q.grossMargin[4] != null) {
    inflection.grossMarginDeltaYoY = q.grossMargin[0]! - q.grossMargin[4]!;
  }
  // Operating margin now + year-ago quarter (the loss→profit turn).
  if (q.operatingMargin[0] != null) inflection.opMarginNow = q.operatingMargin[0]!;
  if (q.operatingMargin[4] != null) inflection.opMarginPrevYearQ = q.operatingMargin[4]!;

  // Opex leverage: SG&A/sales change YoY (negative ⇒ improving leverage).
  if (q.sgaToSale[0] != null && q.sgaToSale[4] != null) {
    inflection.opexPctRevDeltaYoY = q.sgaToSale[0]! - q.sgaToSale[4]!;
  }
  // EV/Sales (TTM) - a small-cap value tell.
  if (q.evToSalesTTM != null && q.evToSalesTTM > 0) inflection.evToSales = q.evToSalesTTM;

  return Object.keys(inflection).length > 0 ? inflection : undefined;
}

/**
 * Point-in-time option for the replay harness: keep only quarters whose period
 * end is at least `lagDays` before `asOf`, because a quarter is not public until
 * its 10-Q lands. The live scan passes nothing and reads every quarter.
 */
export interface QuarterlyMetricsAsOf {
  asOf?: string;
  lagDays?: number;
}

function censorSeries(
  s: SeriesPoint[] | undefined,
  opts?: QuarterlyMetricsAsOf,
): SeriesPoint[] | undefined {
  if (!s || !opts?.asOf) return s;
  const cutoff = Date.parse(`${opts.asOf}T00:00:00Z`) - (opts.lagDays ?? 45) * 86_400_000;
  if (!Number.isFinite(cutoff)) return s;
  return s.filter(
    (p) => typeof p.period === "string" && Date.parse(`${p.period}T00:00:00Z`) <= cutoff,
  );
}

/** Fetch + normalize the quarterly metric series for one symbol. null on failure. */
export async function fetchQuarterlyMetrics(
  symbol: string,
  opts?: QuarterlyMetricsAsOf,
): Promise<QuarterlyMetrics | null> {
  const key = finnhubKey();
  if (!key) return null;
  const ticker = symbol.trim().toUpperCase();
  if (!ticker) return null;
  try {
    const data = await httpJson<FinnhubMetricResponse>(
      `${FINNHUB}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${encodeURIComponent(key)}`,
    );
    const q = data.series?.quarterly ?? {};
    // EV/Sales is a live ratio with no history; a replay cannot reconstruct it.
    const evToSalesTTM = opts?.asOf
      ? undefined
      : (numOrU(data.metric?.evRevenueTTM) ?? numOrU(data.metric?.psTTM));
    return {
      grossMargin: vals(censorSeries(q.grossMargin, opts)),
      operatingMargin: vals(censorSeries(q.operatingMargin, opts)),
      salesPerShare: vals(censorSeries(q.salesPerShare, opts)),
      sgaToSale: vals(censorSeries(q.sgaToSale, opts)),
      evToSalesTTM,
    };
  } catch {
    return null;
  }
}

export interface InflectionEnrichProgress {
  done: number;
  total: number;
}

/**
 * Fetch quarterly metrics + fold inflection inputs onto the given companies (the
 * caller passes ONLY the top-N by prelim score). One Finnhub call per company,
 * pooled at low concurrency to respect the 60/min free limit; a rate-limited call
 * just degrades that name to the cold-start neutral. No-op without a Finnhub key.
 * Never throws.
 */
export async function enrichTopNWithInflection(
  companies: CompanyData[],
  onProgress?: (p: InflectionEnrichProgress) => void,
  concurrency = 2,
  opts?: QuarterlyMetricsAsOf,
): Promise<CompanyData[]> {
  if (companies.length === 0 || !finnhubKey()) return companies;

  const total = companies.length;
  return pooledMap(
    companies,
    concurrency,
    async (c) => {
      const series = await fetchQuarterlyMetrics(c.ticker, opts);
      if (!series) return c;
      const inflection = computeInflectionInputs(series);
      // A replay that finds nothing public yet must not keep the board's stored
      // (possibly future-dated) inputs either.
      if (!inflection) return opts?.asOf ? { ...c, inflection: undefined } : c;
      return { ...c, inflection };
    },
    (done) => onProgress?.({ done, total }),
  );
}
