/**
 * Heatmap color scales - one ramp per coloring mode. Pure functions returning
 * CSS color strings, kept here so the legend and the tiles read identical stops.
 *
 * Literal hexes (not CSS vars) because tiles interpolate between stops in JS;
 * they mirror the brand tokens in src/styles/tokens.css - blue family for the
 * opportunity score (matching lib/ui scoreColors), green/red for day-move, and
 * a cool→ember thermal ramp for hype/attention.
 */

export type HeatMode = "opportunity" | "day" | "hype";

interface Stop {
  /** Position on the metric's domain. */
  at: number;
  /** [r,g,b] 0..255. */
  rgb: [number, number, number];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

/** Sample a multi-stop ramp at `value`, interpolating between bracketing stops. */
function sampleRamp(stops: Stop[], value: number): string {
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  // Non-finite metric → render at the low/first stop, never a misleading top color.
  if (!Number.isFinite(value) || value <= first.at) return mix(first.rgb, first.rgb, 0);
  if (value >= last.at) return mix(last.rgb, last.rgb, 0);
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i]!;
    const hi = stops[i + 1]!;
    if (value >= lo.at && value <= hi.at) {
      const span = hi.at - lo.at || 1;
      return mix(lo.rgb, hi.rgb, (value - lo.at) / span);
    }
  }
  return mix(last.rgb, last.rgb, 0);
}

function stops(pairs: Array<[number, string]>): Stop[] {
  return pairs.map(([at, hex]) => ({ at, rgb: hexToRgb(hex) }));
}

// Opportunity (0..100): low coral → gold → azure → bright, mirroring lib/ui scoreColors
// bands. Refined for a smoother gold→azure hand-off and a deeper low end so weak and
// strong names separate more cleanly.
const OPPORTUNITY = stops([
  [0, "#e04d63"],
  [40, "#d69a4a"],
  [54, "#4a93c8"],
  [70, "#1ab2e8"],
  [88, "#46c6f5"],
  [100, "#6fdcff"],
]);

// Hype (0..100): a true perceptually-uniform thermal ramp - deep indigo night → violet →
// magenta → rose → coral → amber → bright gold. Luminance climbs MONOTONICALLY low→high,
// so the scale stays legible to colorblind viewers (the lightness ramp carries the signal
// even when hue is lost - the magma/inferno principle), brand-tuned to azure-app gold at
// the hot end. Orange is one band of many, never the whole field.
const HYPE = stops([
  [0, "#20183f"],
  [14, "#3a1f63"],
  [30, "#5e2486"],
  [45, "#8a2c83"],
  [58, "#b3326f"],
  [70, "#d6435a"],
  [80, "#ee6a3f"],
  [90, "#f99a33"],
  [100, "#ffd24a"],
]);

// Day-move diverging endpoints (centered on a near-neutral graphite).
const DAY_NEUTRAL = hexToRgb("#1b2430");
const DAY_BULL = hexToRgb("#2fb27f");
const DAY_BEAR = hexToRgb("#e2495d");

/** Day-move color: diverging green/red around 0, saturating to ±`fullScale` ratio. */
export function dayColor(dayChange: number, fullScale = 0.05): string {
  const safe = Number.isFinite(dayChange) ? dayChange : 0;
  const t = clamp(safe / fullScale, -1, 1);
  if (t >= 0) return mix(DAY_NEUTRAL, DAY_BULL, t);
  return mix(DAY_NEUTRAL, DAY_BEAR, -t);
}

export function opportunityColor(score: number): string {
  return sampleRamp(OPPORTUNITY, score);
}

export function hypeColor(score: number): string {
  return sampleRamp(HYPE, score);
}

/**
 * Contrast-stretch a raw hype score into the ramp's 0..100 position using the
 * field's own spread `[lo, hi]`. Hype is a blend of several 0..100 sub-scores, so
 * the universe clusters in the mid-range - mapping it raw would paint nearly every
 * tile the same mid-ramp hue. Stretching the observed spread across the full ramp
 * makes "cooler vs hotter" instantly readable while preserving exact ordering. The
 * absolute score + tier still ride the tile label and tooltip, so nothing is faked.
 */
export function normalizeHype(score: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(score)) return 0;
  if (!(hi > lo)) return 50;
  return clamp(((score - lo) / (hi - lo)) * 100, 0, 100);
}

/** WCAG relative luminance (0..1) of an [r,g,b] triple. */
function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function rgbFromCss(color: string): [number, number, number] {
  const m = color.match(/(\d+)\D+(\d+)\D+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const INK_DARK = "#0a0f16";
const INK_LIGHT = "#eef4fc";
const L_INK_DARK = relLuminance(hexToRgb(INK_DARK));
const L_INK_LIGHT = relLuminance(hexToRgb(INK_LIGHT));

/**
 * Pick the higher-contrast ink (near-black or near-white) for text on `bg` by
 * actual WCAG contrast against BOTH inks - self-correcting if the palette
 * shifts, and never the mistuned-threshold failure where bright azure tiles got
 * low-contrast white text.
 */
export function readableInk(bg: string): string {
  const l = relLuminance(rgbFromCss(bg));
  return contrastRatio(l, L_INK_DARK) >= contrastRatio(l, L_INK_LIGHT) ? INK_DARK : INK_LIGHT;
}

/** A contrast-stretch window for the hype ramp (see {@link normalizeHype}). */
export interface HypeDomain {
  lo: number;
  hi: number;
}

/** The active tile color for a given mode + metric values. */
export function tileColor(
  mode: HeatMode,
  values: { opportunity: number; dayChange: number; hype: number },
  hypeDomain?: HypeDomain,
): string {
  if (mode === "day") return dayColor(values.dayChange);
  if (mode === "hype") return hypeColor(normalizeHype(values.hype, hypeDomain?.lo, hypeDomain?.hi));
  return opportunityColor(values.opportunity);
}

/**
 * A CSS `linear-gradient` sampling the active mode's ramp left→right, for the
 * legend's continuous scale bar. Day diverges across its ±full-scale window;
 * opportunity and hype sweep their 0..100 ramps.
 */
export function rampGradientCss(mode: HeatMode, steps = 10): string {
  const colorAt = (t: number): string => {
    if (mode === "day") return dayColor((t - 0.5) * 0.1);
    if (mode === "hype") return hypeColor(t * 100);
    return opportunityColor(t * 100);
  };
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    parts.push(`${colorAt(t)} ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

export interface LegendSwatch {
  color: string;
  label: string;
}

/** Discrete legend swatches (low→high) for the active mode. */
export function legendForMode(mode: HeatMode): LegendSwatch[] {
  if (mode === "day") {
    return [
      { color: dayColor(-0.05), label: "−5%+" },
      { color: dayColor(-0.02), label: "−2%" },
      { color: dayColor(0), label: "flat" },
      { color: dayColor(0.02), label: "+2%" },
      { color: dayColor(0.05), label: "+5%+" },
    ];
  }
  if (mode === "hype") {
    return [
      { color: hypeColor(10), label: "Cooling" },
      { color: hypeColor(45), label: "Warming" },
      { color: hypeColor(68), label: "Heating" },
      { color: hypeColor(90), label: "On fire" },
    ];
  }
  return [
    { color: opportunityColor(30), label: "Weak" },
    { color: opportunityColor(50), label: "Mixed" },
    { color: opportunityColor(65), label: "Strong" },
    { color: opportunityColor(85), label: "Exceptional" },
  ];
}
