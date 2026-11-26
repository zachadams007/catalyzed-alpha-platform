import type { ScoreCategoryKey } from "@/types";
import { percentileRank, round } from "@/lib/math";
import { CATEGORY_CONFIG } from "./scoringConfig";
import {
  normalizeLedger,
  type ForwardWindow,
  type ModelId,
  type OutcomeEntry,
  type OutcomeLedger,
} from "./outcomeLedger";

/**
 * Champion / Challenger measurement - the honest "is the new ranking actually
 * better?" math (adaptive-algorithm brief §5; discovery-overhaul handoff).
 *
 * The metric is the **rank Information Coefficient (rank-IC)**: per publish-day
 * cohort, the Spearman correlation between a model's score and the realized
 * forward return - "did higher-ranked names actually rise more, that day?". We
 * average the per-cohort ICs (the cross-section is what we rank within), and the
 * cohort spread gives the significance (ICIR, t-stat). Pre-registered promotion
 * rule: the challenger must lead on ΔIC with a significant paired t-stat over a
 * meaningful number of independent cohorts. Everything here is PURE.
 */

/** Cohorts smaller than this can't produce a meaningful cross-sectional rank. */
const MIN_COHORT_NAMES = 5;
/** Independent cohorts (days) required before a promotion can be conclusive. */
export const PROMOTION_MIN_COHORTS = 30;
/** Paired t-stat the ΔIC must clear (~2σ) to call the challenger better. */
export const PROMOTION_MIN_TSTAT = 2.0;

export interface RankICStat {
  /** Mean per-cohort Spearman IC. */
  meanIC: number;
  /** Information Ratio: meanIC / std(IC). */
  icir: number;
  /** t-stat of the mean IC across cohorts (icir × √cohorts). */
  tStat: number;
  /** Cohorts with a computable IC. */
  cohorts: number;
  /** Total scored picks across those cohorts. */
  n: number;
}

export interface RankICResult {
  window: ForwardWindow;
  modelId: ModelId;
  /** IC of the model's opportunity score vs forward return. */
  overall: RankICStat;
  /** IC of each individual category score vs forward return. */
  perCategory: Partial<Record<ScoreCategoryKey, RankICStat>>;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i]! - mx) * (ys[i]! - my);
    vx += (xs[i]! - mx) ** 2;
    vy += (ys[i]! - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null; // no spread → correlation undefined
  return cov / Math.sqrt(vx * vy);
}

/** Spearman rank correlation (Pearson on midrank fractional ranks). */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  return pearson(percentileRank(xs), percentileRank(ys));
}

function meanStd(values: number[]): { mean: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** A model's score for an entry - opportunity, or a single category. */
function modelScore(
  entry: OutcomeEntry,
  modelId: ModelId,
  categoryKey?: ScoreCategoryKey,
): number | undefined {
  if (modelId === "champion") {
    const m = entry.modelScores?.champion;
    const cats = m?.categoryScores ?? entry.categoryScores;
    if (categoryKey) return cats?.[categoryKey];
    return m?.opportunityScore ?? entry.opportunityScore;
  }
  const m = entry.modelScores?.challenger;
  if (!m) return undefined; // entry predates the challenger upgrade
  if (categoryKey) return m.categoryScores?.[categoryKey];
  return m.opportunityScore;
}

interface CohortIC {
  day: string;
  ic: number;
  n: number;
}

/** Per-publish-day Spearman IC of a model's (category) score vs forward return. */
function cohortICs(
  entries: OutcomeEntry[],
  window: ForwardWindow,
  modelId: ModelId,
  categoryKey?: ScoreCategoryKey,
): CohortIC[] {
  const byDay = new Map<string, Array<{ score: number; ret: number }>>();
  for (const e of entries) {
    const ret = e.forwardReturns[window];
    if (ret == null || !Number.isFinite(ret)) continue;
    const score = modelScore(e, modelId, categoryKey);
    if (score == null || !Number.isFinite(score)) continue;
    const day = dayKey(e.publishedAtISO);
    const bucket = byDay.get(day) ?? [];
    bucket.push({ score, ret });
    byDay.set(day, bucket);
  }

  const out: CohortIC[] = [];
  for (const [day, rows] of byDay) {
    if (rows.length < MIN_COHORT_NAMES) continue;
    const ic = spearman(
      rows.map((r) => r.score),
      rows.map((r) => r.ret),
    );
    if (ic == null) continue; // no score/return spread that day
    out.push({ day, ic, n: rows.length });
  }
  // Stable order (chronological) for deterministic pairing/output.
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return out;
}

function statFromCohorts(cohorts: CohortIC[]): RankICStat {
  const ics = cohorts.map((c) => c.ic);
  const { mean, std } = meanStd(ics);
  const k = ics.length;
  const icir = std > 0 ? mean / std : 0;
  const tStat = std > 0 && k > 0 ? (mean / std) * Math.sqrt(k) : 0;
  return {
    meanIC: round(mean, 4),
    icir: round(icir, 3),
    tStat: round(tStat, 3),
    cohorts: k,
    n: cohorts.reduce((s, c) => s + c.n, 0),
  };
}

/** Rank-IC for a model on one window - overall + per category. */
export function computeRankIC(
  ledger: OutcomeLedger,
  window: ForwardWindow,
  modelId: ModelId,
): RankICResult {
  const base = normalizeLedger(ledger);
  const overall = statFromCohorts(cohortICs(base.entries, window, modelId));
  const perCategory: Partial<Record<ScoreCategoryKey, RankICStat>> = {};
  for (const cfg of CATEGORY_CONFIG) {
    perCategory[cfg.key] = statFromCohorts(cohortICs(base.entries, window, modelId, cfg.key));
  }
  return { window, modelId, overall, perCategory };
}

export interface ModelComparison {
  window: ForwardWindow;
  champion: RankICStat;
  challenger: RankICStat;
  /** challenger.meanIC − champion.meanIC. */
  deltaIC: number;
  /** Fraction of SHARED cohorts where the challenger's IC beat the champion's. */
  winRate: number;
  /** Cohorts where BOTH models have a computable IC (the paired sample). */
  cohorts: number;
  /** Paired t-stat of the per-cohort IC difference (challenger − champion). */
  deltaTStat: number;
  /** True only when the pre-registered promotion bar is cleared. */
  promote: boolean;
  /** Honest one-line read of where the comparison stands. */
  rationale: string;
}

/** Champion vs challenger on one window, with the pre-registered promotion test. */
export function compareModels(ledger: OutcomeLedger, window: ForwardWindow): ModelComparison {
  const base = normalizeLedger(ledger);
  const champCohorts = cohortICs(base.entries, window, "champion");
  const challCohorts = cohortICs(base.entries, window, "challenger");
  const championStat = statFromCohorts(champCohorts);
  const challengerStat = statFromCohorts(challCohorts);

  const champByDay = new Map(champCohorts.map((c) => [c.day, c.ic]));
  const diffs: number[] = [];
  let wins = 0;
  for (const c of challCohorts) {
    const champIc = champByDay.get(c.day);
    if (champIc == null) continue; // only days both models scored
    const d = c.ic - champIc;
    diffs.push(d);
    if (d > 0) wins += 1;
  }

  const k = diffs.length;
  const deltaIC = round(challengerStat.meanIC - championStat.meanIC, 4);
  const winRate = k > 0 ? round(wins / k, 3) : 0;
  const { mean: dMean, std: dStd } = meanStd(diffs);
  const deltaTStat = k >= 2 && dStd > 0 ? round((dMean / dStd) * Math.sqrt(k), 3) : 0;
  const promote = deltaIC > 0 && k >= PROMOTION_MIN_COHORTS && deltaTStat >= PROMOTION_MIN_TSTAT;

  return {
    window,
    champion: championStat,
    challenger: challengerStat,
    deltaIC,
    winRate,
    cohorts: k,
    deltaTStat,
    promote,
    rationale: buildRationale({ deltaIC, k, deltaTStat, promote }),
  };
}

function buildRationale(args: {
  deltaIC: number;
  k: number;
  deltaTStat: number;
  promote: boolean;
}): string {
  const { deltaIC, k, deltaTStat, promote } = args;
  if (k === 0) {
    return "No paired cohorts yet — both models need to score the same days and have forward returns land first.";
  }
  if (promote) {
    return `Challenger leads by ΔIC ${deltaIC.toFixed(4)} over ${k} cohorts (t=${deltaTStat.toFixed(2)}) — clears the promotion bar.`;
  }
  const lead = deltaIC > 0 ? "ahead" : deltaIC < 0 ? "behind" : "level";
  const why =
    k < PROMOTION_MIN_COHORTS
      ? `only ${k}/${PROMOTION_MIN_COHORTS} cohorts`
      : Math.abs(deltaTStat) < PROMOTION_MIN_TSTAT
        ? `t=${deltaTStat.toFixed(2)} (need ≥${PROMOTION_MIN_TSTAT})`
        : "ΔIC not positive";
  return `Challenger ${lead} by ΔIC ${deltaIC.toFixed(4)} — directional, not conclusive (${why}).`;
}
