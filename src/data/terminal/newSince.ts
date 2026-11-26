/**
 * "New since last visit" helpers for the Terminal home wire.
 *
 * Pure + deterministic so they're unit-testable: given an event's `surfacedAt`
 * and the user's PREVIOUS visit timestamp, decide whether it should carry a
 * "new" marker. A null `since` (the first ever visit) marks nothing - we don't
 * flood a first-time view with badges. Severity-then-recency ranking is owned by
 * the feed aggregator; this layer only annotates, never re-sorts.
 */

/** True when an event surfaced strictly after the user's previous visit. */
export function isNewSince(surfacedAtISO: string, sinceISO: string | null): boolean {
  if (!sinceISO) return false;
  const surfaced = Date.parse(surfacedAtISO);
  const since = Date.parse(sinceISO);
  if (!Number.isFinite(surfaced) || !Number.isFinite(since)) return false;
  return surfaced > since;
}

/** Count how many events surfaced since the previous visit. */
export function countNewSince(
  events: ReadonlyArray<{ surfacedAt: string }>,
  sinceISO: string | null,
): number {
  if (!sinceISO) return 0;
  let count = 0;
  for (const event of events) {
    if (isNewSince(event.surfacedAt, sinceISO)) count += 1;
  }
  return count;
}
