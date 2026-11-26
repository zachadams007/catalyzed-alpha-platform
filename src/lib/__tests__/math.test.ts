import { describe, expect, it } from "vitest";

import {
  clamp,
  lerp,
  round,
  scaleBand,
  scaleLinear,
  seededRandom,
  weightedAverage,
} from "@/lib/math";

describe("clamp", () => {
  it("clamps values to the default range", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(42)).toBe(42);
    expect(clamp(101)).toBe(100);
  });

  it("includes the range boundaries", () => {
    expect(clamp(0)).toBe(0);
    expect(clamp(100)).toBe(100);
  });

  it("supports a custom range", () => {
    expect(clamp(-10, -5, 5)).toBe(-5);
    expect(clamp(2, -5, 5)).toBe(2);
    expect(clamp(10, -5, 5)).toBe(5);
  });

  // Finite-safe: a non-finite input must collapse to the lower bound, never
  // survive as NaN. Without this a single bad sub-score corrupts the whole
  // universe's cross-sectional ranks (it flows through round(clamp(score))).
  it("sanitizes non-finite inputs to the lower bound", () => {
    expect(clamp(NaN)).toBe(0);
    expect(clamp(Infinity)).toBe(0);
    expect(clamp(-Infinity)).toBe(0);
    expect(clamp(NaN, 10, 90)).toBe(10);
    expect(clamp(Infinity, -5, 5)).toBe(-5);
    expect(Number.isFinite(clamp(NaN))).toBe(true);
  });
});

describe("round", () => {
  it("rounds to an integer by default", () => {
    expect(round(12.49)).toBe(12);
    expect(round(12.5)).toBe(13);
    expect(round(-12.5)).toBe(-12);
  });

  it("rounds to the requested decimal precision", () => {
    expect(round(12.3456, 1)).toBe(12.3);
    expect(round(12.3456, 2)).toBe(12.35);
    expect(round(12.3456, 3)).toBe(12.346);
  });

  it("handles half values at a requested precision", () => {
    expect(round(1.25, 1)).toBe(1.3);
    expect(round(-1.25, 1)).toBe(-1.2);
  });

  it("supports negative precision", () => {
    expect(round(1_249, -2)).toBe(1_200);
    expect(round(1_250, -2)).toBe(1_300);
  });
});

describe("scaleLinear", () => {
  it("maps domain endpoints to the output endpoints", () => {
    expect(scaleLinear(10, 10, 20, -1, 1)).toBe(-1);
    expect(scaleLinear(20, 10, 20, -1, 1)).toBe(1);
  });

  it("maps the domain midpoint linearly", () => {
    expect(scaleLinear(15, 10, 20, -1, 1)).toBe(0);
  });

  it("uses the default output range", () => {
    expect(scaleLinear(0.5, 0, 1)).toBe(50);
  });

  it("clamps values outside the domain", () => {
    expect(scaleLinear(5, 10, 20, -1, 1)).toBe(-1);
    expect(scaleLinear(25, 10, 20, -1, 1)).toBe(1);
  });

  it("supports an inverted domain", () => {
    expect(scaleLinear(100, 100, 0, 0, 1)).toBe(0);
    expect(scaleLinear(75, 100, 0, 0, 1)).toBe(0.25);
    expect(scaleLinear(0, 100, 0, 0, 1)).toBe(1);
    expect(scaleLinear(125, 100, 0, 0, 1)).toBe(0);
    expect(scaleLinear(-25, 100, 0, 0, 1)).toBe(1);
  });

  it("returns the output minimum for a degenerate domain", () => {
    expect(scaleLinear(5, 5, 5, 20, 80)).toBe(20);
    expect(scaleLinear(100, 5, 5, 20, 80)).toBe(20);
  });
});

describe("lerp", () => {
  it("returns the endpoints at t=0 and t=1", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it("interpolates linearly at the midpoint", () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
  });

  it("extrapolates beyond the range", () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
});

// scaleBand(value, ideal, span): a "sweet spot" scorer. value === ideal -> 100;
// falls off linearly to 0 at ideal ± span; clamped to [0, 100].
describe("scaleBand", () => {
  const ideal = 60;
  const span = 20;

  it("scores 100 at the ideal value", () => {
    expect(scaleBand(ideal, ideal, span)).toBe(100);
  });

  it("scores 0 at the edges of the band", () => {
    expect(scaleBand(ideal + span, ideal, span)).toBe(0);
    expect(scaleBand(ideal - span, ideal, span)).toBe(0);
  });

  it("falls off linearly toward the edges", () => {
    expect(scaleBand(ideal + span / 2, ideal, span)).toBe(50);
    expect(scaleBand(ideal - span / 2, ideal, span)).toBe(50);
  });

  it("clamps values outside the band to 0", () => {
    expect(scaleBand(ideal + span * 2, ideal, span)).toBe(0);
    expect(scaleBand(ideal - span * 2, ideal, span)).toBe(0);
  });
});

// weightedAverage(pairs: Array<{ score, weight }>): returns 0 when weights sum to 0.
describe("weightedAverage", () => {
  it("calculates a weighted average", () => {
    expect(
      weightedAverage([
        { score: 10, weight: 0.2 },
        { score: 20, weight: 0.3 },
        { score: 30, weight: 0.5 },
      ]),
    ).toBe(23);
  });

  it("ignores values with zero weight", () => {
    expect(
      weightedAverage([
        { score: 10, weight: 0 },
        { score: 20, weight: 1 },
        { score: 30, weight: 0 },
      ]),
    ).toBe(20);
  });

  it("returns zero when all weights are zero", () => {
    expect(
      weightedAverage([
        { score: 10, weight: 0 },
        { score: 20, weight: 0 },
      ]),
    ).toBe(0);
  });

  it("returns zero for empty input", () => {
    expect(weightedAverage([])).toBe(0);
  });

  it("does not require weights to sum to one", () => {
    expect(
      weightedAverage([
        { score: 10, weight: 2 },
        { score: 20, weight: 1 },
      ]),
    ).toBeCloseTo(40 / 3);
  });
});

describe("seededRandom", () => {
  it("returns a value in [0, 1)", () => {
    for (const seed of ["AAPL", "msft", "", "a-long-seed-string-123"]) {
      const value = seededRandom(seed);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(seededRandom("NVDA")).toBe(seededRandom("NVDA"));
  });

  it("varies across different seeds", () => {
    expect(seededRandom("AAPL")).not.toBe(seededRandom("TSLA"));
  });
});
