import {
  emptySignalHistory,
  normalizeSignalHistory,
  type SignalHistory,
} from "@/engine/signalHistory";

/**
 * localStorage persistence for the daily {@link SignalHistory} (the EWMA +
 * estimate-revision substrate). Kept OUT of the Zustand persist blob on purpose:
 * it's a high-churn, append-only series that the engine reads/writes during a
 * research run (mirroring how the funnel's symbol list is cached), so coupling it
 * to the store's versioned snapshot would force a persist-version bump on every
 * shape tweak. Read/write never throw - a corrupt or unavailable store degrades
 * to an empty history, and the challenger simply behaves as if it's day 1.
 */

const SIGNAL_HISTORY_KEY = "catalyzed-alpha:signal-history:v1";

export function readSignalHistory(): SignalHistory {
  try {
    const raw = localStorage.getItem(SIGNAL_HISTORY_KEY);
    if (!raw) return emptySignalHistory();
    return normalizeSignalHistory(JSON.parse(raw));
  } catch {
    return emptySignalHistory();
  }
}

export function writeSignalHistory(history: SignalHistory): void {
  try {
    localStorage.setItem(SIGNAL_HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* storage full/unavailable - history accrual pauses; the feed is unaffected */
  }
}
