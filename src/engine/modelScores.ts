import type { ScoreCategoryKey, StockSignal } from "@/types";
import { clamp, round } from "@/lib/math";
import { CATEGORY_CONFIG } from "./scoringConfig";
import {
  INFLECTION_V2_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
  computeNormalizedScores,
  DISPLAY_CENTER,
  DISPLAY_SCALE,
  type NormalizationContext,
} from "./normalizeUniverse";
import type { EngineVariantId } from "./challenger";
import type { ModelId, OutcomeModelScore } from "./outcomeLedger";

/**
 * Build BOTH engine variants' scores for a freshly-published universe, so the
 * outcome ledger can record champion AND challenger against the identical price
 * and forward return. Both models are now cap-balanced cross-sectional rankings
 * over the SAME universe; they differ only in their normalization profile. After
 * the promotion the CHAMPION runs the catalyst-driven profile (thesis gate +
 * LANE-D blend + time-aware context) and the CHALLENGER is the curated base
 * (no thesis gate, no time-aware context). Pure: derives everything from the
 * signals' preserved RAW per-category scores, so it's correct whichever variant
 * is live - the ACTIVE variant's opportunity score is taken from the published
 * value exactly; the inactive variant's is reconstructed with its own profile.
 *
 * After the v2 promotion the CHAMPION runs the INFLECTION-v2 profile (catalyst-
 * driven base + thesis gate + LANE-D blend + time-aware context + per-name
 * cap-cohort weight routing) and the CHALLENGER is the previous catalyst-driven
 * model (the same base WITHOUT cohort routing) - so the rank-IC ledger measures v2
 * against the model it replaced.
 */

function rawCategoryScores(signal: StockSignal): Partial<Record<ScoreCategoryKey, number>> {
  const out: Partial<Record<ScoreCategoryKey, number>> = {};
  for (const cat of signal.score.categories) out[cat.key] = cat.score;
  return out;
}

export function buildModelScores(
  signals: StockSignal[],
  activeVariant: EngineVariantId,
  ctx?: NormalizationContext,
): Map<string, Partial<Record<ModelId, OutcomeModelScore>>> {
  // Reconstruct BOTH views from the preserved raw category scores. After the v2
  // promotion the CHAMPION runs the INFLECTION-v2 profile (it uses the SAME
  // time-aware context the live feed used, so its recorded score matches what was
  // published when the champion is live); the CHALLENGER is the previous
  // catalyst-driven profile (the same base, no cap-cohort weight routing).
  const championNorm = computeNormalizedScores(signals, ctx, INFLECTION_V2_NORMALIZATION);
  const challengerNorm = computeNormalizedScores(signals, ctx, REVERSAL_V5_NORMALIZATION);
  const map = new Map<string, Partial<Record<ModelId, OutcomeModelScore>>>();

  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]!;
    const cn = challengerNorm[i]!;
    const ch = championNorm[i]!;

    // The live variant's opportunity is authoritative (already published on the
    // signal); the counterfactual variant's is the freshly reconstructed score.
    const championOpportunity =
      activeVariant === "challenger" ? ch.opportunityScore : s.score.opportunityScore;
    const challengerOpportunity =
      activeVariant === "challenger" ? s.score.opportunityScore : cn.opportunityScore;

    const challengerCategories: Partial<Record<ScoreCategoryKey, number>> = {};
    for (const cfg of CATEGORY_CONFIG) {
      const z = cn.dimensionZ[cfg.key] ?? 0;
      challengerCategories[cfg.key] = clamp(round(DISPLAY_CENTER + DISPLAY_SCALE * z), 0, 100);
    }

    map.set(s.ticker, {
      champion: { opportunityScore: championOpportunity, categoryScores: rawCategoryScores(s) },
      challenger: {
        opportunityScore: challengerOpportunity,
        categoryScores: challengerCategories,
      },
    });
  }

  return map;
}
