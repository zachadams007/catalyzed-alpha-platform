import { describe, it, expect } from "vitest";

import { derivePortfolioHistory, reconstructBasketSeries } from "@/engine/portfolioHistory";
import type {
  Portfolio,
  PortfolioHolding,
  PortfolioValuePoint,
  PricePoint,
  StockSignal,
} from "@/types";

const DAY = 86_400_000;
const ORIGIN = new Date("2026-05-01T00:00:00.000Z").getTime();

function book(holdings: PortfolioHolding[], valueHistory?: PortfolioValuePoint[]): Portfolio {
  return {
    id: "pf_test",
    name: "Test",
    mode: "Custom",
    description: "",
    owner: "me",
    isPublic: false,
    holdings,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    valueHistory,
  };
}

/** Only `priceSeries` is read off the signal - keep the fixture tiny. */
function asSignal(priceSeries: PricePoint[]): StockSignal {
  return { priceSeries } as unknown as StockSignal;
}

function lookupFrom(map: Record<string, PricePoint[]>) {
  return (ticker: string): StockSignal | undefined =>
    map[ticker] ? asSignal(map[ticker]) : undefined;
}

function priceLookupFrom(map: Record<string, PricePoint[]>) {
  return (ticker: string): PricePoint[] | undefined => map[ticker];
}

/** Daily price series from a starting value + per-day deltas (offset by day). */
function walk(start: number, deltas: number[], dayOffset = 0): PricePoint[] {
  const out: PricePoint[] = [{ date: new Date(ORIGIN + dayOffset * DAY).toISOString(), close: start }];
  let value = start;
  deltas.forEach((delta, i) => {
    value = Math.max(0.01, value + delta);
    out.push({ date: new Date(ORIGIN + (dayOffset + i + 1) * DAY).toISOString(), close: value });
  });
  return out;
}

function snapshots(values: number[], stride = 1): PortfolioValuePoint[] {
  return values.map((value, i) => ({
    date: new Date(ORIGIN + i * stride * DAY).toISOString(),
    value,
    valuedCount: 1,
  }));
}

/** A series is a straight line if every consecutive segment shares one slope. */
function isStraightLine(series: PricePoint[]): boolean {
  if (series.length < 3) return true;
  const slopes = new Set<number>();
  for (let i = 1; i < series.length; i++) {
    slopes.add(Math.round((series[i]!.close - series[i - 1]!.close) * 100));
  }
  return slopes.size <= 1;
}

describe("reconstructBasketSeries", () => {
  it("builds a dense, non-linear curve from real price history", () => {
    const series = walk(100, [5, -3, 8, -2, 10, -6, 4]);
    const { series: out, coverageCount } = reconstructBasketSeries(
      [{ ticker: "ACME", shares: 10 }],
      priceLookupFrom({ ACME: series }),
    );
    expect(coverageCount).toBe(1);
    expect(out).toHaveLength(series.length);
    expect(out[0]!.close).toBeCloseTo(series[0]!.close * 10);
    expect(isStraightLine(out)).toBe(false);
  });

  it("only counts holdings with shares and ≥2 real closes", () => {
    const { coverageCount } = reconstructBasketSeries(
      [
        { ticker: "ACME", shares: 10 }, // 8 pts → eligible
        { ticker: "ONE", shares: 5 }, // 1 pt → excluded
        { ticker: "NOSH", shares: 0 }, // no shares → excluded
        { ticker: "MISS", shares: 3 }, // no series → excluded
      ],
      priceLookupFrom({
        ACME: walk(100, [1, 2, -1, 3, -2, 1, 4]),
        ONE: [{ date: new Date(ORIGIN).toISOString(), close: 50 }],
      }),
    );
    expect(coverageCount).toBe(1);
  });

  it("plots the overlapping window and forward-fills interior gaps", () => {
    // ACME spans days 0..7; LATE spans days 3..9 → overlap is days 3..7.
    const acme = walk(100, [1, 1, 1, 1, 1, 1, 1]); // days 0..7
    const late = walk(40, [2, 2, 2, 2, 2, 2], 3); // days 3..9
    const { series, coverageCount } = reconstructBasketSeries(
      [
        { ticker: "ACME", shares: 1 },
        { ticker: "LATE", shares: 1 },
      ],
      priceLookupFrom({ ACME: acme, LATE: late }),
    );
    expect(coverageCount).toBe(2);
    // Window = days 3..7 inclusive → 5 points, every one covered by both names.
    expect(series).toHaveLength(5);
    expect(series.every((p) => p.close > 0)).toBe(true);
  });
});

describe("derivePortfolioHistory", () => {
  const reconLookup = lookupFrom({ ACME: walk(100, [5, -3, 8, -2, 10, -6, 4]) });

  it("replaces a 2-point straight line with the true reconstructed curve", () => {
    // The reported bug: sparse snapshots render as a single straight segment.
    const sparse = book([{ ticker: "ACME", addedAt: "2026-05-01", shares: 10 }], snapshots([1000, 940], 9));
    const result = derivePortfolioHistory(sparse, reconLookup);
    expect(result.source).toBe("reconstructed");
    expect(result.series.length).toBeGreaterThan(2);
    expect(isStraightLine(result.series)).toBe(false);
  });

  it("rejects a long-but-flat recorded series in favour of reconstruction", () => {
    // Stale daily snapshots: many points, but the score price never moved.
    const flat = book(
      [{ ticker: "ACME", addedAt: "2026-05-01", shares: 10 }],
      snapshots([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]),
    );
    const result = derivePortfolioHistory(flat, reconLookup);
    expect(result.source).toBe("reconstructed");
    expect(isStraightLine(result.series)).toBe(false);
  });

  it("trusts a genuinely varied, long recorded series", () => {
    const varied = book(
      [{ ticker: "ACME", addedAt: "2026-05-01", shares: 10 }],
      snapshots([1000, 1020, 1005, 1060, 1035, 1090, 1050, 1110, 1075, 1130, 1095, 1150]),
    );
    // Reconstruction is shorter here, so the rich recorded history should win.
    const shortRecon = lookupFrom({ ACME: walk(100, [1, -1, 2]) });
    const result = derivePortfolioHistory(varied, shortRecon);
    expect(result.source).toBe("recorded");
    expect(result.series).toHaveLength(12);
  });

  it("trusts a short-but-varied measured history over a longer reconstruction", () => {
    // The user has only ~6 daily snapshots, but they genuinely moved - this real
    // measured path should win over a longer synthetic reconstruction.
    const shortVaried = book(
      [{ ticker: "ACME", addedAt: "2026-05-01", shares: 10 }],
      snapshots([1000, 1050, 1010, 1080, 1040, 1100]),
    );
    const longRecon = lookupFrom({ ACME: walk(100, [1, 2, -1, 3, -2, 1, 4, 2, -3, 5, 1, -2, 4, -1, 3]) });
    const result = derivePortfolioHistory(shortVaried, longRecon);
    expect(result.source).toBe("recorded");
    expect(result.series).toHaveLength(6);
  });

  it("falls back to sparse recorded snapshots when no price coverage exists", () => {
    const noCoverage = book(
      [{ ticker: "ZZZ", addedAt: "2026-05-01", shares: 10 }],
      snapshots([1000, 940], 9),
    );
    const result = derivePortfolioHistory(noCoverage, () => undefined);
    expect(result.source).toBe("recorded");
    expect(result.series).toHaveLength(2);
  });

  it("returns an honest empty result with no usable data", () => {
    const empty = book([{ ticker: "ZZZ", addedAt: "2026-05-01" }]);
    const result = derivePortfolioHistory(empty, () => undefined);
    expect(result.source).toBe("none");
    expect(result.series).toHaveLength(0);
    expect(result.holdingCount).toBe(1);
  });

  it("de-dupes recorded snapshots to one point per day", () => {
    const sameDay: PortfolioValuePoint[] = [
      { date: "2026-05-01T09:00:00.000Z", value: 1000, valuedCount: 1 },
      { date: "2026-05-01T16:00:00.000Z", value: 1020, valuedCount: 1 },
      { date: "2026-05-02T16:00:00.000Z", value: 1040, valuedCount: 1 },
    ];
    const result = derivePortfolioHistory(book([], sameDay), () => undefined);
    expect(result.series).toHaveLength(2);
    expect(result.series[0]!.close).toBe(1020); // last write of the day wins
  });
});
