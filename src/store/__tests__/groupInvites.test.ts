import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingGroupInvite } from "@/data/groups/types";

/**
 * Unit coverage for the direct friend → group invite store logic
 * (useGroupsStore). We mock the whole groupsApi data layer + the auth store so
 * the actions run in the node env without Supabase, and assert the
 * accept/decline/invite state transitions (optimistic removal + rollback,
 * already-member handling).
 */

const api = vi.hoisted(() => ({
  inviteFriendToGroup: vi.fn(),
  acceptGroupInvite: vi.fn(),
  declineGroupInvite: vi.fn(),
  listMyGroupInvites: vi.fn(async () => [] as PendingGroupInvite[]),
  // Touched by acceptInvite's follow-up (loadMyGroups → selectGroup); keep inert.
  listMyGroups: vi.fn(async () => []),
  getReadMarks: vi.fn(async () => ({})),
  getLatestActivityStamps: vi.fn(async () => ({})),
  subscribeToGroupsActivity: vi.fn(() => () => {}),
  getGroupMembers: vi.fn(async () => []),
  getGroupWatchlist: vi.fn(async () => []),
  getGroupCalls: vi.fn(async () => []),
  getActiveInvite: vi.fn(async () => null),
  getGroupMessages: vi.fn(async () => []),
  getGroupPolls: vi.fn(async () => []),
  getGroupActivity: vi.fn(async () => []),
  subscribeToMessages: vi.fn(() => () => {}),
  subscribeToPolls: vi.fn(() => () => {}),
  subscribeToActivity: vi.fn(() => () => {}),
  subscribeToWatchlist: vi.fn(() => () => {}),
  subscribeToCalls: vi.fn(() => () => {}),
  subscribeToGroup: vi.fn(() => () => {}),
  subscribeToMembers: vi.fn(() => () => {}),
  subscribeToGroupPresence: vi.fn(() => ({ unsub: () => {}, track: () => {} })),
  fetchCurrentPrices: vi.fn(async () => ({})),
}));

vi.mock("@/data/groups/groupsApi", () => api);

// isSupabaseConfigured must be true so the actions don't early-return.
vi.mock("@/data/supabase/client", () => ({
  isSupabaseConfigured: true,
  supabase: null,
}));

// Auth store: a signed-in user with no real subscriptions.
vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: {
    getState: () => ({ userId: "me", profile: { displayName: "Me", handle: "me" } }),
    subscribe: () => () => {},
  },
}));

vi.mock("@/data/groups/leaderboard", () => ({ callTickers: () => [] }));
vi.mock("@/data/groups/activity", () => ({ unreadCount: () => 0 }));
vi.mock("@/data/symbols/symbolDirectory", () => ({ resolveSymbol: (t: string) => ({ symbol: t.toUpperCase() }) }));

const { useGroupsStore } = await import("@/store/useGroupsStore");

function invite(id: string, groupId = "g1"): PendingGroupInvite {
  return {
    id,
    groupId,
    groupName: "Alpha Squad",
    createdAt: new Date().toISOString(),
    inviter: { id: "friend", handle: "friend", displayName: "A Friend", avatarAccent: "#000" },
  };
}

beforeEach(() => {
  useGroupsStore.setState({ pendingInvites: [invite("i1"), invite("i2")], invitesStatus: "ready" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useGroupsStore — friend → group invites", () => {
  it("acceptInvite removes the invite optimistically and joins the group", async () => {
    api.acceptGroupInvite.mockResolvedValueOnce({ groupId: "g1", groupName: "Alpha Squad", alreadyMember: false });

    const r = await useGroupsStore.getState().acceptInvite("i1");

    expect(r.ok).toBe(true);
    expect(r.groupId).toBe("g1");
    expect(api.acceptGroupInvite).toHaveBeenCalledWith("i1");
    // i1 is gone; i2 remains.
    expect(useGroupsStore.getState().pendingInvites.map((i) => i.id)).toEqual(["i2"]);
  });

  it("acceptInvite rolls the invite back into the list when the RPC fails", async () => {
    api.acceptGroupInvite.mockRejectedValueOnce(new Error("boom"));

    const r = await useGroupsStore.getState().acceptInvite("i1");

    expect(r.ok).toBe(false);
    // Both invites restored after the rollback.
    expect(useGroupsStore.getState().pendingInvites.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  it("declineInvite drops the invite from the list", async () => {
    api.declineGroupInvite.mockResolvedValueOnce(undefined);

    await useGroupsStore.getState().declineInvite("i2");

    expect(api.declineGroupInvite).toHaveBeenCalledWith("i2");
    expect(useGroupsStore.getState().pendingInvites.map((i) => i.id)).toEqual(["i1"]);
  });

  it("inviteFriendToGroup surfaces an already-member outcome as a soft error", async () => {
    api.inviteFriendToGroup.mockResolvedValueOnce({ inviteId: null, groupName: "Alpha Squad", alreadyMember: true });

    const r = await useGroupsStore.getState().inviteFriendToGroup("g1", "friend");

    expect(r.ok).toBe(false);
    expect(r.alreadyMember).toBe(true);
  });

  it("inviteFriendToGroup returns ok with the group name on success", async () => {
    api.inviteFriendToGroup.mockResolvedValueOnce({ inviteId: "new", groupName: "Alpha Squad", alreadyMember: false });

    const r = await useGroupsStore.getState().inviteFriendToGroup("g1", "friend");

    expect(r.ok).toBe(true);
    expect(r.groupName).toBe("Alpha Squad");
    expect(api.inviteFriendToGroup).toHaveBeenCalledWith("g1", "friend");
  });

  it("loadInvites populates pendingInvites from the API", async () => {
    api.listMyGroupInvites.mockResolvedValueOnce([invite("i9")]);

    await useGroupsStore.getState().loadInvites();

    expect(useGroupsStore.getState().pendingInvites.map((i) => i.id)).toEqual(["i9"]);
    expect(useGroupsStore.getState().invitesStatus).toBe("ready");
  });
});
