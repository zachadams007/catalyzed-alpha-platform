import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression: zustand's persist middleware writes the whole partialized store to
 * localStorage on every set(). Once the payload exceeded the ~5MB quota, the raw
 * `setItem` threw QuotaExceededError synchronously inside a React commit/effect,
 * unmounting the entire tree → blank screen + forced reload.
 *
 * safeJSONStorage must NEVER throw: on quota it sheds recomputable slices and
 * retries; if all else fails it drops the write silently.
 *
 * Runs in the node env (no jsdom dependency) by installing a minimal fake
 * `window.localStorage` whose setItem behavior the test controls.
 */

type SetImpl = (key: string, value: string) => void;

let backing: Record<string, string>;
let setImpl: SetImpl;
let setItemCalls: number;

function quotaError(): Error {
  const e = new Error("exceeded the quota");
  e.name = "QuotaExceededError";
  return e;
}

beforeEach(() => {
  backing = {};
  setItemCalls = 0;
  setImpl = (k, v) => {
    backing[k] = v;
  };
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k in backing ? backing[k] : null),
      setItem: (k: string, v: string) => {
        setItemCalls += 1;
        setImpl(k, v);
      },
      removeItem: (k: string) => {
        delete backing[k];
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// Import lazily AFTER window is faked so createJSONStorage binds to our stub.
async function load() {
  const mod = await import("@/store/safeStorage");
  return mod.safeJSONStorage!;
}

describe("safeJSONStorage — quota-safe persist storage", () => {
  it("never throws when setItem always hits the quota", async () => {
    setImpl = () => {
      throw quotaError();
    };
    const storage = await load();
    expect(() =>
      storage.setItem("catalyzed-alpha", {
        state: { signals: [{ ticker: "AAPL" }], watchlist: ["AAPL"] },
        version: 22,
      } as never),
    ).not.toThrow();
    expect(setItemCalls).toBeGreaterThan(0);
  });

  it("sheds a recomputable slice and succeeds when the trimmed payload fits", async () => {
    setImpl = (k, v) => {
      // First (full) write fails; trimmed retry succeeds.
      if (setItemCalls === 1) throw quotaError();
      backing[k] = v;
    };
    const storage = await load();
    storage.setItem("catalyzed-alpha", {
      state: { signals: [{ ticker: "AAPL" }], watchlist: ["AAPL"] },
      version: 22,
    } as never);

    expect(setItemCalls).toBeGreaterThanOrEqual(2);
    const written = JSON.parse(backing["catalyzed-alpha"]);
    // signals shed to [], but user-owned watchlist preserved.
    expect(written.state.signals).toEqual([]);
    expect(written.state.watchlist).toEqual(["AAPL"]);
  });

  it("round-trips a normal value when there is no quota pressure", async () => {
    const storage = await load();
    storage.setItem("k", { state: { watchlist: ["NVDA"] }, version: 1 } as never);
    const got = storage.getItem("k") as { state: { watchlist: string[] } } | null;
    expect(got?.state.watchlist).toEqual(["NVDA"]);
  });
});
