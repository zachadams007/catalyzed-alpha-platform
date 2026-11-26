import { describe, expect, it } from "vitest";

import { disclosedFloorUsd, smartMoneyCatalystBoost } from "@/engine/smartMoney";
import { SMART_MONEY } from "@/engine/scoringConfig";
import { scoreCompany } from "@/engine/scoring";
import type { CompanyData, CongressTrade, SecActivity } from "@/types";

// ---------------------------------------------------------------------------
// Fixtures - a minimal-but-complete CompanyData. `smartMoneyCatalystBoost` only
// reads `congressTrades` + `secActivity`; the rest exists so the same fixture
// can flow through `scoreCompany` in the integration checks.
// ---------------------------------------------------------------------------

function buy(amountRange = "$1,001 - $15,000", over: Partial<CongressTrade> = {}): CongressTrade {
  return {
    representative: "Hon. Test Filer",
    chamber: "House",
    transaction: "buy",
    amountRange,
    transactionDate: "2026-05-01",
    ...over,
  };
}

function sell(amountRange = "$1,001 - $15,000"): CongressTrade {
  return { ...buy(amountRange), transaction: "sell" };
}

function secActivity(over: Partial<SecActivity> = {}): SecActivity {
  return {
    cik: "0000000001",
    form4Count90d: 4,
    eightKCount90d: 1,
    filings: [],
    ...over,
  };
}

function makeCompany(overrides: Partial<CompanyData> = {}): CompanyData {
  const priceHistory = Array.from({ length: 60 }, (_, i) => 20 + i * 0.2);
  return {
    ticker: "TEST",
    name: "Test Co",
    sector: "Technology",
    price: 32,
    dayChange: 0.01,
    marketCap: 2e9,
    priceHistory,
    priceSeries: priceHistory.map((close, i) => ({
      date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
      close,
    })),
    fundamentals: {
      revenueGrowthYoY: 0.1,
      epsGrowthYoY: 0.1,
      grossMargin: 0.4,
      netMargin: 0.08,
      peRatio: 25,
      pegRatio: 1.5,
      debtToEquity: 0.6,
      fcfMargin: 0.08,
    },
    momentum: {
      return1M: 0.04,
      return3M: 0.08,
      return6M: 0.12,
      rsi: 55,
      aboveSMA50: true,
      aboveSMA200: true,
      relativeStrength3M: 0.04,
    },
    catalyst: {
      type: "Product",
      description: "A product update ships next week.",
      daysAway: 12,
      magnitude: 0.5,
    },
    news: {
      items: [],
      sentiment: 0.1,
      count7d: 4,
      freshnessHours: 24,
    },
    social: {
      redditMentions24h: 100,
      xMentions24h: 200,
      politicalMentions: 0,
      sentiment: 0.1,
      trendDelta: 0.1,
      summary: "Measured discussion.",
    },
    socialPosts: [],
    volatility: { beta: 1.2, atrPct: 0.05, impliedVol: 0.6 },
    liquidity: { avgDollarVolume: 50e6, floatShares: 80e6 },
    risk: {
      shortInterestPct: 0.04,
      dilutionRisk: 0.05,
      cashRunwayQuarters: 6,
      governanceFlag: 0,
    },
    sources: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// disclosedFloorUsd
// ---------------------------------------------------------------------------

describe("disclosedFloorUsd", () => {
  it.each([
    ["$1,001 - $15,000", 1001],
    ["$15,001 - $50,000", 15001],
    ["$50,001 - $100,000", 50001],
    ["$1,000,001 - $5,000,000", 1_000_001],
    ["$50,000,000 +", 50_000_000],
    ["$1 - $1,000", 1],
    ["$500", 500],
  ])("parses the disclosed floor of %s as %i", (range, expected) => {
    expect(disclosedFloorUsd(range)).toBe(expected);
  });

  it.each([["Undisclosed"], ["N/A"], ["no dollar amount here"], [""]])(
    "returns 0 for the unparseable band %s",
    (range) => {
      expect(disclosedFloorUsd(range)).toBe(0);
    },
  );

  it("returns 0 for undefined", () => {
    expect(disclosedFloorUsd(undefined)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Degrades silently to zero
// ---------------------------------------------------------------------------

describe("smartMoneyCatalystBoost — no data degrades to zero", () => {
  it("returns a zero boost with no congress trades and no SEC activity", () => {
    const result = smartMoneyCatalystBoost(makeCompany());
    expect(result).toEqual({ points: 0, congress: 0, insider: 0, reason: "" });
  });

  it("returns zero for an empty congress-trades array", () => {
    expect(smartMoneyCatalystBoost(makeCompany({ congressTrades: [] })).points).toBe(0);
  });

  it("returns zero when congress disclosed only sells", () => {
    const result = smartMoneyCatalystBoost(makeCompany({ congressTrades: [sell(), sell()] }));
    expect(result.points).toBe(0);
    expect(result.congress).toBe(0);
  });

  it("returns zero when congress disclosed only an exchange", () => {
    const exchange: CongressTrade = { ...buy(), transaction: "exchange" };
    expect(smartMoneyCatalystBoost(makeCompany({ congressTrades: [exchange] })).points).toBe(0);
  });

  it("returns zero when SEC activity has no aggregated insider-buy fields", () => {
    // form4Count90d alone (all Form 4s, any code) must NOT imply buying.
    const result = smartMoneyCatalystBoost(
      makeCompany({ secActivity: secActivity({ form4Count90d: 9 }) }),
    );
    expect(result.points).toBe(0);
    expect(result.insider).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Congressional buying
// ---------------------------------------------------------------------------

describe("smartMoneyCatalystBoost — congressional buying", () => {
  it("gives a single small buy a small positive boost", () => {
    const result = smartMoneyCatalystBoost(makeCompany({ congressTrades: [buy()] }));
    // 1 of 4 buys → count path 0.25 → 5.0 pts (V3 maxBoost 20).
    expect(result.points).toBeCloseTo(5.0, 5);
    expect(result.congress).toBeCloseTo(0.25, 5);
    expect(result.insider).toBe(0);
    expect(result.reason).toContain("1 disclosed congressional buy");
  });

  it("scales up with more buys and saturates at the count threshold", () => {
    const two = smartMoneyCatalystBoost(makeCompany({ congressTrades: [buy(), buy()] }));
    const four = smartMoneyCatalystBoost(
      makeCompany({ congressTrades: [buy(), buy(), buy(), buy()] }),
    );
    expect(two.points).toBeCloseTo(10, 5); // 0.5 × 20
    expect(four.points).toBeCloseTo(SMART_MONEY.maxBoost, 5); // 4 buys → full
    expect(four.congress).toBe(1);
  });

  it("monotonically increases the boost as buys are added", () => {
    const one = smartMoneyCatalystBoost(makeCompany({ congressTrades: [buy()] })).points;
    const two = smartMoneyCatalystBoost(makeCompany({ congressTrades: [buy(), buy()] })).points;
    const three = smartMoneyCatalystBoost(
      makeCompany({ congressTrades: [buy(), buy(), buy()] }),
    ).points;
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it("lets one large disclosed buy reach the cap on the size path alone", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({ congressTrades: [buy("$250,001 - $500,000")] }),
    );
    // 1 buy → count path only 0.25, but $250k floor saturates the size path.
    expect(result.points).toBeCloseTo(SMART_MONEY.maxBoost, 5);
    expect(result.congress).toBe(1);
  });

  it("ignores sells when buys are present (boost only, no penalty)", () => {
    const withSells = smartMoneyCatalystBoost(
      makeCompany({ congressTrades: [buy(), sell(), sell(), sell()] }),
    );
    const buyOnly = smartMoneyCatalystBoost(makeCompany({ congressTrades: [buy()] }));
    expect(withSells.points).toBe(buyOnly.points);
  });
});

// ---------------------------------------------------------------------------
// Insider buying (pre-aggregated Form 4 "P" fields)
// ---------------------------------------------------------------------------

describe("smartMoneyCatalystBoost — insider buying", () => {
  it("boosts on net-positive aggregated insider buying", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({
        secActivity: secActivity({ form4BuyCount90d: 3, form4NetBuyValue90d: 1_000_000 }),
      }),
    );
    expect(result.points).toBeCloseTo(SMART_MONEY.maxBoost, 5); // 3 buys & $1M net → full
    expect(result.insider).toBe(1);
    expect(result.congress).toBe(0);
    expect(result.reason).toContain("net insider buying");
  });

  it("scales a modest insider read below the cap", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({
        secActivity: secActivity({ form4BuyCount90d: 1, form4NetBuyValue90d: 200_000 }),
      }),
    );
    // count path 1/3 ≈ 0.333 (dominant) vs value path 0.2 → 6.7 pts (× 20).
    expect(result.points).toBeCloseTo(6.7, 5);
  });

  it("does NOT boost on net selling (negative net value)", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({
        secActivity: secActivity({ form4BuyCount90d: 2, form4NetBuyValue90d: -500_000 }),
      }),
    );
    expect(result.points).toBe(0);
    expect(result.insider).toBe(0);
  });

  it("does NOT boost when net buying is zero", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({
        secActivity: secActivity({ form4BuyCount90d: 2, form4NetBuyValue90d: 0 }),
      }),
    );
    expect(result.points).toBe(0);
  });

  it("does NOT boost when the buy count is zero even with positive value", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({
        secActivity: secActivity({ form4BuyCount90d: 0, form4NetBuyValue90d: 500_000 }),
      }),
    );
    expect(result.points).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Corroboration + bounds
// ---------------------------------------------------------------------------

describe("smartMoneyCatalystBoost — corroboration and bounds", () => {
  it("adds the two lanes when both fire (corroboration), naming both", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({
        congressTrades: [buy()], // congress 0.25
        secActivity: secActivity({ form4BuyCount90d: 1, form4NetBuyValue90d: 200_000 }), // insider 0.333
      }),
    );
    expect(result.congress).toBeCloseTo(0.25, 5);
    expect(result.insider).toBeCloseTo(1 / 3, 5);
    expect(result.points).toBeCloseTo(11.7, 5); // (0.25 + 0.333) × 20, rounded
    expect(result.reason).toContain("congressional buy");
    expect(result.reason).toContain("insider buying");
  });

  it("never exceeds maxBoost even with overwhelming buying on both lanes", () => {
    const result = smartMoneyCatalystBoost(
      makeCompany({
        congressTrades: Array.from({ length: 12 }, () => buy("$1,000,001 - $5,000,000")),
        secActivity: secActivity({ form4BuyCount90d: 25, form4NetBuyValue90d: 50_000_000 }),
      }),
    );
    expect(result.points).toBe(SMART_MONEY.maxBoost);
  });

  it("keeps points within [0, maxBoost] and intensities within [0, 1] across many shapes", () => {
    const shapes: Array<Partial<CompanyData>> = [
      {},
      { congressTrades: [] },
      { congressTrades: [buy(), sell()] },
      { congressTrades: [buy("$50,000,000 +")] },
      { secActivity: secActivity({ form4BuyCount90d: 7, form4NetBuyValue90d: 9_000_000 }) },
      { secActivity: secActivity({ form4BuyCount90d: 2, form4NetBuyValue90d: -1 }) },
      {
        congressTrades: [buy(), buy()],
        secActivity: secActivity({ form4BuyCount90d: 1, form4NetBuyValue90d: 1 }),
      },
    ];
    for (const shape of shapes) {
      const r = smartMoneyCatalystBoost(makeCompany(shape));
      expect(r.points).toBeGreaterThanOrEqual(0);
      expect(r.points).toBeLessThanOrEqual(SMART_MONEY.maxBoost);
      expect(r.congress).toBeGreaterThanOrEqual(0);
      expect(r.congress).toBeLessThanOrEqual(1);
      expect(r.insider).toBeGreaterThanOrEqual(0);
      expect(r.insider).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Purity / determinism - no clocks, no globals
// ---------------------------------------------------------------------------

describe("smartMoneyCatalystBoost — purity", () => {
  it("returns identical results for identical input across repeated calls", () => {
    const company = makeCompany({
      congressTrades: [buy(), buy()],
      secActivity: secActivity({ form4BuyCount90d: 2, form4NetBuyValue90d: 400_000 }),
    });
    const first = smartMoneyCatalystBoost(company);
    for (let i = 0; i < 5; i++) {
      expect(smartMoneyCatalystBoost(company)).toEqual(first);
    }
  });

  it("does not mutate the input company", () => {
    const company = makeCompany({ congressTrades: [buy(), sell()] });
    const snapshot = JSON.stringify(company);
    smartMoneyCatalystBoost(company);
    expect(JSON.stringify(company)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Integration with the scoring engine
// ---------------------------------------------------------------------------

describe("smart-money boost — integration with scoreCompany", () => {
  function convictionScore(c: CompanyData): number {
    return scoreCompany(c).categories.find((cat) => cat.key === "conviction")!.score;
  }

  it("lifts the conviction sub-score when congress is buying", () => {
    const plain = makeCompany();
    const buying = makeCompany({ congressTrades: [buy(), buy(), buy()] });
    expect(convictionScore(buying)).toBeGreaterThan(convictionScore(plain));
  });

  it("leaves the conviction sub-score unchanged with no smart-money data", () => {
    const a = convictionScore(makeCompany());
    const b = convictionScore(makeCompany({ secActivity: secActivity() })); // no buy fields
    expect(a).toBe(b);
  });

  it("keeps the boosted conviction sub-score within 0..100", () => {
    const maxedOut = makeCompany({
      catalyst: { type: "Insider", description: "Big buying.", daysAway: 0, magnitude: 1 },
      congressTrades: Array.from({ length: 8 }, () => buy("$1,000,001 - $5,000,000")),
      secActivity: secActivity({ form4BuyCount90d: 20, form4NetBuyValue90d: 40_000_000 }),
    });
    expect(convictionScore(maxedOut)).toBeLessThanOrEqual(100);
    expect(convictionScore(maxedOut)).toBeGreaterThanOrEqual(0);
  });

  it("surfaces the smart-money reason in the conviction explanation", () => {
    const buying = makeCompany({ congressTrades: [buy(), buy()] });
    const explanation = scoreCompany(buying).categories.find(
      (cat) => cat.key === "conviction",
    )!.explanation;
    expect(explanation).toContain("disclosed congressional");
  });

  it("keeps the positive category weights summing to 1.0", () => {
    const total = scoreCompany(makeCompany({ congressTrades: [buy()] })).categories.reduce(
      (sum, cat) => sum + cat.weight,
      0,
    );
    expect(total).toBeCloseTo(1, 3);
  });
});
