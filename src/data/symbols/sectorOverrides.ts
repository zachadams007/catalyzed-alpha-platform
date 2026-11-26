import type { Sector, StockSignal } from "@/types";

/**
 * Curated sector corrections.
 *
 * Both provider sector mappers (`fmpCompany.mapSector` and
 * `finnhub/liveCompany.sectorFromIndustry`) silently default to `"Technology"`
 * whenever the raw provider sector/industry string doesn't match a known key -
 * which mislabeled a cluster of small/obscure names (gene-editing + clinical
 * biotechs, a plastics recycler, an eVTOL maker, and drone / wave-energy / robotics
 * hardware) as Technology. That corrupts the engine's SECTOR-NEUTRALIZATION (a
 * biotech gets demeaned against semiconductors) and manufactures the scary
 * "57% Technology" board flag.
 *
 * This curated map is the source of truth for those names' sectors. It is applied
 * both at the provider layer ({@link resolveSector}, so the daily scan + live
 * lookups seed the right sector) and once at the store's ingest boundary
 * ({@link overlaySectorOverrides}, mirroring `overlayTrustedMajors`, so an
 * already-published / cached board self-heals without waiting for a rescan). Each
 * entry was verified against the real company.
 */
export const SECTOR_OVERRIDES: Record<string, Sector> = {
  CRSP: "Healthcare", // CRISPR Therapeutics - gene editing
  TNYA: "Healthcare", // Tenaya Therapeutics - cardiovascular gene therapy
  EVMN: "Healthcare", // Evommune - immunology biotech
  PCT: "Materials", // PureCycle Technologies - plastics recycling
  JOBY: "Industrials", // Joby Aviation - eVTOL aircraft
  UMAC: "Industrials", // Unusual Machines - drone / defense hardware
  OPTT: "Industrials", // Ocean Power Technologies - wave-energy hardware
  SYM: "Industrials", // Symbotic - warehouse robotics / automation
  FIP: "Industrials", // FTAI Infrastructure - rail, ports, energy/aviation-leasing infra (found via 2026-07-03 top-pick research)
};

/** The curated sector for a ticker when one exists, else the provider-derived fallback. */
export function resolveSector(ticker: string, fallback: Sector): Sector {
  return SECTOR_OVERRIDES[ticker.trim().toUpperCase()] ?? fallback;
}

/** Overlay curated sector corrections across a universe. Pure; returns a new array. */
export function overlaySectorOverrides(signals: StockSignal[]): StockSignal[] {
  return signals.map((signal) => {
    const override = SECTOR_OVERRIDES[signal.ticker.trim().toUpperCase()];
    return override && override !== signal.sector ? { ...signal, sector: override } : signal;
  });
}
