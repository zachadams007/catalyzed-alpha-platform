import type { ActivityKind, GroupActivity } from "./types";

/**
 * Pure helpers for the in-group activity / alerts feed: unread counting against
 * a "last read" mark, and human copy for each event kind. No I/O - the caller
 * passes the read mark, so this is fully unit-testable (see __tests__/activity.test.ts).
 */

/**
 * How many feed rows are newer than the viewer's last-read mark, NOT counting the
 * viewer's own actions (you don't get notified about what you just did).
 * `lastReadAt` null → everything not authored by the viewer is unread.
 */
export function unreadCount(
  activity: GroupActivity[],
  lastReadAt: string | null,
  viewerId: string | null,
): number {
  const since = lastReadAt ? new Date(lastReadAt).getTime() : 0;
  let n = 0;
  for (const a of activity) {
    if (viewerId && a.actor?.id === viewerId) continue;
    if (new Date(a.createdAt).getTime() > since) n += 1;
  }
  return n;
}

/** A short actor label, falling back gracefully through display name → handle → "Someone". */
export function actorName(a: GroupActivity): string {
  return a.actor?.displayName || a.actor?.handle || "Someone";
}

/**
 * One-line human summary of an activity row. Returns the verb-phrase only - the
 * UI prepends the actor name (so it can style the name separately).
 */
export function activitySummary(a: GroupActivity): string {
  const t = a.meta.ticker;
  switch (a.kind) {
    case "call": {
      const verb = a.meta.direction === "watch" ? "flagged a watch on" : "called a buy on";
      return t ? `${verb} ${t}` : "logged a call";
    }
    case "watchlist":
      return t ? `added ${t} to the watchlist` : "added a name to the watchlist";
    case "poll_opened":
      return a.meta.question ? `opened a poll — “${a.meta.question}”` : "opened a poll";
    case "poll_closed":
      return a.meta.question ? `closed the poll “${a.meta.question}”` : "closed a poll";
    case "message":
      return a.meta.preview ? `said: “${a.meta.preview}”` : "sent a message";
    default:
      return "did something";
  }
}

/** The accent role for an event kind, so the feed dot/icon is color-coded. */
export function activityTone(kind: ActivityKind): "accent" | "gold" | "bull" | "muted" {
  switch (kind) {
    case "call":
      return "bull";
    case "poll_opened":
    case "poll_closed":
      return "gold";
    case "watchlist":
      return "accent";
    default:
      return "muted";
  }
}
