import { describe, expect, it } from "vitest";
import { deriveSocialAlerts } from "@/engine/socialAlerts";
import type { StockSignal } from "@/types";

/**
 * Regression: real-cache signals carry the core scored fields (`social`, `score`,
 * `catalyst`) but OMIT the sample-only `socialPosts` enrichment. Before the fix,
 * `for (const post of s.socialPosts)` threw "socialPosts is not iterable", which
 * - with no app-wide error boundary - blanked the whole app on the first
 * StockDetail mount and demanded a full reload.
 *
 * Mirrors the real-cache shape: everything present EXCEPT socialPosts.
 */
function realCacheSignal(overrides: Partial<StockSignal> = {}): StockSignal {
  return {
    ticker: "AAPL",
    name: "Apple",
    generatedAt: new Date().toISOString(),
    social: {
      redditMentions24h: 10,
      xMentions24h: 100,
      politicalMentions: 0,
      sentiment: 0.1,
      trendDelta: 0.1,
      summary: "Measured discussion.",
    },
    catalyst: { type: "Product", description: "Ships soon.", daysAway: 10, magnitude: 0.3 },
    score: { opportunityScore: 70 },
    // socialPosts deliberately absent - as on real-cache signals.
    ...overrides,
  } as unknown as StockSignal;
}

describe("deriveSocialAlerts — tolerates missing socialPosts", () => {
  it("does not throw when a real-cache signal omits socialPosts", () => {
    expect(() => deriveSocialAlerts([realCacheSignal()])).not.toThrow();
  });

  it("does not throw when socialPosts is explicitly undefined", () => {
    expect(() => deriveSocialAlerts([realCacheSignal({ socialPosts: undefined as never })])).not.toThrow();
  });

  it("still derives post alerts when socialPosts IS present (sample mode)", () => {
    const withPosts = realCacheSignal({
      socialPosts: [
        {
          author: "trader",
          text: "Big move",
          url: "https://x.com/x",
          platform: "x",
          publishedAt: new Date().toISOString(),
          severity: "high",
          isPolitical: false,
        },
      ] as never,
    });
    const alerts = deriveSocialAlerts([withPosts]);
    expect(alerts.some((a) => a.kind === "post")).toBe(true);
  });
});
