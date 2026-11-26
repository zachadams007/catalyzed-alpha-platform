import { create } from "zustand";
import { isSupabaseConfigured } from "@/data/supabase/client";
import { useAuthStore } from "@/store/useAuthStore";
import { resolveSymbol } from "@/data/symbols/symbolDirectory";
import * as G from "@/data/groups/groupsApi";
import type { PresenceMember } from "@/data/groups/groupsApi";
import { callTickers } from "@/data/groups/leaderboard";
import { unreadCount } from "@/data/groups/activity";
import type {
  ActivityKind,
  CallDirection,
  GroupActivity,
  GroupCall,
  GroupInvite,
  GroupMember,
  GroupMessage,
  GroupPoll,
  GroupSummary,
  GroupWatchItem,
  InvitePreview,
  MemberHolding,
  PendingGroupInvite,
  PollOptionDraft,
} from "@/data/groups/types";

/**
 * Groups state, backed by Supabase (RLS) + Alpaca snapshots for live prices.
 * Auth lives in useAuthStore; this store reads the current userId at action time.
 * All writes go through @/data/groups/groupsApi and refresh the affected slice -
 * no polling, mirroring the rest of the app's live-price discipline.
 */

type Status = "idle" | "loading" | "ready" | "error";
type Result = { ok: boolean; error?: string };

interface GroupsState {
  configured: boolean;

  groups: GroupSummary[];
  groupsStatus: Status;
  groupsError: string | null;

  activeId: string | null;
  members: GroupMember[];
  watchlist: GroupWatchItem[];
  calls: GroupCall[];
  invite: GroupInvite | null;
  detailStatus: Status;
  detailError: string | null;

  // Social layer (chat / polls / activity) for the active group.
  messages: GroupMessage[];
  polls: GroupPoll[];
  activity: GroupActivity[];

  /** Per-group last-read timestamps → drives the unread badge across the rail. */
  readMarks: Record<string, string>;
  /** Per-group newest-activity timestamp → the rail's unread dot for non-open groups. */
  latestActivity: Record<string, string>;

  /** Incoming PENDING group invites addressed to the viewer (Groups tab). */
  pendingInvites: PendingGroupInvite[];
  invitesStatus: Status;

  /** Members currently viewing this group (Realtime Presence). */
  onlineInGroup: PresenceMember[];

  prices: Record<string, number>;
  pricesUpdatedAt: string | null;
  pricesLoading: boolean;

  loadMyGroups: () => Promise<void>;
  createGroup: (name: string, description: string) => Promise<Result & { groupId?: string }>;
  joinByToken: (token: string) => Promise<Result & { groupId?: string; groupName?: string }>;
  peek: (token: string) => Promise<InvitePreview | null>;
  selectGroup: (id: string) => Promise<void>;
  refreshActive: () => Promise<void>;
  leaveActive: () => Promise<Result>;
  setLeaderboard: (enabled: boolean) => Promise<void>;
  addTicker: (ticker: string, note: string) => Promise<Result & { ticker?: string }>;
  /**
   * Post a ticker to ANY group the viewer belongs to (not just the active one).
   * Powers the feed-tile "Share to group" flow. Reflects the new ticker live if
   * the shared group happens to be the one currently open.
   */
  shareTickerToGroup: (
    groupId: string,
    ticker: string,
    note: string,
  ) => Promise<Result & { ticker?: string; groupName?: string }>;
  removeTicker: (id: string) => Promise<void>;

  /**
   * Direct friend → group invites (alongside the link/code path).
   * - inviteFriendToGroup: from a group, invite one of the viewer's friends.
   * - loadInvites: pull the viewer's pending incoming invites (Groups tab).
   * - acceptInvite / declineInvite: respond to an incoming invite.
   */
  inviteFriendToGroup: (
    groupId: string,
    inviteeId: string,
  ) => Promise<Result & { groupName?: string; alreadyMember?: boolean }>;
  loadInvites: () => Promise<void>;
  acceptInvite: (inviteId: string) => Promise<Result & { groupId?: string; groupName?: string }>;
  declineInvite: (inviteId: string) => Promise<void>;

  /**
   * Log a ranked buy/watch call. Defaults to the active group when `groupId`
   * is omitted (existing callers), but accepts an explicit target group so a
   * call can be logged from outside the Groups page (e.g. the stock detail
   * page's "Call out" action, which has no active group selected).
   */
  logCall: (
    ticker: string,
    direction: CallDirection,
    note: string,
    groupId?: string,
  ) => Promise<Result & { ticker?: string }>;
  removeCall: (id: string) => Promise<void>;
  refreshPrices: () => Promise<number>;

  // Chat
  sendMessage: (body: string) => Promise<Result>;
  removeMessage: (id: string) => Promise<void>;

  // Polls
  createPoll: (question: string, options: PollOptionDraft[], closesAt: string | null) => Promise<Result>;
  vote: (pollId: string, optionId: string) => Promise<Result>;
  closePoll: (pollId: string) => Promise<void>;
  removePoll: (pollId: string) => Promise<void>;
  refreshPolls: () => Promise<void>;

  /**
   * Fetch the tickers another group member is surfacing (their shared-group
   * watchlist adds, calls, and PUBLIC portfolios), scoped to a group you both
   * belong to. A private portfolio is never exposed - see 0019_member_holdings.
   * One-shot read; the caller (MemberHoldings modal) owns its loading/empty/error
   * state, so this returns a Result-shaped payload rather than holding it in store.
   */
  loadMemberHoldings: (
    groupId: string,
    memberId: string,
  ) => Promise<Result & { holdings?: MemberHolding[] }>;

  // Live re-pulls for the shared slices (driven by realtime, see selectGroup).
  refreshWatchlist: () => Promise<void>;
  refreshCalls: () => Promise<void>;
  refreshMembers: () => Promise<void>;

  /** Re-track the viewer's presence payload with an updated typing flag. */
  setTypingInGroup: (typing: boolean) => void;

  // Activity / unread
  refreshActivity: () => Promise<void>;
  markRead: (groupId?: string) => Promise<void>;
  unreadFor: (groupId: string) => number;

  reset: () => void;
}

/** Active realtime channel teardown fns; cleared/re-armed on selectGroup/reset. */
let unsubscribers: Array<() => void> = [];

/** Presence channel tracker fn - updated when the viewer types. */
let presenceTrack: ((payload: Partial<PresenceMember>) => void) | null = null;
function teardownRealtime() {
  for (const off of unsubscribers) off();
  unsubscribers = [];
}

/**
 * App-level cross-group activity channel teardown (C-3). Separate from
 * `unsubscribers` because it must SURVIVE selectGroup switches - it powers the
 * unread dot for every group the viewer is in, not just the open one. Rebuilt on
 * each loadMyGroups (membership may have changed) and torn down on reset.
 */
let groupsActivityUnsub: (() => void) | null = null;
function teardownGroupsActivity() {
  if (groupsActivityUnsub) {
    groupsActivityUnsub();
    groupsActivityUnsub = null;
  }
}

function messageOf(e: unknown): string {
  // Supabase RPC/PostgREST errors are Error subclasses, but be defensive about a
  // plain `{ message }` reject too so a real backend message never collapses into
  // a generic one (this is what once hid the join_group colref bug as "Something
  // went wrong.").
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
  // Auth/permission failures get a clear, actionable line instead of raw SQL.
  if (/^not authenticated$/i.test(raw) || /permission denied/i.test(raw) || /\bjwt\b/i.test(raw)) {
    return "Your session expired — please sign in again to continue.";
  }
  return raw;
}

function uid(): string | null {
  return useAuthStore.getState().userId;
}

const EMPTY_DETAIL = {
  members: [] as GroupMember[],
  watchlist: [] as GroupWatchItem[],
  calls: [] as GroupCall[],
  invite: null as GroupInvite | null,
  messages: [] as GroupMessage[],
  polls: [] as GroupPoll[],
  activity: [] as GroupActivity[],
  onlineInGroup: [] as PresenceMember[],
};

/** Sort the activity feed newest-first (realtime inserts can arrive out of order). */
function sortActivity(rows: GroupActivity[]): GroupActivity[] {
  return [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  configured: isSupabaseConfigured,

  groups: [],
  groupsStatus: "idle",
  groupsError: null,

  activeId: null,
  ...EMPTY_DETAIL,
  detailStatus: "idle",
  detailError: null,

  readMarks: {},
  latestActivity: {},

  pendingInvites: [],
  invitesStatus: "idle",

  prices: {},
  pricesUpdatedAt: null,
  pricesLoading: false,

  loadMyGroups: async () => {
    const userId = uid();
    if (!get().configured || !userId) {
      set({ groups: [], groupsStatus: "ready" });
      return;
    }
    set({ groupsStatus: "loading", groupsError: null });
    try {
      const [groups, readMarks] = await Promise.all([
        G.listMyGroups(userId),
        G.getReadMarks(userId).catch(() => ({} as Record<string, string>)),
      ]);
      set({ groups, readMarks, groupsStatus: "ready" });
      // Fire-and-forget the unread-dot stamps so the rail lights up shortly after.
      void G.getLatestActivityStamps(groups.map((g) => g.id))
        .then((latestActivity) => set({ latestActivity }))
        .catch(() => {});

      // Keep the unread dots LIVE for every group the viewer is in, not just the
      // open one (C-3). One app-level subscription, rebuilt here in case the
      // viewer's membership set changed since the last load. RLS scopes the
      // delivered rows to the viewer's groups, so we only stamp groups we hold.
      teardownGroupsActivity();
      const myGroupIds = new Set(groups.map((g) => g.id));
      groupsActivityUnsub = G.subscribeToGroupsActivity((groupId, createdAt) => {
        if (!myGroupIds.has(groupId)) return;
        const prev = get().latestActivity[groupId];
        if (prev && new Date(prev).getTime() >= new Date(createdAt).getTime()) return;
        set({ latestActivity: { ...get().latestActivity, [groupId]: createdAt } });
      });

      // Keep a selection in view if the active group is still ours.
      const active = get().activeId;
      if (active && !groups.some((g) => g.id === active)) {
        set({ activeId: null, ...EMPTY_DETAIL, detailStatus: "idle" });
      }
    } catch (e) {
      set({ groupsStatus: "error", groupsError: messageOf(e) });
    }
  },

  createGroup: async (name, description) => {
    const userId = uid();
    if (!userId) return { ok: false, error: "Sign in to create a group." };
    if (!name.trim()) return { ok: false, error: "Give your group a name." };
    try {
      const { groupId } = await G.createGroup(name, description);
      await get().loadMyGroups();
      await get().selectGroup(groupId);
      return { ok: true, groupId };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  joinByToken: async (token) => {
    const userId = uid();
    if (!userId) return { ok: false, error: "Sign in to join a group." };
    if (!token.trim()) return { ok: false, error: "Paste an invite link or code." };
    try {
      const { groupId, groupName } = await G.joinGroup(token);
      await get().loadMyGroups();
      await get().selectGroup(groupId);
      return { ok: true, groupId, groupName };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  peek: async (token) => {
    if (!get().configured || !token.trim()) return null;
    try {
      return await G.peekInvite(token);
    } catch {
      return null;
    }
  },

  selectGroup: async (id) => {
    const viewerId = uid();
    if (get().activeId !== id) set({ ...EMPTY_DETAIL });
    teardownRealtime(); // drop the previous group's channels
    set({ activeId: id, detailStatus: "loading", detailError: null });
    try {
      const [members, watchlist, calls, invite, messages, polls, activity] = await Promise.all([
        G.getGroupMembers(id),
        G.getGroupWatchlist(id),
        G.getGroupCalls(id),
        G.getActiveInvite(id).catch(() => null), // invites are admin-readable; non-admins just won't see one
        G.getGroupMessages(id).catch(() => [] as GroupMessage[]),
        G.getGroupPolls(id, viewerId).catch(() => [] as GroupPoll[]),
        G.getGroupActivity(id).catch(() => [] as GroupActivity[]),
      ]);
      // Ignore a stale response if the user switched groups mid-flight.
      if (get().activeId !== id) return;
      set({ members, watchlist, calls, invite, messages, polls, activity: sortActivity(activity), detailStatus: "ready" });
      void get().refreshPrices();

      // Live updates - chat lines, poll tallies, activity, the shared watchlist,
      // the call ledger/leaderboard, and the leaderboard toggle, scoped to this
      // group. Each guards on the active group so a stale channel from a
      // just-switched group can't write into the new view.
      unsubscribers = [
        G.subscribeToMessages(id, (m) => {
          if (get().activeId !== id) return;
          if (get().messages.some((x) => x.id === m.id)) return; // de-dupe our own echo
          set({ messages: [...get().messages, m] });
        }),
        G.subscribeToPolls(id, () => {
          if (get().activeId === id) void get().refreshPolls();
        }),
        // Activity always refreshes the feed/unread badge; on a watchlist- or
        // call-kind row, also re-pull that slice so the Watchlist tab, call
        // ledger, and leaderboard update live for every member (C-2).
        G.subscribeToActivity(id, (kind) => {
          if (get().activeId !== id) return;
          void get().refreshActivity();
          if (kind === "watchlist") void get().refreshWatchlist();
          if (kind === "call") void get().refreshCalls();
        }),
        // Direct table subscriptions catch the changes activity rows don't emit -
        // notably a watchlist/call REMOVAL (no activity row is written) (C-2).
        G.subscribeToWatchlist(id, () => {
          if (get().activeId === id) void get().refreshWatchlist();
        }),
        G.subscribeToCalls(id, () => {
          if (get().activeId === id) void get().refreshCalls();
        }),
        // The leaderboard-enabled toggle broadcasts to other members (C-4).
        G.subscribeToGroup(id, ({ leaderboardEnabled }) => {
          set({
            groups: get().groups.map((g) => (g.id === id ? { ...g, leaderboardEnabled } : g)),
          });
        }),
        // Membership changes emit no activity row, so the open group's roster +
        // member count would otherwise go stale when a teammate joins (e.g.
        // accepts an invite) or leaves. Re-pull members and patch the count
        // live (W4-C #1).
        G.subscribeToMembers(id, () => {
          if (get().activeId === id) void get().refreshMembers();
        }),
      ];

      // Per-group presence: who else has this group open right now.
      if (viewerId) {
        const authProfile = useAuthStore.getState().profile;
        const viewerName =
          authProfile?.displayName || authProfile?.handle || "Member";
        const { unsub: presenceUnsub, track } = G.subscribeToGroupPresence(
          id,
          viewerId,
          viewerName,
          (members) => {
            if (get().activeId === id) set({ onlineInGroup: members });
          },
        );
        presenceTrack = track;
        unsubscribers.push(presenceUnsub);
      }
    } catch (e) {
      if (get().activeId !== id) return;
      set({ detailStatus: "error", detailError: messageOf(e) });
    }
  },

  refreshActive: async () => {
    const id = get().activeId;
    if (id) await get().selectGroup(id);
  },

  leaveActive: async () => {
    const userId = uid();
    const id = get().activeId;
    if (!userId || !id) return { ok: false, error: "Nothing to leave." };
    try {
      teardownRealtime();
      await G.leaveGroup(id, userId);
      set({ activeId: null, ...EMPTY_DETAIL, detailStatus: "idle" });
      await get().loadMyGroups();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  setLeaderboard: async (enabled) => {
    const id = get().activeId;
    if (!id) return;
    // Optimistic - reflect the toggle instantly, then persist.
    set({
      groups: get().groups.map((g) => (g.id === id ? { ...g, leaderboardEnabled: enabled } : g)),
    });
    try {
      await G.setLeaderboardEnabled(id, enabled);
    } catch {
      set({
        groups: get().groups.map((g) => (g.id === id ? { ...g, leaderboardEnabled: !enabled } : g)),
      });
    }
  },

  addTicker: async (ticker, note) => {
    const userId = uid();
    const id = get().activeId;
    if (!userId || !id) return { ok: false, error: "Open a group first." };
    const match = resolveSymbol(ticker);
    if (!match) return { ok: false, error: `We don't recognize "${ticker.trim()}". Try a ticker like NVDA.` };
    try {
      await G.addWatchTicker(id, userId, match.symbol, note);
      const watchlist = await G.getGroupWatchlist(id);
      set({ watchlist });
      void get().refreshPrices();
      return { ok: true, ticker: match.symbol };
    } catch (e) {
      const msg = messageOf(e);
      // Unique violation → already on the list; surface it kindly.
      if (/duplicate key|unique/i.test(msg)) {
        return { ok: false, error: `${match.symbol} is already on the watchlist.` };
      }
      return { ok: false, error: msg };
    }
  },

  shareTickerToGroup: async (groupId, ticker, note) => {
    const userId = uid();
    if (!userId) return { ok: false, error: "Sign in to share to a group." };
    const match = resolveSymbol(ticker);
    if (!match) return { ok: false, error: `We don't recognize "${ticker.trim()}". Try a ticker like NVDA.` };
    const groupName = get().groups.find((g) => g.id === groupId)?.name;
    try {
      await G.addWatchTicker(groupId, userId, match.symbol, note);
      // If the viewer is looking at this group, surface the new ticker immediately.
      if (get().activeId === groupId) {
        const watchlist = await G.getGroupWatchlist(groupId);
        set({ watchlist });
        void get().refreshPrices();
      }
      return { ok: true, ticker: match.symbol, groupName };
    } catch (e) {
      const msg = messageOf(e);
      // Unique violation → already shared with this group; surface it kindly.
      if (/duplicate key|unique/i.test(msg)) {
        return { ok: false, error: `${match.symbol} is already on ${groupName ?? "the group"}'s watchlist.` };
      }
      return { ok: false, error: msg };
    }
  },

  removeTicker: async (id) => {
    const groupId = get().activeId;
    if (!groupId) return;
    const prev = get().watchlist;
    set({ watchlist: prev.filter((w) => w.id !== id) }); // optimistic
    try {
      await G.removeWatchTicker(id);
    } catch {
      set({ watchlist: prev });
    }
  },

  // -------------------------------------------------------------------------
  // Direct friend → group invites
  // -------------------------------------------------------------------------
  inviteFriendToGroup: async (groupId, inviteeId) => {
    const userId = uid();
    if (!userId) return { ok: false, error: "Sign in to invite friends." };
    try {
      const r = await G.inviteFriendToGroup(groupId, inviteeId);
      if (r.alreadyMember) {
        return { ok: false, error: "They're already in this group.", alreadyMember: true };
      }
      return { ok: true, groupName: r.groupName ?? undefined };
    } catch (e) {
      const msg = messageOf(e);
      // A re-invite that the DB upsert can't refresh surfaces as a unique clash;
      // treat it as "already invited" rather than a hard error.
      if (/duplicate key|unique/i.test(msg)) {
        return { ok: false, error: "You've already invited them." };
      }
      return { ok: false, error: msg };
    }
  },

  loadInvites: async () => {
    const userId = uid();
    if (!get().configured || !userId) {
      set({ pendingInvites: [], invitesStatus: "ready" });
      return;
    }
    set({ invitesStatus: "loading" });
    try {
      const pendingInvites = await G.listMyGroupInvites();
      set({ pendingInvites, invitesStatus: "ready" });
    } catch {
      // A failed pull just means the section shows its last-good/empty state -
      // never block the page on it.
      set({ invitesStatus: "error" });
    }
  },

  acceptInvite: async (inviteId) => {
    const userId = uid();
    if (!userId) return { ok: false, error: "Sign in to accept." };
    const prev = get().pendingInvites;
    // Optimistic: drop it from the list immediately.
    set({ pendingInvites: prev.filter((i) => i.id !== inviteId) });
    try {
      const r = await G.acceptGroupInvite(inviteId);
      // Reflect the new membership in the rail + open it.
      await get().loadMyGroups();
      await get().selectGroup(r.groupId);
      return { ok: true, groupId: r.groupId, groupName: r.groupName };
    } catch (e) {
      set({ pendingInvites: prev }); // roll back
      return { ok: false, error: messageOf(e) };
    }
  },

  declineInvite: async (inviteId) => {
    const prev = get().pendingInvites;
    set({ pendingInvites: prev.filter((i) => i.id !== inviteId) }); // optimistic
    try {
      await G.declineGroupInvite(inviteId);
    } catch {
      set({ pendingInvites: prev });
    }
  },

  logCall: async (ticker, direction, note, groupId) => {
    const userId = uid();
    const id = groupId ?? get().activeId;
    if (!userId || !id) return { ok: false, error: "Open a group first." };
    const match = resolveSymbol(ticker);
    if (!match) return { ok: false, error: `We don't recognize "${ticker.trim()}". Try a ticker like NVDA.` };
    try {
      const price = await G.snapshotPrice(match.symbol);
      if (price == null) {
        return {
          ok: false,
          error: `Couldn't get a live price for ${match.symbol} right now — a call needs an honest price at call time. Try again shortly.`,
        };
      }
      await G.logCall(id, userId, match.symbol, direction, price, note);
      // Only re-pull the ledger slice when the logged-to group is the one
      // currently open - logging from outside Groups (e.g. the stock detail
      // page) has no open group's `calls` slice to refresh.
      if (get().activeId === id) {
        const calls = await G.getGroupCalls(id);
        set({ calls });
        void get().refreshPrices();
      }
      return { ok: true, ticker: match.symbol };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  removeCall: async (id) => {
    const groupId = get().activeId;
    if (!groupId) return;
    const prev = get().calls;
    set({ calls: prev.filter((c) => c.id !== id) }); // optimistic
    try {
      await G.deleteCall(id);
    } catch {
      set({ calls: prev });
    }
  },

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------
  sendMessage: async (body) => {
    const userId = uid();
    const id = get().activeId;
    if (!userId || !id) return { ok: false, error: "Open a group first." };
    const text = body.trim();
    if (!text) return { ok: false, error: "Type a message." };
    try {
      const message = await G.sendMessage(id, userId, text);
      // Append immediately (realtime echo is de-duped by id in selectGroup).
      if (get().activeId === id && !get().messages.some((m) => m.id === message.id)) {
        set({ messages: [...get().messages, message] });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  removeMessage: async (id) => {
    const prev = get().messages;
    set({ messages: prev.filter((m) => m.id !== id) }); // optimistic
    try {
      await G.deleteMessage(id);
    } catch {
      set({ messages: prev });
    }
  },

  // -------------------------------------------------------------------------
  // Polls
  // -------------------------------------------------------------------------
  createPoll: async (question, options, closesAt) => {
    const id = get().activeId;
    if (!id) return { ok: false, error: "Open a group first." };
    const q = question.trim();
    if (!q) return { ok: false, error: "Give the poll a question." };
    const clean = options.map((o) => ({ label: o.label.trim(), ticker: o.ticker })).filter((o) => o.label || o.ticker);
    if (clean.length < 2) return { ok: false, error: "Add at least two options." };
    try {
      await G.createPoll(id, q, clean, closesAt);
      await get().refreshPolls();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  vote: async (pollId, optionId) => {
    const viewerId = uid();
    const id = get().activeId;
    if (!viewerId || !id) return { ok: false, error: "Open a group first." };
    // Optimistic: move this viewer's vote to the chosen option and re-tally.
    const prev = get().polls;
    set({
      polls: prev.map((p) => {
        if (p.id !== pollId) return p;
        const had = p.myVote;
        if (had === optionId) return p;
        const options = p.options.map((o) => {
          let votes = o.votes;
          if (o.id === optionId) votes += 1;
          if (had && o.id === had) votes -= 1;
          return { ...o, votes };
        });
        const totalVotes = had ? p.totalVotes : p.totalVotes + 1;
        return { ...p, options, totalVotes, myVote: optionId };
      }),
    });
    try {
      await G.castVote(pollId, optionId);
      return { ok: true };
    } catch (e) {
      set({ polls: prev }); // roll back
      return { ok: false, error: messageOf(e) };
    }
  },

  closePoll: async (pollId) => {
    const prev = get().polls;
    set({ polls: prev.map((p) => (p.id === pollId ? { ...p, closed: true } : p)) }); // optimistic
    try {
      await G.closePoll(pollId);
    } catch {
      set({ polls: prev });
    }
  },

  removePoll: async (pollId) => {
    const prev = get().polls;
    set({ polls: prev.filter((p) => p.id !== pollId) }); // optimistic
    try {
      await G.deletePoll(pollId);
    } catch {
      set({ polls: prev });
    }
  },

  refreshPolls: async () => {
    const id = get().activeId;
    if (!id) return;
    try {
      const polls = await G.getGroupPolls(id, uid());
      if (get().activeId === id) set({ polls });
    } catch {
      /* keep the last good tally on a transient error */
    }
  },

  loadMemberHoldings: async (groupId, memberId) => {
    const userId = uid();
    if (!userId) return { ok: false, error: "Sign in to view a member's holdings." };
    try {
      const holdings = await G.getMemberHoldings(groupId, memberId);
      return { ok: true, holdings };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  },

  // -------------------------------------------------------------------------
  // Live re-pulls for the shared slices (fired by the realtime subscriptions in
  // selectGroup when another member changes them). Each guards on the active
  // group so a late response can't write into a group the viewer has left.
  // -------------------------------------------------------------------------
  refreshWatchlist: async () => {
    const id = get().activeId;
    if (!id) return;
    try {
      const watchlist = await G.getGroupWatchlist(id);
      if (get().activeId === id) {
        set({ watchlist });
        void get().refreshPrices();
      }
    } catch {
      /* keep the last good watchlist on a transient error */
    }
  },

  refreshCalls: async () => {
    const id = get().activeId;
    if (!id) return;
    try {
      const calls = await G.getGroupCalls(id);
      if (get().activeId === id) {
        set({ calls });
        void get().refreshPrices();
      }
    } catch {
      /* keep the last good ledger on a transient error */
    }
  },

  refreshMembers: async () => {
    const id = get().activeId;
    if (!id) return;
    try {
      const members = await G.getGroupMembers(id);
      if (get().activeId !== id) return;
      // Re-pull the roster AND keep the rail's member count in sync (the open
      // group's count is otherwise only set on listMyGroups).
      set({
        members,
        groups: get().groups.map((g) => (g.id === id ? { ...g, memberCount: members.length } : g)),
      });
    } catch {
      /* keep the last good roster on a transient error */
    }
  },

  // -------------------------------------------------------------------------
  // Activity / unread
  // -------------------------------------------------------------------------
  refreshActivity: async () => {
    const id = get().activeId;
    if (!id) return;
    try {
      const activity = await G.getGroupActivity(id);
      if (get().activeId === id) set({ activity: sortActivity(activity) });
    } catch {
      /* keep last good feed */
    }
  },

  markRead: async (groupId) => {
    const id = groupId ?? get().activeId;
    if (!id || !get().configured) return;
    // Optimistic local mark so the badge clears instantly.
    set({ readMarks: { ...get().readMarks, [id]: new Date().toISOString() } });
    try {
      const ts = await G.markGroupRead(id);
      set({ readMarks: { ...get().readMarks, [id]: ts } });
    } catch {
      /* a failed mark just means the badge reappears next load - acceptable */
    }
  },

  unreadFor: (groupId) => {
    const { activeId, activity, readMarks, latestActivity } = get();
    const viewerId = uid();
    // The OPEN group has its full feed loaded → exact unread count.
    if (groupId === activeId) {
      return unreadCount(activity, readMarks[groupId] ?? null, viewerId);
    }
    // Other groups: a best-effort DOT (count 1) when the newest activity stamp is
    // ahead of the read mark. We don't hold their rows, so we can't exclude the
    // viewer's own actions here - opening the group reconciles to the exact count.
    const newest = latestActivity[groupId];
    if (!newest) return 0;
    const read = readMarks[groupId];
    return !read || new Date(newest).getTime() > new Date(read).getTime() ? 1 : 0;
  },

  setTypingInGroup: (typing) => {
    if (presenceTrack) presenceTrack({ typing });
  },

  refreshPrices: async () => {
    const { watchlist, calls } = get();
    const tickers = [...new Set([...watchlist.map((w) => w.ticker), ...callTickers(calls)])];
    if (tickers.length === 0) {
      set({ prices: {}, pricesUpdatedAt: new Date().toISOString() });
      return 0;
    }
    set({ pricesLoading: true });
    try {
      const fresh = await G.fetchCurrentPrices(tickers);
      set({
        prices: { ...get().prices, ...fresh },
        pricesUpdatedAt: new Date().toISOString(),
        pricesLoading: false,
      });
      return Object.keys(fresh).length;
    } catch {
      set({ pricesLoading: false });
      return 0;
    }
  },

  reset: () => {
    teardownRealtime();
    teardownGroupsActivity();
    presenceTrack = null;
    set({
      groups: [],
      groupsStatus: "idle",
      groupsError: null,
      activeId: null,
      ...EMPTY_DETAIL,
      detailStatus: "idle",
      detailError: null,
      readMarks: {},
      latestActivity: {},
      pendingInvites: [],
      invitesStatus: "idle",
      prices: {},
      pricesUpdatedAt: null,
      pricesLoading: false,
    });
  },
}));

// ---------------------------------------------------------------------------
// App-level auth lifecycle (W4-C)
// ---------------------------------------------------------------------------
//
// Groups realtime used to be scoped to the /groups page: loadMyGroups (and the
// cross-group activity channel it opens) ran only on the page mount, and reset()
// ran only on the page's sign-out effect. So off /groups the unread dots were
// dead and a sign-out never cleared another account's groups from memory.
//
// `initGroupsSync` mirrors the initFriendsSync / initPresence pattern: it watches
// the auth store's userId and, app-wide:
//   • on sign-in  → loadMyGroups() (which opens the cross-group activity channel)
//                    + an app-level group_members channel so being ADDED to a new
//                    group is live in the rail without a reload;
//   • on sign-out → reset(), tearing down every groups channel and purging state
//                    so nothing leaks between accounts.
// Idempotent; a no-op when Supabase is unconfigured. Called once from App.tsx.

let groupsSyncStarted = false;
let groupsSyncUserId: string | null = null;
let myMembershipsUnsub: (() => void) | null = null;
let myInvitesUnsub: (() => void) | null = null;
let groupsSyncReady = false;

function onGroupsSignIn(userId: string): void {
  groupsSyncUserId = userId;
  groupsSyncReady = false;
  void useGroupsStore.getState().loadMyGroups().then(() => {
    groupsSyncReady = true;
  });
  // Pull the viewer's pending group invites once on sign-in (Groups tab section).
  void useGroupsStore.getState().loadInvites();

  // Keep incoming invites LIVE: when a friend invites the viewer to a group, an
  // INSERT on group_member_invites (invitee = me) fires. Re-pull the list (so the
  // Groups-tab section updates without a reload) AND push the SAME style toast the
  // friend/share notifications use - mirroring initFriendNotifications. A short
  // ready-gate skips toasts for any backfill the channel might replay on connect.
  if (myInvitesUnsub) myInvitesUnsub();
  let invitesNotifReady = false;
  setTimeout(() => { invitesNotifReady = true; }, 600);
  myInvitesUnsub = G.subscribeToMyGroupInvites(userId, ({ inviter, groupId }) => {
    const store = useGroupsStore.getState();
    void store.loadInvites().then(() => {
      if (!invitesNotifReady) return;
      // Prefer the freshly-listed invite (it carries the group name + inviter
      // handle joined server-side) to compose a friendly, specific toast.
      const fresh = useGroupsStore
        .getState()
        .pendingInvites.find((i) => (groupId ? i.groupId === groupId : false) && (inviter ? i.inviter.id === inviter : true));
      const inviterName = fresh?.inviter.displayName || fresh?.inviter.handle;
      const groupName = fresh?.groupName;
      const msg =
        inviterName && groupName
          ? `${inviterName} invited you to ${groupName}`
          : groupName
            ? `You were invited to ${groupName}`
            : "You have a new group invite";
      import("@/store/useAppStore")
        .then(({ useAppStore }) => useAppStore.getState().pushToast(msg, "info"))
        .catch(() => {});
    });
  });

  if (myMembershipsUnsub) myMembershipsUnsub();
  myMembershipsUnsub = G.subscribeToMyMemberships(userId, () => {
    // Membership set changed (added to / removed from a group elsewhere) →
    // re-pull so the new group appears (or the lost one drops) in the rail live.
    const prevCount = useGroupsStore.getState().groups.length;
    void useGroupsStore.getState().loadMyGroups().then(() => {
      if (!groupsSyncReady) return;
      const nextCount = useGroupsStore.getState().groups.length;
      if (nextCount > prevCount) {
        import("@/store/useAppStore")
          .then(({ useAppStore }) => {
            useAppStore.getState().pushToast("You were added to a new group", "info");
          })
          .catch(() => {});
      }
    });
  });
}

function onGroupsSignOut(): void {
  groupsSyncUserId = null;
  groupsSyncReady = false;
  if (myMembershipsUnsub) {
    myMembershipsUnsub();
    myMembershipsUnsub = null;
  }
  if (myInvitesUnsub) {
    myInvitesUnsub();
    myInvitesUnsub = null;
  }
  useGroupsStore.getState().reset();
}

export function initGroupsSync(): void {
  if (groupsSyncStarted || !isSupabaseConfigured) return;
  groupsSyncStarted = true;

  useAuthStore.subscribe((state) => {
    const next = state.userId;
    if (next && next !== groupsSyncUserId) onGroupsSignIn(next);
    else if (!next && groupsSyncUserId) onGroupsSignOut();
  });

  const existing = useAuthStore.getState().userId;
  if (existing) onGroupsSignIn(existing);
}

// Dev-only handle so the headless screenshot harness can drive Groups rendering
// without a live Supabase session (mirrors window.__appStore / __authStore).
// Stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __groupsStore?: typeof useGroupsStore }).__groupsStore = useGroupsStore;
}
