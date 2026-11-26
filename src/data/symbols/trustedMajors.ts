import type { StockSignal } from "@/types";
import { MARKET_MAJORS } from "@/data/symbols/majors.generated";

/**
 * Trusted cap + sector overlay for the market-majors backbone.
 *
 * The daily scan derives each name's sector from Finnhub's coarse `finnhubIndustry`
 * and its cap from the live profile2 call. When that per-name profile call is
 * THROTTLED (the free 60/min tier, hit constantly across a 500-name scan), the
 * name falls back to a SYNTHETIC seed whose sector is hashed from the ticker and
 * whose market cap is a placeholder. That is exactly how the published board shipped
 * TSLA as "Real Estate · $5.4T", NVDA as "Materials", and JPM as "Utilities · $11.9T"
 * - scrambled sectors and fabricated mega-caps shown under a "Live data" badge, a
 * direct violation of the no-fake-data rule.
 *
 * The majors roster (`majors.generated.ts`, regenerated weekly from REAL Finnhub
 * industry + cap with curated sector overrides) is the source of truth for these
 * ~200 biggest names. Applied ONCE at the store's ingest boundary so every surface
 * (feed, cards, search, detail, heatmap) renders the corrected values - no per-screen
 * patch, no DB mutation. Off-roster small/mid names are untouched.
 */
const MAJOR = new Map(MARKET_MAJORS.map((m) => [m.ticker.toUpperCase(), m]));

/** Overlay one signal's cap + sector from the trusted roster when it's a major. */
export function overlayTrustedMajor(signal: StockSignal): StockSignal {
  const major = MAJOR.get(signal.ticker.trim().toUpperCase());
  if (!major) return signal;
  const live = signal.marketCap;
  // Keep the live cap only when it's a believable ≤±50% drift from the trusted
  // (weekly) value - a real cap can't move more in a week, so a wild gap means the
  // live value is a synthetic-seed lie (NFLX seeded $4.3T vs a real $0.32T).
  const capOk =
    Number.isFinite(live) && live > 0 && live >= major.marketCap * 0.5 && live <= major.marketCap * 1.6;
  const marketCap = capOk ? live : major.marketCap;
  if (marketCap === signal.marketCap && signal.sector === major.sector) return signal;
  return { ...signal, sector: major.sector, marketCap };
}

/** Map the overlay across a universe. Pure; returns a new array. */
export function overlayTrustedMajors(signals: StockSignal[]): StockSignal[] {
  return signals.map(overlayTrustedMajor);
}
