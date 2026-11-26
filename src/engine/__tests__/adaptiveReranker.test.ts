import { describe, expect, it } from "vitest";

import {
  INACTIVE_ADAPTIVE_RERANKER,
  scoreAdaptiveRerankerInShadow,
  type AdaptiveReranker,
} from "@/engine/adaptiveReranker";

const candidates = [
  { ticker: "AAA", baselineScore: 81, features: { catalyst: 0.8 } },
  { ticker: "BBB", baselineScore: 55, features: { catalyst: null } },
];

describe("adaptive reranker shadow boundary", () => {
  it("never changes a published score while inactive", () => {
    const results = scoreAdaptiveRerankerInShadow(INACTIVE_ADAPTIVE_RERANKER, candidates);
    expect(results.map((result) => result.publishedScore)).toEqual([81, 55]);
    expect(results.every((result) => result.shadowScore == null && result.applied === false)).toBe(true);
  });

  it("records a shadow score but still never applies it", () => {
    const shadow: AdaptiveReranker = {
      id: "test-shadow",
      mode: "shadow",
      predict: (features) => (features.catalyst ?? 0) * 100,
    };
    const results = scoreAdaptiveRerankerInShadow(shadow, candidates);
    expect(results[0]).toMatchObject({ publishedScore: 81, shadowScore: 80, applied: false });
    expect(results[1]).toMatchObject({ publishedScore: 55, shadowScore: 0, applied: false });
  });
});
