import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { YahooChart } from "@/data/prices/yahooChart";

// Force live-vs-sample mode deterministically (node test env has no window, so
// the real sample-mode default can't be steered by env alone).
vi.mock("@/data/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/data/http")>();
  return { ...actual, finnhubKey: vi.fn(() => undefined as string | undefined) };
});

// Simulate "live key configured, but the US-only provider returns no quote" (the
// GCU.TO reality on Finnhub's free tier) by making the live fetch return null.
vi.mock("@/data/finnhub/liveCompany", () => ({
  fetchFinnhubCompany: vi.fn(async () => null),
}));

// The keyless Yahoo coverage path - controlled per test.
vi.mock("@/data/prices/yahooChart", () => ({
  fetchYahooChart: vi.fn(async () => null as YahooChart | null),
}));

import { finnhubKey } from "@/data/http";
import { fetchYahooChart } from "@/data/prices/yahooChart";
import {
  companyForTickerAsync,
  DIRECTORY_SOURCE_LABEL,
  YAHOO_SOURCE_LABEL,
} from "@/data/companyLookup";
import { lookupSignalAsync } from "@/engine/lookupSignal";
import { getSymbol } from "@/data/symbols/symbolDirectory";

const mockedKey = vi.mocked(finnhubKey);
const mockedChart = vi.mocked(fetchYahooChart);

/** A realistic Yahoo chart result (≥30 closes so real momentum engages). */
function fakeChart(symbol: string, price: number, currency: string): YahooChart {
  const closes = Array.from({ length: 40 }, (_, i) => Number((price * (0.9 + i * 0.0025)).toFixed(4)));
  const series = closes.map((close, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, close }));
  return {
    meta: {
      symbol,
      currency,
      exchangeName: currency === "CAD" ? "TOR" : "NMS",
      fullExchangeName: currency === "CAD" ? "Toronto" : "NasdaqGS",
      instrumentType: "EQUITY",
      regularMarketPrice: price,
      // Deliberately STALE (a ~1-year-ago close, like Yahoo returns at range=1y):
      // the day-change must ignore this and use the series' prior daily close.
      chartPreviousClose: Number((price * 0.5).toFixed(4)),
      longName: getSymbol(symbol)?.name,
    },
    series,
    closes,
  };
}

beforeEach(() => {
  mockedKey.mockReturnValue(undefined);
  mockedChart.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("companyForTickerAsync — TSX coverage via Yahoo (the GCU.TO fix)", () => {
  beforeEach(() => mockedKey.mockReturnValue("test-key"));

  it("returns a REAL CAD quote + chart for a .TO listing the US provider misses", async () => {
    mockedChart.mockResolvedValue(fakeChart("GCU.TO", 0.43, "CAD"));
    const company = await companyForTickerAsync("GCU.TO");

    expect(company.ticker).toBe("GCU.TO");
    expect(company.price).toBeCloseTo(0.43, 4);
    expect(company.currency).toBe("CAD");
    expect(company.listingExchange).toBe("TSX");
    expect(company.listingCountry).toBe("CA");
    expect(company.priceSeries.length).toBeGreaterThan(30);
    expect(company.priceHistory.length).toBeGreaterThan(30);
    expect(company.sources[0]!.label).toBe(YAHOO_SOURCE_LABEL);
    expect(company.name).not.toMatch(/sample/i);
    // Day change is the prior-DAILY-close move, not the range's 1-year return,
    // even though the (stale) chartPreviousClose implies a +100% gain.
    expect(Math.abs(company.dayChange)).toBeLessThan(0.05);
  });

  it("marks market cap + fundamentals unavailable (never fabricated) on the Yahoo path", async () => {
    mockedChart.mockResolvedValue(fakeChart("GCU.TO", 0.43, "CAD"));
    const company = await companyForTickerAsync("GCU.TO");
    expect(company.marketCap).toBe(0);
    expect(Object.values(company.fundamentalsAvailability!).every((v) => v === false)).toBe(true);
  });

  it("resolves a bare base to the .TO listing (Zach typed plain 'GCU')", async () => {
    mockedChart.mockResolvedValue(fakeChart("GCU.TO", 0.43, "CAD"));
    const company = await companyForTickerAsync("GCU");
    expect(company.ticker).toBe("GCU.TO");
    expect(company.currency).toBe("CAD");
  });

  it("surfaces BOTH listings on a genuine cross-listing, primary = queried listing", async () => {
    mockedChart.mockResolvedValue(fakeChart("SHOP.TO", 154, "CAD"));
    const company = await companyForTickerAsync("SHOP.TO");
    expect(company.currency).toBe("CAD");
    const symbols = (company.crossListings ?? []).map((l) => l.symbol);
    expect(symbols).toContain("SHOP.TO");
    expect(symbols).toContain("SHOP");
    const primary = company.crossListings!.find((l) => l.isPrimary);
    expect(primary!.symbol).toBe("SHOP.TO");
  });
});

describe("companyForTickerAsync — honest unavailable when even Yahoo has nothing", () => {
  beforeEach(() => mockedKey.mockReturnValue("test-key"));

  it("falls back to a directory-backed card (price/fundamentals N/A), never synthetic", async () => {
    mockedChart.mockResolvedValue(null);
    const company = await companyForTickerAsync("GCU.TO");
    expect(company.ticker).toBe("GCU.TO");
    expect(company.name).toBe(getSymbol("GCU.TO")?.name);
    expect(company.price).toBe(0);
    expect(company.marketCap).toBe(0);
    expect(company.priceSeries).toEqual([]);
    expect(company.sources[0]!.label).toBe(DIRECTORY_SOURCE_LABEL);
    expect(Object.values(company.fundamentalsAvailability!).every((v) => v === false)).toBe(true);
  });
});

describe("lookupSignalAsync — honest provenance labeling", () => {
  it("labels a real Yahoo quote as 'yahoo' provenance with a live price", async () => {
    mockedKey.mockReturnValue("test-key");
    mockedChart.mockResolvedValue(fakeChart("GCU.TO", 0.43, "CAD"));
    const signal = await lookupSignalAsync("GCU.TO");
    expect(signal.isLookup).toBe(true);
    expect(signal.lookupProvenance).toBe("yahoo");
    expect(signal.price).toBeGreaterThan(0);
    expect(signal.currency).toBe("CAD");
  });

  it("labels a directory-backed quote-less lookup honestly (not synthetic/curated)", async () => {
    mockedKey.mockReturnValue("test-key");
    mockedChart.mockResolvedValue(null);
    const signal = await lookupSignalAsync("GCU.TO");

    expect(signal.isLookup).toBe(true);
    expect(signal.lookupProvenance).toBeUndefined();
    expect(signal.price).toBe(0);
    expect(signal.keyFundamentals.every((f) => f.value === "N/A")).toBe(true);
  });

  it("still labels a sample-mode ad-hoc unknown symbol as synthetic", async () => {
    mockedKey.mockReturnValue(undefined); // sample mode
    const signal = await lookupSignalAsync("ZQWXTEST");
    expect(signal.isLookup).toBe(true);
    expect(signal.lookupProvenance).toBe("synthetic");
    expect(signal.price).toBeGreaterThan(0);
  });
});
