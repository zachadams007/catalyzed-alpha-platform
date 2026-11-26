import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Control sample-data mode directly (it defaults ON, which would force every
// queryable gate off). Spread the real module so other exports stay intact.
vi.mock("@/data/providers/sampleDataMode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/data/providers/sampleDataMode")>();
  return { ...actual, isSampleDataModeEnabled: vi.fn(() => false) };
});

import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { isFmpQueryable, isFinnhubQueryable } from "@/data/http";

const sampleMock = isSampleDataModeEnabled as unknown as Mock;

// Neutralize the real .env so a local key can't leak in and make this flaky.
const ENV_KEYS = ["VITE_FMP_API_KEY", "VITE_FINNHUB_API_KEY", "VITE_MARKET_PROXY_URL"];

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, "");
  sampleMock.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("isFmpQueryable / isFinnhubQueryable — proxy-aware Phase-2/3 gates", () => {
  it("are false when neither a local key nor a proxy is configured", () => {
    expect(isFmpQueryable()).toBe(false);
    expect(isFinnhubQueryable()).toBe(false);
  });

  it("are true with a local vendor key (desktop / dev path)", () => {
    vi.stubEnv("VITE_FMP_API_KEY", "fmp-key");
    vi.stubEnv("VITE_FINNHUB_API_KEY", "finnhub-key");
    expect(isFmpQueryable()).toBe(true);
    expect(isFinnhubQueryable()).toBe(true);
  });

  it("are true with ONLY the hosted proxy configured (keyless web/phone path)", () => {
    // The exact failure this fixes: a prod web build ships no vendor key, but the
    // proxy injects it - so movers/earnings must still be considered reachable.
    vi.stubEnv("VITE_MARKET_PROXY_URL", "https://proxy.example.dev");
    expect(isFmpQueryable()).toBe(true);
    expect(isFinnhubQueryable()).toBe(true);
  });

  it("are forced false in sample-data mode even with a key AND a proxy", () => {
    vi.stubEnv("VITE_FMP_API_KEY", "fmp-key");
    vi.stubEnv("VITE_MARKET_PROXY_URL", "https://proxy.example.dev");
    sampleMock.mockReturnValue(true);
    expect(isFmpQueryable()).toBe(false);
    expect(isFinnhubQueryable()).toBe(false);
  });
});
