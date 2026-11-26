import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanyData } from "@/types";
import type { DataProvider } from "@/data/providers/types";

/**
 * BUG-FIX REGRESSION (Lane A, A-1, 2026-06-19): the inverted variant guard in
 * research.ts dropped the time-aware NormalizationContext for the LIVE DEFAULT
 * champion.
 *
 * research.ts built the ctx only `if (variant === "challenger")`, but the consumer
 * (postProcessUniverse / challenger.ts) feeds `ctx` to the CHAMPION
 * (CATALYST_DRIVEN_NORMALIZATION) and passes `undefined` to the curated-base
 * challenger. Net: with the live default champion, ctx stayed undefined → the
 * EWMA-smoothed news/social input and the estimate-revision tilt
 * (REVISION_NEUTRAL=50 → revisionTilt=0) were DEAD. The fix guards on
 * `runsCatalystDrivenProfile(variant)` so the champion actually receives its ctx.
 *
 * This drives the REAL `runResearch` pipeline (not a reimplementation). We mock the
 * network enrichment stages to pass-through and the localStorage-backed history
 * store to an in-memory series, then assert:
 *   • a CHAMPION run gets a ctx whose revision map (A=80, B=20) makes A's
 *     opportunityScore strictly out-rank B's (delta > 0; before the fix both were 0
 *     because ctx was undefined), and
 *   • a CHALLENGER run still passes `undefined` ctx (the curated base never consumes
 *     the time-aware refinements).
 */

// --- In-memory signal-history store (the node test env has no localStorage). The
//     write path stays a no-op; the read path returns a seeded PAST EPS series so
//     buildNormalizationContext derives a real revision trend (A up, B down).
//     Factories are inlined because vi.mock is hoisted above all top-level consts. ---
vi.mock("@/data/history/signalHistoryStore", () => ({
  readSignalHistory: () => ({
    schemaVersion: 1,
    series: {
      // Past EPS 1.00 → today's 1.09 (+9%) ⇒ revision score 80 (upward revision).
      A: [{ date: "2026-06-01", news: 50, social: 50, eps: 1.0 }],
      // Past EPS 1.00 → today's 0.91 (−9%) ⇒ revision score 20 (cut).
      B: [{ date: "2026-06-01", news: 50, social: 50, eps: 1.0 }],
    },
  }),
  writeSignalHistory: () => {},
}));

// --- Pass-through enrichment (no network). Each returns the universe unchanged so
//     the test isolates the scored-input → variant-guard → ctx path. ---
vi.mock("@/data/prices/enrichCompanyHistory", () => ({
  enrichUniverseWithLiveHistory: (u: unknown) => Promise.resolve(u),
}));
vi.mock("@/data/fundamentals/enrichCompanyFundamentals", () => ({
  enrichUniverseWithLiveFundamentals: (u: unknown) => Promise.resolve(u),
}));
vi.mock("@/data/news/enrichCompanyNews", () => ({
  enrichUniverseWithLiveNews: (u: unknown) => Promise.resolve(u),
}));
vi.mock("@/data/sec/enrichCompanySec", () => ({
  enrichUniverseWithSec: (u: unknown) => Promise.resolve(u),
}));
vi.mock("@/data/earnings/enrichCompanyEarnings", () => ({
  enrichUniverseWithEarnings: (u: unknown) => Promise.resolve(u),
}));
vi.mock("@/data/earnings/earningsCalendar", () => ({ isEarningsCalendarConfigured: () => false }));
vi.mock("@/data/catalysts/enrichCatalystEvents", () => ({
  enrichUniverseWithCatalystEvents: (u: unknown) => Promise.resolve(u),
}));
vi.mock("@/data/social/enrichCompanySocial", () => ({
  enrichUniverseWithLiveSocial: (u: unknown) => Promise.resolve(u),
}));
vi.mock("@/data/congress/enrichCompanyCongress", () => ({
  enrichUniverseWithCongress: (u: unknown) => Promise.resolve(u),
}));
// Finnhub gates the fundamentals stage; report unconfigured so it's skipped cleanly.
vi.mock("@/data/http", () => ({ isFinnhubConfigured: () => false }));

import { runResearch } from "@/engine/research";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";

/**
 * Two live-shaped companies that are IDENTICAL in every scored input (same
 * synthetic seed, marketCap, price) and differ ONLY in ticker + the forward EPS
 * estimate (the revision input). Using one seed for both isolates the revision
 * tilt as the sole driver of the A-vs-B gap - the synthetic builder otherwise
 * derives per-ticker news/social/catalyst values that would swamp the ±5pt tilt.
 */
function company(ticker: string, epsEstimate: number): CompanyData {
  const seed = buildSyntheticCompany("SEED");
  return {
    ...seed,
    ticker,
    marketCap: 5e9,
    price: 100,
    nextEarnings: {
      dateISO: "2026-07-15",
      daysAway: 25,
      epsEstimate,
    },
  } as CompanyData;
}

/** A live provider whose enrichment stages are mocked to pass-through above. */
function liveProvider(universe: CompanyData[]): DataProvider {
  return {
    id: "test-live",
    name: "test-live",
    isLive: true,
    fetchUniverse: async () => universe,
  };
}

describe("runResearch — variant guard feeds the champion its time-aware context", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a CHAMPION run gets a ctx whose revision map (A=80, B=20) lifts A above B", async () => {
    // Today's estimates: A revised UP to 1.09 (+9% vs seeded 1.00), B cut to 0.91.
    const universe = [company("A", 1.09), company("B", 0.91)];

    const { signals, normalizationContext } = await runResearch(
      liveProvider(universe),
      "manual",
      undefined,
      "champion",
    );

    // The champion (catalyst-driven profile) DOES receive a context now.
    expect(normalizationContext).toBeDefined();
    // The revision map is the one derived from the seeded history + today's EPS.
    expect(normalizationContext!.revision?.A).toBe(80);
    expect(normalizationContext!.revision?.B).toBe(20);

    const score = (t: string) =>
      signals.find((s) => s.ticker === t)!.score.opportunityScore;
    // Before the fix, ctx was undefined for the champion → both names scored revision
    // neutral (tilt 0) → delta 0. With the fix, A's upward revision tilts it strictly
    // above B's cut. (Same raw inputs otherwise, so the gap is the revision tilt.)
    expect(score("A") - score("B")).toBeGreaterThan(0);
  });

  it("a CHALLENGER run still passes undefined ctx (curated base never consumes it)", async () => {
    const universe = [company("A", 1.09), company("B", 0.91)];

    const { normalizationContext } = await runResearch(
      liveProvider(universe),
      "manual",
      undefined,
      "challenger",
    );

    // The curated-base challenger runs with the time-aware refinements OFF.
    expect(normalizationContext).toBeUndefined();
  });
});
