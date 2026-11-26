import { useSyncExternalStore } from "react";
import { subscribeGlobalControls } from "@/data/globalControls";
import {
  isSampleDataModeEnabled,
  subscribeSampleDataMode,
} from "@/data/providers/sampleDataMode";

/**
 * Reactive sample-data-mode for components that must SUPPRESS sample-origin data
 * in live mode.
 *
 * Reading `isSampleDataModeEnabled()` imperatively at render time is a footgun for
 * suppression logic: the effective mode flips from the fail-closed pre-load value
 * (sample ON) to the operator's real choice once `initGlobalControls()` resolves,
 * but a plain imperative read snapshots the OLD value and the component never
 * re-renders when the controls land. A card that decided "sample mode is on, show
 * the seeded numbers" during that pending window then keeps showing fabricated
 * targets under a "Live data" badge.
 *
 * This hook subscribes to BOTH the device-local sample toggle
 * (`subscribeSampleDataMode`, fired by the Operator Console) and the global
 * controls load/realtime channel (`subscribeGlobalControls`, fired when the
 * operator's `app_controls` row resolves) via `useSyncExternalStore`, so any
 * pending→live (or live↔sample) transition re-renders the consumer immediately -
 * no stale read, no app restart.
 */
export function useSampleDataMode(): boolean {
  return useSyncExternalStore(subscribe, isSampleDataModeEnabled, isSampleDataModeEnabled);
}

function subscribe(onChange: () => void): () => void {
  const unsubSample = subscribeSampleDataMode(onChange);
  const unsubControls = subscribeGlobalControls(onChange);
  return () => {
    unsubSample();
    unsubControls();
  };
}
