import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("@/lib/links", () => ({
  externalXSearchUrl: (ticker: string, queryExtra?: string) => {
    const query = queryExtra ? `${ticker} ${queryExtra}` : `${ticker} stock`;
    return `https://x.com/search?q=${encodeURIComponent(query)}`;
  },
  isSampleUniverseTicker: () => true,
}));

import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import {
  computeNormalizedScores,
  INFLECTION_V2_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
} from "@/engine/normalizeUniverse";
import type { StockSignal } from "@/types";

const NOW = "2026-07-02T12:00:00.000Z";
const BASE: StockSignal[] = MOCK_UNIVERSE.map((company) =>
  toStockSignal(company, scoreCompany(company), NOW),
);

/**
 * Regression: a cap-UNKNOWN name (marketCap 0 / NaN - real bug: TSM published
 * with an unknown cap) must receive ~ZERO size tilt, not the maximum small-cap
 * boost. Missing size data must never be a ranking advantage.
 */
describe("size tilt with unknown market cap", () => {
  const unknownZero: StockSignal = { ...BASE[0], ticker: "UNKC0", id: "UNKC0", marketCap: 0 };
  const unknownNaN: StockSignal = {
    ...BASE[1],
    ticker: "UNKCN",
    id: "UNKCN",
    marketCap: Number.NaN,
  };
  const universe = [...BASE, unknownZero, unknownNaN];

  it.each([
    ["V2 champion profile", INFLECTION_V2_NORMALIZATION],
    ["V5 reversal profile", REVERSAL_V5_NORMALIZATION],
  ])("pins unknown caps to the center under the %s", (_label, options) => {
    const scored = computeNormalizedScores(universe, undefined, options);
    const byTicker = new Map(scored.map((s) => [s.ticker, s]));

    const zero = byTicker.get("UNKC0")!;
    const nan = byTicker.get("UNKCN")!;
    expect(Math.abs(zero.sizeTilt)).toBeLessThan(0.5);
    expect(Math.abs(nan.sizeTilt)).toBeLessThan(0.5);
    expect(Number.isFinite(zero.sizeTilt)).toBe(true);
    expect(Number.isFinite(nan.sizeTilt)).toBe(true);

    // The deliberate small-cap balancing still works for names with REAL caps:
    // the smallest known cap keeps a clearly positive tilt.
    const known = BASE.filter((s) => Number.isFinite(s.marketCap) && s.marketCap > 0);
    const smallest = [...known].sort((a, b) => a.marketCap - b.marketCap)[0];
    const smallestScored = byTicker.get(smallest.ticker)!;
    expect(smallestScored.sizeTilt).toBeGreaterThan(0.5);
    expect(smallestScored.sizeTilt).toBeGreaterThan(zero.sizeTilt);
  });
});
