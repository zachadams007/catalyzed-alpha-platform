import { describe, expect, it } from "vitest";

import {
  type EightKInput,
  eightKToCatalystEvent,
  eightKsToCatalystEvents,
} from "@/data/catalysts/edgar8kCatalysts";

/**
 * Unit tests for the 8-K → catalyst mapper: item-code → CatalystType + materiality,
 * most-material-item selection, the "Item 1.01" prefix tolerance, negative-event
 * flagging, and skipping unscorable filings. Deterministic (clock injected).
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

function input(over: Partial<EightKInput>): EightKInput {
  return {
    ticker: over.ticker ?? "AAA",
    companyName: over.companyName ?? "Alpha Inc",
    items: over.items ?? ["1.01"],
    dateIso: over.dateIso ?? "2026-06-16",
    url: over.url ?? "https://www.sec.gov/x-index.htm",
  };
}

describe("eightKToCatalystEvent", () => {
  it("maps a material agreement (1.01) to a Partnership catalyst", () => {
    const e = eightKToCatalystEvent(input({ items: ["1.01", "9.01"] }), NOW)!;
    expect(e.catalystType).toBe("Partnership");
    expect(e.magnitude).toBe(0.55);
    expect(e.summary).toContain("Item 1.01");
    expect(e.negative).toBeUndefined();
    expect(e.strength).toBeGreaterThan(0);
  });

  it("picks the MOST material item when several are present", () => {
    // 2.01 (M&A, 0.85) outranks 2.02 (Earnings, 0.55) and 9.01 (skip).
    const e = eightKToCatalystEvent(input({ items: ["2.02", "9.01", "2.01"] }), NOW)!;
    expect(e.catalystType).toBe("M&A");
    expect(e.magnitude).toBe(0.85);
  });

  it("tolerates the 'Item X.XX' prefix form from the submissions API", () => {
    const e = eightKToCatalystEvent(input({ items: ["Item 1.03"] }), NOW)!;
    expect(e.catalystType).toBe("Regulatory");
    expect(e.negative).toBe(true); // bankruptcy
    expect(e.strength).toBeLessThan(0); // negative event ⇒ negative strength
  });

  it("flags a dilutive unregistered-equity sale (3.02) as negative", () => {
    const e = eightKToCatalystEvent(input({ items: ["3.02"] }), NOW)!;
    expect(e.negative).toBe(true);
    expect(e.strength).toBeLessThan(0);
  });

  it("returns null for exhibits-only (9.01) and for a missing ticker", () => {
    expect(eightKToCatalystEvent(input({ items: ["9.01"] }), NOW)).toBeNull();
    expect(eightKToCatalystEvent(input({ items: ["6.01"] }), NOW)).toBeNull();
    expect(eightKToCatalystEvent(input({ ticker: "", items: ["2.01"] }), NOW)).toBeNull();
  });

  it("dates the catalyst from the filing date (negative daysAway = already filed)", () => {
    const e = eightKToCatalystEvent(input({ dateIso: "2026-06-15", items: ["2.01"] }), NOW)!;
    // daysAway is encoded into strength via recency; a fresh 3-day-old filing is strong.
    expect(e.date).toBe("2026-06-15");
    expect(e.strength).toBeGreaterThan(0.6);
  });
});

describe("eightKsToCatalystEvents", () => {
  it("maps a batch and drops unscorable filings", () => {
    const out = eightKsToCatalystEvents(
      [input({ ticker: "AAA", items: ["2.01"] }), input({ ticker: "BBB", items: ["9.01"] })],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ticker).toBe("AAA");
  });
});
