import type { AnalystCoverage, AnalystRecommendations, AnalystTargetRow } from "@/types";
import { finnhubKey, fmpKey, httpJson } from "@/data/http";
import { analystRatingTotal, estimateConsensusFromRatings } from "@/lib/analystStats";
import { analystSourceLinks, finnhubSymbolUrl } from "@/lib/analystLinks";
import { isSampleUniverseTicker } from "@/lib/links";
import { seededRandom } from "@/lib/math";
import { aggregateAnalystCoverage } from "@/data/analyst/aggregateCoverage";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";

const FINNHUB = "https://finnhub.io/api/v1";

/**
 * Honest empty-consensus coverage: outbound research links only, NO numeric
 * mean/high/low/median. This is the correct state for a real ticker when no live
 * vendor consensus is available and Sample data mode is OFF - never seeded-random
 * dollar targets relabeled as "Estimated".
 */
export function linksOnlyCoverage(ticker: string, spotPrice: number): AnalystCoverage {
  const symbol = ticker.trim().toUpperCase();
  const sources = analystSourceLinks(symbol);
  const linkRows: AnalystTargetRow[] = sources.map((s) => ({
    source: s.name,
    label: s.blurb,
    url: s.url,
    origin: "link",
  }));
  return { status: "links_only", spotPrice, rows: linkRows, sources };
}

interface FinnhubRecommendation {
  symbol?: string;
  period?: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
}

/** Sync baseline for feed cards (sample numbers; refreshed live after research when keyed). */
export function buildFeedAnalystCoverage(ticker: string, spotPrice: number): AnalystCoverage {
  return sampleCoverage(ticker, spotPrice);
}

function sampleCoverage(ticker: string, spotPrice: number): AnalystCoverage {
  const r = seededRandom(`${ticker}-pt`);
  const upside = 0.08 + r * 0.22;
  const mean = spotPrice * (1 + upside);
  const high = mean * (1.06 + r * 0.04);
  const low = mean * (0.88 - r * 0.05);

  const median = mean * (1 + upside * 0.5);
  const updatedAt = new Date().toISOString().slice(0, 10);
  const yahoo = analystSourceLinks(ticker)[0]!.url;

  const rows: AnalystTargetRow[] = [
    {
      source: "Sample consensus",
      label: "Illustrative mean target",
      target: mean,
      targetHigh: high,
      targetLow: low,
      targetMedian: median,
      updatedAt,
      isSample: true,
      url: yahoo,
    },
    {
      source: "Sample consensus",
      label: "Illustrative median",
      target: median,
      isSample: true,
      url: yahoo,
    },
    {
      source: "Sample consensus",
      label: "Illustrative high",
      target: high,
      isSample: true,
      url: yahoo,
    },
    {
      source: "Sample consensus",
      label: "Illustrative low",
      target: low,
      isSample: true,
      url: yahoo,
    },
    ...analystSourceLinks(ticker).map((s) => ({
      source: s.name,
      label: s.blurb,
      url: s.url,
      isSample: true,
    })),
  ];

  return {
    status: "sample",
    spotPrice,
    consensus: { mean, median, high, low, updatedAt },
    recommendations: {
      strongBuy: Math.round(4 + r * 8),
      buy: Math.round(6 + r * 10),
      hold: Math.round(3 + r * 5),
      sell: Math.round(1 + r * 3),
      strongSell: Math.round(r * 2),
      period: updatedAt,
    },
    rows,
    sources: analystSourceLinks(ticker),
  };
}

async function fetchRecommendations(
  symbol: string,
  key: string,
): Promise<AnalystRecommendations | undefined> {
  try {
    const recs = await httpJson<FinnhubRecommendation[]>(
      `${FINNHUB}/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
    );
    const latest = recs?.[0];
    if (!latest) return undefined;
    return {
      strongBuy: latest.strongBuy ?? 0,
      buy: latest.buy ?? 0,
      hold: latest.hold ?? 0,
      sell: latest.sell ?? 0,
      strongSell: latest.strongSell ?? 0,
      period: latest.period,
    };
  } catch {
    return undefined;
  }
}

function coverageFromConsensus(
  symbol: string,
  spotPrice: number,
  status: AnalystCoverage["status"],
  pt: {
    mean?: number;
    median?: number;
    high?: number;
    low?: number;
    updatedAt?: string;
  },
  recommendations: AnalystRecommendations | undefined,
  linkRows: AnalystTargetRow[],
  sources: ReturnType<typeof analystSourceLinks>,
  labelPrefix: string,
): AnalystCoverage {
  const consensusRow: AnalystTargetRow = {
    source: labelPrefix,
    label: status === "live" ? "Street consensus (mean)" : "Estimated mean target",
    target: pt.mean,
    targetHigh: pt.high,
    targetLow: pt.low,
    targetMedian: pt.median,
    updatedAt: pt.updatedAt,
    url: finnhubSymbolUrl(symbol),
    isSample: status === "sample",
  };

  const rows: AnalystTargetRow[] = [
    consensusRow,
  ];

  if (pt.median != null) {
    rows.push({
      source: labelPrefix,
      label: status === "live" ? "Consensus median" : "Estimated median",
      target: pt.median,
      url: finnhubSymbolUrl(symbol),
      updatedAt: pt.updatedAt,
      isSample: status === "sample",
    });
  }
  if (pt.high != null) {
    rows.push({
      source: labelPrefix,
      label: status === "live" ? "Street high target" : "Estimated high",
      target: pt.high,
      url: finnhubSymbolUrl(symbol),
      isSample: status === "sample",
    });
  }
  if (pt.low != null) {
    rows.push({
      source: labelPrefix,
      label: status === "live" ? "Street low target" : "Estimated low",
      target: pt.low,
      url: finnhubSymbolUrl(symbol),
      isSample: status === "sample",
    });
  }

  rows.push(...linkRows);

  return {
    status,
    spotPrice,
    consensus: {
      mean: pt.mean,
      median: pt.median,
      high: pt.high,
      low: pt.low,
      updatedAt: pt.updatedAt,
    },
    recommendations,
    rows,
    sources,
  };
}

function estimatedCoverage(
  symbol: string,
  spotPrice: number,
  recommendations: AnalystRecommendations,
  linkRows: AnalystTargetRow[],
  sources: ReturnType<typeof analystSourceLinks>,
): AnalystCoverage {
  const consensus = estimateConsensusFromRatings(spotPrice, recommendations);
  const total = analystRatingTotal(recommendations);
  return coverageFromConsensus(
    symbol,
    spotPrice,
    "estimated",
    consensus,
    recommendations,
    linkRows,
    sources,
    `Finnhub · ${total} analysts`,
  );
}

/**
 * Multi-source analyst coverage.
 *
 * Order of preference:
 *   1. Blended live consensus across every configured source (Finnhub + FMP/TipRanks).
 *   2. Estimated consensus from live Finnhub buy/hold/sell ratings.
 *   3. Sample numbers for the fictional demo universe.
 *   4. Outbound links only (real ticker, no live consensus available).
 */
export async function fetchAnalystCoverage(ticker: string, spotPrice: number): Promise<AnalystCoverage> {
  const symbol = ticker.trim().toUpperCase();
  const sources = analystSourceLinks(symbol);
  const linkRows: AnalystTargetRow[] = sources.map((s) => ({
    source: s.name,
    label: s.blurb,
    url: s.url,
    origin: "link",
  }));

  const key = finnhubKey();
  const hasLiveKey = Boolean(key) || Boolean(fmpKey());

  if (!hasLiveKey) {
    if (isSampleUniverseTicker(symbol) && isSampleDataModeEnabled()) {
      return sampleCoverage(symbol, spotPrice);
    }
    return { status: "links_only", spotPrice, rows: linkRows, sources };
  }

  // 1) Blended consensus from all configured live sources.
  try {
    const aggregated = await aggregateAnalystCoverage(symbol, spotPrice);
    if (aggregated) {
      if (!aggregated.recommendations && key) {
        aggregated.recommendations = await fetchRecommendations(symbol, key);
      }
      return aggregated;
    }
  } catch {
    /* fall through */
  }

  // 2) Estimated from live ratings (Finnhub).
  if (key) {
    const recommendations = await fetchRecommendations(symbol, key);
    if (recommendations && analystRatingTotal(recommendations) > 0) {
      return estimatedCoverage(symbol, spotPrice, recommendations, linkRows, sources);
    }
  }

  // 3) / 4) Sample for demo universe (ONLY in Sample data mode), else outbound links.
  if (isSampleUniverseTicker(symbol) && isSampleDataModeEnabled()) {
    return sampleCoverage(symbol, spotPrice);
  }
  return { status: "links_only", spotPrice, rows: linkRows, sources };
}
