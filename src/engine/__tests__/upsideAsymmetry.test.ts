import { describe, expect, it } from "vitest";

import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import {
  computeNormalizedScores,
  MISUNDERSTOOD_V6_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
} from "@/engine/normalizeUniverse";
import { withdrawContradictoryFundamentals } from "@/data/fundamentals/publishInvariant";
import type { CompanyData, RawFundamentals } from "@/types";

/**
 * V6 UPSIDE ASYMMETRY (owner request 2026-07-25).
 *
 * The model could rank a mega-cap 12% below its high above a quality name 65%
 * below its high, purely on fundamentals and a live catalyst - with nothing in the
 * score expressing that one had ~14% of room to reclaim its high and the other
 * ~186%, or that the mega-cap's move is largely the index's move. "Be greedy when
 * others are fearful" needs a term that measures how much room is actually left.
 */

function priceHistory(offHighPct: number): number[] {
  // Ramp to a peak of 300, then decline to leave the name `offHighPct` off it.
  const peak = 300;
  const end = peak * (1 - offHighPct);
  const up = Array.from({ length: 80 }, (_, i) => 100 + (i * (peak - 100)) / 79);
  const down = Array.from({ length: 180 }, (_, i) => peak - (i * (peak - end)) / 179);
  return [...up, ...down];
}

function makeCompany(over: Partial<CompanyData> = {}): CompanyData {
  const history = over.priceHistory ?? priceHistory(0.5);
  return {
    ticker: "TEST",
    name: "Test Co",
    sector: "Technology",
    price: history[history.length - 1]!,
    dayChange: 0,
    marketCap: 200e9,
    priceHistory: history,
    priceSeries: history.map((close, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      close,
    })),
    fundamentals: {
      revenueGrowthYoY: 0.2,
      epsGrowthYoY: 0.25,
      grossMargin: 0.6,
      netMargin: 0.25,
      peRatio: 25,
      pegRatio: 1.1,
      debtToEquity: 0.4,
      fcfMargin: 0.2,
    },
    momentum: {
      return1M: -0.05,
      return3M: -0.1,
      return6M: -0.2,
      rsi: 40,
      aboveSMA50: false,
      aboveSMA200: false,
      relativeStrength3M: -0.1,
    },
    catalyst: { type: "None", description: "", daysAway: 365, magnitude: 0 },
    news: { items: [], sentiment: 0, count7d: 5, freshnessHours: 12 },
    social: {
      redditMentions24h: 0,
      xMentions24h: 0,
      politicalMentions: 0,
      sentiment: 0,
      trendDelta: 0,
      summary: "",
    },
    socialPosts: [],
    volatility: { beta: 1, atrPct: 0.04, impliedVol: 0 },
    liquidity: { avgDollarVolume: 500_000_000, floatShares: 1e9 },
    risk: { shortInterestPct: 0, dilutionRisk: 0, cashRunwayQuarters: 12, governanceFlag: 0 },
    sources: [],
    ...over,
  };
}

const asSignal = (c: CompanyData) => toStockSignal(c, scoreCompany(c), "2026-07-25T00:00:00.000Z");

/** Score one name inside a fixed peer set so the cross-sectional pass is stable. */
function tiltFor(subject: CompanyData): number {
  const universe = [
    asSignal(subject),
    asSignal(makeCompany({ ticker: "P1", marketCap: 120e9 })),
    asSignal(makeCompany({ ticker: "P2", marketCap: 60e9 })),
    asSignal(makeCompany({ ticker: "P3", marketCap: 300e9 })),
  ];
  const rows = computeNormalizedScores(universe, undefined, {
    ...MISUNDERSTOOD_V6_NORMALIZATION,
    decompressDisplay: false,
  });
  return rows.find((r) => r.ticker === subject.ticker)!.asymmetryTilt;
}

describe("upside asymmetry — room to run", () => {
  it("pays a quality name deep in a drawdown", () => {
    expect(tiltFor(makeCompany({ priceHistory: priceHistory(0.6) }))).toBeGreaterThan(0);
  });

  it("pays MORE the deeper the drawdown, all else equal", () => {
    const shallow = tiltFor(makeCompany({ priceHistory: priceHistory(0.3) }));
    const deep = tiltFor(makeCompany({ priceHistory: priceHistory(0.65) }));
    expect(deep).toBeGreaterThan(shallow);
  });

  it("penalises a near-high mega-cap whose upside is structurally capped", () => {
    const tilt = tiltFor(
      makeCompany({ priceHistory: priceHistory(0.1), marketCap: 5_000e9, volatility: { beta: 1.6, atrPct: 0.04, impliedVol: 0 } }),
    );
    expect(tilt).toBeLessThan(0);
  });

  it("penalises harder when more of the move is the market's (higher beta)", () => {
    const base = { priceHistory: priceHistory(0.08), marketCap: 4_000e9 };
    const lowBeta = tiltFor(makeCompany({ ...base, volatility: { beta: 0.9, atrPct: 0.04, impliedVol: 0 } }));
    const highBeta = tiltFor(makeCompany({ ...base, volatility: { beta: 2.0, atrPct: 0.04, impliedVol: 0 } }));
    expect(highBeta).toBeLessThan(lowBeta);
  });

  it("gives a big cap LESS credit than a small one for the same drawdown", () => {
    const small = tiltFor(makeCompany({ priceHistory: priceHistory(0.55), marketCap: 40e9 }));
    const mega = tiltFor(makeCompany({ priceHistory: priceHistory(0.55), marketCap: 2_500e9 }));
    expect(small).toBeGreaterThan(mega);
  });

  it("pays a CHEAP BROKEN business nothing — quality-gated, not a discount factor", () => {
    const broken = makeCompany({
      priceHistory: priceHistory(0.7),
      fundamentals: {
        revenueGrowthYoY: -0.3,
        epsGrowthYoY: -0.9,
        grossMargin: 0.02,
        netMargin: -0.9,
        peRatio: null,
        pegRatio: null,
        debtToEquity: 9,
        fcfMargin: -1.1,
      },
    });
    expect(tiltFor(broken)).toBeLessThanOrEqual(0.5);
  });

  it("is inert under V5 — this is a V6-only term", () => {
    const universe = [
      asSignal(makeCompany({ priceHistory: priceHistory(0.6) })),
      asSignal(makeCompany({ ticker: "P1", marketCap: 120e9 })),
      asSignal(makeCompany({ ticker: "P2", marketCap: 60e9 })),
    ];
    const v5 = computeNormalizedScores(universe, undefined, REVERSAL_V5_NORMALIZATION);
    for (const row of v5) expect(row.asymmetryTilt).toBe(0);
  });
});

describe("contradictory vendor fundamentals are withdrawn, not guessed", () => {
  const base = (): { f: RawFundamentals; a: Partial<Record<keyof RawFundamentals, boolean>> } => ({
    f: {
      revenueGrowthYoY: 0.4,
      epsGrowthYoY: 0.06,
      grossMargin: 0,
      netMargin: -0.198,
      peRatio: 36.6,
      pegRatio: 0.96,
      debtToEquity: 0.17,
      fcfMargin: 0,
    },
    a: { netMargin: true, peRatio: true },
  });

  it("withdraws BOTH a negative net margin and the positive P/E it contradicts (the SoFi case)", () => {
    const { f, a } = base();
    expect(withdrawContradictoryFundamentals(f, a)).toBe(true);
    expect(a.netMargin).toBe(false);
    expect(a.peRatio).toBe(false);
  });

  it("leaves a consistent pair alone", () => {
    const { f, a } = base();
    f.netMargin = 0.15;
    expect(withdrawContradictoryFundamentals(f, a)).toBe(false);
    expect(a.netMargin).toBe(true);
    expect(a.peRatio).toBe(true);
  });

  it("does nothing when either field was never available", () => {
    const { f, a } = base();
    a.peRatio = false;
    expect(withdrawContradictoryFundamentals(f, a)).toBe(false);
  });
});
