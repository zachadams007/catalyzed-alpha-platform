import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Regression test for C-1: the friends graph + shares feed must update LIVE for
 * the other user, not only on sign-in / the viewer's own mutation. Before the
 * fix there was no realtime channel for `friendships`/`shares` at all, so a
 * request or a posted share never reached the other person until a full reload.
 *
 * We mock the Supabase client with a fake channel recorder so we can (a) assert
 * the right `postgres_changes` filters are registered on sign-in and (b) fire a
 * captured handler and confirm it triggers a debounced `useAuthStore.refresh()`.
 */

interface Registered {
  table: string;
  event: string;
  filter?: string;
  handler: (payload: unknown) => void;
}

const registered: Registered[] = [];
const removed: unknown[] = [];

function makeChannel() {
  const channel = {
    on(_type: string, cfg: { event: string; table: string; filter?: string }, handler: (p: unknown) => void) {
      registered.push({ table: cfg.table, event: cfg.event, filter: cfg.filter, handler });
      return channel;
    },
    subscribe() {
      return channel;
    },
  };
  return channel;
}

vi.mock("@/data/supabase/client", () => ({
  isSupabaseConfigured: true,
  supabase: {
    channel: vi.fn(() => makeChannel()),
    removeChannel: vi.fn((c: unknown) => {
      removed.push(c);
    }),
  },
}));

import { initFriendsSync } from "@/data/supabase/friendsSync";
import { useAuthStore } from "@/store/useAuthStore";

let refreshSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  registered.length = 0;
  removed.length = 0;
  refreshSpy = vi.fn(async () => {});
  // Replace the store's refresh with a spy; leave userId controllable.
  useAuthStore.setState({ userId: null, refresh: refreshSpy });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("initFriendsSync (C-1)", () => {
  it("subscribes to friendships (both sides) + shares insert/delete when already signed in at boot", () => {
    useAuthStore.setState({ userId: "user-1" });
    initFriendsSync();

    const tables = registered.map((r) => `${r.table}:${r.event}:${r.filter ?? ""}`);
    expect(tables).toContain("friendships:*:requester=eq.user-1");
    expect(tables).toContain("friendships:*:addressee=eq.user-1");
    expect(tables).toContain("shares:INSERT:");
    expect(tables).toContain("shares:DELETE:");
  });

  it("debounces a friendship change into a single refresh()", () => {
    useAuthStore.setState({ userId: "user-1" });
    initFriendsSync();

    const friendshipHandler = registered.find((r) => r.table === "friendships")!.handler;
    friendshipHandler({});
    friendshipHandler({}); // burst - should collapse
    expect(refreshSpy).not.toHaveBeenCalled(); // debounced, not yet

    vi.advanceTimersByTime(300);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes when another user's share is inserted", () => {
    useAuthStore.setState({ userId: "user-1" });
    initFriendsSync();

    const shareInsert = registered.find((r) => r.table === "shares" && r.event === "INSERT")!.handler;
    shareInsert({ new: { id: "s1", author: "user-2" } });
    vi.advanceTimersByTime(300);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
