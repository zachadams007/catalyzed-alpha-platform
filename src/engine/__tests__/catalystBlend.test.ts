import { describe, expect, it } from "vitest";

import {
  CATALYST_DRIVEN_NORMALIZATION,
  computeNormalizedScores,
} from "@/engine/normalizeUniverse";
import { postProcessUniverse } from "@/engine/challenger";
import { CATEGORY_CONFIG } from "@/engine/scoringConfig";
import { selectToday } from "@/feed/feeds";
import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import type {
  CatalystType,
  CongressTrade,
  RawCatalyst,
  ScoreCategoryKey,
  SecActivity,
  StockSignal,
} from "@/types";

/**
 * LANE-D acceptance - the catalyst-driven blend, material-sells-negative,
 * discount focus, and small-cap inclusion. The catalyst-driven algorithm is now
 * the PROMOTED live Champion, so these exercise the `champion` variant /
 * {@link CATALYST_DRIVEN_NORMALIZATION} profile; the curated-base shadow runs the
 * challenger. Each test maps to a binding acceptance criterion (a)–(f). Builds
 * full-enough StockSignal fixtures (catalyst / news / congress / SEC fields the
 * tilts read) and ranks them through the real normalization.
 */

const ALL_KEYS: ScoreCategoryKey[] = CATEGORY_CONFIG.map((c) => c.key);

interface Over {
  ticker: string;
  marketCap?: number;
  sector?: string;
  riskPenalty?: number;
  cats?: Partial<Record<ScoreCategoryKey, number>>;
  catalyst?: RawCatalyst;
  catalystLive?: boolean;
  news?: { count7d: number; freshnessHours: number };
  congressTrades?: CongressTrade[];
  secActivity?: Partial<SecActivity>;
  /** Avg daily $ volume; defaults to a comfortably-fillable $50M so the feed-layer
   *  fillability floor (selectToday/Weekly) is inert on these scoring fixtures. */
  avgDollarVolume?: number;
}

function cat(magnitude: number, daysAway: number, type: CatalystType = "Earnings"): RawCatalyst {
  return { type, description: `${type} catalyst`, daysAway, magnitude };
}

function mk(o: Over): StockSignal {
  const categories = ALL_KEYS.map((key) => ({
    key,
    label: key,
    score: o.cats?.[key] ?? 50,
    weight: 0,
    contribution: 0,
    explanation: "",
  }));
  const s: Record<string, unknown> = {
    ticker: o.ticker,
    name: o.ticker,
    sector: o.sector ?? "Technology",
    marketCap: o.marketCap ?? 1_000_000_000,
    score: {
      opportunityScore: 0,
      confidence: 70,
      confidenceExplanation: "",
      riskPenalty: o.riskPenalty ?? 0,
      riskExplanation: "",
      categories,
    },
    news: o.news
      ? { items: [], sentiment: 0, count7d: o.news.count7d, freshnessHours: o.news.freshnessHours }
      : { items: [], sentiment: 0, count7d: 3, freshnessHours: 30 },
    // Fillable by default ($50M/day, below the $1B effLarge cohort threshold) so the
    // feed-layer fillability floor doesn't accidentally drop a scoring fixture.
    liquidity: { avgDollarVolume: o.avgDollarVolume ?? 50_000_000 },
  };
  if (o.catalyst) s.catalyst = o.catalyst;
  if (o.catalystLive !== undefined) s.catalystLive = o.catalystLive;
  if (o.congressTrades) s.congressTrades = o.congressTrades;
  if (o.secActivity) {
    s.secActivity = { cik: "0000000000", form4Count90d: 0, eightKCount90d: 0, filings: [], ...o.secActivity };
  }
  return s as unknown as StockSignal;
}

/** Filler names that give the universe a cross-sectional spread to rank against. */
function filler(n: number): StockSignal[] {
  return Array.from({ length: n }, (_, i) =>
    mk({
      ticker: `F${i}`,
      sector: i % 2 === 0 ? "Industrials" : "Healthcare",
      marketCap: 10 ** (9 + (i / Math.max(1, n - 1)) * 2),
      cats: {
        valuation: 40 + (i % 5) * 6,
        momentum: 45 + (i % 4) * 8,
        catalyst: 45 + (i % 3) * 5,
        fundamentals: 48 + (i % 4) * 4,
        growth: 47 + (i % 3) * 6,
        news: 45 + (i % 4) * 6,
      },
    }),
  );
}

function catalystDrivenScore(universe: StockSignal[]): Map<string, number> {
  const scored = computeNormalizedScores(universe, undefined, CATALYST_DRIVEN_NORMALIZATION);
  return new Map(scored.map((s) => [s.ticker, s.opportunityScore]));
}

type Bucket = "mega" | "large" | "mid" | "small";
function bucketOf(marketCap: number): Bucket {
  if (marketCap >= 200e9) return "mega";
  if (marketCap >= 10e9) return "large";
  if (marketCap >= 2e9) return "mid";
  return "small";
}

// ---------------------------------------------------------------------------
// (a) discounted + thesis intact outranks an identical name that already ran up
// ---------------------------------------------------------------------------
describe("(a) discount focus — discounted+thesis beats 'already ran up'", () => {
  it("ranks the discounted entry above the chased-highs twin", () => {
    const discounted = mk({
      ticker: "DISCOUNT",
      cats: { valuation: 85, momentum: 45, catalyst: 60, fundamentals: 62, growth: 58, news: 55 },
    });
    // Same name, but it has already run: near its highs (low valuation score) with
    // momentum running hot - nothing else changed, just more expensive (the HOOD case).
    const ranUp = mk({
      ticker: "RANUP",
      cats: { valuation: 25, momentum: 88, catalyst: 60, fundamentals: 62, growth: 58, news: 55 },
    });
    const universe = [discounted, ranUp, ...filler(8)];
    const score = catalystDrivenScore(universe);
    expect(score.get("DISCOUNT")!).toBeGreaterThan(score.get("RANUP")!);
  });
});

// ---------------------------------------------------------------------------
// (b) a small-cap with a real catalyst CAN appear in Today's top set
// ---------------------------------------------------------------------------
describe("(b) small-cap inclusion — a catalyzed small-cap reaches Today", () => {
  it("surfaces the small-cap with a strong fresh catalyst into the top 8", () => {
    const megas = Array.from({ length: 6 }, (_, i) =>
      mk({
        ticker: `MEGA${i}`,
        sector: ["Technology", "Financials", "Energy", "Industrials", "Healthcare", "Utilities"][i]!,
        marketCap: 5e11,
        cats: { news: 92, social: 92, liquidity: 92, catalyst: 32, valuation: 45, momentum: 60 },
      }),
    );
    const small = mk({
      ticker: "SMALLCAP",
      sector: "Materials",
      marketCap: 3e8,
      cats: { news: 30, social: 30, liquidity: 30, catalyst: 82, valuation: 70, momentum: 55, fundamentals: 55, growth: 55 },
      catalyst: cat(0.9, 3, "Clinical"),
      catalystLive: true,
      news: { count7d: 10, freshnessHours: 5 },
    });
    const universe = [...megas, small, ...filler(4)];
    const championToday = selectToday(postProcessUniverse(universe, "champion"));
    expect(championToday.map((s) => s.ticker)).toContain("SMALLCAP");
  });
});

// ---------------------------------------------------------------------------
// (c) Today's top set stays cap-balanced (not mega-cap heavy)
// ---------------------------------------------------------------------------
describe("(c) cap balance — Today stays a small/mid/large mix", () => {
  it("keeps mega-caps from dominating the live champion's Today set", () => {
    const universe = Array.from({ length: 18 }, (_, i) => {
      const t = i / 17;
      const logCap = 8.4 + t * 4.0; // ~2.5e8 (small) .. ~2.5e12 (mega)
      const coverage = 18 + t * 76; // coverage scales WITH size
      return mk({
        ticker: `C${i}`,
        sector: ["Technology", "Healthcare", "Industrials", "Energy", "Financials", "Materials"][i % 6]!,
        marketCap: 10 ** logCap,
        cats: {
          news: coverage,
          social: coverage,
          liquidity: coverage,
          catalyst: 80 - t * 40, // opportunities skew smaller
          valuation: 80 - t * 35,
          momentum: 50,
          fundamentals: 55,
          growth: 55,
        },
        catalyst: cat(0.5 + (1 - t) * 0.4, 5),
        catalystLive: true,
      });
    });
    const today = selectToday(postProcessUniverse(universe, "champion"), 8);
    const counts = today.reduce(
      (acc, s) => {
        acc[bucketOf(s.marketCap)] += 1;
        return acc;
      },
      { mega: 0, large: 0, mid: 0, small: 0 } as Record<Bucket, number>,
    );
    expect(counts.mega).toBeLessThanOrEqual(3);
    expect(counts.small + counts.mid).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// (d) a STRONG, EARLY catalyst (any type) outranks an identical name with
//     none / a stale one
// ---------------------------------------------------------------------------
describe("(d) catalyst strength — strong+early beats none/stale", () => {
  it("lifts the freshly-catalyzed name above its catalyst-less and stale twins", () => {
    const baseCats = { valuation: 55, momentum: 55, catalyst: 60, fundamentals: 58, growth: 56, news: 55 };
    const fresh = mk({
      ticker: "FRESH",
      cats: baseCats,
      catalyst: cat(0.9, 2, "M&A"),
      catalystLive: true,
      news: { count7d: 10, freshnessHours: 4 },
    });
    const stale = mk({
      ticker: "STALE",
      cats: baseCats,
      catalyst: cat(0.9, -120, "M&A"),
      catalystLive: false,
      news: { count7d: 1, freshnessHours: 90 },
    });
    const none = mk({ ticker: "NONE", cats: baseCats });
    const universe = [fresh, stale, none, ...filler(7)];
    const score = catalystDrivenScore(universe);
    expect(score.get("FRESH")!).toBeGreaterThan(score.get("STALE")!);
    expect(score.get("FRESH")!).toBeGreaterThan(score.get("NONE")!);
  });
});

// ---------------------------------------------------------------------------
// (e) MATERIAL selling by a major insider lowers a score; a SMALL routine
//     insider sale does NOT
// ---------------------------------------------------------------------------
describe("(e) material sells negative — with a noise filter", () => {
  it("drops the materially-sold name but leaves a small routine sale untouched", () => {
    const baseCats = { valuation: 55, momentum: 55, catalyst: 55, fundamentals: 55, growth: 55 };
    const material = mk({ ticker: "MATERIAL", cats: baseCats, secActivity: { form4NetBuyValue90d: -5_000_000 } });
    const smallSale = mk({ ticker: "SMALLSALE", cats: baseCats, secActivity: { form4NetBuyValue90d: -20_000 } });
    const base = mk({ ticker: "BASE", cats: baseCats });
    const universe = [material, smallSale, base, ...filler(6)];
    const score = catalystDrivenScore(universe);
    // The material seller is penalized vs the identical no-sell name…
    expect(score.get("MATERIAL")!).toBeLessThan(score.get("BASE")!);
    // …while the small routine sale is treated as noise (no score change).
    expect(score.get("SMALLSALE")!).toBe(score.get("BASE")!);
  });
});

// ---------------------------------------------------------------------------
// (f) a strong-fundamentals name with NO catalyst is NOT pushed out
// ---------------------------------------------------------------------------
describe("(f) no gate — quality without a catalyst is not penalized", () => {
  it("keeps a discounted, high-quality, catalyst-less name in Today and never penalizes it", () => {
    const quality = mk({
      ticker: "QUALITY",
      marketCap: 8e9,
      cats: { fundamentals: 92, growth: 90, valuation: 76, momentum: 55, catalyst: 40, news: 45, social: 40, volatility: 50, liquidity: 60 },
      // No catalyst object on purpose - quality is its own valid path.
    });
    // A field of catalyzed-but-mediocre names it must coexist with.
    const catalyzed = Array.from({ length: 8 }, (_, i) =>
      mk({
        ticker: `CAT${i}`,
        sector: ["Technology", "Healthcare", "Energy", "Industrials"][i % 4]!,
        marketCap: 10 ** (9 + (i / 7) * 2),
        cats: { catalyst: 70 + i, valuation: 50, momentum: 60, fundamentals: 48, growth: 48, news: 60 },
        catalyst: cat(0.7, 5),
        catalystLive: true,
        news: { count7d: 7, freshnessHours: 10 },
      }),
    );
    const universe = [quality, ...catalyzed, ...filler(3)];

    const scored = computeNormalizedScores(universe, undefined, CATALYST_DRIVEN_NORMALIZATION);
    const q = scored.find((s) => s.ticker === "QUALITY")!;
    // The catalyst mechanism only ever ADDS - a catalyst-less name gets exactly 0,
    // never a penalty.
    expect(q.catalystTilt).toBe(0);

    const today = selectToday(postProcessUniverse(universe, "champion"), 8);
    expect(today.map((s) => s.ticker)).toContain("QUALITY");
  });
});

// ---------------------------------------------------------------------------
// Before/after Today top-8 (champion vs challenger) on the real sample universe.
// ---------------------------------------------------------------------------
describe("LANE-D demo — curated-base shadow (before) vs catalyst-driven champion (after) Today top-8", () => {
  it("prints the Today top-8 diff and the catalyst leads the live champion surfaces", () => {
    const GENERATED_AT = "2026-06-18T16:00:00.000Z";
    const scored = MOCK_UNIVERSE.map((c) => toStockSignal(c, scoreCompany(c), GENERATED_AT));

    // The catalyst-driven algorithm is the live champion now; the curated base is
    // the shadow challenger. "before" = shadow (challenger), "after" = live (champion).
    const shadowToday = selectToday(postProcessUniverse(scored, "challenger"));
    const championToday = selectToday(postProcessUniverse(scored, "champion"));
    const shadowTickers = shadowToday.map((s) => s.ticker);
    const champTickers = championToday.map((s) => s.ticker);

    // The catalyst that drives each live champion pick, surfaced (not silently weighted).
    const leads = computeNormalizedScores(scored, undefined, CATALYST_DRIVEN_NORMALIZATION);
    const leadByTicker = new Map(leads.map((s) => [s.ticker, s.catalystLead]));
    const fmtCap = (mc: number) => bucketOf(mc);
    const capMix = (signals: StockSignal[]) => {
      const c = signals.reduce(
        (acc, s) => {
          acc[bucketOf(s.marketCap)] += 1;
          return acc;
        },
        { mega: 0, large: 0, mid: 0, small: 0 } as Record<Bucket, number>,
      );
      return `mega ${c.mega} · large ${c.large} · mid ${c.mid} · small ${c.small}`;
    };
    const changed = champTickers.filter((t) => !shadowTickers.includes(t)).length;

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "── LANE D: catalyst-driven blend + discount + small-cap + sells-negative ──",
        `universe: ${scored.length} names`,
        "",
        `Today (top 8) cap mix`,
        `  curated-base shadow (before) : ${capMix(shadowToday)}`,
        `  catalyst-driven champion (after / live) : ${capMix(championToday)}`,
        "",
        `Today shadow (before)   : ${shadowTickers.join(", ")}`,
        `Today champion (after)  : ${champTickers.join(", ")}`,
        `→ ${changed}/8 names changed`,
        "",
        "Live champion top-8 — the catalyst driving each pick:",
        ...championToday.map((s) => {
          const lead = leadByTicker.get(s.ticker) || "(no lead catalyst — quality/value path)";
          return `  ${s.ticker.padEnd(7)} ${fmtCap(s.marketCap).padEnd(6)} ${lead}`;
        }),
        "──────────────────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );

    // The two models rank the identical universe differently (a promotion is real).
    expect(champTickers.join()).not.toBe(shadowTickers.join());
    // The live champion's Today is not a wall of mega-caps.
    const champMega = championToday.filter((s) => bucketOf(s.marketCap) === "mega").length;
    expect(champMega).toBeLessThanOrEqual(3);
  });
});
