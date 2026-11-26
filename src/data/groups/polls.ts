import type { GroupPoll, PollOption } from "./types";

/**
 * Pure poll math - tallies, leader detection, and the "is this poll open right
 * now" check. No I/O, no clock reads beyond the `now` the caller passes, so it
 * stays fully unit-testable (see __tests__/polls.test.ts).
 */

/** True when the poll still accepts votes at `now` (not hard-closed, not past its deadline). */
export function isPollOpen(poll: Pick<GroupPoll, "closed" | "closesAt">, now: number = Date.now()): boolean {
  if (poll.closed) return false;
  if (poll.closesAt && new Date(poll.closesAt).getTime() <= now) return false;
  return true;
}

/** Share of total votes for an option, 0..1. Returns 0 when there are no votes. */
export function optionShare(option: Pick<PollOption, "votes">, totalVotes: number): number {
  if (totalVotes <= 0) return 0;
  return option.votes / totalVotes;
}

/**
 * The winning option id(s). Returns every option tied for the lead (so the UI
 * can mark a draw honestly) and an empty array when no votes are in yet.
 */
export function leadingOptionIds(options: PollOption[]): string[] {
  const max = options.reduce((m, o) => Math.max(m, o.votes), 0);
  if (max <= 0) return [];
  return options.filter((o) => o.votes === max).map((o) => o.id);
}

/**
 * Fold raw vote rows into per-option tallies + the viewer's current vote.
 * `votes` is the flat (optionId, voter) list from group_poll_votes for ONE poll.
 * Pure - the caller supplies the viewer id; never reads global state.
 */
export function tallyPoll(
  options: PollOption[],
  votes: { optionId: string; voter: string }[],
  viewerId: string | null,
): { options: PollOption[]; totalVotes: number; myVote: string | null } {
  const counts = new Map<string, number>();
  let myVote: string | null = null;
  for (const v of votes) {
    counts.set(v.optionId, (counts.get(v.optionId) ?? 0) + 1);
    if (viewerId && v.voter === viewerId) myVote = v.optionId;
  }
  const tallied = options
    .map((o) => ({ ...o, votes: counts.get(o.id) ?? 0 }))
    .sort((a, b) => a.position - b.position);
  return { options: tallied, totalVotes: votes.length, myVote };
}

/** Split a list of polls into open-first, then closed - each newest-first. */
export function sortPolls(polls: GroupPoll[], now: number = Date.now()): GroupPoll[] {
  return [...polls].sort((a, b) => {
    const ao = isPollOpen(a, now);
    const bo = isPollOpen(b, now);
    if (ao !== bo) return ao ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
