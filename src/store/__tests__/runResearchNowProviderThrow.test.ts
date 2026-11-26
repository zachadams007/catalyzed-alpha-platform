import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression (D-2): `runResearchNow` is fired fire-and-forget as
 * `void get().runResearchNow("scheduled")` (auto research, the controls
 * subscription, the retry timer). `getActiveProvider()` throws
 * ("No data source configured") when no provider resolves. It used to be called
 * ABOVE the try block, so that throw escaped `runResearchNow` as an UNHANDLED
 * PROMISE REJECTION - the run never set `researchStatus:"error"`, the feed never
 * surfaced a recoverable error console, and a real provider outage vanished
 * silently. The fix moves `getActiveProvider()` INSIDE the try so the throw
 * routes through the catch (sets `researchStatus:"error"`).
 *
 * Runs in the node env: we mock the provider module so the run's gates pass but
 * provider resolution throws, and install a minimal fake `window` for the
 * catch-path retry timer.
 */

// All gates BEFORE getActiveProvider() must pass so we reach the throw; only
// getActiveProvider itself fails - exactly the production failure mode.
vi.mock("@/data/providers", () => ({
  isDataSourceConfigured: () => true,
  isResearchRunAllowed: () => true,
  // Stay off the live/shared-signals fetch path (no network in the test).
  isLiveDataActive: () => false,
  // Provider choice is NOT pending - we must fall through to getActiveProvider().
  isProviderResolutionPending: () => false,
  isSampleDataModeEnabled: () => false,
  getActiveProvider: () => {
    throw new Error("No data source configured.");
  },
}));

// The scheduled path never reaches the shared-cache fetch (isLiveDataActive is
// false), but the module is imported eagerly - keep it inert.
vi.mock("@/data/dailySignalsCache", () => ({
  isDailySignalsCacheConfigured: () => false,
  fetchTodaySharedSignals: vi.fn(async () => null),
  uploadTodaySharedSignals: vi.fn(async () => undefined),
  // isDailySignalsCacheConfigured() is false here, so the shared-cache branch
  // in runResearchNow (which reads this) never executes - included anyway so
  // this mock stays a safe, complete stand-in for the real module.
  SHARED_BOARD_MAX_AGE_DAYS: 5,
}));

// The store module touches `window` at import time (a DEV-only debug hook) and in
// the catch-path retry timer (window.setTimeout). Node has no window - install a
// minimal stand-in BEFORE importing the store so module evaluation succeeds.
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
  vi.useFakeTimers();
  useAppStore.setState({ researchStatus: "idle", signals: [] });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("runResearchNow — provider-resolution throw routes through the catch", () => {
  it("does NOT reject (no unhandled rejection) when getActiveProvider throws", async () => {
    await expect(useAppStore.getState().runResearchNow("scheduled")).resolves.toBeUndefined();
  });

  it("sets researchStatus to 'error' so the feed can show a recoverable console", async () => {
    await useAppStore.getState().runResearchNow("scheduled");
    expect(useAppStore.getState().researchStatus).toBe("error");
  });
});
