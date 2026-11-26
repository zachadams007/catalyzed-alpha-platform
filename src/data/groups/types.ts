import type { Profile } from "@/data/supabase/friends";

/**
 * Domain types for Groups - private, invite-only shared spaces. Mirrors the
 * Supabase schema in supabase/migrations/0008_groups.sql. Profiles are reused
 * from the friends backend so avatars/handles render identically everywhere.
 */

export type GroupRole = "owner" | "admin" | "member";

/** A logged stock "call": a directional bet (buy) or a tracked interest (watch). */
export type CallDirection = "buy" | "watch";

/** A group the viewer belongs to, plus their role and the headcount. */
export interface GroupSummary {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  leaderboardEnabled: boolean;
  createdAt: string;
  role: GroupRole;
  memberCount: number;
}

export interface GroupMember {
  membershipId: string;
  groupId: string;
  role: GroupRole;
  joinedAt: string;
  profile: Profile;
}

/** A ticker on the shared group watchlist, attributed to whoever added it. */
export interface GroupWatchItem {
  id: string;
  groupId: string;
  ticker: string;
  note: string;
  addedBy: Profile;
  createdAt: string;
}

/** Where a member-holding ticker was surfaced (drives the source chip + copy). */
export type MemberHoldingSource = "watchlist" | "call" | "public_portfolio";

/**
 * One ticker a group member is surfacing, as seen by a co-member. NOT a private
 * portfolio readout - only what's already member-visible: their shared-group
 * watchlist adds, their group calls, and any PUBLIC portfolio holdings. Deduped
 * by ticker (the strongest source wins) by the data layer.
 */
export interface MemberHolding {
  ticker: string;
  source: MemberHoldingSource;
  note: string;
  createdAt: string;
}

/** One immutable call in the ledger. `calledPrice` is the snapshot at call time. */
export interface GroupCall {
  id: string;
  groupId: string;
  ticker: string;
  direction: CallDirection;
  calledPrice: number;
  note: string;
  calledAt: string;
  author: Profile;
}

export interface GroupInvite {
  id: string;
  groupId: string;
  token: string;
  revoked: boolean;
  expiresAt: string | null;
  createdAt: string;
}

/** What peek_invite() returns for an invite landing preview (pre-join). */
export interface InvitePreview {
  groupId: string | null;
  groupName: string | null;
  memberCount: number;
  valid: boolean;
}

/**
 * An incoming PENDING invite addressed to the viewer by a friend (distinct from
 * the shareable link/code path). Shown in the Groups tab with Accept / Decline.
 * Maps a row of public.group_member_invites joined to its group + inviter.
 */
export interface PendingGroupInvite {
  id: string;
  groupId: string;
  groupName: string;
  inviter: Profile;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** One chat line. Immutable (no edit) - author/admin may delete. */
export interface GroupMessage {
  id: string;
  groupId: string;
  body: string;
  createdAt: string;
  author: Profile;
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

/** One choice on a poll. `ticker` is set when the option is a security. */
export interface PollOption {
  id: string;
  label: string;
  ticker: string | null;
  position: number;
  /** Tally - filled in from the votes (see data/groups/polls.ts). */
  votes: number;
}

/**
 * A poll with its options + the viewer's current vote. `closed` is the hard
 * flag; a poll past `closesAt` is also treated as closed in the UI.
 */
export interface GroupPoll {
  id: string;
  groupId: string;
  question: string;
  closed: boolean;
  closesAt: string | null;
  createdAt: string;
  author: Profile;
  options: PollOption[];
  totalVotes: number;
  /** The option id this viewer voted for, or null if they haven't voted. */
  myVote: string | null;
}

/** A draft option in the create-poll composer (label and/or ticker). */
export interface PollOptionDraft {
  label: string;
  ticker: string | null;
}

// ---------------------------------------------------------------------------
// Activity / alerts
// ---------------------------------------------------------------------------

export type ActivityKind = "message" | "call" | "watchlist" | "poll_opened" | "poll_closed";

/** Small denormalized payload carried on an activity row (see meta in 0009). */
export interface ActivityMeta {
  ticker?: string;
  direction?: CallDirection;
  preview?: string;
  question?: string;
}

/** One row in the in-group activity / alerts feed. */
export interface GroupActivity {
  id: string;
  groupId: string;
  kind: ActivityKind;
  refId: string | null;
  meta: ActivityMeta;
  createdAt: string;
  /** May be null when the acting account was deleted. */
  actor: Profile | null;
}
