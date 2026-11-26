import { describe, expect, it } from "vitest";

import { scoreCompany } from "@/engine/scoring";
import {
  archetypeOverlay,
  capCohort,
  capCurveWeights,
  cohortWeights,
  COMPOUNDER_WEIGHTS,
  effectiveCapCohort,
  LARGE_CAP_WEIGHTS,
  MEGA_REVERSAL_WEIGHTS,
  MID_CAP_WEIGHTS,
  SMALL_CAP_WEIGHTS,
  SMALL_RUNNER_WEIGHTS,
} from "@/engine/capCurve";
import { inferArchetypeFlags } from "@/engine/normalizeUniverse";
import { computeSentimentShift } from "@/engine/sentimentShift";
import { toStockSignal } from "@/engine/enrich";
import type { CompanyData, ScoreCategoryKey } from "@/types";

// ---------------------------------------------------------------------------
// A minimal, all-fields-present CompanyData factory (everything live & neutral).
// ---------------------------------------------------------------------------
function makeCompany(over: Partial<CompanyData> = {}): CompanyData {
  const priceHistory = Array.from({ length: 120 }, (_, i) => (i < 60 ? 40 + i * 0.5 : 70 - (i - 60) * 0.3));
  return {
    ticker: "TEST",
    name: "Test Co",
    sector: "Technology",
    price: 50,
    dayChange: 0,
    marketCap: 1.5e9,
    priceHistory,
    priceSeries: priceHistory.map((close, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      close,
    })),
    fundamentals: {
      revenueGrowthYoY: 0.1,
      epsGrowthYoY: 0.05,
      grossMargin: 0.4,
      netMargin: 0.05,
      peRatio: 25,
      pegRatio: 1.5,
      debtToEquity: 0.5,
      fcfMargin: 0.05,
    },
    momentum: {
      return1M: 0.02,
      return3M: 0.05,
      return6M: 0.1,
      rsi: 52,
      aboveSMA50: true,
      aboveSMA200: true,
      relativeStrength3M: 0.02,
    },
    catalyst: { type: "Product", description: "", daysAway: 14, magnitude: 0.5 },
    news: { items: [], sentiment: 0.1, count7d: 4, freshnessHours: 24 },
    social: { redditMentions24h: 50, xMentions24h: 50, politicalMentions: 0, sentiment: 0.1, trendDelta: 0.1, summary: "" },
    socialPosts: [],
    volatility: { beta: 1.1, atrPct: 0.05, impliedVol: 0.6 },
    liquidity: { avgDollarVolume: 20_000_000, floatShares: 80_000_000 },
    risk: { shortInterestPct: 0.05, dilutionRisk: 0.1, cashRunwayQuarters: 8, governanceFlag: 0 },
    sources: [],
    ...over,
  };
}

const cat = (c: CompanyData, key: ScoreCategoryKey) =>
  scoreCompany(c).categories.find((x) => x.key === key)!.score;

const asSignal = (c: CompanyData) =>
  toStockSignal(c, scoreCompany(c), "2026-06-29T00:00:00.000Z");

type NestedCompanyOverrides = Partial<
  Omit<CompanyData, "fundamentals" | "momentum" | "catalyst">
> & {
  fundamentals?: Partial<CompanyData["fundamentals"]>;
  momentum?: Partial<CompanyData["momentum"]>;
  catalyst?: Partial<CompanyData["catalyst"]>;
};

function makeSignal(over: NestedCompanyOverrides = {}) {
  const base = makeCompany();
  return asSignal({
    ...base,
    ...over,
    fundamentals: { ...base.fundamentals, ...over.fundamentals },
    momentum: { ...base.momentum, ...over.momentum },
    catalyst: { ...base.catalyst, ...over.catalyst },
  });
}

const sumWeights = (w: Record<ScoreCategoryKey, number>) =>
  Object.values(w).reduce((a, b) => a + b, 0);

// ===========================================================================
describe("capCurve — cohort routing", () => {
  it("routes by the 3-tier boundaries (≤$2B small · $2–10B mid · >$10B large); Unknown → small", () => {
    expect(capCohort(3e8)).toBe("small"); // $0.3B
    expect(capCohort(1.9e9)).toBe("small"); // $1.9B
    expect(capCohort(2.9e9)).toBe("mid"); // $2.9B - the middle strategy
    expect(capCohort(3.1e9)).toBe("mid"); // $3.1B - still mid, not large
    expect(capCohort(1.1e10)).toBe("large"); // $11B
    expect(capCohort(2e11)).toBe("large"); // $200B
    expect(capCohort(0)).toBe("unknown");
    expect(capCohort(NaN)).toBe("unknown");
    expect(capCohort(-5)).toBe("unknown");
  });

  it("effectiveCapCohort upgrades a cap-UNKNOWN but highly-liquid name to the large curve (P2)", () => {
    // The TSM-style ADR: marketCap missing, but trades $20B/day → judged as large.
    expect(effectiveCapCohort(0, 20e9)).toBe("large");
    // A genuinely thin unknown stays "unknown" (→ routed to the small/discovery
    // curve by cohortWeights) - it is NOT upgraded (never trades $1B+/day).
    expect(effectiveCapCohort(0, 5e8)).toBe("unknown");
    expect(effectiveCapCohort(0)).toBe("unknown");
    expect(cohortWeights(effectiveCapCohort(0, 5e8))).toBe(SMALL_CAP_WEIGHTS);
    // A KNOWN cap is unaffected by liquidity.
    expect(effectiveCapCohort(5e9, 20e9)).toBe("mid");
  });

  it("all three weight curves are proper weighted averages (sum to 1.0)", () => {
    expect(sumWeights(SMALL_CAP_WEIGHTS)).toBeCloseTo(1, 9);
    expect(sumWeights(MID_CAP_WEIGHTS)).toBeCloseTo(1, 9);
    expect(sumWeights(LARGE_CAP_WEIGHTS)).toBeCloseTo(1, 9);
  });

  it("the mid curve sits between small and large (revenue re-accel + growth led)", () => {
    // Mid leans on inflection + growth + pipeline (re-acceleration), between the two.
    expect(MID_CAP_WEIGHTS.inflection).toBeGreaterThan(SMALL_CAP_WEIGHTS.inflection);
    expect(MID_CAP_WEIGHTS.growth).toBeGreaterThan(LARGE_CAP_WEIGHTS.growth);
    expect(cohortWeights("mid")).toBe(MID_CAP_WEIGHTS);
    // A $5B name routes to the mid curve.
    expect(capCurveWeights(5e9).inflection).toBeCloseTo(MID_CAP_WEIGHTS.inflection, 9);
  });

  it("locks the V4 Phase A spine re-weight inside the Phase C conviction carve-out", () => {
    expect(SMALL_CAP_WEIGHTS.conviction).toBeCloseTo(0.1, 9);
    expect(LARGE_CAP_WEIGHTS.conviction).toBeCloseTo(0.07, 9);
    expect(SMALL_CAP_WEIGHTS.inflection / (1 - SMALL_CAP_WEIGHTS.conviction)).toBeCloseTo(0.18, 2);
    expect(SMALL_CAP_WEIGHTS.social).toBeCloseTo(0.01, 9);
    expect(LARGE_CAP_WEIGHTS.inflection / (1 - LARGE_CAP_WEIGHTS.conviction)).toBeCloseTo(0.22, 2);
    expect(LARGE_CAP_WEIGHTS.pipeline / (1 - LARGE_CAP_WEIGHTS.conviction)).toBeCloseTo(0.08, 2);
    expect(LARGE_CAP_WEIGHTS.social).toBeCloseTo(0.02, 9);
  });

  it("the small curve weights pipeline/catalyst/growth more than the large curve", () => {
    expect(SMALL_CAP_WEIGHTS.pipeline).toBeGreaterThan(LARGE_CAP_WEIGHTS.pipeline);
    expect(SMALL_CAP_WEIGHTS.growth).toBeGreaterThan(LARGE_CAP_WEIGHTS.growth);
    // …and the large curve leans more on the margin inflection + fundamentals.
    expect(LARGE_CAP_WEIGHTS.inflection).toBeGreaterThan(SMALL_CAP_WEIGHTS.inflection);
    expect(LARGE_CAP_WEIGHTS.fundamentals).toBeGreaterThan(SMALL_CAP_WEIGHTS.fundamentals);
  });

  it("an unknown-cap name uses the small/discovery curve", () => {
    expect(capCurveWeights(0)).toBe(SMALL_CAP_WEIGHTS);
    expect(cohortWeights("unknown")).toBe(SMALL_CAP_WEIGHTS);
  });

  it("defines normalized V4 archetype profiles and blends without hard-branching", () => {
    expect(sumWeights(MEGA_REVERSAL_WEIGHTS)).toBeCloseTo(1, 9);
    expect(sumWeights(COMPOUNDER_WEIGHTS)).toBeCloseTo(1, 9);
    expect(sumWeights(SMALL_RUNNER_WEIGHTS)).toBeCloseTo(1, 9);
    expect(MEGA_REVERSAL_WEIGHTS.conviction).toBeCloseTo(0.1, 9);
    expect(COMPOUNDER_WEIGHTS.conviction).toBeCloseTo(0.07, 9);
    expect(SMALL_RUNNER_WEIGHTS.conviction).toBeCloseTo(0.1, 9);

    const reversal = capCurveWeights(2e11, { megaReversal: true });
    expect(sumWeights(reversal)).toBeCloseTo(1, 9);
    expect(reversal.valuation).toBeGreaterThan(LARGE_CAP_WEIGHTS.valuation);
    expect(reversal.momentum).toBeLessThan(LARGE_CAP_WEIGHTS.momentum);

    const blended = archetypeOverlay(SMALL_CAP_WEIGHTS, {
      compounder: true,
      smallRunner: true,
    });
    expect(sumWeights(blended)).toBeCloseTo(1, 9);
    expect(blended.pipeline).toBeGreaterThan(SMALL_CAP_WEIGHTS.pipeline);
    expect(blended.social).toBeLessThanOrEqual(SMALL_CAP_WEIGHTS.social);
  });
});

// ===========================================================================
describe("V4 archetype router — pure flag detection", () => {
  it("tags a large washed-out quality reversal as T1", () => {
    const history = Array.from({ length: 140 }, (_, i) => 115 - i * 0.45);
    const flags = inferArchetypeFlags(
      makeSignal({
        marketCap: 650e9,
        price: 52,
        priceHistory: history,
        fundamentals: { revenueGrowthYoY: 0.06, fcfMargin: 0.12, debtToEquity: 0.35 },
        momentum: { rsi: 31, aboveSMA50: false, aboveSMA200: false, return3M: -0.12 },
        inflection: {
          grossMarginDeltaYoY: 0.02,
          opMarginNow: 0.02,
          opMarginPrevYearQ: -0.04,
        },
      }),
    );
    expect(flags.megaReversal).toBe(true);
    expect(flags.smallRunner).not.toBe(true);
  });

  it("tags a re-accelerating large/mid compounder with healthy but not parabolic momentum as T2", () => {
    const flags = inferArchetypeFlags(
      makeSignal({
        marketCap: 18e9,
        momentum: { rsi: 66, aboveSMA50: true, aboveSMA200: true, return3M: 0.18 },
        inflection: {
          revAccelQoQ: 0.045,
          grossMarginDeltaYoY: 0.03,
        },
        pipeline: { bookToBill: 1.28 },
      }),
    );
    expect(flags.compounder).toBe(true);
    expect(flags.megaReversal).not.toBe(true);
  });

  it("tags a small runner on fresh catalyst plus early trend without requiring a discount", () => {
    const flags = inferArchetypeFlags(
      makeSignal({
        marketCap: 850e6,
        momentum: { rsi: 59, aboveSMA50: true, aboveSMA200: false, return1M: 0.08 },
        catalystLive: true,
        catalyst: {
          type: "Partnership",
          description: "New hyperscaler partnership announced.",
          daysAway: -7,
          magnitude: 0.65,
        },
      }),
    );
    expect(flags.smallRunner).toBe(true);
    expect(flags.megaReversal).not.toBe(true);
  });

  it("does NOT tag an EXTENDED large-cap (chasing highs) as a compounder", () => {
    // Up ~170% off its base (runFromLow > 0.8) - a large-cap chasing highs is NOT a
    // compounder even with re-acceleration + bounded momentum (the owner's TSM problem).
    const upHistory = Array.from({ length: 140 }, (_, i) => 40 + i * 0.5); // low 40 → last ~109
    const flags = inferArchetypeFlags(
      makeSignal({
        marketCap: 200e9,
        price: 108,
        priceHistory: upHistory,
        momentum: { rsi: 70, aboveSMA50: true, aboveSMA200: true, return3M: 0.4 },
        inflection: { revAccelQoQ: 0.045, grossMarginDeltaYoY: 0.03 },
      }),
    );
    expect(flags.compounder).toBe(false);
  });

  it("treats an unknown-cap name trading like a mega-cap (TSM) as large — not a small runner", () => {
    // marketCap 0 (a data miss) but $5B/day volume + extended off its base → it must NOT
    // ride the small-runner curve; it's effectively large and chasing.
    const upHistory = Array.from({ length: 140 }, (_, i) => 40 + i * 0.5);
    const flags = inferArchetypeFlags(
      makeSignal({
        marketCap: 0,
        price: 108,
        priceHistory: upHistory,
        liquidity: { avgDollarVolume: 5_000_000_000, floatShares: 1e9 },
        momentum: { rsi: 70, aboveSMA50: true, aboveSMA200: true, return1M: 0.1, return3M: 0.4 },
        inflection: { revAccelQoQ: 0.045 },
      }),
    );
    expect(flags.smallRunner).toBe(false);
    expect(flags.compounder).toBe(false); // cap unknown → not isLarge → not a compounder either
  });

  it("requires a GENUINE 2nd-derivative for re-acceleration (marginal growth no longer counts)", () => {
    // revAccelQoQ 0.01 / revYoYAccel 0.01 are below the tightened thresholds (0.02 / 0.03)
    // - a barely-positive number must not label the name a re-accelerating compounder.
    const flags = inferArchetypeFlags(
      makeSignal({
        marketCap: 50e9,
        momentum: { rsi: 60, aboveSMA50: true, aboveSMA200: true, return3M: 0.15 },
        inflection: { revAccelQoQ: 0.01, revYoYAccel: 0.01 },
      }),
    );
    expect(flags.compounder).toBe(false);
  });
});

// ===========================================================================
describe("v2 inflection / pipeline scorers — cold-start safe", () => {
  it("score a neutral 50 when no v2 inputs are present (never fabricates a trend)", () => {
    const c = makeCompany();
    expect(cat(c, "inflection")).toBe(50);
    expect(cat(c, "pipeline")).toBe(50);
    expect(cat(c, "conviction")).toBe(50);
  });

  it("reward a real revenue/margin re-acceleration", () => {
    const flat = makeCompany({ revenueTTM: 800_000_000 });
    const inflecting = makeCompany({
      // A real revenue base: the guard added 2026-07-26 damps growth/inflection
      // credit toward neutral without one, because a 2nd derivative on a near-zero
      // revenue line is arithmetic rather than evidence.
      revenueTTM: 800_000_000,
      inflection: {
        revAccelQoQ: 0.08,
        revYoYAccel: 0.03,
        grossMarginDeltaYoY: 0.05,
        opMarginNow: 0.02,
        opMarginPrevYearQ: -0.05,
        opexPctRevDeltaYoY: -0.03,
      },
    });
    expect(cat(inflecting, "inflection")).toBeGreaterThan(cat(flat, "inflection"));
    expect(cat(inflecting, "inflection")).toBeGreaterThan(70);
  });

  it("reward a hard order book (book-to-bill / backlog / named contract)", () => {
    const backlog = makeCompany({
      revenueTTM: 800_000_000,
      pipeline: { bookToBill: 1.5, backlogToRevTTM: 1.8 },
    });
    expect(cat(backlog, "pipeline")).toBeGreaterThan(70);
    // a partial fold still works (the strongest available ratio carries it)
    const contract = makeCompany({ pipeline: { namedContractPctRev: 0.25 } });
    expect(cat(contract, "pipeline")).toBeGreaterThan(60);
  });

  it("uses forward visibility and retention as cold-start-safe pipeline support", () => {
    const weakVisibility = makeCompany({
      fundamentals: { ...makeCompany().fundamentals, revenueGrowthYoY: 0.2 },
      pipeline: { backlogYoY: 0.08, deferredRevYoY: 0.06, nrr: 0.96, shareDeltaBps: -100 },
    });
    const strongVisibility = makeCompany({
      fundamentals: { ...makeCompany().fundamentals, revenueGrowthYoY: 0.12 },
      pipeline: { backlogYoY: 0.28, deferredRevYoY: 0.34, nrr: 1.18, shareDeltaBps: 320 },
    });
    expect(cat(strongVisibility, "pipeline")).toBeGreaterThan(cat(weakVisibility, "pipeline"));
    expect(cat(strongVisibility, "pipeline")).toBeGreaterThan(60);
  });

  it("promotes smart-money and strategic capital through conviction, not catalyst", () => {
    const quiet = makeCompany({ catalystLive: false });
    const convicted = makeCompany({
      catalystLive: false,
      congressTrades: Array.from({ length: 4 }, (_, i) => ({
        representative: `R${i}`,
        chamber: "House",
        transaction: "buy",
        amountRange: "$1,000,001 - $5,000,000",
        transactionDate: "2026-06-10",
      })),
      secActivity: {
        cik: "0000000001",
        form4Count90d: 3,
        eightKCount90d: 0,
        filings: [{ form: "SC 13D", filedAt: "2026-06-10", url: "https://sec.gov/x" }],
        form4BuyCount90d: 3,
        form4NetBuyValue90d: 2_000_000,
      },
      strategicCapital: { investor: "Strategic buyer", amountUsd: 75_000_000, disclosedStrike: 55 },
    });
    expect(cat(quiet, "conviction")).toBe(50);
    expect(cat(convicted, "conviction")).toBeGreaterThan(80);
    expect(cat(convicted, "catalyst")).toBe(cat(quiet, "catalyst"));
  });

  it("rewards cheap-vs-own-history valuation and down-weights parabolic momentum", () => {
    const cheapOwnHistory = makeCompany({ valuation: { peVsOwn5yrPctile: 0.08 } });
    const richOwnHistory = makeCompany({ valuation: { peVsOwn5yrPctile: 0.92 } });
    expect(cat(cheapOwnHistory, "valuation")).toBeGreaterThan(cat(richOwnHistory, "valuation"));

    const healthyTrend = makeCompany({
      momentum: {
        return1M: 0.08,
        return3M: 0.24,
        return6M: 0.36,
        rsi: 64,
        aboveSMA50: true,
        aboveSMA200: true,
        relativeStrength3M: 0.16,
      },
    });
    const parabolic = makeCompany({
      momentum: {
        return1M: 0.28,
        return3M: 0.8,
        return6M: 1.1,
        rsi: 86,
        aboveSMA50: true,
        aboveSMA200: true,
        relativeStrength3M: 0.45,
      },
    });
    expect(cat(parabolic, "momentum")).toBeLessThan(cat(healthyTrend, "momentum"));
  });
});

// ===========================================================================
describe("sentimentShift — z vs own baseline, anti-hype gated", () => {
  it("is a neutral 50 on a cold start (no trailing series)", () => {
    const r = computeSentimentShift(makeCompany());
    expect(r.score).toBe(50);
    expect(r.coldStart).toBe(true);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it("scores a genuine positive shift WITH substance above neutral", () => {
    const c = makeCompany({
      sentimentSeries: {
        socialPolarity: [0.0, 0.0, 0.0, 0.05, 0.6],
        socialVolume: [100, 110, 105, 130, 400],
        newsTone: [0.0, 0.0, 0.05, 0.1, 0.5],
        newsVolume: [1, 1, 2, 2, 6],
      },
      news: {
        items: [
          { headline: "Big contract win", source: "Reuters", url: "https://reuters.com/x", publishedAt: "2026-06-20T00:00:00Z", sentiment: 0.6 },
          { headline: "Analyst upgrade", source: "Bloomberg", url: "https://bloomberg.com/y", publishedAt: "2026-06-20T00:00:00Z", sentiment: 0.5 },
        ],
        sentiment: 0.5,
        count7d: 6,
        freshnessHours: 6,
      },
      secActivity: { cik: "0000000001", form4Count90d: 2, eightKCount90d: 2, filings: [] },
    });
    const r = computeSentimentShift(c);
    expect(r.coldStart).toBe(false);
    expect(r.unconfirmedHype).toBe(false);
    expect(r.score).toBeGreaterThan(55);
    expect(r.rawSigma).toBeGreaterThan(0);
  });

  it("demotes a hype spike with NO hard event behind it (unconfirmed hype)", () => {
    const noSubstance = makeCompany({
      sentimentSeries: {
        socialPolarity: [0.0, 0.0, 0.0, 0.05, 0.7],
        socialVolume: [100, 110, 105, 130, 500],
        newsTone: [0, 0, 0, 0, 0],
        newsVolume: [0, 0, 0, 0, 0],
      },
      news: { items: [], sentiment: 0, count7d: 0, freshnessHours: 200 },
    });
    const r = computeSentimentShift(noSubstance);
    expect(r.unconfirmedHype).toBe(true);
    // The substance gate (×0.3) holds it well below a corroborated shift.
    expect(r.score).toBeLessThan(45);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});

// ===========================================================================
describe("anti-lottery pumpRisk — demotes pumps, never zeroes a real setup", () => {
  const penalty = (c: CompanyData) => scoreCompany(c).riskPenalty;

  it("penalizes a no-revenue shell at a non-trivial cap", () => {
    const shell = makeCompany({
      revenueTTM: 0,
      marketCap: 2e8,
      liquidity: { avgDollarVolume: 800_000, floatShares: 5_000_000 },
    });
    const withRevenue = makeCompany({ revenueTTM: 5e8, marketCap: 2e8 });
    expect(penalty(shell)).toBeGreaterThan(penalty(withRevenue));
    expect(penalty(shell)).toBeLessThanOrEqual(25); // bounded by RISK.cap
  });

  it("penalizes observed no-revenue shells below $50M too", () => {
    const shell = makeCompany({
      revenueTTM: 0,
      marketCap: 35e6,
      liquidity: { avgDollarVolume: 150_000, floatShares: 3_000_000 },
    });
    const withRevenue = makeCompany({ revenueTTM: 3e7, marketCap: 35e6 });
    expect(penalty(shell)).toBeGreaterThan(penalty(withRevenue));
  });

  it("exempts a biotech-binary name from the no-revenue penalty", () => {
    const shell = makeCompany({ revenueTTM: 0, marketCap: 2e8 });
    const biotech = makeCompany({ revenueTTM: 0, marketCap: 2e8, binaryCatalystTag: true });
    expect(penalty(biotech)).toBeLessThan(penalty(shell));
  });

  it("does NOT over-penalize a genuine small-cap with revenue + healthy float", () => {
    const realSmallCap = makeCompany({
      revenueTTM: 4e8,
      marketCap: 1.2e9,
      liquidity: { avgDollarVolume: 8_000_000, floatShares: 40_000_000 },
      risk: { shortInterestPct: 0.05, dilutionRisk: 0.05, cashRunwayQuarters: 10, governanceFlag: 0 },
    });
    // No pump flags ⇒ the risk penalty stays modest (well below the cap).
    expect(penalty(realSmallCap)).toBeLessThan(6);
  });

  it("demotes a value trap while sparing an improving discounted reversal", () => {
    const trap = makeCompany({
      marketCap: 35e9,
      fundamentals: {
        ...makeCompany().fundamentals,
        revenueGrowthYoY: -0.16,
        fcfMargin: -0.12,
        debtToEquity: 3.4,
      },
      inflection: { revYoYAccel: -0.05, revAccelQoQ: -0.03, opexPctRevDeltaYoY: 0.05 },
      pipeline: { shareDeltaBps: -260 },
      risk: { ...makeCompany().risk, dividendCutOrSuspended: true, dilutionRisk: 0.42 },
    });
    const improving = makeCompany({
      marketCap: 35e9,
      fundamentals: {
        ...makeCompany().fundamentals,
        revenueGrowthYoY: 0.04,
        fcfMargin: 0.06,
        debtToEquity: 0.4,
      },
      inflection: {
        revYoYAccel: 0.02,
        grossMarginDeltaYoY: 0.02,
        opMarginNow: 0.04,
        opMarginPrevYearQ: -0.03,
      },
    });
    expect(penalty(trap)).toBeGreaterThan(penalty(improving) + 3);
  });

  it("demotes a small-cap falling knife only when no fresh reason is present", () => {
    const knife = makeCompany({
      marketCap: 450e6,
      momentum: {
        ...makeCompany().momentum,
        aboveSMA50: false,
        aboveSMA200: false,
        return1M: -0.08,
        return3M: -0.24,
      },
      catalystLive: false,
    });
    const withReason = makeCompany({
      marketCap: 450e6,
      momentum: {
        ...makeCompany().momentum,
        aboveSMA50: false,
        aboveSMA200: false,
        return1M: -0.08,
        return3M: -0.24,
      },
      catalystLive: true,
      catalyst: { type: "Partnership", description: "New contract award", daysAway: -5, magnitude: 0.7 },
    });
    expect(penalty(knife)).toBeGreaterThan(penalty(withReason));
  });

  it("does not treat high short interest as risk when it is squeeze fuel with a confirmed turn", () => {
    const crowdedNoTurn = makeCompany({
      risk: { ...makeCompany().risk, shortInterestPct: 0.28, daysToCover: 7 },
    });
    const squeezeFuel = makeCompany({
      risk: { ...makeCompany().risk, shortInterestPct: 0.28, daysToCover: 7 },
      inflection: { revAccelQoQ: 0.04, grossMarginDeltaYoY: 0.03 },
      pipeline: { bookToBill: 1.25 },
    });
    expect(penalty(squeezeFuel)).toBeLessThan(penalty(crowdedNoTurn));
  });
});

// ===========================================================================
describe("scoreInflection — base-size guard (P3: not every stock is re-accelerating)", () => {
  const inflectionScore = (c: CompanyData) =>
    scoreCompany(c).categories.find((x) => x.key === "inflection")!.score;
  const inflectionCopy = (c: CompanyData) =>
    scoreCompany(c).categories.find((x) => x.key === "inflection")!.explanation;

  it("damps a huge revenue 2nd-derivative on a TINY revenue base toward neutral", () => {
    const tinyBase = makeCompany({ revenueTTM: 4_000_000, inflection: { revAccelQoQ: 0.9 } });
    const bigBase = makeCompany({ revenueTTM: 500_000_000, inflection: { revAccelQoQ: 0.9 } });
    // The micro-cap's "+90% QoQ" is base-effect noise → near neutral; the SAME
    // acceleration on a real revenue base is a genuine, high inflection read.
    expect(inflectionScore(tinyBase)).toBeLessThan(inflectionScore(bigBase));
    expect(inflectionScore(tinyBase)).toBeLessThan(60);
    expect(inflectionScore(bigBase)).toBeGreaterThan(70);
  });

  it("does not slap 'revenue re-accelerating' on a tiny-base name", () => {
    const tinyBase = makeCompany({ revenueTTM: 4_000_000, inflection: { revAccelQoQ: 0.9 } });
    expect(inflectionCopy(tinyBase)).not.toMatch(/re-accelerating/i);
    const bigBase = makeCompany({ revenueTTM: 500_000_000, inflection: { revAccelQoQ: 0.9 } });
    expect(inflectionCopy(bigBase)).toMatch(/re-accelerating/i);
  });
});
