import { describe, it, expect } from "vitest";

import { evaluateScreenGates } from "@/engine/screen";
import type { ScreenCriteria, StockSignal } from "@/types";

/**
 * Lane C regression: the screener must never present a placeholder 0% (seeded by
 * `unknownFundamentals()` for a live record with no provider value) as a
 * company's real fundamental. Fixtures here are SYNTHETIC engine-behavior cases,
 * not claims about any real ticker, so no market-data verification applies.
 */

type FundamentalsFixture = Pick<StockSignal, "fundamentals" | "fundamentalsAvailability">;

function makeSignal(fixture: FundamentalsFixture): StockSignal {
  return fixture as StockSignal;
}

const CRITERIA: ScreenCriteria = {
  minRevenueGrowth: 0.1,
  minEpsGrowth: 0.1,
  minGrossMargin: 0.3,
};

const FUND_KEYS = ["minRevenueGrowth", "minEpsGrowth", "minGrossMargin"] as const;

describe("evaluateScreenGates — fundamentals availability gate (Lane C)", () => {
  it("renders N/A (never 0%) when a live record marks the fundamental unavailable", () => {
    // Mirrors unknownFundamentals(): placeholder 0 + explicit availability=false.
    const signal = makeSignal({
      fundamentals: {
        revenueGrowthYoY: 0,
        epsGrowthYoY: 0,
        grossMargin: 0,
        netMargin: 0,
        peRatio: null,
        pegRatio: null,
        debtToEquity: 0,
        fcfMargin: 0,
      },
      fundamentalsAvailability: {
        revenueGrowthYoY: false,
        epsGrowthYoY: false,
        grossMargin: false,
      },
    });

    const gates = evaluateScreenGates(signal, CRITERIA);

    for (const key of FUND_KEYS) {
      const gate = gates.find((g) => g.key === key);
      expect(gate, `gate ${key} should be emitted`).toBeDefined();
      expect(gate!.actual).toBe("N/A");
      expect(gate!.actual).not.toContain("%");
      expect(gate!.unknown).toBe(true);
      // Unknown is not a real-value pass.
      expect(gate!.pass).toBe(false);
    }
  });

  it("still gates on the modeled value for a sample/no-map signal (backward compat)", () => {
    // No fundamentalsAvailability map => sample/modeled universe keeps current behavior.
    const signal = makeSignal({
      fundamentals: {
        revenueGrowthYoY: 0.25, // 25% modeled growth, comfortably above the 10% floor
        epsGrowthYoY: 0.05, // 5% modeled, BELOW the 10% floor -> should fail on its real value
        grossMargin: 0.42, // 42% modeled, above the 30% floor
        netMargin: 0.12,
        peRatio: 18,
        pegRatio: 1.4,
        debtToEquity: 0.5,
        fcfMargin: 0.15,
      },
    });

    const gates = evaluateScreenGates(signal, CRITERIA);

    const rev = gates.find((g) => g.key === "minRevenueGrowth")!;
    expect(rev.unknown).toBeUndefined();
    expect(rev.actual).toBe("25%");
    expect(rev.pass).toBe(true);

    const eps = gates.find((g) => g.key === "minEpsGrowth")!;
    expect(eps.unknown).toBeUndefined();
    expect(eps.actual).toBe("5%");
    expect(eps.pass).toBe(false); // modeled value gates honestly, not as "unknown"

    const margin = gates.find((g) => g.key === "minGrossMargin")!;
    expect(margin.unknown).toBeUndefined();
    expect(margin.actual).toBe("42%");
    expect(margin.pass).toBe(true);
  });

  it("treats availability=true (live value present) as a normal scored gate", () => {
    const signal = makeSignal({
      fundamentals: {
        revenueGrowthYoY: 0.18,
        epsGrowthYoY: 0.22,
        grossMargin: 0.55,
        netMargin: 0.2,
        peRatio: 30,
        pegRatio: 1.1,
        debtToEquity: 0.3,
        fcfMargin: 0.25,
      },
      fundamentalsAvailability: {
        revenueGrowthYoY: true,
        epsGrowthYoY: true,
        grossMargin: true,
      },
    });

    const gates = evaluateScreenGates(signal, CRITERIA);
    for (const key of FUND_KEYS) {
      const gate = gates.find((g) => g.key === key)!;
      expect(gate.unknown).toBeUndefined();
      expect(gate.actual).not.toBe("N/A");
      expect(gate.pass).toBe(true);
    }
  });
});

/**
 * Cap-gate symmetry: a KNOWN cap that misses the selected buckets is a real fail
 * (→ hard-removed from the board), but an UNKNOWN cap is display-only N/A - never
 * a fail. This stops an AI-discovered name (hydrated keylessly, so cap is
 * "Unknown") from being buried by a cap filter just for a data gap.
 */
describe("evaluateScreenGates — market-cap bucket gate (Unknown = N/A, not a fail)", () => {
  const capSignal = (bucket: StockSignal["marketCapBucket"]): StockSignal =>
    ({
      marketCapBucket: bucket,
      // evaluateScreenGates reads signal.fundamentals.peRatio unconditionally.
      fundamentals: {
        revenueGrowthYoY: 0,
        epsGrowthYoY: 0,
        grossMargin: 0,
        netMargin: 0,
        peRatio: null,
        pegRatio: null,
        debtToEquity: 0,
        fcfMargin: 0,
      },
    }) as StockSignal;
  const MICRO_ONLY: ScreenCriteria = { capBuckets: ["Micro"] };

  it("treats an Unknown cap as N/A (unknown:true, not a real fail)", () => {
    const gate = evaluateScreenGates(capSignal("Unknown"), MICRO_ONLY).find(
      (g) => g.key === "capBuckets",
    )!;
    expect(gate).toBeDefined();
    expect(gate.unknown).toBe(true);
    expect(gate.pass).toBe(false);
    expect(gate.actual).toBe("—");
  });

  it("hard-fails a KNOWN cap that misses the selected buckets", () => {
    const gate = evaluateScreenGates(capSignal("Mega"), MICRO_ONLY).find(
      (g) => g.key === "capBuckets",
    )!;
    expect(gate.unknown).toBeUndefined();
    expect(gate.pass).toBe(false);
    expect(gate.actual).toBe("Mega");
  });

  it("passes a KNOWN cap that matches a selected bucket", () => {
    const gate = evaluateScreenGates(capSignal("Micro"), MICRO_ONLY).find(
      (g) => g.key === "capBuckets",
    )!;
    expect(gate.unknown).toBeUndefined();
    expect(gate.pass).toBe(true);
  });

  it("emits no cap gate when no cap filter is active", () => {
    const gate = evaluateScreenGates(capSignal("Mega"), {}).find((g) => g.key === "capBuckets");
    expect(gate).toBeUndefined();
  });
});
