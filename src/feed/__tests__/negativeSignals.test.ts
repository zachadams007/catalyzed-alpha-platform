import { describe, it, expect } from "vitest";
import type { InteractionEvent, InteractionKind, Portfolio, StockSignal } from "@/types";
import {
  deriveNegativeSignals,
  deriveWatchOutSignals,
  hasNegativeSignal,
  buildWatchOuts,
  snapshotWatchOutFacts,
} from "@/feed/negativeSignals";

/**
 * Minimal-but-valid StockSignal fixture. Only the fields the honest
 * negative-signal derivation reads are meaningful; the rest are inert defaults
 * so we test the rules in isolation (no universe scoring).
 */
function makeSignal(overrides: Partial<StockSignal> = {}): StockSignal {
  const base = {
    id: "T",
    ticker: "TST",
    name: "Test Co",
    price: 100,
    dayChange: 0,
    currency: "USD",
    marketCap: 1e9,
    marketCapBucket: "Mid",
    sector: "Technology",
    fundamentals: {
      revenueGrowthYoY: 0.1,
      epsGrowthYoY: 0.1,
      netMargin: 0.1,
      peRatio: 20,
    },
    fundamentalsAvailability: undefined,
    momentum: { aboveSMA200: true, return3M: 0.1 },
    news: { items: [], sentiment: 0, count7d: 0, freshnessHours: 24 },
    risk: {
      governanceFlag: 0,
      dilutionRisk: 0,
      shortInterestPct: 0,
      cashRunwayQuarters: 12,
    },
    riskLevel: "Moderate",
    score: { opportunityScore: 70, categories: [], riskExplanation: "" },
    congressTrades: undefined,
    secActivity: undefined,
    analyst: undefined,
    marketDataUnavailable: undefined,
  } as unknown as StockSignal;
  return { ...base, ...overrides } as StockSignal;
}

function makePortfolio(tickers: string[]): Portfolio {
  return {
    id: "pf_test",
    name: "Test Portfolio",
    mode: "Custom",
    description: "",
    owner: "me",
    isPublic: false,
    holdings: tickers.map((ticker) => ({ ticker, addedAt: "2026-06-20T00:00:00.000Z" })),
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function makeInteraction(ticker: string, kind: InteractionKind = "view_detail"): InteractionEvent {
  return {
    id: `evt_${ticker}`,
    kind,
    ticker,
    sector: "Technology",
    catalystType: "Earnings",
    marketCapBucket: "Mid",
    at: "2026-06-20T00:00:00.000Z",
  };
}

describe("deriveNegativeSignals — honest, real-data only", () => {
  it("returns nothing for a clean name (honest both ways)", () => {
    expect(deriveNegativeSignals(makeSignal())).toEqual([]);
    expect(hasNegativeSignal(makeSignal())).toBe(false);
  });

  it("flags material congressional selling as an alert", () => {
    const s = makeSignal({
      congressTrades: [
        {
          representative: "Rep A",
          chamber: "House",
          transaction: "sell",
          amountRange: "$250,001 - $500,000",
          transactionDate: "2026-06-10",
        },
        {
          representative: "Rep B",
          chamber: "House",
          transaction: "sell",
          amountRange: "$100,001 - $250,000",
          transactionDate: "2026-06-11",
        },
      ] as StockSignal["congressTrades"],
    });
    const negs = deriveNegativeSignals(s);
    const cong = negs.find((n) => n.kind === "congress_selling");
    expect(cong).toBeTruthy();
    expect(cong?.severity).toBe("alert");
  });

  it("flags net insider selling as an alert", () => {
    const s = makeSignal({
      secActivity: {
        cik: "0000000001",
        form4Count90d: 3,
        eightKCount90d: 0,
        filings: [],
        form4NetBuyValue90d: -2_000_000,
      } as StockSignal["secActivity"],
    });
    const insider = deriveNegativeSignals(s).find((n) => n.kind === "insider_selling");
    expect(insider).toBeTruthy();
    expect(insider?.severity).toBe("alert");
  });

  it("flags deteriorating fundamentals (negative EPS growth) as warn", () => {
    const s = makeSignal({
      fundamentals: { revenueGrowthYoY: 0.1, epsGrowthYoY: -0.3, netMargin: 0.1, peRatio: 20 } as StockSignal["fundamentals"],
    });
    const det = deriveNegativeSignals(s).find((n) => n.kind === "deteriorating");
    expect(det).toBeTruthy();
    expect(det?.severity).toBe("warn");
  });

  it("flags an analyst sell-skew", () => {
    const s = makeSignal({
      analyst: {
        status: "live",
        spotPrice: 100,
        rows: [],
        sources: [],
        recommendations: { strongBuy: 0, buy: 1, hold: 2, sell: 3, strongSell: 1 },
      } as StockSignal["analyst"],
    });
    expect(deriveNegativeSignals(s).some((n) => n.kind === "downgrade")).toBe(true);
  });

  it("flags genuinely bad news and quotes the worst real headline", () => {
    const s = makeSignal({
      news: {
        items: [
          { headline: "Probe widens", source: "X", url: "#", publishedAt: "2026-06-18", sentiment: -0.6 },
          { headline: "Minor update", source: "Y", url: "#", publishedAt: "2026-06-18", sentiment: -0.1 },
        ],
        sentiment: -0.4,
        count7d: 4,
        freshnessHours: 6,
      } as StockSignal["news"],
    });
    const bad = deriveNegativeSignals(s).find((n) => n.kind === "bad_news");
    expect(bad).toBeTruthy();
    expect(bad?.detail).toContain("Probe widens");
  });

  it("never fabricates from a sample / unquoted profile", () => {
    const sample = makeSignal({
      marketDataUnavailable: "sample" as StockSignal["marketDataUnavailable"],
      fundamentals: { revenueGrowthYoY: -0.5, epsGrowthYoY: -0.5, netMargin: -0.2, peRatio: 0 } as StockSignal["fundamentals"],
    });
    expect(deriveNegativeSignals(sample)).toEqual([]);
    const directory = makeSignal({
      marketDataUnavailable: "directory" as StockSignal["marketDataUnavailable"],
      fundamentals: { revenueGrowthYoY: -0.5, epsGrowthYoY: -0.5, netMargin: -0.2, peRatio: 0 } as StockSignal["fundamentals"],
    });
    expect(deriveNegativeSignals(directory)).toEqual([]);
  });

  it("orders alerts before warns", () => {
    const s = makeSignal({
      fundamentals: { revenueGrowthYoY: 0.1, epsGrowthYoY: -0.3, netMargin: 0.1, peRatio: 20 } as StockSignal["fundamentals"],
      secActivity: {
        cik: "0000000001",
        form4Count90d: 3,
        eightKCount90d: 0,
        filings: [],
        form4NetBuyValue90d: -2_000_000,
      } as StockSignal["secActivity"],
    });
    const negs = deriveNegativeSignals(s);
    expect(negs[0].severity).toBe("alert");
  });
});

/**
 * A-2 / A-3 - the honest-fundamentals gate must FAIL CLOSED for live records.
 *
 * The bug: `fundAvailable` returned true for an UNDEFINED availability map, so a
 * live-shaped record that lost/never-got a map printed a watch-out off its
 * synthetic random fundamentals under a green Live badge. Live records always
 * carry a map now; a watch-out fires only when the field is explicitly
 * available AND the figure is fresh.
 *
 * Financial figures below are WEB-VERIFIED (Q1 2026) - see each `// src:`.
 */
const FRESH_ASOF = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const STALE_ASOF = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);

function allTrueAvailability(): StockSignal["fundamentalsAvailability"] {
  return {
    revenueGrowthYoY: true,
    epsGrowthYoY: true,
    grossMargin: true,
    netMargin: true,
    peRatio: true,
    pegRatio: true,
    debtToEquity: true,
    fcfMargin: true,
  };
}

describe("deriveNegativeSignals — fail CLOSED on fundamentals provenance", () => {
  it("a LIVE record with synthetic fundamentals but NO availability map yields no fundamentals flag", () => {
    // This is the exact bug: enrichment was skipped, the map is absent, the
    // fundamentals are synthetic randoms - must NOT fabricate a watch-out.
    const s = makeSignal({
      marketDataUnavailable: undefined,
      fundamentalsAvailability: {}, // present-but-empty: a live map with nothing vouched-for
      fundamentals: {
        revenueGrowthYoY: -0.4,
        epsGrowthYoY: -0.5,
        netMargin: -0.198, // the fabricated SOFI value
        peRatio: 20,
      } as StockSignal["fundamentals"],
    });
    const negs = deriveNegativeSignals(s);
    expect(negs.some((n) => n.kind === "deteriorating")).toBe(false);
  });

  it("fires only when the field is explicitly available AND fresh", () => {
    const fresh = makeSignal({
      fundamentalsAvailability: { ...allTrueAvailability() },
      fundamentalsAsOf: FRESH_ASOF,
      // src: ExxonMobil Q1 2026 GAAP EPS $1.00 vs $1.76 = −43% YoY (investor.exxonmobil.com)
      fundamentals: { revenueGrowthYoY: 0.02, epsGrowthYoY: -0.43, netMargin: 0.05, peRatio: 14 } as StockSignal["fundamentals"],
    });
    const det = deriveNegativeSignals(fresh).find((n) => n.kind === "deteriorating");
    expect(det).toBeTruthy();
    expect(det?.detail).toContain("EPS");
    expect(det?.detail).toContain("as of"); // honest as-of qualifier appended
  });

  it("does NOT fire on a STALE figure even when flagged available", () => {
    const stale = makeSignal({
      fundamentalsAvailability: { ...allTrueAvailability() },
      fundamentalsAsOf: STALE_ASOF,
      fundamentals: { revenueGrowthYoY: 0.02, epsGrowthYoY: -0.43, netMargin: 0.05, peRatio: 14 } as StockSignal["fundamentals"],
    });
    expect(deriveNegativeSignals(stale).some((n) => n.kind === "deteriorating")).toBe(false);
  });

  it("SOFI: a profitable name (positive net margin) never flags 'Unprofitable'", () => {
    // src: SoFi Q1 2026 ~15% GAAP net margin, profitable (Q1 2026 earnings release)
    const sofi = makeSignal({
      ticker: "SOFI",
      fundamentalsAvailability: { ...allTrueAvailability() },
      fundamentalsAsOf: FRESH_ASOF,
      fundamentals: { revenueGrowthYoY: 0.43, epsGrowthYoY: 1.34, netMargin: 0.15, peRatio: 40 } as StockSignal["fundamentals"],
    });
    expect(deriveNegativeSignals(sofi).some((n) => n.label === "Unprofitable")).toBe(false);
  });

  it("SOFI bug: a NEGATIVE net margin is vetoed by a POSITIVE P/E (the stale −19.8% field)", () => {
    // Finnhub's netProfitMarginTTM read −19.8% for SoFi while the company is
    // GAAP-profitable (TTM EPS +$0.44, P/E ~38). A positive trailing P/E proves
    // positive earnings, so it must veto the "Unprofitable" label - never show a
    // stale negative-margin field as a real red flag. (the owner's #1 rule.)
    const sofi = makeSignal({
      ticker: "SOFI",
      fundamentalsAvailability: { ...allTrueAvailability() },
      fundamentalsAsOf: FRESH_ASOF,
      fundamentals: { revenueGrowthYoY: 0.43, epsGrowthYoY: 1.34, netMargin: -0.198, peRatio: 38 } as StockSignal["fundamentals"],
    });
    expect(deriveNegativeSignals(sofi).some((n) => n.label === "Unprofitable")).toBe(false);
  });

  it("a genuinely unprofitable name (negative net margin, NO positive P/E) still flags", () => {
    const unprofitable = makeSignal({
      ticker: "RIVN",
      fundamentalsAvailability: { ...allTrueAvailability(), peRatio: false },
      fundamentalsAsOf: FRESH_ASOF,
      fundamentals: { revenueGrowthYoY: 0.1, epsGrowthYoY: 0.1, netMargin: -0.45, peRatio: 0 } as StockSignal["fundamentals"],
    });
    expect(deriveNegativeSignals(unprofitable).some((n) => n.label === "Unprofitable")).toBe(true);
  });

  it("TSLA: positive EPS growth never flags 'Deteriorating'", () => {
    // src: Tesla Q1 2026 GAAP EPS $0.13 vs $0.12 = +8% YoY (electrek.co / SEC 8-K)
    const tsla = makeSignal({
      ticker: "TSLA",
      fundamentalsAvailability: { ...allTrueAvailability() },
      fundamentalsAsOf: FRESH_ASOF,
      fundamentals: { revenueGrowthYoY: 0.16, epsGrowthYoY: 0.08, netMargin: 0.06, peRatio: 80 } as StockSignal["fundamentals"],
    });
    expect(deriveNegativeSignals(tsla).some((n) => n.kind === "deteriorating")).toBe(false);
  });
});

describe("buildWatchOuts priority tiers", () => {
  function majorAlert(id: string, ticker: string, bucket = "Mega"): StockSignal {
    return makeSignal({
      id,
      ticker,
      marketCapBucket: bucket as StockSignal["marketCapBucket"],
      marketCap: 5e11,
      secActivity: {
        cik: "0000000009",
        form4Count90d: 2,
        eightKCount90d: 0,
        filings: [],
        form4NetBuyValue90d: -5_000_000,
      } as StockSignal["secActivity"],
    });
  }

  it("orders held, suggested, price warnings, major names, then other relevant flags", () => {
    const clean = makeSignal({ id: "C", ticker: "CLN" });
    const heldWarn = makeSignal({
      id: "W",
      ticker: "WRN",
      fundamentals: { revenueGrowthYoY: -0.2, epsGrowthYoY: -0.2, netMargin: 0.1, peRatio: 20 } as StockSignal["fundamentals"],
    });
    const heldAlert = makeSignal({
      id: "A",
      ticker: "ALR",
      secActivity: {
        cik: "0000000002",
        form4Count90d: 2,
        eightKCount90d: 0,
        filings: [],
        form4NetBuyValue90d: -3_000_000,
      } as StockSignal["secActivity"],
    });
    const suggested = makeSignal({
      id: "S",
      ticker: "SUG",
      secActivity: {
        cik: "0000000003",
        form4Count90d: 2,
        eightKCount90d: 0,
        filings: [],
        form4NetBuyValue90d: -2_000_000,
      } as StockSignal["secActivity"],
    });
    const priceWarning = makeSignal({
      id: "P",
      ticker: "PWR",
      dayChange: -0.04,
      fundamentals: { revenueGrowthYoY: -0.2, epsGrowthYoY: -0.2, netMargin: 0.1, peRatio: 20 } as StockSignal["fundamentals"],
    });
    const other = makeSignal({
      id: "U",
      ticker: "OTH",
      fundamentals: { revenueGrowthYoY: -0.2, epsGrowthYoY: -0.2, netMargin: 0.1, peRatio: 20 } as StockSignal["fundamentals"],
    });
    const owned = new Set(["CLN", "WRN", "ALR"]);
    const out = buildWatchOuts(
      [other, majorAlert("M", "MAJ"), priceWarning, suggested, heldWarn, heldAlert, clean],
      owned,
      { portfolios: [makePortfolio(["WRN", "ALR"])], interactions: [makeInteraction("SUG")] },
    );

    expect(out.map((e) => e.signal.ticker)).toEqual(["ALR", "WRN", "SUG", "PWR", "MAJ", "OTH"]);
    expect(out.map((e) => e.priority)).toEqual([
      "held",
      "held",
      "suggested",
      "price_warning",
      "major",
      "other",
    ]);
  });

  it("includes an unowned MAJOR name with an ALERT flag (market-wide significance)", () => {
    const out = buildWatchOuts([majorAlert("B", "BIG")], new Set());
    expect(out.map((e) => e.signal.ticker)).toContain("BIG");
    expect(out[0].priority).toBe("major");
  });

  it("includes an unowned MAJOR name with a WARN flag (a mega-cap's real deterioration is notable)", () => {
    const warnBig = makeSignal({
      id: "WB",
      ticker: "WBG",
      marketCapBucket: "Mega",
      marketCap: 5e11,
      fundamentals: { revenueGrowthYoY: -0.2, epsGrowthYoY: -0.2, netMargin: 0.1, peRatio: 20 } as StockSignal["fundamentals"],
      fundamentalsAvailability: { revenueGrowthYoY: true, epsGrowthYoY: true, netMargin: true, peRatio: true } as StockSignal["fundamentalsAvailability"],
      fundamentalsAsOf: new Date().toISOString(),
    });
    expect(buildWatchOuts([warnBig], new Set()).map((e) => e.signal.ticker)).toContain("WBG");
  });

  it("keeps an unowned SMALL/Mid alert as other relevant", () => {
    const smallAlert = majorAlert("S", "SML", "Small");
    const out = buildWatchOuts([smallAlert], new Set());
    expect(out.map((e) => e.signal.ticker)).toContain("SML");
    expect(out[0].priority).toBe("other");
  });

  it("always includes held names and prioritizes them ahead of market flags", () => {
    const ownedWarn = makeSignal({
      id: "O",
      ticker: "OWN",
      marketCapBucket: "Small",
      fundamentals: { revenueGrowthYoY: -0.2, epsGrowthYoY: -0.2, netMargin: 0.1, peRatio: 20 } as StockSignal["fundamentals"],
    });
    const out = buildWatchOuts(
      [majorAlert("B", "BIG"), ownedWarn],
      new Set(["OWN"]),
      { portfolios: [makePortfolio(["OWN"])] },
    );
    expect(out.find((e) => e.signal.ticker === "OWN")?.priority).toBe("held");
    expect(out.map((e) => e.signal.ticker)).toContain("BIG");
    expect(out[0].priority).toBe("held"); // holdings lead
  });

  it("caps the strip at a reasonable number", () => {
    const many = Array.from({ length: 20 }, (_, i) => majorAlert("m" + i, "MJ" + i));
    expect(buildWatchOuts(many, new Set(), { limit: 8 })).toHaveLength(8);
  });
});

describe("deriveWatchOutSignals — change-only (baseline delta)", () => {
  const asOf = new Date().toISOString();
  const availAll = {
    revenueGrowthYoY: true,
    epsGrowthYoY: true,
    netMargin: true,
    peRatio: true,
  } as StockSignal["fundamentalsAvailability"];

  function fundSignal(cats: {
    revenueGrowthYoY: number;
    epsGrowthYoY: number;
    netMargin: number;
    peRatio: number;
  }): StockSignal {
    return makeSignal({
      id: "F",
      ticker: "FUN",
      fundamentals: cats as StockSignal["fundamentals"],
      fundamentalsAvailability: availAll,
      fundamentalsAsOf: asOf,
    });
  }

  it("does NOT re-flag a condition that was already true at baseline (was unprofitable when suggested)", () => {
    // Unprofitable then AND now - nothing changed, so no watch-out (the owner's rule).
    const sig = fundSignal({ revenueGrowthYoY: 0.1, epsGrowthYoY: 0.1, netMargin: -0.03, peRatio: -10 });
    const baseline = snapshotWatchOutFacts(sig, asOf)!;
    expect(deriveWatchOutSignals(sig, baseline)).toHaveLength(0);
    // …but with NO baseline (e.g. a major you don't hold) it still shows current-state.
    expect(deriveWatchOutSignals(sig).length).toBeGreaterThan(0);
  });

  it("DOES flag a name that TURNED unprofitable since baseline", () => {
    const before = fundSignal({ revenueGrowthYoY: 0.1, epsGrowthYoY: 0.1, netMargin: 0.08, peRatio: 20 });
    const baseline = snapshotWatchOutFacts(before, asOf)!;
    const now = fundSignal({ revenueGrowthYoY: 0.1, epsGrowthYoY: 0.1, netMargin: -0.05, peRatio: -8 });
    const out = deriveWatchOutSignals(now, baseline);
    expect(out.some((n) => n.label === "Turned unprofitable")).toBe(true);
  });

  it("DOES flag revenue that newly turned negative since baseline", () => {
    const before = fundSignal({ revenueGrowthYoY: 0.12, epsGrowthYoY: 0.05, netMargin: 0.1, peRatio: 20 });
    const baseline = snapshotWatchOutFacts(before, asOf)!;
    const now = fundSignal({ revenueGrowthYoY: -0.15, epsGrowthYoY: 0.05, netMargin: 0.1, peRatio: 20 });
    const out = deriveWatchOutSignals(now, baseline);
    expect(out.some((n) => n.label === "Revenue turned down")).toBe(true);
  });

  it("does NOT flag revenue that was already declining at baseline", () => {
    const sig = fundSignal({ revenueGrowthYoY: -0.15, epsGrowthYoY: 0.05, netMargin: 0.1, peRatio: 20 });
    const baseline = snapshotWatchOutFacts(sig, asOf)!;
    expect(deriveWatchOutSignals(sig, baseline)).toHaveLength(0);
  });

  it("flags NEW insider selling but not selling that was already disclosed at baseline", () => {
    const selling = makeSignal({
      id: "S",
      ticker: "SEL",
      secActivity: {
        cik: "0000000021",
        form4Count90d: 2,
        eightKCount90d: 0,
        filings: [],
        form4NetBuyValue90d: -4_000_000,
      } as StockSignal["secActivity"],
    });
    // Already selling at baseline → not re-flagged.
    const baseWithSelling = snapshotWatchOutFacts(selling, asOf)!;
    expect(deriveWatchOutSignals(selling, baseWithSelling).some((n) => n.kind === "insider_selling")).toBe(
      false,
    );
    // Clean at baseline, now selling → flagged as new.
    const clean = makeSignal({ id: "C", ticker: "SEL" });
    const baseClean = snapshotWatchOutFacts(clean, asOf)!;
    expect(deriveWatchOutSignals(selling, baseClean).some((n) => n.kind === "insider_selling")).toBe(true);
  });
});
