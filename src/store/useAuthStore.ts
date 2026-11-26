import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "@/data/supabase/client";
import { isAdminEmail } from "@/lib/admin";
import { setAdminUnlimited } from "@/lib/apiUsage";
import * as F from "@/data/supabase/friends";

/**
 * Auth + friends state, backed by Supabase. Sign-in uses email + password
 * (no email codes). Profile stores display name (initials) + handle (search).
 */
export interface SignUpInput {
  email: string;
  password: string;
  displayName: string;
  handle: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

interface AuthState {
  configured: boolean;
  ready: boolean;
  userId: string | null;
  email: string | null;
  profile: F.Profile | null;
  friends: F.Friend[];
  incoming: F.FriendRequest[];
  outgoing: F.FriendRequest[];
  shares: F.FriendShare[];
  backendError: string | null;

  init: () => Promise<void>;
  signUp: (input: SignUpInput) => Promise<{ ok: boolean; error?: string }>;
  signIn: (input: SignInInput) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  saveProfile: (displayName: string, handle: string) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
  search: (query: string) => Promise<F.Profile[]>;
  addFriend: (addresseeId: string) => Promise<{ ok: boolean; error?: string }>;
  respond: (friendshipId: string, accept: boolean) => Promise<void>;
  unfriend: (friendshipId: string) => Promise<void>;
  shareTicker: (ticker: string, note: string) => Promise<{ ok: boolean; error?: string }>;
}

function messageOf(e: unknown): string {
  // Be defensive about a plain `{ message }` reject (not just Error subclasses) so
  // a real backend message never collapses into a generic one.
  const raw =
    e instanceof Error
      ? e.message
      : e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string"
        ? (e as { message: string }).message
        : "";
  if (!raw) return "Something went wrong — please try again.";
  if (raw === "Failed to fetch") {
    return "Can't reach Supabase — check your internet and .env keys, then restart the app.";
  }
  if (/^not authenticated$/i.test(raw) || /permission denied/i.test(raw) || /\bjwt\b/i.test(raw)) {
    return "Your session expired — please sign in again to continue.";
  }
  return raw;
}

let subscribed = false;

// ---------------------------------------------------------------------------
// Realtime friend/share notification channels (L1)
// ---------------------------------------------------------------------------
let friendNotifUnsubs: Array<() => void> = [];

function teardownFriendNotifications() {
  for (const off of friendNotifUnsubs) off();
  friendNotifUnsubs = [];
}

function initFriendNotifications(userId: string) {
  if (!supabase) return;
  teardownFriendNotifications();

  // 1. Incoming friend request: friendships INSERT where addressee = me.
  const incomingCh = supabase
    .channel(`friend-incoming-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "friendships",
        filter: `addressee=eq.${userId}`,
      },
      () => {
        // Refresh so `incoming` updates live; the actual toast (with the sender's
        // name, deduped) is fired by the social-reconcile hook off that state
        // change - the SAME path that surfaces requests which arrived while the app
        // was closed, so online and offline both notify through one code path.
        void useAuthStore.getState().refresh();
      },
    )
    .subscribe();
  friendNotifUnsubs.push(() => void supabase?.removeChannel(incomingCh));

  // 2. Friend request accepted: friendships UPDATE where requester = me.
  const acceptedCh = supabase
    .channel(`friend-accepted-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "friendships",
        filter: `requester=eq.${userId}`,
      },
      (payload) => {
        const row = payload.new as { status?: string };
        if (row.status !== "accepted") return;
        // Refresh so `friends` updates; the "you're now connected" toast is fired
        // by the social-reconcile hook off that state change - deduped and
        // offline-safe, so an accept that lands while the app is closed still
        // notifies on reopen (the live-only path missed exactly that case).
        void useAuthStore.getState().refresh();
      },
    )
    .subscribe();
  friendNotifUnsubs.push(() => void supabase?.removeChannel(acceptedCh));

  // 3. New share arriving: shares INSERT. RLS already scopes delivery to friends,
  //    so any INSERT we receive (that isn't our own author) is a friend sharing.
  const sharesCh = supabase
    .channel(`friend-shares-${userId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "shares" },
      (payload) => {
        const row = payload.new as { author?: string };
        if (!row.author || row.author === userId) return;
        // Refresh so `shares` updates; the toast ("X shared TICKER with you",
        // deduped + offline-safe) is fired by the social-reconcile hook.
        void useAuthStore.getState().refresh();
      },
    )
    .subscribe();
  friendNotifUnsubs.push(() => void supabase?.removeChannel(sharesCh));
  // No initial-load suppression needed: every toast now flows through the
  // social-reconcile hook, which dedupes against a persisted "seen" set - so the
  // realtime channels only need to refresh state, and the hook decides what's new.
}

export const useAuthStore = create<AuthState>((set, get) => ({
  configured: isSupabaseConfigured,
  ready: false,
  userId: null,
  email: null,
  profile: null,
  friends: [],
  incoming: [],
  outgoing: [],
  shares: [],
  backendError: null,

  init: async () => {
    if (!supabase) {
      set({ ready: true });
      return;
    }
    if (!subscribed) {
      subscribed = true;
      supabase.auth.onAuthStateChange((_event, session) => {
        const user = session?.user ?? null;
        set({ userId: user?.id ?? null, email: user?.email ?? null });
        setAdminUnlimited(isAdminEmail(user?.email)); // owner is never app-budget-throttled
        if (user) {
          void get().refresh();
          initFriendNotifications(user.id);
        } else {
          set({ profile: null, friends: [], incoming: [], outgoing: [], shares: [], backendError: null });
          teardownFriendNotifications();
        }
      });
    }
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user ?? null;
    set({ userId: user?.id ?? null, email: user?.email ?? null, ready: true });
    setAdminUnlimited(isAdminEmail(user?.email));
    if (user) await get().refresh();
  },

  signUp: async ({ email, password, displayName, handle }) => {
    if (!supabase) return { ok: false, error: "Sign-in isn't configured yet." };
    const trimmedEmail = email.trim();
    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: { data: { display_name: displayName.trim() } },
    });
    if (error) return { ok: false, error: error.message };
    if (!data.user) return { ok: false, error: "Sign-up failed — try again." };

    if (!data.session) {
      return {
        ok: false,
        error:
          "Account created but not signed in. In Supabase → Authentication → Providers → Email, turn OFF “Confirm email”, then try again.",
      };
    }

    set({ userId: data.user.id, email: data.user.email ?? trimmedEmail });
    try {
      const profile = await F.upsertProfile(data.user.id, { displayName, handle });
      set({ profile, backendError: null });
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  signIn: async ({ email, password }) => {
    if (!supabase) return { ok: false, error: "Sign-in isn't configured yet." };
    const trimmedEmail = email.trim();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });
    if (error) return { ok: false, error: error.message };
    const user = data.user;
    set({ userId: user?.id ?? null, email: user?.email ?? trimmedEmail });
    if (user) await get().refresh();
    return { ok: true };
  },

  signOut: async () => {
    teardownFriendNotifications();
    if (supabase) await supabase.auth.signOut();
    set({
      userId: null,
      email: null,
      profile: null,
      friends: [],
      incoming: [],
      outgoing: [],
      shares: [],
      backendError: null,
    });
  },

  saveProfile: async (displayName, handle) => {
    const userId = get().userId;
    if (!userId) return { ok: false, error: "Not signed in." };
    try {
      const profile = await F.upsertProfile(userId, { displayName, handle });
      set({ profile });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  refresh: async () => {
    const userId = get().userId;
    if (!userId) return;
    try {
      const [profile, graph, shares] = await Promise.all([
        F.getProfile(userId),
        F.getFriendGraph(userId),
        F.getFriendShares(userId),
      ]);
      set({
        profile,
        friends: graph.friends,
        incoming: graph.incoming,
        outgoing: graph.outgoing,
        shares,
        backendError: null,
      });
    } catch (e) {
      const msg = messageOf(e);
      console.error("Friends refresh failed:", e);
      set({ backendError: msg });
    }
  },

  search: async (query) => {
    const userId = get().userId;
    if (!userId) return [];
    try {
      return await F.searchProfiles(query, userId);
    } catch {
      return [];
    }
  },

  addFriend: async (addresseeId) => {
    const userId = get().userId;
    if (!userId) return { ok: false, error: "Not signed in." };
    try {
      await F.sendFriendRequest(userId, addresseeId);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  respond: async (friendshipId, accept) => {
    try {
      await F.respondToRequest(friendshipId, accept);
      await get().refresh();
    } catch (e) {
      console.error("Respond failed:", e);
    }
  },

  unfriend: async (friendshipId) => {
    try {
      await F.removeFriendship(friendshipId);
      await get().refresh();
    } catch (e) {
      console.error("Unfriend failed:", e);
    }
  },

  shareTicker: async (ticker, note) => {
    const userId = get().userId;
    if (!userId) return { ok: false, error: "Not signed in." };
    if (!ticker.trim()) return { ok: false, error: "Enter a ticker." };
    try {
      await F.createShare(userId, ticker, note);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },
}));

// Dev-only handle so the headless screenshot harness can drive the admin gate
// (the Operator cockpit on /performance) without a live Supabase session.
// Mirrors window.__appStore; stripped from production builds. The `window`
// guard keeps node-env unit tests (which import this via sampleDataMode) green.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __authStore?: typeof useAuthStore }).__authStore = useAuthStore;
}
