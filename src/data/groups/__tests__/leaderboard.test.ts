import { describe, it, expect } from "vitest";

import type { Profile } from "@/data/supabase/friends";
import type { CallDirection, GroupCall } from "@/data/groups/types";
import {
  CALL_MATURITY_MS,
  buildLeaderboard,
  callTickers,
  computeCallPerformance,
  rankCalls,
} from "@/data/groups/leaderboard";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 5, 17, 18, 0, 0); // fixed clock - deterministic
const HOUR = 60 * 60 * 1000;
const MATURE_AT = new Date(NOW - 2 * HOUR).toISOString(); // 2h old → matured
const YOUNG_AT = new Date(NOW - 5 * 60 * 1000).toISOString(); // 5m old → pending

function profile(id: string, displayName: string): Profile {
  return { id, handle: displayName.toLowerCase(), displayName, avatarAccent: "#1ab2e8" };
}

let seq = 0;
function call(over: Partial<GroupCall> & { author: Profile; ticker: string; calledPrice: number }): GroupCall {
  seq += 1;
  return {
    id: `call-${seq}`,
    groupId: "g1",
    direction: "buy" as CallDirection,
    note: "",
    calledAt: MATURE_AT,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// computeCallPerformance
// ---------------------------------------------------------------------------

describe("computeCallPerformance", () => {
  const zach = profile("u-zach", "Zach");

  it("computes a positive return for a matured, priced buy call and scores it", () => {
    const c = call({ author: zach, ticker: "NVDA", calledPrice: 100, calledAt: MATURE_AT });
    const perf = computeCallPerformance(c, 125, NOW);
    expect(perf.returnPct).toBeCloseTo(0.25, 10);
    expect(perf.status).toBe("mature");
    expect(perf.scored).toBe(true);
    expect(perf.currentPrice).toBe(125);
  });

  it("computes a negative return correctly", () => {
    const c = call({ author: zach, ticker: "SOFI", calledPrice: 20, calledAt: MATURE_AT });
    const perf = computeCallPerformance(c, 15, NOW);
    expect(perf.returnPct).toBeCloseTo(-0.25, 10);
    expect(perf.scored).toBe(true);
  });

  it("marks a fresh call pending (return shown, but not scored)", () => {
    const c = call({ author: zach, ticker: "AAPL", calledPrice: 200, calledAt: YOUNG_AT });
    const perf = computeCallPerformance(c, 210, NOW);
    expect(perf.status).toBe("pending");
    expect(perf.scored).toBe(false);
    expect(perf.returnPct).toBeCloseTo(0.05, 10); // live return is still computed
  });

  it("never scores a watch call, even when matured and up", () => {
    const c = call({ author: zach, ticker: "TSLA", calledPrice: 250, calledAt: MATURE_AT, direction: "watch" });
    const perf = computeCallPerformance(c, 300, NOW);
    expect(perf.status).toBe("mature");
    expect(perf.scored).toBe(false);
    expect(perf.returnPct).toBeCloseTo(0.2, 10);
  });

  it("is unpriced when there is no current quote", () => {
    const c = call({ author: zach, ticker: "XYZ", calledPrice: 10, calledAt: MATURE_AT });
    for (const missing of [null, undefined, 0, -3, NaN]) {
      const perf = computeCallPerformance(c, missing as number, NOW);
      expect(perf.status).toBe("unpriced");
      expect(perf.returnPct).toBeNull();
      expect(perf.scored).toBe(false);
    }
  });

  it("is unpriced when the called price is invalid", () => {
    const c = call({ author: zach, ticker: "XYZ", calledPrice: 0, calledAt: MATURE_AT });
    const perf = computeCallPerformance(c, 50, NOW);
    expect(perf.status).toBe("unpriced");
    expect(perf.returnPct).toBeNull();
  });

  it("treats a call exactly at the maturity threshold as matured", () => {
    const exactly = new Date(NOW - CALL_MATURITY_MS).toISOString();
    const c = call({ author: zach, ticker: "MSFT", calledPrice: 100, calledAt: exactly });
    expect(computeCallPerformance(c, 110, NOW).status).toBe("mature");
  });
});

// ---------------------------------------------------------------------------
// buildLeaderboard
// ---------------------------------------------------------------------------

describe("buildLeaderboard", () => {
  const zach = profile("u-zach", "Zach");
  const nina = profile("u-nina", "Nina");
  const omar = profile("u-omar", "Omar");

  const prices = { NVDA: 125, SOFI: 15, AAPL: 210, TSLA: 300, HOOD: 40 };

  it("ranks individual matured BUY calls by their own return, best first — not by member average", () => {
    const calls: GroupCall[] = [
      call({ author: zach, ticker: "NVDA", calledPrice: 100 }), // +25%
      call({ author: zach, ticker: "SOFI", calledPrice: 20 }), // -25%
      // Nina's single call (+50%) outranks the owner's NVDA call (+25%), even though
      // The owner has more calls - ranking is per-call, not a per-member average.
      call({ author: nina, ticker: "NVDA", calledPrice: 83.3333333 }), // +50%
    ];
    const board = buildLeaderboard(calls, prices, NOW);
    const rankedTickers = board.filter((r) => r.rank != null).map((r) => r.perf.call.ticker);
    expect(rankedTickers).toEqual(["NVDA", "NVDA", "SOFI"]);
    // Nina's +50% NVDA call is rank 0; the owner appears twice, once per call.
    expect(board[0]!.perf.call.author.id).toBe("u-nina");
    expect(board[0]!.rank).toBe(0);
    expect(board[0]!.perf.returnPct).toBeCloseTo(0.5, 4);
    expect(board[1]!.perf.call.author.id).toBe("u-zach");
    expect(board[1]!.perf.call.ticker).toBe("NVDA");
    expect(board[1]!.rank).toBe(1);
    expect(board[2]!.perf.call.author.id).toBe("u-zach");
    expect(board[2]!.perf.call.ticker).toBe("SOFI");
    expect(board[2]!.rank).toBe(2);
  });

  it("lets the same member occupy multiple top ranks when they made several strong calls", () => {
    const calls: GroupCall[] = [
      call({ author: zach, ticker: "NVDA", calledPrice: 100 }), // +25%
      call({ author: zach, ticker: "HOOD", calledPrice: 20 }), // +100%
      call({ author: nina, ticker: "AAPL", calledPrice: 200 }), // +5%
    ];
    const board = buildLeaderboard(calls, prices, NOW);
    expect(board[0]!.perf.call.ticker).toBe("HOOD");
    expect(board[0]!.perf.call.author.id).toBe("u-zach");
    expect(board[0]!.rank).toBe(0);
    expect(board[1]!.perf.call.ticker).toBe("NVDA");
    expect(board[1]!.perf.call.author.id).toBe("u-zach");
    expect(board[1]!.rank).toBe(1);
    expect(board[2]!.perf.call.ticker).toBe("AAPL");
    expect(board[2]!.rank).toBe(2);
  });

  it("excludes pending and watch calls from ranking but still returns them, unranked", () => {
    const calls: GroupCall[] = [
      call({ author: zach, ticker: "NVDA", calledPrice: 100, calledAt: MATURE_AT }), // +25% scored
      call({ author: zach, ticker: "AAPL", calledPrice: 100, calledAt: YOUNG_AT }), // pending → unranked
      call({ author: zach, ticker: "TSLA", calledPrice: 100, calledAt: MATURE_AT, direction: "watch" }), // watch → unranked
    ];
    const board = buildLeaderboard(calls, prices, NOW);
    expect(board).toHaveLength(3);
    const ranked = board.filter((r) => r.rank != null);
    const unranked = board.filter((r) => r.rank == null);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.perf.call.ticker).toBe("NVDA");
    expect(unranked.map((r) => r.perf.call.ticker).sort()).toEqual(["AAPL", "TSLA"]);
  });

  it("puts unranked (pending/watch/unpriced) calls after all ranked calls, newest first", () => {
    const calls: GroupCall[] = [
      call({ author: zach, ticker: "NVDA", calledPrice: 100 }), // scored +25%
      call({ author: nina, ticker: "AAPL", calledPrice: 100, calledAt: YOUNG_AT }), // only pending
      call({ author: omar, ticker: "TSLA", calledPrice: 100, direction: "watch" }), // only watch
    ];
    const board = buildLeaderboard(calls, prices, NOW);
    expect(board[0]!.perf.call.ticker).toBe("NVDA");
    expect(board[0]!.rank).toBe(0);
    expect(board[1]!.rank).toBeNull();
    expect(board[2]!.rank).toBeNull();
  });

  it("breaks ties deterministically by calledAt then ticker", () => {
    const calls: GroupCall[] = [
      // Both +25%, same instant → tie broken by ticker.
      call({ author: zach, ticker: "SOFI", calledPrice: 100, calledAt: MATURE_AT }),
      call({ author: nina, ticker: "NVDA", calledPrice: 100, calledAt: MATURE_AT }),
    ];
    const board = buildLeaderboard(calls, { NVDA: 125, SOFI: 125 }, NOW);
    expect(board.map((r) => r.perf.call.ticker)).toEqual(["NVDA", "SOFI"]);

    // Same return, different call time → earlier call ranks first.
    const earlier = new Date(NOW - 3 * HOUR).toISOString();
    const later = new Date(NOW - 2 * HOUR).toISOString();
    const calls2: GroupCall[] = [
      call({ author: zach, ticker: "NVDA", calledPrice: 100, calledAt: later }),
      call({ author: nina, ticker: "NVDA", calledPrice: 100, calledAt: earlier }),
    ];
    const board2 = buildLeaderboard(calls2, { NVDA: 125 }, NOW);
    expect(board2[0]!.perf.call.author.id).toBe("u-nina");
    expect(board2[1]!.perf.call.author.id).toBe("u-zach");
  });

  it("treats an unpriced ticker as unranked, not a zero return", () => {
    const calls: GroupCall[] = [call({ author: zach, ticker: "PRIVATE", calledPrice: 100 })];
    const board = buildLeaderboard(calls, prices, NOW); // no price for PRIVATE
    expect(board).toHaveLength(1);
    expect(board[0]!.rank).toBeNull();
    expect(board[0]!.perf.returnPct).toBeNull();
  });

  it("returns an empty board for no calls", () => {
    expect(buildLeaderboard([], prices, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("callTickers / rankCalls", () => {
  const zach = profile("u-zach", "Zach");

  it("dedupes and upper-cases tickers", () => {
    const calls = [
      call({ author: zach, ticker: "nvda", calledPrice: 1 }),
      call({ author: zach, ticker: "NVDA", calledPrice: 1 }),
      call({ author: zach, ticker: "aapl", calledPrice: 1 }),
    ];
    expect(callTickers(calls).sort()).toEqual(["AAPL", "NVDA"]);
  });

  it("orders the ledger newest-first", () => {
    const older = call({ author: zach, ticker: "NVDA", calledPrice: 1, calledAt: new Date(NOW - 5 * HOUR).toISOString() });
    const newer = call({ author: zach, ticker: "AAPL", calledPrice: 1, calledAt: new Date(NOW - 1 * HOUR).toISOString() });
    const ranked = rankCalls([older, newer], { NVDA: 2, AAPL: 2 }, NOW);
    expect(ranked.map((p) => p.call.ticker)).toEqual(["AAPL", "NVDA"]);
  });
});
