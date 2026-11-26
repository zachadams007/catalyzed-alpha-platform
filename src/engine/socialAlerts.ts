import type { SocialAlert, StockSignal } from "@/types";
import { externalXSearchUrl } from "@/lib/links";

const SEVERITY_RANK: Record<SocialAlert["severity"], number> = {
  high: 3,
  elevated: 2,
  watch: 1,
};

/**
 * Derive early-warning social alerts from scored signals.
 * Pure function - safe to run after every research / lookup refresh.
 */
export function deriveSocialAlerts(signals: StockSignal[]): SocialAlert[] {
  const alerts: SocialAlert[] = [];

  for (const s of signals) {
    // `socialPosts` is a sample-only enrichment; real-cache signals omit it.
    // Guard so a live signal never throws "socialPosts is not iterable" (which
    // previously crashed the whole view on first StockDetail mount).
    for (const post of s.socialPosts ?? []) {
      if (!post.isPolitical && post.severity === "watch") continue;
      alerts.push({
        id: `post-${s.ticker}-${post.publishedAt}`,
        ticker: s.ticker,
        companyName: s.name,
        kind: "post",
        severity: post.severity,
        title:
          post.isPolitical && post.severity === "high"
            ? `${s.ticker}: High-visibility political mention on X (sample)`
            : `${s.ticker}: Social post flagged`,
        summary: post.text,
        publishedAt: post.publishedAt,
        url: post.url,
        opportunityScore: s.score.opportunityScore,
      });
    }

    if (s.social.xMentions24h >= 5000 && s.social.trendDelta >= 1.2) {
      alerts.push({
        id: `spike-${s.ticker}-${s.generatedAt}`,
        ticker: s.ticker,
        companyName: s.name,
        kind: "mention_spike",
        severity: s.social.trendDelta >= 2 ? "high" : "elevated",
        title: `${s.ticker}: X mention spike (sample scan)`,
        summary: `${s.social.xMentions24h.toLocaleString("en-US")} X mentions / 24h · ${(
          s.social.trendDelta * 100
        ).toFixed(0)}% DoD velocity in sample data.`,
        publishedAt: s.generatedAt,
        url: externalXSearchUrl(s.ticker),
        opportunityScore: s.score.opportunityScore,
      });
    }

    if (s.catalyst.type === "Political" && s.catalyst.magnitude >= 0.5) {
      alerts.push({
        id: `cat-${s.ticker}-${s.generatedAt}`,
        ticker: s.ticker,
        companyName: s.name,
        kind: "political_catalyst",
        severity: s.social.politicalMentions >= 4 ? "high" : "elevated",
        title: `${s.ticker}: Political catalyst active`,
        summary: s.catalyst.description,
        publishedAt: s.generatedAt,
        url: externalXSearchUrl(s.ticker, "political"),
        opportunityScore: s.score.opportunityScore,
      });
    }
  }

  const seen = new Set<string>();
  return alerts
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    })
    .sort((a, b) => {
      const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sev !== 0) return sev;
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });
}

export function countUnseenAlerts(alerts: SocialAlert[], seenIds: string[]): number {
  const seen = new Set(seenIds);
  return alerts.filter((a) => !seen.has(a.id)).length;
}
