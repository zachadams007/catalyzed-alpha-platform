import { createJSONStorage, type StateStorage } from "zustand/middleware";

/**
 * Quota-safe localStorage for the persisted app store.
 *
 * The bug: zustand's persist middleware writes the WHOLE partialized store to
 * localStorage on every `set()`. As the persisted payload grows (cached signals,
 * run history, lookup cache, interaction log), a write eventually exceeds the
 * browser's ~5MB localStorage quota and `setItem` throws `QuotaExceededError`.
 *
 * That throw is the real, broad root cause of the "blank/main screen, reload
 * required" crash: persisted writes are triggered from inside React effects
 * (e.g. StockDetail caching analyst coverage, applyResearchResult). A synchronous
 * throw during a commit/passive-effect phase unmounts the ENTIRE React tree -
 * every tab then dead-screens until a full reload re-mounts the root.
 *
 * Fix: never let persistence throw into React. On a quota failure we shed the
 * largest, fully-recomputable slices (cached signals, history, caches) and retry;
 * if it still fails we drop the write entirely. Losing a cache entry is harmless
 * (it's re-fetched); crashing the whole app is not.
 */

// Persisted keys that are pure caches / recomputable history. Shed these first,
// largest-impact first, when we're over quota. User-owned data (portfolios,
// watchlist, preferences, notes) is never dropped here.
const SHEDDABLE_KEYS = [
  "lookupCache",
  "runHistory",
  "interactions",
  "signals",
  "researchRunLog",
  "outcomeLedger",
] as const;

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException) && !(err instanceof Error)) return false;
  const name = (err as { name?: string }).name ?? "";
  const code = (err as { code?: number }).code;
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

/**
 * Try to write `value`. On quota failure, progressively trim recomputable slices
 * from the persisted JSON and retry. Returns silently if nothing works - a failed
 * cache write must never propagate as a thrown error.
 */
function safeSetItem(name: string, value: string): void {
  try {
    window.localStorage.setItem(name, value);
    return;
  } catch (err) {
    if (!isQuotaError(err)) {
      // Non-quota failure (private mode, disabled storage): swallow - the app
      // works without persistence, and throwing here would crash the tree.
      console.warn(`[safeStorage] non-quota write failure for ${name}; skipping persist.`, err);
      return;
    }
  }

  // Quota path: parse, shed slices, retry after each shed.
  let parsed: { state?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }

  if (parsed && parsed.state && typeof parsed.state === "object") {
    for (const key of SHEDDABLE_KEYS) {
      if (!(key in parsed.state)) continue;
      const slice = parsed.state[key];
      // Empty it (preserve the shape: array → [], object → {}).
      parsed.state[key] = Array.isArray(slice) ? [] : {};
      try {
        window.localStorage.setItem(name, JSON.stringify(parsed));
        console.warn(
          `[safeStorage] localStorage quota exceeded — shed "${key}" to fit the write.`,
        );
        return;
      } catch (retryErr) {
        if (!isQuotaError(retryErr)) {
          console.warn(`[safeStorage] write failed after shedding ${key}; skipping.`, retryErr);
          return;
        }
        // still over quota → shed the next slice and retry
      }
    }
  }

  // Last resort: drop the existing key so the NEXT write has room, and skip this
  // one. The store keeps running in memory; nothing user-visible breaks.
  try {
    window.localStorage.removeItem(name);
  } catch {
    /* ignore */
  }
  console.warn(
    `[safeStorage] localStorage quota exceeded and could not be reclaimed; persistence skipped this write.`,
  );
}

const quotaSafeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => safeSetItem(name, value),
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/** JSON storage backed by the quota-safe localStorage above, for persist(). */
export const safeJSONStorage = createJSONStorage(() => quotaSafeStorage);
