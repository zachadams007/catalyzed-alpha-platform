import { afterEach, describe, it, expect, vi } from "vitest";

/**
 * A-1 - a LIVE Finnhub-quoted company must carry NO real fundamentals at
 * construction. Previously `fetchFinnhubCompany` returned `{ ...synthetic }`,
 * leaking the synthetic PRNG fundamentals block (netMargin, epsGrowthYoY, …) as
 * if it were live data until - and only IF - a later enrichment stage overwrote
 * it. The fix initializes every fundamental to a neutral placeholder gated OFF
 * by an all-false availability map.
 */

vi.mock("@/data/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/data/http")>();
  return {
    ...actual,
    finnhubKey: vi.fn(() => "test-key"),
    httpJson: vi.fn(),
  };
});

import { finnhubKey, httpJson } from "@/data/http";
import { fetchFinnhubCompany } from "@/data/finnhub/liveCompany";

const mockedHttp = vi.mocked(httpJson);
const mockedKey = vi.mocked(finnhubKey);

afterEach(() => vi.clearAllMocks());

describe("fetchFinnhubCompany — no synthetic fundamentals leak (A-1)", () => {
  it("returns a quoted company with all fundamentals flagged unavailable", async () => {
    mockedKey.mockReturnValue("test-key");
    // quote first, profile second (Promise.all order in the impl).
    mockedHttp
      .mockResolvedValueOnce({ c: 25.5, d: 0.5, dp: 2.0, pc: 25.0 } as never)
      .mockResolvedValueOnce({
        name: "SoFi Technologies Inc",
        marketCapitalization: 25000, // $25B (Finnhub reports millions)
        finnhubIndustry: "Financial Services",
        exchange: "NASDAQ",
        ticker: "SOFI",
      } as never);

    const company = await fetchFinnhubCompany("SOFI");
    expect(company).not.toBeNull();
    if (!company) return;

    // Real, live fields are present…
    expect(company.price).toBe(25.5);
    expect(company.name).toBe("SoFi Technologies Inc");

    // …but EVERY fundamental is explicitly unavailable - nothing real yet.
    const av = company.fundamentalsAvailability ?? {};
    for (const flag of Object.values(av)) expect(flag).toBe(false);
    expect(av.netMargin).toBe(false);
    expect(av.epsGrowthYoY).toBe(false);

    // The placeholder values are inert (not the synthetic PRNG seed range).
    expect(company.fundamentals.netMargin).toBe(0);
    expect(company.fundamentals.epsGrowthYoY).toBe(0);
    expect(company.fundamentals.peRatio).toBeNull();
  });
});
