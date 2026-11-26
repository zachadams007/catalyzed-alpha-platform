import { describe, expect, it } from "vitest";

import {
  CATALYST_DRIVEN_NORMALIZATION,
  CURATED_BASE_NORMALIZATION,
  INFLECTION_V2_NORMALIZATION,
  computeNormalizedScores,
  MAX_REVISION_POINTS,
  normalizeUniverse,
} from "@/engine/normalizeUniverse";
import { CATEGORY_CONFIG } from "@/engine/scoringConfig";
import type { ScoreCategoryKey, StockSignal } from "@/types";

const ALL_KEYS = CATEGORY_CONFIG.map((c) => c.key);

/** The raw per-company blend (what `scoreCompany` ranks by) for a signal, using
 *  the real CATEGORY_CONFIG weights - the size-biased baseline we're replacing. */
function rawBlend(s: StockSignal): number {
  const byKey = new Map(s.score.categories.map((c) => [c.key, c.score] as const));
  let blend = 0;
  for (const cfg of CATEGORY_CONFIG) blend += cfg.weight * (byKey.get(cfg.key) ?? 50);
  return blend - (s.score.riskPenalty ?? 0);
}

/**
 * A realistic universe where the *opportunities* live in the smaller names but
 * mega-cap COVERAGE (news/social/liquidity, which scale with size) drowns them
 * out in a naive per-company blend. Small caps carry the strong catalyst + value;
 * mega caps carry the coverage. This is exactly the mega-cap over-representation
 * the cap-balancing must kill.
 */
function coverageBiasedUniverse(): StockSignal[] {
  return Array.from({ length: 20 }, (_, i) => {
    const t = i / 19;
    const logCap = 8.3 + t * 3.9; // ~2e8 (small) .. ~1.6e12 (mega)
    const coverage = 15 + t * 78; // 15 → 93, scales WITH size
    const catalyst = 90 - t * 55; // 90 → 35, strong in the small names
    const valuation = 85 - t * 45; // 85 → 40, discounted entries skew smaller
    return sig({
      ticker: `N${i}`,
      marketCap: 10 ** logCap,
      cats: {
        news: coverage,
        social: coverage,
        liquidity: coverage,
        catalyst,
        valuation,
        momentum: 55,
        fundamentals: 55,
        growth: 55,
        volatility: 50,
      },
    });
  });
}

/** Tickers ordered best→worst by a score function. */
function rankOrder(signals: StockSignal[], scoreOf: (s: StockSignal) => number): string[] {
  return [...signals].sort((a, b) => scoreOf(b) - scoreOf(a)).map((s) => s.ticker);
}

function sig(over: {
  ticker: string;
  marketCap?: number;
  sector?: string;
  riskPenalty?: number;
  volatility?: Partial<StockSignal["volatility"]>;
  cats?: Partial<Record<ScoreCategoryKey, number>>;
  priceHistory?: number[];
  price?: number;
  momentum?: Partial<StockSignal["momentum"]>;
  catalyst?: Partial<StockSignal["catalyst"]>;
  catalystLive?: boolean;
}): StockSignal {
  const categories = ALL_KEYS.map((key) => ({
    key,
    label: key,
    score: over.cats?.[key] ?? 50,
    weight: 0,
    contribution: 0,
    explanation: "",
  }));
  const closes = over.priceHistory;
  return {
    ticker: over.ticker,
    name: over.ticker,
    sector: over.sector ?? "Technology",
    marketCap: over.marketCap ?? 1_000_000_000,
    price: over.price ?? (closes ? closes[closes.length - 1] : 0) ?? 0,
    priceHistory: closes,
    momentum: over.momentum,
    catalyst: over.catalyst,
    catalystLive: over.catalystLive,
    score: {
      opportunityScore: 0,
      confidence: 70,
      confidenceExplanation: "",
      riskPenalty: over.riskPenalty ?? 0,
      riskExplanation: "",
      categories,
    },
    volatility: {
      atrPct: 0.06,
      beta: 1.1,
      impliedVol: 0.7,
      ...over.volatility,
    },
  } as unknown as StockSignal;
}

/** An accelerating collapse (falling knife) - see reversalReadiness.test.ts. */
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

/** A real drawdown that then flattens into a low-vol base. */
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

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i]! - mx) * (ys[i]! - my);
    vx += (xs[i]! - mx) ** 2;
    vy += (ys[i]! - my) ** 2;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

describe("normalizeUniverse — purity & shape", () => {
  it("returns [] for an empty universe", () => {
    expect(normalizeUniverse([])).toEqual([]);
    expect(computeNormalizedScores([])).toEqual([]);
  });

  it("does not mutate inputs and preserves raw category scores", () => {
    const input = [
      sig({ ticker: "A", cats: { catalyst: 80 } }),
      sig({ ticker: "B", cats: { catalyst: 20 } }),
      sig({ ticker: "C", cats: { catalyst: 50 } }),
    ];
    const before = JSON.stringify(input);
    const out = normalizeUniverse(input);
    expect(JSON.stringify(input)).toBe(before); // untouched
    // Raw per-category scores carry over unchanged; only opportunityScore moves.
    out.forEach((s, i) => {
      expect(s.score.categories).toEqual(input[i]!.score.categories);
    });
  });

  it("is deterministic", () => {
    const build = () => [
      sig({ ticker: "A", marketCap: 2e8, cats: { catalyst: 90 } }),
      sig({ ticker: "B", marketCap: 5e11, cats: { news: 90 } }),
      sig({ ticker: "C", marketCap: 1e9, cats: { momentum: 70 } }),
    ];
    const a = computeNormalizedScores(build());
    const b = computeNormalizedScores(build());
    expect(a).toEqual(b);
  });

  it("P9: panic does NOT rotate to low-vol 'safety' — calm vs wild vol alone no longer re-ranks", () => {
    // The old design blended a defensive low-vol read into the dimensions at
    // riskOffness 1, so LOW beat HIGH on volatility alone (flight-to-safety).
    // P9 removed that rotation: with identical scores and no risk penalty, raw
    // volatility profiles alone must not create a panic-day ranking gap.
    const universe = [
      sig({ ticker: "LOW", marketCap: 8e9, volatility: { atrPct: 0.025, beta: 0.75, impliedVol: 0.3 } }),
      sig({ ticker: "HIGH", marketCap: 8e9, volatility: { atrPct: 0.13, beta: 2.2, impliedVol: 1.2 } }),
    ];
    const scores = computeNormalizedScores(
      universe,
      { regime: { riskOffness: 1 } },
      INFLECTION_V2_NORMALIZATION,
    );
    const byTicker = new Map(scores.map((s) => [s.ticker, s.opportunityScore]));
    expect(byTicker.get("LOW")).toBe(byTicker.get("HIGH"));
  });

  it("P9: panic AMPLIFIES the discount reward for a data-backed quality discount (greedy on quality)", () => {
    // Identical universe scored calm vs full-panic: the discounted-quality name's
    // discount tilt must grow (~×1.5) in panic - leaning into the fear - while the
    // amplification stays bounded.
    const build = () => [
      sig({
        ticker: "QUAL",
        marketCap: 8e9,
        cats: { valuation: 90, fundamentals: 70 },
        priceHistory: baseCloses(),
        momentum: { rsi: 45, return1M: 0.01 } as StockSignal["momentum"],
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        sig({ ticker: `F${i}`, marketCap: 8e9, cats: { valuation: 40, fundamentals: 50 } }),
      ),
    ];
    const calm = computeNormalizedScores(build(), { regime: { riskOffness: 0 } }, INFLECTION_V2_NORMALIZATION);
    const panic = computeNormalizedScores(build(), { regime: { riskOffness: 1 } }, INFLECTION_V2_NORMALIZATION);
    const calmTilt = calm.find((s) => s.ticker === "QUAL")!.discountTilt;
    const panicTilt = panic.find((s) => s.ticker === "QUAL")!.discountTilt;
    expect(calmTilt).toBeGreaterThan(0);
    expect(panicTilt).toBeGreaterThan(calmTilt);
    expect(panicTilt).toBeLessThanOrEqual(calmTilt * 1.5 + 1e-9);
  });

  it("gives every name the same score in a degenerate (all-identical) universe", () => {
    const u = ["A", "B", "C", "D"].map((t) => sig({ ticker: t, riskPenalty: 0 }));
    const scores = computeNormalizedScores(u).map((s) => s.opportunityScore);
    expect(new Set(scores).size).toBe(1);
  });
});

describe("normalizeUniverse — size residualization", () => {
  it("makes size-residualized dims ~uncorrelated with log market cap, unlike raw dims", () => {
    // News & catalyst both scale with cap; only news is size-residualized.
    const universe = Array.from({ length: 24 }, (_, i) => {
      const logCap = 8 + (i / 23) * 5; // 1e8 .. 1e13
      const coverage = 20 + (logCap - 8) * 14; // bigger = more coverage
      return sig({
        ticker: `T${i}`,
        marketCap: 10 ** logCap,
        cats: { news: coverage, social: coverage, catalyst: coverage },
      });
    });
    const logCaps = universe.map((s) => Math.log10(s.marketCap));
    const scores = computeNormalizedScores(universe);
    const newsZ = scores.map((s) => s.dimensionZ.news ?? 0);
    const catalystZ = scores.map((s) => s.dimensionZ.catalyst ?? 0);

    // News is residualized → its z loses the size relationship.
    expect(Math.abs(pearson(newsZ, logCaps))).toBeLessThan(0.35);
    // Catalyst is NOT residualized → it still tracks size strongly (sanity check).
    expect(Math.abs(pearson(catalystZ, logCaps))).toBeGreaterThan(0.85);
  });
});

describe("normalizeUniverse — anti-megacap ranking", () => {
  it("lets a catalyzed small-cap out-rank an un-catalyzed megacap", () => {
    const filler = Array.from({ length: 10 }, (_, i) =>
      sig({
        ticker: `F${i}`,
        marketCap: 10 ** (9 + (i / 9) * 2), // 1e9 .. 1e11
        cats: { news: 40 + i * 3, social: 40 + i * 3, catalyst: 50, valuation: 50 },
      }),
    );
    const mega = sig({
      ticker: "MEGA",
      marketCap: 1e12,
      cats: { news: 96, social: 96, catalyst: 22, valuation: 25 },
    });
    const small = sig({
      ticker: "SMALL",
      marketCap: 3e8,
      cats: { news: 25, social: 25, catalyst: 96, valuation: 92 },
    });
    const universe = [mega, small, ...filler];
    const scores = computeNormalizedScores(universe);
    const byTicker = new Map(scores.map((s) => [s.ticker, s.opportunityScore]));
    expect(byTicker.get("SMALL")!).toBeGreaterThan(byTicker.get("MEGA")!);
  });
});

describe("normalizeUniverse — estimate-revision tilt (Mission 4)", () => {
  it("tilts up on upward revisions, down on cuts, bounded, neutral without ctx", () => {
    const u = ["A", "B", "C", "D"].map((t) => sig({ ticker: t }));
    const scores = computeNormalizedScores(u, { revision: { A: 100, B: 0, C: 50 } });
    const m = new Map(scores.map((s) => [s.ticker, s]));
    expect(m.get("A")!.revisionTilt).toBeCloseTo(MAX_REVISION_POINTS, 5);
    expect(m.get("B")!.revisionTilt).toBeCloseTo(-MAX_REVISION_POINTS, 5);
    expect(m.get("C")!.revisionTilt).toBe(0); // 50 → neutral
    expect(m.get("D")!.revisionTilt).toBe(0); // no ctx entry → neutral
    expect(m.get("D")!.revisionScore).toBe(50);
    // Up-revised name out-ranks the cut name in an otherwise identical universe.
    expect(m.get("A")!.opportunityScore).toBeGreaterThan(m.get("B")!.opportunityScore);
    expect(Math.abs(m.get("A")!.revisionTilt)).toBeLessThanOrEqual(MAX_REVISION_POINTS);
  });

  it("an empty/omitted revision ctx leaves scores byte-identical to no ctx", () => {
    const u = ["A", "B", "C"].map((t) =>
      sig({ ticker: t, cats: { catalyst: t === "A" ? 80 : 40 } }),
    );
    const baseline = computeNormalizedScores(u).map((s) => s.opportunityScore);
    expect(computeNormalizedScores(u, {}).map((s) => s.opportunityScore)).toEqual(baseline);
    expect(computeNormalizedScores(u, { revision: {} }).map((s) => s.opportunityScore)).toEqual(
      baseline,
    );
  });
});

describe("normalizeUniverse — EWMA-smoothed news/social input (Mission 4)", () => {
  it("uses the smoothed value as the normalization input for news", () => {
    // Identical raw news; the context smooths A's up and B's down.
    const u = ["A", "B", "C", "D", "E"].map((t) => sig({ ticker: t, cats: { news: 50 } }));
    const scores = computeNormalizedScores(u, {
      smoothed: { A: { news: 95 }, B: { news: 5 } },
    });
    const z = new Map(scores.map((s) => [s.ticker, s.dimensionZ.news ?? 0]));
    expect(z.get("A")!).toBeGreaterThan(z.get("C")!);
    expect(z.get("B")!).toBeLessThan(z.get("C")!);
  });

  it("falls back to the raw sub-score when no smoothed value is supplied", () => {
    const u = ["A", "B", "C"].map((t) =>
      sig({ ticker: t, cats: { news: t === "A" ? 80 : 40 } }),
    );
    const raw = computeNormalizedScores(u).map((s) => s.dimensionZ.news);
    expect(computeNormalizedScores(u, { smoothed: {} }).map((s) => s.dimensionZ.news)).toEqual(raw);
  });
});

describe("normalizeUniverse — sector neutralization", () => {
  it("scores 'good for its sector' above 'mediocre in a strong sector'", () => {
    // Strong sector (Technology): high fundamentals baseline, 6 names.
    const tech = Array.from({ length: 6 }, (_, i) =>
      sig({
        ticker: `TECH${i}`,
        sector: "Technology",
        marketCap: 5e9,
        cats: { fundamentals: 80 + i }, // 80..85
      }),
    );
    // Weak sector (Utilities): low fundamentals baseline, 6 names.
    const util = Array.from({ length: 6 }, (_, i) =>
      sig({
        ticker: `UTIL${i}`,
        sector: "Utilities",
        marketCap: 5e9,
        cats: { fundamentals: 20 + i }, // 20..25
      }),
    );
    const scores = computeNormalizedScores([...tech, ...util]);
    const z = new Map(scores.map((s) => [s.ticker, s.dimensionZ.fundamentals ?? 0]));
    // UTIL5 (top of a weak sector, raw 25) beats TECH0 (bottom of a strong
    // sector, raw 80) on the sector-neutral fundamentals dimension.
    expect(z.get("UTIL5")!).toBeGreaterThan(z.get("TECH0")!);
  });
});

describe("normalizeUniverse — cap balancing (kills mega-cap over-representation)", () => {
  it("the structural coverage edge tracks size; the champion ranking does not", () => {
    const universe = coverageBiasedUniverse();
    const logCaps = universe.map((s) => Math.log10(s.marketCap));

    // The raw coverage dims (news/social/liquidity) scale WITH size - the structural
    // mega-cap edge the cap-balancing must strip. (v2 deliberately downweights these
    // coverage dims in the blend, which is itself part of the fix; here we use the
    // raw coverage signal directly as the honest size-bias proxy.)
    const coverage = universe.map((s) => s.score.categories.find((c) => c.key === "news")!.score);
    expect(pearson(coverage, logCaps)).toBeGreaterThan(0.9);

    // The promoted v2 champion (size-residualization + zero-mean size tilt + per-name
    // cap-cohort weight routing) strips that mega-cap edge: its ranking is NOT
    // positively size-biased. On this adversarial fixture (all the catalyst/value
    // lives in the small names, the only size-correlated signal is coverage, which is
    // residualized away) it actively favors the small caps - the desired direction.
    // (Realistic universes balance out; see capBalance.demo.test.ts.)
    const champ = normalizeUniverse(universe, undefined, INFLECTION_V2_NORMALIZATION);
    const champScores = champ.map((s) => s.score.opportunityScore);
    const champCorr = pearson(champScores, logCaps);
    expect(champCorr).toBeLessThan(0.2); // not mega-cap biased
    // And it killed the structural mega-cap edge by a wide margin, not by a hair.
    expect(champCorr).toBeLessThan(pearson(coverage, logCaps) - 0.5);
  });

  it("surfaces a cap-balanced Today set instead of a wall of mega-caps", () => {
    const universe = coverageBiasedUniverse();
    const smallMidCap = 1e10; // ≤ $10B counts as small/mid here

    // A naive coverage-led blend (the structural size edge) would crown mega-caps.
    const coverageTop = rankOrder(
      universe,
      (s) => s.score.categories.find((c) => c.key === "news")!.score,
    ).slice(0, 8);
    const champTop = rankOrder(
      normalizeUniverse(universe, undefined, INFLECTION_V2_NORMALIZATION),
      (s) => s.score.opportunityScore,
    ).slice(0, 8);

    const smallMids = (tickers: string[]) =>
      tickers.filter((t) => universe.find((s) => s.ticker === t)!.marketCap <= smallMidCap).length;

    // The coverage-led ordering is mega-cap heavy; the cap-balanced champion is balanced.
    expect(smallMids(coverageTop)).toBeLessThanOrEqual(2);
    expect(smallMids(champTop)).toBeGreaterThanOrEqual(4);
    // The most-catalyzed smallest name reaches Today under the cap-balanced champion only.
    expect(champTop).toContain("N0");
    expect(coverageTop).not.toContain("N0");
  });

  it("the size tilt is bounded and zero for an all-same-cap universe", () => {
    const flat = ["A", "B", "C", "D"].map((t) => sig({ ticker: t, marketCap: 5e9 }));
    for (const s of computeNormalizedScores(flat, undefined, CATALYST_DRIVEN_NORMALIZATION)) {
      expect(s.sizeTilt).toBe(0);
    }
    const spread = coverageBiasedUniverse();
    for (const s of computeNormalizedScores(spread, undefined, CATALYST_DRIVEN_NORMALIZATION)) {
      expect(Math.abs(s.sizeTilt)).toBeLessThanOrEqual(CATALYST_DRIVEN_NORMALIZATION.capTilt);
    }
  });
});

describe("normalizeUniverse — the two engine profiles differ by algorithm only", () => {
  it("produce different live rankings over the identical universe", () => {
    const universe = coverageBiasedUniverse();
    const champ = normalizeUniverse(universe, undefined, CURATED_BASE_NORMALIZATION);
    const chall = normalizeUniverse(universe, undefined, CATALYST_DRIVEN_NORMALIZATION);

    const champOrder = rankOrder(champ, (s) => s.score.opportunityScore);
    const challOrder = rankOrder(chall, (s) => s.score.opportunityScore);
    // A promotion is observable: the two profiles rank the same universe differently.
    expect(champOrder).not.toEqual(challOrder);

    // Same raw inputs, so the per-name scores still differ purely by profile
    // (the catalyst-driven profile's thesis gate + size-balanced catalyst/discount
    // blend, over the SAME gentle cap tilt as the curated base) - e.g. the smallest name.
    const cScore = new Map(champ.map((s) => [s.ticker, s.score.opportunityScore]));
    const xScore = new Map(chall.map((s) => [s.ticker, s.score.opportunityScore]));
    expect(cScore.get("N0")).not.toBe(xScore.get("N0"));
  });

  it("size-balances the catalyst-driven profile's LANE-D tilt bundle (keeps cap BALANCE, not small-cap skew)", () => {
    // coverageBiasedUniverse() puts catalyst + valuation (the LANE-D tilt drivers)
    // in the SMALLEST names - the discovery-universe skew that, unbalanced, rotates
    // Today to small-caps. The size-balance correction must strip the part of the
    // tilt bundle that scales with market cap, WITHOUT killing small-cap inclusion.
    const universe = coverageBiasedUniverse();
    const logCaps = universe.map((s) => Math.log10(s.marketCap));

    const corr = (ys: number[]): number => {
      const mx = logCaps.reduce((a, b) => a + b, 0) / logCaps.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let cov = 0,
        vx = 0,
        vy = 0;
      for (let i = 0; i < ys.length; i++) {
        cov += (logCaps[i]! - mx) * (ys[i]! - my);
        vx += (logCaps[i]! - mx) ** 2;
        vy += (ys[i]! - my) ** 2;
      }
      return vx === 0 || vy === 0 ? 0 : cov / Math.sqrt(vx * vy);
    };
    const bundleOf = (ns: ReturnType<typeof computeNormalizedScores>) =>
      ns.map((s) => s.catalystTilt + s.sellWatchTilt + s.discountTilt + s.revisionTilt);

    const off = computeNormalizedScores(universe, undefined, {
      ...CATALYST_DRIVEN_NORMALIZATION,
      sizeBalanceTilts: false,
    });
    const on = computeNormalizedScores(universe, undefined, CATALYST_DRIVEN_NORMALIZATION);

    // The raw LANE-D bundle is strongly NEGATIVELY correlated with cap (favors small).
    const rawBundle = bundleOf(off);
    expect(corr(rawBundle)).toBeLessThan(-0.3);

    // The EFFECTIVE bundle under size-balance (raw bundle + the correction term) is
    // ~cap-neutral: the size-explained part has been residualized out.
    const balancedBundle = on.map(
      (s, i) => rawBundle[i]! + s.sizeBalanceTilt,
    );
    expect(Math.abs(corr(balancedBundle))).toBeLessThan(0.05);

    // The correction is active (non-zero) and the curated-base profile never uses it.
    expect(on.some((s) => Math.abs(s.sizeBalanceTilt) > 0.01)).toBe(true);
    for (const s of computeNormalizedScores(universe, undefined, CURATED_BASE_NORMALIZATION)) {
      expect(s.sizeBalanceTilt).toBe(0);
    }
  });

  it("P1: an active falling knife loses its discount REWARD while a based name keeps it", () => {
    // KNIFE and BASE are identically discounted (valuation 90) with the SAME
    // data-backed thesis (fundamentals 70) - the ONLY difference is price action:
    // KNIFE is mid-crash (RSI 22, −32%/1M, accelerating), BASE has flattened. The
    // reversal-readiness gate must strip KNIFE's discount reward and keep BASE's.
    const filler = Array.from({ length: 8 }, (_, i) =>
      sig({ ticker: `F${i}`, marketCap: 2e9, cats: { valuation: 40, fundamentals: 50 } }),
    );
    const knife = sig({
      ticker: "KNIFE",
      marketCap: 2e9,
      cats: { valuation: 90, fundamentals: 70 },
      priceHistory: knifeCloses(),
      momentum: { rsi: 22, return1M: -0.32 } as StockSignal["momentum"],
    });
    const base = sig({
      ticker: "BASE",
      marketCap: 2e9,
      cats: { valuation: 90, fundamentals: 70 },
      priceHistory: baseCloses(),
      momentum: { rsi: 45, return1M: 0.01 } as StockSignal["momentum"],
    });
    const scores = computeNormalizedScores([knife, base, ...filler], undefined, INFLECTION_V2_NORMALIZATION);
    const byT = new Map(scores.map((s) => [s.ticker, s]));

    expect(byT.get("KNIFE")!.reversalReadiness).toBe(0);
    expect(byT.get("BASE")!.reversalReadiness).toBeGreaterThan(0.5);
    // The knife collects NO discount bonus; the based name does.
    expect(byT.get("KNIFE")!.discountTilt).toBe(0);
    expect(byT.get("BASE")!.discountTilt).toBeGreaterThan(0);
    // ...and it is NOT a penalty - the knife's discount tilt is exactly 0, never negative.
    expect(byT.get("KNIFE")!.discountTilt).not.toBeLessThan(0);
  });

  it("P1: a FRESH adverse shock halves a based quality name's discount reward (AEM mine-halt case)", () => {
    const filler = Array.from({ length: 8 }, (_, i) =>
      sig({ ticker: `F${i}`, marketCap: 2e9, cats: { valuation: 40, fundamentals: 50 } }),
    );
    const shocked = baseCloses();
    shocked[shocked.length - 2] = shocked[shocked.length - 3]! * 0.9; // a −10% single-session gap
    const based = sig({
      ticker: "BASED",
      marketCap: 2e9,
      cats: { valuation: 90, fundamentals: 70 },
      priceHistory: baseCloses(),
      momentum: { rsi: 45, return1M: 0.01 } as StockSignal["momentum"],
    });
    const shock = sig({
      ticker: "SHOCK",
      marketCap: 2e9,
      cats: { valuation: 90, fundamentals: 70 },
      priceHistory: shocked,
      momentum: { rsi: 45, return1M: 0.01 } as StockSignal["momentum"],
    });
    const scores = computeNormalizedScores([based, shock, ...filler], undefined, INFLECTION_V2_NORMALIZATION);
    const byT = new Map(scores.map((s) => [s.ticker, s]));
    // Same discounted quality thesis, but the fresh-shocked name is digesting an event -
    // its readiness (and thus its discount reward) is cut, without going negative.
    expect(byT.get("SHOCK")!.reversalReadiness).toBeLessThan(byT.get("BASED")!.reversalReadiness);
    expect(byT.get("SHOCK")!.discountTilt).toBeLessThan(byT.get("BASED")!.discountTilt);
    expect(byT.get("SHOCK")!.discountTilt).toBeGreaterThanOrEqual(0);
  });

  it("P4: a cold-start neutral backer cannot unlock the discount reward (only a data-backed one can)", () => {
    // Three low real inflection reads (30) let the no-data block (50) earn a positive
    // inflection z via the midrank artifact. NODATA is discounted (valuation 90) but
    // its ONLY would-be backer is that neutral-50 inflection - it must earn NO reward.
    // REAL_BACKER is identical but carries a genuinely data-backed fundamentals (70).
    const low = ["LOW1", "LOW2", "LOW3"].map((t) =>
      sig({ ticker: t, marketCap: 2e9, cats: { inflection: 30, valuation: 45, fundamentals: 50 } }),
    );
    const filler = Array.from({ length: 5 }, (_, i) =>
      sig({ ticker: `F${i}`, marketCap: 2e9, cats: { valuation: 48 } }),
    );
    const nodata = sig({ ticker: "NODATA", marketCap: 2e9, cats: { valuation: 90 } });
    const realBacker = sig({
      ticker: "REAL",
      marketCap: 2e9,
      cats: { valuation: 90, fundamentals: 70 },
    });
    const scores = computeNormalizedScores(
      [nodata, realBacker, ...low, ...filler],
      undefined,
      INFLECTION_V2_NORMALIZATION,
    );
    const byT = new Map(scores.map((s) => [s.ticker, s]));

    // The artifact is real: NODATA's no-data inflection reads POSITIVE cross-sectionally...
    expect(byT.get("NODATA")!.dimensionZ.inflection ?? 0).toBeGreaterThan(0);
    // ...yet it no longer unlocks the discount reward (no genuinely data-backed backer).
    expect(byT.get("NODATA")!.discountTilt).toBe(0);
    // The name with a real fundamentals backer does earn the discount reward.
    expect(byT.get("REAL")!.discountTilt).toBeGreaterThan(0);
  });

  it("the curated-base profile runs WITHOUT the thesis gate; the catalyst-driven profile soft-gates", () => {
    // A name with no reason to move and nothing behind it: low value/catalyst and
    // low fundamentals/growth, so the catalyst-driven thesis gate demotes it.
    const universe = [
      sig({ ticker: "WEAK", marketCap: 5e9, cats: { catalyst: 10, valuation: 12, fundamentals: 12, growth: 12, news: 50, social: 50 } }),
      ...Array.from({ length: 8 }, (_, i) =>
        sig({ ticker: `OK${i}`, marketCap: 5e9, cats: { catalyst: 60 + i, valuation: 60, fundamentals: 60, growth: 60 } }),
      ),
    ];
    const champ = computeNormalizedScores(universe, undefined, CURATED_BASE_NORMALIZATION);
    const chall = computeNormalizedScores(universe, undefined, CATALYST_DRIVEN_NORMALIZATION);
    const weakChamp = champ.find((s) => s.ticker === "WEAK")!;
    const weakChall = chall.find((s) => s.ticker === "WEAK")!;

    expect(weakChamp.thesisCleared).toBe(true); // curated-base profile never gates
    expect(weakChall.thesisCleared).toBe(false); // catalyst-driven profile soft-gates it
    // Soft-gating demotes the weak name further under the catalyst-driven profile.
    expect(weakChall.opportunityScore).toBeLessThan(weakChamp.opportunityScore);
  });
});
