import { describe, expect, it } from "vitest";

import {
  appendSnapshots,
  buildNormalizationContext,
  emptySignalHistory,
  MAX_SERIES_LENGTH,
  normalizeSignalHistory,
  REVISION_NEUTRAL,
  revisionMomentumScore,
  smoothedValue,
  type SignalHistory,
} from "@/engine/signalHistory";

function history(series: SignalHistory["series"]): SignalHistory {
  return { schemaVersion: 1, series };
}

describe("signalHistory — appendSnapshots", () => {
  it("records a new day and is pure (does not mutate input)", () => {
    const base = emptySignalHistory();
    const before = JSON.stringify(base);
    const next = appendSnapshots(base, [{ ticker: "AAA", news: 60, social: 40, eps: 1.2 }], "2026-06-12");
    expect(JSON.stringify(base)).toBe(before); // untouched
    expect(next.series.AAA).toHaveLength(1);
    expect(next.series.AAA![0]).toMatchObject({ date: "2026-06-12", news: 60, social: 40, eps: 1.2 });
  });

  it("dedupes by day — a same-day re-run REPLACES rather than appends", () => {
    let h = appendSnapshots(emptySignalHistory(), [{ ticker: "AAA", news: 10, social: 10, eps: 1 }], "2026-06-12");
    h = appendSnapshots(h, [{ ticker: "AAA", news: 80, social: 80, eps: 2 }], "2026-06-12");
    expect(h.series.AAA).toHaveLength(1);
    expect(h.series.AAA![0]!.news).toBe(80);
    expect(h.series.AAA![0]!.eps).toBe(2);
  });

  it("caps each series at MAX_SERIES_LENGTH (drops the oldest)", () => {
    let h = emptySignalHistory();
    for (let i = 0; i < MAX_SERIES_LENGTH + 20; i++) {
      const day = `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
      h = appendSnapshots(h, [{ ticker: "AAA", news: i, social: i, eps: null }], day);
    }
    expect(h.series.AAA!.length).toBe(MAX_SERIES_LENGTH);
    // Oldest retained is news=20 (the first 20 rotated out).
    expect(h.series.AAA![0]!.news).toBe(20);
  });

  it("prunes tickers whose newest snapshot predates the cutoff", () => {
    const base = history({
      OLD: [{ date: "2026-01-01", news: 50, social: 50, eps: null }],
      NEW: [{ date: "2026-06-10", news: 50, social: 50, eps: null }],
    });
    const next = appendSnapshots(base, [{ ticker: "FRESH", news: 50, social: 50, eps: null }], "2026-06-12", "2026-03-01");
    expect(next.series.OLD).toBeUndefined(); // pruned (last seen Jan 1 < Mar 1)
    expect(next.series.NEW).toBeDefined();
    expect(next.series.FRESH).toBeDefined();
  });
});

describe("signalHistory — normalizeSignalHistory", () => {
  it("coerces junk to an empty history", () => {
    expect(normalizeSignalHistory(null).series).toEqual({});
    expect(normalizeSignalHistory(42).series).toEqual({});
    expect(normalizeSignalHistory({ nope: true }).series).toEqual({});
  });

  it("filters invalid snapshots and re-sorts oldest → newest", () => {
    const dirty = {
      series: {
        AAA: [
          { date: "2026-06-12", news: 5, social: 5, eps: 1 },
          { date: "2026-06-10", news: 3, social: 3, eps: null },
          { date: "2026-06-11", news: "bad", social: 1, eps: 1 }, // invalid → dropped
          { news: 1, social: 1, eps: 1 }, // no date → dropped
        ],
      },
    };
    const clean = normalizeSignalHistory(dirty);
    expect(clean.series.AAA!.map((s) => s.date)).toEqual(["2026-06-10", "2026-06-12"]);
  });
});

describe("signalHistory — revisionMomentumScore", () => {
  it("is neutral with fewer than two finite estimates (cold start)", () => {
    expect(revisionMomentumScore([])).toBe(REVISION_NEUTRAL);
    expect(revisionMomentumScore([1.0])).toBe(REVISION_NEUTRAL);
    expect(revisionMomentumScore([NaN, 1.0])).toBe(REVISION_NEUTRAL);
  });

  it("scores above neutral for an upward revision, below for a cut", () => {
    expect(revisionMomentumScore([1.0, 1.1])).toBeGreaterThan(REVISION_NEUTRAL);
    expect(revisionMomentumScore([1.0, 0.9])).toBeLessThan(REVISION_NEUTRAL);
  });

  it("is neutral for a flat estimate and clamps extreme revisions", () => {
    expect(revisionMomentumScore([1.0, 1.0])).toBe(REVISION_NEUTRAL);
    expect(revisionMomentumScore([1.0, 5.0])).toBe(100); // clamped to the band
    expect(revisionMomentumScore([1.0, -5.0])).toBe(0);
  });

  it("reads a swing back to profitability as strongly bullish", () => {
    expect(revisionMomentumScore([-0.1, 0.05])).toBeGreaterThan(90);
  });
});

describe("signalHistory — smoothedValue", () => {
  it("returns the current value when there is no history", () => {
    expect(smoothedValue([], 80)).toBe(80);
  });

  it("damps a fresh spike toward the prior level", () => {
    const smoothed = smoothedValue([20, 20, 20], 80, 3);
    expect(smoothed).toBeGreaterThan(20);
    expect(smoothed).toBeLessThan(80); // a one-day spike doesn't fully land
  });
});

describe("signalHistory — buildNormalizationContext", () => {
  it("smooths news/social and scores revision from the past plus today", () => {
    const base = history({
      AAA: [
        { date: "2026-06-10", news: 20, social: 30, eps: 1.0 },
        { date: "2026-06-11", news: 20, social: 30, eps: 1.1 },
      ],
    });
    const ctx = buildNormalizationContext(base, [{ ticker: "AAA", news: 80, social: 90, eps: 1.2 }], "2026-06-12");
    expect(ctx.smoothed!.AAA!.news).toBeGreaterThan(20);
    expect(ctx.smoothed!.AAA!.news).toBeLessThan(80); // spike damped
    expect(ctx.revision!.AAA).toBeGreaterThan(REVISION_NEUTRAL); // 1.0 → 1.2
  });

  it("is idempotent — an existing same-day snapshot is excluded, not double-counted", () => {
    const withoutToday = history({ AAA: [{ date: "2026-06-10", news: 20, social: 20, eps: 1.0 }] });
    const withStaleToday = history({
      AAA: [
        { date: "2026-06-10", news: 20, social: 20, eps: 1.0 },
        { date: "2026-06-12", news: 99, social: 99, eps: 9 }, // stale same-day write
      ],
    });
    const today = [{ ticker: "AAA", news: 80, social: 80, eps: 1.2 }];
    const a = buildNormalizationContext(withoutToday, today, "2026-06-12");
    const b = buildNormalizationContext(withStaleToday, today, "2026-06-12");
    expect(b.smoothed!.AAA).toEqual(a.smoothed!.AAA);
    expect(b.revision!.AAA).toEqual(a.revision!.AAA);
  });

  it("is cold-start neutral for a name with no prior history", () => {
    const ctx = buildNormalizationContext(emptySignalHistory(), [{ ticker: "NEW", news: 70, social: 40, eps: 1.5 }], "2026-06-12");
    expect(ctx.smoothed!.NEW).toEqual({ news: 70, social: 40 }); // smooths to itself
    expect(ctx.revision!.NEW).toBe(REVISION_NEUTRAL); // only one eps point
  });
});
