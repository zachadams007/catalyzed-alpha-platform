import { describe, expect, it } from "vitest";

import {
  CATALYST_DRIVEN_NORMALIZATION,
  CURATED_BASE_NORMALIZATION,
  INFLECTION_V2_NORMALIZATION,
  decompressDisplayScores,
  normalizeUniverse,
  type NormalizationOptions,
} from "@/engine/normalizeUniverse";
import { CATEGORY_CONFIG } from "@/engine/scoringConfig";
import type { ScoreCategoryKey, StockSignal } from "@/types";

const ALL_KEYS = CATEGORY_CONFIG.map((c) => c.key);

function sig(ticker: string, marketCap: number, cats: Partial<Record<ScoreCategoryKey, number>>): StockSignal {
  const categories = ALL_KEYS.map((key) => ({
    key,
    label: key,
    score: cats[key] ?? 50,
    weight: 0,
    contribution: 0,
    explanation: "",
  }));
  return {
    ticker,
    name: ticker,
    sector: "Technology",
    marketCap,
    score: { opportunityScore: 0, confidence: 70, confidenceExplanation: "", riskPenalty: 0, riskExplanation: "", categories },
  } as unknown as StockSignal;
}

const argsort = (xs: number[]): number[] => xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);

describe("decompressDisplayScores — fills the 0-100 scale, never re-ranks", () => {
  it("returns [] for an empty universe", () => {
    expect(decompressDisplayScores([])).toEqual([]);
  });

  it("is MONOTONE — preserves the exact ranking order", () => {
    const native = [38, 41, 36, 59, 23, 47, 39, 40, 44, 33];
    const out = decompressDisplayScores(native);
    expect(argsort(out)).toEqual(argsort(native)); // same order, different numbers
  });

  it("FILLS the scale — pushes the extremes to the rails and spreads the bunched body", () => {
    // Realistic champion shape: a couple genuine extremes (worst ~3, best ~100) with
    // a tightly-bunched 30-59 body in between - exactly what z→50+15z produces.
    const body = Array.from({ length: 196 }, (_, i) => 30 + (i / 195) * 29);
    const native = [3, 5, ...body, 99, 100];
    const out = decompressDisplayScores(native);
    expect(Math.min(...out)).toBeLessThan(5); // worst (native 3) → ~2
    expect(Math.max(...out)).toBeGreaterThan(95); // best (native 100) → ~100
    // The body is no longer crammed: the inter-decile spread widens dramatically.
    const sorted = [...out].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(0.1 * native.length)]!;
    const p90 = sorted[Math.floor(0.9 * native.length)]!;
    expect(p90 - p10).toBeGreaterThan(35); // native p90-p10 was ~23; absolute-leaning weight spreads less than pure percentile
  });

  it("weight=1 ⇒ pure percentile (uniform); weight=0 ⇒ identity (no spread)", () => {
    const native = [10, 20, 30, 40, 90];
    const pure = decompressDisplayScores(native, 1);
    const ident = decompressDisplayScores(native, 0);
    // Pure percentile ignores magnitude: equal spacing regardless of the 40→90 gap.
    expect(pure).toEqual([17, 33, 50, 67, 83]); // rank/(n+1)*100, n=5
    // weight=0 is the identity (rounded) - the absolute score, untouched.
    expect(ident).toEqual(native);
  });
});

describe("display decompression — wired to the live champion only", () => {
  it("INFLECTION_V2 (champion) decompresses; the shadow baselines do not", () => {
    expect(INFLECTION_V2_NORMALIZATION.decompressDisplay).toBe(true);
    expect(CATALYST_DRIVEN_NORMALIZATION.decompressDisplay).toBeFalsy();
    expect(CURATED_BASE_NORMALIZATION.decompressDisplay).toBeFalsy();
  });

  it("normalizeUniverse(champion) widens the displayed spread WITHOUT changing the order", () => {
    // A spread universe (varied caps + catalyst/valuation) so the composite isn't degenerate.
    const universe: StockSignal[] = Array.from({ length: 30 }, (_, i) => {
      const t = i / 29;
      return sig(`T${i}`, 10 ** (8.5 + t * 3.5), {
        catalyst: 90 - t * 70,
        valuation: 80 - t * 50,
        momentum: 30 + t * 40,
        inflection: 70 - t * 40,
      });
    });
    const champWithout: NormalizationOptions = { ...INFLECTION_V2_NORMALIZATION, decompressDisplay: false };
    const decompressed = normalizeUniverse(universe, undefined, INFLECTION_V2_NORMALIZATION);
    const native = normalizeUniverse(universe, undefined, champWithout);

    // Decompression is monotone in the RAW composite, so it never INVERTS the ranking
    // - it only breaks ties the 0-100 clamp created at the saturated top (a 3.1σ and a
    // 2.8σ name both clamp to native 100; decompression differentiates them). So sort
    // by the decompressed score and assert the native scores are non-increasing (no
    // inversion), rather than an identical order (which the clamp ties broke).
    const byDecompressed = [...decompressed].sort(
      (a, b) => b.score.opportunityScore - a.score.opportunityScore,
    );
    const nativeByTicker = new Map(native.map((s) => [s.ticker, s.score.opportunityScore]));
    for (let i = 1; i < byDecompressed.length; i++) {
      const prev = nativeByTicker.get(byDecompressed[i - 1]!.ticker)!;
      const cur = nativeByTicker.get(byDecompressed[i]!.ticker)!;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
    // But the decompressed numbers use more of the scale than the bunched native body.
    const span = (xs: StockSignal[]) => {
      const v = xs.map((s) => s.score.opportunityScore);
      return Math.max(...v) - Math.min(...v);
    };
    expect(span(decompressed)).toBeGreaterThan(span(native));
  });
});
