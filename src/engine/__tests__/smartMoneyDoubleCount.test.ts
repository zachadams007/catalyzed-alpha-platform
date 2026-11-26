import { describe, expect, it } from "vitest";

import { scoreCompany } from "@/engine/scoring";
import { smartMoneyCatalystBoost } from "@/engine/smartMoney";
import { catalystStrength } from "@/engine/catalystStrength";
import { computeNormalizedScores, MAX_CATALYST_POINTS } from "@/engine/normalizeUniverse";
import { CATEGORY_CONFIG, SMART_MONEY } from "@/engine/scoringConfig";
import type { CompanyData, CongressTrade, RawCatalyst, StockSignal } from "@/types";
import { toStockSignal } from "@/engine/enrich";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";

/**
 * V4 single-count guard.
 *
 * Smart-money buying is weighted once, in the additive-only `conviction`
 * sub-score. catalystStrength may still name "Smart money" as the lead so the
 * feed tile explains the pick, but it must not add a second catalyst tilt.
 */

function maximalSmartMoneyBuys(): Pick<CompanyData, "congressTrades" | "secActivity"> {
  const congressTrades: CongressTrade[] = Array.from({ length: 6 }, (_, i) => ({
    representative: `R${i}`,
    chamber: "House",
    transaction: "buy",
    amountRange: "$1,000,001 - $5,000,000",
    transactionDate: "2026-06-10",
  }));
  return {
    congressTrades,
    secActivity: { form4BuyCount90d: 10, form4NetBuyValue90d: 5_000_000 } as never,
  };
}

const NEUTRAL_CATALYST: RawCatalyst = {
  type: "Earnings",
  description: "none",
  daysAway: 999,
  magnitude: 0,
};

function companyPair(): { without: CompanyData; with: CompanyData } {
  const base = buildSyntheticCompany("SM") as CompanyData;
  const without: CompanyData = {
    ...base,
    catalyst: NEUTRAL_CATALYST,
    catalystLive: false,
    congressTrades: undefined,
    secActivity: undefined,
    news: { items: [], sentiment: 0, count7d: 0, freshnessHours: 200 },
    social: { redditMentions24h: 0, xMentions24h: 0, politicalMentions: 0, sentiment: 0, trendDelta: 0, summary: "" },
    revenueTTM: 100_000_000,
  } as CompanyData;
  const withSM: CompanyData = { ...without, ...maximalSmartMoneyBuys() } as CompanyData;
  return { without, with: withSM };
}

const CONVICTION_WEIGHT = CATEGORY_CONFIG.find((c) => c.key === "conviction")!.weight;

describe("smart-money single-count (V4) — conviction sub-score", () => {
  it("the boost is capped at SMART_MONEY.maxBoost and lifts conviction by that amount", () => {
    const { without, with: withSM } = companyPair();
    const boost = smartMoneyCatalystBoost(withSM);
    expect(boost.points).toBe(SMART_MONEY.maxBoost);
    expect(boost.points).toBe(20);

    const convictionWithout = scoreCompany(without).categories.find((c) => c.key === "conviction")!.score;
    const convictionWith = scoreCompany(withSM).categories.find((c) => c.key === "conviction")!.score;
    expect(convictionWithout).toBe(50);
    expect(convictionWith - convictionWithout).toBe(20);

    const catWithout = scoreCompany(without).categories.find((c) => c.key === "catalyst")!.score;
    const catWith = scoreCompany(withSM).categories.find((c) => c.key === "catalyst")!.score;
    expect(catWith).toBe(catWithout);
  });

  it("bounds the flat blended lift through the conviction weight", () => {
    const { without, with: withSM } = companyPair();
    const maxBlendedFromBoost = SMART_MONEY.maxBoost * CONVICTION_WEIGHT;
    expect(maxBlendedFromBoost).toBeCloseTo(1.6, 5);

    const delta =
      scoreCompany(withSM).opportunityScore - scoreCompany(without).opportunityScore;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(Math.ceil(maxBlendedFromBoost) + 1);
  });
});

describe("smart-money single-count (V4) — catalyst tilt remains zero", () => {
  it("a pure smart-money buy has catalystStrength 0 but still names the lead", () => {
    const { with: withSM } = companyPair();
    const strength = catalystStrength(withSM);
    expect(strength.strength).toBe(0);
    expect(strength.leadType).toBe("Smart money");

    const championCatalystTilt = (strength.strength / 100) * MAX_CATALYST_POINTS;
    expect(championCatalystTilt).toBe(0);
  });

  it("the champion's normalized catalystTilt for the smart-money name is 0", () => {
    const { with: withSM, without } = companyPair();
    const signals: StockSignal[] = [
      toStockSignal(withSM, scoreCompany(withSM), "2026-06-19T00:00:00.000Z"),
      ...["F0", "F1", "F2"].map((t) => {
        const f = { ...without, ticker: t } as CompanyData;
        return toStockSignal(f, scoreCompany(f), "2026-06-19T00:00:00.000Z");
      }),
    ];
    const scores = computeNormalizedScores(signals);
    const smName = scores.find((s) => s.ticker === "SM")!;
    expect(smName.catalystTilt).toBe(0);
    for (const f of scores.filter((s) => s.ticker !== "SM")) {
      expect(f.catalystTilt).toBe(0);
    }
  });
});
