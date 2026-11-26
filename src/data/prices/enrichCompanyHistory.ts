import type { CompanyData } from "@/types";
import { pooledMap } from "@/lib/concurrency";
import { applyLiveHistoryToCompany, fetchYahooHistory } from "@/data/prices/yahooHistory";

export interface HistoryEnrichProgress {
  done: number;
  total: number;
}

/** Fetch real Yahoo price history + momentum for the whole universe. */
export async function enrichUniverseWithLiveHistory(
  companies: CompanyData[],
  onProgress?: (p: HistoryEnrichProgress) => void,
): Promise<CompanyData[]> {
  return pooledMap(
    companies,
    5,
    async (company) => {
      try {
        const hist = await fetchYahooHistory(company.ticker);
        return applyLiveHistoryToCompany(company, hist);
      } catch {
        return company;
      }
    },
    (done, total) => onProgress?.({ done, total }),
  );
}
