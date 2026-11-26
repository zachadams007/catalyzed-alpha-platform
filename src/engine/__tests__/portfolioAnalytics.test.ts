import { describe, it, expect } from "vitest";

import { computePortfolioAnalytics } from "@/engine/portfolioAnalytics";
import type { Portfolio, PortfolioHolding, StockSignal } from "@/types";

function makePortfolio(holdings: PortfolioHolding[]): Portfolio {
  return {
    id: "portfolio-1",
    name: "Test Portfolio",
    mode: "Custom",
    description: "Deterministic analytics fixture",
    owner: "me",
    isPublic: false,
    holdings,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function makeSignal(
  ticker: string,
  price: number,
  opportunityScore: number,
  confidence = 80,
): StockSignal {
  return {
    id: ticker,
    ticker,
    name: `${ticker} Corp`,
    sector: "Technology",
    price,
    dayChange: 0.02,
    marketCap: 1_000_000_000,
    priceHistory: [price],
    priceSeries: [{ date: "2026-06-01", close: price }],
    fundamentals: {
      revenueGrowthYoY: 0.1,
      epsGrowthYoY: 0.1,
      grossMargin: 0.5,
      netMargin: 0.1,
      peRatio: 20,
      pegRatio: 1.5,
      debtToEquity: 0.4,
      fcfMargin: 0.08,
    },
    momentum: {
      return1M: 0.03,
      return3M: 0.08,
      return6M: 0.12,
      rsi: 55,
      aboveSMA50: true,
      aboveSMA200: true,
      relativeStrength3M: 0.04,
    },
    catalyst: {
      type: "Product",
      description: "Test product launch",
      daysAway: 14,
      magnitude: 0.5,
    },
    news: {
      items: [],
      sentiment: 0.1,
      count7d: 1,
      freshnessHours: 12,
    },
    social: {
      redditMentions24h: 10,
      xMentions24h: 20,
      politicalMentions: 0,
      sentiment: 0.1,
      trendDelta: 0.05,
      summary: "Test social summary",
    },
    socialPosts: [],
    volatility: {
      beta: 1.1,
      atrPct: 0.03,
      impliedVol: 0.4,
    },
    liquidity: {
      avgDollarVolume: 50_000_000,
      floatShares: 100_000_000,
    },
    risk: {
      shortInterestPct: 0.04,
      dilutionRisk: 0.1,
      cashRunwayQuarters: 8,
      governanceFlag: 0,
    },
    sources: [],
    score: {
      opportunityScore,
      confidence,
      confidenceExplanation: "Deterministic fixture",
      riskPenalty: 0,
      riskExplanation: "No fixture penalty",
      categories: [],
    },
    marketCapBucket: "Mid",
    riskLevel: "Moderate",
    confidence,
    catalystType: "Product",
    generatedAt: "2026-06-01T00:00:00.000Z",
    thesis: "Test thesis",
    newsInsight: "Test news insight",
    momentumNote: "Test momentum note",
    socialSummary: "Test social summary",
    keyFundamentals: [],
    hype: {
      score: 50,
      tier: "Warming",
      tldr: "Test hype summary",
      drivers: [],
    },
  };
}

function makeLookup(signals: StockSignal[]): (ticker: string) => StockSignal | undefined {
  const byTicker = new Map(signals.map((signal) => [signal.ticker, signal]));
  return (ticker) => byTicker.get(ticker);
}

describe("computePortfolioAnalytics", () => {
  it("computes portfolio totals and profit/loss percentages", () => {
    const portfolio = makePortfolio([
      {
        ticker: "ALFA",
        addedAt: "2026-06-01T00:00:00.000Z",
        shares: 10,
        costBasis: 8,
      },
      {
        ticker: "BETA",
        addedAt: "2026-06-01T00:00:00.000Z",
        shares: 5,
        costBasis: 20,
      },
    ]);
    const lookup = makeLookup([
      makeSignal("ALFA", 10, 70),
      makeSignal("BETA", 30, 90),
    ]);

    const result = computePortfolioAnalytics(portfolio, lookup);

    expect(result.totalValue).toBe(250);
    expect(result.totalCost).toBe(180);
    expect(result.totalPL).toBe(70);
    expect(result.totalPLPct).toBeCloseTo(70 / 180);
    expect(result.rows[0].plPct).toBeCloseTo(0.25);
    expect(result.rows[1].plPct).toBeCloseTo(0.5);
  });

  it("rounds the average opportunity score across matched signals", () => {
    const portfolio = makePortfolio([
      { ticker: "ALFA", addedAt: "2026-06-01T00:00:00.000Z" },
      { ticker: "BETA", addedAt: "2026-06-01T00:00:00.000Z" },
    ]);
    const lookup = makeLookup([
      makeSignal("ALFA", 10, 61),
      makeSignal("BETA", 20, 70),
    ]);

    expect(computePortfolioAnalytics(portfolio, lookup).avgOpportunity).toBe(66);
  });

  it("returns zeroed analytics for an empty portfolio", () => {
    const result = computePortfolioAnalytics(makePortfolio([]), makeLookup([]));

    expect(result).toEqual({
      rows: [],
      totalValue: 0,
      totalCost: 0,
      totalPL: 0,
      totalPLPct: 0,
      dayChangeValue: 0,
      dayChangePct: 0,
      tracked: false,
      valuedCount: 0,
      sectorAllocation: [],
      holdingAllocation: [],
      sectorGroups: [],
      avgOpportunity: null,
      avgConfidence: null,
    });
  });

  it("uses imported value and unclassified allocation when a signal lookup is missing", () => {
    const portfolio = makePortfolio([
      {
        ticker: "MISS",
        addedAt: "2026-06-01T00:00:00.000Z",
        value: 75,
      },
    ]);

    const result = computePortfolioAnalytics(portfolio, makeLookup([]));

    expect(result.totalValue).toBe(75);
    expect(result.valuedCount).toBe(1);
    expect(result.avgOpportunity).toBeNull();
    expect(result.avgConfidence).toBeNull();
    expect(result.rows[0]).toMatchObject({
      ticker: "MISS",
      hasSignal: false,
      importedValue: 75,
      marketValue: 75,
      weight: 1,
    });
    expect(result.sectorAllocation).toEqual([
      {
        label: "Unclassified",
        value: 75,
        pct: 1,
        color: "var(--pf-slice-1)",
      },
    ]);
  });

  it("nests holdings inside their sector for the concentric rings", () => {
    const portfolio = makePortfolio([
      { ticker: "ALFA", addedAt: "2026-06-01T00:00:00.000Z", shares: 10, costBasis: 5 },
      { ticker: "BETA", addedAt: "2026-06-01T00:00:00.000Z", shares: 10, costBasis: 5 },
      { ticker: "GAMA", addedAt: "2026-06-01T00:00:00.000Z", shares: 10, costBasis: 5 },
    ]);
    // ALFA + BETA are Technology (the default fixture sector); GAMA is Energy,
    // so Technology should dominate the outer ring and wrap two inner holdings.
    const energy = { ...makeSignal("GAMA", 40, 70), sector: "Energy" as const };
    const lookup = makeLookup([makeSignal("ALFA", 60, 70), makeSignal("BETA", 20, 70), energy]);

    const { sectorGroups } = computePortfolioAnalytics(portfolio, lookup);

    // Total value = 600 + 200 + 400 = 1200. Technology = 800 (66.7%), Energy = 400.
    expect(sectorGroups.map((g) => g.label)).toEqual(["Technology", "Energy"]);
    expect(sectorGroups[0].pct).toBeCloseTo(2 / 3);
    expect(sectorGroups[0].color).toBe("var(--pf-slice-1)");
    expect(sectorGroups[1].color).toBe("var(--pf-slice-2)");
    // Holdings nest under their sector, ordered largest-first, with whole-book pct.
    expect(sectorGroups[0].holdings.map((h) => h.ticker)).toEqual(["ALFA", "BETA"]);
    expect(sectorGroups[0].holdings[0].pct).toBeCloseTo(0.5);
    expect(sectorGroups[0].holdings[1].sectorRank).toBe(1);
    expect(sectorGroups[1].holdings).toHaveLength(1);
    expect(sectorGroups[1].holdings[0].ticker).toBe("GAMA");
  });
});
