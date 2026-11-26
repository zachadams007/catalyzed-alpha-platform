import type { CompanyData, RawFundamentals } from "@/types";
import { finnhubKey, httpJson } from "@/data/http";
import {
  asOfQualifier,
  isFundamentalsFresh,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";

export { asOfQualifier };

const FINNHUB = "https://finnhub.io/api/v1";

type Metric = Record<string, number | string | null | undefined>;

/** One dated datapoint in a Finnhub basic-financials `series` block. */
interface SeriesPoint {
  period?: string;
  v?: number;
}

interface FinnhubMetricResponse {
  metric?: Metric;
  /** Dated time-series per metric (free tier returns `annual` / `quarterly`). */
  series?: {
    annual?: Record<string, SeriesPoint[] | undefined>;
    quarterly?: Record<string, SeriesPoint[] | undefined>;
  };
}

/**
 * Live Finnhub fundamentals + their reporting as-of. `metric` is the flat
 * dictionary the existing field extractors read; `asOf` is the most-recent
 * reporting period found in the dated `series` block (used for the freshness
 * gate + the honest "as of …" qualifier). `asOf` is null when undatable.
 */
export interface LiveFundamentals {
  metric: Metric;
  asOf: string | null;
}

/**
 * Most-recent reporting period across the dated `series` block, as an ISO-ish
 * "YYYY-MM-DD" string, or null when the feed carried no dated series. Annual
 * periods are preferred (they back the TTM/annual figures we extract); we fall
 * back to the latest quarterly period otherwise.
 */
function latestPeriod(series: FinnhubMetricResponse["series"]): string | null {
  if (!series) return null;
  let best: string | null = null;
  for (const bucket of [series.annual, series.quarterly]) {
    if (!bucket) continue;
    for (const points of Object.values(bucket)) {
      if (!Array.isArray(points)) continue;
      for (const p of points) {
        const period = typeof p?.period === "string" ? p.period : null;
        if (period && (best == null || period > best)) best = period;
      }
    }
  }
  return best;
}

/** First finite number found under any of the candidate keys, else null. */
function num(metric: Metric, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = metric[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Finnhub reports margins / growth as percentages (e.g. 43.6 → 0.436). */
function pct(v: number | null): number | null {
  return v == null ? null : v / 100;
}

/**
 * Size-aware sanity bound for a growth metric (revenue / EPS YoY, as a ratio).
 *
 * Finnhub's free `metric=all` feed sometimes surfaces a noisy quarterly-YoY
 * figure off a weak comparable quarter - e.g. a megabank reading "+99% revenue
 * growth" (the Bank of America bug). For a large/mega-cap that's almost always an
 * artifact, not reality, so we reject it (→ "N/A") rather than show a number we
 * can't stand behind. Small caps legitimately post triple-digit growth, so they
 * only get a loose garbage guard. `null`/non-finite always passes through as null.
 */
function saneGrowth(value: number | null, marketCap: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  // Large + Mega cap (≥ $10B). Below that, growth can genuinely run hot.
  const largeCap = marketCap >= 1e10;
  const cap = largeCap ? 0.7 : 5; // 70% band for large/mega; 500% garbage guard otherwise
  return Math.abs(value) > cap ? null : value;
}

/** Reject a value outside a plausible [lo, hi] band (→ "N/A"); pass null through. */
function inBand(value: number | null, lo: number, hi: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value >= lo && value <= hi ? value : null;
}

/**
 * Fetch Finnhub "basic financials" (free tier). Returns the flat `metric`
 * dictionary (margins, growth, valuation, beta, volume) plus the most-recent
 * reporting period found in the dated `series` block (`asOf`), or null on
 * failure. The `asOf` powers the freshness gate so a 1–2-quarter-lagged figure
 * is never presented as current.
 */
export async function fetchFinnhubMetrics(symbol: string): Promise<LiveFundamentals | null> {
  const key = finnhubKey();
  if (!key) return null;
  const ticker = symbol.trim().toUpperCase();
  if (!ticker) return null;

  try {
    const data = await httpJson<FinnhubMetricResponse>(
      `${FINNHUB}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${encodeURIComponent(key)}`,
    );
    if (!data.metric) return null;
    return { metric: data.metric, asOf: latestPeriod(data.series) };
  } catch {
    return null;
  }
}

/** Normalize the two accepted input shapes to `{ metric, asOf }`. */
function asLive(input: Metric | LiveFundamentals | null): LiveFundamentals | null {
  if (!input) return null;
  if ("metric" in input && typeof (input as LiveFundamentals).metric === "object") {
    return input as LiveFundamentals;
  }
  // A bare metric dict (e.g. from a test or a legacy caller) - undatable.
  return { metric: input as Metric, asOf: null };
}

/**
 * Merge real Finnhub fundamentals into a company. Every fundamentals field is
 * flagged in `fundamentalsAvailability`: true ONLY when a real, in-band value
 * was found in the feed AND it is not provably stale; false otherwise (the UI
 * then shows "N/A" instead of the modeled placeholder, and a stale figure is
 * never shown as current). A field that isn't available is reset to a neutral
 * placeholder so no seeded/modeled value can ever leak behind a false flag.
 * Beta and average dollar volume are upgraded to live values when present.
 */
export function applyLiveFundamentalsToCompany(
  company: CompanyData,
  input: Metric | LiveFundamentals | null,
): CompanyData {
  const live = asLive(input);
  if (!live) {
    if (company.fundamentalsAvailability) return company;
    // No live financials: nothing about fundamentals is real here.
    return {
      ...company,
      fundamentalsAvailability: {
        revenueGrowthYoY: false,
        epsGrowthYoY: false,
        grossMargin: false,
        netMargin: false,
        peRatio: false,
        pegRatio: false,
        debtToEquity: false,
        fcfMargin: false,
      },
    };
  }
  const { metric, asOf } = live;

  // Freshness gate: a dated figure that's older than the window is treated as
  // STALE → not available (so SOFI's pre-profitability margin can't read as
  // current). Undated free-tier data passes this gate at the tile level - the
  // freshness-sensitive surfaces (the "Watch-outs" strip) apply their own,
  // stricter freshness check that ALSO requires a present as-of.
  const stale = asOf != null && !isFundamentalsFresh(asOf);

  // Prefer TTM/annual; reject implausible values (size-aware for growth) so a
  // noisy quarterly-YoY artifact reads "N/A" instead of a fabricated-looking
  // number. Every field below is either a real, in-band value or null → "N/A".
  const revenueGrowthYoY = saneGrowth(
    pct(num(metric, "revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy", "revenueGrowth3Y")),
    company.marketCap,
  );
  const epsGrowthYoY = saneGrowth(
    pct(num(metric, "epsGrowthTTMYoy", "epsGrowthQuarterlyYoy", "epsGrowth3Y")),
    company.marketCap,
  );
  const grossMargin = inBand(pct(num(metric, "grossMarginTTM", "grossMarginAnnual")), -1, 1);
  const netMargin = inBand(
    pct(num(metric, "netProfitMarginTTM", "netMarginTTM", "netProfitMarginAnnual")),
    -5,
    1,
  );
  // A meaningful P/E is positive; negative or absurd readings aren't shown.
  const peRatio = inBand(num(metric, "peTTM", "peBasicExclExtraTTM", "peAnnual"), 0, 2000);
  const pegRatio = inBand(num(metric, "pegTTM", "pegRatio"), 0, 50);
  const debtToEquity = inBand(
    num(
      metric,
      "totalDebt/totalEquityQuarterly",
      "totalDebt/totalEquityAnnual",
      "totalDebtToEquityQuarterly",
      "totalDebtToEquityAnnual",
      "longTermDebt/equityQuarterly",
    ),
    0,
    100,
  );
  const fcfMargin = inBand(pct(num(metric, "fcfMarginTTM", "fcfMargin5Y")), -5, 1);
  const beta = num(metric, "beta");
  // Average daily volume in millions of shares -> dollar volume.
  const avgVolMillions = num(metric, "3MonthAverageTradingVolume", "10DayAverageTradingVolume");

  // Build the merged fundamentals from a NEUTRAL placeholder, not the existing
  // (possibly synthetic/modeled) values - so a field that isn't really available
  // can never retain a seeded number behind a `false` flag. A real, in-band,
  // fresh value overwrites the placeholder and flips availability true.
  const placeholder = unknownFundamentals();
  const next: RawFundamentals = { ...placeholder };
  const availability: Record<keyof RawFundamentals, boolean> = {
    revenueGrowthYoY: false,
    epsGrowthYoY: false,
    grossMargin: false,
    netMargin: false,
    peRatio: false,
    pegRatio: false,
    debtToEquity: false,
    fcfMargin: false,
  };

  // Apply one real value: only when present, in-band, and not provably stale.
  const set = (key: keyof RawFundamentals, value: number | null): void => {
    if (value == null || stale) return;
    next[key] = value;
    availability[key] = true;
  };

  set("revenueGrowthYoY", revenueGrowthYoY);
  set("epsGrowthYoY", epsGrowthYoY);
  set("grossMargin", grossMargin);
  set("netMargin", netMargin);
  set("peRatio", peRatio);
  set("pegRatio", pegRatio);
  set("debtToEquity", debtToEquity);
  set("fcfMargin", fcfMargin);

  const volatility = beta != null ? { ...company.volatility, beta } : company.volatility;
  const liquidity =
    avgVolMillions != null && company.price > 0
      ? { ...company.liquidity, avgDollarVolume: avgVolMillions * 1_000_000 * company.price }
      : company.liquidity;

  // Stamp the as-of only when at least one real value made it through; clears
  // it otherwise so a record with no live fundamentals carries no false date.
  const anyAvailable = (Object.keys(availability) as Array<keyof RawFundamentals>).some(
    (k) => availability[k],
  );

  return {
    ...company,
    fundamentals: next,
    fundamentalsAvailability: availability,
    fundamentalsAsOf: anyAvailable && asOf ? asOf : undefined,
    volatility,
    liquidity,
  };
}
