import { describe, expect, it } from "vitest";

import {
  blendDiscoveryModes,
  getDiscoveryContext,
  modeScore,
  setDiscoveryContext,
  type DiscoveryContext,
} from "@/data/funnel/modes";
import type { ScreenerCandidate } from "@/data/funnel/prefilter";

function cand(over: Partial<ScreenerCandidate> & { symbol: string }): ScreenerCandidate {
  return {
    price: 25,
    marketCap: 2_000_000_000,
    dollarVolume: 50_000_000,
    beta: 1.3,
    sector: "Technology",
    ...over,
  };
}

describe("modeScore", () => {
  it("overlooked favors small + moving over large", () => {
    const small = cand({ symbol: "S", beta: 1.6 });
    expect(modeScore(small, "overlooked", 0.1, {})).toBeGreaterThan(
      modeScore(small, "overlooked", 0.95, {}),
    );
  });

  it("learn_winners is neutral with no profile, and boosts favored sectors", () => {
    expect(modeScore(cand({ symbol: "X" }), "learn_winners", 0.5, {})).toBe(50);
    const ctx: DiscoveryContext = { favoredSectors: new Set(["Technology"]) };
    expect(modeScore(cand({ symbol: "T", sector: "Technology" }), "learn_winners", 0.5, ctx)).toBe(
      80,
    );
    expect(modeScore(cand({ symbol: "E", sector: "Energy" }), "learn_winners", 0.5, ctx)).toBe(45);
  });

  it("learn_winners adds a peer bonus for held tickers", () => {
    const ctx: DiscoveryContext = {
      favoredSectors: new Set(["Technology"]),
      heldTickers: new Set(["T"]),
    };
    expect(modeScore(cand({ symbol: "T" }), "learn_winners", 0.5, ctx)).toBe(100);
  });

  it("hunt_themes is neutral when empty and boosts members", () => {
    expect(modeScore(cand({ symbol: "X" }), "hunt_themes", 0.5, {})).toBe(50);
    const ctx: DiscoveryContext = { themeTickers: new Set(["AAA"]) };
    expect(modeScore(cand({ symbol: "AAA" }), "hunt_themes", 0.5, ctx)).toBe(92);
    expect(modeScore(cand({ symbol: "BBB" }), "hunt_themes", 0.5, ctx)).toBe(42);
  });
});

describe("blendDiscoveryModes", () => {
  it("returns [] for an empty pool", () => {
    expect(blendDiscoveryModes([], 10)).toEqual([]);
  });

  it("slices to top-N deterministically with a stable tiebreak", () => {
    const pool = Array.from({ length: 8 }, (_, i) =>
      cand({ symbol: `T${i}`, marketCap: (i + 1) * 1e9 }),
    );
    const a = blendDiscoveryModes(pool, 4, {});
    const b = blendDiscoveryModes([...pool].reverse(), 4, {});
    expect(a.length).toBe(4);
    expect(a.map((c) => c.symbol)).toEqual(b.map((c) => c.symbol));
  });

  it("lifts a theme member above an otherwise-identical non-member", () => {
    const pool = [
      cand({ symbol: "PLAIN", marketCap: 3e9 }),
      cand({ symbol: "THEME", marketCap: 3e9 }),
    ];
    const ctx: DiscoveryContext = { themeTickers: new Set(["THEME"]) };
    const ranked = blendDiscoveryModes(pool, 2, ctx).map((c) => c.symbol);
    expect(ranked.indexOf("THEME")).toBeLessThan(ranked.indexOf("PLAIN"));
  });

  it("keeps coverage: a liquid name still surfaces under the wide_net floor", () => {
    const pool = [
      cand({ symbol: "LIQUID", marketCap: 5e9, dollarVolume: 500_000_000, sector: "Energy" }),
      cand({ symbol: "THEME", marketCap: 5e9, dollarVolume: 2_000_000, sector: "Technology" }),
    ];
    // Even with a theme + favored-sector tilt toward THEME, the highly liquid
    // name is not dropped from a 2-slot pool (wide_net is the floor).
    const ctx: DiscoveryContext = {
      themeTickers: new Set(["THEME"]),
      favoredSectors: new Set(["Technology"]),
    };
    const ranked = blendDiscoveryModes(pool, 2, ctx).map((c) => c.symbol);
    expect(ranked).toContain("LIQUID");
  });
});

describe("blendDiscoveryModes — guaranteeTopCap", () => {
  it("guarantees a huge-cap name the anti-megacap tilt would otherwise slice out", () => {
    // MEGA: $2.5T, otherwise unremarkable (same liquidity/beta as the field). The
    // size tilt drops it to the bottom of the blend - the SPCX failure mode.
    const mega = cand({ symbol: "MEGA", marketCap: 2_500_000_000_000 });
    const field = Array.from({ length: 8 }, (_, i) =>
      cand({ symbol: `S${i}`, marketCap: 1_000_000_000 + i * 100_000_000 }),
    );
    const pool = [mega, ...field];
    // Without a guarantee, MEGA is sliced from a 4-slot pool.
    expect(blendDiscoveryModes(pool, 4, {}).map((c) => c.symbol)).not.toContain("MEGA");
    // With the top-1-by-cap guarantee, MEGA survives - and leads.
    const guarded = blendDiscoveryModes(pool, 4, {}, undefined, 1).map((c) => c.symbol);
    expect(guarded).toContain("MEGA");
    expect(guarded[0]).toBe("MEGA");
    expect(guarded.length).toBe(4);
  });

  it("never duplicates a guaranteed name that also ranks well on the blend", () => {
    const pool = [
      cand({ symbol: "BIG", marketCap: 3e12, dollarVolume: 900_000_000 }),
      cand({ symbol: "MID", marketCap: 5e9 }),
      cand({ symbol: "SMALL", marketCap: 1e9 }),
    ];
    const out = blendDiscoveryModes(pool, 3, {}, undefined, 1).map((c) => c.symbol);
    expect(new Set(out).size).toBe(out.length);
    expect(out).toContain("BIG");
  });

  it("clamps the guarantee to topN and stays deterministic across input order", () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      cand({ symbol: `T${i}`, marketCap: (i + 1) * 1e11 }),
    );
    const a = blendDiscoveryModes(pool, 3, {}, undefined, 99); // k clamped to 3
    const b = blendDiscoveryModes([...pool].reverse(), 3, {}, undefined, 99);
    expect(a.length).toBe(3);
    expect(a.map((c) => c.symbol)).toEqual(b.map((c) => c.symbol));
    // k >= topN → the three biggest caps fill every slot, cap-desc.
    expect(a.map((c) => c.symbol)).toEqual(["T5", "T4", "T3"]);
  });

  it("guaranteeTopCap=0 is identical to the un-guarded blend (back-compat)", () => {
    const pool = Array.from({ length: 8 }, (_, i) =>
      cand({ symbol: `T${i}`, marketCap: (i + 1) * 1e9 }),
    );
    const plain = blendDiscoveryModes(pool, 4, {}).map((c) => c.symbol);
    const zero = blendDiscoveryModes(pool, 4, {}, undefined, 0).map((c) => c.symbol);
    expect(zero).toEqual(plain);
  });
});

describe("discovery context mirror", () => {
  it("round-trips and can be cleared", () => {
    setDiscoveryContext({ themeTickers: new Set(["ZZZ"]) });
    expect(getDiscoveryContext().themeTickers?.has("ZZZ")).toBe(true);
    setDiscoveryContext({});
    expect(getDiscoveryContext().themeTickers).toBeUndefined();
  });
});
