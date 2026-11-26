import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * FMP answers HTTP 402 for TWO completely different situations, and telling them
 * apart is the difference between "skip one premium ticker" and "disable every
 * quote in the app for the rest of the session".
 *
 *   endpoint-scoped: "Restricted Endpoint: This endpoint is not available under
 *                     your current subscription"      → trip the endpoint off
 *   symbol-scoped:   "Premium Query Parameter: 'Special Endpoint : This value set
 *                     for 'symbol' is not available…" → skip that ticker only
 *
 * The first version of this breaker keyed only on the status code, so a single
 * premium mid-cap (MU) tripped `/quote` off and silently killed live quotes for
 * every other ticker. These tests pin the scoping so that cannot regress.
 */

// The module reads import.meta.env and pulls in the sample-mode gate; neither is
// relevant to scope classification, so keep the graph small and deterministic.
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: () => false,
}));
vi.mock("@/data/marketProxy", () => ({
  finnhubRetryUrl: () => null,
  isMarketProxyConfigured: () => false,
  isRateLimitStatus: () => false,
  resolveMarketRequest: (url: string) => ({ url, headers: undefined, proxied: false }),
  secondFinnhubKey: () => undefined,
}));
vi.mock("@/lib/apiUsage", () => ({
  checkApiAllowed: () => ({ allowed: true }),
  hasVisionKey: () => false,
  recordApiCall: () => {},
}));

const SYMBOL_402 =
  "Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not " +
  "available under your current subscription please visit our subscription page to upgrade";
const ENDPOINT_402 =
  "Restricted Endpoint: This endpoint is not available under your current subscription " +
  "please visit our subscription page to upgrade your plan";
const LEGACY_403 =
  "Legacy Endpoint : Due to Legacy endpoints being no longer supported - This endpoint is " +
  "only available for legacy users who have valid subscriptions prior August 31, 2025.";

describe("plan-blocked scoping", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("a PREMIUM SYMBOL refusal must not disable the endpoint", async () => {
    const http = await import("@/data/http");
    http.notePlanBlocked("fmp", "/quote", 402, SYMBOL_402);
    http.notePlanBlockedSymbol("fmp", "MU", SYMBOL_402);

    expect(http.isPlanBlocked("fmp", "/quote")).toBe(false);
    expect(http.isPlanBlockedSymbol("fmp", "MU")).toBe(true);
    // Everything else still flows through the same endpoint.
    expect(http.isPlanBlockedSymbol("fmp", "NVDA")).toBe(false);
  });

  it("an ENDPOINT refusal disables the endpoint but blames no symbol", async () => {
    const http = await import("@/data/http");
    http.notePlanBlocked("fmp", "/company-screener", 402, ENDPOINT_402);
    http.notePlanBlockedSymbol("fmp", "AAPL", ENDPOINT_402);

    expect(http.isPlanBlocked("fmp", "/company-screener")).toBe(true);
    expect(http.isPlanBlockedSymbol("fmp", "AAPL")).toBe(false);
  });

  it("a retired LEGACY endpoint (403) is endpoint-scoped", async () => {
    const http = await import("@/data/http");
    http.notePlanBlocked("fmp", "/quote", 403, LEGACY_403);
    expect(http.isPlanBlocked("fmp", "/quote")).toBe(true);
  });

  it("an UNRECOGNISED body trips nothing — refuse to guess", async () => {
    const http = await import("@/data/http");
    http.notePlanBlocked("fmp", "/quote", 402, "service temporarily unavailable");
    http.notePlanBlockedSymbol("fmp", "TSLA", "service temporarily unavailable");

    expect(http.isPlanBlocked("fmp", "/quote")).toBe(false);
    expect(http.isPlanBlockedSymbol("fmp", "TSLA")).toBe(false);
  });

  it("symbol blocking is case-insensitive", async () => {
    const http = await import("@/data/http");
    http.notePlanBlockedSymbol("fmp", "mu", SYMBOL_402);
    expect(http.isPlanBlockedSymbol("fmp", "MU")).toBe(true);
  });

  it("HttpError carries the status and body a caller needs to classify", async () => {
    const { HttpError } = await import("@/data/http");
    const err = new HttpError(402, SYMBOL_402);
    expect(err.status).toBe(402);
    expect(err.body).toContain("Premium Query Parameter");
    // Message shape is load-bearing: researchAgent parses /HTTP (\d{3})/.
    expect(err.message).toBe("HTTP 402");
  });
});
