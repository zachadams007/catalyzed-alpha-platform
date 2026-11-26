import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage breadth is FUNCTIONALITY, not an A/B experiment. The full-market
 * funnel (the "wider net") must be the default live universe whenever FMP is
 * configured - for champion and challenger ALIKE - and never gated behind the
 * engine variant. These tests lock that invariant so a future change can't
 * silently re-narrow the default (the exact regression we just fixed).
 *
 * The node test env has no `window`, so the real `isSampleDataModeEnabled()`
 * returns its safe default (true) and `resolveProviderId()` would short-circuit
 * to "mock". We mock the module so the live-provider selection path is exercised
 * - http.ts reads the same getter, so the stubbed VITE_ keys register as live.
 */
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: () => false,
  // No global controls in this env, so resolution is never pending.
  isSampleDataModePending: () => false,
  getSampleDataModeState: () => ({
    safetyVersion: 2,
    enabled: false,
    updatedBy: null,
    updatedAt: null,
  }),
  setSampleDataModeEnabled: () => false,
  SAMPLE_DATA_MODE_STORAGE_KEY: "catalyzed-dev-offline",
}));

// `resolveProviderId()` only reads config + env - it never constructs a
// provider. Stub the provider classes so importing the barrel doesn't pull in
// the eager mock-universe build (a circular links.ts import that breaks at load
// under Node) and keeps selection logic the only thing under test.
vi.mock("@/data/providers/MockDataProvider", () => ({ MockDataProvider: class {} }));
vi.mock("@/data/providers/FinnhubDataProvider", () => ({ FinnhubDataProvider: class {} }));
vi.mock("@/data/providers/FmpDataProvider", () => ({ FmpDataProvider: class {} }));
vi.mock("@/data/providers/HybridDataProvider", () => ({ HybridDataProvider: class {} }));
vi.mock("@/data/providers/DiscoveryDataProvider", () => ({ DiscoveryDataProvider: class {} }));
vi.mock("@/data/providers/FunnelDataProvider", () => ({ FunnelDataProvider: class {} }));
vi.mock("@/data/providers/LiveProviderStub", () => ({ LiveProviderStub: class {} }));

import { isLiveFunnelViable, resolveProviderId } from "@/data/providers";

const FMP = "test-fmp-key";
const FINNHUB = "test-finnhub-key";
const PROXY = "https://proxy.example/run";

function setEnv(opts: {
  provider?: string;
  variant?: string;
  fmp?: string;
  finnhub?: string;
  proxy?: string;
  /** Hosted market proxy. Defaults to "" so the real `.env` value can't leak in
   *  and flip the keyless placeholder (fmpKey/finnhubKey) under us. */
  marketProxy?: string;
}) {
  vi.stubEnv("VITE_DATA_PROVIDER", opts.provider ?? "");
  vi.stubEnv("VITE_ENGINE_VARIANT", opts.variant ?? "");
  vi.stubEnv("VITE_FMP_API_KEY", opts.fmp ?? "");
  vi.stubEnv("VITE_FINNHUB_API_KEY", opts.finnhub ?? "");
  vi.stubEnv("VITE_RESEARCH_PROXY_URL", opts.proxy ?? "");
  vi.stubEnv("VITE_MARKET_PROXY_URL", opts.marketProxy ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveProviderId — the wider net is the default coverage path", () => {
  it("auto-picks the full-market funnel when FMP is configured (champion build)", () => {
    setEnv({ variant: "", fmp: FMP, finnhub: FINNHUB, proxy: PROXY });
    expect(resolveProviderId()).toBe("funnel");
  });

  it("still auto-picks the funnel under the challenger flag — coverage is NOT variant-gated", () => {
    setEnv({ variant: "challenger", fmp: FMP, finnhub: FINNHUB, proxy: PROXY });
    expect(resolveProviderId()).toBe("funnel");
  });

  it("prefers the funnel over niche discovery even when the proxy is configured", () => {
    // Both could run; the wider net wins by default.
    setEnv({ fmp: FMP, finnhub: FINNHUB, proxy: PROXY });
    expect(resolveProviderId()).toBe("funnel");
  });

  it("honors an explicit VITE_DATA_PROVIDER override (discovery)", () => {
    setEnv({ provider: "discovery", fmp: FMP, finnhub: FINNHUB, proxy: PROXY });
    expect(resolveProviderId()).toBe("discovery");
  });

  it("falls back to niche discovery when FMP is absent but the proxy + Finnhub are set", () => {
    setEnv({ fmp: "", finnhub: FINNHUB, proxy: PROXY });
    expect(resolveProviderId()).toBe("discovery");
  });

  it("falls back to a single vendor when only Finnhub is configured", () => {
    setEnv({ fmp: "", finnhub: FINNHUB, proxy: "" });
    expect(resolveProviderId()).toBe("finnhub");
  });

  it("returns null when no live source is configured (sample data never shown as live)", () => {
    setEnv({ fmp: "", finnhub: "", proxy: "" });
    expect(resolveProviderId()).toBeNull();
  });

  it("auto-picks the funnel on a KEYLESS build — no local key, only the market proxy", () => {
    // The production web/phone path: VITE_*_API_KEY are all empty; the hosted
    // proxy injects them. fmpKey()/finnhubKey() return a strippable placeholder
    // so the funnel is still reachable instead of falling to the gate.
    setEnv({ fmp: "", finnhub: "", proxy: "", marketProxy: "https://proxy.example/run" });
    expect(resolveProviderId()).toBe("funnel");
  });

  it("still returns null on a keyless build in nothing-configured shape (no proxy either)", () => {
    setEnv({ fmp: "", finnhub: "", proxy: "", marketProxy: "" });
    expect(resolveProviderId()).toBeNull();
  });
});

describe("isLiveFunnelViable — the live funnel only runs with a REAL local FMP key", () => {
  it("is TRUE with a real local FMP key (desktop / dev) — the funnel screener is reachable", () => {
    setEnv({ fmp: FMP, finnhub: FINNHUB });
    // Sanity: the funnel is the resolved provider here.
    expect(resolveProviderId()).toBe("funnel");
    expect(isLiveFunnelViable()).toBe(true);
  });

  it("is FALSE on the KEYLESS web build — funnel is SELECTED via the proxy but its paid screener isn't usable", () => {
    // No local key; only the hosted market proxy → resolveProviderId() picks the
    // funnel (proxy-injected placeholder), but the live screener sweep can't run.
    setEnv({ fmp: "", finnhub: "", marketProxy: PROXY });
    expect(resolveProviderId()).toBe("funnel");
    expect(isLiveFunnelViable()).toBe(false);
  });

  it("is FALSE when the funnel is not the resolved provider (e.g. single-vendor Finnhub)", () => {
    setEnv({ fmp: "", finnhub: FINNHUB });
    expect(resolveProviderId()).toBe("finnhub");
    expect(isLiveFunnelViable()).toBe(false);
  });
});
