import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C-2 - overall scan watchdog.
 *
 * The Wave-2 auto-retry only fires from the catch, so a run that HANGS (a step
 * that never resolves AND never rejects) left the Today feed stuck on a skeleton
 * forever: researchStatus stayed "loading", no error console, no Retry. The fix
 * races the awaited `runResearch` against a hard SCAN_BUDGET_MS ceiling so any
 * unforeseen stall settles into the existing catch → researchStatus "error".
 *
 * This test mocks `runResearch` to NEVER settle and asserts the watchdog trips
 * within the budget, flipping researchStatus to "error" and releasing in-flight
 * sockets via abortLiveDataRequests().
 */

vi.mock("@/data/providers", () => ({
  isDataSourceConfigured: () => true,
  isResearchRunAllowed: () => true,
  isLiveDataActive: () => false,
  isProviderResolutionPending: () => false,
  isSampleDataModeEnabled: () => false,
  // A resolvable, non-live provider so the run reaches the awaited runResearch.
  getActiveProvider: () => ({ isLive: false, label: "test", kind: "mock" }),
}));

// runResearch never settles → only the watchdog can end the run.
vi.mock("@/engine/research", () => ({
  runResearch: () => new Promise(() => {}),
}));

vi.mock("@/data/dailySignalsCache", () => ({
  isDailySignalsCacheConfigured: () => false,
  fetchTodaySharedSignals: vi.fn(async () => null),
  uploadTodaySharedSignals: vi.fn(async () => undefined),
  // isDailySignalsCacheConfigured() is false here, so the shared-cache branch
  // in runResearchNow (which reads this) never executes - included anyway so
  // this mock stays a safe, complete stand-in for the real module.
  SHARED_BOARD_MAX_AGE_DAYS: 5,
}));

// Spy the socket-release call so we can assert the watchdog trip aborts in-flight
// requests. Re-export everything else from the real http module.
const abortLiveDataRequests = vi.fn();
vi.mock("@/data/http", async () => {
  const actual = await vi.importActual<typeof import("@/data/http")>("@/data/http");
  return { ...actual, abortLiveDataRequests };
});

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
  abortLiveDataRequests.mockClear();
  useAppStore.setState({ researchStatus: "idle", signals: [] });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("runResearchNow — scan watchdog on a hung run (C-2)", () => {
  it("flips researchStatus to 'error' within the scan budget and aborts in-flight sockets", async () => {
    const run = useAppStore.getState().runResearchNow("scheduled");
    // Advance past the 180s scan budget; the watchdog rejects the race.
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(run).resolves.toBeUndefined();
    expect(useAppStore.getState().researchStatus).toBe("error");
    expect(abortLiveDataRequests).toHaveBeenCalled();
  });
});
