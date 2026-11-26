import { describe, it, expect } from "vitest";
import { coerceNum, parseMover, parseMovers } from "@/data/movers/fetchMovers";

describe("coerceNum", () => {
  it("passes finite numbers through", () => {
    expect(coerceNum(5.23)).toBe(5.23);
    expect(coerceNum(0)).toBe(0);
    expect(coerceNum(-1.2)).toBe(-1.2);
  });

  it("strips %, +, commas, and whitespace from strings", () => {
    expect(coerceNum("5.23%")).toBe(5.23);
    expect(coerceNum("+1,234")).toBe(1234);
    expect(coerceNum(" -3.1% ")).toBe(-3.1);
  });

  it("returns null for non-numeric or non-finite input", () => {
    expect(coerceNum("abc")).toBeNull();
    expect(coerceNum(undefined)).toBeNull();
    expect(coerceNum(null)).toBeNull();
    expect(coerceNum(Infinity)).toBeNull();
    expect(coerceNum(NaN)).toBeNull();
  });
});

describe("parseMover", () => {
  it("normalizes a numeric stable row, converting percent to a ratio", () => {
    expect(
      parseMover({ symbol: "nvda", name: "NVIDIA Corp", price: 120.5, change: 4.2, changesPercentage: 3.61 }),
    ).toEqual({ ticker: "NVDA", name: "NVIDIA Corp", price: 120.5, change: 4.2, changePct: 0.0361 });
  });

  it("parses a string '5.23%' changesPercentage", () => {
    const m = parseMover({ symbol: "AMD", name: "AMD", price: 100, change: "+5", changesPercentage: "5.23%" });
    expect(m?.changePct).toBeCloseTo(0.0523, 6);
    expect(m?.change).toBe(5);
  });

  it("accepts the changePercentage alias", () => {
    const m = parseMover({ symbol: "TSLA", price: 200, changePercentage: -2 });
    expect(m?.changePct).toBe(-0.02);
  });

  it("falls back to the ticker when name is missing", () => {
    expect(parseMover({ symbol: "F", price: 12 })?.name).toBe("F");
  });

  it("drops rows with an invalid symbol", () => {
    expect(parseMover({ symbol: "N/A", price: 10 })).toBeNull();
    expect(parseMover({ symbol: "123", price: 10 })).toBeNull();
    expect(parseMover({ symbol: "", price: 10 })).toBeNull();
  });

  it("drops rows with a missing or non-positive price", () => {
    expect(parseMover({ symbol: "AAPL" })).toBeNull();
    expect(parseMover({ symbol: "AAPL", price: 0 })).toBeNull();
    expect(parseMover({ symbol: "AAPL", price: -5 })).toBeNull();
  });

  it("defaults a missing changesPercentage to 0", () => {
    expect(parseMover({ symbol: "KO", price: 60 })?.changePct).toBe(0);
  });
});

describe("parseMovers", () => {
  it("returns [] for non-array input", () => {
    expect(parseMovers(null)).toEqual([]);
    expect(parseMovers({})).toEqual([]);
    expect(parseMovers(undefined)).toEqual([]);
  });

  it("filters invalid rows and preserves API order", () => {
    const rows = [
      { symbol: "AAA", price: 10, changesPercentage: 1 },
      { symbol: "N/A", price: 5 },
      null,
      "garbage",
      { symbol: "BBB", price: 20, changesPercentage: -2 },
    ];
    const out = parseMovers(rows, 8);
    expect(out.map((m) => m.ticker)).toEqual(["AAA", "BBB"]);
  });

  it("caps the result to the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ symbol: `T${i}`.replace(/\d/g, "A"), price: 10 + i }));
    // ticker regex requires alpha - build valid distinct symbols
    const valid = ["AAPL", "MSFT", "NVDA", "AMD", "TSLA", "META", "GOOG", "AMZN", "NFLX", "INTC"].map(
      (s, i) => ({ symbol: s, price: 10 + i }),
    );
    expect(parseMovers(valid, 3)).toHaveLength(3);
    expect(parseMovers(rows, 5).length).toBeLessThanOrEqual(5);
  });
});
