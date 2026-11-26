import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression (W4-B): `lookupTicker` only wrapped `resolveSymbolFromQuery` in a
 * try/catch (that path toasts + rethrows). The network-bound
 * `await lookupSignalAsync(key)` ran OUTSIDE any try, so a Finnhub/Yahoo failure
 * rejected with a non-SymbolResolveError and pushed NO toast - every caller
 * (TopBar search, Beacon, deep links) got a silent dead box.
 *
 * The fix wraps `lookupSignalAsync` in try/catch: on failure it pushes a "warn"
 * toast before rethrowing, so callers get honest feedback. This test forces
 * `lookupSignalAsync` to reject and asserts a toast fires and the call rejects.
 *
 * Runs in the node env: we mock symbol resolution so it succeeds (we reach the
 * network call), mock the engine so the network call rejects, and install a
 * minimal fake `window` so the store module evaluates.
 */

// Symbol resolution succeeds so we reach the network-bound lookupSignalAsync.
vi.mock("@/data/finnhub/symbolSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/data/finnhub/symbolSearch")>();
  return { ...actual, resolveSymbolFromQuery: vi.fn(async (q: string) => q.toUpperCase()) };
});

// The network-bound data load rejects - exactly the production failure mode
// (provider unreachable / quote fetch rejected).
vi.mock("@/engine/lookupSignal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine/lookupSignal")>();
  return {
    ...actual,
    lookupSignalAsync: vi.fn(async () => {
      throw new Error("network down");
    }),
  };
});

// Keep the daily-cache module inert (imported eagerly by the store).
vi.mock("@/data/dailySignalsCache", () => ({
  isDailySignalsCacheConfigured: () => false,
  fetchTodaySharedSignals: vi.fn(async () => null),
  uploadTodaySharedSignals: vi.fn(async () => undefined),
  // isDailySignalsCacheConfigured() is false here, so the shared-cache branch
  // in runResearchNow (which reads this) never executes - included anyway so
  // this mock stays a safe, complete stand-in for the real module.
  SHARED_BOARD_MAX_AGE_DAYS: 5,
}));

// The store touches `window` at import time and in timers - install a stand-in.
const originalWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  setTimeout: ((fn: () => void, ms?: number) =>
    globalThis.setTimeout(fn, ms)) as typeof window.setTimeout,
  clearTimeout: ((id: number) => globalThis.clearTimeout(id)) as typeof window.clearTimeout,
  addEventListener: () => undefined,
  location: { reload: () => undefined },
} as unknown as Window & typeof globalThis;

const { useAppStore } = await import("@/store/useAppStore");

beforeEach(() => {
  useAppStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("lookupTicker — network-bound failure surfaces a toast (no silent dead box)", () => {
  it("pushes a warn toast when lookupSignalAsync rejects", async () => {
    await expect(useAppStore.getState().lookupTicker("AAPL")).rejects.toThrow("network down");

    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].tone).toBe("warn");
    expect(toasts[0].message).toMatch(/load data for that ticker/i);
  });

  it("rethrows so callers can render their own error state", async () => {
    await expect(useAppStore.getState().lookupTicker("MSFT")).rejects.toBeInstanceOf(Error);
  });
});
