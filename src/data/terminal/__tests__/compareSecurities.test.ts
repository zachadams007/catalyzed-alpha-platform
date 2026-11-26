import { describe, it, expect } from "vitest";
import {
  returnOver,
  pctFromHigh,
  buildComparison,
  tallyWins,
  type CompareSide,
} from "@/data/terminal/compareSecurities";

describe("returnOver", () => {
  it("computes the trailing return over the lookback", () => {
    expect(returnOver([100, 110], 1)).toBeCloseTo(0.1, 6);
    expect(returnOver([100, 90], 1)).toBeCloseTo(-0.1, 6);
  });
  it("returns null when the series is too short or prior is 0", () => {
    expect(returnOver([100], 1)).toBeNull();
    expect(returnOver([0, 100], 1)).toBeNull();
  });
});

describe("pctFromHigh", () => {
  it("is 0 at the high and negative below it", () => {
    expect(pctFromHigh(100, [50, 100, 80])).toBeCloseTo(0, 6); // price == high
    expect(pctFromHigh(80, [50, 100, 80])).toBeCloseTo(-0.2, 6);
  });
  it("returns null with no closes", () => {
    expect(pctFromHigh(80, [])).toBeNull();
  });
});

function side(p: Partial<CompareSide>): CompareSide {
  return { ticker: "X", score: 50, momentum: 0, fromHigh: -0.1, marketCap: 1e9, upside: 0, ...p };
}

describe("buildComparison", () => {
  it("rewards the higher value on score/momentum/upside", () => {
    const m = buildComparison(side({ ticker: "A", score: 80 }), side({ ticker: "B", score: 60 }));
    expect(m.find((x) => x.key === "score")!.winner).toBe("a");
  });

  it("treats the MORE discounted name as ahead on discount-to-high", () => {
    const m = buildComparison(side({ fromHigh: -0.30 }), side({ fromHigh: -0.05 }));
    expect(m.find((x) => x.key === "fromHigh")!.winner).toBe("a"); // -0.30 is cheaper
    expect(m.find((x) => x.key === "fromHigh")!.higherWins).toBe(false);
  });

  it("marks ties and uncomparable (null) metrics as tie", () => {
    const m = buildComparison(side({ score: 70, upside: null }), side({ score: 70, upside: 0.2 }));
    expect(m.find((x) => x.key === "score")!.winner).toBe("tie");
    expect(m.find((x) => x.key === "upside")!.winner).toBe("tie"); // one side null
  });

  it("never declares a market-cap winner", () => {
    const m = buildComparison(side({ marketCap: 9e9 }), side({ marketCap: 1e9 }));
    expect(m.find((x) => x.key === "marketCap")!.winner).toBe("tie");
  });

  it("carries a missing (null) market cap through as null so the cell reads '—'", () => {
    // deriveSide maps a 0/missing cap to null; formatMetric('marketCap', null) === ' - '.
    const m = buildComparison(side({ marketCap: null }), side({ marketCap: 1e9 }));
    const cap = m.find((x) => x.key === "marketCap")!;
    expect(cap.a).toBeNull();
    expect(cap.winner).toBe("tie"); // cap is never a winner, null side included
  });
});

describe("tallyWins", () => {
  it("counts metric leads, excluding market cap", () => {
    const a = side({ ticker: "A", score: 80, momentum: 0.2, fromHigh: -0.3, upside: 0.5, marketCap: 9e9 });
    const b = side({ ticker: "B", score: 60, momentum: 0.1, fromHigh: -0.05, upside: 0.1, marketCap: 1e9 });
    // A leads score, momentum, discount, upside = 4; cap excluded.
    expect(tallyWins(buildComparison(a, b))).toEqual({ a: 4, b: 0 });
  });
});
