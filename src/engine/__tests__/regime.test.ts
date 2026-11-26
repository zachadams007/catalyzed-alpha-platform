import { describe, expect, it } from "vitest";

import { capCurveWeights } from "@/engine/capCurve";
import {
  REGIME_RISK_OFF_BUFFER,
  REGIME_SPY_SMA_DAYS,
  breadthAboveSma50,
  buildMarketRegimeContext,
  computeFearGreed,
  computeMarketRegime,
  fearGreedLabelFor,
} from "@/engine/regime";
import type { StockSignal } from "@/types";

function flatSpy(close = 100, days = REGIME_SPY_SMA_DAYS): number[] {
  return Array.from({ length: days }, () => close);
}

function sig(ticker: string, aboveSMA50: boolean): StockSignal {
  return {
    ticker,
    momentum: { aboveSMA50 },
  } as StockSignal;
}

describe("market regime context", () => {
  it("cold-starts neutral when SPY lacks a 200-DMA window", () => {
    const ctx = computeMarketRegime(flatSpy(100, 80));
    expect(ctx.riskOffness).toBe(0);
    expect(ctx.label).toBe("neutral");
  });

  it("stays risk-on when SPY is above its 200-DMA", () => {
    const ctx = computeMarketRegime([...flatSpy(100, 199), 106]);
    expect(ctx.riskOffness).toBe(0);
    expect(ctx.label).toBe("risk-on");
    expect(ctx.spyDistanceToSma200).toBeGreaterThan(0);
  });

  it("turns risk-off once SPY is below its 200-DMA", () => {
    const justAboveTrend = computeMarketRegime([...flatSpy(100, 199), 101]);
    const belowTrend = computeMarketRegime([...flatSpy(100, 199), 98]);

    expect(justAboveTrend.spyDistanceToSma200).toBeGreaterThan(REGIME_RISK_OFF_BUFFER);
    expect(justAboveTrend.riskOffness).toBe(0);
    expect(belowTrend.riskOffness).toBeGreaterThan(0);
  });

  it("recognizes correction pressure before SPY loses its 200-DMA", () => {
    const ctx = computeMarketRegime([...flatSpy(100, 179), ...flatSpy(120, 20), 104]);

    expect(ctx.spyDistanceToSma200).toBeGreaterThan(0);
    expect(ctx.spyDistanceToSma50).toBeLessThan(0);
    expect(ctx.riskOffness).toBeGreaterThan(0);
  });

  it("uses breadth as a confirmer without making it required", () => {
    const spy = [...flatSpy(100, 199), 90];
    const base = computeMarketRegime(spy);
    const weakBreadth = computeMarketRegime(spy, 0.2);
    expect(weakBreadth.riskOffness).toBeGreaterThan(base.riskOffness ?? 0);
  });

  it("computes universe breadth from point-in-time signals", () => {
    expect(breadthAboveSma50([sig("A", true), sig("B", false), sig("C", false)])).toBeCloseTo(1 / 3);
    expect(buildMarketRegimeContext({ spyCloses: flatSpy(100), signals: [] }).riskOffness).toBe(0);
  });

  it("P9: panic tilts cap-curve weights toward discounted QUALITY, not low-vol safety", () => {
    const base = capCurveWeights(50_000_000_000);
    const panic = capCurveWeights(50_000_000_000, undefined, { riskOffness: 1 });

    // Quality + value + inflection lean IN; momentum and hype lean OUT.
    expect(panic.valuation).toBeGreaterThan(base.valuation);
    expect(panic.fundamentals).toBeGreaterThan(base.fundamentals);
    expect(panic.momentum).toBeLessThan(base.momentum);
    expect(panic.social).toBeLessThan(base.social);
    // NOT a defensive rotation: volatility must never be the panic vector's
    // headline (the old RISK_OFF_WEIGHTS made it the single largest weight, 0.23).
    expect(panic.volatility).toBeLessThan(0.08);
    expect(panic.volatility).toBeLessThan(panic.valuation);
    expect(panic.volatility).toBeLessThan(panic.inflection);
    expect(Object.values(panic).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe("fear & greed composite (P9)", () => {
  /** A steady rally: +0.3%/day for a year - greedy tape. */
  function rally(): number[] {
    const out: number[] = [];
    let p = 100;
    for (let i = 0; i < 260; i++) {
      p *= 1.003;
      out.push(p);
    }
    return out;
  }
  /** A crash: flat year, then −2%/day for 30 sessions - fearful tape. */
  function crash(): number[] {
    const out = Array.from({ length: 230 }, () => 100);
    let p = 100;
    for (let i = 0; i < 30; i++) {
      p *= 0.98;
      out.push(p);
    }
    return out;
  }

  it("reads a rally as greed and a crash as fear (with breadth confirming)", () => {
    expect(computeFearGreed(rally(), 0.85)).toBeGreaterThan(60);
    expect(computeFearGreed(crash(), 0.15)).toBeLessThan(30);
  });

  it("is neutral 50 with no inputs and bands labels correctly", () => {
    expect(computeFearGreed([], undefined)).toBe(50);
    expect(fearGreedLabelFor(10)).toBe("extreme-fear");
    expect(fearGreedLabelFor(35)).toBe("fear");
    expect(fearGreedLabelFor(50)).toBe("neutral");
    expect(fearGreedLabelFor(65)).toBe("greed");
    expect(fearGreedLabelFor(90)).toBe("extreme-greed");
  });

  it("an external (CNN) reading overrides the internal composite and is labeled by source", () => {
    const withCnn = computeMarketRegime(rally(), 0.85, 12);
    expect(withCnn.fearGreed).toBe(12);
    expect(withCnn.fearGreedLabel).toBe("extreme-fear");
    expect(withCnn.fearGreedSource).toBe("cnn");
    const internal = computeMarketRegime(rally(), 0.85);
    expect(internal.fearGreedSource).toBe("internal");
    expect(internal.fearGreed).toBeGreaterThan(60);
  });
});
