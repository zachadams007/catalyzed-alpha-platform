import type { Sector, StockSignal } from "@/types";
import { researchRankScore } from "@/engine/ranking";

/**
 * Feed selection logic for the non-personalized feeds.
 *
 * - Today: a tight, high-conviction set with light sector diversity so the
 *   daily feed doesn't become five flavors of the same trade.
 * - Weekly: a broader leaderboard of the week's strongest signals.
 *
 * "For You" is handled separately by feedAlgorithm.personalize().
 */

export const TODAY_LIMIT = 8;
export const WEEKLY_LIMIT = 16;
/** Max names per sector on the Today board (soft - tops up if thin). The
 *  Algorithm-tab explainer (viz/pipelineModel FEED_RULES) renders this SAME
 *  constant, so the user-facing copy can never drift from the engine again. */
export const TODAY_SECTOR_CAP = 3;
/** Max names per sector on the weekly leaderboard (owner request 2026-07-01): keep the week
 *  view diversified so it isn't 8 flavors of the same sector. */
export const WEEKLY_SECTOR_CAP = 4;

/**
 * Max gap (display points) the Today feed will span below the day's best pick. Names below the
 * floor are used ONLY when there aren't enough strong names to fill the feed, so the band stays
 * tight and plausible (e.g. 91 → ~71, never 91 → 53).
 */
export const MAX_TODAY_SPREAD = 20;

/** Feed tab ids for pages that list scored signal cards. */
export type FeedTabId = "today" | "for-you" | "weekly" | "watchlist";

export const FEED_TAB_LABELS: Record<FeedTabId, string> = {
  today: "Today",
  "for-you": "For You",
  weekly: "This Week",
  watchlist: "Watchlist",
};

/**
 * One-line educational subtitles - must match the selection logic in this file
 * and personalize() in feedAlgorithm.ts.
 */
export const FEED_TAB_SUBTITLES: Record<FeedTabId, string> = {
  today: `The ${TODAY_LIMIT} strongest setups from today's run — kept to a tight quality band (no filler picks far below the day's best), lightly diversified across sectors with a cap on giant companies so small- and mid-caps can surface, and limited to names liquid enough to actually fill.`,
  weekly: `The top ${WEEKLY_LIMIT} signals from the latest run, ranked by score with at most ${WEEKLY_SECTOR_CAP} per sector so the week isn't one crowded theme.`,
  "for-you":
    "Every scored stock, reordered to match your likes, your tuning, and your horizon — with filter chips that snap the feed to a type (early + catalyst, emerging themes, reversals, breakouts, smart money) in real time.",
  watchlist: "Stocks you saved to watch, rescored on every research run.",
};

/** Per-signal ranking score. The default is the shared evidence-tilted score;
 *  the For-You risk dial passes a risk-adjusted variant (a prefs-aware wrapper,
 *  so `ranking.ts` itself stays global and prefs-free). */
export type RankScoreFn = (signal: StockSignal) => number;

const byScoreWith =
  (scoreFn: RankScoreFn) =>
  (a: StockSignal, b: StockSignal): number =>
    scoreFn(b) - scoreFn(a);

/** Cap-tier thresholds (USD), matching the engine's cap-balance regression guard. */
const MEGA_CAP_USD = 200e9;
const LARGE_CAP_USD = 10e9;

/**
 * FILLABILITY FLOOR (2026-07-02): the actionable feeds (Today + This Week)
 * should only surface names a person can realistically get FILLED at a retail broker - a
 * small retail order that fills promptly near the quote, not one that sits unfilled
 * for hours while the price drifts. Below ~$2M/day in dollar volume a retail order
 * can't be counted on to fill cleanly, so those names are held OUT of the actionable
 * feeds. They stay fully scored, searchable, and resolvable everywhere else - this
 * is a feed-ELIGIBILITY floor, not a scoring change, and it honors the
 * universal-coverage lock. A live dated catalyst overrides the floor: an
 * event-driven name is worth surfacing even when thin.
 */
export const FILLABLE_MIN_DOLLAR_VOL = 2_000_000;

function isFillable(s: StockSignal): boolean {
  return (s.liquidity?.avgDollarVolume ?? 0) >= FILLABLE_MIN_DOLLAR_VOL || s.catalystLive === true;
}

/**
 * Keep only names a retail order can realistically fill, but NEVER empty the feed:
 * if fewer than `limit` fillable names exist (a tiny/degenerate universe), fall back
 * to the full sorted set so the feed still returns a board.
 */
function fillablePool(sorted: StockSignal[], limit: number): StockSignal[] {
  const fillable = sorted.filter(isFillable);
  return fillable.length >= limit ? fillable : sorted;
}

/**
 * Pool-adaptive cap-tier ceilings for the daily board. The live broad-universe
 * scan force-seeds the ~200 biggest names (the Market Map backbone) into the
 * scored pool, so the pool is mega-FLOODED and the gentle, cap-neutral engine
 * tilt alone still yields an "all large-cap" Today. These are UPPER BOUNDS, not
 * quotas: on an already-balanced / small-cap-heavy pool they never bind (so the
 * feed is unchanged and the engine's own cap-balance is respected), but on the
 * flooded pool they demote the surplus mega/large names so genuine small/mid
 * discovery surfaces. The top-up pass below guarantees a full `limit` either way.
 *   • mega  ≤ 25% of the board  (the spec's mega ceiling)
 *   • large+mega ≤ 50% of the board (so small/mid discovery is at least half)
 */
function capTierCeilings(limit: number): { mega: number; largeMega: number } {
  return {
    mega: Math.max(1, Math.ceil(limit * 0.25)),
    largeMega: Math.max(2, Math.ceil(limit * 0.5)),
  };
}

/**
 * Top signals with soft diversity caps - at most 3 per sector AND pool-adaptive
 * cap-tier ceilings (so the daily board never becomes all mega-cap) - so the
 * Today feed feels curated. Falls back to pure score if diversity can't fill it.
 * An optional `scoreFn` lets a caller tilt the ranking (e.g. the risk dial)
 * without changing the global ranking model.
 */
export function selectToday(
  signals: StockSignal[],
  limit = TODAY_LIMIT,
  scoreFn: RankScoreFn = researchRankScore,
): StockSignal[] {
  const sortedAll = [...signals].sort(byScoreWith(scoreFn));
  if (sortedAll.length === 0) return [];
  // FILLABILITY FLOOR: hold out names too illiquid to fill promptly at a retail broker
  // (never empties the feed - falls back to the full set on a thin universe).
  const sorted = fillablePool(sortedAll, limit);

  // QUALITY FLOOR: the day's best pick sets a band; the diversity/cap caps below
  // may REORDER among genuinely-strong names but must never pad the feed with a
  // name far below it. So we run the caps over the strong band first, and only dip
  // below the floor if there aren't `limit` strong names to fill the feed.
  const topOpp = Math.max(...sorted.map((s) => s.score.opportunityScore));
  const floor = topOpp - MAX_TODAY_SPREAD;
  const strong = sorted.filter((s) => s.score.opportunityScore >= floor);
  const pool = strong.length >= limit ? strong : sorted;

  const perSector = new Map<Sector, number>();
  const ceil = capTierCeilings(limit);
  let megaCount = 0;
  let largeMegaCount = 0;
  const picked: StockSignal[] = [];

  for (const s of pool) {
    if (picked.length >= limit) break;
    const count = perSector.get(s.sector) ?? 0;
    if (count >= TODAY_SECTOR_CAP) continue;
    const cap = s.marketCap;
    const isMega = cap >= MEGA_CAP_USD;
    const isLargeOrMega = cap >= LARGE_CAP_USD;
    if (isMega && megaCount >= ceil.mega) continue;
    if (isLargeOrMega && largeMegaCount >= ceil.largeMega) continue;
    perSector.set(s.sector, count + 1);
    if (isMega) megaCount += 1;
    if (isLargeOrMega) largeMegaCount += 1;
    picked.push(s);
  }

  // Top up if the diversity/cap caps left us short: prefer the next-best STRONG
  // names (still inside the band) before ever dipping to weaker names, so the feed
  // stays a tight, plausible set rather than a 91-down-to-53 spread.
  if (picked.length < limit) {
    for (const s of pool) {
      if (picked.length >= limit) break;
      if (!picked.includes(s)) picked.push(s);
    }
  }
  if (picked.length < limit) {
    for (const s of sorted) {
      if (picked.length >= limit) break;
      if (!picked.includes(s)) picked.push(s);
    }
  }

  // The evidence-tilted researchRankScore + diversity/cap caps above decide WHICH names make the
  // board; ordering the final set by the SHOWN opportunityScore keeps the label honest without
  // changing selection or the scoring engine.
  return [...picked].sort((a, b) => b.score.opportunityScore - a.score.opportunityScore);
}

export function selectWeekly(
  signals: StockSignal[],
  limit = WEEKLY_LIMIT,
  scoreFn: RankScoreFn = researchRankScore,
): StockSignal[] {
  // Fillability floor (see selectToday) - the weekly leaderboard is actionable too.
  const sorted = fillablePool([...signals].sort(byScoreWith(scoreFn)), limit);
  // Soft sector cap so the week's leaderboard isn't one crowded theme (the owner). It's
  // an UPPER BOUND, not a quota: we take the strongest names first, skipping a sector
  // once it hits the cap, then top up with the next-best names if the caps left us
  // short - so a limit-length board is always returned, just more diversified.
  const perSector = new Map<Sector, number>();
  const picked: StockSignal[] = [];
  for (const s of sorted) {
    if (picked.length >= limit) break;
    const count = perSector.get(s.sector) ?? 0;
    if (count >= WEEKLY_SECTOR_CAP) continue;
    perSector.set(s.sector, count + 1);
    picked.push(s);
  }
  if (picked.length < limit) {
    for (const s of sorted) {
      if (picked.length >= limit) break;
      if (!picked.includes(s)) picked.push(s);
    }
  }
  // DISPLAY ORDER: same honesty fix as selectToday - the leaderboard reads top-down
  // by the visible score, so the number on each row never contradicts its rank.
  return [...picked].sort((a, b) => b.score.opportunityScore - a.score.opportunityScore);
}
