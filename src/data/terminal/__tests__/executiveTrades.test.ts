import { describe, expect, it } from "vitest";

import {
  type ExecutiveItem,
  EXECUTIVE_ITEMS,
  executiveCatalystEvents,
  executiveSignalSummaries,
  executiveSignalTickers,
  executiveSignalsForTicker,
  executiveTradeTerminalEvents,
  isAdverse,
  isFavorable,
} from "@/data/terminal/executiveTrades";

/**
 * Synthetic adverse item - mirrors what the daily catalyst-discovery engine
 * feeds at runtime. The static seed is FAVORABLE-ONLY after the 2026-06-25
 * data-quality pass (the ABBV/REGN tariff-holdout items went stale once both
 * signed MFN deals), so the adverse-direction paths are exercised via injection.
 */
const ADVERSE_ITEM: ExecutiveItem = {
  ticker: "ZADV",
  companyName: "Test Adverse Co.",
  kind: "adverse_callout",
  actor: "Trump administration",
  date: "2026-06-20",
  summary: "Administration threatened a 100% tariff on ZADV — a bearish policy threat.",
  magnitude: 0.5,
  sourceUrl: "https://example.com/adverse",
  sourceLabel: "Test source",
};

/**
 * Guards on the REAL, sourced executive-branch political seed: every item traces
 * to a source URL, direction is correct (adverse = bearish), the projections are
 * pure + consistent, and a fabricated callout (ROK - no source found) is absent.
 */

const NOW = Date.parse("2026-06-24T00:00:00.000Z");

describe("executiveTrades — data integrity", () => {
  it("every seeded item has a real source URL, a date, and a 0..1 magnitude", () => {
    expect(EXECUTIVE_ITEMS.length).toBeGreaterThan(0);
    for (const item of EXECUTIVE_ITEMS) {
      expect(item.ticker).toMatch(/^[A-Z.]{1,6}$/);
      expect(item.sourceUrl).toMatch(/^https?:\/\//);
      expect(item.sourceLabel.length).toBeGreaterThan(0);
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.magnitude).toBeGreaterThan(0);
      expect(item.magnitude).toBeLessThanOrEqual(1);
      expect(item.summary.length).toBeGreaterThan(10);
    }
  });

  it("does NOT contain a Rockwell Automation (ROK) callout (no source confirmed it)", () => {
    // Hard rule: never fabricate a catalyst. A 2026 search found no confirmation
    // that the President called out Rockwell Automation, so ROK must stay absent.
    expect(executiveSignalTickers()).not.toContain("ROK");
    expect(EXECUTIVE_ITEMS.some((i) => i.ticker === "ROK")).toBe(false);
  });

  it("classifies favorable vs adverse direction correctly", () => {
    expect(isFavorable("buy")).toBe(true);
    expect(isFavorable("favorable_callout")).toBe(true);
    expect(isAdverse("sell")).toBe(true);
    expect(isAdverse("adverse_callout")).toBe(true);
    // A tariff/probe item must be bearish, never favorable.
    expect(isFavorable("adverse_callout")).toBe(false);
    expect(isAdverse("buy")).toBe(false);
  });
});

describe("executiveSignalsForTicker — per-ticker rollup", () => {
  it("returns null for a name with no Presidential signal", () => {
    expect(executiveSignalsForTicker("ZZZZ")).toBeNull();
    expect(executiveSignalsForTicker(undefined)).toBeNull();
  });

  it("rolls a disclosed BUY + favorable callout into a bullish summary (LLY)", () => {
    const s = executiveSignalsForTicker("lly"); // case-insensitive
    expect(s).not.toBeNull();
    expect(s!.ticker).toBe("LLY");
    expect(s!.favorable).toBeTruthy();
    expect(["bullish", "mixed"]).toContain(s!.direction);
  });

  it("marks an adverse-only name bearish (direction read off an injected adverse item)", () => {
    // Seed is favorable-only post-2026-06-25; the adverse rollup is validated via
    // an injected item - the same path the discovery engine feeds at runtime.
    const s = executiveSignalSummaries(NOW, [ADVERSE_ITEM]).get("ZADV");
    expect(s).toBeTruthy();
    expect(s!.direction).toBe("bearish");
    expect(s!.adverse).toBeTruthy();
    expect(s!.favorable).toBeUndefined();
  });

  it("the static seed is favorable-only (no stale adverse political claims)", () => {
    expect(EXECUTIVE_ITEMS.length).toBeGreaterThan(0);
    expect(EXECUTIVE_ITEMS.every((i) => isFavorable(i.kind))).toBe(true);
  });
});

describe("executiveCatalystEvents — scoring projection", () => {
  it("emits Political events with the SIGN set by direction", () => {
    const events = executiveCatalystEvents(NOW);
    expect(events.length).toBe(EXECUTIVE_ITEMS.length);
    for (const ev of events) {
      expect(ev.catalystType).toBe("Political");
      expect(ev.sourceUrl).toMatch(/^https?:\/\//);
    }
    // Sign is set by direction: favorable items are non-negative, adverse ones
    // negative. (A favorable item's recency-scaled `strength` can be 0 once it is
    // stale - e.g. the Feb-10 disclosed buys - but it is never NEGATIVE.)
    for (const ev of events) {
      const item = EXECUTIVE_ITEMS.find((i) => i.ticker === ev.ticker && i.summary === ev.summary)!;
      if (isAdverse(item.kind)) {
        expect(ev.negative).toBe(true);
        expect(ev.strength).toBeLessThanOrEqual(0);
      } else {
        expect(ev.negative).toBeFalsy();
        expect(ev.strength).toBeGreaterThanOrEqual(0);
      }
    }

    // The canonical FRESH favorable callouts (LLY + NOK, 2026-06-23) carry a real
    // positive strength. The adverse SIGN is validated on an injected item (the
    // seed is favorable-only post-2026-06-25; runtime adverse items come from the
    // discovery engine).
    const llyCallout = events.find((e) => e.ticker === "LLY" && e.date === "2026-06-23");
    expect(llyCallout!.strength).toBeGreaterThan(0);

    const zadv = executiveCatalystEvents(NOW, [ADVERSE_ITEM]).find((e) => e.ticker === "ZADV");
    expect(zadv!.negative).toBe(true);
    expect(zadv!.strength).toBeLessThan(0);
  });

  it("is deterministic for a fixed clock (pure)", () => {
    expect(executiveCatalystEvents(NOW)).toEqual(executiveCatalystEvents(NOW));
  });
});

describe("executiveSignalSummaries — recency-stamped scoring map", () => {
  it("pre-computes daysAway on each item so the scorer stays clock-free", () => {
    const map = executiveSignalSummaries(NOW);
    const lly = map.get("LLY");
    expect(lly?.favorable?.daysAway).toBeTypeOf("number");
    // The Feb-10 disclosed buy is well in the past → negative daysAway.
    const now = map.get("NOW");
    expect(now?.favorable?.daysAway).toBeLessThan(0);
  });
});

describe("executiveTradeTerminalEvents — wire projection", () => {
  it("maps favorable → buy tone, with a real source link on every wire event", () => {
    const events = executiveTradeTerminalEvents();
    expect(events.length).toBe(EXECUTIVE_ITEMS.length);
    const fav = events.find((e) => e.id.includes("NOW"));
    expect(fav!.trade?.direction).toBe("buy");
    // Seed is favorable-only post-2026-06-25 → every wire event is buy-tone.
    for (const e of events) {
      expect(e.trade?.direction).toBe("buy");
      expect(e.source.url).toMatch(/^https?:\/\//);
      expect(e.kind).toBe("politician_trade");
    }
  });
});
