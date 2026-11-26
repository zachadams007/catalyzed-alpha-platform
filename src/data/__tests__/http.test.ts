import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pin the DEVICE-LOCAL / unconfigured-build gate path - the shared slot-reservation
// + pause/budget gate logic that governs when no Supabase global-controls source
// exists. The GLOBAL (configured) operator path is covered by globalControls.test.ts.
// Report the global layer unconfigured so the gate reads the local controls this
// file seeds (live UNPAUSED with a known budget).
vi.mock("@/data/globalControls", () => ({
  isGlobalControlsConfigured: () => false,
  getGlobalControls: () => null,
  areGlobalControlsLoaded: () => true,
  subscribeGlobalControls: () => () => {},
  initGlobalControls: async () => {},
  refreshGlobalControls: async () => {},
  saveGlobalControls: async () => false,
}));

/**
 * Busy-flag lifecycle regression (Research Desk "stuck busy" bug).
 *
 * `postJson` / `httpText` RESERVE a usage slot via `checkApiAllowed` (which does
 * `reservedCalls[vendor] += 1`) and are the ONLY code that releases it, via
 * `recordApiCall`. If a request settles WITHOUT recording - e.g. the dynamic
 * `import("@tauri-apps/api/core")` rejects before the fetch is made - the reserved
 * slot leaks for the page's lifetime. `peekApiAllowed` counts those reservations
 * against the vendor budget, so a leak silently drives the Research Desk lane to
 * `paused` → the desk reports "busy" and refuses to start a run, with no recovery
 * short of a reload.
 *
 * These tests pin the contract: the reserved slot is ALWAYS released - on success,
 * on an HTTP error, on an abort/timeout, AND on a pre-request throw - so the lane
 * never wedges into a phantom busy state.
 */

// ---------------------------------------------------------------------------
// In-memory localStorage seeded so live data is UNPAUSED with a known proxy
// budget. vitest runs in the `node` env - there is no DOM storage by default,
// and apiUsage.ts reads controls/ledger at module init.
// ---------------------------------------------------------------------------
const PROXY_URL = "https://desk.example.dev/research";
// Generous so the legitimately-RECORDED errors below never themselves close the
// gate - only a per-call reservation LEAK could, which is exactly what we're
// guarding against.
const PROXY_BUDGET = 500;

function installMemoryStorage(): void {
  const backing = new Map<string, string>();
  // safetyVersion must match apiUsage's API_SAFETY_VERSION (2) or it resets.
  backing.set(
    "catalyzed-alpha:api-controls:v1",
    JSON.stringify({
      safetyVersion: 2,
      paused: false,
      enforceBudgets: true,
      budgets: { proxy: PROXY_BUDGET },
      updatedBy: null,
      updatedAt: null,
    }),
  );
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
}

// `vendorOf(PROXY_URL)` resolves "proxy" only when VITE_RESEARCH_PROXY_URL matches
// the request host, so the reservation/budget are keyed to the proxy lane.
vi.stubEnv("VITE_RESEARCH_PROXY_URL", PROXY_URL);

// vitest runs in `node` (no `window`), so sample-data mode defaults to ON, which
// short-circuits http.ts before the usage gate. Force it OFF so the gate +
// reservation lifecycle under test actually runs.
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: () => false,
}));

// Mock the Tauri core probe so we can (a) run the browser branch by default and
// (b) simulate the dynamic-import FAILURE that used to leak the slot.
//
// When `failCoreImport` is set, READING `isTauri` off the imported namespace
// throws - i.e. `const { isTauri } = await import("@tauri-apps/api/core")` throws
// at the destructure. In the OLD postJson that destructure ran BEFORE the try
// that holds `record()`, so the reserved slot leaked with nothing recorded. This
// is deterministic (the getter throws on every access - no mock-cache surprises).
const isTauriMock = vi.fn<() => boolean>(() => false);
let failCoreImport = false;
vi.mock("@tauri-apps/api/core", () => ({
  get isTauri() {
    if (failCoreImport) throw new Error("Failed to fetch dynamically imported module");
    return () => isTauriMock();
  },
}));

let httpMod: typeof import("@/data/http");
let usageMod: typeof import("@/lib/apiUsage");

beforeEach(async () => {
  installMemoryStorage();
  isTauriMock.mockReturnValue(false);
  failCoreImport = false;
  vi.resetModules();
  // Re-import AFTER storage is stubbed so apiUsage initializes from our controls.
  usageMod = await import("@/lib/apiUsage");
  httpMod = await import("@/data/http");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The desk lane is runnable exactly when the usage gate allows the proxy. */
function laneRunnable(): boolean {
  return usageMod.peekApiAllowed(PROXY_URL).allowed;
}

/** Today's recorded proxy calls (ok + err) - proof a `record()` actually fired. */
function proxyRecordedToday(): { today: number; errorsToday: number } {
  const row = usageMod.getUsageSnapshot().vendors.find((v) => v.meta.id === "proxy");
  return { today: row?.today ?? 0, errorsToday: row?.errorsToday ?? 0 };
}

describe("postJson — usage-slot lifecycle (Research Desk busy-lock regression)", () => {
  it("releases the reserved slot on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    expect(laneRunnable()).toBe(true);
    await expect(httpMod.postJson(PROXY_URL, { task: "deep_research" })).resolves.toEqual({
      ok: true,
    });
    expect(laneRunnable()).toBe(true);
  });

  it("releases the reserved slot on an HTTP error and records the failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const before = proxyRecordedToday().errorsToday;
    await expect(httpMod.postJson(PROXY_URL, { task: "deep_research" })).rejects.toThrow(
      /HTTP 500/,
    );
    // The failure was recorded (which is what RELEASES the reserved slot) and the
    // lane stays runnable. Delta-based: the shared usage ledger may carry proxy
    // calls from other suites in the full test run.
    expect(proxyRecordedToday().errorsToday).toBe(before + 1);
    expect(laneRunnable()).toBe(true);
  });

  it("releases the reserved slot on an abort/timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort);
        });
      }),
    );
    await expect(
      httpMod.postJson(PROXY_URL, { task: "deep_research" }, 5),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(laneRunnable()).toBe(true);
  });

  it("releases the reserved slot when the dynamic import throws BEFORE the request (the leak)", async () => {
    // Simulate the chunk-load failure: `await import("@tauri-apps/api/core")`
    // REJECTS before any fetch happens - the exact pre-`try` throw the old code
    // never recorded against.
    failCoreImport = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const before = proxyRecordedToday().errorsToday;

    await expect(httpMod.postJson(PROXY_URL, { task: "deep_research" })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();

    // THE BUG SIGNATURE: before the fix this path threw before any `record()`, so
    // the reservation from `checkApiAllowed` was never released AND nothing was
    // recorded (errorsToday would stay 0 while the phantom reservation lingered).
    // The finally now guarantees one failure record - which RELEASES the reserved
    // slot and leaves an honest ledger entry. A recorded error here is the proof
    // the release ran on the pre-request throw path.
    expect(proxyRecordedToday().errorsToday).toBe(before + 1);
    expect(laneRunnable()).toBe(true);
  });
});

describe("httpText — usage-slot lifecycle", () => {
  const FINNHUB_URL = "https://finnhub.io/api/v1/quote?symbol=AAPL&token=x";

  function finnhubRecordedToday(): { today: number; errorsToday: number } {
    const row = usageMod.getUsageSnapshot().vendors.find((v) => v.meta.id === "finnhub");
    return { today: row?.today ?? 0, errorsToday: row?.errorsToday ?? 0 };
  }

  it("records a success and stays runnable (slot released)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello", { status: 200 })),
    );
    const before = finnhubRecordedToday().today;
    await expect(httpMod.httpText(FINNHUB_URL)).resolves.toBe("hello");
    expect(finnhubRecordedToday().today).toBe(before + 1);
    expect(usageMod.peekApiAllowed(FINNHUB_URL).allowed).toBe(true);
  });

  it("records the failure and stays runnable on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const before = finnhubRecordedToday().errorsToday;
    await expect(httpMod.httpText(FINNHUB_URL)).rejects.toThrow(/HTTP 500/);
    // The failure record both releases the reserved finnhub slot and lands an
    // honest ledger entry - the lane never wedges from a dropped reservation.
    expect(finnhubRecordedToday().errorsToday).toBe(before + 1);
    expect(usageMod.peekApiAllowed(FINNHUB_URL).allowed).toBe(true);
  });

  // C-1 (ROOT CAUSE): a live GET with NO caller-supplied timeoutMs must STILL
  // abort on the default 15s safety ceiling. A TCP stall / slow-loris / hung
  // proxy never resolves and never rejects on its own, so before this fix the
  // caller's try/catch never fired and the live path hung forever. Now the
  // always-armed AbortController aborts the request → it rejects → the existing
  // catches turn it into honest N/A/null/empty instead of an infinite hang.
  it("aborts a never-resolving GET on the default timeout when the caller passes none", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that never settles on its own - it only ever rejects when the
      // shared AbortController fires (proving the abort path, not a stub return).
      const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort);
        });
      });
      vi.stubGlobal("fetch", fetchSpy);
      const before = finnhubRecordedToday().errorsToday;

      // No timeoutMs passed - relies entirely on the default ceiling.
      const pending = httpMod.httpJson(FINNHUB_URL);
      const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });

      // Advance past the 15s default ceiling; the await of the dynamic import
      // needs the microtask queue flushed before the timer is armed.
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;

      // The abort routed through record(false) → the reserved slot is released
      // and the lane stays runnable; an infinite hang would never have recorded.
      expect(finnhubRecordedToday().errorsToday).toBe(before + 1);
      expect(usageMod.peekApiAllowed(FINNHUB_URL).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("nextFmpKey — round-robin FMP key pool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cycles evenly across all configured keys (pool of 4)", async () => {
    vi.stubEnv("VITE_FMP_API_KEY", "key-a");
    vi.stubEnv("VITE_FMP_API_KEY_2", "key-b");
    vi.stubEnv("VITE_FMP_API_KEY_3", "key-c");
    vi.stubEnv("VITE_FMP_API_KEY_4", "key-d");
    vi.resetModules();
    const mod = await import("@/data/http");
    const seen = Array.from({ length: 8 }, () => mod.nextFmpKey());
    expect(seen).toEqual([
      "key-a",
      "key-b",
      "key-c",
      "key-d",
      "key-a",
      "key-b",
      "key-c",
      "key-d",
    ]);
  });

  it("behaves exactly like the single-key path when only one key is configured", async () => {
    vi.stubEnv("VITE_FMP_API_KEY", "only-key");
    vi.stubEnv("VITE_FMP_API_KEY_2", "");
    vi.stubEnv("VITE_FMP_API_KEY_3", "");
    vi.stubEnv("VITE_FMP_API_KEY_4", "");
    vi.resetModules();
    const mod = await import("@/data/http");
    expect(mod.nextFmpKey()).toBe("only-key");
    expect(mod.nextFmpKey()).toBe("only-key");
    expect(mod.nextFmpKey()).toBe(mod.fmpKey());
  });
});
