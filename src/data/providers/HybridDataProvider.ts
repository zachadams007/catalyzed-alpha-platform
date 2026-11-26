import type { CompanyData } from "@/types";
import { FinnhubDataProvider } from "./FinnhubDataProvider";
import { FmpDataProvider } from "./FmpDataProvider";
import type { DataProvider } from "./types";

/**
 * Hybrid live universe.
 *
 * Finnhub gives reliable quote/profile coverage for the curated live list.
 * FMP adds screener-based niche discovery and deeper fundamentals for the
 * names it can hydrate. The research pipeline enriches the merged universe
 * with price history, news, social, and available fundamentals afterward.
 */
export class HybridDataProvider implements DataProvider {
  readonly id = "hybrid";
  readonly name = "Hybrid Live Universe";
  readonly isLive = true;

  async fetchUniverse(): Promise<CompanyData[]> {
    const providers: DataProvider[] = [new FinnhubDataProvider(), new FmpDataProvider()];
    const results = await Promise.allSettled(providers.map((p) => p.fetchUniverse()));

    const byTicker = new Map<string, CompanyData>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const company of result.value) {
        const existing = byTicker.get(company.ticker);
        if (!existing) {
          byTicker.set(company.ticker, company);
          continue;
        }

        const existingLiveFields = Object.values(existing.fundamentalsAvailability ?? {}).filter(Boolean).length;
        const incomingLiveFields = Object.values(company.fundamentalsAvailability ?? {}).filter(Boolean).length;
        if (incomingLiveFields > existingLiveFields) byTicker.set(company.ticker, company);
      }
    }

    const universe = [...byTicker.values()];
    if (universe.length === 0) {
      throw new Error("Hybrid provider returned no data. Check Finnhub/FMP keys and rate limits.");
    }
    return universe;
  }
}
