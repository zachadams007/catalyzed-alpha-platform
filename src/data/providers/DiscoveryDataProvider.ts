import type { CompanyData } from "@/types";
import { finnhubKey } from "@/data/http";
import { fetchFinnhubCompany } from "@/data/finnhub/liveCompany";
import { discoverNicheTickers } from "@/data/ai/discoverUniverse";
import { NICHE_ANCHOR_TICKERS } from "@/data/realUniverse";
import type { DataProvider } from "./types";

const GAP_MS = 260;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Keep the run snappy and rate-limit friendly. */
const MAX_UNIVERSE = 48;

/**
 * AI Niche Discovery universe.
 *
 * The candidate list is sourced by the hosted research agent (live web search)
 * across rotating niche themes, then hydrated with the SAME live pipeline the
 * rest of the app uses (Finnhub quote/profile here; Yahoo history, fundamentals,
 * news and social are layered on in runResearch). A specialized anchor set fills
 * any gaps so the feed always has coverage. This is what makes the main feed
 * surface unique, specialized names instead of a fixed mega-cap list.
 *
 * Discovery/research only - the agent never returns buy/sell advice, and every
 * discovered ticker is validated by a live quote before it can be scored.
 */
export class DiscoveryDataProvider implements DataProvider {
  readonly id = "discovery";
  readonly name = "AI Niche Discovery";
  readonly isLive = true;

  async fetchUniverse(): Promise<CompanyData[]> {
    if (!finnhubKey()) {
      throw new Error(
        "AI Discovery needs VITE_FINNHUB_API_KEY to hydrate and validate discovered tickers.",
      );
    }

    let discovered: string[] = [];
    try {
      const result = await discoverNicheTickers();
      discovered = result.tickers;
    } catch {
      /* fall back to anchors below */
    }

    // Discovered niche names lead; anchors backfill for stable coverage.
    const seen = new Set<string>();
    const order: string[] = [];
    for (const raw of [...discovered, ...NICHE_ANCHOR_TICKERS]) {
      const ticker = raw.trim().toUpperCase();
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      order.push(ticker);
      if (order.length >= MAX_UNIVERSE) break;
    }

    const universe: CompanyData[] = [];
    for (let i = 0; i < order.length; i++) {
      // null = no live quote (delisted / unknown / bad ticker) -> skip silently.
      const company = await fetchFinnhubCompany(order[i]!);
      if (company) universe.push(company);
      if (i < order.length - 1) await delay(GAP_MS);
    }

    if (universe.length === 0) {
      throw new Error(
        "AI Discovery returned no hydratable tickers. Check the research proxy, Finnhub key, and rate limits.",
      );
    }
    return universe;
  }
}
