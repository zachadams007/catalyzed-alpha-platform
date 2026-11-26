import { describe, expect, it } from "vitest";

import { scoreCompany } from "@/engine/scoring";
import type { CompanyData } from "@/types";

type CompanyOverrides = Partial<
  Omit<
    CompanyData,
    | "fundamentals"
    | "momentum"
    | "catalyst"
    | "news"
    | "social"
    | "volatility"
    | "liquidity"
    | "risk"
  >
> & {
  fundamentals?: Partial<CompanyData["fundamentals"]>;
  momentum?: Partial<CompanyData["momentum"]>;
  catalyst?: Partial<CompanyData["catalyst"]>;
  news?: Partial<CompanyData["news"]>;
  social?: Partial<CompanyData["social"]>;
  volatility?: Partial<CompanyData["volatility"]>;
  liquidity?: Partial<CompanyData["liquidity"]>;
  risk?: Partial<CompanyData["risk"]>;
};

const FUNDAMENTAL_KEYS: Array<keyof CompanyData["fundamentals"]> = [
  "revenueGrowthYoY",
  "epsGrowthYoY",
  "grossMargin",
  "netMargin",
  "peRatio",
  "pegRatio",
  "debtToEquity",
  "fcfMargin",
];

const availability = (value: boolean): NonNullable<CompanyData["fundamentalsAvailability"]> =>
  Object.fromEntries(FUNDAMENTAL_KEYS.map((key) => [key, value]));

function makePriceHistory(): number[] {
  return Array.from({ length: 120 }, (_, index) =>
    index < 60 ? 35 + index * 0.45 : 62 - (index - 60) * 0.2,
  );
}

function makeCompany(overrides: CompanyOverrides = {}): CompanyData {
  const priceHistory = makePriceHistory();
  const base: CompanyData = {
    ticker: "NOVA",
    name: "Nova Systems",
    sector: "Technology",
    price: 50,
    dayChange: 0.012,
    marketCap: 6.5e9,
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
      rsi: 58,
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
      items: [
        {
          headline: "Nova expands its enterprise platform",
          source: "TechWire",
          url: "https://techwire.example/nova-platform",
          publishedAt: "2026-06-12T12:00:00.000Z",
          sentiment: 0.3,
        },
        {
          headline: "Nova signs a new channel partner",
          source: "Market Ledger",
          url: "https://marketledger.example/nova-partner",
          publishedAt: "2026-06-11T12:00:00.000Z",
          sentiment: 0.2,
        },
        {
          headline: "Mid-cap software demand remains firm",
          source: "Software Daily",
          url: "https://softwaredaily.example/mid-cap-demand",
          publishedAt: "2026-06-10T12:00:00.000Z",
          sentiment: 0.1,
        },
        {
          headline: "Nova previews its product roadmap",
          source: "Product Brief",
          url: "https://productbrief.example/nova-roadmap",
          publishedAt: "2026-06-09T12:00:00.000Z",
          sentiment: 0.25,
        },
      ],
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
      summary: "Measured discussion across Stocktwits and technology forums.",
    },
    socialPosts: [
      {
        platform: "x",
        author: "Market Researcher",
        handle: "@marketresearcher",
        text: "Watching the Nova product launch.",
        publishedAt: "2026-06-12T14:00:00.000Z",
        url: "https://x.com/marketresearcher/status/1",
        sentiment: 0.2,
        isPolitical: false,
        severity: "watch",
      },
    ],
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
    sources: [
      { label: "Company filings", url: "https://sec.gov/Archives/nova" },
      { label: "Company investor relations", url: "https://nova.example/investors" },
    ],
    fundamentalsAvailability: availability(true),
    catalystLive: true,
  };

  return {
    ...base,
    ...overrides,
    fundamentals: { ...base.fundamentals, ...overrides.fundamentals },
    momentum: { ...base.momentum, ...overrides.momentum },
    catalyst: { ...base.catalyst, ...overrides.catalyst },
    news: { ...base.news, ...overrides.news },
    social: { ...base.social, ...overrides.social },
    volatility: { ...base.volatility, ...overrides.volatility },
    liquidity: { ...base.liquidity, ...overrides.liquidity },
    risk: { ...base.risk, ...overrides.risk },
  };
}

const bestCaseFundamentals: CompanyOverrides = {
  fundamentals: {
    revenueGrowthYoY: 0.6,
    epsGrowthYoY: 0.8,
    grossMargin: 0.8,
    netMargin: 0.3,
    peRatio: 18,
    pegRatio: 1,
    debtToEquity: 0.1,
    fcfMargin: 0.3,
  },
};

const worstCaseFundamentals: CompanyOverrides = {
  fundamentals: {
    revenueGrowthYoY: -0.1,
    epsGrowthYoY: -0.3,
    grossMargin: 0,
    netMargin: -0.2,
    peRatio: null,
    pegRatio: 8,
    debtToEquity: 10,
    fcfMargin: -0.25,
  },
};

const stressedCompany: CompanyOverrides = {
  fundamentals: { fcfMargin: -0.4 },
  volatility: { atrPct: 0.3 },
  liquidity: { avgDollarVolume: 100_000 },
  risk: {
    shortInterestPct: 0.6,
    dilutionRisk: 1,
    cashRunwayQuarters: 1,
    governanceFlag: 1,
  },
};

const invariantCases = [
  ["base", {}],
  ["best fundamentals", bestCaseFundamentals],
  ["worst fundamentals", worstCaseFundamentals],
  ["stressed", stressedCompany],
  [
    "missing fundamentals",
    {
      fundamentalsAvailability: availability(false),
    },
  ],
] satisfies Array<[string, CompanyOverrides]>;

describe("scoreCompany range invariants", () => {
  it.each(invariantCases)("keeps the %s opportunity score between 0 and 100", (_, overrides) => {
    const { opportunityScore } = scoreCompany(makeCompany(overrides));

    expect(opportunityScore).toBeGreaterThanOrEqual(0);
    expect(opportunityScore).toBeLessThanOrEqual(100);
  });

  it.each(invariantCases)("keeps the %s confidence between 0 and 100", (_, overrides) => {
    const { confidence } = scoreCompany(makeCompany(overrides));

    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(100);
  });

  it.each(invariantCases)("keeps the %s risk penalty non-negative", (_, overrides) => {
    expect(scoreCompany(makeCompany(overrides)).riskPenalty).toBeGreaterThanOrEqual(0);
  });

  it("returns at least one category and bounds every category score", () => {
    const { categories } = scoreCompany(makeCompany());

    expect(categories.length).toBeGreaterThan(0);
    for (const category of categories) {
      expect(category.score).toBeGreaterThanOrEqual(0);
      expect(category.score).toBeLessThanOrEqual(100);
    }
  });

  it("keeps category weights normalized", () => {
    const { categories } = scoreCompany(makeCompany());
    const weightTotal = categories.reduce((sum, category) => sum + category.weight, 0);

    expect(weightTotal).toBeCloseTo(1, 3);
    expect(Math.abs(weightTotal - 1)).toBeLessThanOrEqual(0.005);
  });

  it("provides a non-empty explanation for every category", () => {
    const { categories } = scoreCompany(makeCompany());

    for (const category of categories) {
      expect(category.explanation.trim().length).toBeGreaterThan(0);
    }
  });

  it("reports each contribution as score multiplied by weight", () => {
    const { categories } = scoreCompany(makeCompany());

    for (const category of categories) {
      expect(category.contribution).toBeCloseTo(category.score * category.weight, 1);
    }
  });

  it("computes opportunity score from the blended categories minus risk", () => {
    const result = scoreCompany(makeCompany());
    const blended = result.categories.reduce(
      (sum, category) => sum + category.score * category.weight,
      0,
    );
    const expected = Math.min(100, Math.max(0, Math.round(blended - result.riskPenalty)));

    expect(result.opportunityScore).toBe(expected);
  });

  it("always returns confidence and risk explanations", () => {
    const result = scoreCompany(makeCompany());

    expect(result.confidenceExplanation.trim().length).toBeGreaterThan(0);
    expect(result.riskExplanation.trim().length).toBeGreaterThan(0);
  });

  it("caps the aggregate risk penalty", () => {
    // RISK.cap rose 25→30 when the v3 extension/already-ran guard was added.
    expect(scoreCompany(makeCompany(stressedCompany)).riskPenalty).toBeLessThanOrEqual(30);
  });
});

describe("scoreValuation — honest entry read (BMNR 'chasing highs' guard)", () => {
  const val = (c: Parameters<typeof scoreCompany>[0]) =>
    scoreCompany(c).categories.find((x) => x.key === "valuation")!;

  it("stays NEUTRAL (not 'chasing highs') on a thin/modeled history near the lows", () => {
    // BMNR shape: ~30-pt modeled window, price near the window low.
    const thin = Array.from({ length: 30 }, (_, i) => 14.5 - (i % 5) * 0.3);
    const v = val(makeCompany({ price: 13, priceHistory: thin }));
    expect(v.explanation).toMatch(/^Limited price history/);
    // No off-high read is fabricated from the thin window; the score stays in the neutral band.
    expect(v.score).toBeGreaterThanOrEqual(45);
    expect(v.score).toBeLessThanOrEqual(62);
    expect(v.explanation).not.toMatch(/chasing the top/);
  });

  it("reads a DEEP history near its lows as discounted, never 'chasing highs'", () => {
    // ~150 closes declining from 100 → ~13, current price at the low (deep discount).
    const deep = Array.from({ length: 150 }, (_, i) => 100 - i * 0.58);
    const v = val(makeCompany({ price: 13, priceHistory: deep }));
    expect(v.score).toBeGreaterThan(60); // discounted, with a real base to judge it
    expect(v.explanation).not.toMatch(/chasing the top/);
  });
});

describe("scoreCompany monotonicity", () => {
  it("rewards a higher gross margin", () => {
    const low = scoreCompany(makeCompany({ fundamentals: { grossMargin: 0.15 } }));
    const high = scoreCompany(makeCompany({ fundamentals: { grossMargin: 0.75 } }));

    // v2 de-weights raw fundamentals to a 0.02 minority sanity check, so its effect
    // on the blended score is small; the load-bearing monotonic contract is that the
    // fundamentals SUB-SCORE rises and the blended score never regresses.
    const fund = (r: typeof low) => r.categories.find((c) => c.key === "fundamentals")!.score;
    expect(fund(high)).toBeGreaterThan(fund(low));
    expect(high.opportunityScore).toBeGreaterThanOrEqual(low.opportunityScore);
  });

  it("rewards a higher net margin", () => {
    const low = scoreCompany(makeCompany({ fundamentals: { netMargin: -0.2 } }));
    const high = scoreCompany(makeCompany({ fundamentals: { netMargin: 0.3 } }));

    // Assert the effect WHERE IT LIVES. `fundamentals` carries a 0.02 weight in
    // the flat blend, so a 25-point dimension move contributes ~0.5 points to a
    // composite that is then rounded to an integer - this assertion sat on a
    // rounding boundary and could flip on any unrelated tenth-of-a-point change.
    // The dimension itself must respond strictly; the composite must not go
    // BACKWARDS (which is the real regression worth catching).
    const dim = (r: typeof low) => r.categories.find((c) => c.key === "fundamentals")!.score;
    expect(dim(high)).toBeGreaterThan(dim(low));
    expect(high.opportunityScore).toBeGreaterThanOrEqual(low.opportunityScore);
  });

  it("rewards higher year-over-year revenue growth", () => {
    const low = scoreCompany(makeCompany({ fundamentals: { revenueGrowthYoY: -0.1 } }));
    const high = scoreCompany(makeCompany({ fundamentals: { revenueGrowthYoY: 0.6 } }));

    expect(high.opportunityScore).toBeGreaterThan(low.opportunityScore);
  });

  it("rewards stronger one-month price momentum", () => {
    const low = scoreCompany(makeCompany({ momentum: { return1M: -0.15 } }));
    const high = scoreCompany(makeCompany({ momentum: { return1M: 0.25 } }));

    expect(high.opportunityScore).toBeGreaterThan(low.opportunityScore);
  });

  it("rewards a stronger catalyst", () => {
    const low = scoreCompany(makeCompany({ catalyst: { magnitude: 0.2 } }));
    const high = scoreCompany(makeCompany({ catalyst: { magnitude: 1 } }));

    expect(high.opportunityScore).toBeGreaterThan(low.opportunityScore);
  });

  it("penalizes an already-ran (extended) name — the SNDK guard", () => {
    // A based name: 60 closes around 10-12, trading at 12 (≈+20% off the low).
    const basedHistory = Array.from({ length: 60 }, (_, i) => 10 + (i % 6) * 0.3);
    const based = scoreCompany(
      makeCompany({ price: 12, priceHistory: basedHistory } as CompanyOverrides),
    );
    // An extended name: ran from ~10 to ~110 (≈+1000%, the SNDK case), trading at 110.
    const ranHistory = Array.from({ length: 60 }, (_, i) => 10 + (i / 59) * 100);
    const extended = scoreCompany(
      makeCompany({ price: 110, priceHistory: ranHistory } as CompanyOverrides),
    );
    // The extension guard adds risk to the post-run name that the based name never sees.
    expect(extended.riskPenalty).toBeGreaterThan(based.riskPenalty + 2);
  });

  it("rewards more positive news sentiment", () => {
    const low = scoreCompany(makeCompany({ news: { sentiment: -1 } }));
    const high = scoreCompany(makeCompany({ news: { sentiment: 1 } }));

    expect(high.opportunityScore).toBeGreaterThan(low.opportunityScore);
  });

  it("rewards rising social attention", () => {
    const low = scoreCompany(makeCompany({ social: { trendDelta: -0.5 } }));
    const high = scoreCompany(makeCompany({ social: { trendDelta: 2 } }));

    // Social is a small (0.03) weight, so its effect on the blended score can fall
    // under integer rounding; the load-bearing monotonic contract is that the social
    // SUB-SCORE rises and the blended score never regresses (same pattern as the
    // gross-margin test).
    const social = (r: typeof low) => r.categories.find((c) => c.key === "social")!.score;
    expect(social(high)).toBeGreaterThan(social(low));
    expect(high.opportunityScore).toBeGreaterThanOrEqual(low.opportunityScore);
  });

  it("rewards trading above the 50-day moving average", () => {
    const below = scoreCompany(makeCompany({ momentum: { aboveSMA50: false } }));
    const above = scoreCompany(makeCompany({ momentum: { aboveSMA50: true } }));

    expect(above.opportunityScore).toBeGreaterThan(below.opportunityScore);
  });

  it("rewards trading above the 200-day moving average", () => {
    const below = scoreCompany(makeCompany({ momentum: { aboveSMA200: false } }));
    const above = scoreCompany(makeCompany({ momentum: { aboveSMA200: true } }));

    expect(above.opportunityScore).toBeGreaterThan(below.opportunityScore);
  });
});

describe("scoreCompany extremes and missing data", () => {
  it("scores an all-best-case fundamental profile clearly above the worst case", () => {
    // v2 no longer treats pristine static fundamentals as a top pick on their own
    // (the leading inflection/pipeline/sentiment-shift dims dominate the blend), so
    // the meaningful invariant is best ≫ worst, comfortably above the midpoint.
    const best = scoreCompany(makeCompany(bestCaseFundamentals)).opportunityScore;
    const worst = scoreCompany(makeCompany(worstCaseFundamentals)).opportunityScore;
    expect(best).toBeGreaterThan(worst);
    expect(best).toBeGreaterThan(50);
  });

  it("scores an all-worst-case fundamental profile below neutral once its cash burn is real", () => {
    // NOTE (2026-07-25): this used to assert a bare `< 50` on a fixture that only
    // overrides FUNDAMENTALS - a dimension carrying 0.02 of the flat blend. It
    // passed because the old solvency rule fired a near-flat penalty on ANY
    // negative free cash flow, so a −25% burn was punished almost as hard as a
    // −400% one. That rule is now severity-proportionate, which is the whole point
    // of wiring real XBRL free cash flow, and the composite for this fixture lands
    // at ~51 instead of ~49.
    //
    // The invariant worth protecting is not the arbitrary 50 line - it is that a
    // genuinely distressed company is scored as such. So this now pins BOTH: a
    // real cash crunch drives the composite below neutral, and the penalty scales
    // with the severity of the burn rather than merely its sign.
    const distressed = scoreCompany(
      makeCompany({
        ...worstCaseFundamentals,
        fundamentals: { ...worstCaseFundamentals.fundamentals!, fcfMargin: -1.2 },
        risk: { shortInterestPct: 0.4, dilutionRisk: 0.8, cashRunwayQuarters: 1.5, governanceFlag: 0.6 },
      }),
    );
    expect(distressed.opportunityScore).toBeLessThan(50);

    const mildBurn = scoreCompany(
      makeCompany({
        ...worstCaseFundamentals,
        fundamentals: { ...worstCaseFundamentals.fundamentals!, fcfMargin: -0.12 },
      }),
    );
    const severeBurn = scoreCompany(
      makeCompany({
        ...worstCaseFundamentals,
        fundamentals: { ...worstCaseFundamentals.fundamentals!, fcfMargin: -1.4 },
      }),
    );
    expect(severeBurn.riskPenalty).toBeGreaterThan(mildBurn.riskPenalty);
  });

  it("keeps zero and null-equivalent fundamentals finite", () => {
    const result = scoreCompany(
      makeCompany({
        fundamentals: {
          revenueGrowthYoY: 0,
          epsGrowthYoY: 0,
          grossMargin: 0,
          netMargin: 0,
          peRatio: null,
          pegRatio: null,
          debtToEquity: 0,
          fcfMargin: 0,
        },
      }),
    );

    const numericValues = [
      result.opportunityScore,
      result.confidence,
      result.riskPenalty,
      ...result.categories.flatMap((category) => [
        category.score,
        category.weight,
        category.contribution,
      ]),
    ];

    expect(numericValues.every(Number.isFinite)).toBe(true);
  });

  it("scores unavailable fundamental values neutrally regardless of placeholders", () => {
    const unavailable = availability(false);
    const lowPlaceholders = scoreCompany(
      makeCompany({
        fundamentals: worstCaseFundamentals.fundamentals,
        fundamentalsAvailability: unavailable,
      }),
    );
    const highPlaceholders = scoreCompany(
      makeCompany({
        fundamentals: bestCaseFundamentals.fundamentals,
        fundamentalsAvailability: unavailable,
      }),
    );

    expect(highPlaceholders.categories).toEqual(lowPlaceholders.categories);
    expect(highPlaceholders.opportunityScore).toBe(lowPlaceholders.opportunityScore);
  });
});

describe("scoreCompany confidence", () => {
  it("lowers confidence when all fundamental availability flags are false", () => {
    const unavailable = scoreCompany(
      makeCompany({ fundamentalsAvailability: availability(false) }),
    );
    const available = scoreCompany(
      makeCompany({ fundamentalsAvailability: availability(true) }),
    );

    expect(unavailable.confidence).toBeLessThan(available.confidence);
  });

  it("gives a well-sourced company with all fundamentals available confidence above 50", () => {
    const result = scoreCompany(
      makeCompany({ fundamentalsAvailability: availability(true) }),
    );

    expect(result.confidence).toBeGreaterThan(50);
  });
});

describe("scoreCompany determinism", () => {
  it("returns the same opportunity score for identical input", () => {
    const company = makeCompany();

    expect(scoreCompany(company).opportunityScore).toBe(
      scoreCompany(company).opportunityScore,
    );
  });

  it("returns the same categories array across repeated calls", () => {
    const company = makeCompany();
    const first = scoreCompany(company).categories;

    for (let run = 0; run < 5; run += 1) {
      expect(scoreCompany(company).categories).toEqual(first);
    }
  });
});

describe("scoreValuation — cap-aware fundamental cheapness (Zach 2026-07-03)", () => {
  const val = (c: Parameters<typeof scoreCompany>[0]) =>
    scoreCompany(c).categories.find((x) => x.key === "valuation")!;
  // A deep, real base with the price ~38% off the high - an EQUAL off-high read for
  // every fixture, so only the FUNDAMENTAL leg differs between them.
  const deep = Array.from({ length: 160 }, (_, i) => 100 - i * 0.25);

  it("a cheap large-cap reads more valued than an identical expensive one", () => {
    const cheap = val(
      makeCompany({ priceHistory: deep, price: 62, marketCap: 50e9, fundamentals: { peRatio: 10, pegRatio: 0.6 } }),
    );
    const rich = val(
      makeCompany({ priceHistory: deep, price: 62, marketCap: 50e9, fundamentals: { peRatio: 55, pegRatio: 3.2 } }),
    );
    expect(cheap.score).toBeGreaterThan(rich.score);
    expect(cheap.explanation).toMatch(/Value:/);
  });

  it("a small-cap is NOT marked expensive for weak earnings — growth-adjusted EV/Sales leads", () => {
    const cheapForGrowth = val(
      makeCompany({
        priceHistory: deep,
        price: 62,
        marketCap: 0.6e9,
        fundamentals: { peRatio: null, pegRatio: null, revenueGrowthYoY: 0.4 },
        inflection: { evToSales: 2 },
      }),
    );
    const richForGrowth = val(
      makeCompany({
        priceHistory: deep,
        price: 62,
        marketCap: 0.6e9,
        fundamentals: { peRatio: null, pegRatio: null, revenueGrowthYoY: 0.4 },
        inflection: { evToSales: 14 },
      }),
    );
    expect(cheapForGrowth.score).toBeGreaterThan(richForGrowth.score);
    expect(cheapForGrowth.explanation).toMatch(/cheap-for-growth/);
    // A null P/E never drags the small-cap into the "chasing highs" band on value alone.
    expect(cheapForGrowth.explanation).not.toMatch(/chasing the top/);
  });

  it("a data-less name (unavailable fundamentals) gets no fabricated value read — price action leads", () => {
    const nearHighNoData = val(
      makeCompany({
        priceHistory: deep,
        price: 99.5,
        marketCap: 50e9,
        fundamentalsAvailability: availability(false),
        inflection: {},
      }),
    );
    // No available multiples + no EV/Sales ⇒ inert fundamental leg ⇒ a name at its high still reads extended.
    expect(nearHighNoData.explanation).toMatch(/chasing the top/);
    expect(nearHighNoData.explanation).not.toMatch(/Value:/);
  });
});
