import type {
  InteractionEvent,
  MarketCapBucket,
  StockSignal,
  TradeHorizon,
  UserPreferences,
} from "@/types";
import { horizonCategoryWeights } from "@/engine/screen";
import { researchRankScore } from "@/engine/ranking";
import { TRADE_HORIZON_LABELS } from "@/types";
import { shiftHorizon } from "@/lib/tradeHorizon";
import { clamp } from "@/lib/math";
import { riskAdjustedRankScore } from "@/feed/riskTilt";

/**
 * Personalization engine for the "For You" feed.
 *
 * Two pure functions:
 *   - applyInteraction(): fold a single user action into the preference vector.
 *   - personalize(): re-rank a set of signals against that vector, returning a
 *     0..100 match score plus human-readable reasons ("why am I seeing this?").
 *
 * Everything is pure and serializable so the Zustand store can persist it and
 * a future backend can recompute it server-side. See docs/feed-algorithm.md.
 */

const CAP_ORDER: MarketCapBucket[] = ["Nano", "Micro", "Small", "Mid", "Large", "Mega"];

const WEIGHT_MIN = -3;
const WEIGHT_MAX = 3;

export function defaultPreferences(): UserPreferences {
  return {
    sectorWeights: {},
    capWeights: {},
    catalystWeights: {},
    styleTilt: 0,
    riskAppetite: 0.55,
    likedTickers: [],
    mutedTickers: [],
    tradeHorizon: "swing_trading",
    // Default lean toward discounted-with-a-catalyst, the archetype the user
    // explicitly wants prioritized over names that already ran to highs.
    archetypeTilt: 0.35,
  };
}

const ARCHETYPE_MIN = 0;
const ARCHETYPE_MAX = 1;

/**
 * "Discounted + catalyst, not chasing highs" alignment for one signal, -1..1.
 * +1 = healthy discount with a live catalyst; -1 = extended / near highs with
 * momentum running hot (the setup the user wants pushed DOWN).
 */
function archetypeAxis(signal: StockSignal): number {
  const cats = signal.score.categories;
  const get = (k: string) => cats.find((c) => c.key === k)?.score ?? 50;
  const discount = get("valuation"); // high = discounted entry, low = near highs
  const catalystHeat = (get("catalyst") + get("news")) / 2;
  const momentum = get("momentum");
  const discountCatalyst =
    ((discount - 50) / 50) * 0.6 + ((catalystHeat - 50) / 50) * 0.4;
  // Extra penalty for "already ran" names: low discount + hot momentum.
  const chasing = discount < 40 && momentum > 65 ? (momentum - 65) / 70 : 0;
  return clamp(discountCatalyst - chasing, -1, 1);
}

/** Nudge the discount+catalyst dial up ("more") or down ("less"). */
export function tuneArchetypeTilt(current: number, dir: "more" | "less"): number {
  const delta = dir === "more" ? 0.18 : -0.18;
  return clamp(current + delta, ARCHETYPE_MIN, ARCHETYPE_MAX);
}

function bump<K extends string>(
  map: Partial<Record<K, number>>,
  key: K,
  delta: number,
): Partial<Record<K, number>> {
  const next = { ...map };
  next[key] = clamp((next[key] ?? 0) + delta, WEIGHT_MIN, WEIGHT_MAX);
  return next;
}

function addUnique(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value];
}

function remove(list: string[], value: string): string[] {
  return list.filter((v) => v !== value);
}

/** Shift cap affinity toward larger (dir=+1) or smaller (dir=-1) names. */
function shiftCapPreference(
  weights: Partial<Record<MarketCapBucket, number>>,
  pivot: MarketCapBucket,
  dir: 1 | -1,
): Partial<Record<MarketCapBucket, number>> {
  const pivotIndex = CAP_ORDER.indexOf(pivot);
  const next = { ...weights };
  CAP_ORDER.forEach((bucket, i) => {
    // Reward buckets in the requested direction relative to the current one.
    const relative = (i - pivotIndex) * dir;
    if (relative > 0) next[bucket] = clamp((next[bucket] ?? 0) + 0.4, WEIGHT_MIN, WEIGHT_MAX);
    else if (relative < 0) next[bucket] = clamp((next[bucket] ?? 0) - 0.2, WEIGHT_MIN, WEIGHT_MAX);
  });
  return next;
}

export function applyInteraction(
  prefs: UserPreferences,
  event: InteractionEvent,
): UserPreferences {
  const next: UserPreferences = {
    ...prefs,
    sectorWeights: { ...prefs.sectorWeights },
    capWeights: { ...prefs.capWeights },
    catalystWeights: { ...prefs.catalystWeights },
    likedTickers: [...prefs.likedTickers],
    mutedTickers: [...prefs.mutedTickers],
  };

  switch (event.kind) {
    case "like":
      next.likedTickers = addUnique(next.likedTickers, event.ticker);
      next.mutedTickers = remove(next.mutedTickers, event.ticker);
      next.sectorWeights = bump(next.sectorWeights, event.sector, 0.6);
      next.catalystWeights = bump(next.catalystWeights, event.catalystType, 0.4);
      break;
    case "more_like_this":
      next.sectorWeights = bump(next.sectorWeights, event.sector, 0.8);
      next.catalystWeights = bump(next.catalystWeights, event.catalystType, 0.5);
      next.capWeights = bump(next.capWeights, event.marketCapBucket, 0.4);
      break;
    case "less_like_this":
      next.sectorWeights = bump(next.sectorWeights, event.sector, -0.6);
      next.catalystWeights = bump(next.catalystWeights, event.catalystType, -0.3);
      next.mutedTickers = addUnique(next.mutedTickers, event.ticker);
      break;
    case "higher_market_cap":
      next.capWeights = shiftCapPreference(next.capWeights, event.marketCapBucket, 1);
      // Implicit nudges only apply while the user hasn't set the dial by hand.
      if (!next.riskAppetiteLocked) next.riskAppetite = clamp(next.riskAppetite - 0.05, 0, 1);
      break;
    case "lower_market_cap":
      next.capWeights = shiftCapPreference(next.capWeights, event.marketCapBucket, -1);
      if (!next.riskAppetiteLocked) next.riskAppetite = clamp(next.riskAppetite + 0.05, 0, 1);
      break;
    case "more_sector":
      next.sectorWeights = bump(next.sectorWeights, event.sector, 1.0);
      break;
    case "less_sector":
      next.sectorWeights = bump(next.sectorWeights, event.sector, -1.0);
      break;
    case "more_catalyst_driven":
      next.styleTilt = clamp(next.styleTilt + 0.25, -1, 1);
      next.catalystWeights = bump(next.catalystWeights, event.catalystType, 0.3);
      break;
    case "more_fundamentals_driven":
      next.styleTilt = clamp(next.styleTilt - 0.25, -1, 1);
      break;
    case "shorter_horizon":
      next.tradeHorizon = shiftHorizon(next.tradeHorizon ?? "swing_trading", "shorter");
      break;
    case "longer_horizon":
      next.tradeHorizon = shiftHorizon(next.tradeHorizon ?? "swing_trading", "longer");
      break;
    case "add_to_portfolio":
    case "save_watchlist":
      next.sectorWeights = bump(next.sectorWeights, event.sector, 0.3);
      next.catalystWeights = bump(next.catalystWeights, event.catalystType, 0.2);
      break;
    case "share":
    case "view_detail":
      next.sectorWeights = bump(next.sectorWeights, event.sector, 0.1);
      break;
  }

  return next;
}

export interface RankedSignal {
  signal: StockSignal;
  matchScore: number;
  reasons: string[];
}

/**
 * "catalyst-driven-ness" of a signal: +1 fully catalyst/momentum led,
 * -1 fully fundamentals led. Used to align with the user's styleTilt.
 */
function styleAxis(signal: StockSignal): number {
  const cats = signal.score.categories;
  const get = (k: string) => cats.find((c) => c.key === k)?.score ?? 50;
  const catalystSide = (get("catalyst") + get("momentum") + get("social")) / 3;
  const fundamentalSide = (get("fundamentals") + get("growth")) / 2;
  return clamp((catalystSide - fundamentalSide) / 50, -1, 1);
}

/** Normalized 0..1 "how aggressive is this name" proxy. */
function aggression(signal: StockSignal): number {
  const volScore = signal.score.categories.find((c) => c.key === "volatility")?.score ?? 50;
  const capFactor =
    signal.marketCapBucket === "Nano" || signal.marketCapBucket === "Micro"
      ? 1
      : signal.marketCapBucket === "Small"
        ? 0.7
        : signal.marketCapBucket === "Mid"
          ? 0.45
          : 0.2;
  return clamp((volScore / 100) * 0.6 + capFactor * 0.4, 0, 1);
}

export function personalize(signals: StockSignal[], prefs: UserPreferences): RankedSignal[] {
  const ranked = signals.map((signal) => {
    const reasons: string[] = [];
    let boost = 0;

    const sectorW = prefs.sectorWeights[signal.sector] ?? 0;
    if (sectorW !== 0) {
      boost += sectorW * 5;
      if (sectorW > 0) reasons.push(`Matches your interest in ${signal.sector}`);
    }

    const capW = prefs.capWeights[signal.marketCapBucket] ?? 0;
    if (capW !== 0) {
      boost += capW * 4;
      if (capW > 0) reasons.push(`${signal.marketCapBucket}-cap, like you've favored`);
    }

    const catW = prefs.catalystWeights[signal.catalystType] ?? 0;
    if (catW !== 0) {
      boost += catW * 4;
      if (catW > 0) reasons.push(`${signal.catalystType} catalysts match your taps`);
    }

    // Style alignment: closer to the user's tilt = higher boost.
    const styleAlignment = 1 - Math.abs(styleAxis(signal) - prefs.styleTilt) / 2; // 0..1
    boost += (styleAlignment - 0.5) * 10;
    if (prefs.styleTilt > 0.3 && styleAxis(signal) > 0.3) reasons.push("Catalyst / momentum-driven");
    if (prefs.styleTilt < -0.3 && styleAxis(signal) < -0.3) reasons.push("Fundamentals-driven");

    // Risk appetite alignment.
    const riskAlignment = 1 - Math.abs(aggression(signal) - prefs.riskAppetite);
    boost += (riskAlignment - 0.5) * 8;

    if (prefs.likedTickers.includes(signal.ticker)) {
      boost += 14;
      reasons.push("You liked this");
    }
    if (prefs.mutedTickers.includes(signal.ticker)) {
      boost -= 30;
      reasons.push("You asked for less like this");
    }

    const hWeights = horizonCategoryWeights(prefs.tradeHorizon ?? "swing_trading");
    let horizonBoost = 0;
    for (const cat of signal.score.categories) {
      const w = hWeights[cat.key];
      if (w != null && w > 0) horizonBoost += ((cat.score - 50) / 50) * w * 8;
    }
    boost += horizonBoost;
    if (horizonBoost > 2) {
      const label = `${TRADE_HORIZON_LABELS[prefs.tradeHorizon ?? "swing_trading"]} fit`;
      reasons.push(label);
    }

    // Discount-with-catalyst archetype: lean toward discounted names with a live
    // catalyst, push down names that already ran to highs. Scaled by the dial.
    const archetypeTilt = prefs.archetypeTilt ?? 0.35;
    const archetype = archetypeAxis(signal);
    boost += archetype * archetypeTilt * 16;
    if (archetypeTilt > 0.3 && archetype > 0.35) reasons.push("Discounted with a live catalyst");
    else if (archetypeTilt > 0.3 && archetype < -0.35) reasons.push("Near highs — entry looks stretched");

    if (signal.confidence < 55) reasons.push("Limited source coverage");

    // The risk dial tilts the base ranking key (penalty weighting + soft floor)
    // before personalization boosts are added on top.
    const matchScore = clamp(riskAdjustedRankScore(signal, prefs.riskAppetite) + boost, 0, 100);
    if (reasons.length === 0) reasons.push("Strong overall signal score");

    return { signal, matchScore: Math.round(matchScore), reasons: reasons.slice(0, 3) };
  });

  return ranked.sort((a, b) => b.matchScore - a.matchScore);
}

export interface HoldingOutcome {
  signal: StockSignal;
  /** Realized P/L ratio when shares+cost are known; else undefined. */
  plPct?: number;
}

/**
 * Learn from the user's actual positions and how they're doing. Winners nudge
 * their sector/catalyst affinity up; losers nudge it down. Names that already
 * ran to highs and then lost push the "discount + catalyst" dial UP (chasing
 * hurt); discounted-catalyst winners reinforce it. Nudges are deliberately tiny
 * and clamped, so calling this once per research run drifts gently and saturates
 * safely rather than swinging the profile around.
 */
export function learnFromHoldings(
  prefs: UserPreferences,
  outcomes: HoldingOutcome[],
): UserPreferences {
  if (outcomes.length === 0) return prefs;

  let next: UserPreferences = {
    ...prefs,
    sectorWeights: { ...prefs.sectorWeights },
    catalystWeights: { ...prefs.catalystWeights },
    likedTickers: [...prefs.likedTickers],
    mutedTickers: [...prefs.mutedTickers],
  };

  let archetype = next.archetypeTilt ?? 0.35;

  for (const { signal, plPct } of outcomes) {
    // Prefer realized P/L; fall back to today's move as a weak proxy.
    const perf = plPct ?? signal.dayChange ?? 0;
    const arche = archetypeAxis(signal);

    if (perf >= 0.05) {
      next.sectorWeights = bump(next.sectorWeights, signal.sector, 0.12);
      next.catalystWeights = bump(next.catalystWeights, signal.catalystType, 0.08);
      if (arche > 0.3) archetype = clamp(archetype + 0.02, ARCHETYPE_MIN, ARCHETYPE_MAX);
    } else if (perf <= -0.08) {
      next.sectorWeights = bump(next.sectorWeights, signal.sector, -0.1);
      next.catalystWeights = bump(next.catalystWeights, signal.catalystType, -0.06);
      // A name that had already run to highs and then fell validates the tilt.
      if (arche < -0.3) archetype = clamp(archetype + 0.03, ARCHETYPE_MIN, ARCHETYPE_MAX);
    }
  }

  next = { ...next, archetypeTilt: archetype };
  return next;
}
