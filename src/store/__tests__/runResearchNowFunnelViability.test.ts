import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Funnel-viability gate - graceful degradation on the KEYLESS web build.
 *
 * Root cause (reproduced on web boot): the proxy injects a placeholder FMP key,
 * so `isFmpConfigured()` is true and the Full-Market Funnel is the resolved live
 * provider - but FMP's paid-tier `/stock-screener` endpoint isn't available on
 * the proxied/free path, so the sweep returns 0 rows and `FunnelDataProvider`
 * throws "Full-Market Funnel produced no candidates …". Fired fire-and-forget on
 * every boot, that throw spammed the console and (with an empty feed) tripped the
 * auto-retry - an error loop.
 *
 * The fix gates funnel viability BEFORE the run: when the active provider is the
 * funnel but no real local FMP key is present (keyless web), the scheduled run
 * does NOT run the live funnel. It relies on the cloud `daily_signals` cache
 * (already attempted earlier in the run); on a cache miss it degrades to a single
 * honest status - `error` with no signals, or `complete` if a published scan is
 * already held - and crucially NEVER calls `runResearch` (so the funnel can't
 * throw) and never schedules a retry.
 *
 * Tests:
 *  (a) keyless/non-viable funnel + cache miss → does NOT throw, does NOT call
 *      runResearch, settles to 'error' with no retry scheduled.
 *  (b) keyless/non-viable funnel but a published scan is already held → keeps the
 *      feed ('complete'), still never calls runResearch.
 *  (c) a VIABLE funnel (real local key) → the live funnel still runs (runResearch
 *      is called) - the capability is preserved on desktop / with a real key.
 */

// Toggle the active-provider shape per test via these module-level switches.
let providerIsFunnel = true;
let funnelViable = false;
const runResearchSpy = vi.fn();

vi.mock("@/data/providers", () => ({
  isDataSourceConfigured: () => true,
  isResearchRunAllowed: () => true,
  // The scheduled path checks the shared cache only when live data is active.
  isLiveDataActive: () => true,
  isProviderResolutionPending: () => false,
  isSampleDataModeEnabled: () => false,
  resolveProviderId: () => (providerIsFunnel ? "funnel" : "finnhub"),
  isLiveFunnelViable: () => funnelViable,
  // A live provider so a run that DOES proceed reaches runResearch.
  getActiveProvider: () => ({ isLive: true, name: "Full-Market Funnel", id: "funnel" }),
}));

// runResearch must never be reached in the non-viable cases. In the viable case
// we resolve a minimal result so the run completes without real network.
vi.mock("@/engine/research", () => ({
  runResearch: (...args: unknown[]) => {
    runResearchSpy(...args);
    return Promise.resolve({
      run: {
        id: "run_test",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        provider: "Full-Market Funnel",
        universeSize: 1,
        signalsGenerated: 1,
        trigger: "scheduled",
        status: "complete",
        stages: [],
      },
      signals: [],
    });
  },
}));

// Cache configured but a MISS (today's row hasn't landed) - the exact window in
// which the funnel would otherwise run and throw on web.
const fetchRecentSharedSignals = vi.fn(async () => null);
vi.mock("@/data/dailySignalsCache", () => ({
  isDailySignalsCacheConfigured: () => true,
  fetchRecentSharedSignals,
  // The IndexedDB fast path (perf-diagnosis Finding #1, both the exact-key and
  // fallback-day tiers) reads these before the network fetch; fixed values are
  // fine here since these tests exercise the cache-MISS network path
  // (readCachedBoard / readMostRecentCachedBoard are unmocked and resolve null
  // in the Node test environment - no real IndexedDB - exactly like a real miss).
  marketDayKey: () => "2026-01-01",
  isSharedSignalsFresh: () => false,
  uploadTodaySharedSignals: vi.fn(async () => undefined),
  SHARED_BOARD_MAX_AGE_DAYS: 5,
}));

// The store touches `window` at import time (DEV debug hook) and in the catch
// retry timer. Spy setTimeout so we can assert NO retry is scheduled.
const setTimeoutSpy = vi.fn(
  ((fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)) as typeof window.setTimeout,
);
// Minimal in-memory localStorage so the store's persist middleware (which runs
// when the viable run completes) writes quietly instead of logging a warning.
const memStore = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

const originalWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  setTimeout: setTimeoutSpy,
  clearTimeout: ((id: number) => globalThis.clearTimeout(id)) as typeof window.clearTimeout,
  addEventListener: () => undefined,
  location: { reload: () => undefined },
  localStorage: localStorageStub,
} as unknown as Window & typeof globalThis;

const { useAppStore } = await import("@/store/useAppStore");

beforeEach(() => {
  providerIsFunnel = true;
  funnelViable = false;
  runResearchSpy.mockClear();
  setTimeoutSpy.mockClear();
  fetchRecentSharedSignals.mockClear();
  useAppStore.setState({ researchStatus: "idle", signals: [] });
});

afterEach(() => {
  vi.clearAllTimers();
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("runResearchNow — boot never client-scans; funnel is manual-only", () => {
  it("(a) SCHEDULED + cache miss: does NOT scan, settles to 'idle' (awaiting published scan), no retry", async () => {
    funnelViable = false;
    await expect(useAppStore.getState().runResearchNow("scheduled")).resolves.toBeUndefined();

    // The shared cache was consulted first (the real scan path).
    expect(fetchRecentSharedSignals).toHaveBeenCalled();
    // Boot NEVER runs a client-side scan - so the funnel can't run (or throw).
    expect(runResearchSpy).not.toHaveBeenCalled();
    // No cache to show yet → honest 'idle' (awaiting the published board), not a scan.
    expect(useAppStore.getState().researchStatus).toBe("idle");
    // No auto-retry timer scheduled → no error loop / interval spam.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("(b) SCHEDULED but a published scan is already held: keeps the feed ('complete'), never scans", async () => {
    funnelViable = false;
    useAppStore.setState({
      researchStatus: "complete",
      // A minimal already-held signal (e.g. adopted from the cache earlier).
      signals: [{ ticker: "AAA" } as never],
    });
    await expect(useAppStore.getState().runResearchNow("scheduled")).resolves.toBeUndefined();

    expect(runResearchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().researchStatus).toBe("complete");
    expect(useAppStore.getState().signals).toHaveLength(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("(a2) SCHEDULED boot passes through 'loading' but NEVER 'running' — no 'Scanning…' flash", async () => {
    // The recurring complaint: opening the app flashes "Scanning…" / "Running
    // this morning's research…" even though it's only reading the published
    // board. Reading the cache must use the quiet 'loading' status; the loud
    // 'running' status is reserved for a real client scan (manual press / desktop
    // funnel). Capture every researchStatus transition during a scheduled boot
    // run and assert 'running' never appears while 'loading' does.
    funnelViable = false;
    const seen: string[] = [];
    const unsub = useAppStore.subscribe((s) => seen.push(s.researchStatus));
    await useAppStore.getState().runResearchNow("scheduled");
    unsub();

    expect(seen).toContain("loading");
    expect(seen).not.toContain("running");
    expect(runResearchSpy).not.toHaveBeenCalled();
  });

  it("(c) SCHEDULED + VIABLE funnel still does NOT scan on boot — boot is cache-only", async () => {
    // The whole point: opening the app must never kick off a market scan, even
    // when the funnel COULD run. The GitHub Action is the scanner.
    funnelViable = true;
    await expect(useAppStore.getState().runResearchNow("scheduled")).resolves.toBeUndefined();
    expect(runResearchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().researchStatus).toBe("idle");
  });

  it("(d) MANUAL 'Scan Market' + VIABLE funnel: runs the live funnel — capability preserved", async () => {
    funnelViable = true;
    await expect(useAppStore.getState().runResearchNow("manual")).resolves.toBeUndefined();

    // A deliberate manual press is the ONLY thing that runs a fresh local scan.
    expect(runResearchSpy).toHaveBeenCalledTimes(1);
  });
});
