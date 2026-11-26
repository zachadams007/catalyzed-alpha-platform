import type { WatchlistAlert } from "@/types";
import type { CloudWatchItem } from "./watchlists";

/**
 * Pure merge/diff helpers for cross-device WATCHLIST sync. No store/Supabase
 * import so it stays trivially unit-testable (watchlistSync.ts wires these into
 * the live store + network). Mirrors notesMerge.ts.
 */

export interface WatchlistState {
  tickers: string[];
  alerts: Record<string, WatchlistAlert>;
}

/** Stable serialization (ticker-sorted) to detect real changes. */
export function serializeWatchlist(state: WatchlistState): string {
  const tickers = [...state.tickers].sort();
  return JSON.stringify(
    tickers.map((t) => [t, state.alerts[t] ?? null]),
  );
}

/**
 * Merge the local watchlist with the cloud rows. Pure + UNION-biased so a pull
 * NEVER silently drops a locally-added ticker (the user's "it keeps deleting"
 * complaint) - a remote removal only takes effect after a push deletes that row,
 * exactly like notesSync. Conflict resolution on the per-ticker ALERT is LWW
 * against the stamp we last synced.
 *
 *  - remote-only ticker → adopt it (restores the account's watchlist on a fresh
 *    device / after the local blob was lost).
 *  - local-only ticker  → keep it (never dropped by a pull; reconciling push
 *    persists it to the cloud).
 *  - both present       → keep the ticker; adopt the remote ALERT only when it is
 *    strictly newer than our last-synced stamp for that ticker.
 */
export function mergeWatchlist(
  local: WatchlistState,
  remote: CloudWatchItem[],
  knownStamps: Map<string, string>,
): WatchlistState {
  const tickers = new Set(local.tickers);
  const alerts: Record<string, WatchlistAlert> = { ...local.alerts };

  for (const r of remote) {
    const hadLocal = tickers.has(r.ticker);
    tickers.add(r.ticker); // union - never drop

    if (!hadLocal) {
      // Remote-only ticker: adopt it and its alert.
      if (r.alert) alerts[r.ticker] = r.alert;
      continue;
    }
    // Present on both: LWW on the alert.
    const stamp = knownStamps.get(r.ticker);
    const remoteNewer = stamp ? Date.parse(r.updatedAt) > Date.parse(stamp) : false;
    if (remoteNewer) {
      if (r.alert) alerts[r.ticker] = r.alert;
      else delete alerts[r.ticker];
    }
  }

  // Drop alerts for tickers no longer in the set (defensive).
  for (const t of Object.keys(alerts)) if (!tickers.has(t)) delete alerts[t];

  return { tickers: [...tickers], alerts };
}

/** The tickers whose membership or alert changed between two states. */
export function diffChangedTickers(next: WatchlistState, prev: WatchlistState): string[] {
  const keys = new Set([...next.tickers, ...prev.tickers]);
  const out: string[] = [];
  const sameAlert = (a?: WatchlistAlert, b?: WatchlistAlert) =>
    (a?.price ?? null) === (b?.price ?? null) && (a?.direction ?? null) === (b?.direction ?? null);
  for (const t of keys) {
    const inNext = next.tickers.includes(t);
    const inPrev = prev.tickers.includes(t);
    if (inNext !== inPrev || !sameAlert(next.alerts[t], prev.alerts[t])) out.push(t);
  }
  return out;
}
