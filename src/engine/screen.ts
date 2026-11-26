import type {
  RankingMode,
  ScoreCategoryKey,
  ScreenCriteria,
  ScreenFitComponents,
  ScreenGateResult,
  ScreenMatch,
  StockSignal,
  TradeHorizon,
} from "@/types";
import { TRADE_HORIZON_LABELS } from "@/types";
import { clamp, weightedAverage } from "@/lib/math";
import { CATEGORY_CONFIG } from "@/engine/scoringConfig";
import { buildNarrativeIntel, hasNicheIntent, scoreNarrativeMatch } from "@/engine/narrativeIntel";
import { researchRankScore } from "@/engine/ranking";

/**
 * Blueprint / portfolio discovery engine.
 *
 * Pure ranking over already-scored signals - narrative uses local theme expansion
 * (see narrativeIntel.ts). Optional external LLM lane is documented on Algorithm tab.
 */

export function normalizeHorizons(horizon: TradeHorizon | TradeHorizon[]): TradeHorizon[] {
  const list = Array.isArray(horizon) ? horizon : [horizon];
  return list.length > 0 ? list : ["position_trading"];
}

export function horizonCategoryWeights(
  horizon: TradeHorizon,
): Partial<Record<ScoreCategoryKey, number>> {
  switch (horizon) {
    case "scalping":
      return {
        volatility: 0.28,
        liquidity: 0.22,
        momentum: 0.2,
        news: 0.14,
        catalyst: 0.1,
        social: 0.06,
      };
    case "day_trading":
      return {
        catalyst: 0.28,
        news: 0.22,
        social: 0.18,
        momentum: 0.18,
        volatility: 0.08,
        fundamentals: 0.06,
      };
    case "swing_trading":
      return {
        momentum: 0.22,
        catalyst: 0.2,
        fundamentals: 0.16,
        growth: 0.16,
        news: 0.12,
        liquidity: 0.08,
      };
    case "position_trading":
      return {
        fundamentals: 0.24,
        growth: 0.24,
        liquidity: 0.14,
        momentum: 0.12,
        catalyst: 0.1,
        volatility: 0.08,
      };
    default:
      return {};
  }
}

/** Optional screening nudge when user picks scalping (research-only; not execution). */
export function scalpingCriteriaNudge(criteria: ScreenCriteria): ScreenCriteria {
  return {
    ...criteria,
    minCategoryScores: {
      ...criteria.minCategoryScores,
      volatility: Math.max(criteria.minCategoryScores?.volatility ?? 0, 55),
      liquidity: Math.max(criteria.minCategoryScores?.liquidity ?? 0, 50),
    },
  };
}

function categoryScore(signal: StockSignal, key: ScoreCategoryKey): number {
  return signal.score.categories.find((c) => c.key === key)?.score ?? 0;
}

/** The criteria the engine actually screens with (scalping adds vol/liquidity floors). */
export function effectiveScreenCriteria(
  horizon: TradeHorizon | TradeHorizon[],
  criteria: ScreenCriteria,
): ScreenCriteria {
  const horizons = normalizeHorizons(horizon);
  return horizons.includes("scalping") ? scalpingCriteriaNudge(criteria) : criteria;
}

const pctText = (v: number): string => `${Math.round(v * 100)}%`;

const dollarText = (v: number): string =>
  v >= 1_000_000_000
    ? `$${(v / 1_000_000_000).toFixed(1)}B`
    : v >= 1_000_000
      ? `$${Math.round(v / 1_000_000)}M`
      : `$${Math.round(v).toLocaleString()}`;

function categoryLabel(key: ScoreCategoryKey): string {
  return CATEGORY_CONFIG.find((c) => c.key === key)?.label ?? key;
}

/**
 * Keys of `signal.fundamentals` that are plain numeric percentages AND tracked
 * by `fundamentalsAvailability`. A live record seeds these to 0 with the
 * availability flag set `false` when the provider has no value
 * (see fundamentalsProvenance.unknownFundamentals); the screener must surface
 * that as "N/A", never the placeholder 0%.
 */
type NumericFundamentalKey = "revenueGrowthYoY" | "epsGrowthYoY" | "grossMargin";

/**
 * Build a fundamentals-backed gate that respects per-field availability.
 *
 * Pattern for ANY future fundamentals gate: compute availability FIRST and
 * mirror the display layer's `enrich.ts` `live()` helper - a field is available
 * unless `fundamentalsAvailability[key]` is explicitly `false`. (Absent map =>
 * sample/modeled universe keeps its existing modeled-value behavior.) When the
 * value is unavailable we emit `actual: "N/A"` and `unknown: true` so the UI
 * renders "N/A · data unavailable" and never a fabricated "0%". An unknown gate
 * is display-only: `summarizeGates` excludes it from the pass/fail tally so a
 * name with missing fundamentals is neither credited a real pass nor unfairly
 * demoted/zeroed.
 */
function fundamentalGate(
  key: string,
  label: string,
  signal: StockSignal,
  field: NumericFundamentalKey,
  min: number,
): ScreenGateResult {
  const avail = signal.fundamentalsAvailability?.[field] !== false;
  if (!avail) {
    return { key, label, pass: false, unknown: true, actual: "N/A", required: `≥ ${pctText(min)}` };
  }
  const value = signal.fundamentals[field];
  return {
    key,
    label,
    pass: value >= min,
    actual: pctText(value),
    required: `≥ ${pctText(min)}`,
  };
}

/**
 * Evaluate every ACTIVE hard-filter gate against one signal. This is the single
 * source of truth for hard filtering - `passesHardFilters` (and therefore
 * `screenSignals`) derives from it, so any UI built on these results explains
 * exactly what the engine did. Pass the same criteria the engine screens with
 * (see `effectiveScreenCriteria`).
 */
export function evaluateScreenGates(
  signal: StockSignal,
  criteria: ScreenCriteria,
): ScreenGateResult[] {
  const gates: ScreenGateResult[] = [];

  if (criteria.sectors?.length) {
    gates.push({
      key: "sectors",
      label: "Sector",
      pass: criteria.sectors.includes(signal.sector),
      actual: signal.sector,
      required: criteria.sectors.join(" / "),
    });
  }
  if (criteria.capBuckets?.length) {
    // A KNOWN cap that misses the selected buckets is a real fail (→ hard-removed
    // from the board). But an UNKNOWN cap (data gap - e.g. an AI-discovered name
    // hydrated keylessly) is display-only N/A, NOT a fail: don't bury a name just
    // because we couldn't fetch its size. Symmetric with `fundamentalGate`, and
    // it stops the recurring "the AI finds names then throws them away" bug.
    if (signal.marketCapBucket === "Unknown") {
      gates.push({
        key: "capBuckets",
        label: "Market cap",
        pass: false,
        unknown: true,
        actual: "—",
        required: criteria.capBuckets.join(" / "),
      });
    } else {
      gates.push({
        key: "capBuckets",
        label: "Market cap",
        pass: criteria.capBuckets.includes(signal.marketCapBucket),
        actual: signal.marketCapBucket,
        required: criteria.capBuckets.join(" / "),
      });
    }
  }
  if (criteria.riskLevels?.length) {
    gates.push({
      key: "riskLevels",
      label: "Risk level",
      pass: criteria.riskLevels.includes(signal.riskLevel),
      actual: signal.riskLevel,
      required: criteria.riskLevels.join(" / "),
    });
  }
  if (criteria.catalystTypes?.length) {
    gates.push({
      key: "catalystTypes",
      label: "Catalyst type",
      pass: criteria.catalystTypes.includes(signal.catalystType),
      actual: signal.catalystType,
      required: criteria.catalystTypes.join(" / "),
    });
  }
  if (criteria.minOpportunityScore != null) {
    gates.push({
      key: "minOpportunityScore",
      label: "Min opportunity",
      pass: signal.score.opportunityScore >= criteria.minOpportunityScore,
      actual: String(signal.score.opportunityScore),
      required: `≥ ${criteria.minOpportunityScore}`,
    });
  }
  if (criteria.minConfidence != null) {
    gates.push({
      key: "minConfidence",
      label: "Min confidence",
      pass: signal.confidence >= criteria.minConfidence,
      actual: String(signal.confidence),
      required: `≥ ${criteria.minConfidence}`,
    });
  }
  if (criteria.minRevenueGrowth != null) {
    gates.push(
      fundamentalGate(
        "minRevenueGrowth",
        "Revenue growth",
        signal,
        "revenueGrowthYoY",
        criteria.minRevenueGrowth,
      ),
    );
  }
  if (criteria.minEpsGrowth != null) {
    gates.push(
      fundamentalGate("minEpsGrowth", "EPS growth", signal, "epsGrowthYoY", criteria.minEpsGrowth),
    );
  }
  if (criteria.minGrossMargin != null) {
    gates.push(
      fundamentalGate(
        "minGrossMargin",
        "Gross margin",
        signal,
        "grossMargin",
        criteria.minGrossMargin,
      ),
    );
  }
  if (criteria.minAvgDollarVolume != null) {
    gates.push({
      key: "minAvgDollarVolume",
      label: "Dollar volume",
      pass: signal.liquidity.avgDollarVolume >= criteria.minAvgDollarVolume,
      actual: dollarText(signal.liquidity.avgDollarVolume),
      required: `≥ ${dollarText(criteria.minAvgDollarVolume)}`,
    });
  }
  if (criteria.maxShortInterestPct != null) {
    gates.push({
      key: "maxShortInterestPct",
      label: "Short interest",
      pass: signal.risk.shortInterestPct <= criteria.maxShortInterestPct,
      actual: pctText(signal.risk.shortInterestPct),
      required: `≤ ${pctText(criteria.maxShortInterestPct)}`,
    });
  }
  const pe = signal.fundamentals.peRatio;
  if (criteria.minPeRatio != null) {
    gates.push({
      key: "minPeRatio",
      label: "Min P/E",
      pass: pe != null && pe >= criteria.minPeRatio,
      actual: pe == null ? "N/A" : pe.toFixed(1),
      required: `≥ ${criteria.minPeRatio}`,
    });
  }
  if (criteria.maxPeRatio != null) {
    gates.push({
      key: "maxPeRatio",
      label: "Max P/E",
      pass: pe == null || pe <= criteria.maxPeRatio,
      actual: pe == null ? "N/A" : pe.toFixed(1),
      required: `≤ ${criteria.maxPeRatio}`,
    });
  }
  if (criteria.requireAboveSMA50) {
    gates.push({
      key: "requireAboveSMA50",
      label: "50-day SMA",
      pass: signal.momentum.aboveSMA50,
      actual: signal.momentum.aboveSMA50 ? "Above" : "Below",
      required: "Above",
    });
  }
  if (criteria.requireAboveSMA200) {
    gates.push({
      key: "requireAboveSMA200",
      label: "200-day SMA",
      pass: signal.momentum.aboveSMA200,
      actual: signal.momentum.aboveSMA200 ? "Above" : "Below",
      required: "Above",
    });
  }
  if (criteria.minNewsArticles7d != null) {
    gates.push({
      key: "minNewsArticles7d",
      label: "News volume",
      pass: signal.news.count7d >= criteria.minNewsArticles7d,
      actual: `${signal.news.count7d} in 7d`,
      required: `≥ ${criteria.minNewsArticles7d}`,
    });
  }
  if (criteria.minSocialMentions24h != null) {
    const mentions = signal.social.redditMentions24h + signal.social.xMentions24h;
    gates.push({
      key: "minSocialMentions24h",
      label: "Social mentions",
      pass: mentions >= criteria.minSocialMentions24h,
      actual: `${mentions} in 24h`,
      required: `≥ ${criteria.minSocialMentions24h}`,
    });
  }
  if (criteria.maxDaysToCatalyst != null) {
    gates.push({
      key: "maxDaysToCatalyst",
      label: "Catalyst window",
      pass: signal.catalyst.daysAway <= criteria.maxDaysToCatalyst,
      actual: `${signal.catalyst.daysAway}d away`,
      required: `≤ ${criteria.maxDaysToCatalyst}d`,
    });
  }
  if (criteria.minCategoryScores) {
    for (const [key, min] of Object.entries(criteria.minCategoryScores) as Array<
      [ScoreCategoryKey, number | undefined]
    >) {
      // The form parks cleared sliders as explicit `undefined` entries - an
      // inactive floor must not gate (score >= undefined is false for all).
      if (min == null) continue;
      gates.push({
        key: `cat:${key}`,
        label: categoryLabel(key),
        pass: categoryScore(signal, key) >= min,
        actual: String(categoryScore(signal, key)),
        required: `≥ ${min}`,
      });
    }
  }

  return gates;
}

interface GateSummary {
  passed: number;
  total: number;
  failed: ScreenGateResult[];
}

/**
 * Soft gate evaluation: how many ACTIVE hard filters a signal passes vs. fails.
 * Screening no longer removes signals that miss a gate - it demotes them (see
 * `screenSignals`), so a narrow filter combo can never empty the leaderboard.
 */
function summarizeGates(signal: StockSignal, criteria: ScreenCriteria): GateSummary {
  // Unknown gates (a fundamental the live feed doesn't carry) are display-only:
  // an unavailable metric is neither a real-value pass nor a fail, so it must
  // not move the pass/fail tally (filtersFitScore) or land in `failedGates`
  // (the UI would otherwise print it as a missed gate). It still appears in
  // `evaluateScreenGates` output so the console rail can show it as "N/A".
  const gates = evaluateScreenGates(signal, criteria).filter((g) => !g.unknown);
  const failed = gates.filter((g) => !g.pass);
  return { passed: gates.length - failed.length, total: gates.length, failed };
}

function horizonFitScore(signal: StockSignal, horizon: TradeHorizon): number {
  const weights = horizonCategoryWeights(horizon);
  let total = 0;
  let wSum = 0;
  for (const [key, w] of Object.entries(weights) as Array<[ScoreCategoryKey, number]>) {
    total += categoryScore(signal, key) * w;
    wSum += w;
  }
  return wSum > 0 ? total / wSum : signal.score.opportunityScore;
}

function multiHorizonFit(signal: StockSignal, horizons: TradeHorizon[]): number {
  if (horizons.length === 0) return signal.score.opportunityScore;
  let sum = 0;
  for (const h of horizons) sum += horizonFitScore(signal, h);
  return sum / horizons.length;
}

/** News + social + catalyst + mention velocity - “modern market attention”. */
export function hypeAttentionScore(signal: StockSignal): number {
  const newsCat = categoryScore(signal, "news");
  const socialCat = categoryScore(signal, "social");
  const catalystCat = categoryScore(signal, "catalyst");
  const mentions = signal.social.redditMentions24h + signal.social.xMentions24h;
  const mentionBurst = Math.min(100, 35 + Math.log10(mentions + 1) * 18 + signal.social.trendDelta * 22);
  const freshness = Math.max(0, 100 - signal.news.freshnessHours * 1.2);
  return Math.round(
    newsCat * 0.3 + socialCat * 0.28 + catalystCat * 0.22 + mentionBurst * 0.12 + freshness * 0.08,
  );
}

function nicheCapFitScore(signal: StockSignal, keywords: string[]): number {
  if (!hasNicheIntent(keywords)) return 50;
  switch (signal.marketCapBucket) {
    case "Nano":
    case "Micro":
      return 100;
    case "Small":
      return 92;
    case "Mid":
      return 68;
    case "Large":
      return 34;
    case "Mega":
      return 18;
    default:
      return 50;
  }
}

// ---------------------------------------------------------------------------
// Fit lanes
//
// Every screen computes ALL of these per signal (each 0..100) regardless of the
// active ranking mode, so the mode only changes the ORDER - never what the UI
// can explain. See docs/scoring-framework.md for the full contract.
// ---------------------------------------------------------------------------

/** Quality composite - the "Fundamentals only" lane. */
function fundamentalsFitScore(signal: StockSignal): number {
  return Math.round(
    weightedAverage([
      { score: categoryScore(signal, "fundamentals"), weight: 0.4 },
      { score: categoryScore(signal, "growth"), weight: 0.28 },
      { score: categoryScore(signal, "valuation"), weight: 0.2 },
      { score: categoryScore(signal, "liquidity"), weight: 0.12 },
    ]),
  );
}

/** Structured-filter satisfaction + horizon fit - the "filters" lane. */
function filtersFitScore(
  signal: StockSignal,
  horizons: TradeHorizon[],
  gate: GateSummary,
  nicheScore: number,
): number {
  const horizon = multiHorizonFit(signal, horizons);
  const gateRatio = gate.total > 0 ? gate.passed / gate.total : 1;
  const gateFit = 40 + gateRatio * 60; // passing every active gate is a strong structural fit
  const niche = nicheScore !== 50 ? nicheScore : horizon;
  return Math.round(
    weightedAverage([
      { score: horizon, weight: 0.5 },
      { score: gateFit, weight: 0.3 },
      { score: niche, weight: 0.2 },
    ]),
  );
}

/** AI research-agent relevance for a ticker, or null when none was supplied. */
function aiRelevanceFor(ticker: string, aiRelevance?: Record<string, number>): number | null {
  const v = aiRelevance?.[ticker.toUpperCase()];
  return typeof v === "number" ? Math.round(clamp(v, 0, 100)) : null;
}

interface FitContext {
  mode: RankingMode;
  horizons: TradeHorizon[];
  criteria: ScreenCriteria;
  nicheKeywords: string[];
  narrativeStrength: number;
  aiRelevance?: Record<string, number>;
}

/** Blended fit: description + structured filters + fundamentals fused (+ theme/hype/AI). */
function blendedFitScore(comp: ScreenFitComponents, ctx: FitContext): number {
  const preferHype = ctx.criteria.preferHype === true;
  const narrativeBoost =
    Math.min(1, (ctx.criteria.narrativeWeight ?? 50) / 100) * (ctx.narrativeStrength / 100);
  // `fundamentals` is held at 0.14 on purpose - quality still matters, so a name doesn't
  // dominate JUST for being on-theme (no bad-but-quantum picks). The general `filters`/horizon
  // lane and `hype` give a little room back.
  const pairs = [
    { score: comp.filters, weight: (preferHype ? 0.26 : 0.34) - narrativeBoost * 0.12 },
    { score: comp.theme, weight: 0.2 + narrativeBoost * 0.2 },
    { score: comp.description, weight: 0.14 + narrativeBoost * 0.12 },
    { score: comp.fundamentals, weight: 0.14 },
    { score: comp.hype, weight: preferHype ? 0.2 : 0.08 },
  ];
  if (comp.ai != null) pairs.push({ score: comp.ai, weight: 0.16 });
  return Math.round(weightedAverage(pairs));
}

/** Resolve the single fit number used to RANK, per the active mode. */
function modeFitScore(comp: ScreenFitComponents, ctx: FitContext): number {
  switch (ctx.mode) {
    case "fundamentals":
      return comp.fundamentals;
    case "ai":
      // Hosted agent relevance when present; otherwise approximate the agent's
      // view locally (description + theme) so the mode still ranks offline.
      if (comp.ai != null) return comp.ai;
      return Math.round(
        weightedAverage([
          { score: comp.description, weight: 0.6 },
          { score: comp.theme, weight: 0.4 },
        ]),
      );
    case "blended":
    default:
      return blendedFitScore(comp, ctx);
  }
}

function buildReasons(
  signal: StockSignal,
  comp: ScreenFitComponents,
  gate: GateSummary,
  ctx: FitContext,
  themeHits: string[],
  descHits: string[],
): string[] {
  const reasons: string[] = [];

  // Lead with WHY this name ranks where it does under the active mode.
  switch (ctx.mode) {
    case "fundamentals":
      reasons.push(`Quality fit ${comp.fundamentals}`);
      break;
    case "ai":
      reasons.push(comp.ai != null ? `AI relevance ${comp.ai}` : `AI proxy fit ${modeFitScore(comp, ctx)}`);
      break;
    default: {
      const horizonLabel =
        ctx.horizons.length === 1 ? TRADE_HORIZON_LABELS[ctx.horizons[0]!] : `${ctx.horizons.length} horizons`;
      reasons.push(`${horizonLabel} fit ${comp.filters}`);
    }
  }

  // Surface theme / description evidence when it isn't already the lead reason.
  if (themeHits.length > 0) {
    reasons.push(`Theme: ${themeHits.slice(0, 2).join(", ")}`);
  } else if (descHits.length > 0) {
    reasons.push(`Matches: ${descHits.slice(0, 2).join(", ")}`);
  }

  // Be honest about a weak (demoted) match and exactly which filters it missed.
  if (gate.failed.length > 0) {
    reasons.push(`Weak match — missed ${gate.failed.slice(0, 2).map((g) => g.label).join(", ")}`);
  }

  if (ctx.criteria.preferHype && comp.hype >= 60) reasons.push(`Attention ${comp.hype}`);

  const top = [...signal.score.categories].sort((a, b) => b.score - a.score)[0];
  if (top) reasons.push(`Strong ${top.label.toLowerCase()} (${top.score})`);
  if (signal.confidence < 55) reasons.push(`Thin evidence ${signal.confidence}%`);

  return reasons.slice(0, 4);
}

/**
 * Rank a scored universe for a Blueprint screen.
 *
 * Screening is SOFT: every signal is scored and returned in best-fit order.
 * Signals that miss one or more active hard filters are flagged `weakMatch` and
 * demoted below full matches - never removed. The result is therefore ALWAYS a
 * non-empty, ordered list of best-fit names whenever the universe has any
 * stocks (the old behavior could return zero on a narrow filter combo).
 *
 * `criteria.rankingMode` selects how results order (default `blended`). The
 * optional `aiRelevance` map (ticker → 0..100) feeds the AI modes when a hosted
 * research agent is configured; without it the AI modes fall back to a local
 * description/theme match so they still rank meaningfully offline.
 */
export function screenSignals(
  signals: StockSignal[],
  horizon: TradeHorizon | TradeHorizon[],
  criteria: ScreenCriteria,
  narrative?: string,
  aiRelevance?: Record<string, number>,
): ScreenMatch[] {
  const horizons = normalizeHorizons(horizon);
  const effectiveCriteria = effectiveScreenCriteria(horizons, criteria);
  const mode = effectiveCriteria.rankingMode ?? "blended";

  // Separate the curated theme-tag evidence from the free-text description so
  // each still reports as its own fit lane (components.theme / .description)
  // even though only `blended` fuses them into the ranking now.
  const combined = buildNarrativeIntel(
    narrative ?? "",
    effectiveCriteria.themeTags,
    effectiveCriteria.keywords,
  );
  const themeKeywords = buildNarrativeIntel("", effectiveCriteria.themeTags, []).keywords;
  const descKeywords = buildNarrativeIntel(narrative ?? "", undefined, effectiveCriteria.keywords).keywords;

  const ctx: FitContext = {
    mode,
    horizons,
    criteria: effectiveCriteria,
    nicheKeywords: combined.keywords,
    narrativeStrength: combined.narrativeStrength,
    aiRelevance,
  };

  const matches: ScreenMatch[] = signals.map((signal) => {
    const gate = summarizeGates(signal, effectiveCriteria);
    const themeMatch = scoreNarrativeMatch(signal, themeKeywords);
    const descMatch = scoreNarrativeMatch(signal, descKeywords);
    const nicheScore = nicheCapFitScore(signal, ctx.nicheKeywords);
    const components: ScreenFitComponents = {
      fundamentals: fundamentalsFitScore(signal),
      theme: themeMatch.score,
      description: descMatch.score,
      filters: filtersFitScore(signal, horizons, gate, nicheScore),
      hype: hypeAttentionScore(signal),
      ai: aiRelevanceFor(signal.ticker, aiRelevance),
    };
    const fitScore = Math.round(clamp(modeFitScore(components, ctx), 0, 100));

    return {
      signal,
      fitScore,
      reasons: buildReasons(signal, components, gate, ctx, themeMatch.hits, descMatch.hits),
      mode,
      components,
      weakMatch: gate.failed.length > 0,
      failedGates: gate.failed,
      gatesPassed: gate.passed,
      gatesTotal: gate.total,
    };
  });

  // Soft ranking: full matches first, then weak matches (closest first), each
  // ordered by fit with an opportunity-score tiebreak. Screening NEVER drops a
  // signal, so the list is only empty when the universe itself is empty.
  matches.sort((a, b) => {
    if (a.weakMatch !== b.weakMatch) return a.weakMatch ? 1 : -1;
    if (a.weakMatch && a.gatesTotal > 0 && b.gatesTotal > 0) {
      const ra = a.gatesPassed / a.gatesTotal;
      const rb = b.gatesPassed / b.gatesTotal;
      if (rb !== ra) return rb - ra;
    }
    return b.fitScore - a.fitScore || researchRankScore(b.signal) - researchRankScore(a.signal);
  });

  // `maxResults` is a soft "show top N" knob, not a hard cap on the universe.
  // Unset → return the full ranked list (no artificial ceiling).
  const cap = effectiveCriteria.maxResults;
  return typeof cap === "number" && cap > 0 ? matches.slice(0, cap) : matches;
}

/**
 * Default Blueprint criteria: intentionally unconstrained so the screen starts
 * against the whole live universe with NO result cap - "show top N" is opt-in.
 * No theme tags are pre-selected (the user chooses their own narrative angle);
 * every hard filter is opt-in via "Include filter".
 */
export function defaultBlueprintCriteria(): ScreenCriteria {
  return {
    rankingMode: "blended",
    narrativeWeight: 65,
  };
}

/** Default criteria tuned for “next NVIDIA” small-cap growth style screens. */
export function defaultGrowthScreenCriteria(): ScreenCriteria {
  return {
    capBuckets: ["Nano", "Micro", "Small", "Mid"],
    themeTags: ["ai", "quantum", "robotics"],
    minRevenueGrowth: 0.12,
    minOpportunityScore: 48,
    minCategoryScores: { growth: 50, momentum: 45 },
    narrativeWeight: 65,
  };
}

/** Re-export for HUD / forms. */
export { previewNarrativeChips } from "@/engine/narrativeIntel";
