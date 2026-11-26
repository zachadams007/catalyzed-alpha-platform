import { describe, expect, it } from "vitest";

import type { DiscoveredCatalyst, DiscoveredScan } from "@/data/terminal/discoveredCatalysts";
import {
  discoveredCatalystEvents,
  discoveredExecutiveItems,
  discoveredTerminalEvents,
  isPoliticalDiscovered,
} from "@/data/terminal/discoveredCatalysts";
import { isFavorable, isAdverse } from "@/data/terminal/executiveTrades";

/**
 * Unit tests for the DISCOVERED-catalyst projections - the live engine output
 * mapped into the SAME executive / catalyst / terminal shapes the static seed
 * uses, so discovered items flow through every surface unchanged. Pure; clock
 * injected. The #1 product rule (never fabricate, direction must be correct) is
 * asserted here.
 */

const NOW = Date.parse("2026-06-24T00:00:00.000Z");

function cat(over: Partial<DiscoveredCatalyst>): DiscoveredCatalyst {
  return {
    ticker: over.ticker ?? "NOK",
    company: over.company ?? "Nokia",
    headline: over.headline ?? "Trump spotlighted Nokia at a PA event",
    actor: over.actor ?? "President Trump",
    role: over.role ?? "President",
    direction: over.direction ?? "bullish",
    date: over.date ?? "2026-06-23",
    importance: over.importance ?? 70,
    kind: over.kind ?? "political",
    url: over.url ?? "https://finance.yahoo.com/nok",
  };
}

function scan(items: DiscoveredCatalyst[]): DiscoveredScan {
  return { catalysts: items, generatedAt: "2026-06-24T12:00:00.000Z" };
}

describe("discovered → executive items (political only)", () => {
  it("maps a favorable presidential CALLOUT to a favorable_callout ExecutiveItem", () => {
    const items = discoveredExecutiveItems(scan([cat({ kind: "political", direction: "bullish" })]));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("favorable_callout");
    expect(isFavorable(items[0].kind)).toBe(true);
    expect(items[0].ticker).toBe("NOK");
    expect(items[0].sourceUrl).toMatch(/^https?:\/\//);
    // magnitude is importance/100, bounded 0..1.
    expect(items[0].magnitude).toBeCloseTo(0.7, 5);
  });

  it("maps a disclosed political BUY (headline says 'bought') to kind=buy", () => {
    const items = discoveredExecutiveItems(
      scan([cat({ headline: "Sen. X disclosed buying 1,000 shares", role: "Congress", direction: "bullish" })]),
    );
    expect(items[0].kind).toBe("buy");
  });

  it("maps a tariff THREAT (bearish) to adverse_callout — direction is preserved", () => {
    const items = discoveredExecutiveItems(
      scan([cat({ ticker: "ABBV", headline: "Admin threatens 100% pharma tariff", direction: "bearish", kind: "political" })]),
    );
    expect(items[0].kind).toBe("adverse_callout");
    expect(isAdverse(items[0].kind)).toBe(true);
  });

  it("drops NON-political items from the executive projection", () => {
    const items = discoveredExecutiveItems(
      scan([cat({ kind: "insider_buy", role: "CEO" }), cat({ kind: "ma", role: "Company" })]),
    );
    expect(items).toHaveLength(0);
  });

  it("isPoliticalDiscovered only true for kind=political", () => {
    expect(isPoliticalDiscovered(cat({ kind: "political" }))).toBe(true);
    expect(isPoliticalDiscovered(cat({ kind: "insider_buy" }))).toBe(false);
  });
});

describe("discovered → scoring catalyst events", () => {
  it("maps each kind to the right CatalystType and sets the sign", () => {
    const events = discoveredCatalystEvents(
      scan([
        cat({ ticker: "GILD", kind: "fda", direction: "bullish" }),
        cat({ ticker: "APGE", kind: "ma", direction: "bullish" }),
        cat({ ticker: "PSEC", kind: "insider_buy", direction: "bullish" }),
        cat({ ticker: "XYZ", kind: "guidance", direction: "bearish" }),
        cat({ ticker: "BA", kind: "contract", direction: "bullish" }),
      ]),
      NOW,
    );
    const byTicker = Object.fromEntries(events.map((e) => [e.ticker, e]));
    expect(byTicker.GILD.catalystType).toBe("Regulatory");
    expect(byTicker.APGE.catalystType).toBe("M&A");
    expect(byTicker.PSEC.catalystType).toBe("Insider");
    expect(byTicker.XYZ.catalystType).toBe("Earnings");
    expect(byTicker.BA.catalystType).toBe("Partnership");
    // bearish guidance is a NEGATIVE event; bullish ones are positive.
    expect(byTicker.XYZ.negative).toBe(true);
    expect(byTicker.XYZ.strength).toBeLessThan(0);
    expect(byTicker.GILD.negative).toBe(false);
    expect(byTicker.GILD.strength).toBeGreaterThan(0);
  });

  it("returns [] for a null scan (fallback to the static seed)", () => {
    expect(discoveredCatalystEvents(null, NOW)).toEqual([]);
    expect(discoveredExecutiveItems(null)).toEqual([]);
    expect(discoveredTerminalEvents(null)).toEqual([]);
  });

  it("drops a low-materiality political/PR item (e.g. a donation announcement) even though it cites a $ figure", () => {
    const events = discoveredCatalystEvents(
      scan([
        cat({
          ticker: "XOM",
          kind: "political",
          headline: "$250M Trump Accounts donation announced",
          importance: 30, // below the 0.5 materiality floor, and not a hard type
        }),
      ]),
      NOW,
    );
    expect(events).toHaveLength(0);
  });

  it("keeps a political item when it clears the materiality floor", () => {
    const events = discoveredCatalystEvents(
      scan([cat({ ticker: "XOM", kind: "political", importance: 65 })]),
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0].catalystType).toBe("Political");
  });

  it("keeps a hard-typed event (M&A/FDA/contract/guidance) regardless of low importance", () => {
    const events = discoveredCatalystEvents(
      scan([
        cat({ ticker: "APGE", kind: "ma", importance: 10 }),
        cat({ ticker: "GILD", kind: "fda", importance: 10 }),
        cat({ ticker: "BA", kind: "contract", importance: 10 }),
      ]),
      NOW,
    );
    expect(events).toHaveLength(3);
  });
});

describe("discovered → terminal wire events", () => {
  it("maps political→politician_trade, insider→insider_buy, contract→gov_contract, ma→catalyst_news", () => {
    const events = discoveredTerminalEvents(
      scan([
        cat({ ticker: "NOK", kind: "political" }),
        cat({ ticker: "PSEC", kind: "insider_buy" }),
        cat({ ticker: "BA", kind: "contract" }),
        cat({ ticker: "APGE", kind: "ma" }),
      ]),
    );
    const byTicker = Object.fromEntries(events.map((e) => [e.ticker, e]));
    expect(byTicker.NOK.kind).toBe("politician_trade");
    expect(byTicker.PSEC.kind).toBe("insider_buy");
    expect(byTicker.BA.kind).toBe("gov_contract");
    expect(byTicker.APGE.kind).toBe("catalyst_news");
    // every wire event carries the real source URL.
    for (const e of events) expect(e.source.url).toMatch(/^https?:\/\//);
  });

  it("sets buy/sell trade direction on political + insider events from the catalyst direction", () => {
    const events = discoveredTerminalEvents(
      scan([
        cat({ ticker: "AMZN", kind: "political", direction: "bearish", headline: "Rep. sold AMZN" }),
        cat({ ticker: "PSEC", kind: "insider_buy", direction: "bullish" }),
      ]),
    );
    const byTicker = Object.fromEntries(events.map((e) => [e.ticker, e]));
    expect(byTicker.AMZN.trade?.direction).toBe("sell");
    expect(byTicker.PSEC.trade?.direction).toBe("buy");
  });

  it("higher importance → higher severity", () => {
    const [hi, lo] = discoveredTerminalEvents(
      scan([
        cat({ ticker: "A", importance: 90 }),
        cat({ ticker: "B", importance: 20 }),
      ]),
    );
    expect(hi.severity).toBe("high");
    expect(lo.severity).toBe("watch");
  });
});
