import { describe, expect, it } from "vitest";

import {
  DEFAULT_RISK_APPETITE,
  getCurrentRiskAppetite,
  riskAdjustGates,
  riskAdjustedRankScore,
  riskTilt,
  setCurrentRiskAppetite,
} from "@/feed/riskTilt";
import { DEFAULT_PREFILTER_GATES } from "@/data/funnel/prefilter";
import type { StockSignal } from "@/types";

function sig(opportunityScore: number, confidence: number, riskPenalty: number): StockSignal {
  return {
    ticker: "T",
    score: { opportunityScore, confidence, riskPenalty, categories: [] },
    confidence,
  } as unknown as StockSignal;
}

describe("riskTilt", () => {
  it("maps the conservative extreme to strict, risk-averse knobs", () => {
    const t = riskTilt(0);
    expect(t.gateFactor).toBeCloseTo(1.7, 5);
    expect(t.penaltyFactor).toBeCloseTo(1.6, 5);
    expect(t.surfaceFloor).toBeCloseTo(42, 5);
  });

  it("maps the aggressive extreme to broad, risk-forgiving knobs", () => {
    const t = riskTilt(1);
    expect(t.gateFactor).toBeCloseTo(0.6, 5);
    expect(t.penaltyFactor).toBeCloseTo(0.5, 5);
    expect(t.surfaceFloor).toBeCloseTo(0, 5);
  });

  it("clamps out-of-range appetites", () => {
    expect(riskTilt(-1)).toEqual(riskTilt(0));
    expect(riskTilt(2)).toEqual(riskTilt(1));
  });
});

describe("riskAdjustGates", () => {
  it("raises the floors for conservative and lowers them for aggressive", () => {
    const safe = riskAdjustGates(DEFAULT_PREFILTER_GATES, 0);
    const bold = riskAdjustGates(DEFAULT_PREFILTER_GATES, 1);
    expect(safe.minDollarVolume).toBeGreaterThan(DEFAULT_PREFILTER_GATES.minDollarVolume);
    expect(safe.minMarketCap).toBeGreaterThan(DEFAULT_PREFILTER_GATES.minMarketCap);
    expect(bold.minDollarVolume).toBeLessThan(DEFAULT_PREFILTER_GATES.minDollarVolume);
    expect(bold.minMarketCap).toBeLessThan(DEFAULT_PREFILTER_GATES.minMarketCap);
  });

  it("never lowers the penny-stock price floor (a guardrail)", () => {
    expect(riskAdjustGates(DEFAULT_PREFILTER_GATES, 1).minPrice).toBe(
      DEFAULT_PREFILTER_GATES.minPrice,
    );
  });
});

describe("riskAdjustedRankScore", () => {
  it("ranks a risky name lower for a conservative dial than an aggressive one", () => {
    const risky = sig(40, 50, 20);
    expect(riskAdjustedRankScore(risky, 1)).toBeGreaterThan(riskAdjustedRankScore(risky, 0));
  });

  it("leaves a clean, high-conviction name unchanged across the dial", () => {
    const clean = sig(90, 75, 0);
    expect(riskAdjustedRankScore(clean, 0)).toBeCloseTo(riskAdjustedRankScore(clean, 1), 5);
  });
});

describe("currentRiskAppetite mirror", () => {
  it("round-trips and clamps", () => {
    setCurrentRiskAppetite(0.3);
    expect(getCurrentRiskAppetite()).toBe(0.3);
    setCurrentRiskAppetite(5);
    expect(getCurrentRiskAppetite()).toBe(1);
    setCurrentRiskAppetite(DEFAULT_RISK_APPETITE); // restore for other suites
    expect(getCurrentRiskAppetite()).toBe(DEFAULT_RISK_APPETITE);
  });
});
