import type { CompanyData } from "@/types";

type MarketDataState = Pick<CompanyData, "marketDataUnavailable">;

/**
 * True for a REAL listed security we have NO live market data for (a directory-
 * confirmed name the live provider couldn't quote). Every market-derived surface
 * - sector, market cap, P/E, fundamentals, catalyst, momentum, valuation, risk,
 * hype, opportunity score, archetypes, narrative - must render "unavailable"
 * instead of a modeled/seeded value. This is the integrity gate that keeps an
 * uncovered ticker (e.g. GCU.TO) honest-incomplete rather than confidently wrong.
 */
export function isMarketDataUnavailable(c: MarketDataState): boolean {
  return c.marketDataUnavailable === "directory";
}

/**
 * True for a fictional/illustrative profile served for an explicit unknown-ticker
 * lookup (keyless sample mode). Nothing in it is real - surfaces must be labeled
 * "SAMPLE - not live" so a sample number is never mistaken for live market data.
 */
export function isSampleProfile(c: MarketDataState): boolean {
  return c.marketDataUnavailable === "sample";
}

/**
 * True when the record carries no real market data of any kind (directory OR
 * sample) - used where the distinction in copy doesn't matter, only that nothing
 * market-derived should be presented as fact.
 */
export function hasNoLiveMarketData(c: MarketDataState): boolean {
  return c.marketDataUnavailable != null;
}
