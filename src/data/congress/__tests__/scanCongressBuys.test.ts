import { describe, expect, it } from "vitest";

import {
  attachCongressBuys,
  enrichScanUniverseWithCongressBuys,
  mapCongressBuysAcrossUniverse,
  recentOpenMarketBuys,
} from "@/data/congress/scanCongressBuys";
import { smartMoneyCatalystBoost } from "@/engine/smartMoney";
import type { CompanyData, CongressTrade } from "@/types";

// ---------------------------------------------------------------------------
// Fixtures. A fixed reference clock keeps the recency window deterministic:
// NOW = 2026-06-17 UTC, so the default 120-day cutoff is exactly 2026-02-17.
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 5, 17); // 2026-06-17
const CUTOFF_DATE = "2026-02-17"; // NOW − 120 days, to the day
const RECENT = "2026-05-01";
const STALE = "2026-01-01"; // before the cutoff

function buy(transactionDate: string, over: Partial<CongressTrade> = {}): CongressTrade {
  return {
    representative: "Hon. Test Filer",
    chamber: "House",
    transaction: "buy",
    amountRange: "$1,001 - $15,000",
    transactionDate,
    ...over,
  };
}

function sell(transactionDate: string): CongressTrade {
  return { ...buy(transactionDate), transaction: "sell" };
}

function exchange(transactionDate: string): CongressTrade {
  return { ...buy(transactionDate), transaction: "exchange" };
}

// The scan-path mapping only reads `ticker` and writes `congressTrades`; a
// minimal cast keeps these tests focused on the mapping contract itself.
function company(ticker: string): CompanyData {
  return { ticker } as CompanyData;
}

function indexOf(entries: Record<string, CongressTrade[]>): Map<string, CongressTrade[]> {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// recentOpenMarketBuys
// ---------------------------------------------------------------------------

describe("recentOpenMarketBuys", () => {
  it("returns [] for undefined or empty input", () => {
    expect(recentOpenMarketBuys(undefined, { now: NOW })).toEqual([]);
    expect(recentOpenMarketBuys([], { now: NOW })).toEqual([]);
  });

  it("keeps buys and drops sells and exchanges", () => {
    const result = recentOpenMarketBuys(
      [buy(RECENT), sell(RECENT), exchange(RECENT)],
      { now: NOW },
    );
    expect(result).toHaveLength(1);
    expect(result.every((t) => t.transaction === "buy")).toBe(true);
  });

  it("drops buys older than the lookback window", () => {
    const result = recentOpenMarketBuys([buy(STALE), buy(RECENT)], { now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.transactionDate).toBe(RECENT);
  });

  it("keeps a buy dated exactly on the cutoff boundary (inclusive)", () => {
    const result = recentOpenMarketBuys([buy(CUTOFF_DATE)], { now: NOW });
    expect(result).toHaveLength(1);
  });

  it("drops a buy dated one day before the cutoff", () => {
    expect(recentOpenMarketBuys([buy("2026-02-16")], { now: NOW })).toHaveLength(0);
  });

  it("sorts the kept buys newest-first", () => {
    const result = recentOpenMarketBuys(
      [buy("2026-03-01"), buy("2026-05-20"), buy("2026-04-10")],
      { now: NOW },
    );
    expect(result.map((t) => t.transactionDate)).toEqual([
      "2026-05-20",
      "2026-04-10",
      "2026-03-01",
    ]);
  });

  it("caps the list to maxPerCompany (keeping the newest)", () => {
    const trades = [buy("2026-06-01"), buy("2026-05-01"), buy("2026-04-01"), buy("2026-03-01")];
    const result = recentOpenMarketBuys(trades, { now: NOW, maxPerCompany: 2 });
    expect(result.map((t) => t.transactionDate)).toEqual(["2026-06-01", "2026-05-01"]);
  });

  it("honors a custom lookback window", () => {
    // A 30-day window from 2026-06-17 excludes a 2026-05-01 buy (47 days back).
    expect(recentOpenMarketBuys([buy("2026-05-01")], { now: NOW, lookbackDays: 30 })).toHaveLength(0);
    expect(recentOpenMarketBuys([buy("2026-06-10")], { now: NOW, lookbackDays: 30 })).toHaveLength(1);
  });

  it("ignores trades with an unparseable date", () => {
    expect(recentOpenMarketBuys([buy("not-a-date")], { now: NOW })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// attachCongressBuys
// ---------------------------------------------------------------------------

describe("attachCongressBuys", () => {
  it("returns the SAME reference when there are no qualifying buys", () => {
    const c = company("AAA");
    expect(attachCongressBuys(c, [sell(RECENT)], { now: NOW })).toBe(c);
    expect(attachCongressBuys(c, [buy(STALE)], { now: NOW })).toBe(c);
    expect(attachCongressBuys(c, undefined, { now: NOW })).toBe(c);
  });

  it("attaches only the recent buys when present (immutably)", () => {
    const c = company("AAA");
    const out = attachCongressBuys(c, [buy(RECENT), sell(RECENT), buy(STALE)], { now: NOW });
    expect(out).not.toBe(c);
    expect(out.congressTrades).toHaveLength(1);
    expect(out.congressTrades![0]!.transaction).toBe("buy");
    expect(out.congressTrades![0]!.transactionDate).toBe(RECENT);
  });

  it("does not mutate the input company", () => {
    const c = company("AAA");
    const snapshot = JSON.stringify(c);
    attachCongressBuys(c, [buy(RECENT)], { now: NOW });
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// mapCongressBuysAcrossUniverse
// ---------------------------------------------------------------------------

describe("mapCongressBuysAcrossUniverse", () => {
  it("attaches to matching tickers and leaves others untouched", () => {
    const companies = [company("AAA"), company("BBB"), company("CCC")];
    const index = indexOf({ AAA: [buy(RECENT)], CCC: [buy(RECENT)] });
    const { companies: out, enrichedCount } = mapCongressBuysAcrossUniverse(companies, index, {
      now: NOW,
    });
    expect(enrichedCount).toBe(2);
    expect(out[0]!.congressTrades).toHaveLength(1);
    expect(out[1]).toBe(companies[1]); // BBB had no entry → unchanged reference
    expect(out[2]!.congressTrades).toHaveLength(1);
  });

  it("does not count a ticker whose only disclosed trades are stale/sells", () => {
    const companies = [company("AAA")];
    const index = indexOf({ AAA: [sell(RECENT), buy(STALE)] });
    const { companies: out, enrichedCount } = mapCongressBuysAcrossUniverse(companies, index, {
      now: NOW,
    });
    expect(enrichedCount).toBe(0);
    expect(out[0]).toBe(companies[0]);
  });

  it("matches tickers case-insensitively and trimmed", () => {
    const companies = [company("  aaa  ")];
    const index = indexOf({ AAA: [buy(RECENT)] });
    const { companies: out, enrichedCount } = mapCongressBuysAcrossUniverse(companies, index, {
      now: NOW,
    });
    expect(enrichedCount).toBe(1);
    expect(out[0]!.congressTrades).toHaveLength(1);
  });

  it("respects the maxCompanies cap, passing the rest through untouched", () => {
    const companies = [company("AAA"), company("BBB"), company("CCC")];
    const index = indexOf({ AAA: [buy(RECENT)], BBB: [buy(RECENT)], CCC: [buy(RECENT)] });
    const { companies: out, enrichedCount } = mapCongressBuysAcrossUniverse(companies, index, {
      now: NOW,
      maxCompanies: 1,
    });
    expect(enrichedCount).toBe(1);
    expect(out[0]!.congressTrades).toHaveLength(1);
    expect(out[1]).toBe(companies[1]);
    expect(out[2]).toBe(companies[2]);
  });

  it("counts attachments, not iterations, toward the cap", () => {
    // AAA has no entry, so it must not consume the single allotted slot - BBB does.
    const companies = [company("AAA"), company("BBB"), company("CCC")];
    const index = indexOf({ BBB: [buy(RECENT)], CCC: [buy(RECENT)] });
    const { companies: out, enrichedCount } = mapCongressBuysAcrossUniverse(companies, index, {
      now: NOW,
      maxCompanies: 1,
    });
    expect(enrichedCount).toBe(1);
    expect(out[0]).toBe(companies[0]); // AAA untouched (no entry)
    expect(out[1]!.congressTrades).toHaveLength(1); // BBB enriched
    expect(out[2]).toBe(companies[2]); // CCC capped out
  });

  it("returns everything unchanged for an empty index", () => {
    const companies = [company("AAA"), company("BBB")];
    const { companies: out, enrichedCount } = mapCongressBuysAcrossUniverse(
      companies,
      new Map(),
      { now: NOW },
    );
    expect(enrichedCount).toBe(0);
    expect(out[0]).toBe(companies[0]);
    expect(out[1]).toBe(companies[1]);
  });
});

// ---------------------------------------------------------------------------
// The payoff: the mapping actually lights up the smart-money boost, and the
// recency gate prevents a stale disclosure from boosting a name today.
// ---------------------------------------------------------------------------

describe("scan-path mapping → smart-money boost", () => {
  it("makes the bounded congress boost fire on a mapped name", () => {
    const plain = company("AAA");
    const mapped = attachCongressBuys(plain, [buy(RECENT), buy("2026-04-15")], { now: NOW });
    expect(smartMoneyCatalystBoost(plain).points).toBe(0);
    expect(smartMoneyCatalystBoost(mapped).points).toBeGreaterThan(0);
    expect(smartMoneyCatalystBoost(mapped).congress).toBeGreaterThan(0);
  });

  it("keeps the boost at zero when the only disclosed buys are stale", () => {
    const mapped = attachCongressBuys(company("AAA"), [buy(STALE), buy("2025-06-01")], { now: NOW });
    expect(mapped.congressTrades).toBeUndefined();
    expect(smartMoneyCatalystBoost(mapped).points).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enrichScanUniverseWithCongressBuys - only the no-I/O early-return guard
// (the dataset fetch is not exercised in unit tests; it degrades silently).
// ---------------------------------------------------------------------------

describe("enrichScanUniverseWithCongressBuys", () => {
  it("short-circuits an empty universe without touching the network", async () => {
    const result = await enrichScanUniverseWithCongressBuys([]);
    expect(result).toEqual({ companies: [], enrichedCount: 0 });
  });
});
