import { create } from "zustand";

/**
 * Ticker Scope store - module-scope, NOT persisted.
 *
 * Mirrors `useResearchDeskStore`'s pattern: leaving the tab used to lose the
 * last-looked-up ticker because it lived only in the `?t=` URL param and local
 * `useState`. Lifting just the "last active ticker" here (module scope, not
 * component scope) means navigating to another tab and back within the same
 * session reopens Ticker Scope on that same ticker - no refetch needed, since
 * the resolved signal itself already lives in `useAppStore`'s persisted
 * `lookupCache`.
 *
 * Deliberately NOT persisted to localStorage: same reasoning as the Research
 * Desk - this is just a same-session "where was I" pointer, not data that
 * should survive an app restart.
 */
interface TickerBeaconState {
  /** The ticker Ticker Scope last resolved/showed. Null before any lookup. */
  activeTicker: string | null;
  setActiveTicker: (ticker: string | null) => void;
}

export const useTickerBeaconStore = create<TickerBeaconState>((set) => ({
  activeTicker: null,
  setActiveTicker: (ticker) => set({ activeTicker: ticker }),
}));

// Dev-only handle, mirrors window.__appStore / __researchDeskStore for the
// headless screenshot harness and manual console debugging.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __tickerBeaconStore?: typeof useTickerBeaconStore }).__tickerBeaconStore =
    useTickerBeaconStore;
}
