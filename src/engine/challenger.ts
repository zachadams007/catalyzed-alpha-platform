import type { StockSignal } from "@/types";
import {
  INFLECTION_V2_NORMALIZATION,
  MISUNDERSTOOD_V6_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
  SYNTHESIS_V7_NORMALIZATION,
  normalizeUniverse,
  type NormalizationContext,
  type NormalizationOptions,
} from "./normalizeUniverse";
import { getVariantOverride } from "./variantOverride";
import { getGlobalControls, isGlobalControlsConfigured } from "@/data/globalControls";

/**
 * Champion / challenger engine variants.
 *
 * Both models sweep the same full universe and both run the same cap-balanced
 * cross-sectional ranking pass. They differ only by normalization profile:
 * - champion: V4 rollback baseline, `INFLECTION_V2_NORMALIZATION`.
 * - challenger: live V5, `REVERSAL_V5_NORMALIZATION`.
 *
 * Selection comes from the app-wide operator control row when Supabase is
 * configured, then the build flag, then the local dev override. The build default
 * is V5/challenger.
 */

export type EngineVariantId = "champion" | "challenger" | "v6" | "v7";

export const ENGINE_VARIANTS: EngineVariantId[] = ["champion", "challenger", "v6", "v7"];

export const VARIANT_LABELS: Record<EngineVariantId, string> = {
  champion: "Champion",
  challenger: "Challenger",
  v6: "V6 misunderstood-quality",
  v7: "V7 synthesis",
};

/**
 * The short VERSION tag each variant shows on a recorded pick ("V5", "V7"), so
 * the Track Record can tell which engine made a call. Distinct from
 * {@link VARIANT_LABELS}, which are the operator-facing role names
 * (Champion / Challenger) rather than version numbers.
 */
export const VARIANT_VERSION_TAGS: Record<EngineVariantId, string> = {
  champion: "V4",
  challenger: "V5",
  v6: "V6",
  v7: "V7",
};

/** The build-flag default, from `VITE_ENGINE_VARIANT` (default V5/challenger). */
function readBuildVariant(): EngineVariantId {
  const raw = (import.meta.env.VITE_ENGINE_VARIANT as string | undefined)?.trim().toLowerCase();
  if (raw === "champion") return "champion";
  if (raw === "v6") return "v6";
  if (raw === "v7") return "v7";
  return "challenger";
}

/**
 * The variant the engine runs right now. Read live so a promotion takes effect
 * without a rebuild. The live feed only moves on a deliberate operator action
 * or build flag.
 */
export function getActiveVariant(): EngineVariantId {
  if (isGlobalControlsConfigured()) {
    return getGlobalControls()?.activeVariant ?? readBuildVariant();
  }
  return getVariantOverride() ?? readBuildVariant();
}

/**
 * Snapshot of the active variant at module load. Used by surfaces that want a
 * stable value for a render pass; engine hot paths call `getActiveVariant`.
 */
export const ACTIVE_VARIANT: EngineVariantId = getActiveVariant();

export function isChallenger(variant: EngineVariantId = getActiveVariant()): boolean {
  return variant === "challenger";
}

/**
 * Whether `variant` runs the V4 catalyst/archetype profile. V5 layers its
 * reversal-first changes on top through `REVERSAL_V5_NORMALIZATION`, so this
 * helper remains tied to the V4 rollback slot for legacy explainer facts.
 */
export function runsCatalystDrivenProfile(
  variant: EngineVariantId = getActiveVariant(),
): boolean {
  return variant === "champion";
}

/**
 * Post-scoring, pre-ranking hook. Pure: returns a new array and never mutates
 * the input. `champion` is the V4 rollback baseline; `challenger` is the live V5
 * reversal-first profile.
 */
export function postProcessUniverse(
  signals: StockSignal[],
  variant: EngineVariantId = getActiveVariant(),
  ctx?: NormalizationContext,
): StockSignal[] {
  return normalizeUniverse(signals, ctx, NORMALIZATION_FOR_VARIANT[variant]);
}

/** The normalization profile each engine variant runs. Single source of truth so
 *  the app, the daily scan, and the offline reports can never drift apart. */
export const NORMALIZATION_FOR_VARIANT: Record<EngineVariantId, NormalizationOptions> = {
  champion: INFLECTION_V2_NORMALIZATION,
  challenger: REVERSAL_V5_NORMALIZATION,
  v6: MISUNDERSTOOD_V6_NORMALIZATION,
  v7: SYNTHESIS_V7_NORMALIZATION,
};
