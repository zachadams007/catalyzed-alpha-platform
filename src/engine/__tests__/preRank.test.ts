import { describe, expect, it } from "vitest";

import { preRankUniverse } from "@/engine/preRank";
import type { PreRankInput, PreRankConfig } from "@/engine/preRank";

function row(
  ticker: string,
  overrides: Partial<PreRankInput> = {},
): PreRankInput {
  return {
    ticker,
    price: 20,
    prevClose: 19,
    dayChange: 0.05,
    dollarVolume: 5_000_000,
    rangePct: 0.03,
    ...overrides,
  };
}

const BASE_CONFIG: PreRankConfig = { target: 10 };

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------
describe("preRankUniverse — floors", () => {
  it("excludes a row with price below minPrice (default 1.50)", () => {
    const rows = [
      row("CHEAP", { price: 1.0, prevClose: 1.0, dollarVolume: 10_000_000 }),
      row("GOOD", { price: 5, prevClose: 4 }),
    ];
    const result = preRankUniverse(rows, BASE_CONFIG);
    expect(result.tickers).not.toContain("CHEAP");
    expect(result.tickers).toContain("GOOD");
    // gatedCount reflects only floor-passers
    expect(result.gatedCount).toBe(1);
    expect(result.consideredCount).toBe(2);
  });

  it("excludes a row with dollarVolume below minDollarVolume (default 2M)", () => {
    const rows = [
      row("ILLIQUID", { dollarVolume: 500_000 }),
      row("LIQUID"),
    ];
    const result = preRankUniverse(rows, BASE_CONFIG);
    expect(result.tickers).not.toContain("ILLIQUID");
    expect(result.tickers).toContain("LIQUID");
    expect(result.gatedCount).toBe(1);
  });

  it("excludes a row with prevClose <= 0", () => {
    const rows = [
      row("NOPREV", { prevClose: 0 }),
      row("GOOD"),
    ];
    const result = preRankUniverse(rows, BASE_CONFIG);
    expect(result.tickers).not.toContain("NOPREV");
    expect(result.tickers).toContain("GOOD");
  });

  it("excludes a row when price > maxPrice", () => {
    const rows = [
      row("TOOHIGH", { price: 600, prevClose: 590 }),
      row("OK", { price: 50, prevClose: 48 }),
    ];
    const result = preRankUniverse(rows, { target: 10, maxPrice: 100 });
    expect(result.tickers).not.toContain("TOOHIGH");
    expect(result.tickers).toContain("OK");
  });

  it("respects custom minPrice and minDollarVolume from config", () => {
    const rows = [
      row("PASS", { price: 3, dollarVolume: 3_000_000, prevClose: 2.9 }),
      row("FAILPRICE", { price: 1.0, dollarVolume: 3_000_000, prevClose: 0.9 }),
      row("FAILVOL", { price: 5, dollarVolume: 500_000, prevClose: 4.8 }),
    ];
    const result = preRankUniverse(rows, {
      target: 10,
      minPrice: 2,
      minDollarVolume: 1_000_000,
    });
    expect(result.tickers).toContain("PASS");
    expect(result.tickers).not.toContain("FAILPRICE");
    expect(result.tickers).not.toContain("FAILVOL");
  });

  it("exposes the applied floorDollarVolume in the result", () => {
    const result = preRankUniverse([row("A")], {
      target: 5,
      minDollarVolume: 999_000,
    });
    expect(result.floorDollarVolume).toBe(999_000);
  });
});

// ---------------------------------------------------------------------------
// alwaysInclude (seeds)
// ---------------------------------------------------------------------------
describe("preRankUniverse — alwaysInclude seeds", () => {
  it("includes a seeded ticker even when its price fails the floor", () => {
    const rows = [
      row("SUBSEED", { price: 0.5, prevClose: 0.4, dollarVolume: 10_000_000 }),
      row("REGULAR"),
    ];
    const result = preRankUniverse(rows, {
      target: 10,
      alwaysInclude: ["SUBSEED"],
    });
    expect(result.tickers).toContain("SUBSEED");
  });

  it("includes a seeded ticker even when its dollarVolume fails the floor", () => {
    const rows = [
      row("TINYVOLSEED", { dollarVolume: 1_000 }),
      row("REGULAR"),
    ];
    const result = preRankUniverse(rows, {
      target: 10,
      alwaysInclude: ["TINYVOLSEED"],
    });
    expect(result.tickers).toContain("TINYVOLSEED");
  });

  it("seeds appear FIRST in the output order before non-seeded names", () => {
    const rows = [
      row("SEED1"),
      row("SEED2"),
      row("NOTSEED1"),
      row("NOTSEED2"),
    ];
    const result = preRankUniverse(rows, {
      target: 10,
      alwaysInclude: ["SEED1", "SEED2"],
    });
    const seed1Idx = result.tickers.indexOf("SEED1");
    const seed2Idx = result.tickers.indexOf("SEED2");
    const other1Idx = result.tickers.indexOf("NOTSEED1");
    const other2Idx = result.tickers.indexOf("NOTSEED2");
    expect(seed1Idx).toBeLessThan(other1Idx);
    expect(seed1Idx).toBeLessThan(other2Idx);
    expect(seed2Idx).toBeLessThan(other1Idx);
    expect(seed2Idx).toBeLessThan(other2Idx);
  });

  it("a seeded ticker with no matching row is simply absent (cannot fabricate data)", () => {
    const rows = [row("REAL")];
    const result = preRankUniverse(rows, {
      target: 10,
      alwaysInclude: ["GHOST"],
    });
    expect(result.tickers).not.toContain("GHOST");
    expect(result.tickers).toContain("REAL");
  });

  it("seed keys are case-insensitive — lowercase seed matches uppercase row", () => {
    const rows = [row("AAPL")];
    const result = preRankUniverse(rows, {
      target: 10,
      alwaysInclude: ["aapl"],
    });
    expect(result.tickers).toContain("AAPL");
  });

  it("all seeds returned even when they exceed the target", () => {
    // 5 seeds, target = 2 → all 5 still returned
    const seeds = ["S1", "S2", "S3", "S4", "S5"];
    const rows = seeds.map((t) => row(t));
    const result = preRankUniverse(rows, {
      target: 2,
      alwaysInclude: seeds,
    });
    for (const s of seeds) {
      expect(result.tickers).toContain(s);
    }
    expect(result.tickers.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Anti-megacap ranking
// ---------------------------------------------------------------------------
describe("preRankUniverse — anti-megacap ranking", () => {
  it("a high-volatility mid-liquidity name outranks a huge-vol but flat mega-cap", () => {
    // MEGA: massive dollar volume but tiny daily range and no move
    const mega = row("MEGA", {
      price: 350,
      prevClose: 350,
      dayChange: 0.0,
      dollarVolume: 800_000_000, // well above saturation threshold direction
      rangePct: 0.002, // very tight range
    });
    // VOLATILE: moderate liquidity, big daily range, big move
    const volatile = row("VOLATILE", {
      price: 40,
      prevClose: 36,
      dayChange: 0.11,
      dollarVolume: 10_000_000,
      rangePct: 0.18,
    });
    // Add filler rows so we have some percentile spread
    const fillers = Array.from({ length: 8 }, (_, i) =>
      row(`F${i}`, {
        price: 20 + i,
        prevClose: 18 + i,
        dayChange: 0.02 + i * 0.005,
        dollarVolume: 3_000_000 + i * 500_000,
        rangePct: 0.02 + i * 0.005,
      }),
    );
    const result = preRankUniverse([mega, volatile, ...fillers], {
      target: 10,
    });
    const megaIdx = result.tickers.indexOf("MEGA");
    const volatileIdx = result.tickers.indexOf("VOLATILE");
    // VOLATILE should rank above MEGA (lower index = higher rank)
    expect(megaIdx).toBeGreaterThan(volatileIdx);
  });
});

// ---------------------------------------------------------------------------
// market-majors seed guarantee (calm mega-cap survives the volatility prefilter)
// ---------------------------------------------------------------------------
describe("preRankUniverse — market-majors seed guarantee", () => {
  it("a calm mega-cap is sliced out WITHOUT the seed and guaranteed in WITH it", () => {
    // A big, calm name: low range, no move, modest volume - exactly what the
    // volatility-led pre-rank slices out. A field of hot movers outranks it. The
    // majors backbone seed is what keeps a calm $2T name on the map even when cap
    // itself isn't a ranking input. (KO = a real public calm mega-cap; the old
    // SPCX placeholder was misleading - SpaceX is private and excluded.)
    const calm = row("KO", {
      price: 175,
      prevClose: 175,
      dayChange: 0.001,
      rangePct: 0.004,
      dollarVolume: 40_000_000,
    });
    const movers = Array.from({ length: 12 }, (_, i) =>
      row(`HOT${i}`, {
        price: 20 + i,
        dayChange: 0.12 + i * 0.005,
        rangePct: 0.15 + i * 0.005,
        dollarVolume: 8_000_000,
      }),
    );
    const pool = [calm, ...movers];

    // Without seeding, the calm mega-cap loses the volatility race and is cut.
    const without = preRankUniverse(pool, { target: 5 });
    expect(without.tickers).not.toContain("KO");

    // Seeded by the market-majors backbone, it's guaranteed a slot (and leads).
    const seeded = preRankUniverse(pool, { target: 5, alwaysInclude: ["KO"] });
    expect(seeded.tickers).toContain("KO");
    expect(seeded.tickers[0]).toBe("KO");
    expect(seeded.tickers.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// target cap
// ---------------------------------------------------------------------------
describe("preRankUniverse — target cap", () => {
  it("returns exactly target tickers when no seeds and enough candidates", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`T${i}`, { price: 10 + i, dayChange: 0.01 + i * 0.005 }),
    );
    const result = preRankUniverse(rows, { target: 3 });
    expect(result.tickers.length).toBe(3);
  });

  it("returns fewer than target when not enough valid rows exist", () => {
    const rows = [row("ONLY"), row("TWO", { price: 5, prevClose: 4.8 })];
    const result = preRankUniverse(rows, { target: 10 });
    expect(result.tickers.length).toBe(2);
  });

  it("returns 0 tickers for target=0", () => {
    const result = preRankUniverse([row("A"), row("B")], { target: 0 });
    expect(result.tickers.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe("preRankUniverse — determinism", () => {
  it("same input twice yields identical tickers array", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row(`DET${i}`, {
        price: 5 + i * 2,
        dayChange: 0.01 + i * 0.007,
        dollarVolume: 3_000_000 + i * 1_200_000,
        rangePct: 0.02 + i * 0.008,
      }),
    );
    const cfg: PreRankConfig = { target: 7 };
    const r1 = preRankUniverse(rows, cfg);
    const r2 = preRankUniverse(rows, cfg);
    expect(r1.tickers).toEqual(r2.tickers);
  });
});

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------
describe("preRankUniverse — de-duplication", () => {
  it("duplicate ticker rows collapse to one, keeping the higher dollarVolume row", () => {
    const rows = [
      row("DUPL", { dollarVolume: 3_000_000, rangePct: 0.01 }),
      row("DUPL", { dollarVolume: 9_000_000, rangePct: 0.05 }),
      row("OTHER"),
    ];
    const result = preRankUniverse(rows, { target: 10 });
    const duplCount = result.tickers.filter((t) => t === "DUPL").length;
    expect(duplCount).toBe(1);
    expect(result.consideredCount).toBe(2); // de-duped before counting
    // The higher-volume row won (rangePct 0.05)
    const duplRow = result.rows.find((r) => r.ticker === "DUPL");
    expect(duplRow?.dollarVolume).toBe(9_000_000);
  });

  it("case-normalises ticker before de-duplication", () => {
    const rows = [
      row("aapl", { dollarVolume: 4_000_000 }),
      row("AAPL", { dollarVolume: 8_000_000 }),
    ];
    const result = preRankUniverse(rows, { target: 10 });
    const aaplCount = result.tickers.filter((t) => t === "AAPL").length;
    expect(aaplCount).toBe(1);
  });

  it("rows with invalid price (0 or NaN) are excluded from consideredCount", () => {
    const rows = [
      row("GOOD"),
      row("BADPRICE", { price: 0 }),
      row("NANPRICE", { price: NaN }),
    ];
    const result = preRankUniverse(rows, { target: 10 });
    expect(result.consideredCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rows shape
// ---------------------------------------------------------------------------
describe("preRankUniverse — rows shape", () => {
  it("each row in result.rows has a numeric score in [0,1]", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`R${i}`));
    const result = preRankUniverse(rows, { target: 5 });
    for (const r of result.rows) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("seeded rows have seeded=true; non-seeded rows have seeded=false", () => {
    const rows = [row("SEED"), row("NOSEED")];
    const result = preRankUniverse(rows, {
      target: 10,
      alwaysInclude: ["SEED"],
    });
    const seedRow = result.rows.find((r) => r.ticker === "SEED");
    const noseedRow = result.rows.find((r) => r.ticker === "NOSEED");
    expect(seedRow?.seeded).toBe(true);
    expect(noseedRow?.seeded).toBe(false);
  });

  it("result.tickers matches result.rows.map(r=>r.ticker)", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`T${i}`));
    const result = preRankUniverse(rows, { target: 6 });
    expect(result.tickers).toEqual(result.rows.map((r) => r.ticker));
  });
});

describe("preRankUniverse — full eligible pool", () => {
  it("returns every floor-pass or seed-bypass row without changing the capped selection", () => {
    const floorPassers = Array.from({ length: 6 }, (_, index) =>
      row(`PASS${index}`, { dollarVolume: 3_000_000 + index, rangePct: 0.02 + index / 100 }),
    );
    const seedBypasses = [
      row("SEEDA", { price: 1, dollarVolume: 100 }),
      row("SEEDB", { price: 1, dollarVolume: 200 }),
    ];
    const excluded = [
      row("LOWVOL", { dollarVolume: 100 }),
      row("LOWPRICE", { price: 1 }),
    ];
    const result = preRankUniverse([...floorPassers, ...seedBypasses, ...excluded], {
      target: 2,
      alwaysInclude: ["SEEDA", "SEEDB"],
    });

    expect(result.consideredCount).toBe(10);
    expect(result.gatedCount).toBe(6);
    expect(result.tickers).toEqual(["SEEDA", "SEEDB"]);
    expect(result.rows.map((candidate) => candidate.ticker)).toEqual(result.tickers);
    expect(result.eligibleRows).toHaveLength(8);
    expect(new Set(result.eligibleRows.map((candidate) => candidate.ticker))).toEqual(
      new Set([...floorPassers.map((candidate) => candidate.ticker), "SEEDA", "SEEDB"]),
    );
  });
});
