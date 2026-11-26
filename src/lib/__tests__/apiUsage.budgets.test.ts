import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Daily-budget contract tests.
 *
 * 2. Operator control changes apply INSTANTLY: a budget set via `setVendorBudget`
 *    (or pause via `updateApiControls`) is visible to the very next
 *    `checkApiAllowed`/`peekApiAllowed` call with no module reload, and
 *    `subscribeApiUsage` fires so the UI re-renders.
 */

// ── Authorize the operator so setVendorBudget/updateApiControls succeed ─────────
const OPERATOR = "operator@example.com";

vi.mock("@/lib/admin", () => ({
  isAdminEmail: (email: string | null | undefined) =>
    (email ?? "").trim().toLowerCase() === OPERATOR,
  isAdminConfigured: () => true,
}));

vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: {
    getState: () => ({ ready: true, userId: "u-1", email: OPERATOR }),
  },
}));

// This file pins the DEVICE-LOCAL / unconfigured-build control path - the shared
// budget + gate logic that governs when no Supabase global-controls source exists.
// The GLOBAL (configured) operator path is covered by globalControls.test.ts +
// activeVariantGlobal.test.ts. Report the global layer unconfigured so
// effectiveControls() reads the local controls these tests drive.
vi.mock("@/data/globalControls", () => ({
  isGlobalControlsConfigured: () => false,
  getGlobalControls: () => null,
  areGlobalControlsLoaded: () => true,
  subscribeGlobalControls: () => () => {},
  initGlobalControls: async () => {},
  refreshGlobalControls: async () => {},
  saveGlobalControls: async () => false,
}));

function installMemoryStorage(seedControls?: Record<string, unknown>): void {
  const backing = new Map<string, string>();
  if (seedControls) {
    backing.set("catalyzed-alpha:api-controls:v1", JSON.stringify(seedControls));
  }
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

let usage: typeof import("@/lib/apiUsage");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SAFE_DEFAULT_BUDGETS = each key's full daily limit", () => {
  beforeEach(async () => {
    installMemoryStorage();
    vi.resetModules();
    usage = await import("@/lib/apiUsage");
  });

  it("ships the full daily limit for every keyed/keyless vendor (no low share)", () => {
    const b = usage.SAFE_DEFAULT_BUDGETS;
    expect(b.proxy).toBe(200);
    expect(b.fmp).toBe(250);
    expect(b.finnhub).toBe(250);
    expect(b.alpaca).toBe(500);
    expect(b.yahoo).toBe(500);
    expect(b.sec).toBe(600);
    expect(b.stocktwits).toBe(200);
    expect(b.apewisdom).toBe(60);
    expect(b.vision).toBe(100);
  });

  it("does NOT keep the old artificially-low caps (fmp 25 / proxy 25)", () => {
    expect(usage.SAFE_DEFAULT_BUDGETS.fmp).not.toBe(25);
    expect(usage.SAFE_DEFAULT_BUDGETS.proxy).not.toBe(25);
  });

  it("matches the printed allowance for every DAY-windowed vendor card", () => {
    for (const v of usage.API_VENDORS) {
      if (v.window !== "day") continue;
      const def = usage.SAFE_DEFAULT_BUDGETS[v.id];
      expect(def, `${v.id} default should equal its day limit`).toBe(v.limit);
    }
    // FMP, Research Proxy, Yahoo are day-windowed - this asserts they're covered.
    const dayVendors = usage.API_VENDORS.filter((v) => v.window === "day").map((v) => v.id);
    expect(dayVendors).toEqual(expect.arrayContaining(["fmp", "proxy", "yahoo"]));
  });

  it("a fresh device seeds every default cap into live controls", () => {
    const controls = usage.getApiControls();
    expect(controls.budgets).toMatchObject(usage.SAFE_DEFAULT_BUDGETS);
  });
});

describe("operator controls apply instantly (no restart)", () => {
  beforeEach(async () => {
    // Seed live + budget-enforcing so the gate actually evaluates budgets.
    installMemoryStorage({
      safetyVersion: 2,
      paused: false,
      enforceBudgets: true,
      budgets: { fmp: 250 },
      updatedBy: null,
      updatedAt: null,
    });
    vi.resetModules();
    usage = await import("@/lib/apiUsage");
  });

  const FMP_URL = "https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=x";

  it("a budget lowered via setVendorBudget gates the very next call — no reload", () => {
    expect(usage.peekApiAllowed(FMP_URL).allowed).toBe(true);
    // Drop the cap to 0-effective by setting it to 1 then exhausting it would be
    // slow; instead prove the NEW cap is read live: set a tiny cap, record up to it.
    expect(usage.setVendorBudget("fmp", 1, OPERATOR)).toBe(true);
    // First call allowed (0 used), then record it; the next peek must be blocked
    // against the freshly-set cap of 1 - proving checkApiAllowed reads live state.
    const gate = usage.checkApiAllowed(FMP_URL);
    expect(gate.allowed).toBe(true);
    usage.recordApiCall(FMP_URL, true);
    const blocked = usage.peekApiAllowed(FMP_URL);
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed === false && blocked.reason).toMatch(/budget/i);
  });

  it("pausing via updateApiControls blocks the next call immediately", () => {
    expect(usage.checkApiAllowed(FMP_URL).allowed).toBe(true);
    expect(usage.updateApiControls({ paused: true }, OPERATOR)).toBe(true);
    const gate = usage.peekApiAllowed(FMP_URL);
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toMatch(/paused/i);
  });

  it("notifies subscribers on a control change so the UI re-renders live", () => {
    const spy = vi.fn();
    const unsub = usage.subscribeApiUsage(spy);
    usage.setVendorBudget("fmp", 123, OPERATOR);
    expect(spy).toHaveBeenCalled();
    // The new value is immediately reflected in the live snapshot.
    expect(usage.getApiControls().budgets.fmp).toBe(123);
    unsub();
  });

  it("rejects a non-operator edit (auth gate intact)", () => {
    expect(usage.setVendorBudget("fmp", 5, "not-admin@example.com")).toBe(false);
    expect(usage.getApiControls().budgets.fmp).toBe(250);
  });
});
