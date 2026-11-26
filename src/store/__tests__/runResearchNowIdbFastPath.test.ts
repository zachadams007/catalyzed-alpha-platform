import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cold-load IndexedDB fast path (perf-diagnosis Finding #1 / TOP-1).
 *
 * Goal: the 2nd+ open on the SAME market day paints the board from the local
 * IndexedDB cache with NO visible skeleton - `researchStatus` must never pass
 * through "loading" and the network (`fetchRecentSharedSignals`) must never be
 * called. A miss (or ANY cache failure) must fall through to the existing
 * network path completely unchanged, and a successful network fetch must be
 * written back into the cache (write-through) for the next open.
 *
 * `@/data/dailySignalsCache` and `@/data/dailySignalsIdbCache` are mocked so
 * this is a pure unit test of the orchestration in `runResearchNow` - no
 * network, no real IndexedDB. The signal fixtures are REAL (`MOCK_UNIVERSE` +
 * the real `scoreCompany`/`toStockSignal`), so they survive the REAL
 * `applyResearchResult` → overlay → `rerankSignalsForVariant` →
 * `postProcessUniverse` → `normalizeUniverse` pipeline unmocked, the same way
 * `applyDisplayControlsChange.test.ts` does.
 */

let liveDataActive = true;

vi.mock("@/data/providers", () => ({
  isDataSourceConfigured: () => true,
  isResearchRunAllowed: () => true,
  // The scheduled path only tries the shared cache (IDB or network) when live.
  isLiveDataActive: () => liveDataActive,
  isProviderResolutionPending: () => false,
  isSampleDataModeEnabled: () => false,
  resolveProviderId: () => "finnhub",
  isLiveFunnelViable: () => true,
  getActiveProvider: () => ({ isLive: true, name: "Finnhub Live Universe", id: "finnhub" }),
}));

const fetchRecentSharedSignals = vi.fn(async (): Promise<unknown> => null);
const marketDayKeyMock = vi.fn(() => "2026-09-16");
vi.mock("@/data/dailySignalsCache", () => ({
  isDailySignalsCacheConfigured: () => true,
  fetchRecentSharedSignals: (...args: unknown[]) =>
    (fetchRecentSharedSignals as (...a: unknown[]) => Promise<unknown>)(...args),
  marketDayKey: (...args: unknown[]) => (marketDayKeyMock as (...a: unknown[]) => string)(...args),
  isSharedSignalsFresh: () => false,
  uploadTodaySharedSignals: vi.fn(async () => false),
  // Real value (not a mock) - the store passes this straight through to
  // readMostRecentCachedBoard, and the "fallback-day" tests below assert on
  // the exact value it's called with.
  SHARED_BOARD_MAX_AGE_DAYS: 5,
}));

const readCachedBoard = vi.fn(async (_marketDay?: string): Promise<unknown> => null);
const readMostRecentCachedBoard = vi.fn(
  async (_todayKey?: string, _maxAgeDays?: number): Promise<unknown> => null,
);
const writeCachedBoard = vi.fn(async (): Promise<void> => undefined);
vi.mock("@/data/dailySignalsIdbCache", () => ({
  readCachedBoard: (...args: unknown[]) =>
    (readCachedBoard as (...a: unknown[]) => Promise<unknown>)(...args),
  readMostRecentCachedBoard: (...args: unknown[]) =>
    (readMostRecentCachedBoard as (...a: unknown[]) => Promise<unknown>)(...args),
  writeCachedBoard: (...args: unknown[]) =>
    (writeCachedBoard as (...a: unknown[]) => Promise<void>)(...args),
}));

// A real client-side scan must NEVER run on the scheduled boot path (that's
// the pre-existing, unrelated "boot never client-scans" contract) - spy on it
// so every test here can assert it stays untouched.
const runResearchSpy = vi.fn();
vi.mock("@/engine/research", () => ({
  runResearch: (...args: unknown[]) => {
    runResearchSpy(...args);
    return Promise.resolve({
      run: {
        id: "run_local_scan",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        provider: "Finnhub Live Universe",
        universeSize: 0,
        signalsGenerated: 0,
        trigger: "scheduled",
        status: "complete",
        stages: [],
      },
      signals: [],
    });
  },
}));

// The store touches `window` at import time (DEV debug hook) and the persist
// middleware reads localStorage - Node has neither by default.
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
  setTimeout: ((fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)) as typeof window.setTimeout,
  clearTimeout: ((id: number) => globalThis.clearTimeout(id)) as typeof window.clearTimeout,
  addEventListener: () => undefined,
  location: { reload: () => undefined },
  localStorage: localStorageStub,
} as unknown as Window & typeof globalThis;

const { useAppStore } = await import("@/store/useAppStore");
const { MOCK_UNIVERSE } = await import("@/data/mockSignals");
const { toStockSignal } = await import("@/engine/enrich");
const { scoreCompany } = await import("@/engine/scoring");

const GENERATED_AT = "2026-09-16T12:55:00.000Z";
function buildScored() {
  // A couple of real, fully-shaped signals - enough to prove the rerank
  // pipeline runs end to end without special-casing an empty array.
  return MOCK_UNIVERSE.slice(0, 2).map((c) => toStockSignal(c, scoreCompany(c), GENERATED_AT));
}

const CACHED_RUN = {
  id: "run_cached_2026-09-16",
  startedAt: GENERATED_AT,
  finishedAt: GENERATED_AT,
  provider: "Shared daily compute",
  universeSize: 2,
  signalsGenerated: 2,
  trigger: "scheduled" as const,
  status: "complete" as const,
  stages: [],
};

function sharedBoard(marketDay = "2026-09-16") {
  return { signals: buildScored(), run: CACHED_RUN, computedAt: GENERATED_AT, marketDay };
}

beforeEach(() => {
  liveDataActive = true;
  readCachedBoard.mockReset().mockResolvedValue(null);
  readMostRecentCachedBoard.mockReset().mockResolvedValue(null);
  writeCachedBoard.mockReset().mockResolvedValue(undefined);
  fetchRecentSharedSignals.mockReset().mockResolvedValue(null);
  marketDayKeyMock.mockReset().mockReturnValue("2026-09-16");
  runResearchSpy.mockClear();
  useAppStore.setState({
    researchStatus: "idle",
    signals: [],
    boardRegime: null,
    signalsFromShared: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("runResearchNow — IndexedDB cold-load fast path", () => {
  it("cache HIT: paints the board directly, 'loading' never appears, network never called", async () => {
    readCachedBoard.mockResolvedValue(sharedBoard());
    const seen: string[] = [];
    const unsub = useAppStore.subscribe((s) => seen.push(s.researchStatus));

    await useAppStore.getState().runResearchNow("scheduled");
    unsub();

    expect(readCachedBoard).toHaveBeenCalledWith("2026-09-16");
    expect(seen).not.toContain("loading");
    expect(fetchRecentSharedSignals).not.toHaveBeenCalled();
    expect(runResearchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().researchStatus).toBe("complete");
    expect(useAppStore.getState().signalsFromShared).toBe(true);
    expect(useAppStore.getState().signals.map((s) => s.ticker)).toEqual(
      buildScored().map((s) => s.ticker),
    );
    // An exact-key hit short-circuits before even trying the fallback tier.
    expect(readMostRecentCachedBoard).not.toHaveBeenCalled();
    // A cache hit must never itself write back to the cache (only a fresh
    // network fetch does that).
    expect(writeCachedBoard).not.toHaveBeenCalled();
  });

  it("fallback-day HIT: today's exact key misses but a recent cached day is found — paints directly, no skeleton, no network, no re-write", async () => {
    // Simulates the exact bug this tier fixes: no scan has landed for TODAY
    // yet, but a recent prior day's board (e.g. yesterday's, or last Friday's
    // before a weekend scan) is already sitting in IndexedDB under ITS OWN
    // date, written there by an earlier open this same day.
    readCachedBoard.mockResolvedValue(null);
    const recent = sharedBoard("2026-09-15");
    readMostRecentCachedBoard.mockResolvedValue(recent);
    const seen: string[] = [];
    const unsub = useAppStore.subscribe((s) => seen.push(s.researchStatus));

    await useAppStore.getState().runResearchNow("scheduled");
    unsub();

    expect(readCachedBoard).toHaveBeenCalledWith("2026-09-16");
    // Mirrors fetchRecentSharedSignals's own staleness window - see
    // SHARED_BOARD_MAX_AGE_DAYS in dailySignalsCache.ts.
    expect(readMostRecentCachedBoard).toHaveBeenCalledWith("2026-09-16", 5);
    expect(seen).not.toContain("loading");
    expect(fetchRecentSharedSignals).not.toHaveBeenCalled();
    expect(runResearchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().researchStatus).toBe("complete");
    expect(useAppStore.getState().signalsFromShared).toBe(true);
    expect(useAppStore.getState().lastRun?.id).toBe(CACHED_RUN.id);
    // Already cached - re-writing it would be pointless (and would reset
    // nothing useful, since the key is unchanged).
    expect(writeCachedBoard).not.toHaveBeenCalled();
  });

  it("fallback-day FAILURE (rejects): degrades exactly like a miss — falls back to network, never throws", async () => {
    readCachedBoard.mockResolvedValue(null);
    readMostRecentCachedBoard.mockRejectedValue(new Error("IndexedDB blocked"));
    const fetched = sharedBoard();
    fetchRecentSharedSignals.mockResolvedValue(fetched);

    await expect(useAppStore.getState().runResearchNow("scheduled")).resolves.toBeUndefined();

    expect(fetchRecentSharedSignals).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().researchStatus).toBe("complete");
    expect(useAppStore.getState().signals.length).toBeGreaterThan(0);
  });

  it("cache MISS (both tiers): falls through to the existing network path unchanged, then writes through", async () => {
    readCachedBoard.mockResolvedValue(null);
    readMostRecentCachedBoard.mockResolvedValue(null);
    const fetched = sharedBoard();
    fetchRecentSharedSignals.mockResolvedValue(fetched);
    const seen: string[] = [];
    const unsub = useAppStore.subscribe((s) => seen.push(s.researchStatus));

    await useAppStore.getState().runResearchNow("scheduled");
    unsub();

    expect(readMostRecentCachedBoard).toHaveBeenCalledWith("2026-09-16", 5);
    expect(fetchRecentSharedSignals).toHaveBeenCalledTimes(1);
    // Unchanged pre-existing behavior: the network path DOES pass through the
    // quiet "loading" state (no visible skeleton fix applies here - this is
    // the first-open-of-the-day case where a fetch is genuinely required).
    expect(seen).toContain("loading");
    expect(writeCachedBoard).toHaveBeenCalledTimes(1);
    expect(writeCachedBoard).toHaveBeenCalledWith(fetched);
    expect(useAppStore.getState().researchStatus).toBe("complete");
    expect(useAppStore.getState().signalsFromShared).toBe(true);
  });

  it("exact-key cache FAILURE (rejects): degrades exactly like a miss — falls back to the fallback tier / network, never throws", async () => {
    readCachedBoard.mockRejectedValue(new Error("IndexedDB blocked"));
    const fetched = sharedBoard();
    fetchRecentSharedSignals.mockResolvedValue(fetched);

    await expect(useAppStore.getState().runResearchNow("scheduled")).resolves.toBeUndefined();

    expect(fetchRecentSharedSignals).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().researchStatus).toBe("complete");
    expect(useAppStore.getState().signals.length).toBeGreaterThan(0);
  });

  it("stale market day: a cache miss for TODAY'S key is never masked by an old day's data via the exact-key lookup", async () => {
    // Simulate the cache only holding a PRIOR day's row (e.g. last Friday) -
    // the mock's readCachedBoard is queried with today's key and correctly
    // returns null for it, exactly as the real module would (strict equality,
    // no fuzzy "most recent" matching inside readCachedBoard itself - that
    // lookup is readMostRecentCachedBoard's job, covered by its own
    // "fallback-day HIT" test above; it's left at its default (null) miss
    // here so this test isolates readCachedBoard's own strict contract).
    readCachedBoard.mockImplementation(async (key: unknown) =>
      key === "2026-09-16" ? null : sharedBoard("2026-09-12"),
    );
    const fetched = sharedBoard("2026-09-16");
    fetchRecentSharedSignals.mockResolvedValue(fetched);

    await useAppStore.getState().runResearchNow("scheduled");

    expect(readCachedBoard).toHaveBeenCalledWith("2026-09-16");
    // Must fall through to the network rather than silently accepting a stale
    // cached day, and the board that lands is the fresh one.
    expect(fetchRecentSharedSignals).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().lastRun?.id).toBe(CACHED_RUN.id);
  });

  it("respects the fail-closed app_controls gate: sample-mode/paused skips the fast path entirely", async () => {
    liveDataActive = false;
    readCachedBoard.mockResolvedValue(sharedBoard());

    await useAppStore.getState().runResearchNow("scheduled");

    // Never even consulted when the operator gate says not-live - the SAME
    // condition that already guarded the network path guards this one too.
    expect(readCachedBoard).not.toHaveBeenCalled();
    expect(readMostRecentCachedBoard).not.toHaveBeenCalled();
    expect(fetchRecentSharedSignals).not.toHaveBeenCalled();
  });
});
