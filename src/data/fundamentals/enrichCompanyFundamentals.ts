import type { CompanyData } from "@/types";
import {
  applyLiveFundamentalsToCompany,
  fetchFinnhubMetrics,
} from "@/data/finnhub/liveFundamentals";

// Sequential with a gap to stay under Finnhub's free-tier rate limit; a 429
// just yields null -> the fields read "N/A" rather than fabricated numbers.
const GAP_MS = 320;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FundamentalsEnrichProgress {
  done: number;
  total: number;
}

/**
 * Fetch real Finnhub basic financials for the universe and merge them in.
 * Fields the feed doesn't provide are flagged unavailable (shown as "N/A")
 * rather than fabricated.
 */
export async function enrichUniverseWithLiveFundamentals(
  companies: CompanyData[],
  onProgress?: (p: FundamentalsEnrichProgress) => void,
): Promise<CompanyData[]> {
  const out: CompanyData[] = [];
  const total = companies.length;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i]!;
    // Per-name guard (mirrors enrichCompanyNews / enrichCompanyHistory): a single
    // ticker's fetch throwing (timeout/network/parse) must not abort the whole
    // universe enrichment. null -> applyLiveFundamentalsToCompany flags every
    // field unavailable ("N/A"), never a fabricated number. Removes the cross-file
    // dependency on fetchFinnhubMetrics's own internal catch.
    let metric: Awaited<ReturnType<typeof fetchFinnhubMetrics>> = null;
    try {
      metric = await fetchFinnhubMetrics(company.ticker);
    } catch {
      metric = null;
    }
    out.push(applyLiveFundamentalsToCompany(company, metric));
    onProgress?.({ done: i + 1, total });
    if (i < companies.length - 1) await delay(GAP_MS);
  }

  return out;
}
