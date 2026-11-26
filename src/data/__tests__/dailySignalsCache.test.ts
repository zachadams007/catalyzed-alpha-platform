import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchRun, StockSignal } from "@/types";

/**
 * Tests for the shared daily-compute read/write seam. The Supabase client is
 * mocked so these are pure unit tests - no network, no real env. The fake client
 * mirrors the tiny slice of the supabase-js builder the seam actually uses:
 *   .from(t).select(c).eq(k,v).maybeSingle()   and   .from(t).insert(row)
 */

// Hoisted so the (hoisted) vi.mock factory can reference it without a TDZ error.
const h = vi.hoisted(() => {
  const state = {
    single: { data: null as unknown, error: null as { code?: string } | null },
    insert: { error: null as { code?: string } | null },
    insertPayload: null as Record<string, unknown> | null,
    throwOn: "none" as "none" | "select" | "insert",
  };
  const fakeClient = {
    from() {
      return this;
    },
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle() {
      if (state.throwOn === "select") return Promise.reject(new Error("boom"));
      return Promise.resolve(state.single);
    },
    insert(payload: Record<string, unknown>) {
      state.insertPayload = payload;
      if (state.throwOn === "insert") return Promise.reject(new Error("boom"));
      return Promise.resolve(state.insert);
    },
  };
  return { state, fakeClient };
});

const state = h.state;

vi.mock("@/data/supabase/client", () => ({ supabase: h.fakeClient }));

import {
  fetchTodaySharedSignals,
  isDailySignalsCacheConfigured,
  isSharedSignalsFresh,
  marketDayKey,
  uploadTodaySharedSignals,
  type SharedDailySignals,
} from "@/data/dailySignalsCache";

function signal(ticker: string): StockSignal {
  // Only the fields the seam reads/validates matter here; cast the rest.
  return { ticker, score: { opportunityScore: 70 } } as unknown as StockSignal;
}

const RUN: ResearchRun = {
  id: "run_1",
  startedAt: "2026-06-16T13:00:00.000Z",
  finishedAt: "2026-06-16T13:02:00.000Z",
  provider: "Finnhub Live Universe",
  universeSize: 98,
  signalsGenerated: 42,
  trigger: "scheduled",
  status: "complete",
  stages: [],
};

beforeEach(() => {
  state.single = { data: null, error: null };
  state.insert = { error: null };
  state.insertPayload = null;
  state.throwOn = "none";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("marketDayKey", () => {
  it("uses the US/Eastern calendar date, not UTC", () => {
    // 03:00 UTC on the 16th is 23:00 EDT on the 15th → the market day is the 15th.
    expect(marketDayKey(new Date("2026-06-16T03:00:00Z"))).toBe("2026-06-15");
    // Midday UTC is the same calendar day in Eastern.
    expect(marketDayKey(new Date("2026-06-16T12:00:00Z"))).toBe("2026-06-16");
  });
});

describe("isDailySignalsCacheConfigured", () => {
  it("is true when the Supabase client exists", () => {
    expect(isDailySignalsCacheConfigured()).toBe(true);
  });
});

describe("fetchTodaySharedSignals", () => {
  it("returns the published signals + run when a row exists", async () => {
    state.single = {
      data: {
        market_day: "2026-06-16",
        signals: [signal("NVDA"), signal("AMD")],
        run: RUN,
        computed_at: "2026-06-16T13:02:00.000Z",
        meta: { provider: "Finnhub Live Universe" },
      },
      error: null,
    };
    const out = await fetchTodaySharedSignals(new Date("2026-06-16T16:00:00Z"));
    expect(out).not.toBeNull();
    expect(out!.signals.map((s) => s.ticker)).toEqual(["NVDA", "AMD"]);
    expect(out!.run.id).toBe("run_1");
    expect(out!.computedAt).toBe("2026-06-16T13:02:00.000Z");
    expect(out!.marketDay).toBe("2026-06-16");
  });

  it("synthesizes a valid run when the row didn't store one", async () => {
    state.single = {
      data: {
        market_day: "2026-06-16",
        signals: [signal("NVDA")],
        run: null,
        computed_at: "2026-06-16T13:02:00.000Z",
        meta: { provider: "Finnhub Live Universe" },
      },
      error: null,
    };
    const out = await fetchTodaySharedSignals(new Date("2026-06-16T16:00:00Z"));
    expect(out).not.toBeNull();
    expect(out!.run.finishedAt).toBe("2026-06-16T13:02:00.000Z");
    expect(out!.run.provider).toBe("Finnhub Live Universe");
    expect(out!.run.signalsGenerated).toBe(1);
  });

  it("returns null when there is no row for today", async () => {
    state.single = { data: null, error: null };
    expect(await fetchTodaySharedSignals()).toBeNull();
  });

  it("rejects a stale prior-day row even if the query returns it", async () => {
    // Defense-in-depth: a row whose stored market_day disagrees with today must
    // be treated as a miss, never served as today's signals under a Live badge.
    state.single = {
      data: {
        market_day: "2026-06-15", // yesterday
        signals: [signal("NVDA"), signal("AMD")],
        run: RUN,
        computed_at: "2026-06-15T13:02:00.000Z",
        meta: { provider: "Finnhub Live Universe" },
      },
      error: null,
    };
    expect(await fetchTodaySharedSignals(new Date("2026-06-16T16:00:00Z"))).toBeNull();
  });

  it("returns null when the row carries an empty signals array", async () => {
    state.single = { data: { signals: [] }, error: null };
    expect(await fetchTodaySharedSignals()).toBeNull();
  });

  it("returns null on a query error and never throws", async () => {
    state.single = { data: null, error: { code: "PGRST" } };
    expect(await fetchTodaySharedSignals()).toBeNull();
    state.throwOn = "select";
    expect(await fetchTodaySharedSignals()).toBeNull();
  });
});

describe("isSharedSignalsFresh", () => {
  function shared(marketDay: string): SharedDailySignals {
    return {
      signals: [signal("NVDA")],
      run: RUN,
      computedAt: `${marketDay}T13:02:00.000Z`,
      marketDay,
    };
  }

  it("is true only when the result is for the current market day", () => {
    const now = new Date("2026-06-16T16:00:00Z"); // market day = 2026-06-16
    expect(isSharedSignalsFresh(shared("2026-06-16"), now)).toBe(true);
  });

  it("is false for a prior market day (stale)", () => {
    const now = new Date("2026-06-16T16:00:00Z");
    expect(isSharedSignalsFresh(shared("2026-06-15"), now)).toBe(false);
  });

  it("is false for a null result", () => {
    expect(isSharedSignalsFresh(null, new Date("2026-06-16T16:00:00Z"))).toBe(false);
  });
});

describe("uploadTodaySharedSignals (server-only no-op)", () => {
  // SECURITY (migration 0013): publishing the shared feed is a trusted,
  // service-role-only write. The client must NEVER insert into daily_signals,
  // because the shipped anon key would let any holder pre-poison the day's row.
  // So this client-side function is a deliberate no-op: it returns false and
  // performs zero network writes regardless of inputs.
  it("never writes from the client, even for a valid universe", async () => {
    const ok = await uploadTodaySharedSignals(
      [signal("NVDA"), signal("AMD")],
      RUN,
      new Date("2026-06-16T16:00:00Z"),
    );
    expect(ok).toBe(false);
    // The poison surface is gone: no insert is ever attempted.
    expect(state.insertPayload).toBeNull();
  });

  it("returns false for an empty universe and never writes", async () => {
    expect(await uploadTodaySharedSignals([], RUN)).toBe(false);
    expect(state.insertPayload).toBeNull();
  });

  it("does not touch the network even if the client would throw", async () => {
    // Arm the fake insert to reject; the no-op must not call it at all.
    state.throwOn = "insert";
    expect(await uploadTodaySharedSignals([signal("NVDA")], RUN)).toBe(false);
    expect(state.insertPayload).toBeNull();
  });
});
