import { describe, expect, it } from "vitest";

import {
  ewma,
  invNormalCdf,
  mean,
  median,
  medianMAD,
  percentileRank,
  residualize,
  sanitizeFinite,
  winsorize,
} from "@/lib/math";

describe("mean", () => {
  it("averages values", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns 0 for an empty array", () => {
    expect(mean([])).toBe(0);
  });
});

describe("median", () => {
  it("returns the middle value for odd counts", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("averages the two middle values for even counts", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("returns NaN for an empty array", () => {
    expect(median([])).toBeNaN();
  });
  it("does not mutate the input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("winsorize", () => {
  it("clamps extreme outliers into the quantile band", () => {
    const values = [0, 10, 11, 12, 13, 14, 15, 16, 17, 1000];
    const w = winsorize(values, 0.1, 0.9);
    // The 1000 outlier is pulled down to the 90th-percentile value; 0 pulled up.
    expect(Math.max(...w)).toBeLessThan(1000);
    expect(Math.min(...w)).toBeGreaterThan(0);
    expect(w.length).toBe(values.length);
  });

  it("leaves interior values untouched and only clamps the tails inward", () => {
    const values = [10, 12, 14, 16, 18];
    const w = winsorize(values, 0.05, 0.95);
    // Interior values sit inside the band and are unchanged.
    expect(w[1]).toBe(12);
    expect(w[2]).toBe(14);
    expect(w[3]).toBe(16);
    // Tails are pulled toward the band, never pushed further out.
    expect(w[0]).toBeGreaterThanOrEqual(10);
    expect(w[0]).toBeLessThanOrEqual(12);
    expect(w[4]).toBeLessThanOrEqual(18);
    expect(w[4]).toBeGreaterThanOrEqual(16);
  });

  it("returns short arrays unchanged (and a copy)", () => {
    expect(winsorize([])).toEqual([]);
    const one = [42];
    const out = winsorize(one);
    expect(out).toEqual([42]);
    expect(out).not.toBe(one);
  });

  it("preserves input order", () => {
    const values = [100, 1, 50, 2, 99];
    const w = winsorize(values, 0.2, 0.8);
    // Order preserved: index 1 was the smallest, index 0 the largest.
    expect(w[1]).toBeLessThanOrEqual(w[2]!);
  });
});

describe("percentileRank", () => {
  it("ranks distinct values into the open interval (0,1)", () => {
    const r = percentileRank([10, 20, 30, 40]);
    expect(r).toEqual([0.2, 0.4, 0.6, 0.8]); // rank/(n+1)
    for (const p of r) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("is monotonic in value regardless of input order", () => {
    const r = percentileRank([30, 10, 40, 20]);
    expect(r[1]).toBeLessThan(r[3]!); // 10 < 20
    expect(r[3]).toBeLessThan(r[0]!); // 20 < 30
    expect(r[0]).toBeLessThan(r[2]!); // 30 < 40
  });

  it("assigns equal midranks to ties", () => {
    const r = percentileRank([5, 5, 9]);
    expect(r[0]).toBe(r[1]); // tied values share a rank
    expect(r[2]).toBeGreaterThan(r[0]!);
  });

  it("maps a single element to the center", () => {
    expect(percentileRank([7])).toEqual([0.5]);
  });

  it("returns an empty array for empty input", () => {
    expect(percentileRank([])).toEqual([]);
  });
});

describe("invNormalCdf", () => {
  it("maps 0.5 to 0", () => {
    expect(invNormalCdf(0.5)).toBeCloseTo(0, 9);
  });

  it("recovers known z-scores", () => {
    expect(invNormalCdf(0.975)).toBeCloseTo(1.959963985, 5);
    expect(invNormalCdf(0.025)).toBeCloseTo(-1.959963985, 5);
    expect(invNormalCdf(0.8413447461)).toBeCloseTo(1, 4);
    expect(invNormalCdf(0.1586552539)).toBeCloseTo(-1, 4);
  });

  it("is antisymmetric about 0.5", () => {
    for (const p of [0.1, 0.3, 0.45, 0.7, 0.99]) {
      expect(invNormalCdf(p)).toBeCloseTo(-invNormalCdf(1 - p), 6);
    }
  });

  it("stays finite at the boundaries (clamped, never ±Infinity)", () => {
    expect(Number.isFinite(invNormalCdf(0))).toBe(true);
    expect(Number.isFinite(invNormalCdf(1))).toBe(true);
    expect(invNormalCdf(0)).toBeLessThan(0);
    expect(invNormalCdf(1)).toBeGreaterThan(0);
  });

  it("round-trips with percentileRank to produce mean-zero z-scores", () => {
    const ranks = percentileRank([10, 20, 30, 40, 50]);
    const z = ranks.map(invNormalCdf);
    expect(mean(z)).toBeCloseTo(0, 9); // symmetric ranks → zero-mean normal scores
  });
});

describe("medianMAD", () => {
  it("computes the median and raw MAD", () => {
    const { median: med, mad } = medianMAD([1, 2, 3, 4, 5]);
    expect(med).toBe(3);
    expect(mad).toBe(1); // |dev| = [2,1,0,1,2] → median 1
  });

  it("returns NaN for an empty array", () => {
    const { median: med, mad } = medianMAD([]);
    expect(med).toBeNaN();
    expect(mad).toBeNaN();
  });
});

describe("ewma", () => {
  it("returns the constant for a flat series", () => {
    expect(ewma([5, 5, 5, 5], 2)).toBeCloseTo(5, 9);
  });
  it("returns the single point as-is, and NaN for empty", () => {
    expect(ewma([42], 3)).toBe(42);
    expect(ewma([], 3)).toBeNaN();
  });
  it("weights recent points more, between the mean and the latest", () => {
    const series = [0, 0, 0, 10];
    const value = ewma(series, 2);
    expect(value).toBeGreaterThan(mean(series)); // pulled toward the recent spike
    expect(value).toBeLessThan(10);
  });
  it("a shorter half-life tracks the latest more closely", () => {
    const series = [0, 0, 0, 10];
    expect(ewma(series, 1)).toBeGreaterThan(ewma(series, 5));
  });
});

describe("residualize", () => {
  it("removes a perfect linear dependence on x to ~zero", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 2 * x + 3); // exactly explained by xs
    const resid = residualize(ys, xs);
    for (const r of resid) expect(r).toBeCloseTo(0, 9);
  });

  it("leaves the size-orthogonal component, which is uncorrelated with x", () => {
    const xs = [0, 1, 2, 3, 4, 5, 6, 7];
    // y = linear trend in x + an alternating wiggle orthogonal-ish to x
    const ys = xs.map((x, i) => 5 * x + (i % 2 === 0 ? 4 : -4));
    const resid = residualize(ys, xs);
    // Residuals must have ~zero correlation with xs.
    const mx = mean(xs);
    const mr = mean(resid);
    let cov = 0;
    let vx = 0;
    for (let i = 0; i < xs.length; i++) {
      cov += (xs[i]! - mx) * (resid[i]! - mr);
      vx += (xs[i]! - mx) ** 2;
    }
    expect(cov / vx).toBeCloseTo(0, 9);
  });

  it("mean-centers ys when xs has no variance", () => {
    const ys = [10, 20, 30];
    const resid = residualize(ys, [5, 5, 5]);
    expect(resid).toEqual([-10, 0, 10]);
  });

  it("returns a copy of ys for mismatched or empty inputs", () => {
    expect(residualize([], [])).toEqual([]);
    const ys = [1, 2, 3];
    const out = residualize(ys, [1, 2]);
    expect(out).toEqual(ys);
    expect(out).not.toBe(ys);
  });
});

// ---------------------------------------------------------------------------
// NaN-proofing the cross-sectional choke points (Lane B-1).
//
// A NaN anywhere in a per-dimension array poisons the comparators that sort the
// universe ((a,b) => v[a]-v[b] returns NaN, which Array.sort treats as 0), so a
// single stray value silently mis-orders EVERY name's percentile rank / z-score /
// regression residual. These guard that a stray NaN can never reorder the rest.
// ---------------------------------------------------------------------------

describe("sanitizeFinite", () => {
  it("returns the same array reference when everything is finite", () => {
    const v = [1, 2, 3];
    expect(sanitizeFinite(v)).toBe(v);
  });

  it("replaces non-finite entries with the mean of the finite ones", () => {
    expect(sanitizeFinite([2, NaN, 4])).toEqual([2, 3, 4]); // mean(2,4)=3
    expect(sanitizeFinite([10, Infinity, -Infinity, 30])).toEqual([10, 20, 20, 30]);
  });

  it("falls back to 0 when nothing is finite", () => {
    expect(sanitizeFinite([NaN, Infinity])).toEqual([0, 0]);
  });

  it("does not mutate the input", () => {
    const v = [1, NaN, 3];
    sanitizeFinite(v);
    expect(v[1]).toBeNaN();
  });
});

describe("cross-sectional helpers are NaN-proof", () => {
  it("winsorize: a stray NaN does not reorder the finite values", () => {
    const clean = winsorize([10, 20, 30, 40, 50], 0.05, 0.95);
    const dirty = winsorize([10, 20, NaN, 40, 50], 0.05, 0.95);
    // Every output is finite, and the surviving finite positions keep their order.
    for (const x of dirty) expect(Number.isFinite(x)).toBe(true);
    expect(dirty[0]).toBe(clean[0]);
    expect(dirty[1]).toBe(clean[1]);
    expect(dirty[3]).toBe(clean[3]);
    expect(dirty[4]).toBe(clean[4]);
  });

  it("percentileRank: a stray NaN keeps the others' relative order intact", () => {
    const r = percentileRank([10, 20, NaN, 40, 50]);
    for (const p of r) expect(Number.isFinite(p)).toBe(true);
    // The four genuine values must still rank in ascending order.
    expect(r[0]).toBeLessThan(r[1]!);
    expect(r[1]).toBeLessThan(r[3]!);
    expect(r[3]).toBeLessThan(r[4]!);
  });

  it("residualize: a stray NaN in either series can't blow up the residuals", () => {
    const resid = residualize([1, 2, NaN, 4, 5], [1, 2, 3, NaN, 5]);
    for (const r of resid) expect(Number.isFinite(r)).toBe(true);
  });
});
