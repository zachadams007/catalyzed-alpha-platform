import { describe, expect, it } from "vitest";
import type { StockSignal } from "@/types";
import {
  buildHeatTiles,
  groupBySector,
  heatStats,
  hypeDomain,
  resolveMarketCap,
} from "@/components/heatmap/heatmapModel";
import { MARKET_MAJORS } from "@/data/symbols/majors.generated";

/** Minimal signal shape for what the heatmap model reads. */
function sig(over: {
  ticker: string;
  sector: string;
  marketCap: number;
  opportunity?: number;
  dayChange?: number;
  hype?: number;
}): StockSignal {
  return {
    ticker: over.ticker,
    name: `${over.ticker} Inc`,
    sector: over.sector,
    marketCap: over.marketCap,
    dayChange: over.dayChange ?? 0.01,
    score: { opportunityScore: over.opportunity ?? 60 },
    hype: { score: over.hype ?? 50, tier: "Warming" },
  } as unknown as StockSignal;
}

describe("buildHeatTiles", () => {
  it("drops names without a positive market cap", () => {
    const tiles = buildHeatTiles([
      sig({ ticker: "AAA", sector: "Technology", marketCap: 100 }),
      sig({ ticker: "BBB", sector: "Technology", marketCap: 0 }),
      sig({ ticker: "CCC", sector: "Technology", marketCap: NaN }),
    ]);
    expect(tiles.map((t) => t.ticker)).toEqual(["AAA"]);
  });

  it("drops absurd, impossible market caps (the $24.95T garbage-tile bug)", () => {
    const tiles = buildHeatTiles([
      // NNE's real cap is a few billion; a synthetic/units-bug value of $24.95T
      // must never render - it would dominate the treemap as a giant fake tile.
      sig({ ticker: "NNE", sector: "Energy", marketCap: 24.95e12 }),
      sig({ ticker: "AAPL", sector: "Technology", marketCap: 3.2e12 }),
      sig({ ticker: "REAL", sector: "Energy", marketCap: 3.4e9 }),
    ]);
    expect(tiles.map((t) => t.ticker)).toEqual(["AAPL", "REAL"]);
  });

  it("drops an UN-ROSTERED name claiming a megacap cap (LCID $2.65T stale-cache bug)", () => {
    // Lucid is a ~$6B small-cap; a cached $2.65T value is fabricated. It is under
    // the $5T hard bound but is NOT a real top-200 company, so it must be dropped
    // rather than render as a fake megacap tile next to AAPL.
    const tiles = buildHeatTiles([
      sig({ ticker: "LCID", sector: "Consumer", marketCap: 2.65e12 }),
      sig({ ticker: "ASX", sector: "Technology", marketCap: 2.61e12 }),
      sig({ ticker: "AAPL", sector: "Technology", marketCap: 4.3e12 }),
    ]);
    expect(tiles.map((t) => t.ticker)).toEqual(["AAPL"]);
  });

  it("CORRECTS a rostered name's garbage cap to its trusted real cap (Barrick 'B' $11T)", () => {
    const barrick = MARKET_MAJORS.find((m) => m.ticker === "B")!;
    const [t] = buildHeatTiles([
      // Cached "B" (Barrick Mining) at a fabricated $11.03T → rendered at its real cap.
      sig({ ticker: "B", sector: "Materials", marketCap: 11.03e12 }),
    ]);
    expect(t!.ticker).toBe("B");
    expect(t!.marketCap).toBe(barrick.marketCap);
    expect(t!.marketCap).toBeLessThan(5e12);
  });

  it("coerces non-finite metrics to finite (NaN slips past ??)", () => {
    const [t] = buildHeatTiles([
      sig({ ticker: "ZZZ", sector: "Energy", marketCap: 50, opportunity: NaN, dayChange: NaN, hype: NaN }),
    ]);
    expect(Number.isFinite(t!.opportunity)).toBe(true);
    expect(Number.isFinite(t!.dayChange)).toBe(true);
    expect(Number.isFinite(t!.hype)).toBe(true);
  });

  it("prefers a live day-change overlay when finite", () => {
    const [t] = buildHeatTiles([sig({ ticker: "LIV", sector: "Energy", marketCap: 50, dayChange: 0.02 })], {
      LIV: -0.04,
    });
    expect(t!.dayChange).toBeCloseTo(-0.04, 6);
  });
});

describe("resolveMarketCap", () => {
  it("falls back to the trusted roster cap for a real megacap when the input is garbage", () => {
    const aapl = MARKET_MAJORS.find((m) => m.ticker === "AAPL")!;
    expect(resolveMarketCap("AAPL", 24.95e12)).toBe(aapl.marketCap); // >$5T garbage → trusted
    expect(resolveMarketCap("aapl", 0)).toBe(aapl.marketCap); // case-insensitive, ignores 0
  });

  it("prefers a plausible LIVE cap over the dated trusted cap for a roster name", () => {
    // A real mega-cap should track the live market - the trusted value is only a
    // fallback for when the provider cap is missing/garbage.
    expect(resolveMarketCap("AAPL", 4.4e12)).toBe(4.4e12);
  });

  it("keeps a sane sub-floor cap for an un-rostered small/mid name", () => {
    expect(resolveMarketCap("ZZZ", 3.4e9)).toBe(3.4e9);
    expect(resolveMarketCap("ZZZ", 49e9)).toBe(49e9); // just under the $50B floor
  });

  it("drops an un-rostered name that claims a megacap-tier cap", () => {
    expect(resolveMarketCap("LCID", 2.65e12)).toBeNull();
    expect(resolveMarketCap("NNE", 24.95e12)).toBeNull();
    expect(resolveMarketCap("ZZZ", 50e9)).toBeNull(); // at the floor → not trusted
  });

  it("drops a non-finite / non-positive cap for an un-rostered name", () => {
    expect(resolveMarketCap("ZZZ", 0)).toBeNull();
    expect(resolveMarketCap("ZZZ", NaN)).toBeNull();
    expect(resolveMarketCap("ZZZ", -5)).toBeNull();
  });

  it("treats SPCX (SpaceX) as a real public mega-cap, NOT private — trusted ~$2.44T fallback", () => {
    // SpaceX IPO'd on NASDAQ (2026-06-12); it's a top US mega-cap (~$2.44T, ~$185/sh).
    // Seeded as a trusted supplement so the "drop un-rostered megacap" gate never
    // throws it away. The dated trusted value backs a missing/garbage provider cap.
    expect(resolveMarketCap("SPCX", 0)).toBe(2.44e12); // garbage input → trusted fallback
    expect(resolveMarketCap("spcx", NaN)).toBe(2.44e12); // case-insensitive
    expect(resolveMarketCap("SPCX", 24.95e12)).toBe(2.44e12); // >$5T garbage → trusted
    // It is a multi-$T mega-cap now - NOT the old bogus "private $400B" sizing.
    expect(resolveMarketCap("SPCX", 0)!).toBeGreaterThan(2e12);
  });

  it("prefers SPCX's plausible LIVE cap over the dated trusted fallback", () => {
    // When the live provider cap is sane it wins, so SPCX tracks the real market.
    expect(resolveMarketCap("SPCX", 2.5e12)).toBe(2.5e12);
  });

  it("still DROPS a non-rostered name claiming a megacap pseudo-cap", () => {
    expect(resolveMarketCap("LCID", 2.65e12)).toBeNull();
    expect(resolveMarketCap("NNE", 24.95e12)).toBeNull();
  });

  it("ranks SPCX among the largest tiles while NVDA stays largest, NNE/LCID dropped", () => {
    const tiles = buildHeatTiles([
      sig({ ticker: "NVDA", sector: "Technology", marketCap: 4.95e12 }),
      sig({ ticker: "AAPL", sector: "Technology", marketCap: 4.3e12 }),
      sig({ ticker: "SPCX", sector: "Industrials", marketCap: 2.44e12 }),
      sig({ ticker: "NNE", sector: "Energy", marketCap: 24.95e12 }), // garbage → dropped
      sig({ ticker: "LCID", sector: "Consumer", marketCap: 2.65e12 }), // un-rostered megacap lie → dropped
      sig({ ticker: "SMALL", sector: "Energy", marketCap: 3e9 }),
    ]);
    const spx = tiles.find((t) => t.ticker === "SPCX")!;
    expect(spx).toBeDefined();
    expect(spx.marketCap).toBe(2.44e12);
    expect(spx.name).toBe("SPCX Inc"); // ordinary signal name, no "private" relabel
    // NNE and LCID are gone; SPCX is among the top three by cap, NVDA on top.
    const byCap = [...tiles].sort((a, b) => b.marketCap - a.marketCap).map((t) => t.ticker);
    expect(byCap[0]).toBe("NVDA");
    expect(byCap.slice(0, 3)).toContain("SPCX");
    expect(tiles.some((t) => t.ticker === "NNE")).toBe(false);
    expect(tiles.some((t) => t.ticker === "LCID")).toBe(false);
  });
});

describe("groupBySector", () => {
  it("groups by sector, orders sectors by total cap, items by cap desc", () => {
    const groups = groupBySector(
      buildHeatTiles([
        sig({ ticker: "T1", sector: "Technology", marketCap: 300 }),
        sig({ ticker: "T2", sector: "Technology", marketCap: 100 }),
        sig({ ticker: "E1", sector: "Energy", marketCap: 50 }),
      ]),
    );
    expect(groups.map((g) => g.key)).toEqual(["Technology", "Energy"]);
    expect(groups[0]!.items.map((i) => i.ticker)).toEqual(["T1", "T2"]);
  });
});

describe("heatStats", () => {
  it("counts companies, sectors and advancer/decliner breadth", () => {
    const stats = heatStats(
      buildHeatTiles([
        sig({ ticker: "A", sector: "Technology", marketCap: 100, dayChange: 0.02 }),
        sig({ ticker: "B", sector: "Energy", marketCap: 100, dayChange: -0.02 }),
      ]),
    );
    expect(stats.companies).toBe(2);
    expect(stats.sectors).toBe(2);
    expect(stats.advancers).toBe(1);
    expect(stats.decliners).toBe(1);
    expect(stats.advancersShare).toBeCloseTo(0.5, 6);
  });

  it("cap-weights the market move and nets the dollar cap change by weight", () => {
    // Big winner dominates the cap-weighted move over an equal-count small loser.
    // Caps are billions-scale (clears the "flat" floor) but BELOW the megacap
    // trust floor and un-rostered, so they pass through untouched for the math.
    const stats = heatStats(
      buildHeatTiles([
        sig({ ticker: "BIGG", sector: "Technology", marketCap: 9e9, dayChange: 0.1 }),
        sig({ ticker: "SMLL", sector: "Energy", marketCap: 1e9, dayChange: -0.1 }),
      ]),
    );
    // (9*0.1 + 1*-0.1) / 10 = +0.08
    expect(stats.capWeightedMove).toBeCloseTo(0.08, 6);
    // Equal-weighted average is flat (+0.1 and -0.1).
    expect(stats.avgMove).toBeCloseTo(0, 6);
    // Net dollar cap change is positive (the winner is far larger).
    expect(stats.capChangeAbs).toBeGreaterThan(0);
    expect(stats.capChangeLabel.startsWith("+")).toBe(true);
  });

  it("picks the biggest absolute mover and the hottest sector", () => {
    const stats = heatStats(
      buildHeatTiles([
        sig({ ticker: "CALM", sector: "Technology", marketCap: 100, dayChange: 0.01 }),
        sig({ ticker: "WILD", sector: "Energy", marketCap: 50, dayChange: -0.2 }),
        sig({ ticker: "HOT", sector: "Healthcare", marketCap: 80, dayChange: 0.15 }),
      ]),
    );
    expect(stats.biggestMover?.ticker).toBe("WILD");
    expect(Math.abs(stats.biggestMover!.dayChange)).toBeCloseTo(0.2, 6);
    expect(stats.hottestSector?.sector).toBe("Healthcare");
    expect(stats.hottestSector!.move).toBeCloseTo(0.15, 6);
  });

  it("labels a flat market and empty universe honestly", () => {
    expect(heatStats([]).capChangeLabel).toBe("flat");
    const flat = heatStats(
      buildHeatTiles([sig({ ticker: "X", sector: "Energy", marketCap: 100, dayChange: 0 })]),
    );
    expect(flat.advancers).toBe(0);
    expect(flat.decliners).toBe(0);
    expect(flat.unchanged).toBe(1);
    expect(flat.advancersShare).toBe(0);
  });
});

describe("hypeDomain", () => {
  it("spans roughly the observed spread (robust to the tails)", () => {
    const tiles = buildHeatTiles(
      Array.from({ length: 20 }, (_, i) =>
        sig({ ticker: `H${i}`, sector: "Technology", marketCap: 100, hype: i * 5 }),
      ),
    );
    const { lo, hi } = hypeDomain(tiles);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(100);
  });

  it("widens a near-constant field to a minimum spread (no exploded contrast)", () => {
    const tiles = buildHeatTiles(
      Array.from({ length: 10 }, (_, i) =>
        sig({ ticker: `C${i}`, sector: "Energy", marketCap: 100, hype: 50 }),
      ),
    );
    const { lo, hi } = hypeDomain(tiles);
    expect(hi - lo).toBeGreaterThanOrEqual(16 - 1e-9);
    expect((lo + hi) / 2).toBeCloseTo(50, 6);
  });

  it("falls back to the full range with no tiles", () => {
    expect(hypeDomain([])).toEqual({ lo: 0, hi: 100 });
  });
});
