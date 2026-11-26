import { describe, it, expect } from "vitest";

import type { GroupPoll, PollOption } from "@/data/groups/types";
import {
  isPollOpen,
  leadingOptionIds,
  optionShare,
  sortPolls,
  tallyPoll,
} from "@/data/groups/polls";

const NOW = Date.UTC(2026, 5, 18, 15, 0, 0);
const HOUR = 60 * 60 * 1000;

function opt(id: string, position: number, label = id): PollOption {
  return { id, label, ticker: null, position, votes: 0 };
}

// ---------------------------------------------------------------------------
// isPollOpen
// ---------------------------------------------------------------------------
describe("isPollOpen", () => {
  it("is open when not closed and no deadline", () => {
    expect(isPollOpen({ closed: false, closesAt: null }, NOW)).toBe(true);
  });
  it("is closed when the hard flag is set", () => {
    expect(isPollOpen({ closed: true, closesAt: null }, NOW)).toBe(false);
  });
  it("is open before its deadline, closed after", () => {
    expect(isPollOpen({ closed: false, closesAt: new Date(NOW + HOUR).toISOString() }, NOW)).toBe(true);
    expect(isPollOpen({ closed: false, closesAt: new Date(NOW - HOUR).toISOString() }, NOW)).toBe(false);
  });
  it("treats the exact deadline instant as closed", () => {
    expect(isPollOpen({ closed: false, closesAt: new Date(NOW).toISOString() }, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tallyPoll
// ---------------------------------------------------------------------------
describe("tallyPoll", () => {
  const options = [opt("a", 0), opt("b", 1), opt("c", 2)];

  it("counts votes per option and totals them", () => {
    const votes = [
      { optionId: "a", voter: "u1" },
      { optionId: "a", voter: "u2" },
      { optionId: "b", voter: "u3" },
    ];
    const r = tallyPoll(options, votes, null);
    expect(r.totalVotes).toBe(3);
    expect(r.options.find((o) => o.id === "a")!.votes).toBe(2);
    expect(r.options.find((o) => o.id === "b")!.votes).toBe(1);
    expect(r.options.find((o) => o.id === "c")!.votes).toBe(0);
  });

  it("identifies the viewer's own vote", () => {
    const votes = [
      { optionId: "a", voter: "u1" },
      { optionId: "c", voter: "me" },
    ];
    expect(tallyPoll(options, votes, "me").myVote).toBe("c");
    expect(tallyPoll(options, votes, "other").myVote).toBeNull();
    expect(tallyPoll(options, votes, null).myVote).toBeNull();
  });

  it("keeps options ordered by position regardless of input order", () => {
    const shuffled = [opt("c", 2), opt("a", 0), opt("b", 1)];
    const r = tallyPoll(shuffled, [], null);
    expect(r.options.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// optionShare / leadingOptionIds
// ---------------------------------------------------------------------------
describe("optionShare", () => {
  it("is the fraction of total votes", () => {
    expect(optionShare({ votes: 3 }, 4)).toBeCloseTo(0.75, 10);
  });
  it("is 0 when there are no votes (no divide-by-zero)", () => {
    expect(optionShare({ votes: 0 }, 0)).toBe(0);
  });
});

describe("leadingOptionIds", () => {
  it("returns the single leader", () => {
    const o = [{ ...opt("a", 0), votes: 1 }, { ...opt("b", 1), votes: 3 }, { ...opt("c", 2), votes: 2 }];
    expect(leadingOptionIds(o)).toEqual(["b"]);
  });
  it("returns every option tied for the lead (a draw)", () => {
    const o = [{ ...opt("a", 0), votes: 2 }, { ...opt("b", 1), votes: 2 }, { ...opt("c", 2), votes: 1 }];
    expect(leadingOptionIds(o).sort()).toEqual(["a", "b"]);
  });
  it("is empty when no votes are in", () => {
    expect(leadingOptionIds([opt("a", 0), opt("b", 1)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sortPolls
// ---------------------------------------------------------------------------
describe("sortPolls", () => {
  function poll(id: string, over: Partial<GroupPoll>): GroupPoll {
    return {
      id,
      groupId: "g1",
      question: id,
      closed: false,
      closesAt: null,
      createdAt: new Date(NOW).toISOString(),
      author: { id: "u1", handle: "u1", displayName: "U1", avatarAccent: "#1ab2e8" },
      options: [],
      totalVotes: 0,
      myVote: null,
      ...over,
    };
  }

  it("puts open polls before closed ones, each newest-first", () => {
    const polls = [
      poll("closed-old", { closed: true, createdAt: new Date(NOW - 3 * HOUR).toISOString() }),
      poll("open-old", { createdAt: new Date(NOW - 2 * HOUR).toISOString() }),
      poll("open-new", { createdAt: new Date(NOW - 1 * HOUR).toISOString() }),
      poll("closed-new", { closed: true, createdAt: new Date(NOW).toISOString() }),
    ];
    expect(sortPolls(polls, NOW).map((p) => p.id)).toEqual([
      "open-new",
      "open-old",
      "closed-new",
      "closed-old",
    ]);
  });

  it("treats a past-deadline poll as closed for ordering", () => {
    const polls = [
      poll("expired", { closesAt: new Date(NOW - HOUR).toISOString(), createdAt: new Date(NOW).toISOString() }),
      poll("live", { createdAt: new Date(NOW - HOUR).toISOString() }),
    ];
    expect(sortPolls(polls, NOW).map((p) => p.id)).toEqual(["live", "expired"]);
  });
});
