import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  finnhubRetryUrl,
  isFallbackConfigured,
  isProxyableVendor,
  isRateLimitStatus,
  planFallback,
  resolveMarketRequest,
} from "@/data/marketProxy";

// Every market-data key the module reads. Neutralized before each test so the
// real .env (loaded by Vite in test mode) can't leak in and make results
// non-deterministic; each test then opts into exactly the keys it needs.
const ENV_KEYS = [
  "VITE_MARKET_PROXY_URL",
  "VITE_FINNHUB_API_KEY",
  "VITE_FINNHUB_API_KEY_2",
  "VITE_POLYGON_API_KEY",
  "VITE_TIINGO_API_KEY",
  "VITE_RESEARCH_PROXY_URL",
];

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const FINNHUB = "https://finnhub.io/api/v1/quote?symbol=AAPL&token=SECRET_A";
const FMP = "https://financialmodelingprep.com/api/v3/profile/AAPL?apikey=SECRET_F";

describe("resolveMarketRequest — direct mode (no proxy configured)", () => {
  it("returns the vendor URL and headers untouched", () => {
    const headers = { Authorization: "Bearer x", "Content-Type": "application/json" };
    const out = resolveMarketRequest(FINNHUB, headers);
    expect(out.proxied).toBe(false);
    expect(out.url).toBe(FINNHUB);
    expect(out.headers).toEqual(headers);
  });
});

describe("resolveMarketRequest — proxy mode", () => {
  beforeEach(() => vi.stubEnv("VITE_MARKET_PROXY_URL", "https://proxy.example.dev"));

  it("strips Authorization and X-API-Key headers in proxy mode", () => {
    const out = resolveMarketRequest(FINNHUB, {
      Authorization: "Bearer x",
      "X-API-Key": "k",
      "Content-Type": "application/json",
    });
    expect(out.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("passes a malformed URL through untouched instead of throwing", () => {
    const out = resolveMarketRequest("not-a-url");
    expect(out.proxied).toBe(false);
    expect(out.url).toBe("not-a-url");
  });

  it("routes Finnhub through the proxy and strips the token", () => {
    const out = resolveMarketRequest(FINNHUB);
    expect(out.proxied).toBe(true);
    expect(out.url).toBe("https://proxy.example.dev/finnhub/api/v1/quote?symbol=AAPL");
    expect(out.url).not.toContain("SECRET_A");
    expect(out.url).not.toContain("token=");
  });

  it("routes FMP through the proxy and strips the apikey", () => {
    const out = resolveMarketRequest(FMP);
    expect(out.proxied).toBe(true);
    expect(out.url).toBe("https://proxy.example.dev/fmp/api/v3/profile/AAPL");
    expect(out.url).not.toContain("SECRET_F");
    expect(out.url).not.toContain("apikey");
  });

  it("strips secret headers but keeps benign ones", () => {
    const out = resolveMarketRequest("https://data.alpaca.markets/v1beta1/news", {
      "APCA-API-KEY-ID": "id",
      "APCA-API-SECRET-KEY": "secret",
      "Content-Type": "application/json",
    });
    expect(out.proxied).toBe(true);
    expect(out.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("tolerates a trailing slash on the proxy base", () => {
    vi.stubEnv("VITE_MARKET_PROXY_URL", "https://proxy.example.dev/");
    const out = resolveMarketRequest(FINNHUB);
    expect(out.url).toBe("https://proxy.example.dev/finnhub/api/v1/quote?symbol=AAPL");
  });

  it("passes through hosts it doesn't recognize as a market vendor", () => {
    const unknown = "https://some-other-host.test/data?x=1";
    const out = resolveMarketRequest(unknown);
    expect(out.proxied).toBe(false);
    expect(out.url).toBe(unknown);
  });
});

describe("isProxyableVendor", () => {
  it("recognizes known vendors and rejects others", () => {
    expect(isProxyableVendor(FINNHUB)).toBe(true);
    expect(isProxyableVendor(FMP)).toBe(true);
    expect(isProxyableVendor("https://data.sec.gov/submissions/x.json")).toBe(true);
    expect(isProxyableVendor("https://random.test/x")).toBe(false);
  });
});

describe("isRateLimitStatus", () => {
  it("flags 429/418 as rate-limited and nothing else", () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(418)).toBe(true);
    expect(isRateLimitStatus(200)).toBe(false);
    expect(isRateLimitStatus(403)).toBe(false);
    expect(isRateLimitStatus(500)).toBe(false);
  });
});

describe("fallback chain — planFallback / isFallbackConfigured", () => {
  it("is empty when no backup keys are configured", () => {
    expect(planFallback()).toEqual([]);
  });

  it("includes only providers whose keys are present, in chain order", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY_2", "k2");
    vi.stubEnv("VITE_TIINGO_API_KEY", "tg");
    // Polygon intentionally left unset → skipped between finnhub2 and tiingo.
    expect(planFallback()).toEqual(["finnhub2", "tiingo"]);
  });

  it("orders the full chain 2nd-Finnhub → Polygon → Tiingo", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY_2", "k2");
    vi.stubEnv("VITE_POLYGON_API_KEY", "pg");
    vi.stubEnv("VITE_TIINGO_API_KEY", "tg");
    expect(planFallback()).toEqual(["finnhub2", "polygon", "tiingo"]);
  });

  it("reports per-provider configuration", () => {
    vi.stubEnv("VITE_POLYGON_API_KEY", "pg");
    expect(isFallbackConfigured("polygon")).toBe(true);
    expect(isFallbackConfigured("tiingo")).toBe(false);
    expect(isFallbackConfigured("finnhub2")).toBe(false);
  });
});

describe("finnhubRetryUrl — client-side hop #1 (2nd Finnhub key)", () => {
  it("returns null for a Finnhub URL with no token to swap (never injects one)", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY_2", "SECRET_B");
    const noToken = "https://finnhub.io/api/v1/quote?symbol=AAPL";
    const out = finnhubRetryUrl(noToken);
    expect(out).toBeNull();
  });

  it("swaps the token to the second key on a Finnhub URL", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY_2", "SECRET_B");
    const retry = finnhubRetryUrl(FINNHUB);
    expect(retry).toBe("https://finnhub.io/api/v1/quote?symbol=AAPL&token=SECRET_B");
  });

  it("returns null when no second key is configured", () => {
    expect(finnhubRetryUrl(FINNHUB)).toBeNull();
  });

  it("returns null for a non-Finnhub URL", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY_2", "SECRET_B");
    expect(finnhubRetryUrl(FMP)).toBeNull();
  });

  it("returns null when the URL already uses the second key (no infinite swap)", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY_2", "SECRET_B");
    const already = "https://finnhub.io/api/v1/quote?symbol=AAPL&token=SECRET_B";
    expect(finnhubRetryUrl(already)).toBeNull();
  });
});
