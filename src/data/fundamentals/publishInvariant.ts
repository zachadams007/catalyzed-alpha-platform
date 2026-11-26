import type { CompanyData, RawFundamentals } from "@/types";
import {
  allFalseFundamentalsAvailability,
  FUNDAMENTAL_KEYS,
  isFundamentalsFresh,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";
import { hasNoLiveMarketData } from "@/lib/marketData";

/**
 * Pre-publish honest-fundamentals invariant for the daily scan.
 *
 * The prime directive at the publish seam: NO record written to `daily_signals`
 * may expose a fundamental as real unless it is provably real - a present
 * availability map, the field flagged `true`, AND a fresh as-of stamp. This is
 * the last line of defence behind the constructor (A-1) and gate (A-2) fixes: a
 * throttled/fallback seed, a record that skipped the fundamentals-enrichment
 * stage, or any future builder that forgets the map gets NORMALIZED here instead
 * of leaking a synthetic number to every tester.
 *
 * It runs on the scored-input {@link CompanyData} BEFORE `toStockSignal`, so a
 * downgrade flows consistently into the display tiles (`keyFundamentals`) and
 * the honest negative-signals derivation - there is no second, divergent copy.
 *
 * For each record it enforces:
 *  1. A `fundamentalsAvailability` map ALWAYS exists (missing → all-false).
 *  2. A market-data-unavailable record carries NO available fundamentals.
 *  3. A field flagged available but lacking a fresh as-of is downgraded to
 *     false and its value reset to a neutral placeholder (never a retained seed).
 *  4. The as-of stamp is cleared when nothing real remains available.
 */
export interface PublishInvariantResult {
  companies: CompanyData[];
  /** How many records were repaired (a map added or a fundamental downgraded). */
  repaired: number;
  /** How many were missing an availability map entirely. */
  missingMap: number;
}

/**
 * Withdraw fundamentals that CANNOT ALL BE TRUE AT ONCE, returning true when
 * anything was withdrawn.
 *
 * Freshness and provenance are not enough: a vendor can return a set of figures
 * that are individually "available and fresh" and jointly impossible. Finnhub
 * reported SoFi with `netProfitMarginTTM: -19.79` AND `peTTM: 36.6` - a positive
 * price/EARNINGS ratio requires positive earnings, so a negative net margin beside
 * it is arithmetically impossible. The real company had just posted its tenth
 * consecutive GAAP-profitable quarter, and the bad margin flowed into the score,
 * the fundamentals dimension and the archetype quality gates.
 *
 * When two fields contradict we cannot tell WHICH one is wrong, so both are
 * withdrawn to N/A rather than guessed at. Silence is honest; a coin-flip is not.
 *
 * Exported so every path that assembles fundamentals - the publish invariant and
 * any offline re-scoring harness - applies the identical rule.
 */
export function withdrawContradictoryFundamentals(
  fundamentals: RawFundamentals,
  availability: Partial<Record<keyof RawFundamentals, boolean>>,
): boolean {
  if (!availability.netMargin || !availability.peRatio) return false;
  const pe = fundamentals.peRatio;
  const nm = fundamentals.netMargin;
  const contradiction =
    pe != null && Number.isFinite(pe) && ((pe > 0 && nm < 0) || (pe < 0 && nm > 0));
  if (!contradiction) return false;
  availability.netMargin = false;
  availability.peRatio = false;
  fundamentals.netMargin = unknownFundamentals().netMargin;
  fundamentals.peRatio = unknownFundamentals().peRatio;
  return true;
}

export function enforceFundamentalsPublishInvariant(
  companies: CompanyData[],
  now: number = Date.now(),
): PublishInvariantResult {
  let repaired = 0;
  let missingMap = 0;

  const out = companies.map((company) => {
    const priorMap = company.fundamentalsAvailability;
    const hadMap = !!priorMap;
    if (!hadMap) missingMap++;

    const noLiveData = hasNoLiveMarketData(company);
    const fresh = isFundamentalsFresh(company.fundamentalsAsOf, now);

    const availability = allFalseFundamentalsAvailability();
    const fundamentals: RawFundamentals = { ...unknownFundamentals() };
    let downgraded = false;

    for (const key of FUNDAMENTAL_KEYS) {
      const wasAvailable = priorMap?.[key] === true;
      // A field survives ONLY when it was vouched-for, the record HAS live
      // market data, and the figure is fresh. Anything else is reset to N/A.
      if (wasAvailable && !noLiveData && fresh) {
        availability[key] = true;
        // Carry the real value through with its original (possibly nullable) type.
        (fundamentals[key] as RawFundamentals[typeof key]) = company.fundamentals[key];
      } else if (wasAvailable) {
        downgraded = true; // it claimed available but didn't earn it.
      }
    }

    if (withdrawContradictoryFundamentals(fundamentals, availability)) downgraded = true;

    if (!hadMap || downgraded) repaired++;

    // Untouched (had a map, nothing downgraded) → return the original reference.
    if (hadMap && !downgraded) return company;

    const anyAvailable = FUNDAMENTAL_KEYS.some((k) => availability[k]);
    return {
      ...company,
      fundamentals,
      fundamentalsAvailability: availability,
      fundamentalsAsOf: anyAvailable ? company.fundamentalsAsOf : undefined,
    };
  });

  return { companies: out, repaired, missingMap };
}
