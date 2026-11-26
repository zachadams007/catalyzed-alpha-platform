import { describe, expect, it } from "vitest";

import type { CompanyData } from "@/types";
import type { CatalystEvent } from "@/data/catalysts/catalystEvent";
import type { InsiderAggregate } from "@/data/catalysts/insiderClusterCatalysts";
import { foldCatalystEventsAcrossUniverse } from "@/data/catalysts/enrichCatalystEvents";

/**
 * Integration test for the PURE cross-universe fold: real catalyst events +
 * insider aggregates land on the right companies (and only them), proving the
 * end-to-end bridge from structured filings into CompanyData before scoring.
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

function company(ticker: string, over: Partial<CompanyData> = {}): CompanyData {
  return {
    ticker,
    name: ticker,
    catalyst: over.catalyst ?? { type: "Earnings", description: "modeled", daysAway: 30, magnitude: 0.3 },
    catalystLive: over.catalystLive ?? false,
    secActivity: over.secActivity,
    sources: over.sources ?? [],
  } as unknown as CompanyData;
}

describe("foldCatalystEventsAcrossUniverse", () => {
  it("folds events + aggregates onto matching tickers, leaves others untouched", () => {
    const universe = [company("AAA"), company("BBB"), company("CCC")];
    const events: CatalystEvent[] = [
      {
        ticker: "AAA",
        catalystType: "M&A",
        date: "2026-06-16",
        summary: "8-K Item 2.01: Acquisition",
        sourceUrl: "https://sec.gov/aaa",
        magnitude: 0.85,
        strength: 0.8,
      },
      // duplicate of the same filing - must be deduped away
      {
        ticker: "AAA",
        catalystType: "M&A",
        date: "2026-06-16",
        summary: "dup",
        sourceUrl: "https://sec.gov/aaa",
        magnitude: 0.85,
        strength: 0.8,
      },
    ];
    const aggregates = new Map<string, InsiderAggregate>([
      ["BBB", { buyCount: 3, sellCount: 0, netValue: 2_000_000 }],
    ]);

    const res = foldCatalystEventsAcrossUniverse(universe, events, aggregates, { now: NOW });

    // The passed AAA event is deduped to 1; the always-present executive political
    // seed is also surfaced, so the only AAA-passed event present is unique.
    expect(res.events.filter((e) => e.ticker === "AAA")).toHaveLength(1); // deduped
    expect(res.enrichedCount).toBe(2); // AAA (catalyst) + BBB (aggregate)

    const [aaa, bbb, ccc] = res.companies;
    expect(aaa!.catalyst.type).toBe("M&A");
    expect(aaa!.catalystLive).toBe(true);
    expect(aaa!.sources[0]?.url).toBe("https://sec.gov/aaa");

    expect(bbb!.secActivity!.form4BuyCount90d).toBe(3);
    expect(bbb!.secActivity!.form4NetBuyValue90d).toBe(2_000_000);
    expect(bbb!.catalyst.type).toBe("Earnings"); // no catalyst event for BBB

    // None of AAA/BBB/CCC carry an executive signal, so CCC is still the untouched
    // input reference (the executive applier returns the same object when no match).
    expect(ccc).toBe(universe[2]); // untouched reference
  });

  it("folds a favorable Presidential signal into a named ticker (catalyst + executiveSignal)", () => {
    // LLY is in the real executive seed (disclosed Q1 buy + a favorable callout).
    const universe = [company("LLY"), company("ZZZ")];
    const res = foldCatalystEventsAcrossUniverse(universe, [], new Map(), { now: NOW });

    const [lly, zzz] = res.companies;
    // The favorable executive item is the strongest catalyst → folds into catalyst.
    expect(lly!.catalyst.type).toBe("Political");
    expect(lly!.catalystLive).toBe(true);
    // The direction-aware summary is attached for the engine + the badge.
    expect(lly!.executiveSignal?.favorable).toBeTruthy();
    expect(["bullish", "mixed"]).toContain(lly!.executiveSignal?.direction);
    // A name with no executive signal is left as the untouched input reference.
    expect(zzz).toBe(universe[1]);
    expect(zzz!.executiveSignal).toBeUndefined();
  });

  it("attaches an ADVERSE Presidential signal without folding it as a positive catalyst", () => {
    // The adverse path is fed by the discovery engine now (the static seed went
    // favorable-only on 2026-06-25 once the ABBV/REGN tariff-holdout claims aged
    // into falsehood). A bearish political callout → adverse_callout (bearish).
    const universe = [company("ZADV")];
    const discovered = {
      generatedAt: "2026-06-18T00:00:00.000Z",
      catalysts: [
        {
          ticker: "ZADV",
          company: "Test Adverse Co",
          headline: "Administration threatened a 100% tariff on ZADV",
          actor: "Trump administration",
          role: "President",
          direction: "bearish" as const,
          date: "2026-06-17",
          importance: 70,
          kind: "political",
          url: "https://example.com/zadv",
        },
      ],
    };
    const res = foldCatalystEventsAcrossUniverse(universe, [], new Map(), { now: NOW, discovered });

    const [co] = res.companies;
    expect(co!.executiveSignal?.adverse).toBeTruthy();
    expect(co!.executiveSignal?.direction).toBe("bearish");
    // Adverse items are NEGATIVE catalyst events, so they never fold in as the
    // (positive) `catalyst` - the modeled Earnings catalyst is untouched.
    expect(co!.catalyst.type).toBe("Earnings");
  });

  it("weighs a DISCOVERED political callout in scoring — no hardcoding needed", () => {
    // A ticker NOT in the static seed: it only surfaces because the discovery
    // engine found a fresh presidential callout. Proves the autonomous path feeds
    // BOTH the executiveSignal (direction-aware tilt) AND CompanyData.catalyst.
    const universe = [company("ZZTOP")];
    const discovered = {
      generatedAt: "2026-06-18T00:00:00.000Z",
      catalysts: [
        {
          ticker: "ZZTOP",
          company: "ZZ Top Corp",
          headline: "President praised ZZ Top's new US plant at a rally",
          actor: "President Trump",
          role: "President",
          direction: "bullish" as const,
          date: "2026-06-17",
          importance: 80,
          kind: "political",
          url: "https://example.com/zztop",
        },
      ],
    };
    const res = foldCatalystEventsAcrossUniverse(universe, [], new Map(), { now: NOW, discovered });

    const [zz] = res.companies;
    expect(zz!.executiveSignal?.favorable).toBeTruthy();
    expect(zz!.executiveSignal?.direction).toBe("bullish");
    expect(zz!.catalyst.type).toBe("Political");
    expect(zz!.catalystLive).toBe(true);
  });

  it("folds a DISCOVERED non-political catalyst (insider buy) into CompanyData.catalyst", () => {
    const universe = [company("NEWCO")];
    const discovered = {
      generatedAt: "2026-06-18T00:00:00.000Z",
      catalysts: [
        {
          ticker: "NEWCO",
          company: "New Co",
          headline: "CEO bought 1,000,000 shares on the open market",
          actor: "CEO Jane Doe",
          role: "CEO",
          direction: "bullish" as const,
          date: "2026-06-17",
          importance: 75,
          kind: "insider_buy",
          url: "https://example.com/newco-form4",
        },
      ],
    };
    const res = foldCatalystEventsAcrossUniverse(universe, [], new Map(), { now: NOW, discovered });
    const [nc] = res.companies;
    expect(nc!.catalyst.type).toBe("Insider");
    expect(nc!.catalystLive).toBe(true);
    expect(nc!.sources[0]?.url).toBe("https://example.com/newco-form4");
  });
});
