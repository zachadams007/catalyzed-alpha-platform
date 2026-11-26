import type { CompanyData } from "@/types";
import { pooledMap } from "@/lib/concurrency";
import { fetchStockTwitsSocial } from "@/data/social/stocktwits";
import { fetchApeWisdomMention, type ApeWisdomMention } from "@/data/social/apewisdom";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Fold ApeWisdom's Reddit/WSB mention counts into the social signal. Populates
 * `redditMentions24h` (previously always 0) and takes the stronger day-over-day
 * trend between Reddit and StockTwits, since either can be the one that's
 * spiking. Keeps the existing summary and appends a "Reddit/WSB" note.
 */
export function applyApeWisdomToCompany(
  company: CompanyData,
  mention: ApeWisdomMention | null,
): CompanyData {
  if (!mention || mention.mentions <= 0) return company;

  const prev = mention.mentions24hAgo ?? 0;
  const redditTrend =
    prev > 0 ? clamp((mention.mentions - prev) / prev, -1, 2.5) : mention.mentions > 0 ? 1 : 0;

  const rankNote = mention.rank ? ` (#${mention.rank})` : "";
  const note = `Reddit/WSB: ${mention.mentions} mentions${rankNote}`;
  const base = company.social.summary?.trim();

  return {
    ...company,
    social: {
      ...company.social,
      redditMentions24h: mention.mentions,
      trendDelta: Math.max(company.social.trendDelta, redditTrend),
      summary: base ? `${base} · ${note}` : note,
    },
  };
}

/**
 * Replace modeled social fields with live StockTwits attention for real tickers.
 * Keeps the modeled baseline when StockTwits has nothing (thin/illiquid names).
 */
export function applyLiveSocialToCompany(
  company: CompanyData,
  live: Awaited<ReturnType<typeof fetchStockTwitsSocial>>,
): CompanyData {
  if (!live) return company;
  return {
    ...company,
    social: {
      ...company.social,
      ...live.social,
      // preserve any modeled political signal (StockTwits doesn't provide it)
      politicalMentions: company.social.politicalMentions,
    },
    socialPosts: live.posts.length > 0 ? live.posts : company.socialPosts,
  };
}

export interface SocialEnrichProgress {
  done: number;
  total: number;
  ticker?: string;
}

/** Fetch StockTwits attention for the whole universe and merge it in. */
export async function enrichUniverseWithLiveSocial(
  companies: CompanyData[],
  onProgress?: (p: SocialEnrichProgress) => void,
): Promise<CompanyData[]> {
  return pooledMap(
    companies,
    5,
    async (company) => {
      try {
        const [live, ape] = await Promise.all([
          fetchStockTwitsSocial(company.ticker),
          fetchApeWisdomMention(company.ticker).catch(() => null),
        ]);
        return applyApeWisdomToCompany(applyLiveSocialToCompany(company, live), ape);
      } catch {
        return company;
      }
    },
    (done, total) => onProgress?.({ done, total }),
  );
}
