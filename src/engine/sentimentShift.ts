import type { CompanyData } from "@/types";
import { clamp, mean, round, stdev } from "@/lib/math";

/**
 * Sentiment-SHIFT (v2) - "recognize when the conversation is turning," scored as a
 * DELTA against the stock's OWN trailing baseline, not its static level.
 *
 * This is the computable form of the research's core method: the catchable edge is
 * an EARLY tone/attention inflection BEFORE it's obvious. Each component is a
 * z-score of today vs the stock's own trailing-20-day window - a loud absolute
 * level means nothing; a loud CHANGE vs its own normal does. The positive signal is
 * then gated MULTIPLICATIVELY for substance (real event + source diversity +
 * liquidity + persistence), which is what makes it "catalyst + hype WITH substance"
 * rather than chasing a pump.
 *
 * PURE + deterministic + cold-start safe: with no trailing history (the absent
 * `sentimentSeries`, or <2 observed days) it returns a flat neutral 50 and skips
 * the gates entirely - so on a cold start every name is 50, the cross-sectional
 * z-blend sees zero spread, and the dimension contributes nothing until real series
 * accrue. It never throws, never returns NaN, and never fabricates a trend.
 */

export interface SentimentShiftResult {
  /** 0..100 dimension score (50 = neutral / no measurable shift). */
  score: number;
  /** True when the trailing series was too thin to measure (→ neutral 50). */
  coldStart: boolean;
  /** True when the substance gate fired (positive shift WITHOUT a hard event) -
   *  surfaced as an "unconfirmed hype" watch-out on the card. */
  unconfirmedHype: boolean;
  /** Signed raw shift in σ units (−3..3), 0 ≈ no change vs its own baseline. */
  rawSigma: number;
  /** Plain-English lead driver for the feed tile, or "" when neutral. */
  lead: string;
}

const NEUTRAL: SentimentShiftResult = {
  score: 50,
  coldStart: true,
  unconfirmedHype: false,
  rawSigma: 0,
  lead: "",
};

/** Today's value vs the trailing baseline (all-but-last), in σ. 0 when <3 points
 *  or the baseline has no spread (cold/flat → no measurable change). */
function zVsBaseline(series: number[] | undefined): number {
  if (!series || series.length < 3) return 0;
  const last = series[series.length - 1]!;
  const baseline = series.slice(0, -1);
  const m = mean(baseline);
  const s = stdev(baseline);
  if (!(s > 0) || !Number.isFinite(last)) return 0;
  return clamp((last - m) / s, -3, 3);
}

/** Cumulative abnormal level over the last `days`, expressed in σ of the baseline. */
function cumulativeAbnormal(series: number[] | undefined, days = 5): number {
  if (!series || series.length < 3) return 0;
  const m = mean(series);
  const s = stdev(series);
  if (!(s > 0)) return 0;
  const tail = series.slice(-days);
  const abn = tail.reduce((sum, v) => sum + (v - m), 0) / (tail.length * s);
  return clamp(abn, -3, 3);
}

/** Distinct credible news domains in the trailing 7d (a diversity proxy). */
function distinctNewsSources(c: CompanyData): number {
  const domains = new Set<string>();
  for (const item of c.news?.items ?? []) {
    const src = (item.source ?? "").trim().toLowerCase();
    if (src) domains.add(src);
  }
  return domains.size;
}

/** Has a HARD corroborating event (not just chatter): real news, an 8-K, an
 *  insider cluster buy, or an activist filing. Drives the substance gate. */
function hardEventSignals(c: CompanyData): { substance: boolean; insider: boolean; activist: boolean } {
  const realNews = (c.news?.items ?? []).length > 0 && distinctNewsSources(c) > 0;
  const eightK = (c.secActivity?.eightKCount90d ?? 0) > 0;
  const insider = (c.secActivity?.form4BuyCount90d ?? 0) >= 3;
  const activist = (c.secActivity?.filings ?? []).some((f) =>
    String((f as { form?: string; type?: string }).form ?? (f as { type?: string }).type ?? "")
      .toUpperCase()
      .includes("13D"),
  );
  return { substance: realNews || eightK || insider || activist, insider, activist };
}

export function computeSentimentShift(c: CompanyData): SentimentShiftResult {
  const series = c.sentimentSeries;
  // Cold start: no usable trailing history → uniform neutral (zero spread in the
  // cross-section, so the dimension is inert until real series accrue).
  const primary = series?.socialPolarity ?? series?.newsTone;
  if (!series || !primary || primary.length < 2) return NEUTRAL;

  // --- Component z-scores vs the name's OWN trailing baseline. ---
  const dS = zVsBaseline(series.socialPolarity); // social-polarity Δ
  const dN = zVsBaseline(series.newsTone); // news-tone Δ
  const CAP = cumulativeAbnormal(series.socialPolarity, 5); // cumulative abnormal polarity
  const SV = zVsBaseline(series.socialVolume); // social-volume Δ
  const NV = zVsBaseline(series.newsVolume); // news/event-density Δ
  // Level news-tone (not a delta): a sustained positive tone, scaled to σ-ish.
  const toneNow = series.newsTone?.[series.newsTone.length - 1] ?? 0;
  const N = clamp(toneNow / 0.33, -3, 3);

  const raw = clamp(0.3 * dS + 0.2 * dN + 0.15 * CAP + 0.15 * SV + 0.1 * NV + 0.1 * N, -3, 3);

  // --- Directional boosts (0..1) that ADD corroboration; degrade to 0, never < 0. ---
  const { substance, insider, activist } = hardEventSignals(c);
  const INS = insider ? 1 : 0;
  const REV = 0; // early analyst-revision cluster - needs a paid revision feed; 0 at $0 (no false positives).
  const FIL = activist ? 1 : 0;
  // 5–10d relative strength (positive only) - proxied by the 3M RS we already compute.
  const RS = clamp((c.momentum?.relativeStrength3M ?? 0) / 0.1, 0, 1);
  const boost = 1 + 0.25 * INS + 0.2 * REV + 0.2 * FIL + 0.1 * RS;

  // --- Anti-hype gates (multiplicative; the heart of "hype WITH substance"). ---
  const SUBSTANCE = substance ? 1 : 0.3;
  const corroborators = distinctNewsSources(c) + (INS ? 1 : 0) + (FIL ? 1 : 0);
  const DIVERSITY = clamp(corroborators / 3, substance ? 1 / 3 : 0, 1);
  const CLEAN = 1; // no bot/coordination detector at $0 - never fabricate a manipulation penalty.
  const thin =
    (c.liquidity?.avgDollarVolume ?? 0) < 2_000_000 || (c.liquidity?.floatShares ?? 0) < 20_000_000;
  const LIQ = thin ? 0.5 : 1;
  // Persistence: the shift held for the last two observed days (both above baseline).
  const polar = series.socialPolarity ?? series.newsTone ?? [];
  const baseMean = polar.length > 2 ? mean(polar.slice(0, -1)) : 0;
  const heldTwoDays =
    polar.length >= 2 &&
    polar[polar.length - 1]! >= baseMean &&
    polar[polar.length - 2]! >= baseMean;
  const PERSIST = heldTwoDays ? 1 : 0.5;

  const unit = (raw + 3) / 6; // map −3..3 → 0..1 (0.5 = neutral)
  const turn = clamp(unit * boost * SUBSTANCE * DIVERSITY * CLEAN * LIQ * PERSIST, 0, 1);
  const score = round(turn * 100, 0);

  const positiveShift = raw > 0.25;
  const lead = !positiveShift
    ? ""
    : substance
      ? `Sentiment turning: tone ${raw >= 0 ? "+" : ""}${raw.toFixed(1)}σ vs its 20-day, on ${
          distinctNewsSources(c) || corroborators
        } source(s)`
      : "Attention rising (unconfirmed by a hard event)";

  return {
    score,
    coldStart: false,
    unconfirmedHype: positiveShift && !substance,
    rawSigma: round(raw, 2),
    lead,
  };
}
