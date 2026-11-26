import type { Portfolio } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { supabase } from "./client";
import {
  deletePortfolios,
  fetchMyPortfolioIds,
  fetchMyPortfolios,
  upsertPortfolios,
} from "./portfolios";

/**
 * Cross-device portfolio sync. Mirrors the user's own ("me") portfolios to
 * Supabase so the same account sees the same portfolios everywhere (import on
 * mobile → shows on desktop).
 *
 * Strategy:
 *  - On sign-in: PULL remote, merge with local by id (newest `updatedAt` wins),
 *    apply locally, then PUSH the merged set so both sides converge.
 *  - On local change while signed in: debounced PUSH (upserts + deletes).
 *  - On window focus / Realtime change: PULL so other devices' edits appear.
 *
 * Guards prevent a pull→apply→push→pull loop: applying remote data is wrapped in
 * `applyingRemote`, and pushes are skipped when the serialized own-set is unchanged.
 */

let currentUserId: string | null = null;
let applyingRemote = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncedJson = "";
let realtimeChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
let started = false;

function ownPortfolios(): Portfolio[] {
  return useAppStore.getState().portfolios.filter((p) => p.owner === "me");
}

/** Stable serialization to detect real changes (order-independent). */
function serialize(portfolios: Portfolio[]): string {
  return JSON.stringify(
    [...portfolios]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({ ...p, holdings: [...p.holdings].sort((x, y) => x.ticker.localeCompare(y.ticker)) })),
  );
}

function mergeById(local: Portfolio[], remote: Portfolio[]): Portfolio[] {
  const byId = new Map<string, Portfolio>();
  for (const p of remote) byId.set(p.id, p);
  for (const p of local) {
    const r = byId.get(p.id);
    if (!r) {
      byId.set(p.id, p);
      continue;
    }

    const newest =
      Date.parse(p.updatedAt) > Date.parse(r.updatedAt)
        ? p
        : r;
    const historyByDay = new Map(
      [...(r.valueHistory ?? []), ...(p.valueHistory ?? [])].map((point) => [
        point.date.slice(0, 10),
        point,
      ]),
    );
    byId.set(p.id, {
      ...newest,
      valueHistory: [...historyByDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    });
  }
  return [...byId.values()];
}

async function pull(reason: string, authoritative = false): Promise<void> {
  const userId = currentUserId;
  if (!userId || !supabase) return;
  try {
    const remote = await fetchMyPortfolios(userId);
    const local = ownPortfolios();
    const remoteIds = new Set(remote.map((p) => p.id));
    const wouldDropLocal = local.some((p) => !remoteIds.has(p.id));
    if (wouldDropLocal && !authoritative) {
      console.warn(
        `Portfolio sync skipped a destructive remote replace (${reason}); keeping local portfolios in the merge.`,
      );
    }
    const merged = authoritative ? remote : mergeById(local, remote);

    applyingRemote = true;
    useAppStore.getState().replaceOwnPortfolios(merged, { authoritative });
    applyingRemote = false;
    lastSyncedJson = serialize(merged);

    // If local had portfolios the cloud didn't (or newer), push so they persist.
    const remoteJson = serialize(remote);
    if (remoteJson !== lastSyncedJson) await push(`reconcile-after-${reason}`);
  } catch (e) {
    applyingRemote = false;
    console.error(`Portfolio sync pull failed (${reason}):`, e);
  }
}

async function push(reason: string): Promise<void> {
  const userId = currentUserId;
  if (!userId || !supabase) return;
  const own = ownPortfolios();
  const json = serialize(own);
  if (json === lastSyncedJson && reason === "local-change") return;
  try {
    await upsertPortfolios(userId, own);
    const remoteIds = await fetchMyPortfolioIds(userId);
    const localIds = new Set(own.map((p) => p.id));
    const toDelete = remoteIds.filter((id) => !localIds.has(id));
    await deletePortfolios(userId, toDelete);
    lastSyncedJson = json;
  } catch (e) {
    console.error(`Portfolio sync push failed (${reason}):`, e);
  }
}

function schedulePush(): void {
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
    .channel(`portfolios:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "portfolios", filter: `owner=eq.${userId}` },
      (payload) => void pull("realtime", payload.eventType === "DELETE"),
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
  await pull("sign-in");
  startRealtime(userId);
  window.addEventListener("visibilitychange", onFocus);
  window.addEventListener("focus", onFocus);
}

function onSignOut(): void {
  currentUserId = null;
  lastSyncedJson = "";
  if (pushTimer) clearTimeout(pushTimer);
  stopRealtime();
  window.removeEventListener("visibilitychange", onFocus);
  window.removeEventListener("focus", onFocus);
  // Local portfolios are intentionally kept so the app still works offline.
}

/** Wire auth + app stores together. Idempotent; no-op when Supabase is unconfigured. */
export function initPortfolioSync(): void {
  if (started || !supabase) return;
  started = true;

  // React to auth changes.
  useAuthStore.subscribe((state) => {
    const next = state.userId;
    if (next && next !== currentUserId) void onSignIn(next);
    else if (!next && currentUserId) onSignOut();
  });

  // If already signed in at boot.
  const existing = useAuthStore.getState().userId;
  if (existing) void onSignIn(existing);

  // React to local portfolio edits.
  useAppStore.subscribe((state, prev) => {
    if (applyingRemote || !currentUserId) return;
    if (state.portfolios === prev.portfolios) return;
    const ownNow = serialize(state.portfolios.filter((p) => p.owner === "me"));
    if (ownNow !== lastSyncedJson) schedulePush();
  });
}
