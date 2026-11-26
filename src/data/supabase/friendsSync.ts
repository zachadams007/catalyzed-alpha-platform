import { useAuthStore } from "@/store/useAuthStore";
import { supabase } from "./client";

/**
 * Live cross-user sync for the friends graph + shares feed.
 *
 * Before this, `useAuthStore.refresh()` (friend graph + incoming/outgoing
 * requests + the shares feed) ran ONLY on sign-in and after the viewer's OWN
 * mutations. So a friend request, an accept, or a posted share never appeared
 * for the OTHER person until they reloaded the app.
 *
 * This wires Supabase Realtime (the `friendships` + `shares` tables were added
 * to the publication in migration 0011) so the viewer re-pulls when:
 *   • a `friendships` row where they are requester or addressee changes
 *     (request received, accepted, or removed), or
 *   • any `shares` row is inserted/deleted (RLS already scopes which shares the
 *     viewer can actually read, so `refresh()`'s re-pull returns only the ones
 *     visible to them - we can't pre-filter on the wire since friend-visibility
 *     lives in the SELECT policy, not a single column).
 *
 * It also mirrors `portfolioSync`'s visibilitychange/focus refetch so a tab that
 * was backgrounded (where realtime may have dropped) reconciles on return.
 *
 * All refetches funnel through a single debounced `refresh()` so a burst of
 * changes collapses into one round-trip. Idempotent; a no-op when Supabase is
 * unconfigured.
 */

let currentUserId: string | null = null;
let started = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let friendsChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;
let sharesChannel: ReturnType<NonNullable<typeof supabase>["channel"]> | null = null;

/** Debounced re-pull of the whole friends slice through RLS. */
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void useAuthStore.getState().refresh();
  }, 250);
}

function onFocus(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") void useAuthStore.getState().refresh();
}

function startRealtime(userId: string): void {
  if (!supabase) return;
  stopRealtime();

  // friendships: only rows where the viewer is a participant matter to them.
  // PostgREST realtime filters take a single column, so we open one channel per
  // side (requester / addressee) of the directed friendship row.
  friendsChannel = supabase
    .channel(`friendships:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "friendships", filter: `requester=eq.${userId}` },
      () => scheduleRefresh(),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "friendships", filter: `addressee=eq.${userId}` },
      () => scheduleRefresh(),
    )
    .subscribe();

  // shares: friend-visibility lives in the RLS SELECT policy, not one column, so
  // we listen broadly to INSERT/DELETE and let refresh() re-pull what the viewer
  // is actually allowed to see (their own posts are filtered out client-side).
  sharesChannel = supabase
    .channel(`shares:${userId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "shares" },
      () => scheduleRefresh(),
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "shares" },
      () => scheduleRefresh(),
    )
    .subscribe();
}

function stopRealtime(): void {
  if (!supabase) return;
  if (friendsChannel) {
    void supabase.removeChannel(friendsChannel);
    friendsChannel = null;
  }
  if (sharesChannel) {
    void supabase.removeChannel(sharesChannel);
    sharesChannel = null;
  }
}

function onSignIn(userId: string): void {
  currentUserId = userId;
  startRealtime(userId);
  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
  }
}

function onSignOut(): void {
  currentUserId = null;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  stopRealtime();
  if (typeof window !== "undefined") {
    window.removeEventListener("visibilitychange", onFocus);
    window.removeEventListener("focus", onFocus);
  }
}

/**
 * Wire friends realtime to the auth store. Idempotent; no-op when Supabase is
 * unconfigured. `useAuthStore.init()` already does the initial `refresh()` on
 * sign-in, so this only adds the live channel + focus reconciliation on top.
 */
export function initFriendsSync(): void {
  if (started || !supabase) return;
  started = true;

  useAuthStore.subscribe((state) => {
    const next = state.userId;
    if (next && next !== currentUserId) onSignIn(next);
    else if (!next && currentUserId) onSignOut();
  });

  const existing = useAuthStore.getState().userId;
  if (existing) onSignIn(existing);
}
