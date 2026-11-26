import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// Lane W3-A - DATA & NARRATIVE INTEGRITY.
// The #1 deploy blocker: an uncovered ticker (e.g. GCU.TO, a copper miner) must
// render ONLY real fields or "unavailable" - never seeded-random sector /
// catalyst / P/E / archetype / narrative presented as if it were live.

// Force live-vs-sample mode deterministically (node test env has no window).
vi.mock("@/data/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/data/http")>();
  return { ...actual, finnhubKey: vi.fn(() => undefined as string | undefined) };
});

// Simulate "live key configured, provider returns no quote" (the GCU.TO reality).
vi.mock("@/data/finnhub/liveCompany", () => ({
  fetchFinnhubCompany: vi.fn(async () => null),
}));

import { finnhubKey } from "@/data/http";
import { companyForTickerAsync } from "@/data/companyLookup";
import { lookupSignalAsync } from "@/engine/lookupSignal";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import { applyLiveFundamentalsToCompany } from "@/data/finnhub/liveFundamentals";
import { computeHype } from "@/engine/hype";
import { isMarketDataUnavailable, isSampleProfile } from "@/lib/marketData";
import type { CompanyData, ScoreBreakdown } from "@/types";

const mockedKey = vi.mocked(finnhubKey);

beforeEach(() => mockedKey.mockReturnValue(undefined));
afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// (a) Synthetic / directory data is NEVER presented as live.
// ---------------------------------------------------------------------------
describe("(a) synthetic never presented as live", () => {
  it("flags an uncovered real listing as directory (no live market data)", async () => {
    mockedKey.mockReturnValue("test-key"); // live mode, but the quote fetch returns null
    const company = await companyForTickerAsync("GCU.TO");
    expect(company.marketDataUnavailable).toBe("directory");
    expect(isMarketDataUnavailable(company)).toBe(true);
    // Real directory name, never a synthetic placeholder.
    expect(company.name).not.toMatch(/sample|holdings \(sample\)/i);
  });

  it("flags a keyless unknown-ticker lookup as a clearly-labeled sample", async () => {
    mockedKey.mockReturnValue(undefined); // sample mode
    const company = await companyForTickerAsync("ZQWXTEST");
    expect(company.marketDataUnavailable).toBe("sample");
    expect(isSampleProfile(company)).toBe(true);
  });

  it("does not narrate a directory lookup as 'driven by price action'", async () => {
    mockedKey.mockReturnValue("test-key");
    const signal = await lookupSignalAsync("GCU.TO");
    expect(signal.thesis).not.toMatch(/driven by price action/i);
    expect(signal.thesis).toMatch(/no live market data|unavailable/i);
  });
});

// ---------------------------------------------------------------------------
// (b) Price-derived fields are suppressed when there's no price.
// ---------------------------------------------------------------------------
describe("(b) price-derived fields suppressed when price missing", () => {
  it("suppresses P/E, fundamentals, momentum and hype for a no-quote listing", async () => {
    mockedKey.mockReturnValue("test-key");
    const signal = await lookupSignalAsync("GCU.TO");

    // Price + market cap unavailable.
    expect(signal.price).toBe(0);
    expect(signal.marketCap).toBe(0);

    // No fabricated P/E - every fundamental is flagged unavailable → "N/A".
    expect(signal.fundamentalsAvailability?.peRatio).toBe(false);
    expect(signal.keyFundamentals.every((f) => f.value === "N/A")).toBe(true);

    // No price-action archetypes / attention read.
    expect(signal.momentumNote).toMatch(/unavailable/i);
    expect(signal.hype.drivers).toHaveLength(0);
    expect(signal.hype.tldr).toMatch(/unavailable/i);
  });

  it("computeHype returns no drivers when market data is unavailable", () => {
    const directory: CompanyData = {
      ...buildSyntheticCompany("GCU.TO"),
      marketDataUnavailable: "directory",
    };
    const hype = computeHype(directory, {} as ScoreBreakdown);
    expect(hype.drivers).toHaveLength(0);
    expect(hype.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Real fundamentals are sanity-bounded (the Bank-of-America 99% bug).
// ---------------------------------------------------------------------------
describe("(c) BofA-like metric is clamped / marked unavailable", () => {
  function withCap(marketCap: number): CompanyData {
    return { ...buildSyntheticCompany("TEST"), marketCap };
  }

  it("rejects an absurd +99% growth for a mega-cap (noisy quarterly-YoY artifact)", () => {
    const megabank = withCap(3e11); // mega-cap
    const enriched = applyLiveFundamentalsToCompany(megabank, {
      revenueGrowthQuarterlyYoy: 99, // 99% - no TTM available → the BofA bug
    });
    expect(enriched.fundamentalsAvailability?.revenueGrowthYoY).toBe(false);
  });

  it("keeps a legitimately hot +99% growth for a small-cap", () => {
    const smallCap = withCap(1.5e8); // micro/small-cap can genuinely run hot
    const enriched = applyLiveFundamentalsToCompany(smallCap, {
      revenueGrowthQuarterlyYoy: 99,
    });
    expect(enriched.fundamentalsAvailability?.revenueGrowthYoY).toBe(true);
    expect(enriched.fundamentals.revenueGrowthYoY).toBeCloseTo(0.99, 5);
  });

  it("marks a garbage P/E unavailable rather than showing it", () => {
    const company = withCap(5e10);
    const enriched = applyLiveFundamentalsToCompany(company, { peTTM: 50000 });
    expect(enriched.fundamentalsAvailability?.peRatio).toBe(false);
  });

  it("accepts an in-band P/E", () => {
    const company = withCap(5e10);
    const enriched = applyLiveFundamentalsToCompany(company, { peTTM: 18.4 });
    expect(enriched.fundamentalsAvailability?.peRatio).toBe(true);
    expect(enriched.fundamentals.peRatio).toBeCloseTo(18.4, 5);
  });
});

// ---------------------------------------------------------------------------
// Grammar fix (#5): a single hype driver reads "is", not "are".
// ---------------------------------------------------------------------------
describe("hype tldr subject–verb agreement", () => {
  it("uses singular 'is' when only one driver fires", () => {
    const company: CompanyData = {
      ...buildSyntheticCompany("ONE"),
      social: {
        redditMentions24h: 0,
        xMentions24h: 0,
        politicalMentions: 0,
        sentiment: 0,
        trendDelta: 0,
        summary: "",
      },
    };
    // Only the catalyst category is strong enough to surface as a driver.
    const breakdown = {
      categories: [
        { key: "catalyst", score: 55 },
        { key: "news", score: 0 },
        { key: "momentum", score: 0 },
        { key: "volatility", score: 0 },
      ],
    } as ScoreBreakdown;
    const hype = computeHype(company, breakdown);
    expect(hype.drivers).toHaveLength(1);
    // The tldr is now the strongest concrete driver's own punchline (the tier
    // badge conveys the heat) - leads with the catalyst, ends as a one-liner, and
    // never restates the old label+verb phrasing.
    expect(hype.tldr.toLowerCase()).toContain("catalyst");
    expect(hype.tldr).toMatch(/\.$/);
    expect(hype.tldr).not.toMatch(/the only thing stirring|heating it up/);
  });
});
