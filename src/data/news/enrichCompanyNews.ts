import type { CompanyData, NewsItem } from "@/types";
import { fetchLiveNews } from "@/data/news/liveNews";
import { sentimentFromHeadlines } from "@/engine/catalystFromNews";
import { isDirectNewsUrl } from "@/lib/links";

const GAP_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hoursSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 48;
  return Math.max(1, (Date.now() - t) / 3_600_000);
}

/** Merge live headlines (NOT a catalyst) into one company record. */
export function applyLiveNewsToCompany(company: CompanyData, items: NewsItem[]): CompanyData {
  const live = items.filter((n) => isDirectNewsUrl(n.url));
  if (live.length === 0) return company;

  const freshnessHours = Math.round(hoursSince(live[0]!.publishedAt));
  const newsSources = live.slice(0, 3).map((n) => ({
    label: n.source,
    url: n.url,
    publishedAt: n.publishedAt,
  }));

  return {
    ...company,
    // News is NEWS - it is NEVER converted into a catalyst. A headline does not
    // imply a dated catalyst, and inferring one (the old inferCatalystFromNews)
    // fabricated a typed "catalyst landing today" with a made-up magnitude on
    // every name that had news - e.g. a generic "CAN SLIM criteria" article
    // became a "Regulatory catalyst, magnitude 0.85" on ANET, inflating its score
    // and ranking. `catalyst` / `catalystLive` are left exactly as the company
    // carries them (no-catalyst until the structured catalyst-events stage finds a
    // REAL event). We still surface the headlines + their sentiment.
    news: {
      items: live,
      sentiment: sentimentFromHeadlines(live),
      count7d: Math.max(live.length, Math.min(25, company.news.count7d)),
      freshnessHours,
    },
    sources: [...newsSources, ...company.sources.filter((s) => !s.url.includes("example-research.local"))],
  };
}

export interface NewsEnrichProgress {
  done: number;
  total: number;
  ticker?: string;
}

/**
 * Fetch live news for each company (Finnhub → Yahoo RSS) and attach to CompanyData.
 * Used during the research pipeline news stage.
 */
export async function enrichUniverseWithLiveNews(
  companies: CompanyData[],
  onProgress?: (p: NewsEnrichProgress) => void,
): Promise<CompanyData[]> {
  const out: CompanyData[] = [];
  const total = companies.length;

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i]!;
    onProgress?.({ done: i, total, ticker: company.ticker });

    let items: NewsItem[] = [];
    try {
      items = await fetchLiveNews(company.ticker, { includeHighFanoutSources: false });
    } catch {
      items = [];
    }

    out.push(applyLiveNewsToCompany(company, items));
    if (i < companies.length - 1) await delay(GAP_MS);
  }

  onProgress?.({ done: total, total });
  return out;
}
