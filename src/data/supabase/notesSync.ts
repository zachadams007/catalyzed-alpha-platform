import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { supabase } from "./client";
import {
  type CloudNote,
  deleteNotes,
  fetchMyNoteTickers,
  fetchMyNotes,
  upsertNotes,
} from "./terminalNotes";
import {
  type NotesMap,
  diffChangedTickers,
  mergeNotes,
  serializeNotes,
} from "./notesMerge";

// Re-export the pure merge so existing importers/tests keep working.
export { mergeNotes } from "./notesMerge";

/**
 * Cross-device sync for Terminal per-ticker notes. The same account's notes
 * follow the user to their phone - write on desktop, read on mobile. Mirrors
 * portfolioSync.ts (pull→merge→push, debounced push, Realtime + focus pull) but
 * for the flat `terminalNotes: Record<ticker, body>` map.
 *
 * Notes have no per-note timestamp locally, so the sync module tracks a small
 * in-memory `stamps` map (when each ticker was last pulled/pushed) to do
 * last-writer-wins on a conflict. Like portfolioSync, the merge is additive - a
 * pull never silently drops a local note; the reconciling push persists it.
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

function localNotes(): NotesMap {
  return useAppStore.getState().terminalNotes;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function pull(reason: string): Promise<void> {
  const userId = currentUserId;
  if (!userId || !supabase) return;
  try {
    const remote = await fetchMyNotes(userId);
    const local = localNotes();
    const merged = mergeNotes(local, remote, stamps);

    applyingRemote = true;
    useAppStore.getState().replaceTerminalNotes(merged);
    applyingRemote = false;

    // Refresh stamps: a ticker now matching a remote row takes that row's
    // updated_at; a local-kept value is asserted current (stamp = now).
    const remoteByTicker = new Map(remote.map((r) => [r.ticker, r]));
    for (const ticker of Object.keys(merged)) {
      const r = remoteByTicker.get(ticker);
      stamps.set(ticker, r && r.body === merged[ticker] ? r.updatedAt : nowIso());
    }
    for (const ticker of [...stamps.keys()]) {
      if (!(ticker in merged)) stamps.delete(ticker);
    }
    lastSyncedJson = serializeNotes(merged);

    // If the merge differs from the cloud (local-only or local-newer notes),
    // push so they persist for the other devices.
    const remoteMap: NotesMap = {};
    for (const r of remote) if (r.body?.trim()) remoteMap[r.ticker] = r.body;
    if (serializeNotes(remoteMap) !== lastSyncedJson) await push(`reconcile-after-${reason}`);
  } catch (e) {
    applyingRemote = false;
    console.error(`Notes sync pull failed (${reason}):`, e);
  }
}

async function push(reason: string): Promise<void> {
  const userId = currentUserId;
  if (!userId || !supabase) return;
  const local = localNotes();
  const json = serializeNotes(local);
  if (json === lastSyncedJson && reason === "local-change") return;
  try {
    const entries: CloudNote[] = Object.keys(local).map((ticker) => ({
      ticker,
      body: local[ticker],
      updatedAt: stamps.get(ticker) ?? nowIso(),
    }));
    await upsertNotes(userId, entries);

    // Delete cloud rows the user removed locally. Safe because onSignIn pulls
    // first (so local ⊇ remote before any edit), mirroring portfolioSync.
    const remoteTickers = await fetchMyNoteTickers(userId);
    const localTickers = new Set(Object.keys(local));
    const toDelete = remoteTickers.filter((t) => !localTickers.has(t));
    await deleteNotes(userId, toDelete);
    for (const t of toDelete) stamps.delete(t);
    lastSyncedJson = json;
  } catch (e) {
    console.error(`Notes sync push failed (${reason}):`, e);
  }
}

function schedulePush(changedTickers: string[]): void {
  // Stamp the just-edited tickers now() so the push writes a fresh updated_at
  // and future pulls correctly see this device's edit as the newer value.
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
    .channel(`terminal_notes:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "terminal_notes", filter: `owner=eq.${userId}` },
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
  // Local notes are intentionally kept so the app still works offline.
}

/** Wire auth + app stores together. Idempotent; no-op when Supabase is unconfigured. */
export function initNotesSync(): void {
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
    if (state.terminalNotes === prev.terminalNotes) return;
    const changed = diffChangedTickers(state.terminalNotes, prev.terminalNotes);
    if (changed.length > 0) schedulePush(changed);
  });
}
