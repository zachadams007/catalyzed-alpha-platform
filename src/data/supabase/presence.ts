import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./client";
import { useAuthStore } from "@/store/useAuthStore";

/**
 * Lightweight "who's online" via Supabase Realtime presence - no tables, no
 * migrations. Every signed-in client tracks itself on a shared channel;
 * the Operator console observes the channel to list live users.
 *
 * All functions are no-ops when Supabase isn't configured.
 */

export interface OnlineUser {
  userId: string;
  name: string;
  handle: string | null;
  since: string;
}

let channel: RealtimeChannel | null = null;
let channelReady: Promise<RealtimeChannel | null> | null = null;
let started = false;

const observers = new Set<(users: OnlineUser[] | null) => void>();

function currentOnline(): OnlineUser[] {
  if (!channel) return [];
  const state = channel.presenceState<OnlineUser>();
  const byId = new Map<string, OnlineUser>();
  for (const presences of Object.values(state)) {
    for (const p of presences) {
      if (!p.userId || byId.has(p.userId)) continue;
      byId.set(p.userId, {
        userId: p.userId,
        name: p.name || "Member",
        handle: p.handle ?? null,
        since: p.since ?? new Date().toISOString(),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Create + subscribe the shared channel. Resolves null when realtime is
 *  unavailable (offline, project paused, …) - and forgets the attempt so the
 *  next observer/track retries instead of caching the failure forever. */
function subscribedChannel(): Promise<RealtimeChannel | null> {
  if (!supabase) return Promise.resolve(null);
  if (!channelReady) {
    channelReady = new Promise((resolve) => {
      channel = supabase!.channel("online-users");
      channel.on("presence", { event: "sync" }, () => {
        const users = currentOnline();
        for (const cb of observers) cb(users);
      });
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve(channel);
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          for (const cb of observers) cb(null);
          // Tear down so a later call gets a fresh attempt.
          if (channel) void supabase!.removeChannel(channel);
          channel = null;
          channelReady = null;
          resolve(null);
        }
      });
    });
  }
  return channelReady;
}

async function trackSelf(userId: string): Promise<void> {
  const ch = await subscribedChannel();
  if (!ch) return;
  // The channel join is a network round-trip - re-check auth so a sign-out
  // that landed mid-flight doesn't leave a ghost "Online" entry.
  if (useAuthStore.getState().userId !== userId) return;
  const profile = useAuthStore.getState().profile;
  try {
    await ch.track({
      userId,
      name: profile?.displayName || profile?.handle || "Member",
      handle: profile?.handle ?? null,
      since: new Date().toISOString(),
    } satisfies OnlineUser);
  } catch {
    /* presence is best-effort */
  }
}

async function untrackSelf(): Promise<void> {
  if (!channel) return;
  try {
    await channel.untrack();
  } catch {
    /* best-effort */
  }
}

/** Wire presence to auth state. Call once at app start (no-op without Supabase). */
export function initPresence(): void {
  if (!supabase || started) return;
  started = true;

  supabase.auth.onAuthStateChange((_event, session) => {
    const user = session?.user ?? null;
    if (user) void trackSelf(user.id);
    else void untrackSelf();
  });
  void supabase.auth.getSession().then(({ data }) => {
    const user = data.session?.user;
    if (user) void trackSelf(user.id);
  });

  // Re-announce with the real display name once the profile loads/changes.
  useAuthStore.subscribe((state, prev) => {
    if (state.userId && state.profile !== prev.profile) void trackSelf(state.userId);
  });
}

/**
 * Observe the live user list. Calls back with the current list immediately
 * (once subscribed) and on every join/leave; calls back with `null` when
 * realtime is unavailable. Returns an unsubscribe function.
 */
export function observeOnline(cb: (users: OnlineUser[] | null) => void): () => void {
  observers.add(cb);
  void subscribedChannel().then((ch) => {
    if (!observers.has(cb)) return;
    cb(ch ? currentOnline() : null);
  });
  return () => {
    observers.delete(cb);
  };
}
