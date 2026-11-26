import { describe, expect, it } from "vitest";

import type { CompanyData, RawCatalyst } from "@/types";
import {
  type CatalystEvent,
  daysAwayFrom,
  dedupeEvents,
  eventKey,
  eventStrength,
  foldCatalystEventIntoCompany,
  indexEventsByTicker,
  recencyFactor,
  strongestPositiveEvent,
} from "@/data/catalysts/catalystEvent";

/**
 * Unit tests for the catalyst-event SPINE: recency/strength math, dedupe, index,
 * and the fold into CompanyData.catalyst that bridges structured filings into the
 * scoring engine. Deterministic - every clock is injected.
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

function ev(over: Partial<CatalystEvent>): CatalystEvent {
  return {
    ticker: over.ticker ?? "AAA",
    catalystType: over.catalystType ?? "M&A",
    date: over.date ?? "2026-06-16",
    summary: over.summary ?? "event",
    sourceUrl: over.sourceUrl ?? "https://sec.gov/x",
    magnitude: over.magnitude ?? 0.6,
    strength: over.strength ?? 0.5,
    negative: over.negative,
  };
}

function company(over: Partial<CompanyData>): CompanyData {
  return {
    ticker: over.ticker ?? "AAA",
    name: over.name ?? "Alpha",
    catalyst: over.catalyst,
    catalystLive: over.catalystLive,
    sources: over.sources ?? [],
  } as unknown as CompanyData;
}

function cat(over: Partial<RawCatalyst>): RawCatalyst {
  return {
    type: over.type ?? "Earnings",
    description: over.description ?? "old",
    daysAway: over.daysAway ?? 5,
    magnitude: over.magnitude ?? 0.5,
  };
}

describe("daysAwayFrom — RawCatalyst sign convention", () => {
  it("is positive for upcoming, negative for past, 0 for malformed", () => {
    expect(daysAwayFrom("2026-06-22", NOW)).toBe(4); // upcoming
    expect(daysAwayFrom("2026-06-15", NOW)).toBe(-3); // already happened
    expect(daysAwayFrom("not-a-date", NOW)).toBe(0);
  });
});

describe("recencyFactor + eventStrength", () => {
  it("peaks near now and decays for far-future and stale", () => {
    expect(recencyFactor(0)).toBeCloseTo(1, 5);
    expect(recencyFactor(60)).toBeCloseTo(0, 5); // far upcoming
    expect(recencyFactor(-30)).toBeCloseTo(0, 5); // stale
    expect(recencyFactor(-3)).toBeGreaterThan(recencyFactor(-20));
  });

  it("scales magnitude by recency and negates for negative events", () => {
    const fresh = eventStrength(0.8, -3); // 3 days ago
    const stale = eventStrength(0.8, -25);
    expect(fresh).toBeGreaterThan(stale);
    expect(eventStrength(0.8, -3, true)).toBe(-fresh);
  });
});

describe("dedupeEvents + eventKey + index", () => {
  it("dedupes by source URL, then by ticker|type|date", () => {
    const a = ev({ sourceUrl: "https://sec.gov/1" });
    const b = ev({ sourceUrl: "https://sec.gov/1", summary: "dupe" });
    const c = ev({ sourceUrl: "", ticker: "BBB", date: "2026-06-16" });
    const d = ev({ sourceUrl: "", ticker: "BBB", date: "2026-06-16", summary: "dupe2" });
    const out = dedupeEvents([a, b, c, d]);
    expect(out).toHaveLength(2);
    expect(eventKey(c)).toBe("BBB|M&A|2026-06-16");
  });

  it("groups by uppercased ticker and drops tickerless events", () => {
    const idx = indexEventsByTicker([ev({ ticker: "aaa" }), ev({ ticker: "" })]);
    expect(idx.get("AAA")).toHaveLength(1);
    expect([...idx.keys()]).toEqual(["AAA"]);
  });
});

describe("strongestPositiveEvent", () => {
  it("ignores negative events and returns the max-strength positive one", () => {
    const weak = ev({ strength: 0.3 });
    const strong = ev({ strength: 0.7 });
    const sell = ev({ strength: -0.9, negative: true });
    expect(strongestPositiveEvent([weak, strong, sell])).toBe(strong);
    expect(strongestPositiveEvent([sell])).toBeNull();
  });
});

describe("foldCatalystEventIntoCompany", () => {
  it("a real, dated event overrides a MODELED placeholder of similar magnitude", () => {
    const c = company({ catalyst: cat({ magnitude: 0.5 }), catalystLive: false });
    const folded = foldCatalystEventIntoCompany(
      c,
      [ev({ catalystType: "M&A", magnitude: 0.45, date: "2026-06-16", summary: "8-K Item 2.01", strength: 0.4 })],
      { now: NOW },
    );
    expect(folded).not.toBe(c);
    expect(folded.catalystLive).toBe(true);
    expect(folded.catalyst.type).toBe("M&A");
    expect(folded.catalyst.daysAway).toBe(-2);
    expect(folded.sources[0]?.url).toBe("https://sec.gov/x");
  });

  it("does NOT override a stronger LIVE catalyst", () => {
    const c = company({ catalyst: cat({ magnitude: 0.85 }), catalystLive: true });
    const folded = foldCatalystEventIntoCompany(c, [ev({ magnitude: 0.55, strength: 0.5 })], { now: NOW });
    expect(folded).toBe(c); // unchanged reference
  });

  it("returns the same reference when there are no positive events", () => {
    const c = company({ catalyst: cat({ magnitude: 0.2 }) });
    expect(foldCatalystEventIntoCompany(c, [ev({ strength: -0.7, negative: true })], { now: NOW })).toBe(c);
    expect(foldCatalystEventIntoCompany(c, [], { now: NOW })).toBe(c);
    expect(foldCatalystEventIntoCompany(c, undefined, { now: NOW })).toBe(c);
  });
});
