import { describe, expect, it } from "vitest";

import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import {
  unknownRisk,
  unknownSocial,
  unknownVolatility,
} from "@/data/fundamentals/unknownNonFundamentals";
import { realizedBeta } from "@/data/alpaca/bars";

/**
 * Regression guard: the synthetic ticker-hash PRNG must never reach a live record.
 *
 * `buildSyntheticCompany` derives every field from a hash of the ticker string.
 * `fetchFinnhubCompany` builds a live record by spreading that object and
 * overriding the fields it has real data for - so any group it forgets to
 * override ships hash noise as live data. That is exactly what happened to
 * `risk`, `volatility` and `social`: the published board carried Amazon at 21.5%
 * short interest, Meta at a 0.46 "dilution risk" (which excluded it from the
 * misunderstood-quality archetype), and NVIDIA on a 9.9-quarter cash runway.
 *
 * Those fields drive a risk penalty worth up to 30 points and the quality floor
 * every archetype depends on, so this is a ranking-integrity guard, not cosmetics.
 */

describe("synthetic PRNG never leaks into live records", () => {
  it("produces genuinely different values per ticker — i.e. it IS a hash, not a constant", () => {
    const a = buildSyntheticCompany("AAAA");
    const b = buildSyntheticCompany("ZZZZ");
    // If these were ever equal the leak would be invisible in production data.
    expect(a.risk.dilutionRisk).not.toBe(b.risk.dilutionRisk);
    expect(a.risk.shortInterestPct).not.toBe(b.risk.shortInterestPct);
    expect(a.volatility.beta).not.toBe(b.volatility.beta);
  });

  it("neutral risk carries no evidence of danger OR of safety", () => {
    const r = unknownRisk();
    expect(r.shortInterestPct).toBe(0);
    expect(r.dilutionRisk).toBe(0);
    expect(r.governanceFlag).toBe(0);
    // The runway must not be so short that it fabricates a solvency crisis for a
    // company we simply have no runway data for.
    expect(r.cashRunwayQuarters).toBeGreaterThanOrEqual(8);
  });

  it("neutral volatility leaves every leg unscoreable rather than wrong", () => {
    const v = unknownVolatility();
    expect(v.atrPct).toBe(0);
    expect(v.impliedVol).toBe(0);
    expect(v.beta).toBe(1);
  });

  it("neutral social reports zero mentions and says so in the copy", () => {
    const s = unknownSocial();
    expect(s.redditMentions24h).toBe(0);
    expect(s.xMentions24h).toBe(0);
    expect(s.sentiment).toBe(0);
    expect(s.summary.toLowerCase()).toContain("no social signal");
  });
});

describe("realizedBeta — a measured replacement for the hashed beta", () => {
  it("returns ~1 for a name that tracks the market exactly", () => {
    const market = Array.from({ length: 200 }, (_, i) => 100 * 1.001 ** i + (i % 7) - 3);
    const beta = realizedBeta(market, market);
    expect(beta).not.toBeNull();
    expect(beta!).toBeCloseTo(1, 6);
  });

  it("returns ~2 for a name that moves twice the market", () => {
    const market = Array.from({ length: 200 }, (_, i) => 100 + (i % 11) - 5 + i * 0.05);
    // Build a series whose daily RETURNS are twice the market's.
    const levered: number[] = [market[0]!];
    for (let i = 1; i < market.length; i++) {
      const r = (market[i]! - market[i - 1]!) / market[i - 1]!;
      levered.push(levered[i - 1]! * (1 + 2 * r));
    }
    const beta = realizedBeta(levered, market);
    expect(beta).not.toBeNull();
    expect(beta!).toBeGreaterThan(1.7);
    expect(beta!).toBeLessThan(2.3);
  });

  it("refuses to measure a beta from too little overlapping history", () => {
    expect(realizedBeta([1, 2, 3], [1, 2, 3])).toBeNull();
  });
});
