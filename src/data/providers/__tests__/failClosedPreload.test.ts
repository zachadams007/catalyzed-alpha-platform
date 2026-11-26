import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B-1 / B-2 regression: the fail-closed pre-load window must render an EMPTY /
 * SKELETON state - NEVER the fictional MOCK_UNIVERSE under a "Live data" badge.
 *
 * The bug: when Supabase IS configured but the global `app_controls` row hasn't
 * loaded yet (slow/failed first fetch), the provider selector used to fail OPEN
 * to sample-ON → `resolveProviderId()` returned "mock" → the MockDataProvider
 * served MOCK_UNIVERSE, which reuses real symbols for fictional companies. Once
 * the controls later resolved to sample=false the badge flipped to "Live data"
 * while the store still held those mock signals.
 *
 * The fix is a tri-state: configured-but-not-loaded ⇒ pending ⇒ provider null
 * (loading skeleton), no Live badge, and the mock universe is served ONLY when
 * sample mode is EXPLICITLY on AND the controls have actually loaded.
 *
 * Auth + admin + the provider classes are stubbed so importing the barrel never
 * pulls the eager mock-universe build under Node. globalControls is hand-driven
 * so we can move between the pending / loaded-live / loaded-sample states.
 */

// Mutable global-controls state the mock reads - flipped per test.
const gc = vi.hoisted(() => ({
  configured: true,
  /** null = configured-but-not-loaded (PENDING); object = loaded. */
  controls: null as { sampleMode: boolean } | null,
}));

vi.mock("@/data/globalControls", () => ({
  isGlobalControlsConfigured: () => gc.configured,
  getGlobalControls: () => gc.controls,
  isGlobalControlsPending: () => gc.configured && gc.controls === null,
  areGlobalControlsLoaded: () => gc.controls !== null,
  subscribeGlobalControls: () => () => {},
  initGlobalControls: async () => {},
  refreshGlobalControls: async () => {},
  saveGlobalControls: async () => false,
}));

vi.mock("@/lib/admin", () => ({
  isAdminEmail: () => false,
  isAdminConfigured: () => true,
}));

vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: { getState: () => ({ ready: true, userId: "u-1", email: null }) },
}));

// Stub the provider classes so the barrel import doesn't build MOCK_UNIVERSE.
vi.mock("@/data/providers/MockDataProvider", () => ({
  MockDataProvider: class {
    id = "mock";
    name = "Local Mock Universe";
    isLive = false;
  },
}));
vi.mock("@/data/providers/FinnhubDataProvider", () => ({ FinnhubDataProvider: class {} }));
vi.mock("@/data/providers/FmpDataProvider", () => ({ FmpDataProvider: class {} }));
vi.mock("@/data/providers/HybridDataProvider", () => ({ HybridDataProvider: class {} }));
vi.mock("@/data/providers/DiscoveryDataProvider", () => ({ DiscoveryDataProvider: class {} }));
vi.mock("@/data/providers/FunnelDataProvider", () => ({ FunnelDataProvider: class {} }));
vi.mock("@/data/providers/LiveProviderStub", () => ({ LiveProviderStub: class {} }));

import {
  isDataSourceConfigured,
  isLiveDataActive,
  isProviderResolutionPending,
  isSampleDataModeEnabled,
  resolveProviderId,
} from "@/data/providers";

beforeEach(() => {
  // Default to a live build (FMP configured) so a non-pending state resolves live.
  vi.stubEnv("VITE_DATA_PROVIDER", "");
  vi.stubEnv("VITE_FMP_API_KEY", "test-fmp");
  vi.stubEnv("VITE_FINNHUB_API_KEY", "test-finnhub");
  vi.stubEnv("VITE_RESEARCH_PROXY_URL", "");
  vi.stubEnv("VITE_MARKET_PROXY_URL", "");
  gc.configured = true;
  gc.controls = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fail-closed pre-load: configured but controls NOT loaded (pending)", () => {
  it("resolveProviderId() is null (loading), NOT 'mock'", () => {
    gc.controls = null; // PENDING
    expect(isProviderResolutionPending()).toBe(true);
    expect(resolveProviderId()).toBeNull();
    expect(resolveProviderId()).not.toBe("mock");
  });

  it("never shows a Live badge while pending", () => {
    gc.controls = null;
    expect(isLiveDataActive()).toBe(false);
  });

  it("isDataSourceConfigured() is false while pending (bootstrap must not auto-run)", () => {
    gc.controls = null;
    expect(isDataSourceConfigured()).toBe(false);
  });

  it("keeps the http kill-switch fail-closed (sample-enabled) so no live call leaks pre-load", () => {
    gc.controls = null;
    // isSampleDataModeEnabled() is what http.ts reads to block live I/O.
    expect(isSampleDataModeEnabled()).toBe(true);
  });
});

describe("after controls load", () => {
  it("sample=false ⇒ live provider, Live badge on, NOT pending", () => {
    gc.controls = { sampleMode: false };
    expect(isProviderResolutionPending()).toBe(false);
    expect(resolveProviderId()).toBe("funnel");
    expect(isLiveDataActive()).toBe(true);
  });

  it("serves the mock universe ONLY when sample mode is EXPLICITLY on AND loaded", () => {
    gc.controls = { sampleMode: true };
    expect(isProviderResolutionPending()).toBe(false);
    expect(resolveProviderId()).toBe("mock");
    expect(isLiveDataActive()).toBe(false);
    expect(isSampleDataModeEnabled()).toBe(true);
  });
});
