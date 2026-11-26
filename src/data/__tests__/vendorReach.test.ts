import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vendorReach } from "@/data/http";

// Every env key `vendorReach` reads. Neutralized before each test so the real
// .env (loaded by Vite in test mode) can't leak in; each test opts into exactly
// the keys it needs. Mirrors src/data/__tests__/marketProxy.test.ts.
const ENV_KEYS = [
  "VITE_MARKET_PROXY_URL",
  "VITE_FINNHUB_API_KEY",
  "VITE_FINNHUB_API_KEY_2",
  "VITE_FMP_API_KEY",
  "VITE_ALPACA_API_KEY",
  "VITE_ALPACA_API_SECRET",
  "VITE_RESEARCH_PROXY_URL",
];

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vendorReach — truly unconfigured (no local key, no proxy)", () => {
  it("reports no path for the keyed market vendors (the only 'No key' state)", () => {
    expect(vendorReach("finnhub")).toEqual({ kind: "none", reachable: false, failover: null });
    expect(vendorReach("fmp")).toEqual({ kind: "none", reachable: false, failover: null });
    expect(vendorReach("alpaca")).toEqual({ kind: "none", reachable: false, failover: null });
  });

  it("reports no proxy for the research lane", () => {
    expect(vendorReach("proxy")).toEqual({ kind: "none", reachable: false, failover: null });
  });
});

describe("vendorReach — proxy mode (production keyless bundle)", () => {
  beforeEach(() => vi.stubEnv("VITE_MARKET_PROXY_URL", "https://proxy.example.dev"));

  it("treats every market vendor as reachable via the proxy, never 'No key'", () => {
    expect(vendorReach("finnhub")).toMatchObject({ kind: "proxy", reachable: true });
    expect(vendorReach("fmp")).toMatchObject({ kind: "proxy", reachable: true });
    expect(vendorReach("alpaca")).toMatchObject({ kind: "proxy", reachable: true });
  });

  it("surfaces Finnhub's server-side key rotation on a 429", () => {
    expect(vendorReach("finnhub").failover).toMatch(/429/);
  });

  it("does not invent failover copy for FMP / Alpaca (no documented backup)", () => {
    expect(vendorReach("fmp").failover).toBeNull();
    expect(vendorReach("alpaca").failover).toBeNull();
  });

  it("prefers the proxy even when a local key is also present (matches real routing)", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY", "local-key");
    expect(vendorReach("finnhub").kind).toBe("proxy");
  });
});

describe("vendorReach — direct mode (local keys, desktop / dev)", () => {
  it("reports a local Finnhub key, with no failover until a 2nd key is added", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY", "A");
    expect(vendorReach("finnhub")).toEqual({ kind: "local", reachable: true, failover: null });
  });

  it("counts a 2nd Finnhub key as rotation", () => {
    vi.stubEnv("VITE_FINNHUB_API_KEY", "A");
    vi.stubEnv("VITE_FINNHUB_API_KEY_2", "B");
    expect(vendorReach("finnhub")).toMatchObject({ kind: "local", reachable: true });
    expect(vendorReach("finnhub").failover).toMatch(/2 keys/);
  });

  it("reports a local FMP / Alpaca key", () => {
    vi.stubEnv("VITE_FMP_API_KEY", "F");
    vi.stubEnv("VITE_ALPACA_API_KEY", "K");
    vi.stubEnv("VITE_ALPACA_API_SECRET", "S");
    expect(vendorReach("fmp")).toMatchObject({ kind: "local", reachable: true });
    expect(vendorReach("alpaca")).toMatchObject({ kind: "local", reachable: true });
  });

  it("reports the research proxy as the operator's own server with a backup model", () => {
    vi.stubEnv("VITE_RESEARCH_PROXY_URL", "https://agent.example.dev");
    const r = vendorReach("proxy");
    expect(r).toMatchObject({ kind: "server", reachable: true });
    expect(r.failover).toMatch(/[Bb]ackup/);
  });
});

describe("vendorReach — keyless public endpoints", () => {
  it("are always reachable with no key concept and no failover", () => {
    for (const id of ["yahoo", "sec", "stocktwits", "apewisdom"] as const) {
      expect(vendorReach(id)).toEqual({ kind: "local", reachable: true, failover: null });
    }
  });
});
