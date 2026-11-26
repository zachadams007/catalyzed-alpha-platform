import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { supabase } from "./client";
import {
  type CloudWatchItem,
  deleteWatchlistItems,
  fetchMyWatchlist,
  fetchMyWatchlistTickers,
  upsertWatchlist,
} from "./watchlists";
import {
  type WatchlistState,
  diffChangedTickers,
  mergeWatchlist,
  serializeWatchlist,
} from "./watchlistMerge";

// Re-export the pure merge so importers/tests can reach it.
export { mergeWatchlist } from "./watchlistMerge";

/**
 * Cross-device, account-bound WATCHLIST sync. The same account's watchlist (and
 * its per-ticker price reminders) follows the user across devices and - crucially
 * - survives exit/reopen even if the local persist blob is lost, because the
 * cloud copy is the durable source of truth. Mirrors notesSync.ts / portfolioSync.ts
 * (pull→merge→push, debounced push, Realtime + focus pull).
 *
 * The merge is UNION-biased: a pull never drops a locally-added ticker, and a
 * remote removal only lands after a push deletes that row - so the watchlist can
 * never silently empty itself (the user's "it keeps deleting on exit" bug).
 *
 * Idempotent; a no-op when Supabase auth isn't configured.
 */

let currentUserId: string | null = null;
let applyingRemote = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncedJson = "";
/** Ticker → updated_at of the value we last synced; powers conflict LWW. */
const stamps = new Map<string, string>();
let realtimeChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
let started = false;

function localState(): WatchlistState {
  const s = useAppStore.getState();
  return { tickers: s.watchlist, alerts: s.watchlistAlerts };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function pull(reason: string): Promise<void> {
  const userId = currentUserId;
  if (!userId || !supabase) return;
  useAppStore.getState().setWatchlistSyncStatus("loading");
  try {
    const remote = await fetchMyWatchlist(userId);
    const local = localState();
    const merged = mergeWatchlist(local, remote, stamps);

    applyingRemote = true;
    useAppStore.getState().replaceWatchlist(merged.tickers, merged.alerts);
    applyingRemote = false;

    // Refresh stamps: a ticker matching a remote row takes that row's updated_at;
    // a local-kept value is asserted current (stamp = now).
    const remoteByTicker = new Map(remote.map((r) => [r.ticker, r]));
    for (const ticker of merged.tickers) {
      const r = remoteByTicker.get(ticker);
      stamps.set(ticker, r ? r.updatedAt : nowIso());
    }
    for (const ticker of [...stamps.keys()]) {
      if (!merged.tickers.includes(ticker)) stamps.delete(ticker);
    }
    lastSyncedJson = serializeWatchlist(merged);

    // If the merge differs from the cloud (local-only or local-newer items),
    // push so they persist for the other devices.
    const remoteState: WatchlistState = {
      tickers: remote.map((r) => r.ticker),
      alerts: Object.fromEntries(remote.filter((r) => r.alert).map((r) => [r.ticker, r.alert!])),
    };
    if (serializeWatchlist(remoteState) !== lastSyncedJson) await push(`reconcile-after-${reason}`);
    useAppStore.getState().setWatchlistSyncStatus("synced");
  } catch (e) {
    applyingRemote = false;
    useAppStore.getState().setWatchlistSyncStatus("error");
    console.error(`Watchlist sync pull failed (${reason}):`, e);
  }
}

async function push(reason: string): Promise<void> {
  const userId = currentUserId;
  if (!userId || !supabase) return;
  const local = localState();
  const json = serializeWatchlist(local);
  if (json === lastSyncedJson && reason === "local-change") return;
  try {
    const entries: CloudWatchItem[] = local.tickers.map((ticker) => ({
      ticker,
      alert: local.alerts[ticker] ?? null,
      updatedAt: stamps.get(ticker) ?? nowIso(),
    }));
    await upsertWatchlist(userId, entries);

    // Delete cloud rows the user removed locally. Safe because onSignIn pulls
    // first (so local ⊇ remote before any edit), mirroring notesSync.
    const remoteTickers = await fetchMyWatchlistTickers(userId);
    const localTickers = new Set(local.tickers);
    const toDelete = remoteTickers.filter((t) => !localTickers.has(t));
    await deleteWatchlistItems(userId, toDelete);
    for (const t of toDelete) stamps.delete(t);
    lastSyncedJson = json;
  } catch (e) {
    console.error(`Watchlist sync push failed (${reason}):`, e);
  }
}

function schedulePush(changedTickers: string[]): void {
  const ts = nowIso();
  for (const t of changedTickers) stamps.set(t, ts);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void push("local-change"), 1200);
}

function onFocus(): void {
  if (document.visibilityState === "visible") void pull("focus");
}

function startRealtime(userId: string): void {
  if (!supabase) return;
  stopRealtime();
  realtimeChannel = supabase
    .channel(`watchlist_items:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "watchlist_items", filter: `owner=eq.${userId}` },
      () => void pull("realtime"),
    )
    .subscribe();
}

function stopRealtime(): void {
  if (realtimeChannel && supabase) {
    void supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

async function onSignIn(userId: string): Promise<void> {
  currentUserId = userId;
  lastSyncedJson = "";
  stamps.clear();
  await pull("sign-in");
  startRealtime(userId);
  window.addEventListener("visibilitychange", onFocus);
  window.addEventListener("focus", onFocus);
}

function onSignOut(): void {
  currentUserId = null;
  lastSyncedJson = "";
  stamps.clear();
  if (pushTimer) clearTimeout(pushTimer);
  stopRealtime();
  window.removeEventListener("visibilitychange", onFocus);
  window.removeEventListener("focus", onFocus);
  // Local watchlist is intentionally kept so the app still works offline.
}

/** Wire auth + app stores together. Idempotent; no-op when Supabase is unconfigured. */
export function initWatchlistSync(): void {
  if (started || !supabase) return;
  started = true;

  useAuthStore.subscribe((state) => {
    const next = state.userId;
    if (next && next !== currentUserId) void onSignIn(next);
    else if (!next && currentUserId) onSignOut();
  });

  const existing = useAuthStore.getState().userId;
  if (existing) void onSignIn(existing);

  useAppStore.subscribe((state, prev) => {
    if (applyingRemote || !currentUserId) return;
    if (state.watchlist === prev.watchlist && state.watchlistAlerts === prev.watchlistAlerts) return;
    const changed = diffChangedTickers(
      { tickers: state.watchlist, alerts: state.watchlistAlerts },
      { tickers: prev.watchlist, alerts: prev.watchlistAlerts },
    );
    if (changed.length > 0) schedulePush(changed);
  });
}
