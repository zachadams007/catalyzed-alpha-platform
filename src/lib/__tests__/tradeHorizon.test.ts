import { describe, it, expect } from "vitest";

import {
  isTradeHorizon,
  likelyHorizon,
  normalizeTradeHorizon,
  shiftHorizon,
  type LikelyHorizon,
} from "@/lib/tradeHorizon";
import type { StockSignal, TradeHorizon } from "@/types";

type SignalOverrides = {
  catalystType?: StockSignal["catalystType"];
  catalyst?: Partial<StockSignal["catalyst"]>;
  news?: Partial<StockSignal["news"]>;
  social?: Partial<StockSignal["social"]>;
  volatility?: Partial<StockSignal["volatility"]>;
  liquidity?: Partial<StockSignal["liquidity"]>;
  categoryScores?: Partial<
    Record<StockSignal["score"]["categories"][number]["key"], number>
  >;
  omitCategories?: boolean;
};

const baseSignal: StockSignal = {
  ticker: "TEST",
  name: "Test Company",
  sector: "Technology",
  price: 50,
  dayChange: 0.01,
  marketCap: 5_000_000_000,
  priceHistory: [49, 50],
  priceSeries: [
    { date: "2026-06-12", close: 49 },
    { date: "2026-06-13", close: 50 },
  ],
  fundamentals: {
    revenueGrowthYoY: 0.1,
    epsGrowthYoY: 0.1,
    grossMargin: 0.4,
    netMargin: 0.1,
    peRatio: 20,
    pegRatio: 1.5,
    debtToEquity: 0.5,
    fcfMargin: 0.1,
  },
  momentum: {
    return1M: 0.05,
    return3M: 0.1,
    return6M: 0.15,
    rsi: 55,
    aboveSMA50: true,
    aboveSMA200: true,
    relativeStrength3M: 0.05,
  },
  catalyst: {
    type: "Earnings",
    description: "Test catalyst",
    daysAway: 10,
    magnitude: 0.5,
  },
  news: {
    items: [],
    sentiment: 0,
    count7d: 8,
    freshnessHours: 24,
  },
  social: {
    redditMentions24h: 100,
    xMentions24h: 100,
    politicalMentions: 0,
    sentiment: 0,
    trendDelta: 0.1,
    summary: "Test social summary",
  },
  socialPosts: [],
  volatility: {
    beta: 1,
    atrPct: 0.05,
    impliedVol: 0.4,
  },
  liquidity: {
    avgDollarVolume: 50_000_000,
    floatShares: 100_000_000,
  },
  risk: {
    shortInterestPct: 0.05,
    dilutionRisk: 0.1,
    cashRunwayQuarters: 8,
    governanceFlag: 0,
  },
  sources: [],
  id: "TEST",
  score: {
    opportunityScore: 50,
    confidence: 50,
    confidenceExplanation: "Test confidence",
    riskPenalty: 5,
    riskExplanation: "Test risk",
    categories: [
      {
        key: "fundamentals",
        label: "Fundamentals",
        score: 50,
        weight: 0.34,
        contribution: 17,
        explanation: "Test fundamentals",
      },
      {
        key: "growth",
        label: "Growth",
        score: 50,
        weight: 0.33,
        contribution: 16.5,
        explanation: "Test growth",
      },
      {
        key: "liquidity",
        label: "Liquidity",
        score: 50,
        weight: 0.33,
        contribution: 16.5,
        explanation: "Test liquidity",
      },
    ],
  },
  marketCapBucket: "Mid",
  riskLevel: "Moderate",
  confidence: 50,
  catalystType: "Earnings",
  generatedAt: "2026-06-13T12:00:00.000Z",
  thesis: "Test thesis",
  newsInsight: "Test news insight",
  momentumNote: "Test momentum note",
  socialSummary: "Test social summary",
  keyFundamentals: [],
  hype: {
    score: 50,
    tier: "Warming",
    tldr: "Test hype",
    drivers: [],
  },
};

function makeSignal(overrides: SignalOverrides = {}): StockSignal {
  const catalystType = overrides.catalystType ?? baseSignal.catalystType;

  return {
    ...baseSignal,
    catalystType,
    catalyst: {
      ...baseSignal.catalyst,
      type: catalystType,
      ...overrides.catalyst,
    },
    news: { ...baseSignal.news, ...overrides.news },
    social: { ...baseSignal.social, ...overrides.social },
    volatility: { ...baseSignal.volatility, ...overrides.volatility },
    liquidity: { ...baseSignal.liquidity, ...overrides.liquidity },
    score: {
      ...baseSignal.score,
      categories: overrides.omitCategories
        ? []
        : baseSignal.score.categories.map((category) => ({
            ...category,
            score: overrides.categoryScores?.[category.key] ?? category.score,
          })),
    },
  };
}

function makeScalpingCandidate(overrides: SignalOverrides = {}): StockSignal {
  return makeSignal({
    catalystType: "Technical",
    ...overrides,
    catalyst: { daysAway: 10, ...overrides.catalyst },
    news: { freshnessHours: 4, count7d: 8, ...overrides.news },
    social: {
      redditMentions24h: 100,
      xMentions24h: 100,
      trendDelta: 0.1,
      ...overrides.social,
    },
    volatility: { atrPct: 0.03, ...overrides.volatility },
    liquidity: { avgDollarVolume: 150_000_000, ...overrides.liquidity },
  });
}

const scalpResult: LikelyHorizon = {
  horizon: "scalping",
  why: "Ultra-fresh technical attention with high liquidity",
};

const technicalDayResult: LikelyHorizon = {
  horizon: "day_trading",
  why: "Technical setup with enough liquidity",
};

const technicalSwingResult: LikelyHorizon = {
  horizon: "swing_trading",
  why: "Technical setup needs confirmation",
};

describe("isTradeHorizon", () => {
  it.each([
    "scalping",
    "day_trading",
    "swing_trading",
    "position_trading",
  ] satisfies TradeHorizon[])("accepts %s", (horizon) => {
    expect(isTradeHorizon(horizon)).toBe(true);
  });

  it.each(["", "day_trade", "swing", "long_term", "unknown"])("rejects %s", (value) => {
    expect(isTradeHorizon(value)).toBe(false);
  });
});

describe("normalizeTradeHorizon", () => {
  it.each([
    ["scalping", "scalping"],
    ["day_trading", "day_trading"],
    ["swing_trading", "swing_trading"],
    ["position_trading", "position_trading"],
    ["day_trade", "day_trading"],
    ["swing", "swing_trading"],
    ["long_term", "position_trading"],
    ["unknown", "swing_trading"],
    [undefined, "swing_trading"],
  ] satisfies Array<[string | undefined, TradeHorizon]>)(
    "maps %s to %s",
    (value, expected) => {
      expect(normalizeTradeHorizon(value)).toBe(expected);
    },
  );
});

describe("shiftHorizon", () => {
  it.each([
    ["scalping", "scalping"],
    ["day_trading", "scalping"],
    ["swing_trading", "day_trading"],
    ["position_trading", "swing_trading"],
  ] satisfies Array<[TradeHorizon, TradeHorizon]>)(
    "shifts %s one step shorter to %s",
    (horizon, expected) => {
      expect(shiftHorizon(horizon, "shorter")).toBe(expected);
    },
  );

  it.each([
    ["scalping", "day_trading"],
    ["day_trading", "swing_trading"],
    ["swing_trading", "position_trading"],
    ["position_trading", "position_trading"],
  ] satisfies Array<[TradeHorizon, TradeHorizon]>)(
    "shifts %s one step longer to %s",
    (horizon, expected) => {
      expect(shiftHorizon(horizon, "longer")).toBe(expected);
    },
  );
});

describe("likelyHorizon fast-moving thresholds", () => {
  it("maps the inclusive lower scalping boundaries to scalping", () => {
    expect(likelyHorizon(makeScalpingCandidate())).toEqual(scalpResult);
  });

  it("includes the 12% ATR upper boundary in the scalping range", () => {
    expect(
      likelyHorizon(makeScalpingCandidate({ volatility: { atrPct: 0.12 } })),
    ).toEqual(scalpResult);
  });

  it.each([
    [
      "freshness above four hours",
      { news: { freshnessHours: 4.01 } },
      technicalDayResult,
    ],
    [
      "liquidity below $150M",
      { liquidity: { avgDollarVolume: 149_999_999 } },
      technicalDayResult,
    ],
    ["ATR below 3%", { volatility: { atrPct: 0.0299 } }, technicalSwingResult],
    ["ATR above 12%", { volatility: { atrPct: 0.1201 } }, technicalSwingResult],
    ["news count below eight", { news: { count7d: 7 } }, technicalDayResult],
  ] satisfies Array<[string, SignalOverrides, LikelyHorizon]>)(
    "leaves the scalping branch when %s",
    (_, overrides, expected) => {
      expect(likelyHorizon(makeScalpingCandidate(overrides))).toEqual(expected);
    },
  );

  it("treats exactly 500 mentions and 60% trend growth as an attention burst", () => {
    const result = likelyHorizon(
      makeScalpingCandidate({
        news: { count7d: 7 },
        social: {
          redditMentions24h: 250,
          xMentions24h: 250,
          trendDelta: 0.6,
        },
      }),
    );

    expect(result).toEqual(scalpResult);
  });

  it.each([
    [
      "mentions below 500",
      {
        redditMentions24h: 249,
        xMentions24h: 250,
        trendDelta: 0.6,
      },
    ],
    [
      "trend growth below 60%",
      {
        redditMentions24h: 250,
        xMentions24h: 250,
        trendDelta: 0.599,
      },
    ],
  ] satisfies Array<[string, Partial<StockSignal["social"]>]>)(
    "does not create an attention burst when %s",
    (_, social) => {
      const result = likelyHorizon(
        makeScalpingCandidate({
          news: { count7d: 7 },
          social,
        }),
      );

      expect(result).toEqual(technicalDayResult);
    },
  );

  it("includes the day-trading freshness, liquidity, ATR, and catalyst boundaries", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 2 },
        news: { freshnessHours: 12, count7d: 8 },
        volatility: { atrPct: 0.12 },
        liquidity: { avgDollarVolume: 25_000_000 },
      }),
    );

    expect(result).toEqual({
      horizon: "day_trading",
      why: "Fresh catalyst flow, liquid and fast-moving",
    });
  });

  it.each([
    ["freshness above 12 hours", { news: { freshnessHours: 12.01 } }],
    ["liquidity below $25M", { liquidity: { avgDollarVolume: 24_999_999 } }],
    ["ATR above 12%", { volatility: { atrPct: 0.1201 } }],
    ["catalyst more than two days away", { catalyst: { daysAway: 2.01 } }],
  ] satisfies Array<[string, SignalOverrides]>)(
    "falls back to the catalyst mapping when %s",
    (_, overrides: SignalOverrides) => {
      const result = likelyHorizon(
        makeSignal({
          catalystType: "Product",
          catalyst: { daysAway: 2, ...overrides.catalyst },
          news: { freshnessHours: 12, count7d: 8, ...overrides.news },
          volatility: { atrPct: 0.12, ...overrides.volatility },
          liquidity: { avgDollarVolume: 25_000_000, ...overrides.liquidity },
        }),
      );

      expect(result).toEqual({
        horizon: "swing_trading",
        why: "Product event - plays out over days/weeks",
      });
    },
  );

  it.each(["Political", "Macro"] satisfies StockSignal["catalystType"][])(
    "maps a fast, attention-heavy %s catalyst to day trading",
    (catalystType) => {
      const result = likelyHorizon(
        makeSignal({
          catalystType,
          catalyst: { daysAway: 10 },
          news: { freshnessHours: 12, count7d: 8 },
          volatility: { atrPct: 0.03 },
          liquidity: { avgDollarVolume: 25_000_000 },
        }),
      );

      expect(result).toEqual({
        horizon: "day_trading",
        why: "Fresh catalyst flow, liquid and fast-moving",
      });
    },
  );
});

describe("likelyHorizon position thresholds", () => {
  const qualityScores = {
    fundamentals: 70,
    growth: 70,
    liquidity: 70,
  } satisfies SignalOverrides["categoryScores"];

  it("includes an average quality score of exactly 70", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 30.01 },
        news: { count7d: 8 },
        categoryScores: qualityScores,
      }),
    );

    expect(result).toEqual({
      horizon: "position_trading",
      why: "Quality and liquidity lead more than headline timing",
    });
  });

  it("does not include a quality score below 70", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 30.01 },
        news: { count7d: 8 },
        categoryScores: {
          fundamentals: 69.99,
          growth: 69.99,
          liquidity: 69.99,
        },
      }),
    );

    expect(result).toEqual({
      horizon: "swing_trading",
      why: "Product event - plays out over days/weeks",
    });
  });

  it("requires more than 30 days when news count is eight", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 30 },
        news: { count7d: 8 },
        categoryScores: qualityScores,
      }),
    );

    expect(result).toEqual({
      horizon: "swing_trading",
      why: "Product event - plays out over days/weeks",
    });
  });

  it("accepts fewer than eight news items as the alternate quality condition", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 30 },
        news: { count7d: 7 },
        categoryScores: qualityScores,
      }),
    );

    expect(result).toEqual({
      horizon: "position_trading",
      why: "Quality and liquidity lead more than headline timing",
    });
  });

  it("uses neutral category scores when quality categories are missing", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 30.01 },
        news: { count7d: 8 },
        omitCategories: true,
      }),
    );

    expect(result).toEqual({
      horizon: "swing_trading",
      why: "Product event - plays out over days/weeks",
    });
  });

  it("maps a catalyst just over 60 days away to position trading", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 60.01 },
      }),
    );

    expect(result).toEqual({
      horizon: "position_trading",
      why: "Catalyst ~60d out - longer research window",
    });
  });

  it("does not include exactly 60 days in the long-catalyst branch", () => {
    const result = likelyHorizon(
      makeSignal({
        catalystType: "Product",
        catalyst: { daysAway: 60 },
      }),
    );

    expect(result).toEqual({
      horizon: "swing_trading",
      why: "Product event - plays out over days/weeks",
    });
  });
});

describe("likelyHorizon catalyst mappings", () => {
  it("maps a liquid technical setup with tradable volatility to day trading", () => {
    expect(
      likelyHorizon(
        makeSignal({
          catalystType: "Technical",
          news: { count7d: 7 },
        }),
      ),
    ).toEqual(technicalDayResult);
  });

  it.each([
    ["insufficient liquidity", { liquidity: { avgDollarVolume: 24_999_999 } }],
    ["volatility below the tradable range", { volatility: { atrPct: 0.0299 } }],
    ["volatility above the tradable range", { volatility: { atrPct: 0.1201 } }],
  ] satisfies Array<[string, SignalOverrides]>)(
    "maps a technical setup with %s to swing trading",
    (_, overrides) => {
      expect(
        likelyHorizon(
          makeSignal({
            catalystType: "Technical",
            news: { count7d: 7 },
            ...overrides,
          }),
        ),
      ).toEqual(technicalSwingResult);
    },
  );

  it.each(["Political", "Macro"] satisfies StockSignal["catalystType"][])(
    "maps a fresh and liquid %s setup to day trading without an attention burst",
    (catalystType) => {
      expect(
        likelyHorizon(
          makeSignal({
            catalystType,
            news: { freshnessHours: 12, count7d: 7 },
            liquidity: { avgDollarVolume: 25_000_000 },
          }),
        ),
      ).toEqual({
        horizon: "day_trading",
        why: `${catalystType} headline-driven`,
      });
    },
  );

  it.each(["Political", "Macro"] satisfies StockSignal["catalystType"][])(
    "maps a stale %s setup to swing trading",
    (catalystType) => {
      expect(
        likelyHorizon(
          makeSignal({
            catalystType,
            news: { freshnessHours: 12.01, count7d: 7 },
            liquidity: { avgDollarVolume: 25_000_000 },
          }),
        ),
      ).toEqual({
        horizon: "swing_trading",
        why: `${catalystType} effects may unfold over days`,
      });
    },
  );

  it("maps earnings to swing trading", () => {
    expect(likelyHorizon(makeSignal({ catalystType: "Earnings" }))).toEqual({
      horizon: "swing_trading",
      why: "Earnings catalyst - days/weeks setup",
    });
  });

  it.each(["Product", "Partnership", "M&A"] satisfies StockSignal["catalystType"][])(
    "maps %s events to swing trading",
    (catalystType) => {
      expect(likelyHorizon(makeSignal({ catalystType }))).toEqual({
        horizon: "swing_trading",
        why: `${catalystType} event - plays out over days/weeks`,
      });
    },
  );

  it.each(["Regulatory", "Clinical", "Insider"] satisfies StockSignal["catalystType"][])(
    "maps %s timelines to position trading",
    (catalystType) => {
      expect(likelyHorizon(makeSignal({ catalystType }))).toEqual({
        horizon: "position_trading",
        why: `${catalystType} timeline - longer research window`,
      });
    },
  );

  it("uses the balanced fallback for an unrecognized runtime catalyst type", () => {
    const malformedSignal = {
      ...makeSignal(),
      catalystType: "Unknown",
    } as unknown as StockSignal;

    expect(likelyHorizon(malformedSignal)).toEqual({
      horizon: "swing_trading",
      why: "Balanced setup",
    });
  });
});
