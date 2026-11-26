import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANUAL_REFRESH_LIMIT,
  canManualRefresh,
  getManualRefreshStatus,
  recordManualRefresh,
  resetManualRefreshCount,
  subscribeRefreshLimiter,
} from "@/lib/refreshLimiter";

// ---------------------------------------------------------------------------
// In-memory localStorage (vitest runs in the `node` env - no DOM storage).
// ---------------------------------------------------------------------------
function installMemoryStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return backing;
}

// A fixed local clock so day-keys are deterministic.
const DAY1 = new Date(2026, 5, 14, 10, 0, 0); // 2026-06-14 10:00 local
const DAY1_LATER = new Date(2026, 5, 14, 23, 30, 0); // same day, later
const DAY2 = new Date(2026, 5, 15, 0, 30, 0); // 2026-06-15 00:30 local

let backing: Map<string, string>;

beforeEach(() => {
  backing = installMemoryStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshLimiter — fresh state", () => {
  it("starts with the full allowance and is not blocked", () => {
    const status = getManualRefreshStatus({ now: DAY1 });
    expect(status.used).toBe(0);
    expect(status.limit).toBe(MANUAL_REFRESH_LIMIT);
    expect(status.remaining).toBe(MANUAL_REFRESH_LIMIT);
    expect(status.blocked).toBe(false);
    expect(status.unlimited).toBe(false);
    expect(canManualRefresh({ now: DAY1 })).toBe(true);
  });

  it("reports the next local midnight as the reset time", () => {
    const status = getManualRefreshStatus({ now: DAY1 });
    const reset = new Date(status.resetsAtIso);
    expect(reset.getTime()).toBeGreaterThan(DAY1.getTime());
    // Next midnight after 2026-06-14 is 2026-06-15 00:00 local.
    expect(reset.getFullYear()).toBe(2026);
    expect(reset.getMonth()).toBe(5);
    expect(reset.getDate()).toBe(15);
    expect(reset.getHours()).toBe(0);
  });
});

describe("refreshLimiter — counting", () => {
  it("decrements remaining on each manual run and blocks at the limit", () => {
    expect(recordManualRefresh({ now: DAY1 }).remaining).toBe(2);
    expect(recordManualRefresh({ now: DAY1 }).remaining).toBe(1);
    const third = recordManualRefresh({ now: DAY1 });
    expect(third.remaining).toBe(0);
    expect(third.used).toBe(3);
    expect(third.blocked).toBe(true);
    expect(canManualRefresh({ now: DAY1 })).toBe(false);
  });

  it("never lets remaining go negative or used exceed the limit", () => {
    let last = recordManualRefresh({ now: DAY1 });
    for (let i = 0; i < 5; i++) last = recordManualRefresh({ now: DAY1 });
    // The value RETURNED by an over-limit record() is clamped too - callers that
    // render the returned status (e.g. "X left") must never see a negative.
    expect(last.used).toBe(MANUAL_REFRESH_LIMIT);
    expect(last.remaining).toBe(0);
    expect(last.blocked).toBe(true);
    const status = getManualRefreshStatus({ now: DAY1 });
    expect(status.remaining).toBe(0);
    expect(status.used).toBe(MANUAL_REFRESH_LIMIT);
    expect(status.blocked).toBe(true);
  });

  it("persists the count across reads (same device, same day)", () => {
    recordManualRefresh({ now: DAY1 });
    recordManualRefresh({ now: DAY1 });
    // A later read on the same day sees the accumulated count.
    expect(getManualRefreshStatus({ now: DAY1_LATER }).used).toBe(2);
  });
});

describe("refreshLimiter — day rollover", () => {
  it("resets the count after local midnight", () => {
    recordManualRefresh({ now: DAY1 });
    recordManualRefresh({ now: DAY1 });
    recordManualRefresh({ now: DAY1 });
    expect(getManualRefreshStatus({ now: DAY1 }).blocked).toBe(true);
    // New calendar day → counter resets, runs available again.
    const next = getManualRefreshStatus({ now: DAY2 });
    expect(next.used).toBe(0);
    expect(next.blocked).toBe(false);
    expect(canManualRefresh({ now: DAY2 })).toBe(true);
  });
});

describe("refreshLimiter — admin bypass", () => {
  it("reports unlimited and never blocks for an operator", () => {
    const status = getManualRefreshStatus({ isAdmin: true, now: DAY1 });
    expect(status.unlimited).toBe(true);
    expect(status.blocked).toBe(false);
    expect(status.limit).toBe(Infinity);
    expect(status.remaining).toBe(Infinity);
    expect(canManualRefresh({ isAdmin: true, now: DAY1 })).toBe(true);
  });

  it("does not accrue a count when an admin runs research", () => {
    recordManualRefresh({ isAdmin: true, now: DAY1 });
    recordManualRefresh({ isAdmin: true, now: DAY1 });
    // The device's raw (non-admin) count is untouched - an operator on a shared
    // device never burns a friend's quota.
    expect(getManualRefreshStatus({ now: DAY1 }).used).toBe(0);
  });

  it("still bypasses even when the device count is already maxed", () => {
    recordManualRefresh({ now: DAY1 });
    recordManualRefresh({ now: DAY1 });
    recordManualRefresh({ now: DAY1 });
    expect(getManualRefreshStatus({ now: DAY1 }).blocked).toBe(true);
    expect(getManualRefreshStatus({ isAdmin: true, now: DAY1 }).blocked).toBe(false);
  });
});

describe("refreshLimiter — reset + resilience", () => {
  it("resetManualRefreshCount clears today's count", () => {
    recordManualRefresh({ now: DAY1 });
    recordManualRefresh({ now: DAY1 });
    expect(getManualRefreshStatus({ now: DAY1 }).used).toBe(2);
    resetManualRefreshCount({ now: DAY1 });
    expect(getManualRefreshStatus({ now: DAY1 }).used).toBe(0);
    expect(canManualRefresh({ now: DAY1 })).toBe(true);
  });

  it("treats a corrupt stored blob as a fresh day", () => {
    backing.set("catalyzed-alpha:refresh-count:v1", "{ not valid json");
    const status = getManualRefreshStatus({ now: DAY1 });
    expect(status.used).toBe(0);
    expect(status.blocked).toBe(false);
  });

  it("ignores a count stored under a different day", () => {
    backing.set(
      "catalyzed-alpha:refresh-count:v1",
      JSON.stringify({ date: "2020-01-01", count: 99 }),
    );
    expect(getManualRefreshStatus({ now: DAY1 }).used).toBe(0);
  });
});

describe("refreshLimiter — subscriptions", () => {
  it("notifies subscribers on record and reset", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRefreshLimiter(listener);
    recordManualRefresh({ now: DAY1 });
    expect(listener).toHaveBeenCalledTimes(1);
    resetManualRefreshCount({ now: DAY1 });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    recordManualRefresh({ now: DAY1 });
    expect(listener).toHaveBeenCalledTimes(2); // no longer notified
  });

  it("does not notify on an admin no-op record", () => {
    const listener = vi.fn();
    subscribeRefreshLimiter(listener);
    recordManualRefresh({ isAdmin: true, now: DAY1 });
    expect(listener).not.toHaveBeenCalled();
  });
  it("clamps a structurally-valid but out-of-range same-day count", () => {
    const key = "2026-06-14"; // matches dayKeyOf(DAY1)
    backing.set("catalyzed-alpha:refresh-count:v1", JSON.stringify({ date: key, count: -5 }));
    let s = getManualRefreshStatus({ now: DAY1 });
    expect(s.used).toBe(0);
    expect(s.remaining).toBe(MANUAL_REFRESH_LIMIT);
    expect(s.blocked).toBe(false);

    backing.set("catalyzed-alpha:refresh-count:v1", JSON.stringify({ date: key, count: 999 }));
    s = getManualRefreshStatus({ now: DAY1 });
    expect(s.used).toBe(MANUAL_REFRESH_LIMIT);
    expect(s.remaining).toBe(0);
    expect(s.blocked).toBe(true);

    backing.set("catalyzed-alpha:refresh-count:v1", JSON.stringify({ date: key, count: 2.7 }));
    expect(getManualRefreshStatus({ now: DAY1 }).used).toBe(2); // floored
  });

  it("treats a non-numeric same-day count as a fresh day", () => {
    backing.set(
      "catalyzed-alpha:refresh-count:v1",
      JSON.stringify({ date: "2026-06-14", count: "3" }),
    );
    expect(getManualRefreshStatus({ now: DAY1 }).used).toBe(0);
  });
});
