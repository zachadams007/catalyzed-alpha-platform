import type { CompanyData } from "@/types";
import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { genSocialPosts } from "@/data/socialPosts";
import { seededRandom } from "@/lib/math";
import { MOCK_UNIVERSE } from "@/data/mockSignals";
import type { DataProvider } from "./types";

/**
 * Local, offline provider used for the MVP and for development.
 *
 * It returns the sample universe with a small amount of deterministic jitter
 * per run so that pressing "Scan the Market" feels alive (prices and freshness
 * wobble) while remaining reproducible within a run.
 */
export class MockDataProvider implements DataProvider {
  readonly id = "mock";
  readonly name = "Local Mock Universe";
  readonly isLive = false;

  async fetchUniverse(): Promise<CompanyData[]> {
    // Simulate network/compute latency so the pipeline UI has something to show.
    await new Promise((resolve) => setTimeout(resolve, 450));

    const runSeed = Date.now().toString();
    return MOCK_UNIVERSE.map((company) => {
      const jitter = (seededRandom(`${company.ticker}-${runSeed}`) - 0.5) * 0.02; // +/-1%
      const price = Math.max(0.01, company.price * (1 + jitter));
      const mentionBump = 1 + (seededRandom(`${company.ticker}-x-${runSeed}`) - 0.4) * 0.12;
      const xMentions = Math.round(company.social.xMentions24h * mentionBump);
      const priceSeries = genPriceSeries(
        company.ticker,
        Number(price.toFixed(price < 5 ? 3 : 2)),
        company.momentum.return1M,
        company.volatility.atrPct,
      );
      return {
        ...company,
        price: Number(price.toFixed(price < 5 ? 3 : 2)),
        dayChange: company.dayChange + jitter,
        priceSeries,
        priceHistory: closesFromSeries(priceSeries),
        news: {
          ...company.news,
          freshnessHours: Math.max(1, company.news.freshnessHours - 1),
        },
        social: {
          ...company.social,
          xMentions24h: xMentions,
          trendDelta: company.social.trendDelta + (mentionBump - 1) * 0.5,
        },
        socialPosts: genSocialPosts({
          ticker: company.ticker,
          xMentions,
          political: company.social.politicalMentions,
          socialSummary: company.social.summary,
        }),
      };
    });
  }
}
