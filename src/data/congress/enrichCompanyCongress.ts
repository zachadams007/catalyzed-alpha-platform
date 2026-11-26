import type { CompanyData, CongressTrade } from "@/types";
import { fetchCongressTrades, recentTradeCount } from "@/data/congress/congressTrades";

/**
 * Fold free congressional-trade disclosures into the political-attention signal.
 *
 * We bump `social.politicalMentions` (which the scoring engine already rewards)
 * by the count of recent disclosed trades, annotate the social summary, and
 * attach the raw trades so the hype layer and detail view can show "who bought".
 * Keeps the modeled baseline when a ticker has no disclosures.
 */

const LOOKBACK_DAYS = 120;

function summarize(trades: CongressTrade[], recent: number): string {
  const buys = trades.filter((t) => t.transaction === "buy").length;
  const sells = trades.filter((t) => t.transaction === "sell").length;
  const parts: string[] = [];
  if (buys > 0) parts.push(`${buys} buy${buys === 1 ? "" : "s"}`);
  if (sells > 0) parts.push(`${sells} sell${sells === 1 ? "" : "s"}`);
  const mix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const window = recent > 0 ? ` in ${LOOKBACK_DAYS}d` : "";
  const count = recent > 0 ? recent : trades.length;
  return `Congress: ${count} disclosed trade${count === 1 ? "" : "s"}${mix}${window}`;
}

export function applyCongressToCompany(
  company: CompanyData,
  trades: CongressTrade[],
): CompanyData {
  if (trades.length === 0) return company;

  const recent = recentTradeCount(trades, LOOKBACK_DAYS);
  // Prefer recent activity for scoring; fall back to total when the dataset lags.
  const mentions = recent > 0 ? recent : Math.min(trades.length, 3);
  const congressNote = summarize(trades, recent);
  const baseSummary = company.social.summary?.trim();

  return {
    ...company,
    social: {
      ...company.social,
      politicalMentions: Math.max(company.social.politicalMentions, mentions),
      summary: baseSummary ? `${baseSummary} · ${congressNote}` : congressNote,
    },
    congressTrades: trades,
  };
}

export interface CongressEnrichProgress {
  done: number;
  total: number;
  ticker?: string;
}

/**
 * Attach congressional-trade disclosures across the universe. The first lookup
 * triggers the one-time dataset load (module-cached); the rest are Map hits.
 */
export async function enrichUniverseWithCongress(
  companies: CompanyData[],
  onProgress?: (p: CongressEnrichProgress) => void,
): Promise<CompanyData[]> {
  const out: CompanyData[] = [];
  const total = companies.length;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i]!;
    onProgress?.({ done: i, total, ticker: company.ticker });
    try {
      const trades = await fetchCongressTrades(company.ticker);
      out.push(applyCongressToCompany(company, trades));
    } catch {
      out.push(company);
    }
  }

  onProgress?.({ done: total, total });
  return out;
}
