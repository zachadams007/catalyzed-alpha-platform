import { describe, it, expect } from "vitest";

import {
  appendOutcomes,
  emptyLedger,
  summarizePerformance,
  updateForwardReturns,
  type OutcomeEntry,
  type OutcomeLedger,
} from "@/engine/outcomeLedger";
import type { ScoreCategory, StockSignal } from "@/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCategories(scores: Partial<Record<ScoreCategory["key"], number>>): ScoreCategory[] {
  return Object.entries(scores).map(([key, score]) => ({
    key: key as ScoreCategory["key"],
    label: key,
    score: score ?? 0,
    weight: 0.1,
    contribution: 0,
    explanation: "fixture",
  }));
}

/** Minimal StockSignal shaped exactly as appendOutcomes reads it. */
function makeSignal(
  ticker: string,
  opportunityScore: number,
  price: number,
  opts: { confidence?: number; name?: string; categories?: Partial<Record<ScoreCategory["key"], number>> } = {},
): StockSignal {
  const confidence = opts.confidence ?? 70;
  const fixture = {
    id: ticker,
    ticker,
    name: opts.name ?? `${ticker} Inc.`,
    price,
    confidence,
    score: {
      opportunityScore,
      confidence,
      confidenceExplanation: "fixture",
      riskPenalty: 0,
      riskExplanation: "fixture",
      categories: makeCategories(opts.categories ?? { momentum: opportunityScore }),
    },
  };
  return fixture as unknown as StockSignal;
}

/** Build a measured entry directly (for summarize tests). */
function makeEntry(
  ticker: string,
  opportunityScore: number,
  publishedAtISO: string,
  forwardReturns: OutcomeEntry["forwardReturns"] = {},
  priceAtPublish = 100,
): OutcomeEntry {
  return {
    ticker,
    name: `${ticker} Inc.`,
    publishedAtISO,
    opportunityScore,
    confidence: 70,
    categoryScores: { momentum: opportunityScore },
    priceAtPublish,
    forwardReturns,
  };
}

const DAY1 = "2026-01-01T16:00:00.000Z";
const DAY2 = "2026-01-02T16:00:00.000Z";

// ---------------------------------------------------------------------------
// appendOutcomes
// ---------------------------------------------------------------------------

describe("appendOutcomes", () => {
  it("appends one entry per published signal with the score snapshot", () => {
    const signals = [
      makeSignal("AAA", 82, 10, { categories: { momentum: 80, catalyst: 90 } }),
      makeSignal("BBB", 55, 25),
    ];
    const ledger = appendOutcomes(emptyLedger(), signals, DAY1);

    expect(ledger.entries).toHaveLength(2);
    const aaa = ledger.entries.find((e) => e.ticker === "AAA")!;
    expect(aaa.opportunityScore).toBe(82);
    expect(aaa.priceAtPublish).toBe(10);
    expect(aaa.publishedAtISO).toBe(DAY1);
    expect(aaa.categoryScores).toEqual({ momentum: 80, catalyst: 90 });
    expect(aaa.forwardReturns).toEqual({});
  });

  it("does not mutate the input ledger (pure)", () => {
    const start = emptyLedger();
    appendOutcomes(start, [makeSignal("AAA", 80, 10)], DAY1);
    expect(start.entries).toHaveLength(0);
  });

  it("dedupes by ticker + publish-day, but records the same ticker on a new day", () => {
    let ledger = appendOutcomes(emptyLedger(), [makeSignal("AAA", 80, 10)], DAY1);
    // Same ticker, same day → no duplicate.
    ledger = appendOutcomes(ledger, [makeSignal("AAA", 81, 11)], "2026-01-01T20:00:00.000Z");
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0].opportunityScore).toBe(80); // first write wins for the day

    // Same ticker, next day → a fresh entry.
    ledger = appendOutcomes(ledger, [makeSignal("AAA", 84, 12)], DAY2);
    expect(ledger.entries).toHaveLength(2);
  });

  it("skips signals with a non-positive price (nothing to measure)", () => {
    const ledger = appendOutcomes(
      emptyLedger(),
      [makeSignal("AAA", 80, 0), makeSignal("BBB", 70, -5), makeSignal("CCC", 60, 9)],
      DAY1,
    );
    expect(ledger.entries.map((e) => e.ticker)).toEqual(["CCC"]);
  });

  it("caps at maxEntries, keeps the most recent, and counts what was dropped", () => {
    let ledger = emptyLedger();
    // Day 1: 3 names.
    ledger = appendOutcomes(
      ledger,
      [makeSignal("AAA", 50, 10), makeSignal("BBB", 60, 10), makeSignal("CCC", 70, 10)],
      DAY1,
      { maxEntries: 4 },
    );
    // Day 2: 3 more → 6 total, cap 4 → drop the 2 oldest.
    ledger = appendOutcomes(
      ledger,
      [makeSignal("DDD", 55, 10), makeSignal("EEE", 65, 10), makeSignal("FFF", 75, 10)],
      DAY2,
      { maxEntries: 4 },
    );

    expect(ledger.entries).toHaveLength(4);
    expect(ledger.droppedCount).toBe(2);
    // All three day-2 names survive; only day-1 names were rotated out.
    const tickers = ledger.entries.map((e) => e.ticker);
    expect(tickers).toEqual(expect.arrayContaining(["DDD", "EEE", "FFF"]));
    expect(tickers.filter((t) => ["AAA", "BBB", "CCC"].includes(t))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateForwardReturns
// ---------------------------------------------------------------------------

describe("updateForwardReturns", () => {
  it("fills only the windows whose horizon has elapsed", () => {
    const ledger: OutcomeLedger = {
      schemaVersion: 1,
      droppedCount: 0,
      entries: [makeEntry("AAA", 80, DAY1, {}, 100)],
    };
    // 8 days later, price 110 → +10%. d7 elapsed, d30/d90 not.
    const eightDaysLater = "2026-01-09T16:00:00.000Z";
    const next = updateForwardReturns(ledger, [makeSignal("AAA", 80, 110)], eightDaysLater);

    expect(next.entries[0].forwardReturns.d7).toBeCloseTo(0.1, 5);
    expect(next.entries[0].forwardReturns.d30).toBeUndefined();
    expect(next.entries[0].forwardReturns.d90).toBeUndefined();
  });

  it("fills every elapsed window at once when the run is far in the future", () => {
    const ledger: OutcomeLedger = {
      schemaVersion: 1,
      droppedCount: 0,
      entries: [makeEntry("AAA", 80, DAY1, {}, 100)],
    };
    const hundredDaysLater = "2026-04-11T16:00:00.000Z";
    const next = updateForwardReturns(ledger, [makeSignal("AAA", 80, 150)], hundredDaysLater);

    expect(next.entries[0].forwardReturns.d7).toBeCloseTo(0.5, 5);
    expect(next.entries[0].forwardReturns.d30).toBeCloseTo(0.5, 5);
    expect(next.entries[0].forwardReturns.d90).toBeCloseTo(0.5, 5);
  });

  it("does not fill before the first window elapses", () => {
    const ledger: OutcomeLedger = {
      schemaVersion: 1,
      droppedCount: 0,
      entries: [makeEntry("AAA", 80, DAY1, {}, 100)],
    };
    const threeDaysLater = "2026-01-04T16:00:00.000Z";
    const next = updateForwardReturns(ledger, [makeSignal("AAA", 80, 110)], threeDaysLater);
    expect(next.entries[0].forwardReturns).toEqual({});
  });

  it("never overwrites an already-realized window (first read wins, no look-ahead churn)", () => {
    const ledger: OutcomeLedger = {
      schemaVersion: 1,
      droppedCount: 0,
      entries: [makeEntry("AAA", 80, DAY1, { d7: 0.1 }, 100)],
    };
    const eightDaysLater = "2026-01-09T16:00:00.000Z";
    // Price changed to 200 (+100%) but d7 is already locked at +10%.
    const next = updateForwardReturns(ledger, [makeSignal("AAA", 80, 200)], eightDaysLater);
    expect(next.entries[0].forwardReturns.d7).toBe(0.1);
  });

  it("leaves windows pending when no current price is available for the ticker", () => {
    const ledger: OutcomeLedger = {
      schemaVersion: 1,
      droppedCount: 0,
      entries: [makeEntry("AAA", 80, DAY1, {}, 100)],
    };
    const eightDaysLater = "2026-01-09T16:00:00.000Z";
    const next = updateForwardReturns(ledger, [makeSignal("ZZZ", 50, 40)], eightDaysLater);
    expect(next.entries[0].forwardReturns).toEqual({});
  });

  it("does not mutate the input ledger (pure)", () => {
    const ledger: OutcomeLedger = {
      schemaVersion: 1,
      droppedCount: 0,
      entries: [makeEntry("AAA", 80, DAY1, {}, 100)],
    };
    updateForwardReturns(ledger, [makeSignal("AAA", 80, 110)], "2026-01-09T16:00:00.000Z");
    expect(ledger.entries[0].forwardReturns).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// summarizePerformance
// ---------------------------------------------------------------------------

describe("summarizePerformance", () => {
  it("reports an honest empty state for a fresh ledger", () => {
    const summary = summarizePerformance(emptyLedger());
    expect(summary.totalTracked).toBe(0);
    expect(summary.measuredCount).toBe(0);
    expect(summary.byScoreDecile).toHaveLength(0);
    expect(summary.lowSample).toBe(true);
    expect(summary.coverageNote).toMatch(/starts recording on your next research run/i);
  });

  it("distinguishes tracked-but-unmeasured from measured", () => {
    const ledger: OutcomeLedger = {
      schemaVersion: 1,
      droppedCount: 0,
      entries: [makeEntry("AAA", 80, DAY1, {}), makeEntry("BBB", 60, DAY1, {})],
    };
    const summary = summarizePerformance(ledger);
    expect(summary.totalTracked).toBe(2);
    expect(summary.measuredCount).toBe(0);
    expect(summary.coverageNote).toMatch(/Forward returns appear once/i);
  });

  it("flags a small measured sample as not yet conclusive", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry(`T${i}`, 50 + i, DAY1, { d7: 0.01 * i }),
    );
    const summary = summarizePerformance({ schemaVersion: 1, droppedCount: 0, entries });
    expect(summary.measuredCount).toBe(5);
    expect(summary.lowSample).toBe(true);
    expect(summary.coverageNote).toMatch(/directional, not conclusive/i);
  });

  it("computes decile lift, hit rate, and highlights on the best-covered window", () => {
    // 100 entries: higher scores deliberately earn higher forward returns, so
    // the lift (top decile − bottom decile) must be strongly positive.
    const entries: OutcomeEntry[] = [];
    for (let i = 0; i < 100; i++) {
      const score = i; // 0..99
      const ret = (i - 50) / 100; // -0.50 .. +0.49, monotonic in score
      entries.push(makeEntry(`T${i}`, score, DAY1, { d7: ret }));
    }
    const summary = summarizePerformance({ schemaVersion: 1, droppedCount: 0, entries });

    expect(summary.primaryWindow).toBe("d7");
    expect(summary.measuredCount).toBe(100);
    expect(summary.byScoreDecile).toHaveLength(10);
    expect(summary.lowSample).toBe(false);

    const top = summary.byScoreDecile[9];
    const bottom = summary.byScoreDecile[0];
    expect(top.avgForwardReturn).toBeGreaterThan(bottom.avgForwardReturn);
    expect(summary.lift).toBeGreaterThan(0);
    expect(summary.lift).toBeCloseTo(top.avgForwardReturn - bottom.avgForwardReturn, 5);

    // Highlights: best hit is the highest-scoring name, worst miss the lowest.
    expect(summary.topHits[0].ticker).toBe("T99");
    expect(summary.worstMisses[0].ticker).toBe("T0");
    expect(summary.overallHitRate).toBeCloseTo(0.49, 5);
  });

  it("prefers the longer window when coverage ties", () => {
    const entries = [
      makeEntry("AAA", 80, DAY1, { d7: 0.1, d30: 0.2 }),
      makeEntry("BBB", 60, DAY1, { d7: -0.1, d30: -0.2 }),
    ];
    const summary = summarizePerformance({ schemaVersion: 1, droppedCount: 0, entries });
    expect(summary.windowCoverage).toEqual({ d7: 2, d20: 0, d30: 2, d90: 0, d252: 0 });
    expect(summary.primaryWindow).toBe("d30");
  });
});
