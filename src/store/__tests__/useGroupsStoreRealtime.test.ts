import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { ActivityKind } from "@/data/groups/types";

/**
 * Regression tests for Group C realtime sync (C-2, C-3, C-4): a change made by
 * ANOTHER member must reach the viewer live, not only after a manual reselect.
 *
 * We mock @/data/groups/groupsApi so each `subscribe*` fn captures its callback;
 * the tests then fire those callbacks (simulating a realtime payload from another
 * user) and assert the store re-pulls the right slice / patches the right field.
 * Before the fix the activity sub never branched on kind and there were no
 * watchlist/calls/group/cross-group subscriptions at all.
 */

// Captured realtime callbacks, set when selectGroup/loadMyGroups wires the subs.
let activityCb: ((kind: ActivityKind | null) => void) | null = null;
let watchlistCb: (() => void) | null = null;
let callsCb: (() => void) | null = null;
let groupSettingsCb: ((row: { leaderboardEnabled: boolean }) => void) | null = null;
let groupsActivityCb: ((groupId: string, createdAt: string) => void) | null = null;
let membersCb: (() => void) | null = null;
let myMembershipsCb: (() => void) | null = null;
let myGroupInvitesCb: ((row: { inviter: string | null; groupId: string | null }) => void) | null = null;

// The store's sync gate is `if (!isSupabaseConfigured) return;`, and the real
// module derives that flag from VITE_SUPABASE_URL at import time. Without this
// mock the suite silently depends on a `.env` being present in the checkout -
// it passed on the main clone and failed 6 tests ("groupsActivityCb is not a
// function") in a fresh lane worktree with no env file. Same idiom as
// friendsSync.test.ts / globalControls.test.ts: the test must be hermetic.
vi.mock("@/data/supabase/client", () => ({
  isSupabaseConfigured: true,
  supabase: {
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() })),
    removeChannel: vi.fn(),
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
    from: vi.fn(),
  },
}));

vi.mock("@/data/groups/groupsApi", () => ({
  // detail loaders used by selectGroup's Promise.all
  getGroupMembers: vi.fn(async () => []),
  getGroupWatchlist: vi.fn(async () => []),
  getGroupCalls: vi.fn(async () => []),
  getActiveInvite: vi.fn(async () => null),
  getGroupMessages: vi.fn(async () => []),
  getGroupPolls: vi.fn(async () => []),
  getGroupActivity: vi.fn(async () => []),
  fetchCurrentPrices: vi.fn(async () => ({})),
  listMyGroups: vi.fn(async () => []),
  getReadMarks: vi.fn(async () => ({})),
  getLatestActivityStamps: vi.fn(async () => ({})),
  // subscriptions - capture the callback, return a no-op unsub
  subscribeToMessages: vi.fn(() => () => {}),
  subscribeToPolls: vi.fn(() => () => {}),
  subscribeToActivity: vi.fn((_id: string, cb: (kind: ActivityKind | null) => void) => {
    activityCb = cb;
    return () => {};
  }),
  subscribeToWatchlist: vi.fn((_id: string, cb: () => void) => {
    watchlistCb = cb;
    return () => {};
  }),
  subscribeToCalls: vi.fn((_id: string, cb: () => void) => {
    callsCb = cb;
    return () => {};
  }),
  subscribeToGroup: vi.fn((_id: string, cb: (row: { leaderboardEnabled: boolean }) => void) => {
    groupSettingsCb = cb;
    return () => {};
  }),
  subscribeToGroupsActivity: vi.fn((cb: (groupId: string, createdAt: string) => void) => {
    groupsActivityCb = cb;
    return () => {};
  }),
  subscribeToMembers: vi.fn((_id: string, cb: () => void) => {
    membersCb = cb;
    return () => {};
  }),
  subscribeToMyMemberships: vi.fn((_viewerId: string, cb: () => void) => {
    myMembershipsCb = cb;
    return () => {};
  }),
  // Friend → group invites (0018): captured so onGroupsSignIn can wire them.
  listMyGroupInvites: vi.fn(async () => []),
  subscribeToMyGroupInvites: vi.fn((_viewerId: string, cb: (row: { inviter: string | null; groupId: string | null }) => void) => {
    myGroupInvitesCb = cb;
    return () => {};
  }),
}));

import * as G from "@/data/groups/groupsApi";
import { useGroupsStore, initGroupsSync } from "@/store/useGroupsStore";
import { useAuthStore } from "@/store/useAuthStore";
import type { GroupMember, GroupSummary } from "@/data/groups/types";

const getGroupWatchlist = G.getGroupWatchlist as Mock;
const getGroupCalls = G.getGroupCalls as Mock;
const getGroupMembers = G.getGroupMembers as Mock;
const listMyGroups = G.listMyGroups as Mock;

const GROUP_A: GroupSummary = {
  id: "g1",
  name: "Alpha Club",
  description: "",
  createdBy: "user-1",
  leaderboardEnabled: false,
  createdAt: new Date(0).toISOString(),
  role: "owner",
  memberCount: 4,
};
const GROUP_B: GroupSummary = { ...GROUP_A, id: "g2", name: "Beta Club" };

async function flush() {
  // selectGroup awaits a Promise.all then sets up subs; let microtasks drain.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  activityCb = watchlistCb = callsCb = null;
  groupSettingsCb = null;
  groupsActivityCb = null;
  membersCb = myMembershipsCb = null;
  myGroupInvitesCb = null;
  useAuthStore.setState({ userId: "user-1" });
  useGroupsStore.getState().reset();
  useGroupsStore.setState({ groups: [GROUP_A, GROUP_B] });
});

describe("Group realtime: shared watchlist + call ledger (C-2)", () => {
  it("re-pulls the watchlist when a 'watchlist'-kind activity arrives from another member", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();
    getGroupWatchlist.mockClear();

    expect(activityCb).toBeTypeOf("function");
    activityCb!("watchlist");
    await flush();

    expect(getGroupWatchlist).toHaveBeenCalledWith("g1");
  });

  it("re-pulls the call ledger when a 'call'-kind activity arrives", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();
    getGroupCalls.mockClear();

    activityCb!("call");
    await flush();

    expect(getGroupCalls).toHaveBeenCalledWith("g1");
  });

  it("does NOT re-pull watchlist/calls for an unrelated activity kind (message)", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();
    getGroupWatchlist.mockClear();
    getGroupCalls.mockClear();

    activityCb!("message");
    await flush();

    expect(getGroupWatchlist).not.toHaveBeenCalled();
    expect(getGroupCalls).not.toHaveBeenCalled();
  });

  it("re-pulls the watchlist on a direct table change (covers a REMOVAL, which emits no activity)", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();
    getGroupWatchlist.mockClear();

    expect(watchlistCb).toBeTypeOf("function");
    watchlistCb!();
    await flush();

    expect(getGroupWatchlist).toHaveBeenCalledWith("g1");
  });

  it("re-pulls the call ledger on a direct table change (covers a removed call)", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();
    getGroupCalls.mockClear();

    callsCb!();
    await flush();

    expect(getGroupCalls).toHaveBeenCalledWith("g1");
  });

  it("drops a watchlist re-pull whose response lands AFTER the viewer switched groups", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();

    // A slow re-pull for g1 that only resolves after we've moved to g2. The
    // activeId guard inside refreshWatchlist must discard it so g1's rows never
    // leak into the g2 view.
    let resolveSlow!: (rows: unknown[]) => void;
    getGroupWatchlist.mockReturnValueOnce(new Promise((res) => { resolveSlow = res as (r: unknown[]) => void; }));

    void useGroupsStore.getState().refreshWatchlist(); // starts the g1 pull
    await useGroupsStore.getState().selectGroup("g2"); // switch before it resolves
    await flush();

    resolveSlow([
      { id: "wX", groupId: "g1", ticker: "NVDA", note: "", addedBy: { id: "u", handle: null, displayName: "X", avatarAccent: "#000" }, createdAt: "x" },
    ]);
    await flush();

    // active group is g2; the g1 rows must have been discarded by the guard
    expect(useGroupsStore.getState().watchlist).toHaveLength(0);
  });
});

describe("Group realtime: leaderboard toggle broadcast (C-4)", () => {
  it("patches leaderboardEnabled in the groups list when another admin flips it", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();
    expect(groupSettingsCb).toBeTypeOf("function");

    groupSettingsCb!({ leaderboardEnabled: true });

    const g1 = useGroupsStore.getState().groups.find((g) => g.id === "g1");
    expect(g1?.leaderboardEnabled).toBe(true);
  });
});

describe("Cross-group unread dots (C-3)", () => {
  beforeEach(() => {
    listMyGroups.mockResolvedValue([GROUP_A, GROUP_B]);
  });

  it("stamps latestActivity for a non-active member group on a live insert", async () => {
    await useGroupsStore.getState().loadMyGroups();
    await flush();
    expect(groupsActivityCb).toBeTypeOf("function");

    const ts = "2026-06-19T12:00:00.000Z";
    groupsActivityCb!("g2", ts);

    expect(useGroupsStore.getState().latestActivity.g2).toBe(ts);
  });

  it("ignores activity for a group the viewer is not a member of", async () => {
    await useGroupsStore.getState().loadMyGroups();
    await flush();

    groupsActivityCb!("g-not-mine", "2026-06-19T12:00:00.000Z");

    expect(useGroupsStore.getState().latestActivity["g-not-mine"]).toBeUndefined();
  });

  it("does not move the stamp backwards for an older insert", async () => {
    await useGroupsStore.getState().loadMyGroups();
    await flush();

    const newer = "2026-06-19T12:00:00.000Z";
    const older = "2026-06-19T11:00:00.000Z";
    groupsActivityCb!("g2", newer);
    groupsActivityCb!("g2", older);

    expect(useGroupsStore.getState().latestActivity.g2).toBe(newer);
  });
});

function member(id: string): GroupMember {
  return {
    membershipId: `m-${id}`,
    groupId: "g1",
    role: "member",
    joinedAt: new Date(0).toISOString(),
    profile: { id, handle: null, displayName: id, avatarAccent: "#000" },
  };
}

describe("Group realtime: member roster + count (W4-C #1)", () => {
  it("re-pulls members AND patches the rail member count on a group_members change", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();
    expect(membersCb).toBeTypeOf("function");

    // A teammate accepts an invite → the group now has 3 members. The roster
    // re-pull and the rail's memberCount must both reflect it live.
    getGroupMembers.mockResolvedValueOnce([member("user-1"), member("user-2"), member("user-3")]);
    membersCb!();
    await flush();

    expect(getGroupMembers).toHaveBeenLastCalledWith("g1");
    expect(useGroupsStore.getState().members).toHaveLength(3);
    expect(useGroupsStore.getState().groups.find((g) => g.id === "g1")?.memberCount).toBe(3);
  });

  it("discards a member re-pull whose response lands after the viewer switched groups", async () => {
    await useGroupsStore.getState().selectGroup("g1");
    await flush();

    let resolveSlow!: (rows: GroupMember[]) => void;
    getGroupMembers.mockReturnValueOnce(new Promise<GroupMember[]>((res) => { resolveSlow = res; }));
    void useGroupsStore.getState().refreshMembers(); // starts the g1 pull
    await useGroupsStore.getState().selectGroup("g2"); // switch before it resolves
    await flush();

    resolveSlow([member("user-1"), member("user-2")]);
    await flush();

    // active group is g2; the g1 roster must have been discarded by the guard
    expect(useGroupsStore.getState().members).toHaveLength(0);
  });
});

describe("initGroupsSync auth lifecycle (W4-C #2/#3)", () => {
  beforeEach(() => {
    // Pre-arm so a sign-in transition re-loads the groups list deterministically.
    listMyGroups.mockResolvedValue([GROUP_A, GROUP_B]);
  });

  it("loads groups + opens an app-level membership channel on sign-in", async () => {
    // Start signed out so initGroupsSync's subscribe sees a null→user transition.
    useAuthStore.setState({ userId: null });
    useGroupsStore.getState().reset();
    initGroupsSync();

    useAuthStore.setState({ userId: "user-1" });
    await flush();

    expect(listMyGroups).toHaveBeenCalled();
    expect(G.subscribeToMyMemberships).toHaveBeenCalledWith("user-1", expect.any(Function));
    expect(myMembershipsCb).toBeTypeOf("function");
  });

  it("re-loads groups when the viewer is added to a new group (membership INSERT)", async () => {
    useAuthStore.setState({ userId: null });
    useGroupsStore.getState().reset();
    initGroupsSync();
    useAuthStore.setState({ userId: "user-1" });
    await flush();
    listMyGroups.mockClear();

    // Simulate a group_members INSERT for the viewer arriving over realtime.
    myMembershipsCb!();
    await flush();

    expect(listMyGroups).toHaveBeenCalledTimes(1);
  });

  it("resets the groups store on sign-out", async () => {
    useAuthStore.setState({ userId: null });
    useGroupsStore.getState().reset();
    initGroupsSync();
    useAuthStore.setState({ userId: "user-1" });
    await flush();

    // Populate some state that a sign-out must clear.
    useGroupsStore.setState({ activeId: "g1", members: [member("user-1")], readMarks: { g1: "x" } });

    useAuthStore.setState({ userId: null }); // sign out
    await flush();

    const s = useGroupsStore.getState();
    expect(s.activeId).toBeNull();
    expect(s.groups).toHaveLength(0);
    expect(s.members).toHaveLength(0);
    expect(s.readMarks).toEqual({});
  });
});
