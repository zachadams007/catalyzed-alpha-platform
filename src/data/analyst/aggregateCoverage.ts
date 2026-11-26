import type { AnalystCoverage, AnalystTargetRow } from "@/types";
import {
  finnhubKey,
  fmpKey,
  httpJson,
  isPlanBlocked,
  notePlanBlocked,
  postJson,
  researchProxyUrl,
} from "@/data/http";
import { analystSourceLinks, finnhubSymbolUrl, tipRanksForecastUrl } from "@/lib/analystLinks";
import { fmpPriceTargetConsensus } from "@/data/fmp/fmpClient";

const FINNHUB = "https://finnhub.io/api/v1";

interface SourceConsensus {
  source: string;
  origin: NonNullable<AnalystTargetRow["origin"]>;
  url: string;
  mean?: number;
  median?: number;
  high?: number;
  low?: number;
  updatedAt?: string;
  analystCount?: number;
}

interface FinnhubPriceTarget {
  lastUpdated?: string;
  targetHigh?: number;
  targetLow?: number;
  targetMean?: number;
  targetMedian?: number;
  numberOfAnalysts?: number;
}

/**
 * Finnhub moved `/stock/price-target` behind a paid plan - a free key now gets
 * HTTP 403 `{"error":"You don't have access to this resource."}` for EVERY
 * symbol. That was a large share of the app's daily Finnhub failure count, so
 * the lane trips off after the first 403 and the FMP consensus below (which is
 * in-plan and returns the same shape) carries the surface on its own.
 */
async function finnhubConsensus(symbol: string): Promise<SourceConsensus | null> {
  const key = finnhubKey();
  if (!key) return null;
  if (isPlanBlocked("finnhub", "/stock/price-target")) return null;
  try {
    const pt = await httpJson<FinnhubPriceTarget>(
      `${FINNHUB}/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
    );
    if (!pt?.targetMean || pt.targetMean <= 0) return null;
    return {
      source: "Finnhub consensus",
      origin: "finnhub",
      url: finnhubSymbolUrl(symbol),
      mean: pt.targetMean,
      median: pt.targetMedian,
      high: pt.targetHigh,
      low: pt.targetLow,
      updatedAt: pt.lastUpdated,
      analystCount: pt.numberOfAnalysts,
    };
  } catch (err) {
    const e = err as { status?: number; body?: string };
    // Finnhub's refusal body is `{"error":"You don't have access to this resource."}`
    // - an ENDPOINT-level plan gate, so it is safe to trip the whole lane off.
    if (e?.status === 401 || e?.status === 403) {
      notePlanBlocked("finnhub", "/stock/price-target", e.status, "restricted endpoint");
    }
    return null;
  }
}

async function fmpConsensus(symbol: string): Promise<SourceConsensus | null> {
  if (!fmpKey()) return null;
  const c = await fmpPriceTargetConsensus(symbol);
  if (!c?.targetConsensus || c.targetConsensus <= 0) return null;
  return {
    source: "FMP / TipRanks consensus",
    origin: "fmp",
    url: tipRanksForecastUrl(symbol),
    mean: c.targetConsensus,
    median: c.targetMedian,
    high: c.targetHigh,
    low: c.targetLow,
  };
}

/**
 * Real Yahoo Finance analyst targets via the research proxy (server-side, since
 * Yahoo's endpoint needs a cookie/crumb). This is the second live source that
 * lifts coverage beyond Finnhub-only. Returns null when the proxy is
 * unconfigured or Yahoo has no targets - the caller still blends the rest.
 */
async function yahooConsensus(symbol: string): Promise<SourceConsensus | null> {
  const url = researchProxyUrl("price_targets");
  if (!url) return null;
  try {
    const r = await postJson<{
      mean?: number;
      high?: number;
      low?: number;
      median?: number;
      analystCount?: number;
    }>(url, { task: "price_targets", ticker: symbol }, 18_000);
    if (!r?.mean || r.mean <= 0) return null;
    return {
      source: "Yahoo Finance consensus",
      origin: "yahoo",
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/analysis`,
      mean: r.mean,
      median: r.median,
      high: r.high,
      low: r.low,
      analystCount: r.analystCount,
    };
  } catch {
    return null;
  }
}

function avg(nums: Array<number | undefined>): number | undefined {
  const vals = nums.filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
  if (vals.length === 0) return undefined;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Pull live price-target consensus from every configured source (Finnhub, FMP/
 * TipRanks) and blend them. Always appends outbound links (Yahoo, TipRanks,
 * CNN, MarketWatch) so the user can verify at the big providers.
 *
 * Returns null when no live source produced a consensus (caller falls back).
 */
export async function aggregateAnalystCoverage(
  ticker: string,
  spotPrice: number,
): Promise<AnalystCoverage | null> {
  const symbol = ticker.trim().toUpperCase();
  const [fh, fmp, yh] = await Promise.all([
    finnhubConsensus(symbol),
    fmpConsensus(symbol),
    yahooConsensus(symbol),
  ]);
  const live = [fh, fmp, yh].filter((c): c is SourceConsensus => c != null);
  if (live.length === 0) return null;

  const sources = analystSourceLinks(symbol);
  const linkRows: AnalystTargetRow[] = sources.map((s) => ({
    source: s.name,
    label: s.blurb,
    url: s.url,
    origin: "link",
  }));

  const perSourceRows: AnalystTargetRow[] = live.map((c) => ({
    source: c.source,
    label: c.analystCount ? `Mean target · ${c.analystCount} analysts` : "Mean target",
    target: c.mean,
    targetHigh: c.high,
    targetLow: c.low,
    targetMedian: c.median,
    updatedAt: c.updatedAt,
    url: c.url,
    origin: c.origin,
    analystCount: c.analystCount,
  }));

  const blendedMean = avg(live.map((c) => c.mean));
  const blendedMedian = avg(live.map((c) => c.median ?? c.mean));
  const blendedHigh = avg(live.map((c) => c.high));
  const blendedLow = avg(live.map((c) => c.low));
  const contributors = live.map((c) => c.source);
  const analystCount = live.reduce((sum, c) => sum + (c.analystCount ?? 0), 0) || undefined;
  const updatedAt = live.find((c) => c.updatedAt)?.updatedAt;

  const blendedRow: AnalystTargetRow | null =
    live.length >= 2 && blendedMean != null
      ? {
          source: "Blended consensus",
          label: `Average of ${live.length} live sources`,
          target: blendedMean,
          targetHigh: blendedHigh,
          targetLow: blendedLow,
          targetMedian: blendedMedian,
          updatedAt,
          url: tipRanksForecastUrl(symbol),
          origin: "fmp",
          analystCount,
        }
      : null;

  const rows: AnalystTargetRow[] = [
    ...(blendedRow ? [blendedRow] : []),
    ...perSourceRows,
    ...linkRows,
  ];

  return {
    status: live.length >= 2 ? "aggregated" : "live",
    spotPrice,
    consensus: {
      mean: blendedMean,
      median: blendedMedian,
      high: blendedHigh,
      low: blendedLow,
      updatedAt,
      contributors,
      analystCount,
    },
    rows,
    sources,
  };
}
