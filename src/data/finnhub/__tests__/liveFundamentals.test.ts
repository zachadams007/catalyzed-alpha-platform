import { describe, it, expect } from "vitest";
import type { CompanyData } from "@/types";
import { applyLiveFundamentalsToCompany } from "@/data/finnhub/liveFundamentals";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import {
  allFalseFundamentalsAvailability,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";

/**
 * A-1 / A-3 - honest live fundamentals.
 *
 * The bug class: every live record was `{ ...synthetic }`, so a name that
 * Finnhub didn't return a metric for KEPT its synthetic PRNG fundamentals (the
 * SOFI "Unprofitable −19.8% net margin" under a green Live badge). The fix: a
 * live record starts with NO real fundamentals (placeholder + all-false map),
 * and a value is only flagged available when it's real, in-band, and FRESH.
 *
 * Financial figures encoded below are WEB-VERIFIED (Q1 2026, reported Apr–May
 * 2026) - see the `// src:` citation on each. We never invent a number.
 */

/** A live-shaped company seeded the honest way (A-1): no real fundamentals. */
function liveCompany(overrides: Partial<CompanyData> = {}): CompanyData {
  return {
    ...buildSyntheticCompany("TEST"),
    marketCap: 5e10,
    price: 100,
    fundamentals: unknownFundamentals(),
    fundamentalsAvailability: allFalseFundamentalsAvailability(),
    ...overrides,
  };
}

/** A fresh as-of (within the freshness window) relative to "now". */
const FRESH_ASOF = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
/** A stale as-of (well past the freshness window). */
const STALE_ASOF = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);

describe("applyLiveFundamentalsToCompany — never retains a modeled value", () => {
  it("with no metric, sets all-false availability and leaves nothing real", () => {
    const company = liveCompany();
    const enriched = applyLiveFundamentalsToCompany(company, null);
    for (const k of Object.values(enriched.fundamentalsAvailability ?? {})) {
      expect(k).toBe(false);
    }
  });

  it("a real, fresh netMargin flips ONLY that field available and stamps as-of", () => {
    const enriched = applyLiveFundamentalsToCompany(liveCompany(), {
      metric: { netProfitMarginTTM: 15.0 }, // src: SoFi Q1 2026 ~15% GAAP net margin
      asOf: FRESH_ASOF,
    });
    expect(enriched.fundamentalsAvailability?.netMargin).toBe(true);
    expect(enriched.fundamentals.netMargin).toBeCloseTo(0.15, 5);
    expect(enriched.fundamentalsAsOf).toBe(FRESH_ASOF);
    // Every OTHER field stays unavailable - no synthetic leak.
    expect(enriched.fundamentalsAvailability?.epsGrowthYoY).toBe(false);
    expect(enriched.fundamentalsAvailability?.revenueGrowthYoY).toBe(false);
  });

  it("a field whose metric is ABSENT never inherits a prior/synthetic value", () => {
    // Start from a company that (wrongly) carries a synthetic netMargin value.
    const dirty = liveCompany({
      fundamentals: { ...unknownFundamentals(), netMargin: -0.198 }, // the old SOFI seed
    });
    const enriched = applyLiveFundamentalsToCompany(dirty, {
      metric: { peTTM: 18.4 }, // only P/E returned this run
      asOf: FRESH_ASOF,
    });
    expect(enriched.fundamentalsAvailability?.netMargin).toBe(false);
    // The reset placeholder is 0, NOT the inherited −0.198 synthetic seed.
    expect(enriched.fundamentals.netMargin).toBe(0);
  });

  it("rejects STALE fundamentals entirely (availability false, no as-of)", () => {
    const enriched = applyLiveFundamentalsToCompany(liveCompany(), {
      metric: { netProfitMarginTTM: 15.0 },
      asOf: STALE_ASOF,
    });
    expect(enriched.fundamentalsAvailability?.netMargin).toBe(false);
    expect(enriched.fundamentalsAsOf).toBeUndefined();
  });

  it("accepts undated free-tier data at the tile level (availability true, no as-of)", () => {
    const enriched = applyLiveFundamentalsToCompany(liveCompany(), {
      metric: { peTTM: 18.4 },
      asOf: null,
    });
    expect(enriched.fundamentalsAvailability?.peRatio).toBe(true);
    expect(enriched.fundamentalsAsOf).toBeUndefined();
  });

  it("still accepts a bare metric dict (back-compat) as undated", () => {
    const enriched = applyLiveFundamentalsToCompany(liveCompany(), { peTTM: 18.4 });
    expect(enriched.fundamentalsAvailability?.peRatio).toBe(true);
  });
});

describe("web-verified watch-out figures resolve to the RIGHT sign/magnitude", () => {
  // These confirm the extractor + sanity bands surface the real direction, so a
  // downstream watch-out (negativeSignals) reads truthfully instead of fabricated.

  it("QBTS revenue −81% YoY (small-cap) is kept (genuinely hot move, real)", () => {
    // src: D-Wave Q1 2026 revenue $2.9M vs $15.5M = −81% YoY (businesswire 8-K)
    const enriched = applyLiveFundamentalsToCompany(
      liveCompany({ marketCap: 1.2e9 }),
      { metric: { revenueGrowthTTMYoy: -81 }, asOf: FRESH_ASOF },
    );
    expect(enriched.fundamentalsAvailability?.revenueGrowthYoY).toBe(true);
    expect(enriched.fundamentals.revenueGrowthYoY).toBeCloseTo(-0.81, 5);
  });

  it("SOFI net margin is POSITIVE (~15%) — profitable, not −19.8%", () => {
    // src: SoFi Q1 2026 GAAP net income $166.7M, ~15% net margin (Q1 earnings release)
    const enriched = applyLiveFundamentalsToCompany(liveCompany(), {
      metric: { netProfitMarginTTM: 15.0 },
      asOf: FRESH_ASOF,
    });
    expect(enriched.fundamentals.netMargin).toBeGreaterThan(0);
    expect(enriched.fundamentals.netMargin).toBeCloseTo(0.15, 5);
  });
});
