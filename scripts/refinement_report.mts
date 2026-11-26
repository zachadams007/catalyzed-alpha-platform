// IMPORTANT: bootstrap MUST be the first import - it installs the Node
// localStorage/window shims, seeds sample-mode OFF + budgets OFF, and loads
// scripts/universe_scan/.scan.env into process.env before any `@/` module reads
// it at load time. (Same import-order contract as scripts/backtest/replay.mts.)
import "./universe_scan/bootstrap.mjs";

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import type {
  MarketCapBucket,
  ScoreCategory,
  ScoreCategoryKey,
  Sector,
  StockSignal,
} from "@/types";
import {
  fetchRecentSharedSignals,
  type SharedDailySignals,
} from "@/data/dailySignalsCache";
import {
  getActiveVariant,
  postProcessUniverse,
  VARIANT_LABELS,
  type EngineVariantId,
} from "@/engine/challenger";
import {
  initGlobalControls,
  getGlobalControls,
  getScoreSpreadWeight,
} from "@/data/globalControls";
import {
  buildArchetypeContext,
  computeNormalizedScores,
  INFLECTION_V2_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
  REVERSAL_TILT_MAX,
  MAX_CATALYST_POINTS,
  MAX_SELL_PENALTY,
  MAX_REVISION_POINTS,
  type NormalizationContext,
  type NormalizedScore,
} from "@/engine/normalizeUniverse";
import { buildMarketRegimeContext } from "@/engine/regime";
import {
  capCohort,
  capCurveWeights,
  dampMomentumWeight,
  V5_MOMENTUM_WEIGHT_SCALE,
  type WeightVector,
} from "@/engine/capCurve";
import { isAlpacaConfigured } from "@/data/http";
import { fetchAlpacaBarsForSymbols } from "@/data/alpaca/bars";
import { CATEGORY_CONFIG } from "@/engine/scoringConfig";
import { mean, median, round } from "@/lib/math";

/**
 * scripts/refinement_report.mts - a REPEATABLE "refinement-session report".
 *
 * Dumps WHAT THE LIVE ALGORITHM PICKS + the SCORES + the per-dimension "why", so
 * the owner or a high-reasoning LLM can reason over the ACTUAL published board and
 * propose algorithm improvements - without touching any scoring/ranking logic.
 *
 * READ-ONLY consumption of the engine:
 *   • loads the published `daily_signals` board (the exact bytes the app reads)
 *     via {@link fetchRecentSharedSignals};
 *   • reads the operator's live `active_variant` from `app_controls` (the same
 *     source `getActiveVariant` uses in the app);
 *   • re-ranks the board under that LIVE variant with the SAME normalization pass
 *     the app runs ({@link postProcessUniverse} / {@link computeNormalizedScores}),
 *     rebuilding the normalization context (archetypes always; market regime from
 *     SPY bars when Alpaca is configured, else a documented neutral fallback).
 *
 * It never mutates the engine, the board, or any weight - every function called
 * here is a pure read of already-published data. Output: a JSON + a human-readable
 * Markdown report in docs/refinement/, both self-explanatory for an LLM reviewer
 * with no repo access.
 *
 * Run:  npx tsx scripts/refinement_report.mts
 *   or: vite-node scripts/refinement_report.mts   (matches the other scan scripts)
 *   or: npm run refine:report
 */

const TOP_N = 40;

const t0 = Date.now();
function log(msg: string): void {
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(6, " ");
  console.log(`[+${secs}s] ${msg}`);
}

// ---------------------------------------------------------------------------
// Board loading - the exact live board the app reads, with a direct fallback
// ---------------------------------------------------------------------------

/**
 * Direct anon-key read of the most-recent published `daily_signals` row, used
 * ONLY when the app's own loader returns null (e.g. vite-node didn't populate
 * `import.meta.env` for the shared client). Keys come from process.env
 * (bootstrap loaded .scan.env), never hardcoded - same VITE_* mechanism the app
 * and the scan use.
 */
async function fetchBoardDirect(): Promise<SharedDailySignals | null> {
  const url =
    process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon =
    process.env["VITE_SUPABASE_ANON_KEY"] ||
    process.env["SUPABASE_ANON_KEY"] ||
    "";
  if (!url || !anon) return null;
  try {
    const client = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client
      .from("daily_signals")
      .select("market_day, signals, run, computed_at, meta")
      .order("market_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as {
      market_day?: string;
      signals?: unknown;
      run?: unknown;
      computed_at?: string;
    };
    if (typeof row.market_day !== "string") return null;
    const signals = row.signals;
    if (!Array.isArray(signals) || signals.length === 0) return null;
    const computedAt =
      typeof row.computed_at === "string"
        ? row.computed_at
        : new Date().toISOString();
    return {
      signals: signals as StockSignal[],
      run: (row.run ?? {
        id: `shared_${row.market_day}`,
        startedAt: computedAt,
        finishedAt: computedAt,
        provider: "Direct daily_signals read",
        universeSize: signals.length,
        signalsGenerated: signals.length,
        trigger: "scheduled",
        status: "complete",
        stages: [],
      }) as SharedDailySignals["run"],
      computedAt,
      marketDay: row.market_day,
    };
  } catch {
    return null;
  }
}

/** Direct anon-key read of the operator's live active_variant. */
async function fetchActiveVariantDirect(): Promise<EngineVariantId | null> {
  const url =
    process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon =
    process.env["VITE_SUPABASE_ANON_KEY"] ||
    process.env["SUPABASE_ANON_KEY"] ||
    "";
  if (!url || !anon) return null;
  try {
    const client = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client
      .from("app_controls")
      .select("active_variant")
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return null;
    const v = (data as { active_variant?: unknown }).active_variant;
    return v === "challenger" ? "challenger" : "champion";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Regime context - rebuild the SAME context the scan built (best-effort)
// ---------------------------------------------------------------------------

interface RegimeSource {
  context: NormalizationContext;
  note: string;
}

async function buildContext(signals: StockSignal[]): Promise<RegimeSource> {
  const archetypes = buildArchetypeContext(signals);
  if (!isAlpacaConfigured()) {
    return {
      context: { archetypes, regime: buildMarketRegimeContext({ spyCloses: [], signals }) },
      note:
        "Alpaca not configured — market regime held NEUTRAL (breadth-only). The " +
        "published board itself was scored with the scan's live SPY-derived regime; " +
        "this re-rank uses a neutral regime, so risk-off tilts may differ slightly.",
    };
  }
  try {
    log("Fetching SPY bars from Alpaca to rebuild the market-regime context...");
    const bars = await fetchAlpacaBarsForSymbols(["SPY"], { limit: 260 });
    const spyCloses = bars["SPY"]?.closes ?? [];
    const regime = buildMarketRegimeContext({ spyCloses, signals });
    return {
      context: { archetypes, regime },
      note:
        `Market regime rebuilt from ${spyCloses.length} live SPY closes ` +
        `(label=${regime.label ?? "neutral"}, riskOffness=${(regime.riskOffness ?? 0).toFixed(2)}).`,
    };
  } catch (err) {
    return {
      context: { archetypes, regime: buildMarketRegimeContext({ spyCloses: [], signals }) },
      note: `SPY fetch failed (${(err as Error).message}); market regime held NEUTRAL (breadth-only).`,
    };
  }
}

// ---------------------------------------------------------------------------
// Derived per-pick facts
// ---------------------------------------------------------------------------

const NORMALIZATION_BY_VARIANT: Record<EngineVariantId, typeof INFLECTION_V2_NORMALIZATION> = {
  champion: INFLECTION_V2_NORMALIZATION,
  challenger: REVERSAL_V5_NORMALIZATION,
};

/**
 * REPORT-LOCAL MIRROR of `normalizeUniverse.ts`'s private `reversalTilt()` (P7).
 *
 * The live pass computes this per-name inside `computeNormalizedScores` (the owner's
 * large-cap discounted-REVERSAL archetype: washout × quality × size, one-sided
 * UP, bounded to `max`) but does NOT put it on the returned `NormalizedScore` -
 * it's folded straight into the ranking score and lost. Since it isn't exported
 * and this file must not edit `normalizeUniverse.ts`, this is a byte-for-byte
 * read-only replica (same inputs: `priceHistory`, `price`, `momentum`, the
 * `fundamentals` category score, `marketCap` - nothing internal/private) so the
 * report can show the ACTUAL points the flagship reversal mechanism gave each
 * pick. Keep in sync with `reversalTilt()` in `src/engine/normalizeUniverse.ts`
 * if that function ever changes.
 */
function clampLocal(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}

function reversalTiltMirror(signal: StockSignal, max: number): number {
  if (max <= 0) return 0;
  const closes = signal.priceHistory ?? [];
  const price = signal.price > 0 ? signal.price : (closes[closes.length - 1] ?? 0);
  if (closes.length < 120 || price <= 0) return 0;

  const high = Math.max(price, ...closes);
  const offHigh = high > 0 ? (high - price) / high : 0;
  const mom = signal.momentum;
  const below200 = mom?.aboveSMA200 ? 0 : 1;
  const rsi = mom?.rsi ?? 50;
  const oversold = clampLocal((45 - rsi) / 20);
  const offHighScore = clampLocal(offHigh / 0.3);
  const washout = (below200 + oversold + offHighScore) / 3;

  const fundDim = signal.score.categories.find((c) => c.key === "fundamentals")?.score ?? 50;
  const quality = clampLocal((fundDim - 40) / 40);

  const cap = signal.marketCap ?? 0;
  const size = cap > 0 ? clampLocal((Math.log10(cap) - 9.5) / (11.7 - 9.5)) : 0;

  const reversal = washout * quality * size;
  return round(max * reversal, 2);
}

function cat(signal: StockSignal, key: ScoreCategoryKey): ScoreCategory | undefined {
  return signal.score.categories.find((c) => c.key === key);
}

function catScore(signal: StockSignal, key: ScoreCategoryKey): number | null {
  const c = cat(signal, key);
  return c ? c.score : null;
}

/** Reversal-shaped = strong entry/value + weak momentum. Breakout-shaped = strong momentum. */
type Shape = "reversal" | "breakout" | "neutral";

function classifyShape(signal: StockSignal): Shape {
  const valuation = catScore(signal, "valuation");
  const momentum = catScore(signal, "momentum");
  if (valuation == null || momentum == null) return "neutral";
  if (valuation >= 60 && momentum <= 45) return "reversal";
  if (momentum >= 60) return "breakout";
  return "neutral";
}

interface PickRow {
  rank: number;
  ticker: string;
  name: string;
  sector: Sector;
  marketCapBucket: MarketCapBucket;
  marketCap: number;
  capCohort: string;
  capUnknown: boolean;
  price: number;
  currency: string;
  opportunityScore: number; // LIVE re-ranked value
  publishedOpportunityScore: number; // as stored on the board (champion-scored)
  confidence: number;
  riskLevel: string;
  riskPenalty: number;
  riskExplanation: string;
  catalystType: string;
  catalystLive: boolean;
  hypeTier: string;
  hypeScore: number;
  // archetype / reversal-relevant facts
  belowSMA50: boolean | null;
  belowSMA200: boolean | null;
  rsi: number | null;
  return1M: number | null;
  return3M: number | null;
  momentumScore: number | null;
  valuationScore: number | null;
  momentumVsValuationSplit: number | null; // valuation − momentum (positive = reversal-lean)
  shape: Shape;
  archetypeFlags: { megaReversal: boolean; compounder: boolean; smallRunner: boolean };
  thesisCleared: boolean;
  thesisReason: string;
  catalystTilt: number;
  discountTilt: number;
  /** P1 reversal-readiness 0..1 that scaled this pick's discount reward (1 = fall
   *  stopped / live-catalyst bypass; 0 = active falling knife). */
  reversalReadiness: number;
  sizeTilt: number;
  sizeBalanceTilt: number;
  catalystLead: string;
  // --- P7 audit-fidelity additions ---------------------------------------
  /** Other NormalizedScore fields not previously surfaced by this report. */
  revisionTilt: number;
  sellWatchTilt: number;
  catalystScore: number;
  /** Per-dimension cross-sectional z-scores the LIVE variant actually blended. */
  dimensionZ: Partial<Record<ScoreCategoryKey, number>>;
  /** REPLICATED (not read from NormalizedScore - see reversalTiltMirror above):
   *  the flagship large-cap discounted-reversal tilt, in LIVE display points. */
  reversalTilt: number;
  categories: Array<{
    key: ScoreCategoryKey;
    label: string;
    score: number;
    /** Flat CHAMPION weight as stored on the published board (scoreCompany priors). */
    boardWeight: number;
    /** ACTUAL per-name cap-cohort weight the LIVE variant blended with (after
     *  archetype overlay, regime tilt, and - for the challenger - dampMomentumWeight).
     *  This is what the live ranking used; boardWeight is NOT what ranked this pick. */
    liveWeight: number;
    contribution: number;
    explanation: string;
  }>;
}

function buildPickRow(
  signal: StockSignal,
  rank: number,
  norm: NormalizedScore,
  liveWeights: WeightVector,
): PickRow {
  const mom = signal.momentum;
  const capUnknown = signal.marketCapBucket === "Unknown" || !(signal.marketCap > 0);
  const momentumScore = catScore(signal, "momentum");
  const valuationScore = catScore(signal, "valuation");
  const flags = norm.archetypeFlags ?? {};
  return {
    rank,
    ticker: signal.ticker,
    name: signal.name,
    sector: signal.sector,
    marketCapBucket: signal.marketCapBucket,
    marketCap: signal.marketCap,
    capCohort: capCohort(signal.marketCap),
    capUnknown,
    price: signal.price,
    currency: signal.currency ?? "USD",
    opportunityScore: signal.score.opportunityScore,
    publishedOpportunityScore: norm.opportunityScore, // set by caller (see note below)
    confidence: signal.confidence,
    riskLevel: signal.riskLevel,
    riskPenalty: signal.score.riskPenalty,
    riskExplanation: signal.score.riskExplanation,
    catalystType: signal.catalystType,
    catalystLive: signal.catalystLive ?? false,
    hypeTier: signal.hype?.tier ?? "n/a",
    hypeScore: signal.hype?.score ?? 0,
    belowSMA50: mom?.aboveSMA50 == null ? null : !mom.aboveSMA50,
    belowSMA200: mom?.aboveSMA200 == null ? null : !mom.aboveSMA200,
    rsi: mom?.rsi ?? null,
    return1M: mom?.return1M ?? null,
    return3M: mom?.return3M ?? null,
    momentumScore,
    valuationScore,
    momentumVsValuationSplit:
      momentumScore != null && valuationScore != null
        ? round(valuationScore - momentumScore, 1)
        : null,
    shape: classifyShape(signal),
    archetypeFlags: {
      megaReversal: flags.megaReversal === true,
      compounder: flags.compounder === true,
      smallRunner: flags.smallRunner === true,
    },
    thesisCleared: norm.thesisCleared,
    thesisReason: norm.thesisReason,
    catalystTilt: norm.catalystTilt,
    discountTilt: norm.discountTilt,
    reversalReadiness: norm.reversalReadiness,
    sizeTilt: norm.sizeTilt,
    sizeBalanceTilt: norm.sizeBalanceTilt,
    catalystLead: norm.catalystLead,
    revisionTilt: norm.revisionTilt,
    sellWatchTilt: norm.sellWatchTilt,
    catalystScore: norm.catalystScore,
    dimensionZ: norm.dimensionZ,
    reversalTilt: reversalTiltMirror(signal, REVERSAL_TILT_MAX),
    categories: signal.score.categories.map((c) => ({
      key: c.key,
      label: c.label,
      score: c.score,
      boardWeight: c.weight,
      liveWeight: round(liveWeights[c.key] ?? 0, 4),
      contribution: c.contribution,
      explanation: c.explanation,
    })),
  };
}

// ---------------------------------------------------------------------------
// Board-level analytics
// ---------------------------------------------------------------------------

interface CategoryStat {
  key: ScoreCategoryKey;
  label: string;
  meanTop: number;
  medianTop: number;
  meanFull: number;
  medianFull: number;
  meanContributionTop: number;
}

function categoryStats(top: StockSignal[], full: StockSignal[]): CategoryStat[] {
  return CATEGORY_CONFIG.map((cfg) => {
    const topScores = top.map((s) => catScore(s, cfg.key)).filter((v): v is number => v != null);
    const fullScores = full.map((s) => catScore(s, cfg.key)).filter((v): v is number => v != null);
    const topContribs = top
      .map((s) => cat(s, cfg.key)?.contribution)
      .filter((v): v is number => v != null);
    const label = top.map((s) => cat(s, cfg.key)?.label).find((l) => l) ?? cfg.key;
    return {
      key: cfg.key,
      label,
      meanTop: topScores.length ? round(mean(topScores), 1) : 0,
      medianTop: topScores.length ? round(median(topScores), 1) : 0,
      meanFull: fullScores.length ? round(mean(fullScores), 1) : 0,
      medianFull: fullScores.length ? round(median(fullScores), 1) : 0,
      meanContributionTop: topContribs.length ? round(mean(topContribs), 2) : 0,
    };
  });
}

function distribution<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it] = (out[it] ?? 0) + 1;
  return out;
}

function histogram(values: number[], edges: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < edges.length - 1; i++) {
    out[`${edges[i]}-${edges[i + 1]}`] = 0;
  }
  for (const v of values) {
    for (let i = 0; i < edges.length - 1; i++) {
      if (v >= edges[i]! && (v < edges[i + 1]! || i === edges.length - 2)) {
        out[`${edges[i]}-${edges[i + 1]}`]! += 1;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

interface RefinementReport {
  generatedAt: string;
  marketDay: string;
  computedAt: string;
  activeVariant: EngineVariantId;
  activeVariantLabel: string;
  activeVariantSource: string;
  modelVersionLabel: string;
  momentumWeightScale: number;
  scoreSpreadWeight: number;
  universeSize: number;
  boardSize: number;
  boardScoringNote: string;
  regimeNote: string;
  topN: number;
  picks: PickRow[];
  analytics: {
    sectorDistributionTop: Record<string, number>;
    capBucketDistributionTop: Record<string, number>;
    capBucketDistributionFull: Record<string, number>;
    capCohortDistributionTop: Record<string, number>;
    unknownCapTop: number;
    unknownCapFull: number;
    belowSMA50Top: number;
    belowSMA200Top: number;
    belowSMA50KnownTop: number;
    belowSMA200KnownTop: number;
    momentumHistogramTop: Record<string, number>;
    reversalShapedTop: number;
    breakoutShapedTop: number;
    neutralShapedTop: number;
    categoryStats: CategoryStat[];
  };
  reviewerQuestions: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("Catalyzed Alpha — refinement-session report");

  // 1) Active variant (operator's live promotion), matching the app's source.
  let variantSource = "app getActiveVariant() (globalControls / build flag)";
  await initGlobalControls().catch(() => undefined);
  let activeVariant = getActiveVariant();
  const controls = getGlobalControls();
  if (controls) {
    activeVariant = controls.activeVariant;
    variantSource = `app_controls.active_variant (operator = ${controls.updatedBy ?? "unknown"})`;
  } else {
    const direct = await fetchActiveVariantDirect();
    if (direct) {
      activeVariant = direct;
      variantSource = "app_controls.active_variant (direct anon read)";
    } else {
      variantSource = "build-flag default (app_controls unavailable)";
    }
  }
  log(`Active LIVE variant: ${activeVariant} (${VARIANT_LABELS[activeVariant]}) — source: ${variantSource}`);

  // 2) Load the published board (the exact bytes the app reads).
  let board = await fetchRecentSharedSignals();
  let boardSource = "app fetchRecentSharedSignals()";
  if (!board) {
    board = await fetchBoardDirect();
    boardSource = "direct daily_signals read (anon key)";
  }
  if (!board) {
    console.error(
      "\nERROR: could not load the published daily_signals board from Supabase.\n" +
        "Checked the app loader and a direct anon read. Verify VITE_SUPABASE_URL / " +
        "VITE_SUPABASE_ANON_KEY are present in .env or scripts/universe_scan/.scan.env.\n",
    );
    process.exit(1);
  }
  log(`Loaded board via ${boardSource}: ${board.signals.length} signals, marketDay=${board.marketDay}.`);

  const universe = board.signals;

  // 3) Rebuild the normalization context (archetypes + regime) and re-rank the
  //    WHOLE board under the LIVE variant - the same pass the app runs.
  const { context, note: regimeNote } = await buildContext(universe);
  log(regimeNote);

  const reranked = postProcessUniverse(universe, activeVariant, context);
  // The full NormalizedScore detail (dimensionZ, tilts, thesis, archetype flags)
  // for every name under the LIVE variant, in board order (parallel to `universe`).
  const options = NORMALIZATION_BY_VARIANT[activeVariant];
  const normDetail = computeNormalizedScores(universe, context, options);
  const normByTicker = new Map<string, NormalizedScore>(normDetail.map((n) => [n.ticker, n]));

  // Sort by the LIVE opportunity score (descending) - this is what the algorithm PICKS.
  const rankedSignals = [...reranked].sort(
    (a, b) => b.score.opportunityScore - a.score.opportunityScore,
  );
  const top = rankedSignals.slice(0, TOP_N);

  const picks: PickRow[] = top.map((signal, i) => {
    const norm = normByTicker.get(signal.ticker) ?? {
      ticker: signal.ticker,
      opportunityScore: signal.score.opportunityScore,
      dimensionZ: {},
      thesisCleared: true,
      thesisReason: "",
      revisionScore: 50,
      revisionTilt: 0,
      sizeTilt: 0,
      catalystTilt: 0,
      sellWatchTilt: 0,
      discountTilt: 0,
      reversalReadiness: 1,
      sizeBalanceTilt: 0,
      catalystScore: 0,
      catalystLead: "",
      archetypeFlags: {},
    };
    // P7: the ACTUAL per-name weight vector the LIVE variant blended with - the
    // same derivation `computeNormalizedScores` does internally (capCurveWeights,
    // which applies the archetype overlay + regime tilt, then dampMomentumWeight
    // for the challenger). Falls back to an even/neutral vector if this variant
    // doesn't route weights by cohort (capCohortWeights off) - every current
    // profile has it on, so this only guards a future profile that doesn't.
    const baseVector = options.capCohortWeights
      ? capCurveWeights(signal.marketCap, norm.archetypeFlags, context.regime, signal.liquidity?.avgDollarVolume)
      : (Object.fromEntries(CATEGORY_CONFIG.map((c) => [c.key, c.weight])) as WeightVector);
    const liveWeights =
      options.momentumWeightScale != null && options.momentumWeightScale < 1
        ? dampMomentumWeight(baseVector, options.momentumWeightScale)
        : baseVector;
    const row = buildPickRow(signal, i + 1, norm, liveWeights);
    // `publishedOpportunityScore` on the board is the CHAMPION-scored value the
    // scan uploaded; expose it alongside the LIVE re-ranked score for contrast.
    const published = universe.find((s) => s.ticker === signal.ticker);
    row.publishedOpportunityScore = published?.score.opportunityScore ?? row.opportunityScore;
    return row;
  });

  // 4) Board-level analytics (top 40 vs full board).
  const capEdges = [0, 30, 40, 50, 60, 70, 80, 90, 101];
  const momTop = top.map((s) => catScore(s, "momentum")).filter((v): v is number => v != null);
  const shapes = top.map((s) => classifyShape(s));
  const belowSMA50Known = top.filter((s) => s.momentum?.aboveSMA50 != null);
  const belowSMA200Known = top.filter((s) => s.momentum?.aboveSMA200 != null);

  const analytics: RefinementReport["analytics"] = {
    sectorDistributionTop: distribution(top.map((s) => String(s.sector))),
    capBucketDistributionTop: distribution(top.map((s) => s.marketCapBucket)),
    capBucketDistributionFull: distribution(universe.map((s) => s.marketCapBucket)),
    capCohortDistributionTop: distribution(top.map((s) => capCohort(s.marketCap))),
    unknownCapTop: top.filter((s) => s.marketCapBucket === "Unknown").length,
    unknownCapFull: universe.filter((s) => s.marketCapBucket === "Unknown").length,
    belowSMA50Top: belowSMA50Known.filter((s) => !s.momentum!.aboveSMA50).length,
    belowSMA200Top: belowSMA200Known.filter((s) => !s.momentum!.aboveSMA200).length,
    belowSMA50KnownTop: belowSMA50Known.length,
    belowSMA200KnownTop: belowSMA200Known.length,
    momentumHistogramTop: histogram(momTop, capEdges),
    reversalShapedTop: shapes.filter((s) => s === "reversal").length,
    breakoutShapedTop: shapes.filter((s) => s === "breakout").length,
    neutralShapedTop: shapes.filter((s) => s === "neutral").length,
    categoryStats: categoryStats(top, universe),
  };

  // 5) Auto-generated reviewer questions from the data.
  const reviewerQuestions = buildReviewerQuestions(top, analytics);

  const report: RefinementReport = {
    generatedAt: new Date().toISOString(),
    marketDay: board.marketDay,
    computedAt: board.computedAt,
    activeVariant,
    activeVariantLabel: VARIANT_LABELS[activeVariant],
    activeVariantSource: variantSource,
    modelVersionLabel:
      activeVariant === "challenger"
        ? "V5 reversal-first (REVERSAL_V5_NORMALIZATION; momentum de-weighted ~70%)"
        : "V4/V2 Inflection champion (INFLECTION_V2_NORMALIZATION)",
    momentumWeightScale: activeVariant === "challenger" ? V5_MOMENTUM_WEIGHT_SCALE : 1,
    scoreSpreadWeight: getScoreSpreadWeight(),
    universeSize: universe.length,
    boardSize: universe.length,
    boardScoringNote:
      "The published board's stored opportunityScore is the CHAMPION (INFLECTION_V2) " +
      "ranking the daily scan uploaded (scan.mts calls postProcessUniverse(..., 'champion', ...)). " +
      "This report RE-RANKS that same board under the LIVE variant above, so the ranking here " +
      "reflects what the live algorithm actually surfaces. Each pick shows both the LIVE score " +
      "(opportunityScore) and the board's stored publishedOpportunityScore for contrast.",
    regimeNote,
    topN: TOP_N,
    picks,
    analytics,
    reviewerQuestions,
  };

  // 6) Write JSON + Markdown to docs/refinement/.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(repoRoot, "docs", "refinement");
  mkdirSync(outDir, { recursive: true });
  const stamp = board.marketDay;
  const jsonPath = join(outDir, `report-${stamp}.json`);
  const mdPath = join(outDir, `report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  log(`Wrote ${jsonPath}`);
  log(`Wrote ${mdPath}`);

  // Console summary.
  console.log(
    `\nTop ${TOP_N} under ${activeVariant} (${VARIANT_LABELS[activeVariant]}): ` +
      top.slice(0, 10).map((s) => `${s.ticker} ${s.score.opportunityScore}`).join(", ") +
      ` …\nReversal-shaped: ${analytics.reversalShapedTop}, breakout-shaped: ${analytics.breakoutShapedTop}, ` +
      `neutral: ${analytics.neutralShapedTop}. Unknown-cap in top ${TOP_N}: ${analytics.unknownCapTop}.`,
  );
}

// ---------------------------------------------------------------------------
// Reviewer questions (auto-generated from the board)
// ---------------------------------------------------------------------------

function buildReviewerQuestions(
  top: StockSignal[],
  a: RefinementReport["analytics"],
): string[] {
  const q: string[] = [];
  const n = top.length || 1;

  // Sector concentration > 40%.
  for (const [sector, count] of Object.entries(a.sectorDistributionTop)) {
    const pct = (count / n) * 100;
    if (pct > 40) {
      q.push(
        `Sector concentration: ${sector} is ${count}/${n} (${pct.toFixed(0)}%) of the top ${n}. ` +
          `Is the board over-concentrated, or does the current regime justify it?`,
      );
    }
  }

  // Any cap bucket entirely absent from the top N.
  const allBuckets: MarketCapBucket[] = ["Nano", "Micro", "Small", "Mid", "Large", "Mega"];
  const missing = allBuckets.filter((b) => !(a.capBucketDistributionTop[b] > 0));
  if (missing.length) {
    q.push(
      `Cap-bucket gaps: no ${missing.join(", ")} names reach the top ${n}. ` +
        `Is a whole size cohort being systematically excluded from what the algorithm surfaces?`,
    );
  }

  // Unknown-cap names ranked in the top N.
  if (a.unknownCapTop > 0) {
    const unknowns = top
      .filter((s) => s.marketCapBucket === "Unknown")
      .map((s) => s.ticker)
      .join(", ");
    q.push(
      `Unknown market-cap in top ${n}: ${a.unknownCapTop} name(s) — ${unknowns}. ` +
        `Unknown-cap routes to the small-cap curve; confirm these aren't mega-caps with a missing cap field ` +
        `(the TSM-style data-miss) that should be treated as large.`,
    );
  }

  // Dimensions whose contribution is ~zero everywhere in the top N.
  for (const cs of a.categoryStats) {
    if (Math.abs(cs.meanContributionTop) < 0.5 && Math.abs(cs.meanTop - 50) < 3) {
      q.push(
        `Near-dead dimension: "${cs.label}" (${cs.key}) has ~zero mean contribution (${cs.meanContributionTop}) ` +
          `and sits at ~neutral (mean ${cs.meanTop}) across the top ${n}. Is this dimension carrying any signal, ` +
          `or is it cold-start-neutral (no data) and effectively unused right now?`,
      );
    }
  }

  // Reversal-friendliness sanity: below-MA names should NOT be absent if the live
  // model is reversal-first (a stock must never be neglected SOLELY for being below an MA).
  if (a.belowSMA200KnownTop > 0 && a.belowSMA200Top === 0) {
    q.push(
      `Reversal-friendliness: 0 of the top ${n} are below their 200-DMA (of ${a.belowSMA200KnownTop} with known MA data). ` +
        `The live model is reversal-first (momentum de-weighted ~70%) — is it still implicitly favoring above-trend names, ` +
        `i.e. is a below-MA setup being neglected purely for being below its moving average?`,
    );
  }
  if (a.reversalShapedTop === 0) {
    q.push(
      `No reversal-shaped picks: 0 of the top ${n} are reversal-shaped (high valuation/entry score + low momentum), ` +
        `${a.breakoutShapedTop} are breakout-shaped. For a reversal-first live model, should more discounted/oversold ` +
        `setups be surfacing?`,
    );
  }

  // Momentum distribution skew.
  const momValues = top
    .map((s) => s.score.categories.find((c) => c.key === "momentum")?.score)
    .filter((v): v is number => v != null);
  if (momValues.length) {
    const hot = momValues.filter((v) => v >= 70).length;
    if (hot / momValues.length > 0.5) {
      q.push(
        `Momentum skew: ${hot}/${momValues.length} top picks score ≥70 on momentum. ` +
          `For a reversal-first model this is high — are we still chasing names already in an uptrend?`,
      );
    }
  }

  if (q.length === 0) {
    q.push(
      `No automatic red flags fired (sector concentration ≤40%, every cap bucket present, no dead dimensions, ` +
        `reversal setups present). Review the per-dimension contributions below for finer tuning opportunities.`,
    );
  }
  return q;
}

// ---------------------------------------------------------------------------
// Markdown rendering - self-explanatory for an LLM reviewer with no repo access
// ---------------------------------------------------------------------------

const CATEGORY_LEGEND: Record<ScoreCategoryKey, string> = {
  fundamentals: "Profitability / margins / balance-sheet quality (0-100).",
  growth: "Revenue & EPS growth rates (0-100).",
  momentum: "Trend / RSI / above-below 50 & 200-day moving averages (0-100). De-weighted ~70% in the live V5 model.",
  catalyst: "A dated, real catalyst event (earnings, product, M&A, clinical, etc.) and its magnitude/earliness (0-100).",
  conviction: "Additive-only smart-money / disclosed strategic-capital conviction (0-100).",
  news: "News coverage volume + freshness + tone, size-residualized (0-100).",
  social: "Social/retail + political mention volume & sentiment, size-residualized (0-100).",
  volatility: "Beta / ATR / implied vol — lower is calmer (0-100).",
  liquidity: "Average dollar volume & float, size-residualized (0-100).",
  valuation: "Entry/value timing — discounted vs its own range (high) vs chasing a top (low) (0-100).",
  inflection: "2nd-derivative fundamental RE-acceleration off a depressed base — the pre-move trigger (0-100).",
  pipeline: "Earliest hard forward signal: backlog / book-to-bill / a named contract win leading revenue (0-100).",
  sentimentShift: "DELTA of tone/attention vs the stock's OWN 20-day baseline, gated for substance (0-100).",
};

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(0)}%` : "0%";
}

function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return v.toFixed(digits);
}

function fmtRatioPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(1)}%`;
}

function distributionTable(dist: Record<string, number>, total: number): string {
  const rows = Object.entries(dist)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `| ${k} | ${v} | ${pct(v, total)} |`)
    .join("\n");
  return `| Bucket | Count | Share |\n|---|---:|---:|\n${rows}`;
}

function renderPick(p: PickRow): string {
  const capNote = p.capUnknown ? " ⚠️ **UNKNOWN cap** (routed to small-cap curve)" : "";
  const arche = [
    p.archetypeFlags.megaReversal ? "megaReversal" : null,
    p.archetypeFlags.compounder ? "compounder" : null,
    p.archetypeFlags.smallRunner ? "smallRunner" : null,
  ].filter(Boolean);
  const catRows = p.categories
    .map(
      (c) =>
        `| ${c.key} | ${fmtNum(c.score, 0)} | ${fmtNum(c.boardWeight, 3)} | ${fmtNum(c.liveWeight, 3)} | ${fmtNum(c.contribution, 2)} | ${c.explanation.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  const dimZRows = (Object.keys(p.dimensionZ) as ScoreCategoryKey[])
    .filter((k) => p.dimensionZ[k] != null)
    .map((k) => `${k}=${fmtNum(p.dimensionZ[k], 2)}`)
    .join(" · ");
  return [
    `### ${p.rank}. ${p.ticker} — ${p.name}`,
    ``,
    `- **Sector:** ${p.sector} · **Cap bucket:** ${p.marketCapBucket}${capNote} · **Cohort:** ${p.capCohort} · **Market cap:** ${p.marketCap > 0 ? `$${(p.marketCap / 1e9).toFixed(2)}B` : "unknown"}`,
    `- **Price:** ${p.price > 0 ? `${p.price.toFixed(2)} ${p.currency}` : "n/a"}`,
    `- **LIVE opportunity score:** ${p.opportunityScore} · **Board (champion) score:** ${p.publishedOpportunityScore} · **Confidence:** ${p.confidence} · **Risk:** ${p.riskLevel} (penalty ${p.riskPenalty})`,
    `- **Catalyst:** ${p.catalystType}${p.catalystLive ? " (live)" : " (none/inferred)"}${p.catalystLead ? ` — lead: ${p.catalystLead}` : ""} · **Hype:** ${p.hypeTier} (${p.hypeScore}) · **Catalyst strength (0-100):** ${fmtNum(p.catalystScore, 0)}`,
    `- **Reversal facts:** below-50DMA=${p.belowSMA50 == null ? "n/a" : p.belowSMA50} · below-200DMA=${p.belowSMA200 == null ? "n/a" : p.belowSMA200} · RSI=${fmtNum(p.rsi, 0)} · 1M=${fmtRatioPct(p.return1M)} · 3M=${fmtRatioPct(p.return3M)}`,
    `- **Shape:** ${p.shape} (valuation ${fmtNum(p.valuationScore, 0)} − momentum ${fmtNum(p.momentumScore, 0)} = split ${fmtNum(p.momentumVsValuationSplit, 1)}) · **Archetypes:** ${arche.length ? arche.join(", ") : "none"}`,
    `- **Thesis gate:** ${p.thesisCleared ? "cleared" : "soft-gated"} — ${p.thesisReason.replace(/\n/g, " ")}`,
    `- **LANE-D + reversal tilts (LIVE display pts):** catalyst +${fmtNum(p.catalystTilt, 2)} · discount ${fmtNum(p.discountTilt, 2)} (readiness ×${fmtNum(p.reversalReadiness, 2)}) · sellWatch ${fmtNum(p.sellWatchTilt, 2)} · revision ${fmtNum(p.revisionTilt, 2)} · sizeTilt ${fmtNum(p.sizeTilt, 2)} · sizeBalance ${fmtNum(p.sizeBalanceTilt, 2)} · **reversalTilt +${fmtNum(p.reversalTilt, 2)}**`,
    `- **Dimension z-scores (LIVE, cross-sectional):** ${dimZRows || "n/a"}`,
    `- **Risk note:** ${p.riskExplanation.replace(/\n/g, " ")}`,
    ``,
    `| Category | Score | boardWeight (champion-stored) | liveWeight (V5 cohort) | Contribution | Explanation |`,
    `|---|---:|---:|---:|---:|---|`,
    catRows,
    ``,
  ].join("\n");
}

function renderMarkdown(r: RefinementReport): string {
  const n = r.picks.length;
  const legendRows = (Object.keys(CATEGORY_LEGEND) as ScoreCategoryKey[])
    .map((k) => `| \`${k}\` | ${CATEGORY_LEGEND[k]} |`)
    .join("\n");

  const catStatRows = r.analytics.categoryStats
    .map(
      (c) =>
        `| ${c.key} | ${c.meanTop} | ${c.medianTop} | ${c.meanFull} | ${c.medianFull} | ${c.meanContributionTop} |`,
    )
    .join("\n");

  const momHistRows = Object.entries(r.analytics.momentumHistogramTop)
    .map(([band, count]) => `| ${band} | ${count} |`)
    .join("\n");

  return [
    `# Catalyzed Alpha — Refinement-Session Report`,
    ``,
    `**Generated:** ${r.generatedAt}`,
    `**Market day (board):** ${r.marketDay} · **Board computed at:** ${r.computedAt}`,
    `**LIVE variant:** \`${r.activeVariant}\` (${r.activeVariantLabel}) — ${r.modelVersionLabel}`,
    `**Variant source:** ${r.activeVariantSource}`,
    `**Universe / board size:** ${r.universeSize} · **Top picks reported:** ${r.topN}`,
    `**Score-spread dial:** ${r.scoreSpreadWeight} · **Momentum weight scale (V5):** ${r.momentumWeightScale}`,
    ``,
    `---`,
    ``,
    `## How to read this report (legend for a reviewer with no repo access)`,
    ``,
    `This app scores a universe of US/TSX stocks on an explainable 0-100 scale and surfaces them`,
    `as a social-style feed of *short-term catalyst / momentum swing* ideas (no trading, no advice —`,
    `discovery only). Each stock gets a **blended opportunity score (0-100)** = a weighted average of`,
    `per-dimension sub-scores, minus a risk penalty, after a cross-sectional cap-balancing pass.`,
    ``,
    `**Scoring pipeline:** \`scoreCompany\` scores each name in isolation → a cross-sectional`,
    `normalization pass re-expresses every dimension RELATIVE to the universe (size-residualize`,
    `coverage/volume dims; sector-neutralize the slow quality factors; rank→inverse-normal z-score),`,
    `then blends with **cap-cohort weights** (small/micro names judged on the curve that predicts`,
    `THEIR runs; large names on a margin-inflection + entry-timing + trend curve), applies bounded`,
    `LANE-D tilts (catalyst up, disclosed selling down, discounted-entry up / chasing-highs down,`,
    `large-cap washed-out-quality reversal up), a fear&greed-driven regime tilt (panic → leans into`,
    `discounted QUALITY, never a safety rotation to low-vol/defensive names — see the Regime read`,
    `section below), and finally a monotone display-decompression so the 0-100 scale is used fully.`,
    ``,
    `**V5 live blend context:** the LIVE model is the **reversal / breakout-first** variant — it is`,
    `the V4 inflection champion with ONE change: **momentum's blend weight is cut ~70%** (kept at`,
    `${r.momentumWeightScale} of its value) and redistributed into the early-entry signals`,
    `(inflection, entry/value timing, catalyst, sentiment-shift, pipeline). The thesis: we hunt`,
    `reversals/breakouts BEFORE the move, so a name being below its moving averages should barely`,
    `drag it. An **archetype router** (megaReversal / compounder / smallRunner) bends each name's`,
    `weight vector toward the profile that fits it, and a **fear&greed regime tilt** shifts the whole`,
    `board toward discounted QUALITY in panic (never a safety rotation — see the Regime read section).`,
    `**A stock must never be neglected SOLELY for being below a`,
    `moving average** — the below-MA counts below are the reversal-friendliness check.`,
    ``,
    `> **Board scoring note:** ${r.boardScoringNote}`,
    ``,
    `> **Regime note:** ${r.regimeNote}`,
    ``,
    `### Category legend`,
    ``,
    `| Key | Meaning |`,
    `|---|---|`,
    legendRows,
    ``,
    `- **contribution** = boardWeight × score (the points a category added on the PUBLISHED board;`,
    `  the live-ranked contribution would use liveWeight instead — not recomputed here, see note below).`,
    `- **Shape:** *reversal-shaped* = valuation/entry ≥60 AND momentum ≤45 (cheap + not-yet-moving);`,
    `  *breakout-shaped* = momentum ≥60 (already trending up); else *neutral*.`,
    `- **split** = valuation − momentum sub-score (positive ⇒ reversal-lean, negative ⇒ momentum-lean).`,
    ``,
    `### Weight columns — READ THIS BEFORE AUDITING WEIGHTS (P7 fix)`,
    ``,
    `Every pick's category table now shows TWO weight columns, because they are NOT the same number:`,
    ``,
    `- **boardWeight (champion-stored):** the FLAT \`CATEGORY_CONFIG\` prior baked into \`scoreCompany\`,`,
    `  identical for every name (e.g. momentum = 0.100 for everyone). This is what's stored on the`,
    `  published \`daily_signals\` row and is NOT what ranked this pick under the live variant.`,
    `- **liveWeight (V5 cohort):** the ACTUAL per-name weight the LIVE variant blended with —`,
    `  \`capCurveWeights(marketCap, archetypeFlags, regime)\` (small vs. large cap-cohort curve, then`,
    `  bent toward the megaReversal/compounder/smallRunner archetype profile if tagged, then tilted`,
    `  toward PANIC_QUALITY_WEIGHTS (discounted-quality panic mode, not flight-to-safety) if the regime is fearful) — and, for the V5 challenger, additionally`,
    `  passed through \`dampMomentumWeight(scale=${r.momentumWeightScale})\`, which cuts momentum to`,
    `  ~${r.momentumWeightScale}× and redistributes the freed weight into inflection / valuation /`,
    `  catalyst / sentimentShift / pipeline. This is the vector that actually produced the LIVE`,
    `  opportunity score and ranking above — **use this column, not boardWeight, when reasoning about**`,
    `  **why the live model favored one dimension over another.**`,
    ``,
    `### Tilt legend (LANE-D + reversal, one line each)`,
    ``,
    `| Tilt | Meaning |`,
    `|---|---|`,
    `| **catalystTilt** | Bounded + points (max ${MAX_CATALYST_POINTS}) for a strong, early, dated catalyst of any type — one-sided up, 0 if none. |`,
    `| **discountTilt** | Bounded ± points rewarding a discounted entry WITH a thesis behind it, penalizing "already ran / chasing highs". The REWARD leg is now (P1) scaled by reversal-readiness and (P4) only paid when the thesis backer is genuinely data-backed (raw ≥55, not a cold-start neutral-50). |`,
    `| **readiness** | P1 reversal-readiness 0..1 (down-leg deceleration + basing/vol-contraction from priceHistory) that MULTIPLIES the discount reward: 1 = the fall has stopped or a live catalyst bypassed the gate; 0 = an active falling knife (deeply oversold + a fresh >25% monthly drop, no catalyst). It only scales the reward (a bonus) — a name is NEVER penalized for being below a moving average. |`,
    `| **sellWatchTilt** | Bounded − points (max ${MAX_SELL_PENALTY}) for material disclosed insider selling; threshold-gated, 0 for routine sales. |`,
    `| **revisionTilt** | Bounded ± points (max ${MAX_REVISION_POINTS}) for consensus EPS estimates being revised up/down; 0 with no snapshot history. |`,
    `| **sizeTilt** | Structural, ~zero-mean small/mid-cap balancing nudge applied AFTER size-residualization, so the surfaced set is cap-BALANCED not just cap-neutral. |`,
    `| **sizeBalanceTilt** | Correction that strips the part of the catalyst+sell+discount+revision bundle that's explained by market cap (OLS residual), so those tilts don't quietly re-skew the board toward small-caps. |`,
    `| **reversalTilt** | Bounded + points (max ${REVERSAL_TILT_MAX}, one-sided up) for the large-cap discounted-REVERSAL archetype: washout (below-200DMA + oversold RSI + deep off-high) × quality (fundamentals) × size (large-cap only), ALL multiplicative so a low-quality falling knife scores ~0. **Not stored on NormalizedScore by the engine — this report replicates the pure, exported-inputs-only formula locally (see \`reversalTiltMirror\` in this file) to make the flagship reversal mechanism auditable.** |`,
    ``,
    `---`,
    ``,
    `## Board-level analytics (top ${n} vs full board of ${r.boardSize})`,
    ``,
    `### Sector distribution (top ${n})`,
    ``,
    distributionTable(r.analytics.sectorDistributionTop, n),
    ``,
    `### Cap-bucket distribution`,
    ``,
    `**Top ${n}:**`,
    ``,
    distributionTable(r.analytics.capBucketDistributionTop, n),
    ``,
    `**Full board (${r.boardSize}):**`,
    ``,
    distributionTable(r.analytics.capBucketDistributionFull, r.boardSize),
    ``,
    `- **Unknown-cap in top ${n}:** ${r.analytics.unknownCapTop} · **Unknown-cap in full board:** ${r.analytics.unknownCapFull}`,
    `- **Cap cohort (top ${n}):** ${Object.entries(r.analytics.capCohortDistributionTop).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    ``,
    `### Reversal-friendliness (top ${n})`,
    ``,
    `- **Below 50-DMA:** ${r.analytics.belowSMA50Top} of ${r.analytics.belowSMA50KnownTop} with known MA data`,
    `- **Below 200-DMA:** ${r.analytics.belowSMA200Top} of ${r.analytics.belowSMA200KnownTop} with known MA data`,
    `- **Reversal-shaped:** ${r.analytics.reversalShapedTop} · **Breakout-shaped:** ${r.analytics.breakoutShapedTop} · **Neutral:** ${r.analytics.neutralShapedTop}`,
    ``,
    `### Momentum sub-score distribution (top ${n})`,
    ``,
    `| Band | Count |`,
    `|---|---:|`,
    momHistRows,
    ``,
    `### Per-category scores — top ${n} vs full board`,
    ``,
    `| Category | Mean (top) | Median (top) | Mean (full) | Median (full) | Mean contribution (top) |`,
    `|---|---:|---:|---:|---:|---:|`,
    catStatRows,
    ``,
    `---`,
    ``,
    `## Questions for the reviewer (auto-generated from this board)`,
    ``,
    r.reviewerQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
    ``,
    `---`,
    ``,
    `## Top ${n} ranked picks under the LIVE variant`,
    ``,
    r.picks.map(renderPick).join("\n"),
  ].join("\n");
}

main().catch((err) => {
  console.error("Refinement report error:", err);
  process.exit(1);
});
