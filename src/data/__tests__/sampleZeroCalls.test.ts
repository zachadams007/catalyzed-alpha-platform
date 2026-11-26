import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// http.ts pulls in a large module graph; re-importing it per-test (vi.resetModules
// in every beforeEach) multiplies transform cost and times the hook out under full
// -suite load. Each describe seeds its (constant) storage + mocks ONCE in beforeAll
// and imports the graph once, so the heavy work happens a single time per block.
const HOOK_TIMEOUT = 30_000;

/**
 * Sample-mode = ZERO live API calls, anywhere.
 *
 * Every market-data fetch funnels through http.ts's `httpText`/`httpJson`/
 * `postJson`, which MUST hard-throw before any network I/O while sample mode is
 * ON - so "Scan Market", the scan, and every per-symbol fetch make no live call.
 * We also pin that the provider selector resolves to the local "mock" provider in
 * sample mode (the scan never even reaches for a live provider), and that a
 * sample-mode change applies INSTANTLY via `subscribeSampleDataMode`.
 */

const ADMIN = "operator@example.com";

vi.mock("@/lib/admin", () => ({
  isAdminEmail: (email: string | null | undefined) =>
    (email ?? "").trim().toLowerCase() === ADMIN,
  isAdminConfigured: () => true,
}));

vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: {
    getState: () => ({ ready: true, userId: "u-1", email: ADMIN }),
  },
}));

// Run the browser branch of http.ts (no Tauri), so a leaked call would hit the
// global `fetch` spy - which must never happen in sample mode.
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));

// Pin the DEVICE-LOCAL / unconfigured-build sample-mode path - the shared sample
// block + instant-flip logic that governs when no Supabase global-controls source
// exists. The GLOBAL (configured) operator path is covered by globalControls.test.ts.
// Report the global layer unconfigured so effectiveSampleState() reads the local
// state these tests toggle.
vi.mock("@/data/globalControls", () => ({
  isGlobalControlsConfigured: () => false,
  getGlobalControls: () => null,
  areGlobalControlsLoaded: () => true,
  subscribeGlobalControls: () => () => {},
  initGlobalControls: async () => {},
  refreshGlobalControls: async () => {},
  saveGlobalControls: async () => false,
}));

function installBrowserStorage(): Map<string, string> {
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
  // sampleDataMode.ts gates on `typeof window === "undefined"`, so we need a window.
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return backing;
}

/** Seed an explicit sample-mode state (safetyVersion must match SAMPLE_DATA_SAFETY_VERSION=2). */
function seedSampleMode(backing: Map<string, string>, enabled: boolean): void {
  backing.set(
    "catalyzed-dev-offline",
    JSON.stringify({
      safetyVersion: 2,
      enabled,
      updatedBy: ADMIN,
      updatedAt: new Date().toISOString(),
    }),
  );
}

let http: typeof import("@/data/http");
let sample: typeof import("@/data/providers/sampleDataMode");
let providers: typeof import("@/data/providers");

const FINNHUB_URL = "https://finnhub.io/api/v1/quote?symbol=AAPL&token=x";
const FMP_URL = "https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=x";
const PROXY_URL = "https://desk.example.dev/research";

describe("sample mode ON → zero live API calls", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const backing = installBrowserStorage();
    seedSampleMode(backing, true);
    vi.resetModules();
    http = await import("@/data/http");
    sample = await import("@/data/providers/sampleDataMode");
    providers = await import("@/data/providers");
  }, HOOK_TIMEOUT);

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    // Fresh spy per test; sample state is immutable in this block, so no re-import.
    fetchSpy = vi.fn(async () => new Response("should-never-be-called", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("isSampleDataModeEnabled() reads the live ON state", () => {
    expect(sample.isSampleDataModeEnabled()).toBe(true);
  });

  it("httpText throws and never calls fetch", async () => {
    await expect(http.httpText(FINNHUB_URL)).rejects.toThrow(/Sample data mode/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("httpJson throws and never calls fetch", async () => {
    await expect(http.httpJson(FMP_URL)).rejects.toThrow(/Sample data mode/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("postJson (research proxy) throws and never calls fetch", async () => {
    await expect(http.postJson(PROXY_URL, { task: "x" })).rejects.toThrow(/Sample data mode/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the scan never reaches a live provider — resolveProviderId() is 'mock'", () => {
    expect(providers.resolveProviderId()).toBe("mock");
    // The active provider is the local MockDataProvider (isLive === false).
    expect(providers.getActiveProvider().isLive).toBe(false);
  });

  it("vendor-key getters return undefined in sample mode (no key ever rides a request)", () => {
    expect(http.finnhubKey()).toBeUndefined();
    expect(http.fmpKey()).toBeUndefined();
    expect(http.alpacaKeyId()).toBeUndefined();
    expect(http.researchProxyUrl()).toBeUndefined();
  });
});

describe("sample mode OFF → live fetch is allowed through the gate", () => {
  beforeAll(async () => {
    const backing = installBrowserStorage();
    seedSampleMode(backing, false);
    // Unpaused + generous budget so the gate doesn't itself block the call.
    backing.set(
      "catalyzed-alpha:api-controls:v1",
      JSON.stringify({
        safetyVersion: 2,
        paused: false,
        enforceBudgets: true,
        budgets: { finnhub: 500 },
        updatedBy: null,
        updatedAt: null,
      }),
    );
    vi.resetModules();
    http = await import("@/data/http");
    sample = await import("@/data/providers/sampleDataMode");
  }, HOOK_TIMEOUT);

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("httpText reaches fetch when sample mode is OFF", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(http.httpText(FINNHUB_URL)).resolves.toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("sample-mode changes apply instantly (subscribeSampleDataMode)", () => {
  beforeEach(() => {
    const backing = installBrowserStorage();
    seedSampleMode(backing, false);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies subscribers and flips the live-read value on a write", async () => {
    sample = await import("@/data/providers/sampleDataMode");
    expect(sample.isSampleDataModeEnabled()).toBe(false);

    const spy = vi.fn();
    const unsub = sample.subscribeSampleDataMode(spy);

    // applySampleDataModeState is the single write path (used by setSampleDataModeEnabled
    // and the account-sync). It must persist + notify.
    const ok = sample.applySampleDataModeState(true, ADMIN, new Date().toISOString());
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // The data layer re-reads live - no reload needed.
    expect(sample.isSampleDataModeEnabled()).toBe(true);

    unsub();
    sample.applySampleDataModeState(false, ADMIN, new Date().toISOString());
    expect(spy).toHaveBeenCalledTimes(1); // unsubscribed
  });
});
