import { describe, expect, it } from "vitest";
import {
  dayColor,
  hypeColor,
  legendForMode,
  normalizeHype,
  opportunityColor,
  rampGradientCss,
  readableInk,
  tileColor,
} from "@/components/heatmap/colorScale";

const RGB = /^rgb\(\d+, \d+, \d+\)$/;

function rgb(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/(\d+)\D+(\d+)\D+(\d+)/)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("readableInk", () => {
  it("picks the higher-contrast ink across the whole opportunity ramp", () => {
    for (let score = 0; score <= 100; score += 5) {
      const bg = opportunityColor(score);
      const ink = readableInk(bg);
      const other = ink === "#0a0f16" ? "#eef4fc" : "#0a0f16";
      // Chosen ink must be at least as contrasty as the alternative.
      expect(contrast(bg, ink)).toBeGreaterThanOrEqual(contrast(bg, other) - 1e-9);
    }
  });

  it("uses dark ink on the bright azure band (the old threshold's failure case)", () => {
    // score 78 → ~rgb(39,186,237); black ink must win (the 0.42 cutoff chose white).
    expect(readableInk("rgb(39, 186, 237)")).toBe("#0a0f16");
  });

  it("uses light ink on a deep background", () => {
    expect(readableInk("rgb(27, 36, 48)")).toBe("#eef4fc");
  });
});

describe("non-finite guards", () => {
  it("never emits rgb(NaN, …) and treats NaN as the safe end", () => {
    for (const c of [dayColor(NaN), opportunityColor(NaN), hypeColor(NaN)]) {
      expect(c).toMatch(RGB);
      expect(c).not.toContain("NaN");
    }
    // NaN day-move resolves to the neutral center, not a spurious gain/loss.
    expect(dayColor(NaN)).toBe(dayColor(0));
    // NaN score/hype resolve to the low stop, never the misleading top color.
    expect(opportunityColor(NaN)).toBe(opportunityColor(0));
    expect(opportunityColor(NaN)).not.toBe(opportunityColor(100));
  });
});

describe("dayColor divergence", () => {
  it("greens gainers and reds decliners around a neutral center", () => {
    const up = rgb(dayColor(0.05));
    const down = rgb(dayColor(-0.05));
    expect(up[1]).toBeGreaterThan(up[0]); // green channel dominates on a gain
    expect(down[0]).toBeGreaterThan(down[1]); // red channel dominates on a loss
  });

  it("clamps beyond the full scale", () => {
    expect(dayColor(0.2)).toBe(dayColor(0.05));
    expect(dayColor(-0.2)).toBe(dayColor(-0.05));
  });
});

describe("tileColor + legend", () => {
  const vals = { opportunity: 70, dayChange: 0.03, hype: 80 };
  it("routes each mode to the right ramp", () => {
    expect(tileColor("opportunity", vals)).toBe(opportunityColor(70));
    expect(tileColor("day", vals)).toBe(dayColor(0.03));
    expect(tileColor("hype", vals)).toBe(hypeColor(80));
  });

  it("returns ordered legend swatches per mode", () => {
    expect(legendForMode("day")).toHaveLength(5);
    expect(legendForMode("hype")).toHaveLength(4);
    expect(legendForMode("opportunity")).toHaveLength(4);
    for (const s of legendForMode("opportunity")) expect(s.color).toMatch(RGB);
  });
});

describe("hype ramp (perceptual + colorblind-safe)", () => {
  it("climbs MONOTONICALLY in luminance low→high (the magma/inferno guarantee)", () => {
    // A monotonic lightness ramp stays readable to colorblind viewers even when
    // hue is lost - this is the property that makes the hype scale differentiable.
    let prev = -1;
    for (let p = 0; p <= 100; p += 5) {
      const l = luminance(hypeColor(p));
      expect(l).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = l;
    }
  });

  it("separates the cold and hot ends strongly (not an all-orange field)", () => {
    const cold = hypeColor(0);
    const hot = hypeColor(100);
    expect(cold).not.toBe(hot);
    // The hot end is markedly brighter than the cold end.
    expect(luminance(hot)).toBeGreaterThan(luminance(cold) + 0.3);
  });
});

describe("normalizeHype (contrast stretch)", () => {
  it("is the identity over the full 0..100 window by default", () => {
    expect(normalizeHype(80)).toBeCloseTo(80, 6);
    expect(normalizeHype(0)).toBeCloseTo(0, 6);
  });

  it("stretches an observed window across the full ramp and clamps the tails", () => {
    expect(normalizeHype(40, 40, 60)).toBeCloseTo(0, 6);
    expect(normalizeHype(50, 40, 60)).toBeCloseTo(50, 6);
    expect(normalizeHype(60, 40, 60)).toBeCloseTo(100, 6);
    expect(normalizeHype(30, 40, 60)).toBe(0); // below window clamps to 0
    expect(normalizeHype(80, 40, 60)).toBe(100); // above window clamps to 100
  });

  it("preserves ordering (monotonic in the raw score)", () => {
    expect(normalizeHype(45, 40, 60)).toBeLessThan(normalizeHype(55, 40, 60));
  });

  it("guards degenerate windows and non-finite scores", () => {
    expect(normalizeHype(50, 60, 40)).toBe(50); // hi <= lo → neutral mid
    expect(normalizeHype(NaN, 0, 100)).toBe(0);
  });

  it("routes hype tiles through the supplied domain", () => {
    const vals = { opportunity: 70, dayChange: 0.03, hype: 50 };
    expect(tileColor("hype", vals, { lo: 40, hi: 60 })).toBe(hypeColor(50));
  });
});

describe("rampGradientCss", () => {
  it("emits a left→right linear gradient for each mode", () => {
    for (const mode of ["day", "hype", "opportunity"] as const) {
      const css = rampGradientCss(mode);
      expect(css.startsWith("linear-gradient(90deg, ")).toBe(true);
      expect(css).toContain("0%");
      expect(css).toContain("100%");
      expect(css).not.toContain("NaN");
    }
  });
});
