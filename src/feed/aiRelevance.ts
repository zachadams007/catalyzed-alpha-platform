import type { ResearchIntel, ScreenCriteria, StockSignal } from "@/types";
import { clamp } from "@/lib/math";
import { buildNarrativeIntel, scoreNarrativeMatch } from "@/engine/narrativeIntel";

/**
 * AI relevance producer for the Blueprint screener.
 *
 * The hosted research agent (`VITE_RESEARCH_PROXY_URL`) performs a live,
 * web-grounded deep search for the user's thesis and returns {@link ResearchIntel}
 * (a synthesis, bull/bear points, expanded themes, and the real tickers it
 * surfaced). This module turns that intel into a per-ticker `0..100` relevance
 * map that `screenSignals(..., aiRelevance)` consumes for the `ai` mode (and the
 * AI term inside `blended`).
 *
 * The contract is split deliberately:
 *   - the AGENT CALL (impure, network) lives in the store action that owns it;
 *   - `computeAiRelevance` is a PURE, deterministic function of (intel, universe)
 *     so it is trivially testable and re-runs cheaply on every screen tick.
 *
 * This is genuinely different from the local description/theme proxy the engine
 * falls back to offline: the vocabulary here is the agent's *web-researched*
 * findings, not just the words the user typed.
 */

/** The brief + tags handed to the research agent for a relevance pass. */
export interface RelevanceThesis {
  /** Free-text brief (the user's narrative). */
  narrative: string;
  /** Curated theme tags + parsed keywords sent alongside the narrative. */
  themes: string[];
}

/** Optional user-side context fused into the agent's grounded vocabulary. */
export interface RelevanceContext {
  /** Curated theme tag ids (`criteria.themeTags`). */
  themeTags?: string[];
  /** Parsed narrative keywords (`criteria.keywords`). */
  keywords?: string[];
}

/** Build the agent brief from the current screen. Pure. */
export function buildRelevanceThesis(
  description: string,
  criteria: ScreenCriteria,
): RelevanceThesis {
  const themes = [
    ...new Set([...(criteria.themeTags ?? []), ...(criteria.keywords ?? [])]),
  ].slice(0, 16);
  return { narrative: description.trim(), themes };
}

/**
 * Stable cache key for a thesis. Relevance depends on the THESIS (narrative +
 * themes), not the universe membership or horizon - so the agent is called once
 * per distinct thesis while the per-ticker map recomputes freely as the universe
 * changes. Pure.
 */
export function relevanceThesisSignature(thesis: RelevanceThesis): string {
  const themes = [...thesis.themes].map((t) => t.toLowerCase()).sort().join(",");
  return `${thesis.narrative.toLowerCase()}::${themes}`;
}

/** True when a thesis carries enough intent to be worth an agent call. */
export function hasUsableThesis(thesis: RelevanceThesis): boolean {
  return thesis.narrative.length > 0 || thesis.themes.length > 0;
}

/**
 * Turn the agent's grounded intel into a `TICKER → 0..100` relevance map over the
 * given universe. PURE.
 *
 * Scoring:
 *   - **Evidence** - each signal's own narrative blob (thesis, news, social) is
 *     matched against the agent's web-researched vocabulary (summary + bull/bear
 *     prose + expanded themes), reusing the engine's `scoreNarrativeMatch`. This
 *     yields 20..100 and is the "real" relevance signal - the vocabulary came
 *     from the agent's live search, not the user's raw typing.
 *   - **Surfaced names** - tickers the agent explicitly returned as fits for the
 *     thesis get a rank-based floor (rank 0 → 100, decaying), since an explicit,
 *     cited mention is the strongest possible relevance prior. On-page evidence
 *     can lift such a name further but never drops it below its floor.
 *
 * Returns `{}` when the intel has no usable grounding, so the caller passes
 * `undefined` and the engine keeps its local proxy behavior (never breaks
 * offline/mock mode).
 */
export function computeAiRelevance(
  signals: StockSignal[],
  intel: ResearchIntel,
  ctx: RelevanceContext = {},
): Record<string, number> {
  // Grounded vocabulary: fuse the agent's researched prose + expanded themes with
  // the user's own theme tags/keywords.
  const prose = [intel.summary, ...(intel.bullPoints ?? []), ...(intel.bearPoints ?? [])]
    .filter(Boolean)
    .join(" ");
  const vocab = buildNarrativeIntel(prose, ctx.themeTags, [
    ...(intel.themes ?? []),
    ...(ctx.keywords ?? []),
  ]).keywords;

  // Rank map of the real names the agent surfaced for this thesis.
  const suggestionRank = new Map<string, number>();
  (intel.suggestions ?? []).forEach((s, i) => {
    const ticker = s.ticker.trim().toUpperCase();
    if (ticker && !suggestionRank.has(ticker)) suggestionRank.set(ticker, i);
  });

  // No grounding at all → let the engine fall back to its local proxy.
  if (vocab.length === 0 && suggestionRank.size === 0) return {};

  const map: Record<string, number> = {};
  for (const signal of signals) {
    const ticker = signal.ticker.trim().toUpperCase();
    const evidence = scoreNarrativeMatch(signal, vocab).score; // 20..100
    const rank = suggestionRank.get(ticker);
    let relevance: number;
    if (rank != null) {
      const floor = clamp(100 - rank * 5, 72, 100);
      relevance = Math.max(floor, Math.round(0.5 * floor + 0.5 * evidence));
    } else {
      relevance = evidence;
    }
    map[ticker] = Math.round(clamp(relevance, 0, 100));
  }
  return map;
}
