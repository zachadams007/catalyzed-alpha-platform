import type { CompanyData } from "@/types";
import { REAL_UNIVERSE_TICKERS } from "@/data/realUniverse";
import { fetchFinnhubCompany } from "@/data/finnhub/liveCompany";
import { finnhubKey } from "@/data/http";
import type { DataProvider } from "./types";

// Free Finnhub is 60 calls/min. With ~2 calls per name, pace conservatively so a
// single device's daily universe scan stays close to the limit instead of
// bursting into 429s (the keyless/proxy path has no client-side 2nd-key retry).
// Per-ticker failures degrade gracefully (the name is skipped, not fatal).
const GAP_MS = 1100;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Live universe: real U.S. tickers with Finnhub quote + profile.
 * Momentum, social, and fundamentals stay modeled until deeper endpoints ship.
 */
export class FinnhubDataProvider implements DataProvider {
  readonly id = "finnhub";
  readonly name = "Finnhub Live Universe";
  readonly isLive = true;

  async fetchUniverse(): Promise<CompanyData[]> {
    const key = finnhubKey();
    if (!key) {
      throw new Error(
        "Finnhub provider requires VITE_FINNHUB_API_KEY in .env. Get a free key at https://finnhub.io/register",
      );
    }

    const companies: CompanyData[] = [];

    for (let i = 0; i < REAL_UNIVERSE_TICKERS.length; i++) {
      const ticker = REAL_UNIVERSE_TICKERS[i]!;
      const row = await fetchFinnhubCompany(ticker);
      if (row) companies.push(row);
      if (i < REAL_UNIVERSE_TICKERS.length - 1) await delay(GAP_MS);
    }

    if (companies.length === 0) {
      throw new Error(
        "Finnhub returned no quotes for the research universe. Check your API key and rate limits.",
      );
    }

    return companies;
  }
}
