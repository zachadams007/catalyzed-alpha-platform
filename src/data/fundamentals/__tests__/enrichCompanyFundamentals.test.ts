import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyData } from "@/types";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import {
  allFalseFundamentalsAvailability,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";

/**
 * C-3 - per-name resilience in the universe fundamentals enrichment loop.
 *
 * One ticker's `fetchFinnhubMetrics` throwing (timeout / network / parse) must
 * NOT abort the whole universe enrichment. The loop catches per-name and merges
 * `null`, which `applyLiveFundamentalsToCompany` turns into all-false
 * availability ("N/A") - never a fabricated number. This mirrors the existing
 * per-name guards in enrichCompanyNews / enrichCompanyHistory and removes the
 * cross-file dependency on `fetchFinnhubMetrics`'s own internal catch.
 */

// Mock the live-fundamentals module: a controllable fetch + the real apply
// (re-exported via vi.importActual so the merge logic under assertion is real).
const fetchFinnhubMetrics =
  vi.fn<(symbol: string) => Promise<{ metric?: Record<string, number>; asOf?: string } | null>>();

vi.mock("@/data/finnhub/liveFundamentals", async () => {
  const actual = await vi.importActual<typeof import("@/data/finnhub/liveFundamentals")>(
    "@/data/finnhub/liveFundamentals",
  );
  return {
    ...actual,
    fetchFinnhubMetrics: (symbol: string) => fetchFinnhubMetrics(symbol),
  };
});

function liveCompany(ticker: string, overrides: Partial<CompanyData> = {}): CompanyData {
  return {
    ...buildSyntheticCompany(ticker),
    ticker,
    marketCap: 5e10,
    price: 100,
    fundamentals: unknownFundamentals(),
    fundamentalsAvailability: allFalseFundamentalsAvailability(),
    ...overrides,
  };
}

const FRESH_ASOF = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

afterEach(() => {
  vi.useRealTimers();
  fetchFinnhubMetrics.mockReset();
});

describe("enrichUniverseWithLiveFundamentals — per-name fault isolation (C-3)", () => {
  it("completes the loop when one ticker's metric fetch rejects, flagging that name all-false", async () => {
    vi.useFakeTimers();
    const { enrichUniverseWithLiveFundamentals } = await import(
      "@/data/fundamentals/enrichCompanyFundamentals"
    );

    fetchFinnhubMetrics.mockImplementation(async (symbol: string) => {
      if (symbol === "BOOM") throw new Error("Finnhub timeout for BOOM");
      // src: a real, fresh net margin for the healthy names so they flip available.
      return { metric: { netProfitMarginTTM: 15.0 }, asOf: FRESH_ASOF };
    });

    const companies = [liveCompany("AAA"), liveCompany("BOOM"), liveCompany("ZZZ")];
    const promise = enrichUniverseWithLiveFundamentals(companies);
    // The loop sleeps GAP_MS (320ms) between names; advance well past the two
    // gaps so each awaited delay resolves (runAllTimersAsync trips the infinite-
    // loop guard because the next gap is scheduled only after the prior resolves).
    await vi.advanceTimersByTimeAsync(2_000);
    const out = await promise;

    // The whole universe came back - the throw didn't abort the loop.
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.ticker)).toEqual(["AAA", "BOOM", "ZZZ"]);

    // The failing name carries all-false availability (honest N/A), no fabrication.
    const boom = out.find((c) => c.ticker === "BOOM")!;
    expect(Object.values(boom.fundamentalsAvailability ?? {}).every((v) => v === false)).toBe(true);

    // The healthy names still got their real value through.
    const aaa = out.find((c) => c.ticker === "AAA")!;
    expect(aaa.fundamentalsAvailability?.netMargin).toBe(true);
    expect(fetchFinnhubMetrics).toHaveBeenCalledTimes(3);
  });
});
