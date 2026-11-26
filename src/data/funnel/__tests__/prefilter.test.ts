import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREFILTER_GATES,
  prefilterUniverse,
  type ScreenerCandidate,
} from "@/data/funnel/prefilter";

function cand(over: Partial<ScreenerCandidate> & { symbol: string }): ScreenerCandidate {
  return {
    price: 25,
    marketCap: 2_000_000_000,
    dollarVolume: 50_000_000,
    beta: 1.3,
    ...over,
  };
}

describe("prefilterUniverse — gates", () => {
  it("rejects sub-floor price, dollar volume, and market cap", () => {
    const rows = [
      cand({ symbol: "GOOD" }),
      cand({ symbol: "CHEAP", price: 4 }), // < $5
      cand({ symbol: "THIN", dollarVolume: 500_000 }), // < $1M ADV
      cand({ symbol: "NANO", marketCap: 10_000_000 }), // < $50M cap
    ];
    const result = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 100);
    const symbols = result.passed.map((c) => c.symbol);
    expect(symbols).toContain("GOOD");
    expect(symbols).not.toContain("CHEAP");
    expect(symbols).not.toContain("THIN");
    expect(symbols).not.toContain("NANO");
    expect(result.screenedCount).toBe(4);
    expect(result.passedCount).toBe(1);
    expect(result.selectedCount).toBe(1);
  });

  it("treats the gates as strict floors (equal-to-floor is rejected)", () => {
    const rows = [
      cand({ symbol: "ATPRICE", price: 5 }), // not > 5
      cand({ symbol: "ATVOL", dollarVolume: 1_000_000 }), // not > 1M
      cand({ symbol: "ATCAP", marketCap: 50_000_000 }), // not > 50M
    ];
    const result = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 100);
    expect(result.passedCount).toBe(0);
  });
});

describe("prefilterUniverse — dedupe & slicing", () => {
  it("dedupes by symbol (first occurrence wins, case-insensitive)", () => {
    const rows = [cand({ symbol: "dup", price: 30 }), cand({ symbol: "DUP", price: 99 })];
    const result = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 100);
    expect(result.screenedCount).toBe(1);
    expect(result.passed[0]!.symbol).toBe("DUP");
    expect(result.passed[0]!.price).toBe(30); // first kept
  });

  it("slices to the top-N", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      cand({ symbol: `T${i}`, marketCap: (i + 1) * 1_000_000_000 }),
    );
    const result = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 3);
    expect(result.passedCount).toBe(10);
    expect(result.selectedCount).toBe(3);
    expect(result.passed.length).toBe(3);
  });

  it("returns nothing for topN <= 0 but still reports counts", () => {
    const rows = [cand({ symbol: "A" }), cand({ symbol: "B" })];
    const result = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 0);
    expect(result.selectedCount).toBe(0);
    expect(result.passedCount).toBe(2);
  });
});

describe("prefilterUniverse — anti-megacap composite", () => {
  it("ranks a small-cap above a megacap with identical liquidity & beta", () => {
    const rows = [
      cand({ symbol: "MEGA", marketCap: 800_000_000_000 }),
      cand({ symbol: "SMALL", marketCap: 300_000_000 }),
    ];
    const result = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 100);
    const order = result.passed.map((c) => c.symbol);
    expect(order.indexOf("SMALL")).toBeLessThan(order.indexOf("MEGA"));
  });

  it("rewards higher liquidity at equal size", () => {
    const rows = [
      cand({ symbol: "LOWVOL", dollarVolume: 2_000_000, marketCap: 1_000_000_000 }),
      cand({ symbol: "HIGHVOL", dollarVolume: 400_000_000, marketCap: 1_000_000_000 }),
    ];
    const result = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 100);
    const order = result.passed.map((c) => c.symbol);
    expect(order.indexOf("HIGHVOL")).toBeLessThan(order.indexOf("LOWVOL"));
  });

  it("is deterministic with a stable symbol tiebreak on identical metrics", () => {
    const rows = [
      cand({ symbol: "ZZZ" }),
      cand({ symbol: "AAA" }),
      cand({ symbol: "MMM" }),
    ];
    const a = prefilterUniverse(rows, DEFAULT_PREFILTER_GATES, 100);
    const b = prefilterUniverse([...rows].reverse(), DEFAULT_PREFILTER_GATES, 100);
    expect(a.passed.map((c) => c.symbol)).toEqual(["AAA", "MMM", "ZZZ"]);
    expect(b.passed.map((c) => c.symbol)).toEqual(["AAA", "MMM", "ZZZ"]);
  });
});

describe("prefilterUniverse — edge cases", () => {
  it("handles an empty input", () => {
    const result = prefilterUniverse([], DEFAULT_PREFILTER_GATES, 50);
    expect(result.screenedCount).toBe(0);
    expect(result.passedCount).toBe(0);
    expect(result.selectedCount).toBe(0);
    expect(result.passed).toEqual([]);
  });

  it("uppercases and trims symbols in the output", () => {
    const result = prefilterUniverse([cand({ symbol: "  nvda " })], DEFAULT_PREFILTER_GATES, 5);
    expect(result.passed[0]!.symbol).toBe("NVDA");
  });
});
