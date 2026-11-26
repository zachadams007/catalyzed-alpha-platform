import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import type { PortfolioQuote } from "@/types";

/**
 * Live-price overlay hooks.
 *
 * The daily research scan is shared + once-a-day; these hooks layer a live
 * price/day-change on TOP of it for the on-screen tickers (Alpaca IEX snapshots),
 * refreshing on view-open + manual click - never polling. The displayed number
 * ticks live; the opportunity score is never touched.
 */

/** The live overlay quote for one ticker, or undefined when none fetched yet. */
export function useLiveQuote(ticker: string | undefined): PortfolioQuote | undefined {
  const key = ticker?.trim().toUpperCase();
  return useAppStore((s) => (key ? s.livePrices[key] : undefined));
}

export interface LivePriceSync {
  /** Manually refresh the overlay for the bound tickers. */
  refresh: () => void;
  refreshing: boolean;
  /** ISO of the last successful overlay refresh (any surface), or null. */
  updatedAt: string | null;
  /**
   * Freshest underlying-data timestamp (`asOf`) across the bound tickers, or null.
   * Distinct from {@link updatedAt} (the fetch time) - this reflects how old the
   * actual market data is, so the badge can say "at close" honestly when stale.
   */
  dataAsOf: string | null;
  /** How many quotes the most recent refresh from THIS hook returned. */
  lastCount: number;
}

/**
 * Refresh the live-price overlay for `tickers` once when the set first appears
 * (when `auto`, the default) and on demand. Re-fires only when the ticker SET
 * changes - so scrolling/re-renders don't spam Alpaca.
 */
export function useLivePriceSync(tickers: string[], opts: { auto?: boolean } = {}): LivePriceSync {
  const auto = opts.auto ?? true;
  const refreshLivePrices = useAppStore((s) => s.refreshLivePrices);
  const updatedAt = useAppStore((s) => s.livePricesUpdatedAt);
  const livePrices = useAppStore((s) => s.livePrices);
  const [refreshing, setRefreshing] = useState(false);
  const [lastCount, setLastCount] = useState(0);
  const inFlight = useRef(false);

  // Stable, order-independent signature of the ticker set.
  const sig = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))]
    .sort()
    .join(",");

  // Freshest real data timestamp among the bound tickers (not the fetch time).
  const dataAsOf =
    sig
      .split(",")
      .map((t) => livePrices[t]?.asOf)
      .filter((v): v is string => !!v)
      .sort()
      .pop() ?? null;

  const run = useCallback(async () => {
    if (inFlight.current || !sig) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const n = await refreshLivePrices(sig.split(","));
      setLastCount(n);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [sig, refreshLivePrices]);

  const ranFor = useRef<string>("");
  useEffect(() => {
    if (!auto || !sig || ranFor.current === sig) return;
    ranFor.current = sig;
    void run();
  }, [auto, sig, run]);

  const refresh = useCallback(() => void run(), [run]);
  return { refresh, refreshing, updatedAt, dataAsOf, lastCount };
}
