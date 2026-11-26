import type { StockSignal } from "@/types";
import { isProviderResolutionPending, isSampleDataModeEnabled } from "@/data/providers";

/** Stable empty reference so the skeleton path never re-renders in a loop. */
export const EMPTY_SIGNALS: StockSignal[] = [];

/**
 * PRIME-DIRECTIVE render guard (pure, unit-testable). Fake/sample tickers must
 * NEVER paint as if real - not even for the loading flash. Returns the live
 * universe EXCEPT:
 *  - while the operator's global live/sample choice is still loading
 *    (`isProviderResolutionPending()`) → `[]` (surface shows its skeleton); and
 *  - when the in-memory universe is mock-sourced but sample mode is NOT the
 *    explicit, loaded operator choice (a pre-scrub / sample→live window) → `[]`
 *    so the fictional sample set (e.g. "ZNVTX / Novatryx AI Systems") can't flash.
 */
export function selectLiveSafeSignals(state: {
  signals: StockSignal[];
  signalsFromMock: boolean;
}): StockSignal[] {
  if (isProviderResolutionPending()) return EMPTY_SIGNALS;
  if (state.signalsFromMock && !isSampleDataModeEnabled()) return EMPTY_SIGNALS;
  return state.signals;
}
