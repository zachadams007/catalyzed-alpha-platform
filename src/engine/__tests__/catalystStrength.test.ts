import { describe, expect, it } from "vitest";

import { catalystStrength, materialSellSignal, MATERIAL_SELL } from "@/engine/catalystStrength";
import type {
  CatalystType,
  CompanyData,
  CongressTrade,
  ExecutiveSignalSummary,
  RawCatalyst,
} from "@/types";

/**
 * Unit tests for the LANE-D catalyst engine: the unified, all-types catalyst
 * STRENGTH scale and the materiality-gated negative-sell signal. These prove the
 * common-scale judgement (materiality × magnitude × credibility × earliness) and
 * the "a small routine sale is not a signal" filter in isolation, before the
 * normalization-level acceptance tests wire them into the ranking.
 */

function cat(over: Partial<RawCatalyst>): RawCatalyst {
  return {
    type: (over.type ?? "Earnings") as CatalystType,
    description: over.description ?? "Catalyst",
    daysAway: over.daysAway ?? 5,
    magnitude: over.magnitude ?? 0.7,
  };
}

function company(over: Partial<CompanyData>): CompanyData {
  return {
    catalyst: over.catalyst,
    catalystLive: over.catalystLive,
    news: over.news ?? { items: [], sentiment: 0, count7d: 4, freshnessHours: 24 },
    congressTrades: over.congressTrades,
    secActivity: over.secActivity,
    executiveSignal: over.executiveSignal,
  } as unknown as CompanyData;
}

function execSignal(over: Partial<ExecutiveSignalSummary>): ExecutiveSignalSummary {
  return {
    ticker: over.ticker ?? "TEST",
    direction: over.direction ?? "bullish",
    favorable: over.favorable,
    adverse: over.adverse,
  };
}

describe("catalystStrength — unified all-types scale", () => {
  it("scores a name with no catalyst at zero (no penalty for lacking one)", () => {
    const s = catalystStrength(company({ catalyst: undefined, news: undefined }));
    expect(s.strength).toBe(0);
    expect(s.leadType).toBeNull();
  });

  it("a strong, early, live catalyst scores far higher than a weak, distant one", () => {
    const strong = catalystStrength(
      company({
        catalyst: cat({ magnitude: 0.9, daysAway: 2 }),
        catalystLive: true,
        news: { items: [], sentiment: 0.3, count7d: 10, freshnessHours: 4 },
      }),
    );
    const weak = catalystStrength(
      company({
        catalyst: cat({ magnitude: 0.3, daysAway: 80 }),
        catalystLive: false,
        news: { items: [], sentiment: 0, count7d: 1, freshnessHours: 90 },
      }),
    );
    expect(strong.strength).toBeGreaterThan(weak.strength + 25);
  });

  it("rewards EARLY/fresh over stale at identical magnitude (catch them early)", () => {
    const inputs = (daysAway: number, freshnessHours: number) =>
      company({
        catalyst: cat({ magnitude: 0.8, daysAway }),
        catalystLive: true,
        news: { items: [], sentiment: 0, count7d: 6, freshnessHours },
      });
    const fresh = catalystStrength(inputs(3, 6));
    const stale = catalystStrength(inputs(-120, 90));
    expect(fresh.strength).toBeGreaterThan(stale.strength);
    expect(fresh.earliness).toBeGreaterThan(stale.earliness);
  });

  it("judges ALL catalyst types on the same scale (not insider-specific)", () => {
    const types: CatalystType[] = ["Earnings", "M&A", "Regulatory", "Product", "Clinical", "Political"];
    for (const type of types) {
      const s = catalystStrength(
        company({
          catalyst: cat({ type, magnitude: 0.85, daysAway: 4 }),
          catalystLive: true,
          news: { items: [], sentiment: 0.2, count7d: 8, freshnessHours: 6 },
        }),
      );
      expect(s.strength).toBeGreaterThan(50);
      expect(s.leadType).toBe(type);
    }
  });

  it("names a smart-money BUY cluster as the lead WITHOUT inflating strength (V3 single-count)", () => {
    const trades: CongressTrade[] = [
      { representative: "A", chamber: "House", transaction: "buy", amountRange: "$500,001 - $1,000,000", transactionDate: "2026-06-10" },
      { representative: "B", chamber: "Senate", transaction: "buy", amountRange: "$250,001 - $500,000", transactionDate: "2026-06-11" },
    ];
    const s = catalystStrength(
      company({ catalyst: cat({ magnitude: 0.2, daysAway: 70 }), catalystLive: false, congressTrades: trades }),
    );
    // Smart-money still NAMES the pick (the headline)…
    expect(s.leadType).toBe("Smart money");
    // …but no longer adds to `strength`/tilt - its weight is single-counted in the
    // catalyst SUB-SCORE now, so a weak/stale dated catalyst keeps strength low here.
    expect(s.strength).toBeLessThan(20);
  });

  it("a favorable Presidential signal lifts the catalyst read (bounded, direction-aware)", () => {
    const withExec = catalystStrength(
      company({
        catalyst: undefined,
        news: undefined,
        executiveSignal: execSignal({
          direction: "bullish",
          favorable: {
            kind: "buy",
            actor: "President Trump",
            summary: "President Trump disclosed a buy of NOW.",
            date: "2026-06-20",
            daysAway: -4, // just-fired (fresh)
            magnitude: 0.62,
            sourceUrl: "https://example.com/oge",
            sourceLabel: "OGE 278-T",
          },
        }),
      }),
    );
    // A name with NO catalyst scores 0; a favorable Presidential buy lifts it.
    const without = catalystStrength(company({ catalyst: undefined, news: undefined }));
    expect(without.strength).toBe(0);
    expect(withExec.strength).toBeGreaterThan(0);
    expect(withExec.leadType).toBe("Political");
    // Bounded: even a maxed favorable item alone never saturates the 0..100 scale.
    expect(withExec.strength).toBeLessThan(60);
  });

  it("a STALE favorable callout barely registers vs a fresh one (recency-aware)", () => {
    const item = (daysAway: number) =>
      company({
        catalyst: undefined,
        news: undefined,
        executiveSignal: execSignal({
          favorable: {
            kind: "favorable_callout",
            actor: "President Trump",
            summary: "Spotlight.",
            date: "2026-01-01",
            daysAway,
            magnitude: 0.55,
            sourceUrl: "https://example.com/x",
            sourceLabel: "Remarks",
          },
        }),
      });
    const fresh = catalystStrength(item(-2));
    const stale = catalystStrength(item(-120));
    expect(fresh.strength).toBeGreaterThan(stale.strength);
  });

  it("an ADVERSE Presidential signal never reads as a positive catalyst boost", () => {
    const s = catalystStrength(
      company({
        catalyst: undefined,
        news: undefined,
        executiveSignal: execSignal({
          direction: "bearish",
          adverse: {
            kind: "adverse_callout",
            actor: "Trump administration",
            summary: "Named a tariff holdout.",
            date: "2026-06-01",
            daysAway: -23,
            magnitude: 0.5,
            sourceUrl: "https://example.com/tariff",
            sourceLabel: "Section 232",
          },
        }),
      }),
    );
    // No favorable item → no positive catalyst contribution from the executive lane.
    expect(s.strength).toBe(0);
    expect(s.leadType).toBeNull();
  });
});

describe("materialSellSignal — sells negative, with a materiality floor", () => {
  it("a small routine insider sale is NOT a signal", () => {
    const s = materialSellSignal(
      company({ secActivity: { form4NetBuyValue90d: -(MATERIAL_SELL.minMaterialUsd - 1) } as never }),
    );
    expect(s.intensity).toBe(0);
  });

  it("material net insider selling registers as a negative signal", () => {
    const s = materialSellSignal(
      company({ secActivity: { form4NetBuyValue90d: -5_000_000 } as never }),
    );
    expect(s.intensity).toBeGreaterThan(0.8);
    expect(s.reason).toMatch(/selling/i);
  });

  it("net insider BUYING never reads as a sell signal", () => {
    const s = materialSellSignal(
      company({ secActivity: { form4NetBuyValue90d: 3_000_000, form4BuyCount90d: 4 } as never }),
    );
    expect(s.intensity).toBe(0);
  });

  it("a lone small congressional sale is noise; a cluster or a large sale is material", () => {
    const small = materialSellSignal(
      company({
        congressTrades: [
          { representative: "X", chamber: "House", transaction: "sell", amountRange: "$1,001 - $15,000", transactionDate: "2026-06-10" },
        ],
      }),
    );
    expect(small.intensity).toBe(0);

    const cluster = materialSellSignal(
      company({
        congressTrades: [
          { representative: "X", chamber: "House", transaction: "sell", amountRange: "$15,001 - $50,000", transactionDate: "2026-06-10" },
          { representative: "Y", chamber: "Senate", transaction: "sell", amountRange: "$15,001 - $50,000", transactionDate: "2026-06-11" },
        ],
      }),
    );
    expect(cluster.intensity).toBeGreaterThan(0);

    const large = materialSellSignal(
      company({
        congressTrades: [
          { representative: "Z", chamber: "House", transaction: "sell", amountRange: "$1,000,001 - $5,000,000", transactionDate: "2026-06-10" },
        ],
      }),
    );
    expect(large.intensity).toBeGreaterThan(0.8);
  });

  it("an ADVERSE Presidential signal (tariff/probe) registers as a negative tilt", () => {
    const s = materialSellSignal(
      company({
        executiveSignal: execSignal({
          direction: "bearish",
          adverse: {
            kind: "adverse_callout",
            actor: "Trump administration",
            summary: "Named a 100% tariff holdout.",
            date: "2026-06-20",
            daysAway: -4, // fresh
            magnitude: 0.5,
            sourceUrl: "https://example.com/tariff",
            sourceLabel: "Section 232",
          },
        }),
      }),
    );
    expect(s.intensity).toBeGreaterThan(0);
    expect(s.reason).toMatch(/political pressure|presidential/i);
  });

  it("a FAVORABLE Presidential signal never reads as a sell/negative signal", () => {
    const s = materialSellSignal(
      company({
        executiveSignal: execSignal({
          direction: "bullish",
          favorable: {
            kind: "buy",
            actor: "President Trump",
            summary: "Disclosed a buy.",
            date: "2026-06-20",
            daysAway: -4,
            magnitude: 0.62,
            sourceUrl: "https://example.com/oge",
            sourceLabel: "OGE 278-T",
          },
        }),
      }),
    );
    expect(s.intensity).toBe(0);
  });
});
