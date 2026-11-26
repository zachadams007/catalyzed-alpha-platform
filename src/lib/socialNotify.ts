import type { ToastOptions } from "@/store/useAppStore";

/**
 * Social notification reconcile - the "even if you were offline" half of the
 * notification system.
 *
 * The realtime channels in useAuthStore/useGroupsStore only fire a toast when the
 * event happens WHILE you're online. So if a friend adds you (or invites you to a
 * group / shares a ticker) while the app is closed, you'd only ever see the silent
 * badge on reopen. This module closes that gap: on every load it diffs the current
 * pending social items against a PERSISTED "already-toasted" set and fires the
 * bottom-right toast for anything new - so a friend request that arrived overnight
 * pops a notification the next time you open the app. The persisted set also makes
 * it idempotent, so it never re-toasts the same item or double-fires with the live
 * realtime path (both go through the same set).
 *
 * Pure core (buildSocialNotices / reconcileNotices) + a thin localStorage-backed
 * wrapper, so the diff/cap logic is unit-tested without a DOM or network.
 */

export type ToastTone = "info" | "success" | "warn";

/** A would-be notification, with a stable id used for dedupe. */
export interface SocialNotice {
  id: string;
  message: string;
  tone: ToastTone;
  href: string;
  /** ISO timestamp used to order the burst newest-first. */
  createdAt: string;
}

interface NamedProfile {
  displayName: string | null;
  handle: string | null;
}
interface IncomingReq {
  friendshipId: string;
  profile: NamedProfile;
  createdAt: string;
}
interface GroupInvite {
  id: string;
  groupName: string;
  inviter: NamedProfile;
  createdAt: string;
}
interface ShareItem {
  id: string;
  author: NamedProfile;
  ticker: string;
  createdAt: string;
}
interface FriendItem {
  friendshipId: string;
  profile: NamedProfile;
}

export interface SocialInputs {
  incoming: IncomingReq[];
  invites: GroupInvite[];
  shares?: ShareItem[];
  /** Current accepted friends - used to detect a NEW connection (someone accepted
   *  my request, or I accepted theirs). First run is seeded silently so the whole
   *  existing list doesn't toast; only accepts AFTER that notify. */
  friends?: FriendItem[];
}

/** At most this many individual toasts in one reconcile; the rest collapse into a
 *  single summary toast so a long-offline backlog never spams the corner. */
export const MAX_BURST = 3;

function nameOf(p: NamedProfile): string {
  const dn = p.displayName?.trim();
  if (dn) return dn;
  const h = p.handle?.trim();
  if (h) return h.startsWith("@") ? h : `@${h}`;
  return "Someone";
}

/** Turn the raw pending social state into candidate notices (stable ids). */
export function buildSocialNotices(inputs: SocialInputs): SocialNotice[] {
  const out: SocialNotice[] = [];
  for (const r of inputs.incoming) {
    out.push({
      id: `freq:${r.friendshipId}`,
      message: `${nameOf(r.profile)} added you as a friend`,
      tone: "info",
      href: "/friends",
      createdAt: r.createdAt,
    });
  }
  for (const i of inputs.invites) {
    out.push({
      id: `ginv:${i.id}`,
      message: `${nameOf(i.inviter)} invited you to ${i.groupName}`,
      tone: "info",
      href: "/groups",
      createdAt: i.createdAt,
    });
  }
  for (const s of inputs.shares ?? []) {
    out.push({
      id: `share:${s.id}`,
      message: `${nameOf(s.author)} shared ${s.ticker} with you`,
      tone: "info",
      href: "/friends",
      createdAt: s.createdAt,
    });
  }
  for (const f of inputs.friends ?? []) {
    out.push({
      id: `facc:${f.friendshipId}`,
      message: `You're now connected with ${nameOf(f.profile)}`,
      tone: "success",
      href: "/friends",
      // Friends carry no accepted-at timestamp; "" sorts after dated events (a
      // pending request is more urgent than a settled connection in a burst).
      createdAt: "",
    });
  }
  // Newest first so the burst cap keeps the most recent events.
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export interface ReconcileResult {
  /** Individual toasts to fire (already capped to MAX_BURST). */
  toToast: SocialNotice[];
  /** A single collapsed toast for the overflow, or null. */
  summary: { message: string; href: string } | null;
  /** The full set of ids that are now considered "seen" (toasted or summarized). */
  nextSeen: string[];
}

/**
 * Diff candidate notices against the seen set: fire up to MAX_BURST individually,
 * collapse the rest into one summary, and return the updated seen set. Pure.
 */
export function reconcileNotices(notices: SocialNotice[], seen: Iterable<string>): ReconcileResult {
  const seenSet = new Set(seen);
  const fresh = notices.filter((n) => !seenSet.has(n.id));
  if (fresh.length === 0) return { toToast: [], summary: null, nextSeen: [...seenSet] };

  const toToast = fresh.slice(0, MAX_BURST);
  const overflow = fresh.length - toToast.length;
  const summary =
    overflow > 0
      ? { message: `+${overflow} more friend & group update${overflow === 1 ? "" : "s"}`, href: "/friends" }
      : null;

  // Everything fresh is now "seen" (the overflow was covered by the summary). Keep
  // the seen list bounded so it can't grow without limit on a chatty account.
  const nextSeen = [...seenSet, ...fresh.map((n) => n.id)].slice(-300);
  return { toToast, summary, nextSeen };
}

// ---------------------------------------------------------------------------
// localStorage-backed orchestration (the impure shell)
// ---------------------------------------------------------------------------

const SEEN_PREFIX = "catalyzed:social-seen:";

function seenKey(userId: string): string {
  return `${SEEN_PREFIX}${userId}`;
}

export function loadSeen(userId: string): string[] {
  try {
    const raw = localStorage.getItem(seenKey(userId));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveSeen(userId: string, ids: string[]): void {
  try {
    localStorage.setItem(seenKey(userId), JSON.stringify(ids));
  } catch {
    /* storage full / unavailable - non-fatal, we just re-toast next open */
  }
}

const FRIEND_SEED_PREFIX = "catalyzed:social-friendseed:";

/**
 * The FIRST time we ever look at a user's friends, mark all current connections
 * as already-seen WITHOUT toasting - otherwise enabling this feature would pop a
 * "you're now connected" toast for every existing friend. Only accepts that
 * happen AFTER this seeding will notify. Idempotent via a per-user flag.
 */
function seedFriendsOnce(userId: string, friends: ReadonlyArray<{ friendshipId: string }>): void {
  const flagKey = `${FRIEND_SEED_PREFIX}${userId}`;
  try {
    if (localStorage.getItem(flagKey)) return;
    const seen = new Set(loadSeen(userId));
    for (const f of friends) seen.add(`facc:${f.friendshipId}`);
    saveSeen(userId, [...seen]);
    localStorage.setItem(flagKey, "1");
  } catch {
    /* storage unavailable - worst case a one-time connect toast per friend */
  }
}

type PushToast = (message: string, tone?: ToastTone, opts?: ToastOptions) => void;

/** Social toasts linger longer than confirmations so they can be tapped. */
const SOCIAL_TOAST_MS = 6000;

/**
 * Reconcile the current pending social state against this user's seen set and fire
 * any new notifications. Safe to call on every load and on every realtime change -
 * it only toasts genuinely-new items. Returns the number of toasts fired (for tests
 * / telemetry).
 */
export function runSocialReconcile(userId: string, inputs: SocialInputs, pushToast: PushToast): number {
  // Seed the existing friends list once so only NEW connections notify.
  seedFriendsOnce(userId, inputs.friends ?? []);
  const notices = buildSocialNotices(inputs);
  const { toToast, summary, nextSeen } = reconcileNotices(notices, loadSeen(userId));
  if (toToast.length === 0 && !summary) return 0;
  for (const n of toToast) {
    pushToast(n.message, n.tone, { href: n.href, durationMs: SOCIAL_TOAST_MS });
  }
  if (summary) pushToast(summary.message, "info", { href: summary.href, durationMs: SOCIAL_TOAST_MS });
  saveSeen(userId, nextSeen);
  return toToast.length + (summary ? 1 : 0);
}
