import type { EngineVariantId } from "./challenger";

/**
 * Operator's runtime engine-variant override - the bridge that makes the model
 * registry's "Promote" / "Rollback" actually change which engine is live.
 *
 * Standalone + localStorage-backed (like apiUsage / refreshLimiter), so the
 * engine can read it without importing the Zustand store (no cycle). The build
 * flag `VITE_ENGINE_VARIANT` is the DEFAULT; an operator promotion writes here to
 * take precedence on the next research run. Defensive (never throws into the
 * engine) and a no-op in non-browser test runs, so the build default still wins.
 */

const KEY = "catalyzed-alpha:engine-variant:v1";

export function getVariantOverride(): EngineVariantId | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "champion" || raw === "challenger" ? raw : null;
  } catch {
    return null;
  }
}

export function setVariantOverride(variant: EngineVariantId | null): void {
  try {
    if (variant == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, variant);
  } catch {
    /* storage unavailable - the build-flag default still governs the engine */
  }
}
