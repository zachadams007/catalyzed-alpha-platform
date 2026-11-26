import { clamp, percentileRank, scaleBand, scaleLinear } from "@/lib/math";
import { LIQUIDITY_BANDS } from "@/engine/scoringConfig";
import type { ScreenerCandidate } from "./prefilter";

/**
 * Blended discovery modes (Mission 5).
 *
 * The funnel's gated pool is re-ranked by a BLEND of four discovery lenses, so
 * the names that get hydrated + scored aren't just the most liquid:
 *   • wide_net - the broad universe composite (coverage floor);
 *   • overlooked - small + moving, the under-followed corner;
 *   • learn_winners - the sectors/peers the user's own holdings favor;
 *   • hunt_themes - names the AI theme lane surfaced.
 * wide_net is always weighted enough that coverage never collapses. The modes
 * only SOFT-reweight the pool - every gated name stays eligible.
 *
 * Pure scoring; a small module mirror lets the data provider read the user
 * context (held tickers, favored sectors, theme tickers) without importing the
 * store. Pre-hydration the only signals are price / cap / volume / beta / sector,
 * so the modes lean on size, liquidity, movement, sector affinity and theme
 * membership - catalyst/news heat is applied later by the scorer.
 */

export type DiscoveryMode = "wide_net" | "overlooked" | "learn_winners" | "hunt_themes";

export interface DiscoveryContext {
  /** Tickers the user holds (peers boost learn_winners). */
  heldTickers?: Set<string>;
  /** Sectors the user's holdings/taps favor (boost learn_winners). */
  favoredSectors?: Set<string>;
  /** Tickers the AI theme lane surfaced (boost hunt_themes). */
  themeTickers?: Set<string>;
}

export interface ModeWeights {
  wide_net: number;
  overlooked: number;
  learn_winners: number;
  hunt_themes: number;
}

/** Balanced default - wide_net is the floor so coverage never collapses. */
export const DEFAULT_MODE_WEIGHTS: ModeWeights = {
  wide_net: 0.4,
  overlooked: 0.25,
  learn_winners: 0.2,
  hunt_themes: 0.15,
};

// ── Module mirror of the live discovery context ──────────────────────────────
let currentContext: DiscoveryContext = {};

export function setDiscoveryContext(ctx: DiscoveryContext): void {
  currentContext = ctx;
}

export function getDiscoveryContext(): DiscoveryContext {
  return currentContext;
}

// ── Per-mode scoring (0..100) ────────────────────────────────────────────────

function liquidityScore(c: ScreenerCandidate): number {
  return scaleLinear(
    Math.log10(Math.max(c.dollarVolume, 1)),
    Math.log10(LIQUIDITY_BANDS.thin),
    Math.log10(LIQUIDITY_BANDS.deep),
  );
}

function movementScore(c: ScreenerCandidate): number {
  return c.beta != null && Number.isFinite(c.beta) ? scaleBand(c.beta, 1.3, 1.3) : 50;
}

/** Score one candidate under one mode. `sizePercentile` is 0 (small) … 1 (mega). */
export function modeScore(
  c: ScreenerCandidate,
  mode: DiscoveryMode,
  sizePercentile: number,
  ctx: DiscoveryContext,
): number {
  const liquidity = liquidityScore(c);
  const movement = movementScore(c);
  const sizeTilt = clamp((1 - sizePercentile) * 100, 0, 100);

  switch (mode) {
    case "wide_net":
      return 0.45 * liquidity + 0.35 * sizeTilt + 0.2 * movement;
    case "overlooked":
      // The under-followed corner: small + moving (catalyst heat comes later).
      return clamp(0.6 * sizeTilt + 0.4 * movement, 0, 100);
    case "learn_winners": {
      const sector = c.sector;
      const favored = sector != null && ctx.favoredSectors?.has(sector);
      const peer = ctx.heldTickers?.has(c.symbol);
      // Neutral 50 when there's no profile yet, so it can't suppress coverage.
      if (!ctx.favoredSectors?.size && !ctx.heldTickers?.size) return 50;
      return clamp((favored ? 80 : 45) + (peer ? 20 : 0), 0, 100);
    }
    case "hunt_themes": {
      if (!ctx.themeTickers?.size) return 50; // neutral when the lane is empty
      return ctx.themeTickers.has(c.symbol) ? 92 : 42;
    }
  }
}

/**
 * Re-rank the gated pool by the weighted blend of the four modes and slice the
 * top-N. Pure + deterministic (stable symbol tiebreak). wide_net's weight is the
 * coverage floor.
 *
 * `guaranteeTopCap` reserves the first K slots for the K biggest-cap names so the
 * anti-megacap discovery tilt can't slice the market's largest companies (or a
 * fresh mega-cap IPO) out of the universe - the client-side parallel to the cloud
 * scan's market-majors seed. Those K are placed FIRST (cap-desc), then the rest of
 * the top-N is filled by the blended ranking. Default 0 = unchanged behavior.
 */
export function blendDiscoveryModes(
  candidates: ScreenerCandidate[],
  topN: number,
  ctx: DiscoveryContext = getDiscoveryContext(),
  weights: ModeWeights = DEFAULT_MODE_WEIGHTS,
  guaranteeTopCap = 0,
): ScreenerCandidate[] {
  if (candidates.length === 0) return [];
  const slots = Math.max(0, Math.floor(topN));
  const logCaps = candidates.map((c) => Math.log10(Math.max(c.marketCap, 1)));
  const sizePct = percentileRank(logCaps);
  const total =
    weights.wide_net + weights.overlooked + weights.learn_winners + weights.hunt_themes || 1;

  const ranked = candidates
    .map((c, i) => {
      const p = sizePct[i] ?? 0.5;
      const blended =
        (weights.wide_net * modeScore(c, "wide_net", p, ctx) +
          weights.overlooked * modeScore(c, "overlooked", p, ctx) +
          weights.learn_winners * modeScore(c, "learn_winners", p, ctx) +
          weights.hunt_themes * modeScore(c, "hunt_themes", p, ctx)) /
        total;
      return { c, blended };
    })
    .sort(
      (a, b) =>
        b.blended - a.blended || (a.c.symbol < b.c.symbol ? -1 : a.c.symbol > b.c.symbol ? 1 : 0),
    );

  const k = Math.max(0, Math.min(Math.floor(guaranteeTopCap), slots));
  if (k === 0) return ranked.slice(0, slots).map((r) => r.c);

  // Reserve the first K slots for the biggest-cap names (stable symbol tiebreak),
  // then fill the remaining slots from the blended ranking, deduped by symbol.
  const result: ScreenerCandidate[] = [];
  const taken = new Set<string>();
  const byCap = [...candidates].sort(
    (a, b) => b.marketCap - a.marketCap || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );
  for (const c of byCap) {
    if (result.length >= k) break;
    if (!taken.has(c.symbol)) {
      result.push(c);
      taken.add(c.symbol);
    }
  }
  for (const r of ranked) {
    if (result.length >= slots) break;
    if (!taken.has(r.c.symbol)) {
      result.push(r.c);
      taken.add(r.c.symbol);
    }
  }
  return result;
}
