import { supabase } from "@/data/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { fetchSnapshotQuotes } from "@/data/alpaca/snapshots";
import { tallyPoll } from "./polls";
import type { Profile } from "@/data/supabase/friends";
import type {
  ActivityKind,
  ActivityMeta,
  CallDirection,
  GroupActivity,
  GroupCall,
  GroupInvite,
  GroupMember,
  GroupMessage,
  GroupPoll,
  GroupRole,
  GroupSummary,
  GroupWatchItem,
  InvitePreview,
  MemberHolding,
  MemberHoldingSource,
  PendingGroupInvite,
  PollOption,
  PollOptionDraft,
} from "./types";

/**
 * Typed Supabase data-access for Groups. RLS (supabase/migrations/0008_groups.sql)
 * enforces that only members read/write a group's rows; create/join go through
 * SECURITY DEFINER RPCs. Related profiles are joined in JS via a second `in(...)`
 * query (same approach as the friends backend) rather than PostgREST embedding.
 */

const PROFILE_COLS = "id, handle, display_name, avatar_accent";

interface ProfileRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_accent: string | null;
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatarAccent: r.avatar_accent ?? "#3f5fc9",
  };
}

/** A placeholder profile for an id we couldn't resolve (deleted account, etc.). */
function unknownProfile(id: string): Profile {
  return { id, handle: null, displayName: "Member", avatarAccent: "#5a647c" };
}

async function fetchProfiles(ids: string[]): Promise<Map<string, Profile>> {
  const map = new Map<string, Profile>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return map;
  const { data, error } = await client().from("profiles").select(PROFILE_COLS).in("id", unique);
  if (error) throw error;
  for (const r of (data ?? []) as ProfileRow[]) map.set(r.id, toProfile(r));
  return map;
}

// ---------------------------------------------------------------------------
// Groups: list / create / join / preview / leave / settings
// ---------------------------------------------------------------------------

interface GroupRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  leaderboard_enabled: boolean;
  created_at: string;
}

/** Every group the signed-in user belongs to, with their role + headcount. */
export async function listMyGroups(userId: string): Promise<GroupSummary[]> {
  const c = client();
  const { data: mine, error: mineErr } = await c
    .from("group_members")
    .select("group_id, role")
    .eq("user_id", userId);
  if (mineErr) throw mineErr;

  const memberships = (mine ?? []) as { group_id: string; role: GroupRole }[];
  const groupIds = memberships.map((m) => m.group_id);
  if (groupIds.length === 0) return [];

  const roleByGroup = new Map(memberships.map((m) => [m.group_id, m.role]));

  const [{ data: groups, error: gErr }, { data: roster, error: rErr }] = await Promise.all([
    c.from("groups").select("id, name, description, created_by, leaderboard_enabled, created_at").in("id", groupIds),
    c.from("group_members").select("group_id").in("group_id", groupIds),
  ]);
  if (gErr) throw gErr;
  if (rErr) throw rErr;

  const counts = new Map<string, number>();
  for (const row of (roster ?? []) as { group_id: string }[]) {
    counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1);
  }

  return ((groups ?? []) as GroupRow[])
    .map((g): GroupSummary => ({
      id: g.id,
      name: g.name,
      description: g.description ?? "",
      createdBy: g.created_by,
      leaderboardEnabled: g.leaderboard_enabled,
      createdAt: g.created_at,
      role: roleByGroup.get(g.id) ?? "member",
      memberCount: counts.get(g.id) ?? 1,
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Create a group (atomic group + owner membership + first invite). Returns the new id + token. */
export async function createGroup(
  name: string,
  description: string,
): Promise<{ groupId: string; token: string }> {
  const { data, error } = await client().rpc("create_group", {
    p_name: name.trim(),
    p_description: description.trim(),
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { group_id: string; invite_token: string } | null;
  if (!row) throw new Error("Group creation returned no id.");
  return { groupId: row.group_id, token: row.invite_token };
}

/** Join a group from an invite token. Idempotent - re-joining is a no-op. */
export async function joinGroup(
  token: string,
): Promise<{ groupId: string; groupName: string; alreadyMember: boolean }> {
  const { data, error } = await client().rpc("join_group", { p_token: token.trim() });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { group_id: string; group_name: string; already_member: boolean }
    | null;
  if (!row) throw new Error("Couldn't join — invite not found.");
  return { groupId: row.group_id, groupName: row.group_name, alreadyMember: row.already_member };
}

/** Preview the group behind an invite token before joining (name + size). */
export async function peekInvite(token: string): Promise<InvitePreview> {
  const { data, error } = await client().rpc("peek_invite", { p_token: token.trim() });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { group_id: string | null; group_name: string | null; member_count: number; valid: boolean }
    | null;
  if (!row) return { groupId: null, groupName: null, memberCount: 0, valid: false };
  return {
    groupId: row.group_id,
    groupName: row.group_name,
    memberCount: Number(row.member_count ?? 0),
    valid: Boolean(row.valid),
  };
}

export async function leaveGroup(groupId: string, userId: string): Promise<void> {
  const { error } = await client()
    .from("group_members")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function setLeaderboardEnabled(groupId: string, enabled: boolean): Promise<void> {
  const { error } = await client()
    .from("groups")
    .update({ leaderboard_enabled: enabled })
    .eq("id", groupId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Members / invites
// ---------------------------------------------------------------------------

interface MemberRow {
  id: string;
  group_id: string;
  user_id: string;
  role: GroupRole;
  joined_at: string;
}

export async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { data, error } = await client()
    .from("group_members")
    .select("id, group_id, user_id, role, joined_at")
    .eq("group_id", groupId)
    .order("joined_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as MemberRow[];
  const profiles = await fetchProfiles(rows.map((r) => r.user_id));
  return rows.map((r) => ({
    membershipId: r.id,
    groupId: r.group_id,
    role: r.role,
    joinedAt: r.joined_at,
    profile: profiles.get(r.user_id) ?? unknownProfile(r.user_id),
  }));
}

/**
 * Subscribe to membership changes for the OPEN group. Fires on any change
 * (INSERT/UPDATE/DELETE) so the caller can re-pull the roster and patch the
 * member count when a teammate joins (e.g. accepts an invite), leaves, or has
 * their role changed - none of which emit a `group_activity` row, so this is the
 * only live signal for them (C-1).
 */
export function subscribeToMembers(groupId: string, onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`group-members-${groupId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "group_members", filter: `group_id=eq.${groupId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

/**
 * App-level subscription to the VIEWER's own membership rows across every group.
 * When the viewer is added to a new group (INSERT) or removed from one (DELETE) -
 * by an admin, an invite accept, or a leave on another device - the rail must
 * reflect it live without a reload. Filtered to `user_id=eq.<viewerId>` so it
 * only fires for the viewer's own memberships. The callback re-loads the groups
 * list (membership set changed). Stays up for the whole session; returns an
 * unsub fn (C-2).
 */
export function subscribeToMyMemberships(viewerId: string, onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`my-memberships-${viewerId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "group_members", filter: `user_id=eq.${viewerId}` },
      () => onChange(),
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "group_members", filter: `user_id=eq.${viewerId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Member holdings - another member's group-shared + public-portfolio tickers
// (0019_member_holdings.sql). A SELECT-only SECURITY DEFINER RPC, gated so it
// returns rows ONLY when the caller shares the named group with the target. A
// member's PRIVATE portfolio is never exposed (RLS on `portfolios` is unchanged);
// this is the watchlist adds / calls / PUBLIC portfolios they're already sharing.
// ---------------------------------------------------------------------------

interface MemberHoldingRow {
  ticker: string;
  source: MemberHoldingSource;
  note: string | null;
  created_at: string;
}

const HOLDING_SOURCE_RANK: Record<MemberHoldingSource, number> = {
  call: 0, // a logged call is the strongest signal of conviction
  public_portfolio: 1,
  watchlist: 2,
};

/**
 * Every ticker `memberId` is surfacing that the viewer is allowed to see, scoped
 * to the group the click happened in. De-duped by ticker - when the same ticker
 * shows up from more than one source we keep the strongest (call > public
 * portfolio > watchlist) and its note. Newest-first within the result.
 */
export async function getMemberHoldings(
  groupId: string,
  memberId: string,
): Promise<MemberHolding[]> {
  const { data, error } = await client().rpc("get_member_holdings", {
    p_group_id: groupId,
    p_member: memberId,
  });
  if (error) throw error;
  const rows = (data ?? []) as MemberHoldingRow[];

  const byTicker = new Map<string, MemberHolding>();
  for (const r of rows) {
    const ticker = (r.ticker ?? "").trim().toUpperCase();
    if (!ticker) continue;
    const next: MemberHolding = {
      ticker,
      source: r.source,
      note: r.note ?? "",
      createdAt: r.created_at,
    };
    const prev = byTicker.get(ticker);
    if (!prev) {
      byTicker.set(ticker, next);
      continue;
    }
    // Keep the stronger source; if equal, keep the one with a note, else newest.
    const stronger = HOLDING_SOURCE_RANK[next.source] < HOLDING_SOURCE_RANK[prev.source];
    const sameRank = HOLDING_SOURCE_RANK[next.source] === HOLDING_SOURCE_RANK[prev.source];
    if (stronger || (sameRank && !prev.note && next.note)) {
      // Preserve whichever note we actually have.
      byTicker.set(ticker, { ...next, note: next.note || prev.note });
    } else if (sameRank && prev.note === "" && next.note === "") {
      // Both noteless, same rank → keep the newest timestamp.
      if (new Date(next.createdAt).getTime() > new Date(prev.createdAt).getTime()) {
        byTicker.set(ticker, next);
      }
    }
  }

  return [...byTicker.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

interface InviteRow {
  id: string;
  group_id: string;
  token: string;
  revoked: boolean;
  expires_at: string | null;
  created_at: string;
}

/** The group's most recent live (non-revoked) invite, if any. */
export async function getActiveInvite(groupId: string): Promise<GroupInvite | null> {
  const { data, error } = await client()
    .from("group_invites")
    .select("id, group_id, token, revoked, expires_at, created_at")
    .eq("group_id", groupId)
    .eq("revoked", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as InviteRow;
  return {
    id: r.id,
    groupId: r.group_id,
    token: r.token,
    revoked: r.revoked,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Direct friend → group invites (0018_group_invites.sql)
// Distinct from the shareable link/code path above: a member invites a specific
// FRIEND, who gets a pending invite + a live notification and taps Accept.
// ---------------------------------------------------------------------------

/**
 * Invite one of the caller's friends to a group they belong to. SECURITY DEFINER
 * RPC enforces membership + friendship. Idempotent (re-inviting refreshes the
 * pending row). `alreadyMember` is true when the friend is already in the group.
 */
export async function inviteFriendToGroup(
  groupId: string,
  inviteeId: string,
): Promise<{ inviteId: string | null; groupName: string | null; alreadyMember: boolean }> {
  const { data, error } = await client().rpc("invite_friend_to_group", {
    p_group_id: groupId,
    p_invitee: inviteeId,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { invite_id: string | null; group_name: string | null; already_member: boolean }
    | null;
  if (!row) throw new Error("Invite failed — please try again.");
  return {
    inviteId: row.invite_id,
    groupName: row.group_name,
    alreadyMember: Boolean(row.already_member),
  };
}

interface PendingInviteRow {
  invite_id: string;
  group_id: string;
  group_name: string;
  inviter_id: string;
  inviter_handle: string | null;
  inviter_name: string | null;
  created_at: string;
}

/** Every pending invite addressed to the caller, with group name + inviter. */
export async function listMyGroupInvites(): Promise<PendingGroupInvite[]> {
  const { data, error } = await client().rpc("list_my_group_invites");
  if (error) throw error;
  return ((data ?? []) as PendingInviteRow[]).map((r) => ({
    id: r.invite_id,
    groupId: r.group_id,
    groupName: r.group_name,
    createdAt: r.created_at,
    inviter: toProfile({
      id: r.inviter_id,
      handle: r.inviter_handle,
      display_name: r.inviter_name,
      avatar_accent: null,
    }),
  }));
}

/** Accept a pending invite → joins the group as a member. */
export async function acceptGroupInvite(
  inviteId: string,
): Promise<{ groupId: string; groupName: string; alreadyMember: boolean }> {
  const { data, error } = await client().rpc("accept_group_invite", { p_invite_id: inviteId });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { group_id: string; group_name: string; already_member: boolean }
    | null;
  if (!row) throw new Error("Couldn't accept — invite not found.");
  return { groupId: row.group_id, groupName: row.group_name, alreadyMember: Boolean(row.already_member) };
}

/** Decline a pending invite. */
export async function declineGroupInvite(inviteId: string): Promise<void> {
  const { error } = await client().rpc("decline_group_invite", { p_invite_id: inviteId });
  if (error) throw error;
}

/**
 * App-level subscription to NEW invites addressed to the viewer. Filtered to
 * `invitee=eq.<viewerId>` so it only fires for invites sent TO them. Powers both
 * the live "Pending invites" section refresh and the notification toast. The
 * payload carries the new row's inviter + group_id; we re-list through the RPC
 * (RLS-scoped, with the group name + inviter handle joined) so the UI gets the
 * full display shape. Stays up for the whole session; returns an unsub fn.
 */
export function subscribeToMyGroupInvites(
  viewerId: string,
  onInsert: (row: { inviter: string | null; groupId: string | null }) => void,
): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`my-group-invites-${viewerId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "group_member_invites",
        filter: `invitee=eq.${viewerId}`,
      },
      (payload) => {
        const row = payload.new as { inviter?: string; group_id?: string };
        onInsert({ inviter: row.inviter ?? null, groupId: row.group_id ?? null });
      },
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Shared watchlist
// ---------------------------------------------------------------------------

interface WatchRow {
  id: string;
  group_id: string;
  ticker: string;
  added_by: string;
  note: string;
  created_at: string;
}

export async function getGroupWatchlist(groupId: string): Promise<GroupWatchItem[]> {
  const { data, error } = await client()
    .from("group_watchlist")
    .select("id, group_id, ticker, added_by, note, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as WatchRow[];
  const profiles = await fetchProfiles(rows.map((r) => r.added_by));
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    ticker: r.ticker,
    note: r.note ?? "",
    addedBy: profiles.get(r.added_by) ?? unknownProfile(r.added_by),
    createdAt: r.created_at,
  }));
}

export async function addWatchTicker(
  groupId: string,
  userId: string,
  ticker: string,
  note: string,
): Promise<void> {
  const { error } = await client().from("group_watchlist").insert({
    group_id: groupId,
    added_by: userId,
    ticker: ticker.trim().toUpperCase(),
    note: note.trim(),
  });
  if (error) throw error;
}

export async function removeWatchTicker(id: string): Promise<void> {
  const { error } = await client().from("group_watchlist").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Call ledger
// ---------------------------------------------------------------------------

interface CallRow {
  id: string;
  group_id: string;
  author: string;
  ticker: string;
  direction: CallDirection;
  called_price: number | string;
  note: string;
  called_at: string;
}

export async function getGroupCalls(groupId: string): Promise<GroupCall[]> {
  const { data, error } = await client()
    .from("group_calls")
    .select("id, group_id, author, ticker, direction, called_price, note, called_at")
    .eq("group_id", groupId)
    .order("called_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as CallRow[];
  const profiles = await fetchProfiles(rows.map((r) => r.author));
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    ticker: r.ticker,
    direction: r.direction,
    calledPrice: Number(r.called_price),
    note: r.note ?? "",
    calledAt: r.called_at,
    author: profiles.get(r.author) ?? unknownProfile(r.author),
  }));
}

export async function logCall(
  groupId: string,
  userId: string,
  ticker: string,
  direction: CallDirection,
  calledPrice: number,
  note: string,
): Promise<void> {
  const { error } = await client().from("group_calls").insert({
    group_id: groupId,
    author: userId,
    ticker: ticker.trim().toUpperCase(),
    direction,
    called_price: calledPrice,
    note: note.trim(),
  });
  if (error) throw error;
}

export async function deleteCall(id: string): Promise<void> {
  const { error } = await client().from("group_calls").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Prices (Alpaca snapshots) - the live/last price source for the leaderboard
// and the watchlist overlay. Never throws; returns a partial/empty map.
// ---------------------------------------------------------------------------

/** Current best-available prices for a set of tickers. Empty if Alpaca isn't configured. */
export async function fetchCurrentPrices(tickers: string[]): Promise<Record<string, number>> {
  const list = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (list.length === 0) return {};
  const snaps = await fetchSnapshotQuotes(list, { batchSize: 200 });
  const out: Record<string, number> = {};
  for (const [ticker, q] of Object.entries(snaps)) out[ticker] = q.price;
  return out;
}

/**
 * The price to stamp on a new call. Uses the live snapshot; returns null when no
 * quote is available so the caller can refuse to log a call without an honest
 * price (we never invent one).
 */
export async function snapshotPrice(ticker: string): Promise<number | null> {
  const prices = await fetchCurrentPrices([ticker]);
  return prices[ticker.trim().toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  group_id: string;
  author: string;
  body: string;
  created_at: string;
}

/** A page of chat history, oldest→newest so it reads top-to-bottom in the UI. */
export async function getGroupMessages(groupId: string, limit = 200): Promise<GroupMessage[]> {
  const { data, error } = await client()
    .from("group_messages")
    .select("id, group_id, author, body, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = ((data ?? []) as MessageRow[]).reverse(); // newest-first query → oldest-first view
  const profiles = await fetchProfiles(rows.map((r) => r.author));
  return rows.map((r) => toMessage(r, profiles));
}

function toMessage(r: MessageRow, profiles: Map<string, Profile>): GroupMessage {
  return {
    id: r.id,
    groupId: r.group_id,
    body: r.body,
    createdAt: r.created_at,
    author: profiles.get(r.author) ?? unknownProfile(r.author),
  };
}

export async function sendMessage(groupId: string, userId: string, body: string): Promise<GroupMessage> {
  const { data, error } = await client()
    .from("group_messages")
    .insert({ group_id: groupId, author: userId, body: body.trim() })
    .select("id, group_id, author, body, created_at")
    .single();
  if (error) throw error;
  const profiles = await fetchProfiles([userId]);
  return toMessage(data as MessageRow, profiles);
}

export async function deleteMessage(id: string): Promise<void> {
  const { error } = await client().from("group_messages").delete().eq("id", id);
  if (error) throw error;
}

/** Resolve a single message by id (used to hydrate a realtime INSERT payload). */
export async function getMessage(id: string): Promise<GroupMessage | null> {
  const { data, error } = await client()
    .from("group_messages")
    .select("id, group_id, author, body, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as MessageRow;
  const profiles = await fetchProfiles([r.author]);
  return toMessage(r, profiles);
}

/**
 * Subscribe to new chat lines for a group over Supabase Realtime. The payload
 * carries the new row id; we re-fetch through RLS to get the body + author
 * profile (and to confirm the viewer is allowed to see it). Returns an unsub fn.
 */
export function subscribeToMessages(
  groupId: string,
  onInsert: (message: GroupMessage) => void,
): () => void {
  if (!supabase) return () => {};
  const channel: RealtimeChannel = supabase
    .channel(`group-messages-${groupId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "group_messages", filter: `group_id=eq.${groupId}` },
      (payload) => {
        const id = (payload.new as { id?: string }).id;
        if (!id) return;
        void getMessage(id).then((m) => {
          if (m) onInsert(m);
        });
      },
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

interface PollRow {
  id: string;
  group_id: string;
  author: string;
  question: string;
  closed: boolean;
  closes_at: string | null;
  created_at: string;
}
interface PollOptionRow {
  id: string;
  poll_id: string;
  label: string;
  ticker: string | null;
  position: number;
}
interface PollVoteRow {
  poll_id: string;
  option_id: string;
  voter: string;
}

/** Every poll in a group with its options, live tallies, and the viewer's vote. */
export async function getGroupPolls(groupId: string, viewerId: string | null): Promise<GroupPoll[]> {
  const c = client();
  const { data: pollData, error: pErr } = await c
    .from("group_polls")
    .select("id, group_id, author, question, closed, closes_at, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false });
  if (pErr) throw pErr;
  const polls = (pollData ?? []) as PollRow[];
  if (polls.length === 0) return [];

  const pollIds = polls.map((p) => p.id);
  const [{ data: optData, error: oErr }, { data: voteData, error: vErr }] = await Promise.all([
    c.from("group_poll_options").select("id, poll_id, label, ticker, position").in("poll_id", pollIds),
    c.from("group_poll_votes").select("poll_id, option_id, voter").in("poll_id", pollIds),
  ]);
  if (oErr) throw oErr;
  if (vErr) throw vErr;

  const options = (optData ?? []) as PollOptionRow[];
  const votes = (voteData ?? []) as PollVoteRow[];
  const profiles = await fetchProfiles(polls.map((p) => p.author));

  const optsByPoll = new Map<string, PollOption[]>();
  for (const o of options) {
    const list = optsByPoll.get(o.poll_id) ?? [];
    list.push({ id: o.id, label: o.label, ticker: o.ticker, position: o.position, votes: 0 });
    optsByPoll.set(o.poll_id, list);
  }
  const votesByPoll = new Map<string, { optionId: string; voter: string }[]>();
  for (const v of votes) {
    const list = votesByPoll.get(v.poll_id) ?? [];
    list.push({ optionId: v.option_id, voter: v.voter });
    votesByPoll.set(v.poll_id, list);
  }

  return polls.map((p): GroupPoll => {
    const tallied = tallyPoll(optsByPoll.get(p.id) ?? [], votesByPoll.get(p.id) ?? [], viewerId);
    return {
      id: p.id,
      groupId: p.group_id,
      question: p.question,
      closed: p.closed,
      closesAt: p.closes_at,
      createdAt: p.created_at,
      author: profiles.get(p.author) ?? unknownProfile(p.author),
      options: tallied.options,
      totalVotes: tallied.totalVotes,
      myVote: tallied.myVote,
    };
  });
}

export async function createPoll(
  groupId: string,
  question: string,
  options: PollOptionDraft[],
  closesAt: string | null = null,
): Promise<string> {
  const payload = options.map((o) => ({
    label: o.label.trim(),
    ticker: o.ticker ? o.ticker.trim().toUpperCase() : null,
  }));
  const { data, error } = await client().rpc("create_poll", {
    p_group: groupId,
    p_question: question.trim(),
    p_options: payload,
    p_closes_at: closesAt,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as string;
}

export async function castVote(pollId: string, optionId: string): Promise<void> {
  const { error } = await client().rpc("cast_poll_vote", { p_poll: pollId, p_option: optionId });
  if (error) throw error;
}

export async function closePoll(pollId: string): Promise<void> {
  const { error } = await client().rpc("close_poll", { p_poll: pollId });
  if (error) throw error;
}

export async function deletePoll(pollId: string): Promise<void> {
  const { error } = await client().from("group_polls").delete().eq("id", pollId);
  if (error) throw error;
}

/** Live re-tally trigger: fires whenever a vote, poll, or option row changes. */
export function subscribeToPolls(groupId: string, onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`group-polls-${groupId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "group_poll_votes" }, () => onChange())
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "group_polls", filter: `group_id=eq.${groupId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Activity feed + read marks
// ---------------------------------------------------------------------------

interface ActivityRow {
  id: string;
  group_id: string;
  actor: string | null;
  kind: ActivityKind;
  ref_id: string | null;
  meta: ActivityMeta | null;
  created_at: string;
}

export async function getGroupActivity(groupId: string, limit = 60): Promise<GroupActivity[]> {
  const { data, error } = await client()
    .from("group_activity")
    .select("id, group_id, actor, kind, ref_id, meta, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as ActivityRow[];
  const actorIds = rows.map((r) => r.actor).filter((x): x is string => Boolean(x));
  const profiles = await fetchProfiles(actorIds);
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    kind: r.kind,
    refId: r.ref_id,
    meta: r.meta ?? {},
    createdAt: r.created_at,
    actor: r.actor ? profiles.get(r.actor) ?? unknownProfile(r.actor) : null,
  }));
}

/**
 * Subscribe to new activity rows (powers the live unread badge + feed). The
 * callback receives the new row's `kind` so the caller can refetch the matching
 * slice (e.g. re-pull the watchlist on a `watchlist` row, the call ledger on a
 * `call` row) in addition to refreshing the feed itself.
 */
export function subscribeToActivity(
  groupId: string,
  onChange: (kind: ActivityKind | null) => void,
): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`group-activity-${groupId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "group_activity", filter: `group_id=eq.${groupId}` },
      (payload) => onChange((payload.new as { kind?: ActivityKind }).kind ?? null),
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

/**
 * Subscribe to the shared watchlist for a group. Fires on any change (INSERT,
 * UPDATE, DELETE) so the caller can re-pull. DELETE is covered here specifically
 * because removing a ticker emits no activity row - without this, a teammate's
 * removal would never reach other members live (C-2).
 */
export function subscribeToWatchlist(groupId: string, onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`group-watchlist-${groupId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "group_watchlist", filter: `group_id=eq.${groupId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

/**
 * Subscribe to the call ledger for a group. Fires on any change so members see a
 * new call (and a removed one - which emits no activity row) live, keeping the
 * ledger and the leaderboard in sync (C-2).
 */
export function subscribeToCalls(groupId: string, onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`group-calls-${groupId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "group_calls", filter: `group_id=eq.${groupId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

/**
 * Subscribe to settings changes on the group row itself - currently the
 * leaderboard-enabled toggle - so an admin flipping it broadcasts to every other
 * member instead of only updating their own UI (C-4).
 */
export function subscribeToGroup(
  groupId: string,
  onChange: (row: { leaderboardEnabled: boolean }) => void,
): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`group-settings-${groupId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "groups", filter: `id=eq.${groupId}` },
      (payload) => {
        const row = payload.new as { leaderboard_enabled?: boolean };
        onChange({ leaderboardEnabled: Boolean(row.leaderboard_enabled) });
      },
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

/**
 * App-level subscription to NEW activity across ALL of the viewer's groups, used
 * to light up the unread DOT on non-active groups in the rail without reloading
 * (C-3). The per-group activity channel in `selectGroup` only covers the OPEN
 * group; this one stays up for the whole session.
 *
 * One channel for every `group_activity` INSERT: Realtime honors the table's RLS
 * SELECT policy, so the viewer only receives rows for groups they belong to. The
 * callback gets the row's group id + created_at to stamp `latestActivity`. Returns
 * an unsub fn (rebuild it when membership changes - e.g. after loadMyGroups).
 */
export function subscribeToGroupsActivity(
  onInsert: (groupId: string, createdAt: string) => void,
): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel("groups-activity-all")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "group_activity" },
      (payload) => {
        const row = payload.new as { group_id?: string; created_at?: string };
        if (row.group_id && row.created_at) onInsert(row.group_id, row.created_at);
      },
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Per-group presence (Supabase Realtime Presence - no tables, no migrations)
// ---------------------------------------------------------------------------

export interface PresenceMember {
  userId: string;
  name: string;
  typing?: boolean;
}

/**
 * Per-group presence channel. Tracks which viewers have the group open and
 * whether they are currently typing. Returns an unsub fn. The caller gets
 * notified on every presence sync with the current set of online members.
 */
export function subscribeToGroupPresence(
  groupId: string,
  viewerId: string,
  viewerName: string,
  onSync: (members: PresenceMember[]) => void,
): { unsub: () => void; track: (payload: Partial<PresenceMember>) => void } {
  if (!supabase) return { unsub: () => {}, track: () => {} };

  const channel = supabase.channel(`group-presence-${groupId}`, {
    config: { presence: { key: viewerId } },
  });

  const getMembers = (): PresenceMember[] => {
    const state = channel.presenceState<{ userId?: string; name?: string; typing?: boolean }>();
    const seen = new Set<string>();
    const out: PresenceMember[] = [];
    for (const entries of Object.values(state)) {
      for (const e of entries as Array<{ userId?: string; name?: string; typing?: boolean }>) {
        const uid = e.userId;
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        out.push({ userId: uid, name: e.name ?? "Member", typing: e.typing ?? false });
      }
    }
    return out;
  };

  channel
    .on("presence", { event: "sync" }, () => {
      onSync(getMembers());
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ userId: viewerId, name: viewerName, typing: false });
        onSync(getMembers());
      }
    });

  const track = (payload: Partial<PresenceMember>) => {
    void channel.track({ userId: viewerId, name: viewerName, typing: false, ...payload });
  };

  const unsub = () => {
    void channel.untrack();
    void supabase?.removeChannel(channel);
  };

  return { unsub, track };
}

/** The viewer's last-read timestamp for every group they're in (for unread badges). */
export async function getReadMarks(userId: string): Promise<Record<string, string>> {
  const { data, error } = await client()
    .from("group_reads")
    .select("group_id, last_read_at")
    .eq("user_id", userId);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { group_id: string; last_read_at: string }[]) {
    out[r.group_id] = r.last_read_at;
  }
  return out;
}

export async function markGroupRead(groupId: string): Promise<string> {
  const { error } = await client().rpc("mark_group_read", { p_group: groupId });
  if (error) throw error;
  return new Date().toISOString();
}

/**
 * One bounded query across the viewer's groups; RLS scopes it to memberships.
 */
export async function getLatestActivityStamps(groupIds: string[]): Promise<Record<string, string>> {
  if (groupIds.length === 0) return {};
  const { data, error } = await client()
    .from("group_activity")
    .select("group_id, created_at")
    .in("group_id", groupIds)
    .order("created_at", { ascending: false })
    .limit(600);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { group_id: string; created_at: string }[]) {
    if (!out[r.group_id]) out[r.group_id] = r.created_at; // first seen = newest (ordered desc)
  }
  return out;
}
