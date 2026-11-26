import type { CompanyData } from "@/types";

/**
 * The contract every data source must satisfy.
 *
 * The research engine only ever talks to a `DataProvider`, so swapping the
 * MockDataProvider for a real market-data integration (Alpha Vantage, Finnhub,
 * Polygon, FMP, …) is a one-line change in `getActiveProvider()` and requires
 * zero changes to the scoring engine or UI.
 */
export interface DataProvider {
  /** Stable identifier shown on the Research page (e.g. "mock", "finnhub"). */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** True when the provider is fully wired (false = stub/not-configured). */
  readonly isLive: boolean;

  /**
   * Fetch the candidate universe to be scored. Real providers will fan out to
   * fundamentals / news / social endpoints and assemble `CompanyData`.
   */
  fetchUniverse(): Promise<CompanyData[]>;

  /**
   * Optional one-line, honest summary of how this run's universe was assembled -
   * e.g. the funnel's "5,182 listed → 2,140 passed → top 240 scored". Read by
   * the research pipeline AFTER {@link fetchUniverse} to annotate the run. Most
   * providers don't implement it.
   */
  telemetry?(): string | undefined;
}

export interface ProviderInfo {
  id: string;
  name: string;
  isLive: boolean;
}
