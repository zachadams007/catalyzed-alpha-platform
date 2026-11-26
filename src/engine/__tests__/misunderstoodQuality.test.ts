import { describe, expect, it } from "vitest";

import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import {
  computeNormalizedScores,
  inferArchetypeFlags,
  MISUNDERSTOOD_V6_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
} from "@/engine/normalizeUniverse";
import { MISUNDERSTOOD_QUALITY_WEIGHTS, capCurveWeights } from "@/engine/capCurve";
import type { CompanyData } from "@/types";

/**
 * V6 T4 - the MISUNDERSTOOD-QUALITY archetype.
 *
 * The hole it fills (found by auditing the live board on 2026-07-25): a
 * profitable large cap in a deep drawdown whose DISCLOSED order book is growing
 * far faster than recognized revenue was tagged by no archetype at all -
 * megaReversal rejected it on leverage, compounder rejected it on momentum (it is
 * in a downtrend by definition), smallRunner rejected it on size. Oracle, 65% off
 * its high with a filed $638B RPO against $67B of revenue, ranked 246 of 486.
 *
 * These tests pin BOTH directions: the archetype must fire for that shape, and
 * must NOT fire for the falling knife it superficially resembles.
 */

/** A long, deep drawdown: ramp up, then a sustained decline to ~35% of the peak. */
function drawdownHistory(): number[] {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i * 2.5); // → 297.5
  const down = Array.from({ length: 180 }, (_, i) => 297.5 - i * 1.1); // → ~100
  return [...up, ...down];
}

function makeCompany(over: Partial<CompanyData> = {}): CompanyData {
  const priceHistory = over.priceHistory ?? drawdownHistory();
  return {
    ticker: "TEST",
    name: "Test Co",
    sector: "Technology",
    price: priceHistory[priceHistory.length - 1]!,
    dayChange: -0.01,
    marketCap: 300e9,
    priceHistory,
    priceSeries: priceHistory.map((close, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      close,
    })),
    fundamentals: {
      revenueGrowthYoY: 0.17,
      epsGrowthYoY: 0.3,
      grossMargin: 0.66,
      netMargin: 0.25,
      peRatio: 19,
      pegRatio: 1.05,
      // Leverage that the OLD quality floor rejected outright (> 2.5x) but which
      // is comfortably serviced by a 25% net margin.
      debtToEquity: 3.0,
      fcfMargin: 0.05,
    },
    momentum: {
      return1M: -0.27,
      return3M: -0.35,
      return6M: -0.36,
      rsi: 26,
      aboveSMA50: false,
      aboveSMA200: false,
      relativeStrength3M: -0.39,
    },
    catalyst: { type: "None", description: "", daysAway: 365, magnitude: 0 },
    news: { items: [], sentiment: 0, count7d: 10, freshnessHours: 2 },
    social: {
      redditMentions24h: 50,
      xMentions24h: 50,
      politicalMentions: 0,
      sentiment: 0,
      trendDelta: 0,
      summary: "",
    },
    socialPosts: [],
    volatility: { beta: 1.2, atrPct: 0.05, impliedVol: 0.5 },
    liquidity: { avgDollarVolume: 2_000_000_000, floatShares: 2_000_000_000 },
    risk: { shortInterestPct: 0.03, dilutionRisk: 0.05, cashRunwayQuarters: 20, governanceFlag: 0 },
    sources: [],
    // The disclosed order book: contracted demand compounding far ahead of the
    // recognized revenue line (Oracle's RPO went $137.8B → $638.0B, +363%).
    pipeline: { backlogToRevTTM: 9.5, backlogYoY: 3.63 },
    ...over,
  };
}

const asSignal = (c: CompanyData) => toStockSignal(c, scoreCompany(c), "2026-07-25T00:00:00.000Z");

describe("V6 T4 — misunderstood-quality archetype detection", () => {
  it("tags a profitable, deeply-discounted large cap whose booked demand outruns revenue", () => {
    const flags = inferArchetypeFlags(asSignal(makeCompany()));
    expect(flags.misunderstoodQuality).toBe(true);
    // It is precisely the name the other archetypes reject: compounder needs
    // bounded/positive momentum, and this name is in a hard downtrend.
    expect(flags.compounder).not.toBe(true);
    expect(flags.smallRunner).not.toBe(true);
  });

  it("does NOT tag a name whose backlog is growing SLOWER than revenue", () => {
    // The value-trap shape: big absolute order book, but demand is decelerating.
    const flags = inferArchetypeFlags(
      asSignal(makeCompany({ pipeline: { backlogToRevTTM: 9.5, backlogYoY: 0.02 } })),
    );
    expect(flags.misunderstoodQuality).toBe(false);
  });

  it("does NOT tag a name with no disclosed pipeline at all — never inferred from the chart", () => {
    const flags = inferArchetypeFlags(asSignal(makeCompany({ pipeline: undefined })));
    expect(flags.misunderstoodQuality).toBe(false);
  });

  it("does NOT tag an unprofitable falling knife with the same price action", () => {
    const flags = inferArchetypeFlags(
      asSignal(
        makeCompany({
          fundamentals: { ...makeCompany().fundamentals, netMargin: -0.35, epsGrowthYoY: -0.8 },
        }),
      ),
    );
    expect(flags.misunderstoodQuality).toBe(false);
  });

  it("does NOT tag a name whose drawdown is so deep it implies a broken business", () => {
    // ~92% off the high - a solvency story, not a repricing.
    const wipeout = [
      ...Array.from({ length: 80 }, (_, i) => 100 + i * 2.5),
      ...Array.from({ length: 180 }, (_, i) => 297.5 - i * 1.53),
    ];
    const flags = inferArchetypeFlags(asSignal(makeCompany({ priceHistory: wipeout })));
    expect(flags.misunderstoodQuality).toBe(false);
  });

  it("does NOT tag a name that has barely pulled back — the drawdown IS the entry", () => {
    const shallow = [
      ...Array.from({ length: 140 }, (_, i) => 100 + i * 1),
      ...Array.from({ length: 120 }, (_, i) => 240 - i * 0.1),
    ];
    const flags = inferArchetypeFlags(asSignal(makeCompany({ priceHistory: shallow })));
    expect(flags.misunderstoodQuality).toBe(false);
  });

  it("does NOT tag a small cap — that shape is the smallRunner archetype's job", () => {
    const flags = inferArchetypeFlags(
      asSignal(makeCompany({ marketCap: 8e8, liquidity: { avgDollarVolume: 5e6, floatShares: 5e7 } })),
    );
    expect(flags.misunderstoodQuality).toBe(false);
  });

  it("does NOT tag a name flagged going-concern, however good the order book looks", () => {
    const flags = inferArchetypeFlags(
      asSignal(
        makeCompany({
          risk: {
            shortInterestPct: 0.03,
            dilutionRisk: 0.05,
            cashRunwayQuarters: 2,
            governanceFlag: 0,
            goingConcernFlag: true,
          },
        }),
      ),
    );
    expect(flags.misunderstoodQuality).toBe(false);
  });
});

describe("V6 T4 — serviced leverage no longer disqualifies quality", () => {
  it("scores 3x debt/equity on a 25% net margin as not-a-penalty, not a zero", () => {
    const levered = scoreCompany(makeCompany()).categories.find((c) => c.key === "fundamentals")!;
    const unlevered = scoreCompany(
      makeCompany({ fundamentals: { ...makeCompany().fundamentals, debtToEquity: 0.3 } }),
    ).categories.find((c) => c.key === "fundamentals")!;
    // Low leverage is still BETTER - the fix removes the cliff, not the ordering.
    expect(unlevered.score).toBeGreaterThan(levered.score);
    // …but serviced leverage must not crater the dimension the way it used to.
    expect(levered.score).toBeGreaterThan(65);
  });

  it("still punishes negative book equity when the business is NOT profitable", () => {
    const base = makeCompany();
    const serviced = scoreCompany(
      makeCompany({ fundamentals: { ...base.fundamentals, debtToEquity: -2 } }),
    ).categories.find((c) => c.key === "fundamentals")!.score;
    const unserviced = scoreCompany(
      makeCompany({
        fundamentals: { ...base.fundamentals, debtToEquity: -2, netMargin: -0.2 },
      }),
    ).categories.find((c) => c.key === "fundamentals")!.score;
    expect(serviced).toBeGreaterThan(unserviced);
  });
});

describe("V6 T4 — weight routing and the bounded tilt", () => {
  it("routes a T4 name onto a pipeline/valuation-led vector with momentum near zero", () => {
    const w = capCurveWeights(300e9, { misunderstoodQuality: true });
    expect(w.pipeline).toBeGreaterThan(w.momentum);
    expect(w.valuation).toBeGreaterThan(w.momentum);
    expect(MISUNDERSTOOD_QUALITY_WEIGHTS.momentum).toBeLessThan(0.05);
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("pays the T4 lift only under V6 — V5 leaves the same name alone", () => {
    // NOTE on the assertion shape: the displayed opportunityScore blends in a
    // cross-sectional PERCENTILE (`decompressDisplay`), which in a small universe
    // quantizes to a handful of buckets and hides real point differences. So the
    // MODEL is measured with that display remap off, and the lift is asserted
    // against an otherwise-IDENTICAL twin that discloses no order book - same
    // universe, same pass, one variable.
    const v5Options = { ...REVERSAL_V5_NORMALIZATION, decompressDisplay: false };
    const v6Options = { ...MISUNDERSTOOD_V6_NORMALIZATION, decompressDisplay: false };
    const universe = [
      asSignal(makeCompany()), // TEST - discloses the order book
      asSignal(makeCompany({ ticker: "TWIN", pipeline: undefined })), // identical, no disclosure
      asSignal(makeCompany({ ticker: "PEER1", marketCap: 120e9, pipeline: undefined })),
      asSignal(makeCompany({ ticker: "PEER2", marketCap: 60e9, pipeline: undefined })),
    ];
    const v5 = computeNormalizedScores(universe, undefined, v5Options);
    const v6 = computeNormalizedScores(universe, undefined, v6Options);

    const v5Test = v5.find((r) => r.ticker === "TEST")!;
    const v5Twin = v5.find((r) => r.ticker === "TWIN")!;
    const v6Test = v6.find((r) => r.ticker === "TEST")!;
    const v6Twin = v6.find((r) => r.ticker === "TWIN")!;

    expect(v5Test.misunderstoodTilt).toBe(0);
    expect(v6Test.misunderstoodTilt).toBeGreaterThan(0);
    expect(v6Twin.misunderstoodTilt).toBe(0);
    // Under V6 the disclosed order book is worth real points over the twin.
    expect(v6Test.opportunityScore).toBeGreaterThan(v6Twin.opportunityScore);
    // …and V6 does not rank the disclosing name BELOW where V5 put it.
    expect(v6Test.opportunityScore).toBeGreaterThanOrEqual(v5Test.opportunityScore);
    // NOTE: a difference-of-differences on `opportunityScore` is NOT a safe
    // assertion here - the published score is clamped to 0..100, and this fixture
    // is deliberately a very strong name, so V6's extra tilt can push it into the
    // clamp and make the measured gap look SMALLER than V5's while the underlying
    // model change is strictly additive. The unclamped statement of the same
    // intent is the tilt itself, asserted above.
  });

  it("pays nothing to a name with no disclosed pipeline, even under V6", () => {
    const universe = [
      asSignal(makeCompany({ pipeline: undefined })),
      asSignal(makeCompany({ ticker: "PEER1", marketCap: 120e9, pipeline: undefined })),
      asSignal(makeCompany({ ticker: "PEER2", marketCap: 60e9, pipeline: undefined })),
    ];
    const v6 = computeNormalizedScores(universe, undefined, MISUNDERSTOOD_V6_NORMALIZATION);
    for (const row of v6) expect(row.misunderstoodTilt).toBe(0);
  });

  it("keeps the tilt inside its bound", () => {
    const universe = [
      // Absurd disclosed lead - the tilt must still saturate, not run away.
      asSignal(makeCompany({ pipeline: { backlogToRevTTM: 50, backlogYoY: 11 } })),
      asSignal(makeCompany({ ticker: "PEER1", marketCap: 120e9, pipeline: undefined })),
      asSignal(makeCompany({ ticker: "PEER2", marketCap: 60e9, pipeline: undefined })),
    ];
    const v6 = computeNormalizedScores(universe, undefined, MISUNDERSTOOD_V6_NORMALIZATION);
    const test = v6.find((r) => r.ticker === "TEST")!;
    expect(test.misunderstoodTilt).toBeLessThanOrEqual(16);
  });
});
