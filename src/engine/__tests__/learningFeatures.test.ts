import { describe, expect, it } from "vitest";

import {
  extractLearningFeatures,
  LEARNING_FEATURE_NAMES,
} from "@/engine/learningFeatures";
import type { StockSignal } from "@/types";

const AT = "2026-07-20T20:05:00.000Z";

/** Minimal live StockSignal carrying only the fields the extractor reads. */
function sig(over: Partial<Record<string, unknown>> = {}): StockSignal {
  const priceHistory = (over.priceHistory as number[]) ?? baseCloses();
  return {
    ticker: "T",
    price: (over.price as number) ?? priceHistory[priceHistory.length - 1] ?? 0,
    priceHistory,
    momentum: { rsi: 50, return1M: 0, return3M: 0, relativeStrength3M: 0 },
    catalyst: { magnitude: 0, daysAway: 999 },
    catalystLive: false,
    fundamentals: undefined,
    fundamentalsAvailability: undefined,
    risk: { dilutionRisk: 0.1 },
    ...over,
  } as unknown as StockSignal;
}

/** An accelerating collapse (falling knife): gentle drift, then a steep crash. */
function knifeCloses(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 100; i++) out.push(100 - i * 0.18);
  let p = out[out.length - 1]!;
  for (let i = 0; i < 30; i++) {
    p *= 1 - (0.01 + i * 0.0016);
    out.push(p);
  }
  return out;
}

/** A decline that FLATTENS into a low-vol base - the valley / early-turn setup. */
function baseCloses(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 110; i++) out.push(100 - i * 0.3);
  let p = out[out.length - 1]!;
  for (let i = 0; i < 20; i++) {
    p += 0.05;
    out.push(p);
  }
  return out;
}

/** A mature rebound: a washout followed by a large, already-consumed run-up. */
function matureReboundCloses(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 105; i++) out.push(100 - i * 0.45); // 100 → ~53
  let p = out[out.length - 1]!;
  for (let i = 0; i < 25; i++) {
    p *= 1.018; // ~+56% off the low, no fresh information required
    out.push(p);
  }
  return out;
}

describe("extractLearningFeatures — schema and determinism", () => {
  it("always emits every canonical feature name with observedAtISO", () => {
    const map = extractLearningFeatures(sig(), { observedAtISO: AT });
    expect(Object.keys(map).sort()).toEqual([...LEARNING_FEATURE_NAMES].sort());
    for (const f of Object.values(map)) {
      expect(f.observedAtISO).toBe(AT);
      if (f.value != null) expect(Number.isFinite(f.value)).toBe(true);
    }
  });

  it("is deterministic: identical snapshots produce byte-identical features", () => {
    const a = extractLearningFeatures(sig(), { observedAtISO: AT });
    const b = extractLearningFeatures(sig(), { observedAtISO: AT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("entry state — valley vs falling knife vs mature rebound (general mechanisms)", () => {
  it("negative control: an active falling knife scores zero readiness and raises the veto flag", () => {
    const map = extractLearningFeatures(
      sig({
        priceHistory: knifeCloses(),
        momentum: { rsi: 22, return1M: -0.32, return3M: -0.4, relativeStrength3M: -0.3 },
      }),
      { observedAtISO: AT },
    );
    expect(map.entry_falling_knife_veto.value).toBe(1);
    expect(map.entry_reversal_readiness.value).toBe(0);
  });

  it("positive control: a decelerated, based decline reads as a valley (readiness high, no veto)", () => {
    const map = extractLearningFeatures(
      sig({ priceHistory: baseCloses(), momentum: { rsi: 45, return1M: 0.01, return3M: -0.1, relativeStrength3M: 0 } }),
      { observedAtISO: AT },
    );
    expect(map.entry_falling_knife_veto.value).toBe(0);
    expect(map.entry_reversal_readiness.value!).toBeGreaterThan(0.5);
    expect(map.entry_drawdown_from_high.value!).toBeLessThan(-0.2);
  });

  it("staleness: a mature rebound shows a large consumed run-up off the 20d low", () => {
    const fresh = extractLearningFeatures(sig({ priceHistory: baseCloses() }), { observedAtISO: AT });
    const stale = extractLearningFeatures(sig({ priceHistory: matureReboundCloses() }), {
      observedAtISO: AT,
    });
    expect(stale.staleness_runup_from_20d_low.value!).toBeGreaterThan(0.3);
    expect(stale.staleness_runup_from_20d_low.value!).toBeGreaterThan(
      fresh.staleness_runup_from_20d_low.value!,
    );
    expect(stale.staleness_runup_vol_normalized.value!).toBeGreaterThan(0);
  });

  it("drawdown is normalized to the stock's OWN volatility, not an absolute threshold", () => {
    const map = extractLearningFeatures(sig({ priceHistory: baseCloses() }), { observedAtISO: AT });
    expect(map.entry_drawdown_vol_normalized.value).not.toBeNull();
    // vol-normalized drawdown must carry the sign of the raw drawdown
    expect(Math.sign(map.entry_drawdown_vol_normalized.value!)).toBe(
      Math.sign(map.entry_drawdown_from_high.value!),
    );
  });

  it("thin history yields null entry features, never fabricated ones", () => {
    const map = extractLearningFeatures(
      sig({ priceHistory: Array.from({ length: 40 }, (_, i) => 100 - i) }),
      { observedAtISO: AT },
    );
    expect(map.entry_reversal_readiness.value).toBeNull();
    expect(map.entry_drawdown_vol_normalized.value).toBeNull();
    expect(map.evidence_price_history_length.value).toBe(40);
  });
});

describe("quality vs financing vs demand separation (Oracle-class mechanism)", () => {
  it("keeps demand evidence (backlog/RPO) in separate features from debt burden", () => {
    const map = extractLearningFeatures(
      sig({
        fundamentals: { debtToEquity: 2.4, grossMargin: 0.7 },
        fundamentalsAvailability: { debtToEquity: true, grossMargin: true },
        pipeline: { backlogYoY: 0.5, deferredRevYoY: 0.3, bookToBill: 1.2 },
      }),
      { observedAtISO: AT, fundamentalsPublishedAtISO: "2026-07-10T21:00:00.000Z" },
    );
    expect(map.financing_debt_to_equity.value).toBe(2.4);
    expect(map.demand_backlog_growth_yoy.value).toBe(0.5);
    expect(map.demand_book_to_bill.value).toBe(1.2);
    expect(map.quality_gross_margin.value).toBe(0.7);
    expect(map.financing_debt_to_equity.publishedAtISO).toBe("2026-07-10T21:00:00.000Z");
  });

  it("fundamentals without proven live availability are null (no modeled placeholders)", () => {
    const map = extractLearningFeatures(
      sig({
        fundamentals: { debtToEquity: 2.4, grossMargin: 0.7 },
        // availability map absent → sample/modeled universe → not evidence
      }),
      { observedAtISO: AT },
    );
    expect(map.financing_debt_to_equity.value).toBeNull();
    expect(map.quality_gross_margin.value).toBeNull();
  });

  it("per-field availability=false blocks exactly that field", () => {
    const map = extractLearningFeatures(
      sig({
        fundamentals: { debtToEquity: 2.4, grossMargin: 0.7 },
        fundamentalsAvailability: { debtToEquity: false, grossMargin: true },
      }),
      { observedAtISO: AT },
    );
    expect(map.financing_debt_to_equity.value).toBeNull();
    expect(map.quality_gross_margin.value).toBe(0.7);
  });
});

describe("insider evidence (SoFi-class mechanism): open-market P-code only", () => {
  it("uses the verified open-market aggregates when present", () => {
    const map = extractLearningFeatures(
      sig({ secActivity: { form4Count90d: 14, form4BuyCount90d: 3, form4NetBuyValue90d: 1_250_000 } }),
      { observedAtISO: AT },
    );
    expect(map.insider_open_market_buys_90d.value).toBe(3);
    expect(map.insider_net_open_market_value_90d.value).toBe(1_250_000);
    expect(map.insider_open_market_buys_90d.source).toBe("filing");
  });

  it("a pile of non-P Form 4s (grants/options) contributes NOTHING when P-code data is absent", () => {
    const map = extractLearningFeatures(
      sig({ secActivity: { form4Count90d: 40 } }), // 40 filings, zero verified open-market context
      { observedAtISO: AT },
    );
    expect(map.insider_open_market_buys_90d.value).toBeNull();
    expect(map.insider_net_open_market_value_90d.value).toBeNull();
    // and no other feature name carries the undifferentiated Form 4 count
    expect(LEARNING_FEATURE_NAMES.some((n) => n.includes("form4"))).toBe(false);
  });
});

describe("catalyst state", () => {
  it("catalyst magnitude/timing only count when the catalyst is LIVE (headline-backed)", () => {
    const modeled = extractLearningFeatures(
      sig({ catalyst: { magnitude: 0.8, daysAway: 5 }, catalystLive: false }),
      { observedAtISO: AT },
    );
    expect(modeled.catalyst_live.value).toBe(0);
    expect(modeled.catalyst_magnitude.value).toBeNull();

    const liveCat = extractLearningFeatures(
      sig({ catalyst: { magnitude: 0.8, daysAway: 5 }, catalystLive: true }),
      { observedAtISO: AT },
    );
    expect(liveCat.catalyst_live.value).toBe(1);
    expect(liveCat.catalyst_magnitude.value).toBe(0.8);
    expect(liveCat.catalyst_days_away.value).toBe(5);
  });
});

describe("sample records and evidence completeness", () => {
  it("a marketDataUnavailable record yields ALL null values (sample never trains)", () => {
    const map = extractLearningFeatures(
      sig({
        marketDataUnavailable: "sample",
        fundamentals: { grossMargin: 0.9 },
        fundamentalsAvailability: { grossMargin: true },
        secActivity: { form4BuyCount90d: 5 },
      }),
      { observedAtISO: AT },
    );
    for (const [name, f] of Object.entries(map)) {
      if (name === "evidence_price_history_length" || name === "evidence_feature_coverage") continue;
      expect(f.value, name).toBeNull();
    }
    expect(map.evidence_feature_coverage.value).toBeGreaterThanOrEqual(0);
  });

  it("evidence_feature_coverage rises with richer rows", () => {
    const thin = extractLearningFeatures(sig({ momentum: undefined }), { observedAtISO: AT });
    const rich = extractLearningFeatures(
      sig({
        fundamentals: { grossMargin: 0.6, netMargin: 0.2, fcfMargin: 0.15, revenueGrowthYoY: 0.3, epsGrowthYoY: 0.4, debtToEquity: 0.8, peRatio: 25 },
        fundamentalsAvailability: {
          grossMargin: true,
          netMargin: true,
          fcfMargin: true,
          revenueGrowthYoY: true,
          epsGrowthYoY: true,
          debtToEquity: true,
          peRatio: true,
        },
        pipeline: { backlogYoY: 0.5, deferredRevYoY: 0.2, bookToBill: 1.1 },
        secActivity: { form4BuyCount90d: 2, form4NetBuyValue90d: 400_000 },
        valuation: { peVsOwn5yrPctile: 0.2 },
      }),
      { observedAtISO: AT },
    );
    expect(rich.evidence_feature_coverage.value!).toBeGreaterThan(thin.evidence_feature_coverage.value!);
  });
});
