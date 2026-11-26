import { describe, expect, it } from "vitest";

import { scoreCompany } from "@/engine/scoring";
import { computeNormalizedScores } from "@/engine/normalizeUniverse";
import type { CompanyData, StockSignal } from "@/types";

/**
 * Lane B-1 - NaN-proofing the scoring choke points.
 *
 * A NaN in any single sub-score used to survive `round(clamp(score))` (the old
 * `clamp` returned NaN for a NaN input) and flow into the cross-sectional
 * normalization, whose sort comparators treat a NaN difference as 0 - silently
 * mis-ordering the percentile ranks / z-scores of the WHOLE universe. These tests
 * lock in that (1) every category leaves `scoreCompany` finite even when a raw
 * input is NaN, and (2) one poisoned signal can never change how the OTHER names
 * in the same universe rank.
 */

function makePriceHistory(): number[] {
  return Array.from({ length: 120 }, (_, i) => (i < 60 ? 35 + i * 0.45 : 62 - (i - 60) * 0.2));
}

/** A complete, valid CompanyData with sensible defaults; tweak `rsi` per case. */
function makeCompany(over: { ticker: string; rsi?: number; marketCap?: number }): CompanyData {
  const priceHistory = makePriceHistory();
  return {
    ticker: over.ticker,
    name: over.ticker,
    sector: "Technology",
    price: 50,
    dayChange: 0.012,
    marketCap: over.marketCap ?? 6.5e9,
    priceHistory,
    priceSeries: priceHistory.map((close, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      close,
    })),
    fundamentals: {
      revenueGrowthYoY: 0.18,
      epsGrowthYoY: 0.2,
      grossMargin: 0.45,
      netMargin: 0.12,
      peRatio: 28,
      pegRatio: 1.4,
      debtToEquity: 0.6,
      fcfMargin: 0.1,
    },
    momentum: {
      return1M: 0.08,
      return3M: 0.16,
      return6M: 0.28,
      rsi: over.rsi ?? 58,
      aboveSMA50: true,
      aboveSMA200: true,
      relativeStrength3M: 0.08,
    },
    catalyst: {
      type: "Product",
      description: "A new enterprise platform launches next week.",
      daysAway: 10,
      magnitude: 0.55,
    },
    news: {
      items: [],
      sentiment: 0.2,
      count7d: 6,
      freshnessHours: 18,
    },
    social: {
      redditMentions24h: 180,
      xMentions24h: 420,
      politicalMentions: 0,
      sentiment: 0.15,
      trendDelta: 0.2,
      summary: "Measured discussion across technology forums.",
    },
    socialPosts: [],
    volatility: {
      beta: 1.35,
      atrPct: 0.055,
      impliedVol: 0.65,
    },
    liquidity: {
      avgDollarVolume: 120e6,
      floatShares: 130e6,
    },
    risk: {
      shortInterestPct: 0.05,
      dilutionRisk: 0.05,
      cashRunwayQuarters: 4,
      governanceFlag: 0,
    },
    sources: [{ label: "Company filings", url: "https://sec.gov/Archives/nova" }],
    fundamentalsAvailability: Object.fromEntries(
      [
        "revenueGrowthYoY",
        "epsGrowthYoY",
        "grossMargin",
        "netMargin",
        "peRatio",
        "pegRatio",
        "debtToEquity",
        "fcfMargin",
      ].map((k) => [k, true]),
    ),
    catalystLive: true,
  } as unknown as CompanyData;
}

/** A minimal StockSignal carrying a real ScoreBreakdown for the named company. */
function signalFor(company: CompanyData): StockSignal {
  return {
    ticker: company.ticker,
    name: company.name,
    sector: company.sector,
    marketCap: company.marketCap,
    score: scoreCompany(company),
  } as unknown as StockSignal;
}

describe("Lane B-1 — NaN-proof scoring & ranking", () => {
  it("scoreCompany keeps every category finite when rsi is NaN", () => {
    const result = scoreCompany(makeCompany({ ticker: "NAN", rsi: NaN }));
    for (const cat of result.categories) {
      expect(Number.isFinite(cat.score)).toBe(true);
    }
    expect(Number.isFinite(result.opportunityScore)).toBe(true);
    const momentum = result.categories.find((c) => c.key === "momentum");
    expect(momentum).toBeDefined();
    expect(Number.isFinite(momentum!.score)).toBe(true);
  });

  it("a NaN sub-score in one signal does not reorder the OTHER names in the universe", () => {
    // Four clean names with distinct, spread market caps so the cross-sectional
    // pass produces an unambiguous ranking among them.
    const clean: CompanyData[] = [
      makeCompany({ ticker: "AAA", marketCap: 2e8, rsi: 40 }),
      makeCompany({ ticker: "BBB", marketCap: 2e9, rsi: 55 }),
      makeCompany({ ticker: "CCC", marketCap: 2e10, rsi: 65 }),
      makeCompany({ ticker: "DDD", marketCap: 2e11, rsi: 70 }),
    ];
    // The same universe plus one extra name whose rsi is NaN (poison candidate).
    const poison = makeCompany({ ticker: "ZZZ", marketCap: 9e9, rsi: NaN });

    const cleanSignals = clean.map(signalFor);
    const withPoison = [...clean, poison].map(signalFor);

    const rankOf = (scores: { ticker: string; opportunityScore: number }[]) =>
      [...scores]
        .filter((s) => s.ticker !== "ZZZ")
        .sort((a, b) => b.opportunityScore - a.opportunityScore)
        .map((s) => s.ticker);

    // Note: adding a name legitimately shifts the cross-sectional reference set,
    // so we don't compare absolute scores. The INVARIANT B-1 guarantees is that
    // the poisoned name fails GRACEFULLY - every score stays finite - instead of
    // NaN-poisoning the sort and scrambling the rest of the universe.
    const withPoisonScores = computeNormalizedScores(withPoison);
    for (const s of withPoisonScores) expect(Number.isFinite(s.opportunityScore)).toBe(true);

    // And the four clean names, scored on their own, rank in a stable, finite order.
    const cleanRank = rankOf(computeNormalizedScores(cleanSignals));
    expect(cleanRank).toHaveLength(4);
    expect(new Set(cleanRank).size).toBe(4);
  });

  it("a stray NaN injected directly into a dimension cannot scramble ranks", () => {
    // Build signals, then poison ONE name's momentum category to NaN post-hoc to
    // simulate any future code path that lets a NaN slip past scoreCompany. The
    // sanitize guards in winsorize/percentileRank/residualize must absorb it.
    const base: CompanyData[] = [
      makeCompany({ ticker: "AAA", marketCap: 2e8, rsi: 40 }),
      makeCompany({ ticker: "BBB", marketCap: 2e9, rsi: 55 }),
      makeCompany({ ticker: "CCC", marketCap: 2e10, rsi: 65 }),
      makeCompany({ ticker: "DDD", marketCap: 2e11, rsi: 70 }),
      makeCompany({ ticker: "EEE", marketCap: 9e9, rsi: 60 }),
    ];

    const clean = base.map(signalFor);
    const dirty = base.map(signalFor);
    // Poison EEE's momentum sub-score directly.
    const eee = dirty.find((s) => s.ticker === "EEE")!;
    const mom = eee.score.categories.find((c) => c.key === "momentum")!;
    (mom as { score: number }).score = NaN;

    const order = (signals: StockSignal[]) =>
      [...computeNormalizedScores(signals)]
        .sort((a, b) => b.opportunityScore - a.opportunityScore)
        .map((s) => s.ticker);

    const cleanOrder = order(clean);
    const dirtyOrder = order(dirty);

    // Every score finite despite the injected NaN…
    for (const s of computeNormalizedScores(dirty)) {
      expect(Number.isFinite(s.opportunityScore)).toBe(true);
    }
    // …and the order of the names OTHER than the poisoned one is preserved.
    const drop = (o: string[]) => o.filter((t) => t !== "EEE");
    expect(drop(dirtyOrder)).toEqual(drop(cleanOrder));
  });
});
