import type { SocialPost } from "@/types";
import { externalXSearchUrl } from "@/lib/externalUrls";

interface SocialPostInput {
  ticker: string;
  xMentions: number;
  political: number;
  socialSummary: string;
}

/**
 * Sample social posts for the MVP social-attention model.
 * NOT a live X/Twitter feed - simulates what a connected provider would surface.
 */
export function genSocialPosts(input: SocialPostInput): SocialPost[] {
  const { ticker, xMentions, political, socialSummary } = input;
  const now = Date.now();
  const posts: SocialPost[] = [];

  if (xMentions < 400) return posts;

  const severity = political >= 4 || xMentions > 6000 ? "high" : xMentions > 2500 ? "elevated" : "watch";

  posts.push({
    platform: "x",
    author: "Market chatter (sample)",
    handle: "@sample_flow",
    text: `${ticker} mention volume elevated — ${socialSummary}`,
    publishedAt: new Date(now - 3 * 3600 * 1000).toISOString(),
    url: externalXSearchUrl(ticker),
    sentiment: 0.2,
    isPolitical: false,
    severity,
  });

  if (political >= 2) {
    posts.push({
      platform: "x",
      author: "Political-trade tracker (sample)",
      handle: "@sample_politrades",
      text: `Congressional / PAC flow flagged near ${ticker} — sample political-attention signal.`,
      publishedAt: new Date(now - 5 * 3600 * 1000).toISOString(),
      url: externalXSearchUrl(ticker, "congressional trade"),
      sentiment: 0.35,
      isPolitical: true,
      severity: political >= 4 ? "high" : "elevated",
    });
  }

  // PLTX-style election ad-tech: simulate a high-visibility political figure post on X.
  if (ticker === "PLTX" || political >= 5) {
    posts.unshift({
      platform: "x",
      author: "High-profile political figure (sample)",
      handle: "@sample_political",
      text: `[Sample alert] Simulates a viral X post from a major political account referencing ${ticker} / election-ad names — not a live post.`,
      publishedAt: new Date(now - 45 * 60 * 1000).toISOString(),
      url: externalXSearchUrl(ticker, "political"),
      sentiment: 0.48,
      isPolitical: true,
      severity: "high",
    });
  }

  if (xMentions > 3000) {
    posts.push({
      platform: "reddit",
      author: "r/stocks (sample)",
      handle: "u/sample_retail",
      text: `Retail thread activity spiking on ${ticker} (${xMentions.toLocaleString("en-US")} X mentions / 24h in sample data).`,
      publishedAt: new Date(now - 8 * 3600 * 1000).toISOString(),
      url: `https://www.reddit.com/search/?q=${encodeURIComponent(ticker)}`,
      sentiment: 0.15,
      isPolitical: false,
      severity: "watch",
    });
  }

  return posts.slice(0, 4);
}
