import { describe, expect, it } from "vitest";

import { reversalReadiness } from "@/engine/reversalReadiness";
import type { StockSignal } from "@/types";

/** Minimal StockSignal carrying only the fields reversalReadiness reads. */
function sig(over: {
  priceHistory: number[];
  price?: number;
  rsi?: number;
  return1M?: number;
  catalystLive?: boolean;
  catalyst?: { magnitude?: number; daysAway?: number; type?: string };
}): StockSignal {
  const closes = over.priceHistory;
  return {
    ticker: "T",
    price: over.price ?? closes[closes.length - 1] ?? 0,
    priceHistory: closes,
    momentum: { rsi: over.rsi ?? 50, return1M: over.return1M ?? 0 },
    catalystLive: over.catalystLive ?? false,
    catalyst: {
      type: over.catalyst?.type ?? "Partnership",
      magnitude: over.catalyst?.magnitude ?? 0,
      daysAway: over.catalyst?.daysAway ?? 999,
    },
  } as unknown as StockSignal;
}

/** An accelerating collapse: a gentle drift lower, then a steep, vol-expanding crash. */
function knifeCloses(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 100; i++) out.push(100 - i * 0.18); // 100 → ~82, gentle
  let p = out[out.length - 1]!;
  for (let i = 0; i < 30; i++) {
    p *= 1 - (0.01 + i * 0.0016); // −1% ramping to ~−5.6%/day
    out.push(p);
  }
  return out;
}

/** A real drawdown that then FLATTENS: decline for ~110 sessions, then a low-vol,
 *  slightly-up base. The archetypal "reversal caught below the MA, before the move". */
function baseCloses(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 110; i++) out.push(100 - i * 0.3); // 100 → ~67.3, steady decline
  let p = out[out.length - 1]!;
  for (let i = 0; i < 20; i++) {
    p += 0.05; // flat-to-slightly-up tail, tiny daily moves
    out.push(p);
  }
  return out;
}

describe("reversalReadiness", () => {
  it("vetoes an active falling knife (deeply oversold + fresh >25% monthly drop)", () => {
    const r = reversalReadiness(sig({ priceHistory: knifeCloses(), rsi: 22, return1M: -0.32 }));
    expect(r.fallingKnifeVeto).toBe(true);
    expect(r.readiness).toBe(0);
  });

  it("rewards a based, decelerating name well even though it is deep below its highs", () => {
    const r = reversalReadiness(sig({ priceHistory: baseCloses(), rsi: 45, return1M: 0.01 }));
    expect(r.fallingKnifeVeto).toBe(false);
    expect(r.readiness).toBeGreaterThan(0.5);
  });

  it("NEVER vetoes a calm name purely for being below its MA / mildly oversold", () => {
    // Below trend, RSI 40, but a modest -6% month and a flat base - a setup, not a crash.
    const r = reversalReadiness(sig({ priceHistory: baseCloses(), rsi: 40, return1M: -0.06 }));
    expect(r.fallingKnifeVeto).toBe(false);
    expect(r.readiness).toBeGreaterThan(0.4);
  });

  it("a live dated catalyst bypasses the gate entirely (readiness = 1)", () => {
    // Same crashing series that would otherwise be vetoed - the catalyst ends the down-leg.
    const r = reversalReadiness(
      sig({
        priceHistory: knifeCloses(),
        rsi: 22,
        return1M: -0.32,
        catalystLive: true,
        catalyst: { magnitude: 0.6, daysAway: 10 },
      }),
    );
    expect(r.catalystBypass).toBe(true);
    expect(r.readiness).toBe(1);
  });

  it("a scheduled EARNINGS report is graduated by proximity, not a blanket bypass", () => {
    // Every name has a report every quarter, so "earnings in 40 days" must not
    // switch the price-action gate off for most of the quarter.
    const far = reversalReadiness(
      sig({ priceHistory: baseCloses(), rsi: 40, catalystLive: true, catalyst: { type: "Earnings", magnitude: 0.5, daysAway: 40 } }),
    );
    const none = reversalReadiness(sig({ priceHistory: baseCloses(), rsi: 40 }));
    expect(far.catalystBypass).toBe(false);
    expect(far.readiness).toBe(none.readiness);
    // Inside three weeks the print is the setup: a 0.6 floor under a weak read.
    const near = reversalReadiness(
      sig({ priceHistory: knifeCloses(), rsi: 40, return1M: -0.1, catalystLive: true, catalyst: { type: "Earnings", magnitude: 0.5, daysAway: 14 } }),
    );
    expect(near.catalystBypass).toBe(false);
    expect(near.readiness).toBeGreaterThanOrEqual(0.6);
    // A week out, the resolution is imminent: full bypass.
    const imminent = reversalReadiness(
      sig({ priceHistory: knifeCloses(), rsi: 40, return1M: -0.1, catalystLive: true, catalyst: { type: "Earnings", magnitude: 0.5, daysAway: 3 } }),
    );
    expect(imminent.catalystBypass).toBe(true);
    expect(imminent.readiness).toBe(1);
    // An active crash INTO the print keeps the knife veto - the floor never overrides it.
    const crashing = reversalReadiness(
      sig({ priceHistory: knifeCloses(), rsi: 22, return1M: -0.32, catalystLive: true, catalyst: { type: "Earnings", magnitude: 0.5, daysAway: 14 } }),
    );
    expect(crashing.fallingKnifeVeto).toBe(true);
    expect(crashing.readiness).toBe(0);
    // A report that already happened is a fact being digested, not a coming catalyst.
    const past = reversalReadiness(
      sig({ priceHistory: knifeCloses(), rsi: 40, return1M: -0.1, catalystLive: true, catalyst: { type: "Earnings", magnitude: 0.5, daysAway: -3 } }),
    );
    expect(past.catalystBypass).toBe(false);
  });

  it("does not gate a thin-history name (no real base to judge)", () => {
    const shortSeries = Array.from({ length: 60 }, (_, i) => 100 - i);
    const r = reversalReadiness(sig({ priceHistory: shortSeries, rsi: 20, return1M: -0.4 }));
    expect(r.readiness).toBe(1);
    expect(r.fallingKnifeVeto).toBe(false);
  });

  it("is pure/deterministic", () => {
    const build = () => sig({ priceHistory: knifeCloses(), rsi: 22, return1M: -0.32 });
    expect(reversalReadiness(build())).toEqual(reversalReadiness(build()));
  });

  it("flags a FRESH adverse shock on a sharp recent single-session gap-down", () => {
    const closes = baseCloses(); // calm, based
    // Inject a −10% single-session gap two sessions back (an EVENT, not drift).
    closes[closes.length - 2] = closes[closes.length - 3]! * 0.9;
    const r = reversalReadiness(sig({ priceHistory: closes, rsi: 45, return1M: -0.05 }));
    expect(r.freshShock).toBe(true);
  });

  it("no fresh shock on a calm, gently-based name", () => {
    const r = reversalReadiness(sig({ priceHistory: baseCloses(), rsi: 45, return1M: 0.01 }));
    expect(r.freshShock).toBe(false);
  });
});
