import { useSyncExternalStore } from "react";
import { subscribeGlobalControls } from "@/data/globalControls";
import { getActiveVariant, type EngineVariantId } from "@/engine/challenger";

/**
 * The engine variant that is live RIGHT NOW, as a React subscription.
 *
 * `ACTIVE_VARIANT` in `@/engine/challenger` is a module-load snapshot: in the
 * browser it is evaluated before `app_controls` has been fetched, so it is the
 * build default ('challenger' = V5) whatever the operator promoted. Every label
 * derived from it - the lineage strip, the Algorithm-tab fine print - said "V5
 * LIVE" on 2026-09-21 while the feed was already ranking with V7. A label that
 * claims the wrong engine is running breaks the fidelity rule (model versions
 * are promotion state, not cosmetics), so live-version copy reads this hook,
 * which re-renders when the global controls resolve or change.
 */
export function useActiveVariant(): EngineVariantId {
  return useSyncExternalStore(subscribeGlobalControls, getActiveVariant, getActiveVariant);
}
