import { describe, it, expect } from "vitest";
import type { CompanyData } from "@/types";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import { enforceFundamentalsPublishInvariant } from "@/data/fundamentals/publishInvariant";
import {
  allFalseFundamentalsAvailability,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";

/**
 * A-4 - the pre-publish invariant: no record destined for `daily_signals` may
 * expose a fundamental as real unless it's truly real (present map + flagged
 * true + fresh as-of). The synthetic-fallback seed (no map), a record that
 * skipped enrichment, and a stale figure all get normalized to "N/A" here.
 */

const FRESH_ASOF = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const STALE_ASOF = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);

function company(overrides: Partial<CompanyData> = {}): CompanyData {
  return { ...buildSyntheticCompany("TEST"), marketCap: 5e10, price: 100, ...overrides };
}

describe("enforceFundamentalsPublishInvariant", () => {
  it("a record with NO availability map gets an all-false map (synthetic never leaks)", () => {
    // The throttled-fallback seed shape: synthetic fundamentals, no map.
    const seed = company({
      fundamentals: { ...unknownFundamentals(), netMargin: -0.198, epsGrowthYoY: -0.5 },
      fundamentalsAvailability: undefined,
    });
    const { companies, missingMap } = enforceFundamentalsPublishInvariant([seed]);
    expect(missingMap).toBe(1);
    const out = companies[0]!;
    for (const flag of Object.values(out.fundamentalsAvailability ?? {})) {
      expect(flag).toBe(false);
    }
    // Synthetic values wiped to placeholder.
    expect(out.fundamentals.netMargin).toBe(0);
  });

  it("downgrades a field flagged available but lacking a fresh as-of", () => {
    const stale = company({
      fundamentals: { ...unknownFundamentals(), netMargin: -0.198 },
      fundamentalsAvailability: { ...allFalseFundamentalsAvailability(), netMargin: true },
      fundamentalsAsOf: STALE_ASOF,
    });
    const { companies, repaired } = enforceFundamentalsPublishInvariant([stale]);
    expect(repaired).toBe(1);
    expect(companies[0]!.fundamentalsAvailability?.netMargin).toBe(false);
    expect(companies[0]!.fundamentals.netMargin).toBe(0);
    expect(companies[0]!.fundamentalsAsOf).toBeUndefined();
  });

  it("keeps a real, fresh, vouched-for field untouched", () => {
    const good = company({
      // src: SoFi Q1 2026 ~15% GAAP net margin (Q1 2026 earnings release)
      fundamentals: { ...unknownFundamentals(), netMargin: 0.15 },
      fundamentalsAvailability: { ...allFalseFundamentalsAvailability(), netMargin: true },
      fundamentalsAsOf: FRESH_ASOF,
    });
    const { companies, repaired } = enforceFundamentalsPublishInvariant([good]);
    expect(repaired).toBe(0);
    expect(companies[0]).toBe(good); // unchanged reference
    expect(companies[0]!.fundamentalsAvailability?.netMargin).toBe(true);
    expect(companies[0]!.fundamentals.netMargin).toBeCloseTo(0.15, 5);
  });

  it("strips available fundamentals from a market-data-unavailable record", () => {
    const directory = company({
      marketDataUnavailable: "directory",
      fundamentals: { ...unknownFundamentals(), netMargin: 0.15 },
      fundamentalsAvailability: { ...allFalseFundamentalsAvailability(), netMargin: true },
      fundamentalsAsOf: FRESH_ASOF,
    });
    const { companies } = enforceFundamentalsPublishInvariant([directory]);
    expect(companies[0]!.fundamentalsAvailability?.netMargin).toBe(false);
  });

  it("INVARIANT: after enforcement, no published record exposes a fundamental without a fresh stamp", () => {
    const mixed: CompanyData[] = [
      company({ fundamentalsAvailability: undefined }), // no map
      company({
        fundamentalsAvailability: { ...allFalseFundamentalsAvailability(), epsGrowthYoY: true },
        fundamentalsAsOf: STALE_ASOF, // stale
      }),
      company({
        fundamentalsAvailability: { ...allFalseFundamentalsAvailability(), netMargin: true },
        fundamentals: { ...unknownFundamentals(), netMargin: 0.15 },
        fundamentalsAsOf: FRESH_ASOF, // genuinely real
      }),
    ];
    const { companies } = enforceFundamentalsPublishInvariant(mixed);
    for (const c of companies) {
      const av = c.fundamentalsAvailability ?? {};
      const anyTrue = Object.values(av).some((v) => v === true);
      if (anyTrue) {
        // Any record still claiming an available fundamental MUST be fresh.
        const ageOk =
          c.fundamentalsAsOf != null &&
          (Date.now() - Date.parse(c.fundamentalsAsOf)) / 86_400_000 <= 200;
        expect(ageOk).toBe(true);
      }
    }
  });
});
