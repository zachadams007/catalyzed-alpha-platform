import { useMemo } from "react";
import { useAppStore } from "@/store/useAppStore";

/**
 * The set of tickers the user has a stake in - everything WATCHLISTED plus every
 * HOLDING across their portfolios, upper-cased for case-insensitive matching.
 * Drives where the honest negative badges + "Watch-outs today" strip apply: we
 * only surface downside on names the user actually cares about, not the whole
 * universe (the feed already leads with opportunity).
 */
export function useOwnedTickers(): Set<string> {
  const watchlist = useAppStore((s) => s.watchlist);
  const portfolios = useAppStore((s) => s.portfolios);
  return useMemo(() => {
    const set = new Set<string>();
    for (const t of watchlist) set.add(t.toUpperCase());
    for (const p of portfolios) {
      for (const h of p.holdings) set.add(h.ticker.toUpperCase());
    }
    return set;
  }, [watchlist, portfolios]);
}
