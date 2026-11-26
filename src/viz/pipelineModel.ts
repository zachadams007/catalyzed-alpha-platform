/**
 * The TRUTHFUL pipeline model behind the Algorithm tab's animated story and the
 * Blueprint instrument. Every node, edge, label, and number here maps to real
 * engine behavior - imported from the real configs wherever they are exported,
 * and restated with a `source:` file reference where they are module-private.
 *
 * Fidelity rule (CLAUDE.md): if the engine changes, this file - and therefore
 * the Algorithm tab - changes with it. Do not invent stages, sources, or
 * numbers here.
 */

import { STAGE_BLUEPRINT } from "@/engine/research";
import { CATEGORY_CONFIG, RISK, CONFIDENCE, SMART_MONEY } from "@/engine/scoringConfig";
import { DISCOVERY_MISSIONS, DISCOVERY_MISSION_COUNT } from "@/data/ai/discoveryMissions";
import { NICHE_ANCHOR_TICKERS, REAL_UNIVERSE_SIZE } from "@/data/realUniverse";
import { SYSTEM_NAV } from "@/config/navigationLabels";
import { ACTIVE_VARIANT, type EngineVariantId } from "@/engine/challenger";
import { resolveProviderId } from "@/data/providers";
import { DEFAULT_PREFILTER_GATES } from "@/data/funnel/prefilter";
import { FUNNEL_TARGET_MAX } from "@/data/funnel/budget";
import { TODAY_LIMIT, TODAY_SECTOR_CAP, WEEKLY_LIMIT, WEEKLY_SECTOR_CAP } from "@/feed/feeds";
import {
  CATALYST_DRIVEN_NORMALIZATION,
  CURATED_BASE_NORMALIZATION,
  INFLECTION_V2_NORMALIZATION,
  DISPLAY_DECOMPRESS_WEIGHT,
  MAX_REVISION_POINTS,
  MAX_CATALYST_POINTS,
  MAX_SELL_PENALTY,
  MAX_DISCOUNT_POINTS,
  REVERSAL_TILT_MAX,
  QUALITY_COMPOUNDER_TILT_MAX,
  ASYMMETRY_TILT_MAX,
  MISUNDERSTOOD_TILT_MAX,
  OWN_HISTORY_TILT_MAX,
  ABSOLUTE_MULTIPLE_TILT_MAX,
  ATTENTION_TILT_MAX,
  V7_OWN_HISTORY_TILT_MAX,
  V7_ATTENTION_TILT_MAX,
} from "@/engine/normalizeUniverse";
import { NEWS_SOCIAL_HALF_LIFE_DAYS } from "@/engine/signalHistory";
import { EARNINGS_CATALYST_HORIZON_DAYS } from "@/data/earnings/enrichCompanyEarnings";
import { runsCatalystDrivenProfile } from "@/engine/challenger";
import { SMALL_CAP_CEILING_USD } from "@/engine/capCurve";
import {
  REGIME_SPY_CORRECTION_SMA_DAYS,
  REGIME_SPY_SMA_DAYS,
} from "@/engine/regime";

export { STAGE_BLUEPRINT, CATEGORY_CONFIG, RISK, CONFIDENCE, SMART_MONEY, DISCOVERY_MISSIONS, ACTIVE_VARIANT };

// ---------------------------------------------------------------------------
// Stage keys (from the real STAGE_BLUEPRINT in src/engine/research.ts)
// ---------------------------------------------------------------------------

export type PipelineStageKey = "ingest" | "news" | "social" | "score" | "rank";

export const STAGE_KEYS: PipelineStageKey[] = STAGE_BLUEPRINT.map(
  (s) => s.key as PipelineStageKey,
);

export function stageLabel(key: PipelineStageKey): string {
  return STAGE_BLUEPRINT.find((s) => s.key === key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Discovery layer (the "agents" beat)
// ---------------------------------------------------------------------------

/** Constants restated from module-private values - sources inline. */
export const DISCOVERY = {
  /** src/data/ai/discoverUniverse.ts:36 - MISSIONS_PER_REFRESH */
  missionsPerRefresh: 2,
  /** src/data/ai/discoverUniverse.ts:24 - TTL_MS = 90 min */
  cacheTtlMinutes: 90,
  /** src/data/ai/discoverUniverse.ts:30 - FAILURE_COOLDOWN_MS = 60 min */
  failureCooldownMinutes: 60,
  /** src/data/ai/discoverUniverse.ts:44 - MAX_TICKERS per refresh */
  maxDiscoveredPerRefresh: 36,
  /** src/data/providers/DiscoveryDataProvider.ts:8 - MAX_UNIVERSE */
  maxUniverse: 48,
  /** src/data/ai/discoverUniverse.ts:46 - TICKER_RE */
  tickerPattern: "^[A-Z][A-Z0-9.\\-]{0,6}$",
  missionCount: DISCOVERY_MISSION_COUNT,
  missionLabels: DISCOVERY_MISSIONS.map((m) => m.label),
  anchorTickers: NICHE_ANCHOR_TICKERS as readonly string[],
  /**
   * src/data/providers/DiscoveryDataProvider.ts - every candidate is hydrated
   * by a live Finnhub quote; names with no live quote are skipped silently.
   */
  validationGate: "Live Finnhub quote required — no quote, no entry",
  guardrail:
    "The agent never returns buy/sell advice; every ticker must pass a live-quote check before it can be scored.",
} as const;

// ---------------------------------------------------------------------------
// Discovery mode - which universe-sourcing story the Algorithm tab tells.
//
// This tracks the *resolved data provider* (CLAUDE.md fidelity rule: the tab
// renders what the engine actually does), NOT the engine variant:
//  • "curated" - the device-local path. The engine scores a vetted universe of
//    real, liquid U.S. names (REAL_UNIVERSE_TICKERS), hydrated from live Finnhub
//    quote + profile. This is the FALLBACK a device runs when the shared broad
//    scan hasn't published yet; the live default is the scheduled broad scan
//    (BROAD_SCAN) of the whole US market, read from the daily_signals cache.
//  • "funnel" - an alternative full-market breadth path via a PAID market
//    screener (FMP); only the live story when the funnel provider is resolved.
//  • "agent" - the AI niche-discovery provider (hosted research agent), only
//    when that provider is explicitly resolved.
// The scoring-side champion/challenger difference is surfaced separately, gated
// on the variant. See src/data/providers/index.ts and src/engine/challenger.ts.
// ---------------------------------------------------------------------------

export type DiscoveryMode = "agent" | "funnel" | "curated";

const RESOLVED_PROVIDER_ID = resolveProviderId();

export const DISCOVERY_MODE: DiscoveryMode =
  RESOLVED_PROVIDER_ID === "funnel"
    ? "funnel"
    : RESOLVED_PROVIDER_ID === "discovery"
      ? "agent"
      : "curated";

/**
 * The scheduled broad-universe scan - the LIVE production discovery path.
 *
 * A scheduled cloud job (GitHub Action `.github/workflows/daily-universe.yml`,
 * pre-market each U.S. trading day) runs `scripts/universe_scan/scan.mts`: it
 * sweeps the WHOLE US common-stock list, pre-ranks it down to the top ~N names
 * worth a full scoring pass, enriches them with REAL Alpaca daily bars (momentum
 * vs SPY), fundamentals, news, and recent disclosed congressional open-market
 * buys (the keyless House Stock Watcher dump, fetched once and mapped across the
 * board for the bounded smart-money catalyst tilt), scores those through the same
 * 0–100 engine, and publishes the finished board to the shared `daily_signals`
 * cache. Every tester then READS that one board - zero vendor API calls.
 *
 * Numbers are the real engine constants/defaults, restated with `source:`
 * references (the scan's env defaults are module-private), so this can't drift.
 */
export const BROAD_SCAN = {
  /** scripts/universe_scan/scan.mts - UNIVERSE_TARGET, default 500. */
  targetN: 500,
  /** scripts/universe_scan/scan.mts - SCAN_MIN_PRICE default. */
  minPrice: 2,
  /** src/engine/preRank.ts - DEFAULT_MIN_DOLLAR_VOLUME / scan default ($2M/day). */
  minDollarVolume: 2_000_000,
  /** src/data/finnhub/symbolList.ts - fetchUsCommonStockUniverse(). */
  universeSource:
    "Finnhub /stock/symbol?exchange=US — the whole US common-stock list (~thousands of names) in one free call, cached daily",
  /** src/data/alpaca/snapshots.ts - fetchSnapshotQuotes(), batched IEX snapshots. */
  snapshotSource:
    "Alpaca IEX snapshots — one batched pass for price, prior close, dollar volume & range across the full list",
  /** src/data/prices/enrichCompanyBars.ts - enrichUniverseWithAlpacaBars(); SPY is the benchmark. */
  momentumSource:
    "Real Alpaca daily bars — up to 260 closes per scored name → 1/3/6-month return, RSI(14), SMA 50/200, and relative strength vs SPY's own 3-month return (not a fixed proxy)",
  /** src/data/congress/scanCongressBuys.ts - enrichScanUniverseWithCongressBuys(); keyless, fetched once. */
  smartMoneySource:
    "Recent disclosed congressional open-market BUYS (House Stock Watcher) — the few-MB dump is fetched once per run and mapped across the whole board, lifting the Catalyst score with a small, bounded smart-money tilt; never any per-ticker SEC / Form 4 XML",
  /** src/engine/preRank.ts - preRankUniverse() blend. */
  preRankSummary:
    "A price floor (≥$2) + liquidity floor (≥$2M/day) drop junk; survivors rank anti-megacap — 45% realized volatility + 35% the day's move + 20% saturating liquidity, so a $2T mega gets no edge by size.",
  /** src/data/dailySignalsCache.ts - TABLE = 'daily_signals'. */
  publishTarget:
    "The top ~N are fully enriched (real price history, fundamentals, news, and recent congressional open-market buys for the smart-money tilt) + scored, then published to the shared daily_signals cache — every tester reads it with zero vendor calls.",
  guardrail:
    "Every published name ran through the identical 0–100 engine; discovery never returns buy/sell advice.",
} as const;

/**
 * The curated vetted universe - now the FALLBACK, not the ceiling. A device only
 * scores this set locally if the shared broad scan hasn't published yet (e.g.
 * right at the market-day rollover). Numbers are real constants (size from
 * realUniverse.ts) so this can't drift.
 */
export const CURATED = {
  /** src/data/realUniverse.ts - REAL_UNIVERSE_TICKERS.length. Auto-updates. */
  size: REAL_UNIVERSE_SIZE,
  selection:
    "A vetted set of liquid, actively-traded U.S. names spanning every sector — large caps to small caps",
  hydrationSource:
    "Live Finnhub quote + profile per name — real price, market cap, sector, day move",
  /** Honest framing: this set is the fallback the device scores until the scan publishes. */
  upgradeNote:
    "This vetted set is the FALLBACK a device scores locally only until the day's shared broad scan publishes. The live default is the scheduled scan of the whole US market.",
  /** This same list is the always-include seed inside the broad scan's pre-rank. */
  seedNote:
    "These names are also force-included as seeds in the broad scan, so coverage of them is guaranteed even when the funnel favors more volatile movers.",
  anchorTickers: NICHE_ANCHOR_TICKERS as readonly string[],
  guardrail:
    "Every name runs through the identical 0–100 engine; discovery never returns buy/sell advice.",
} as const;

/**
 * The live-price overlay - distinct from the once-daily score. On top of the
 * shared daily board, the DISPLAYED price + day-change refresh live (Alpaca IEX
 * snapshots) on the watchlist, feed cards, stock detail, and portfolio - on
 * view-open + a manual refresh button, never background polling. The opportunity
 * SCORE stays daily/shared; only the displayed number ticks.
 *
 * src/lib/useLivePrices.ts (useLivePriceSync) · src/data/alpaca/snapshots.ts (fetchLiveQuotes).
 */
export const LIVE_PRICE = {
  source: "Alpaca IEX snapshots",
  surfaces: "Watchlist, feed cards, stock detail, and portfolio",
  cadence: "Refreshes on view-open + a manual refresh button — no background polling",
  scoreNote: "Only the displayed price/day-change ticks; the opportunity score stays daily and shared.",
  caveat:
    "Alpaca's free IEX feed is real-time for liquid names, but very thin micro-caps can lag the consolidated tape; the full SIP tape is a commercial-tier upgrade.",
} as const;

/**
 * The full-market funnel model (challenger). Numbers are the real engine
 * constants - gates from `src/data/funnel/prefilter.ts`, target N from
 * `src/data/funnel/budget.ts` - so this can't drift from the code.
 */
export const FUNNEL = {
  /** src/data/funnel/budget.ts - FUNNEL_TARGET_MAX (budget shrinks it per run). */
  targetMax: FUNNEL_TARGET_MAX,
  /** src/data/funnel/prefilter.ts - DEFAULT_PREFILTER_GATES. */
  gates: DEFAULT_PREFILTER_GATES,
  /** src/data/funnel/symbolList.ts - Stage 0 list source. */
  symbolListSource: "Finnhub /stock/symbol?exchange=US — US common stocks, cached once per day",
  /** src/data/providers/FunnelDataProvider.ts - MARKET_SWEEPS. */
  sweepSource: "FMP stock screener — a broad cap-spectrum sweep at the liquidity floor",
  stageZeroLabel: "Pre-filtering the full market",
  gateSummary: "price > $5 · $1M+ avg daily $ volume · $50M+ cap · common stock only",
  rankSummary:
    "Survivors rank liquidity-led with a small/mid (anti-megacap) tilt; the budget-derived top-N is hydrated and scored.",
  budgetNote:
    "The top-N is capped to fit the day's remaining free-tier API budget — a near-spent day scores fewer names, never a blowout.",
  guardrail:
    "Megacaps still pass the floor but never win by size alone; discovery never returns buy/sell advice.",
} as const;

/**
 * The UNIVERSAL cross-sectional normalization - restated from
 * src/engine/normalizeUniverse.ts so the Algorithm tab can describe cap-balancing
 * as always-on without drifting (CLAUDE.md fidelity rule). EVERY engine model
 * runs this pass over the SAME full universe; the champion and challenger differ
 * ONLY in the knobs below (tilt strength, the soft thesis gate, and the
 * time-aware refinements) - never in whether they re-score cross-sectionally or
 * cap-balance. The champion is NOT a naive per-company "identity" model.
 */
export const NORMALIZATION = {
  /** Coverage/volume dims residualized vs log(market cap) - the "big ⇒ covered" edge stripped. */
  residualizedDims: CATEGORY_CONFIG.filter((c) => c.sizeResidualized).map((c) => c.label),
  /** Slow quality factors judged against their own sector mean, not the whole market. */
  sectorNeutralDims: CATEGORY_CONFIG.filter((c) => c.sectorNeutral).map((c) => c.label),
  /** The live champion's bounded small/mid-cap tilt (± display points). The
   *  champion runs the promoted catalyst-driven profile. > 0 ⇒ cap-balanced by default. */
  championCapTilt: CATALYST_DRIVEN_NORMALIZATION.capTilt,
  /** The challenger (curated-base shadow) small/mid-cap tilt (± display points) -
   *  the SAME gentle, zero-mean tilt as the champion. */
  challengerCapTilt: CURATED_BASE_NORMALIZATION.capTilt,
  /** True when the live-by-default champion already cap-balances (anti-megacap). */
  capBalancedByDefault: CATALYST_DRIVEN_NORMALIZATION.capTilt > 0,
  /** True ⇒ the live champion size-balances its catalyst/discount tilt bundle (those
   *  signals skew small in a discovery universe, so the bundle is residualized vs
   *  log(market cap)) - keeping the champion cap-BALANCED, not small-cap-heavy,
   *  while small-caps still surface on merit. */
  championSizeBalancesTilts: CATALYST_DRIVEN_NORMALIZATION.sizeBalanceTilts === true,
  /** The soft thesis gate is part of the catalyst-driven champion profile; the
   *  curated-base challenger runs without it. */
  thesisGateChampionOnly:
    CATALYST_DRIVEN_NORMALIZATION.thesisGate && !CURATED_BASE_NORMALIZATION.thesisGate,
  /** True ⇒ the live champion spreads its displayed 0-100 score across the FULL
   *  scale (a name's percentile within the day's universe, blended with its
   *  absolute score) so the feed stops bunching at 30-59. Display-only - never
   *  re-ranks. */
  displayFullScale: INFLECTION_V2_NORMALIZATION.decompressDisplay === true,
  /** How much of that displayed score is the percentile (relative) leg vs the
   *  absolute leg, 0..1. */
  displayPercentileWeight: DISPLAY_DECOMPRESS_WEIGHT,
  /** V4: cap-cohort weights are blended toward T1/T2/T3 archetype profiles. */
  archetypeOverlay: INFLECTION_V2_NORMALIZATION.archetypeOverlay === true,
  /** V4: one market-regime context is computed upstream and passed into the pure normalizer. */
  regimeTilt: INFLECTION_V2_NORMALIZATION.regimeTilt === true,
  /** src/engine/regime.ts - SPY 200-DMA is the primary risk-off trend read. */
  regimePrimarySmaDays: REGIME_SPY_SMA_DAYS,
  /** src/engine/regime.ts - SPY 50-DMA is the short correction-pressure read. */
  regimeCorrectionSmaDays: REGIME_SPY_CORRECTION_SMA_DAYS,
} as const;

export const V4_ARCHETYPE_EXPLANATION = [
  {
    id: "mega-reversal",
    label: "T1 mega reversal",
    setup:
      "Large/mega-cap quality name, materially off its own high, with margin or operating fundamentals bottoming/improving.",
    engine:
      "Routes toward the mega-reversal curve: inflection + valuation + catalyst/sentiment, with a separate quality-gated reversal lift.",
    source:
      "src/engine/normalizeUniverse.ts — inferArchetypeFlags(), reversalTilt() · src/engine/capCurve.ts — MEGA_REVERSAL_WEIGHTS",
  },
  {
    id: "compounder",
    label: "T2 re-accelerating compounder",
    setup:
      "Large/mid-cap operator where revenue acceleration, gross-margin stability, backlog/book-to-bill, or contract evidence says growth is re-accelerating before the market fully reprices it.",
    engine:
      "Routes toward the compounder curve: inflection, catalyst, sentiment-shift, momentum, pipeline, and growth, with parabolic momentum capped by the existing risk/extension guards.",
    source:
      "src/engine/normalizeUniverse.ts — inferArchetypeFlags() · src/engine/capCurve.ts — COMPOUNDER_WEIGHTS",
  },
  {
    id: "small-runner",
    label: "T3 small runner",
    setup:
      `Small/micro-cap setup (at or below ~$${Math.round(SMALL_CAP_CEILING_USD / 1_000_000_000)}B, or unknown cap) with a fresh catalyst, re-acceleration, backlog/contract evidence, and early trend. It does not require a small-cap discount.`,
    engine:
      "Routes toward the small-runner curve: pipeline, inflection, catalyst, conviction, sentiment-shift, growth, and a bounded momentum check, while raw social stays low so pump-only hype cannot dominate.",
    source:
      "src/engine/normalizeUniverse.ts — inferArchetypeFlags() · src/engine/capCurve.ts — SMALL_RUNNER_WEIGHTS",
  },
] as const;

export const V4_REGIME_TILT = {
  label: "Regime read (fear & greed)",
  detail:
    `The scan computes market regime once, upstream: SPY vs its ${REGIME_SPY_SMA_DAYS}-DMA, correction pressure vs its ${REGIME_SPY_CORRECTION_SMA_DAYS}-DMA, 21-trading-day drawdown, universe breadth, and a Fear & Greed reading (CNN's live index when reachable, else an equivalent internal composite). A normal day keeps the standard curves. In market PANIC the model does NOT rotate into "safe" stocks — by the time a fear index confirms panic, defensives have already been bid. Instead it leans into discounted QUALITY (weights shift toward fundamentals, valuation, inflection and catalysts; momentum is halved), pays a discounted quality setup up to 1.5x the normal discount reward, scales risk penalties up so speculative names are demoted harder, and cools the structural small-cap lift — greedy when others are fearful, on quality only. Missing regime input is neutral, and a feed-tab banner discloses whenever this mode is active.`,
  source:
    "src/engine/regime.ts — buildMarketRegimeContext(), computeFearGreed() · src/engine/capCurve.ts — PANIC_QUALITY_WEIGHTS · src/engine/normalizeUniverse.ts — computeNormalizedScores()",
} as const;

export const V4_FALSE_POSITIVE_SCREENS = [
  "Missing inputs stay neutral at 50: absent fundamentals/catalysts never become a penalty and never fabricate a reward.",
  "No-revenue, thin-float, promo/social-only, high-dilution, or insider-selling lottery tickets are demoted by pump-risk, sell-watch, and thesis gates.",
  "Discounts only earn a lift when the thesis is intact; cheap falling knives and already-ran momentum chases do not get paid for price action alone.",
  "Conviction is additive-only and bounded; risk components subtract only; the display-layer 0-100 spread never re-ranks the board.",
] as const;

// ---------------------------------------------------------------------------
// Engine version lineage (v1 → v2 → v3 → v4) - so a user can verify which engine is
// live. These are DOCUMENTATION facts about real engine milestones, each anchored
// to the source that proves it; `live` is derived from the resolved active variant
// so the badge can never claim the wrong model is running (CLAUDE.md fidelity rule).
// ---------------------------------------------------------------------------

export interface EngineVersion {
  id: "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7";
  /** Short product name shown on the badge. */
  name: string;
  /** Internal engine identifier (the real constant / variant name in code). */
  internalName: string;
  /** One-line "what changed at this version". */
  summary: string;
  /** The concrete capabilities this version introduced. */
  highlights: readonly string[];
  /** Source-of-truth reference(s) for the facts above. */
  source: string;
}

/**
 * Is the active model the V4 rollback profile? Derived from the engine itself:
 * the champion slot is active and the V4 archetype/regime flags are on.
 */
export const V4_IS_LIVE: boolean =
  runsCatalystDrivenProfile(ACTIVE_VARIANT) &&
  INFLECTION_V2_NORMALIZATION.archetypeOverlay === true &&
  INFLECTION_V2_NORMALIZATION.regimeTilt === true;
/**
 * V5 is live when the active variant is challenger. The owner manually approved this
 * promotion on July 11, 2026; V4 remains the rollback baseline.
 *
 * NOTE: `ACTIVE_VARIANT` is a module-load snapshot (the build default before the
 * global controls resolve). UI that names the live engine must derive it at
 * render time - see `lineageIdForVariant` + `useActiveVariant`.
 */
export const V5_IS_LIVE: boolean = ACTIVE_VARIANT === "challenger";

/** Lineage id (`ENGINE_LINEAGE[].id`) for a resolved engine variant. */
export function lineageIdForVariant(variant: EngineVariantId): "v4" | "v5" | "v6" | "v7" {
  if (variant === "champion") return "v4";
  if (variant === "v6") return "v6";
  if (variant === "v7") return "v7";
  return "v5";
}
/** @deprecated V3 is retired to history and never a live slot now. */
export const V3_IS_LIVE = false;

export const ENGINE_LINEAGE: readonly EngineVersion[] = [
  {
    id: "v1",
    name: "Weighted blend",
    internalName: "CATEGORY_CONFIG (original)",
    summary:
      "The original engine — nine category scores blended on fixed weights into one 0–100 number, scored per company in isolation.",
    highlights: [
      "9-category weighted blend",
      "Fixed weights, sum to 1.0",
      "Per-company, no cross-sectional re-score",
    ],
    source: "src/engine/scoringConfig.ts — CATEGORY_CONFIG",
  },
  {
    id: "v2",
    name: "Pre-Move Inflection Engine",
    internalName: "INFLECTION_V2_NORMALIZATION",
    summary:
      "Added the early-move leg — inflection, pipeline, and sentiment-shift dimensions — plus the cap-balanced cross-sectional re-score and a pump-risk guard, so the engine looks for a setup before the move, not after.",
    highlights: [
      "Inflection / pipeline / sentiment-shift signals",
      "Cap-balanced cross-sectional re-score (anti-megacap)",
      "Cap-cohort weight routing + anti-lottery pump guard",
    ],
    source: "src/engine/normalizeUniverse.ts — INFLECTION_V2_NORMALIZATION · src/engine/challenger.ts",
  },
  {
    id: "v3",
    name: "Catalyst-driven base",
    internalName: "INFLECTION_V2_NORMALIZATION (historical base)",
    summary:
      "Historical base layer. It added full-scale 0-100 display decompression, a quality/risk ceiling so flawed names cannot read near-100, the large-cap discounted-reversal tilt, and a market-wide catalyst harvest that seeds catalyzed names onto the board.",
    highlights: [
      `Full-scale 0–100 display decompression (${Math.round(DISPLAY_DECOMPRESS_WEIGHT * 100)}% percentile)`,
      "Quality / risk ceiling on the displayed score",
      `Large-cap discounted-reversal tilt (+${REVERSAL_TILT_MAX} max)`,
      "Market-wide catalyst harvest (8-K / Form-4 / 13D seeding)",
    ],
    source:
      "src/engine/normalizeUniverse.ts - DISPLAY_DECOMPRESS_WEIGHT, QUALITY_CEILING_*, reversalTilt(); src/engine/challenger.ts",
  },
  {
    id: "v4",
    name: "Archetype + regime rollback",
    internalName: "INFLECTION_V2_NORMALIZATION + archetypeOverlay + regimeTilt",
    summary:
      "The V4 rollback baseline. It keeps the v3 catalyst-driven base, then adds the winner-study archetype router, revenue re-acceleration logic, false-positive screens, and one upstream market-regime tilt for risk-off discipline.",
    highlights: [
      "T1 mega reversal, T2 re-accelerating compounder, and T3 small-runner archetype curves",
      "Revenue re-acceleration, backlog/contract, and margin-turn evidence before pure momentum",
      `Risk-off regime from SPY ${REGIME_SPY_SMA_DAYS}-DMA / correction pressure, leaning value + quality + low-vol`,
      "False-positive screens: missing data neutral, pump/social-only demoted, discounts require intact thesis",
    ],
    source:
      "src/engine/normalizeUniverse.ts - inferArchetypeFlags(), INFLECTION_V2_NORMALIZATION; src/engine/capCurve.ts - *_WEIGHTS, PANIC_QUALITY_WEIGHTS; src/engine/regime.ts",
  },
  {
    id: "v5",
    name: "Reversal-first Champion",
    internalName: "REVERSAL_V5_NORMALIZATION (live V5)",
    summary:
      "The live V5 engine. It is V4 with momentum's blend weight cut ~70% and redistributed into early-entry signals (inflection, entry timing, catalyst, sentiment-shift, pipeline), plus the July 11 quality-compounder tweak: discounted high-quality large/mega names can score up even without a fresh catalyst, while no-catalyst low-conviction names are capped below near-perfect.",
    highlights: [
      "Momentum weight cut ~70%, redistributed to inflection / entry-timing / catalyst / sentiment / pipeline",
      "Same V4 archetype router, regime tilt, and cap-cohort routing otherwise",
      `Discounted quality compounder lift (+${QUALITY_COMPOUNDER_TILT_MAX} max)`,
      "No-catalyst, low-conviction names cannot print as near-perfect top-board calls",
    ],
    source:
      "src/engine/capCurve.ts - dampMomentumWeight, V5_MOMENTUM_WEIGHT_SCALE; src/engine/normalizeUniverse.ts - REVERSAL_V5_NORMALIZATION; src/engine/challenger.ts",
  },
  {
    id: "v6",
    name: "Misunderstood quality",
    internalName: "MISUNDERSTOOD_V6_NORMALIZATION (July 2026 candidate)",
    summary:
      "V5 plus real data where V5 had none. A board audit found the forward-pipeline, sentiment-shift and own-history valuation dimensions all scored a flat neutral for 100% of names, so V5 was ranking mostly on price action. V6 folded disclosed SEC XBRL order books, free cash flow, net margin and revenue growth into the scan, added the T4 misunderstood-quality archetype (profitable, deep drawdown, contracted demand outrunning revenue), an upside-asymmetry tilt, own-history valuation, and an absolute-P/E penalty. Never promoted.",
    highlights: [
      "SEC XBRL forward pipeline: remaining performance obligations, contract liabilities, FCF, net margin",
      "T4 misunderstood-quality archetype (Oracle-class): bad momentum is the precondition, not a disqualifier",
      `Upside-asymmetry tilt (±${ASYMMETRY_TILT_MAX}): room to run, size- and beta-discounted`,
      `Own-history valuation (±${OWN_HISTORY_TILT_MAX}) and absolute-P/E penalty (−${ABSOLUTE_MULTIPLE_TILT_MAX}) — both later found too strong`,
      `Attention tilt (±${ATTENTION_TILT_MAX}): cap-normalised turnover, so a mispricing has an audience to close it`,
    ],
    source:
      "src/engine/normalizeUniverse.ts - MISUNDERSTOOD_V6_NORMALIZATION; src/data/sec/xbrlPipeline.ts; src/engine/valuationHistory.ts",
  },
  {
    id: "v7",
    name: "Synthesis",
    internalName: "SYNTHESIS_V7_NORMALIZATION (candidate)",
    summary:
      "The best of every July-2026 version, sized by a backtest of all nine against live closes on 2026-09-16. V7 keeps every data fix and every mechanism whose reasoning stands, removes the absolute-P/E penalty outright (the one version carrying it demoted a strong name for its multiple; PEG already prices that), and shrinks own-history and attention to secondary voices. One short window is evidence, not proof.",
    highlights: [
      "Absolute-P/E penalty removed — PEG inside the fundamentals score already accounts for the multiple",
      `Own-history tilt ±${OWN_HISTORY_TILT_MAX} → ±${V7_OWN_HISTORY_TILT_MAX}; attention ±${ATTENTION_TILT_MAX} → ±${V7_ATTENTION_TILT_MAX}`,
      `Asymmetry (±${ASYMMETRY_TILT_MAX}), T4 misunderstood-quality (+${MISUNDERSTOOD_TILT_MAX}), discount-led compounder, consolidation-as-room, good-price readiness floor all kept`,
      "Entry-quality damping softened so a catalyst on a fully-valued name is discounted, not erased",
      "2026-09-19 review: 'extended' now means price outran the business (not 'near a 52-week high'); a lender's disclosed total revenue beats its partial contract tag (SoFi was scored as unprofitable on a real ~13% margin); the quarterly re-acceleration read is seasonally matched (a retailer's Q4→Q1 drop is no longer a 'deceleration')",
      "2026-09-20 (promoted live 09-21): growth, margin and the order-book denominator read the trailing four quarters from SEC XBRL, not last fiscal year (Amazon +12% FY → +15.8% TTM); the market-wide earnings calendar is wired (was ~45 FMP names, 0 on 07-29), and a scheduled report is graduated timing relief for the reversal-readiness gate — ≤7 days bypasses it, ≤21 days floors it at 0.6 — never a blanket pass",
      "V6 stays registered so both can be scored on the same board",
    ],
    source:
      "src/engine/normalizeUniverse.ts - SYNTHESIS_V7_NORMALIZATION, V7_* constants; docs/scoring-framework.md (V7)",
  },
] as const;

// ---------------------------------------------------------------------------
// The single, consolidated AI-lane boundary. ONE statement of where AI is and is
// NOT used, so the page stops repeating the boundary per discovery mode. The
// scoring math is deterministic; AI only sources candidate names and writes the
// AI Pick analysis. (CLAUDE.md fidelity rule: this restates real behavior - see
// the discovery providers + the Research Desk edge function.)
// ---------------------------------------------------------------------------

export const AI_LANE = {
  headline:
    "AI discovers and sources candidate names and writes the AI Pick analysis — AI NEVER touches the 0–100 score. The scoring math is fully deterministic.",
  does: [
    "Sources candidate tickers in the niche-discovery and Blueprint modes (always quote-validated before scoring)",
    "Writes the AI Pick — a grounded Gemini web read, then a Groq Bull / Bear / Judge debate",
  ],
  neverTouches: [
    "The 0–100 opportunity score — pure, repeatable arithmetic over real data",
    "The risk penalty, confidence, and the ranking key — all deterministic",
  ],
} as const;

/**
 * The challenger's CATALYST-DRIVEN BLEND (LANE D). Point-in-time bounded tilts on
 * top of the cap-balanced re-rank - they need no history, so they are distinct
 * from the time-aware refinements below. ONLY the challenger runs them, so the
 * Algorithm tab surfaces them gated on the challenger (CLAUDE.md fidelity rule).
 * Every ± number is the real engine constant from normalizeUniverse.ts, so the
 * copy can't drift.
 */
export const CHALLENGER_CATALYST_BLEND = [
  {
    id: "catalyst-strength",
    label: "Catalyst strength (all types)",
    /** src/engine/catalystStrength.ts + normalizeUniverse.ts - MAX_CATALYST_POINTS. */
    detail: `Every catalyst — earnings, news, partnership, M&A, regulatory/FDA, product, analyst, or a major insider / congressional buy — is judged on ONE common scale: materiality × magnitude × credibility × how early/fresh it is (a catalyst not yet priced in is worth more). A strong, early catalyst of any type lifts a name up to +${MAX_CATALYST_POINTS} points; a weak or stale one barely moves it. It only ever adds, so a great-fundamentals name with no catalyst is never penalized for lacking one.`,
    source: "src/engine/catalystStrength.ts — catalystStrength()",
  },
  {
    id: "material-sells",
    label: "Material selling = negative",
    /** src/engine/catalystStrength.ts - MATERIAL_SELL · normalizeUniverse.ts - MAX_SELL_PENALTY. */
    detail: `Heavy disclosed selling by significant insiders / important people is a negative catalyst — down to −${MAX_SELL_PENALTY} points. A materiality threshold (transaction size + a cluster of sellers) filters noise: a small routine insider sale is NOT a signal and moves nothing. Real disclosed data only.`,
    source: "src/engine/catalystStrength.ts — materialSellSignal()",
  },
  {
    id: "discount-focus",
    label: "Discount with thesis intact",
    /** src/engine/normalizeUniverse.ts - MAX_DISCOUNT_POINTS. */
    detail: `Rewards a discounted entry whose thesis still holds and penalizes a name that has already run to highs — up to ±${MAX_DISCOUNT_POINTS} points. Momentum alone can't carry a pick: a name that's merely more expensive than last week, with nothing else changed, ranks lower, not higher.`,
    source: "src/engine/normalizeUniverse.ts — discountTilt()",
  },
  {
    id: "reversal-archetype",
    label: "Large-cap discounted reversal",
    /** src/engine/normalizeUniverse.ts - REVERSAL_TILT_MAX. */
    detail: `A washed-out QUALITY name — below its 50- and 200-day averages, oversold, and well off its own high, yet a real-quality larger company — gets a bounded lift up to +${REVERSAL_TILT_MAX} points, so a genuine reversal (a beaten-down quality name the market has overlooked) isn't buried by its weak momentum. Gated on quality and a deep price base: a low-quality falling knife or a thin/IPO name gets nothing.`,
    source: "src/engine/normalizeUniverse.ts — reversalTilt()",
  },
] as const;

/**
 * The challenger's time-aware refinements (Mission 4 data-deps). These ride on
 * top of the funnel + normalization pass and ONLY run under the challenger, so
 * the Algorithm tab surfaces them only when this build is the challenger - never
 * claiming the champion does them (CLAUDE.md fidelity rule). Every number is the
 * real engine constant.
 */
export const CHALLENGER_REFINEMENTS = [
  {
    id: "earnings",
    label: "Earnings-date countdown",
    /** src/data/earnings/enrichCompanyEarnings.ts - EARNINGS_CATALYST_HORIZON_DAYS. */
    detail: `An extra live lane pulls each name's next scheduled earnings date (FMP earnings calendar, Finnhub fallback) into the catalyst timing — a real, dated catalyst inside ${EARNINGS_CATALYST_HORIZON_DAYS} days lifts a name so you can see it before the move.`,
    source: "FMP /earning_calendar (one market-wide call) · Finnhub /calendar/earnings",
  },
  {
    id: "revision",
    label: "Estimate-revision momentum",
    /** src/engine/normalizeUniverse.ts - MAX_REVISION_POINTS. */
    detail: `The consensus forward-EPS estimate is snapshotted daily; an upward revision trend (the pre-earnings-drift effect) tilts a name up, a cut tilts it down — bounded to ±${MAX_REVISION_POINTS} points so it's a tie-breaker, never a driver.`,
    source: "src/engine/signalHistory.ts — daily EPS snapshot + delta scorer",
  },
  {
    id: "ewma",
    label: "News & social smoothing",
    /** src/engine/signalHistory.ts - NEWS_SOCIAL_HALF_LIFE_DAYS. */
    detail: `News and social scores are EWMA-smoothed over their daily history (≈${NEWS_SOCIAL_HALF_LIFE_DAYS}-day half-life) before ranking, so one loud headline decays gracefully instead of spiking a name for a day.`,
    source: "src/engine/signalHistory.ts — ewma() over the daily series",
  },
] as const;

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * The number of challenger refinements as an English word, derived from the array
 * so the prose count can never drift from the list (e.g. when the deferred
 * FDA/PDUFA catalyst becomes a fourth entry). Falls back to the numeral past nine.
 */
export const CHALLENGER_REFINEMENT_COUNT_WORD: string =
  COUNT_WORDS[CHALLENGER_REFINEMENTS.length] ?? String(CHALLENGER_REFINEMENTS.length);

// ---------------------------------------------------------------------------
// The six live enrichment lanes (the fan-in beat)
// ---------------------------------------------------------------------------

export interface SourceLane {
  id: string;
  /** External source name - exactly what the code calls. */
  source: string;
  /** What this lane fills on the company record. */
  fills: string;
  /** Which pipeline stage runs it (real stage keys). */
  stage: PipelineStageKey;
  /** True when the source needs no API key. */
  keyless: boolean;
  /** Short factual note worth surfacing. */
  note?: string;
}

/** Order matches execution order inside runResearch (src/engine/research.ts). */
export const SOURCE_LANES: SourceLane[] = [
  {
    id: "prices",
    source: "Alpaca daily bars",
    fills: "Daily closes → 1/3/6-mo return, RSI(14), SMA 50/200 + relative strength vs SPY",
    stage: "ingest",
    keyless: false,
    note: "The shared cloud scan computes momentum from real Alpaca bars; a device-local run falls back to Yahoo history",
  },
  {
    id: "fundamentals",
    source: "Finnhub",
    fills: "Quotes, company profile + industry, margins, growth, valuation, beta, dollar volume, news",
    stage: "ingest",
    keyless: false,
    note: "Missing fields read “N/A” — never fabricated",
  },
  {
    id: "fmp",
    source: "FMP",
    fills: "Fundamentals (income / ratios / growth), the earnings calendar, and news",
    stage: "ingest",
    keyless: false,
    note: "Financial Modeling Prep — fundamentals + a market-wide earnings-calendar call (the earnings-date countdown) + a news lane",
  },
  {
    id: "yahoo",
    source: "Yahoo Finance",
    fills: "Price charts & history (1D–Max), Canadian TSX (.TO / .V) quotes, analyst price targets, news RSS",
    stage: "ingest",
    keyless: true,
    note: "Device-local FALLBACK only — not a primary live source. Keyless public endpoints (via our proxy) power the expandable charts, Canadian listings, and the device-local momentum fallback before the cloud scan publishes",
  },
  {
    id: "news",
    source: "News wire",
    fills: "Headlines → catalyst inference, sentiment, freshness",
    stage: "news",
    keyless: false,
    note: "Alpaca + Finnhub + FMP + Yahoo RSS — merged & deduped",
  },
  {
    id: "sec",
    source: "SEC EDGAR",
    fills: "8-K material events + Form 4 insider filings + 13D activist stakes (90d)",
    stage: "news",
    keyless: true,
    note: "In the cloud scan these route via the Supabase market-proxy. Counts only across the universe — net open-market insider BUYS lift the Catalyst score (smart-money tilt) only where an aggregated buy read is attached; the scan never fetches per-filing Form 4 XML",
  },
  {
    id: "social",
    source: "StockTwits + ApeWisdom",
    fills: "Message volume & sentiment + Reddit/WSB mentions",
    stage: "social",
    keyless: true,
  },
  {
    id: "congress",
    source: "House Stock Watcher",
    fills: "Congressional trade disclosures (120d) — recent BUYS add a bounded Catalyst boost",
    stage: "social",
    keyless: true,
    note: "House only — the public Senate mirror is stale",
  },
];

/**
 * The AI Pick / Research Desk model lanes - distinct from the scoring SOURCE_LANES
 * above (those feed the deterministic 0–100 score; these write language only). Kept
 * separate so the inventory is complete WITHOUT implying AI touches the score.
 * Restates the real Research Desk edge function (supabase/functions/research-agent)
 * - keep in sync (CLAUDE.md fidelity rule). See SceneResearchDesk.
 */
export interface AiSource {
  id: string;
  source: string;
  fills: string;
  note: string;
}

export const AI_PICK_SOURCES: AiSource[] = [
  {
    id: "gemini",
    source: "Gemini",
    fills: "Grounded research for the AI Pick — a live web read anchored to verified Finnhub facts",
    note: "Google Gemini 2.5 Flash, in a Supabase edge function — never writes the 0–100 score",
  },
  {
    id: "groq",
    source: "Groq",
    fills: "The AI Pick’s Bull ‖ Bear ‖ Judge debate over the grounded notes",
    note: "Groq-hosted Llama 3.3 70B, server-side — argues both sides, then judges on the evidence",
  },
];

// ---------------------------------------------------------------------------
// Scoring (the engine-room beat) - all real config, re-exported above
// ---------------------------------------------------------------------------

/** src/engine/ranking.ts - researchRankScore evidence tilt. */
export const RANK_TILT = {
  confidencePerPoint: 0.18,
  confidencePivot: 70,
  riskPenaltyFactor: 0.25,
  summary:
    "Feeds rank by the opportunity score with a light evidence tilt: +0.18 × (confidence − 70) − 0.25 × risk penalty.",
} as const;

export const RISK_COMPONENT_LABELS: Record<keyof typeof RISK.components, string> = {
  solvency: "Solvency",
  dilution: "Dilution",
  shortInterest: "Short interest",
  governance: "Governance",
  extremeVol: "Extreme volatility",
  pumpRisk: "Pump / lottery risk",
  extension: "Extended / already ran",
};

// ---------------------------------------------------------------------------
// Feed assembly + personalization (the ranking + feedback beats)
// ---------------------------------------------------------------------------

// Imported from src/feed/feeds.ts - the SAME constants the selection engine
// runs on, so this explainer copy can never drift from live behavior again
// (it sat at "2 per sector" after the engine moved to 3).
export const FEED_RULES = {
  today: { limit: TODAY_LIMIT, sectorCap: TODAY_SECTOR_CAP },
  weekly: { limit: WEEKLY_LIMIT, sectorCap: WEEKLY_SECTOR_CAP },
} as const;

export interface PersonalizationBoost {
  id: string;
  label: string;
  /** The real multiplier/points from src/feed/feedAlgorithm.ts. */
  effect: string;
  /** The reason string the feed actually shows (when it shows one). */
  reason?: string;
}

/** Exact boost components inside personalize() - src/feed/feedAlgorithm.ts. */
export const PERSONALIZATION_BOOSTS: PersonalizationBoost[] = [
  { id: "sector", label: "Sector affinity", effect: "weight × 5", reason: "Matches your interest in {sector}" },
  { id: "cap", label: "Market-cap affinity", effect: "weight × 4", reason: "{bucket}-cap, like you've favored" },
  { id: "catalyst", label: "Catalyst affinity", effect: "weight × 4", reason: "{type} catalysts match your taps" },
  { id: "style", label: "Style tilt", effect: "alignment ± 5", reason: "Catalyst / momentum-driven" },
  { id: "risk", label: "Risk dial", effect: "risk-weighted rank + funnel breadth", reason: "Conservative ↔ aggressive" },
  { id: "liked", label: "Liked ticker", effect: "+14", reason: "You liked this" },
  { id: "muted", label: "Muted ticker", effect: "−30", reason: "You asked for less like this" },
  { id: "horizon", label: "Horizon fit", effect: "category fit ± 8", reason: "{horizon} fit" },
  { id: "archetype", label: "Discount + catalyst dial", effect: "axis × tilt × 16", reason: "Discounted with a live catalyst" },
];

export const PORTFOLIO_LEARNING = {
  winnerThreshold: "+5%",
  loserThreshold: "−8%",
  summary:
    "After every research run the engine reads your own holdings' P/L: winners nudge sector/catalyst affinity up (+0.12 / +0.08), losers nudge it down (−0.10 / −0.06), and chasing-highs losses strengthen the discount-with-catalyst dial.",
} as const;

// ---------------------------------------------------------------------------
// Divergence branches (the ending) - every destination tab, truthfully typed
// ---------------------------------------------------------------------------

export type BranchKind = "feed" | "instrument" | "loop";

export interface StoryBranch {
  id: string;
  path: string;
  label: string;
  kind: BranchKind;
  /** One-line truthful description of what this surface does. */
  tagline: string;
}

export const STORY_BRANCHES: StoryBranch[] = [
  { id: "today", path: "/today", label: "Today", kind: "feed", tagline: `Top ${FEED_RULES.today.limit} ranked signals, max ${FEED_RULES.today.sectorCap} per sector` },
  { id: "weekly", path: "/weekly", label: "Weekly", kind: "feed", tagline: `Top ${FEED_RULES.weekly.limit} by rank, ≤${FEED_RULES.weekly.sectorCap} per sector — the wider board` },
  { id: "for-you", path: "/for-you", label: "For You", kind: "feed", tagline: "Re-ranked by your taps, likes & horizon — filter chips snap it to a type" },
  { id: "forge", path: SYSTEM_NAV.forge.path, label: SYSTEM_NAV.forge.label, kind: "instrument", tagline: "Screen the scored universe with your own gates" },
  { id: "beacon", path: SYSTEM_NAV.beacon.path, label: SYSTEM_NAV.beacon.label, kind: "instrument", tagline: "Score any single ticker through the same engine" },
  { id: "terminal", path: SYSTEM_NAV.terminal.path, label: SYSTEM_NAV.terminal.label, kind: "instrument", tagline: "Live wire + ⌘K command bar into any ticker's workspace" },
  { id: "portfolios", path: "/portfolios", label: "Portfolios", kind: "loop", tagline: "Your holdings' P/L feeds back into the engine" },
];

// ---------------------------------------------------------------------------
// Story chapters (drive the progress rail + scene order)
// ---------------------------------------------------------------------------

export interface StoryChapter {
  id: string;
  title: string;
  /** Pipeline stages this chapter visualizes (for live-run mirroring). */
  stages: PipelineStageKey[];
}

export const STORY_CHAPTERS: StoryChapter[] = [
  { id: "hero", title: "The engine", stages: [] },
  { id: "discovery", title: "Discovery", stages: ["ingest"] },
  { id: "enrichment", title: "Evidence", stages: ["ingest", "news", "social"] },
  { id: "scoring", title: "Scoring", stages: ["score"] },
  { id: "ranking", title: "Ranking", stages: ["rank"] },
  { id: "divergence", title: "Where it lands", stages: [] },
];
