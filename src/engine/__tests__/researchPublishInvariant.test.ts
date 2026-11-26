import { describe, it, expect } from "vitest";
import type { CompanyData } from "@/types";
import type { DataProvider } from "@/data/providers/types";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import { runResearch } from "@/engine/research";
import {
  allFalseFundamentalsAvailability,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";

/**
 * Lane D - in-app publish-invariant parity.
 *
 * The offline daily scan (scripts/universe_scan/scan.mts) runs
 * `enforceFundamentalsPublishInvariant` before scoring so no stale/seeded
 * fundamental is published to `daily_signals` as a live figure. The in-app
 * `runResearch` pipeline must run the SAME seam, otherwise a record that is
 * stale or missing its availability map would render a real number in
 * `keyFundamentals` instead of "N/A" - the exact property the scan test asserts.
 *
 * We use a non-live provider so the enrichment stages are skipped and the test
 * isolates the scored-input → invariant → toStockSignal path (no network).
 */

const STALE_ASOF = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);

function company(overrides: Partial<CompanyData> = {}): CompanyData {
  return { ...buildSyntheticCompany("TEST"), marketCap: 5e10, price: 100, ...overrides };
}

function providerFor(universe: CompanyData[]): DataProvider {
  return {
    id: "test",
    name: "test",
    isLive: false,
    fetchUniverse: async () => universe,
  };
}

function netMarginCell(keyFundamentals: { label: string; value: string }[]) {
  return keyFundamentals.find((k) => k.label === "Net Margin");
}

describe("runResearch — in-app publish-invariant parity", () => {
  it("downgrades a STALE vouched-for fundamental so keyFundamentals shows N/A", async () => {
    // A live-shaped record that claims a real net margin but with a stale as-of -
    // the invariant must downgrade it before scoring/display.
    const stale = company({
      fundamentals: { ...unknownFundamentals(), netMargin: -0.198 },
      fundamentalsAvailability: { ...allFalseFundamentalsAvailability(), netMargin: true },
      fundamentalsAsOf: STALE_ASOF,
    });

    const { signals } = await runResearch(providerFor([stale]), "manual");
    expect(signals).toHaveLength(1);
    const cell = netMarginCell(signals[0]!.keyFundamentals);
    expect(cell?.value).toBe("N/A");
  });

  it("downgrades a record MISSING its availability map so keyFundamentals shows N/A", async () => {
    // The throttled-fallback seed shape: synthetic fundamentals, no map. Without
    // the invariant, `buildKeyFundamentals` treats a missing map as "show all",
    // leaking the synthetic figure as if it were real.
    const noMap = company({
      fundamentals: { ...unknownFundamentals(), netMargin: -0.198 },
      fundamentalsAvailability: undefined,
    });

    const { signals } = await runResearch(providerFor([noMap]), "manual");
    expect(signals).toHaveLength(1);
    const cell = netMarginCell(signals[0]!.keyFundamentals);
    expect(cell?.value).toBe("N/A");
  });

  it("keeps a real, fresh, vouched-for fundamental visible (not over-zealously N/A'd)", async () => {
    const fresh = company({
      // src: SoFi Q1 2026 ~15% GAAP net margin (Q1 2026 earnings release)
      fundamentals: { ...unknownFundamentals(), netMargin: 0.15 },
      fundamentalsAvailability: { ...allFalseFundamentalsAvailability(), netMargin: true },
      fundamentalsAsOf: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
    });

    const { signals } = await runResearch(providerFor([fresh]), "manual");
    const cell = netMarginCell(signals[0]!.keyFundamentals);
    expect(cell?.value).not.toBe("N/A");
  });
});
