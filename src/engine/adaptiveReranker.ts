import { clamp, round } from "@/lib/math";

/**
 * A learned reranker is deliberately restricted to inactive or shadow mode.
 * Shadow results are persisted/evaluated elsewhere, but this adapter never
 * changes a signal's published score or ordering. A separate root-owned
 * promotion process must wire any validated candidate into production.
 */
export type AdaptiveRerankerMode = "inactive" | "shadow";

export interface AdaptiveRerankerCandidate {
  ticker: string;
  baselineScore: number;
  features: Readonly<Record<string, number | null>>;
}
export interface AdaptiveReranker {
  id: string;
  mode: AdaptiveRerankerMode;
  /** Fitted only from an approved point-in-time walk-forward training fold. */
  predict(features: Readonly<Record<string, number | null>>): number | null;
}

export interface ShadowRerankResult {
  ticker: string;
  publishedScore: number;
  shadowScore: number | null;
  applied: false;
  explanation: string;
}

export const INACTIVE_ADAPTIVE_RERANKER: AdaptiveReranker = {
  id: "unvalidated-learning-loop",
  mode: "inactive",
  predict: () => null,
};

/**
 * Score a candidate model for evaluation without changing the feed contract.
 * Non-finite candidate output is treated as unavailable rather than coerced.
 */
export function scoreAdaptiveRerankerInShadow(
  reranker: AdaptiveReranker,
  candidates: readonly AdaptiveRerankerCandidate[],
): ShadowRerankResult[] {
  return candidates.map((candidate) => {
    const raw = reranker.mode === "shadow" ? reranker.predict(candidate.features) : null;
    const shadowScore = raw != null && Number.isFinite(raw) ? round(clamp(raw), 2) : null;
    return {
      ticker: candidate.ticker,
      publishedScore: candidate.baselineScore,
      shadowScore,
      applied: false,
      explanation:
        reranker.mode === "shadow"
          ? shadowScore == null
            ? "Shadow model returned no valid score; published ranking is unchanged."
            : "Shadow score recorded for walk-forward evaluation; published ranking is unchanged."
          : "Adaptive reranker is inactive; published ranking is unchanged.",
    };
  });
}
