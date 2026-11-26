import type { CompanyData } from "@/types";
import { fmpKey } from "@/data/http";
import { discoverFmpUniverse } from "@/data/fmp/fmpUniverse";
import { fetchFmpCompany } from "@/data/fmp/fmpCompany";
import { REAL_UNIVERSE_TICKERS } from "@/data/realUniverse";
import type { DataProvider } from "./types";

const GAP_MS = 220;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DISCOVERY_LIMIT = 140;
const DISCOVERY_DETAIL_LIMIT = 42;

/**
 * Financial Modeling Prep universe.
 *
 * Combines a curated core (reliable large/mid caps, live fundamentals) with
 * dynamically screened niche names - so coverage isn't capped to a fixed list.
 */
export class FmpDataProvider implements DataProvider {
  readonly id = "fmp";
  readonly name = "Financial Modeling Prep";
  readonly isLive = true;

  async fetchUniverse(): Promise<CompanyData[]> {
    if (!fmpKey()) {
      throw new Error(
        "FMP provider requires VITE_FMP_API_KEY in .env. Get a free key at https://site.financialmodelingprep.com/developer/docs",
      );
    }

    const byTicker = new Map<string, CompanyData>();

    // 1) Curated core - enriched with live fundamentals.
    const core = REAL_UNIVERSE_TICKERS.slice(0, 20);
    for (let i = 0; i < core.length; i++) {
      const company = await fetchFmpCompany(core[i]!);
      if (company) byTicker.set(company.ticker, company);
      if (i < core.length - 1) await delay(GAP_MS);
    }

    // 2) Niche discovery via screener (cheap - one call per screen).
    try {
      const discovered = await discoverFmpUniverse(DISCOVERY_LIMIT);
      const newCandidates = discovered.filter((c) => !byTicker.has(c.ticker));
      for (const c of newCandidates) byTicker.set(c.ticker, c);

      for (let i = 0; i < Math.min(newCandidates.length, DISCOVERY_DETAIL_LIMIT); i++) {
        const hydrated = await fetchFmpCompany(newCandidates[i]!.ticker);
        if (hydrated) byTicker.set(hydrated.ticker, hydrated);
        if (i < DISCOVERY_DETAIL_LIMIT - 1) await delay(GAP_MS);
      }
    } catch {
      /* screener optional - core still returns */
    }

    const universe = [...byTicker.values()];
    if (universe.length === 0) {
      throw new Error("FMP returned no data. Check your API key and rate limits.");
    }
    return universe;
  }
}
