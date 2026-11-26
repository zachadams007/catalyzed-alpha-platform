/** Small, dependency-free numeric helpers used by the scoring engine. */

export function clamp(value: number, min = 0, max = 100): number {
  // Finite-safe: a NaN/±Infinity sub-score must never survive into a score or a
  // ranking key. `Math.min(max, Math.max(min, NaN)) === NaN` (NaN poisons both
  // comparisons), so without this guard a single bad sub-score (e.g. momentum
  // when rsi is NaN, or liquidity when log10(neg)=NaN) would flow through
  // `round(clamp(score))` ungated and silently corrupt cross-sectional ranks for
  // the WHOLE universe. We collapse a non-finite input to the lower bound - the
  // same neutral-floor treatment a missing/gated sub-score already gets.
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Map `value` from the input range [inMin, inMax] onto [outMin, outMax],
 * clamped to the output range. The backbone of every sub-score.
 */
export function scaleLinear(
  value: number,
  inMin: number,
  inMax: number,
  outMin = 0,
  outMax = 100,
): number {
  if (inMax === inMin) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  return clamp(lerp(outMin, outMax, t), Math.min(outMin, outMax), Math.max(outMin, outMax));
}

/**
 * Score a value that has an ideal "sweet spot". Values at `ideal` score 100;
 * scores fall off linearly toward 0 at `ideal - span` and `ideal + span`.
 * Used for things like RSI (great around 55-65, bad when overbought/oversold)
 * and volatility (we want elevated-but-tradable, not dead or uninvestable).
 */
export function scaleBand(value: number, ideal: number, span: number): number {
  const distance = Math.abs(value - ideal);
  return clamp(100 * (1 - distance / span), 0, 100);
}

/** Weighted average of {score, weight} pairs. Returns 0 when weights sum to 0. */
export function weightedAverage(pairs: Array<{ score: number; weight: number }>): number {
  const totalWeight = pairs.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight === 0) return 0;
  const weighted = pairs.reduce((sum, p) => sum + p.score * p.weight, 0);
  return weighted / totalWeight;
}

/** Deterministic pseudo-random in [0,1) from a string seed (stable per run). */
export function seededRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // xorshift to spread the bits
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return ((h >>> 0) % 100000) / 100000;
}

// ---------------------------------------------------------------------------
// Cross-sectional statistics (challenger normalization, src/engine)
//
// These power the anti-megacap normalization pass: per-dimension winsorize →
// rank-based inverse-normal, plus size residualization. All are PURE and
// dependency-free so the daily research cache stays deterministic. They operate
// on plain number arrays and never assume finiteness beyond what their callers
// guarantee (the engine feeds them finite 0..100 sub-scores).
// ---------------------------------------------------------------------------

/** Arithmetic mean. Returns 0 for an empty array. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Replace every non-finite (NaN / ±Infinity) entry with a neutral stand-in so a
 * single stray value can never reorder the array. The stand-in is the mean of the
 * FINITE entries (which keeps a sanitized value rank-neutral), or 0 when there is
 * nothing finite to average. Returns a new array; the input is not mutated.
 *
 * This is the second line of defence behind a finite-safe {@link clamp}: the
 * cross-sectional ranking helpers below sort/regress over these arrays, and their
 * comparators (`(a, b) => values[a] - values[b]`) treat a NaN difference as 0,
 * which silently mis-orders indices and poisons percentile ranks / z-scores /
 * regression slopes for the WHOLE universe. Sanitizing up front makes that
 * impossible regardless of how a NaN got into the dimension array.
 */
export function sanitizeFinite(values: number[]): number[] {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
  }
  if (count === values.length) return values; // all finite - nothing to do
  const fill = count > 0 ? sum / count : 0;
  return values.map((v) => (Number.isFinite(v) ? v : fill));
}

/**
 * Exponentially-weighted moving average of a time series (oldest → newest),
 * returning the CURRENT smoothed value. `halfLifeDays` is the half-life in the
 * series' own step units: a recent spike decays to half its weight after that
 * many steps, so one loud headline can't dominate the day-to-day reading. NaN
 * for an empty series; the single-point series returns itself.
 */
export function ewma(series: number[], halfLifeDays: number): number {
  if (series.length === 0) return NaN;
  if (series.length === 1) return series[0]!;
  const halfLife = halfLifeDays > 0 ? halfLifeDays : 1;
  const alpha = 1 - Math.exp(-Math.LN2 / halfLife);
  let acc = series[0]!;
  for (let i = 1; i < series.length; i++) acc = alpha * series[i]! + (1 - alpha) * acc;
  return acc;
}

/** Population standard deviation. Returns 0 for an empty array. */
export function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Median of a copy of `values` (input is not mutated). NaN when empty. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The q-quantile (0..1) of an already-ascending array via linear interpolation
 *  between closest ranks (the numpy/R type-7 default). NaN when empty. */
function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const pos = (n - 1) * clamp(q, 0, 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Winsorize: clamp each value into the [lo, hi] quantile band of the array, so a
 * handful of extreme outliers can't dominate a downstream normalization. `lo`
 * and `hi` are fractions in [0,1] (defaults 5% / 95%). Returns a new array in the
 * original order; an array shorter than two elements is returned unchanged.
 */
export function winsorize(values: number[], lo = 0.05, hi = 0.95): number[] {
  if (values.length < 2) return [...values];
  values = sanitizeFinite(values); // a stray NaN must not reorder the band
  const sorted = [...values].sort((a, b) => a - b);
  const loVal = quantileSorted(sorted, Math.min(lo, hi));
  const hiVal = quantileSorted(sorted, Math.max(lo, hi));
  return values.map((v) => (v < loVal ? loVal : v > hiVal ? hiVal : v));
}

/**
 * Fractional rank of each element in (0,1), using **midranks** for ties and the
 * Weibull plotting position `rank / (n + 1)`. The open interval is deliberate:
 * the smallest value maps to `1/(n+1)` and the largest to `n/(n+1)`, never
 * exactly 0 or 1 - so the result is always safe to feed into {@link invNormalCdf}
 * (which would otherwise hit ±∞ at the boundaries). A single element maps to 0.5.
 */
export function percentileRank(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  values = sanitizeFinite(values); // a NaN comparator returns NaN → mis-ordered ranks
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]!]! === values[order[i]!]!) j++;
    // 1-based positions i+1..j+1 share the same value → assign their midrank.
    const midrank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[order[k]!] = midrank;
    i = j + 1;
  }
  return ranks.map((r) => r / (n + 1));
}

// Acklam's rational approximation to the inverse normal CDF. Relative error
// < ~1.15e-9 across the whole domain with no refinement step or dependencies.
const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239e0,
];
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0,
  4.374664141464968e0, 2.938163982698783e0,
];
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0,
];
const ACKLAM_P_LOW = 0.02425;

/**
 * Inverse normal CDF (probit): the z-score whose standard-normal cumulative
 * probability is `p`. `p` is clamped to a tiny interior window so the result is
 * always finite (it never returns ±∞), which keeps blends downstream NaN-free.
 * z(0.5) = 0, z(0.975) ≈ 1.96.
 */
export function invNormalCdf(p: number): number {
  const x = clamp(p, 1e-12, 1 - 1e-12);
  if (x < ACKLAM_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(x));
    return (
      (((((ACKLAM_C[0]! * q + ACKLAM_C[1]!) * q + ACKLAM_C[2]!) * q + ACKLAM_C[3]!) * q +
        ACKLAM_C[4]!) *
        q +
        ACKLAM_C[5]!) /
      ((((ACKLAM_D[0]! * q + ACKLAM_D[1]!) * q + ACKLAM_D[2]!) * q + ACKLAM_D[3]!) * q + 1)
    );
  }
  if (x <= 1 - ACKLAM_P_LOW) {
    const q = x - 0.5;
    const r = q * q;
    return (
      ((((((ACKLAM_A[0]! * r + ACKLAM_A[1]!) * r + ACKLAM_A[2]!) * r + ACKLAM_A[3]!) * r +
        ACKLAM_A[4]!) *
        r +
        ACKLAM_A[5]!) *
        q) /
      (((((ACKLAM_B[0]! * r + ACKLAM_B[1]!) * r + ACKLAM_B[2]!) * r + ACKLAM_B[3]!) * r +
        ACKLAM_B[4]!) *
        r +
        1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - x));
  return -(
    (((((ACKLAM_C[0]! * q + ACKLAM_C[1]!) * q + ACKLAM_C[2]!) * q + ACKLAM_C[3]!) * q +
      ACKLAM_C[4]!) *
      q +
      ACKLAM_C[5]!) /
    ((((ACKLAM_D[0]! * q + ACKLAM_D[1]!) * q + ACKLAM_D[2]!) * q + ACKLAM_D[3]!) * q + 1)
  );
}

/**
 * Robust center & scale: the median and the Median Absolute Deviation (MAD). The
 * MAD is returned RAW (not scaled by 1.4826) - callers that want a normal-
 * consistent robust σ multiply by 1.4826 themselves. NaN/NaN for an empty array.
 */
export function medianMAD(values: number[]): { median: number; mad: number } {
  if (values.length === 0) return { median: NaN, mad: NaN };
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  return { median: med, mad };
}

/**
 * OLS residuals of `ys` regressed on `xs` (closed-form simple linear regression):
 * removes the part of `ys` linearly explained by `xs`, leaving the size-neutral
 * remainder. Used to strip a dimension's dependence on `log(marketCap)` so a
 * megacap's coverage/volume edge doesn't leak into the score. When `xs` has zero
 * variance (nothing to regress on) the residuals collapse to mean-centered `ys`.
 * Returns a copy of `ys` unchanged when the inputs are empty or mismatched.
 */
export function residualize(ys: number[], xs: number[]): number[] {
  const n = ys.length;
  if (n === 0 || xs.length !== n) return [...ys];
  // A stray NaN in either series poisons the regression slope/intercept (and so
  // every residual), reordering the universe. Neutralize before regressing.
  ys = sanitizeFinite(ys);
  xs = sanitizeFinite(xs);
  const meanX = mean(xs);
  const meanY = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - meanY);
  }
  if (sxx === 0) return ys.map((y) => y - meanY);
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  return ys.map((y, i) => y - (intercept + slope * xs[i]!));
}
