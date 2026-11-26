import type { StockSignal } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { selectLiveSafeSignals } from "@/store/liveSafeSelector";

/**
 * The ONLY signal source any user-facing universe surface (Today / Weekly / For
 * You / Market Map) should render from - the render-layer backstop for the
 * PRIME-DIRECTIVE invariant that fake/sample tickers never paint as if real.
 * See {@link selectLiveSafeSignals} for the gating rules.
 *
 * The store also fails closed at the source (merge never rehydrates the runtime
 * universe; `clearMockSignalsIfLive` scrubs on live-activate) - this hook ensures
 * a future code path can't reintroduce the leak at the render layer.
 */
export function useLiveSafeSignals(): StockSignal[] {
  return useAppStore(selectLiveSafeSignals);
}
