import type { ScoreCategoryKey } from "@/types";
import { round } from "@/lib/math";

/**
 * The thesis gate (Mission 4) - AQR's "integrate, don't mix" soft requirement.
 *
 * A name worth ranking high should have BOTH a reason to move (a discounted entry
 * OR a live catalyst) AND something behind it (fundamentals OR growth). This gate
 * checks those two legs against a cross-sectional percentile floor and returns a
 * per-name "why it cleared" reason. It is SOFT: a miss is demoted by a small,
 * bounded penalty - never removed - so the feed can never empty. It runs inside
 * the challenger normalization (on the per-dimension z-scores), so it's a
 * challenger-only refinement; the champion model is untouched.
 *
 * Pure: z-scores in, verdict out.
 */

/** Floor on the stronger leg, as a z-score (~34th percentile). */
const FLOOR_Z = -0.4;
/** Attention/hype/sentiment only counts as a "reason to move" when CLEARLY above
 *  the pack (~69th percentile), never at the neutral median - keeps the gate
 *  meaningful while sentimentShift is a flat 50 at cold-start. */
const ATTENTION_FLOOR_Z = 0.5;
/** Max soft demotion in display points - bounded so the feed never empties. */
export const MAX_THESIS_PENALTY = 8;
/**
 * A backer only counts as a genuine, DATA-BACKED reason once its RAW sub-score
 * clears this floor (P4, refinement proposal 2026-07-02 §1d.1). Every cold-start
 * scorer returns EXACTLY the neutral default when it has no inputs (inflection /
 * pipeline / growth / sentimentShift → 50, catalyst → 0), so `raw ≥ 55` cleanly
 * excludes "we have no data" while admitting any genuinely positive read. This
 * stops the midrank artifact - a no-data block sitting at neutral-50 lands ABOVE
 * the median of the real (lower) reads and earns a positive z - from being cited
 * as, or paying out for, "backed by a fundamental inflection" it doesn't have.
 */
export const DATA_BACKED_MIN_SCORE = 55;

export interface ThesisResult {
  /** True when both legs clear the floor. */
  cleared: boolean;
  /** Plain-English reason it cleared, or what it's soft-gated for. */
  reason: string;
  /** Soft demotion in display points (0 when cleared). */
  penalty: number;
}

export function thesisGate(
  dimZ: Partial<Record<ScoreCategoryKey, number>>,
  /**
   * RAW 0..100 sub-scores for the same name. When supplied (the live pass always
   * does), the solidity leg may only NAME a backer that is genuinely data-backed
   * (raw ≥ {@link DATA_BACKED_MIN_SCORE}) - a cold-start neutral dimension can still
   * let the name clear (the gate stays soft) but must fall back to honest copy
   * instead of claiming a backer it has no data for (P4). Omitted ⇒ legacy behavior
   * (every dimension eligible to be named), so existing callers/tests are unchanged.
   */
  dimRaw?: Partial<Record<ScoreCategoryKey, number>>,
): ThesisResult {
  const z = (k: ScoreCategoryKey) => dimZ[k] ?? 0;
  const dataBacked = (k: ScoreCategoryKey) =>
    dimRaw == null || (dimRaw[k] ?? 0) >= DATA_BACKED_MIN_SCORE;
  // Leg 1 - a reason to move. Originally only "a discounted entry OR a live
  // catalyst", which unfairly soft-gated a high-profile name moving on HYPE /
  // ATTENTION / a POLITICAL CALLOUT / a turning sentiment but not (yet) cheap and
  // with no structured dated catalyst (the owner's #1 complaint: LLY/HIMS/RDDT/NOK/INTC
  // shouldn't drop when they have a real catalyst). A turning conversation or a
  // surge of credible attention IS a reason to move - so sentimentShift + news +
  // social now also satisfy the move leg. This can't let a pump through: the
  // SOLIDITY leg below still requires fundamentals / growth / inflection / pipeline,
  // which a no-substance pump lacks.
  // Primary reasons (a discounted entry OR a live catalyst) clear at the normal
  // floor. ATTENTION / HYPE / a POLITICAL CALLOUT / a turning sentiment ALSO count -
  // but only when CLEARLY ELEVATED above the pack (z ≥ ATTENTION_FLOOR_Z), never at
  // the neutral median: research shows attention is a fast, present-tense move
  // signal, and sentimentShift is a flat 50 at cold-start (z≈0), so a positive floor
  // keeps the gate meaningful until real series accrue. A median-attention name does
  // NOT clear on attention alone; the SOLIDITY leg below still filters pure pumps.
  const valZ = z("valuation");
  const catZ = z("catalyst");
  const primaryMove = Math.max(valZ, catZ);
  const attnZ = Math.max(z("sentimentShift"), z("news"), z("social"));
  const moveViaAttention = attnZ >= ATTENTION_FLOOR_Z;
  const attentionLeads = moveViaAttention && attnZ > primaryMove;
  const moveLeg = attentionLeads ? attnZ : primaryMove;
  const moveLabel = attentionLeads
    ? z("sentimentShift") >= Math.max(z("news"), z("social"))
      ? "a turning sentiment"
      : "a surge of attention"
    : catZ >= valZ
      ? "a live catalyst"
      : "a discounted entry";
  // Leg 2 - something behind it (v2 third leg): fundamentals OR growth OR a
  // fundamental INFLECTION OR a hard PIPELINE. This is what lets a pre-revenue name
  // with a real contract/backlog or a margin-inflection clear, while a pure-
  // narrative pump (no inflection, no pipeline, no fundamentals) stays soft-demoted.
  const backers: Array<[ScoreCategoryKey, string]> = [
    ["fundamentals", "fundamentals"],
    ["growth", "growth"],
    ["inflection", "a fundamental inflection"],
    ["pipeline", "a building pipeline"],
  ];
  // `solidityLeg` (max z over ALL backers) still drives the soft clear/penalty math
  // - the gate stays demote-never-remove, so a cold-start board never empties. But
  // the LABEL may only cite a backer that is genuinely data-backed (raw ≥ floor);
  // if none is, we clear on breadth with honest copy rather than claim a strong
  // backer that is really "we have no data here" (P4, §1d.1).
  let solidityLeg = -Infinity;
  let backedLabel: string | null = null;
  let backedLabelZ = -Infinity;
  for (const [key, label] of backers) {
    const zk = z(key);
    if (zk > solidityLeg) solidityLeg = zk;
    if (dataBacked(key) && zk >= FLOOR_Z && zk > backedLabelZ) {
      backedLabelZ = zk;
      backedLabel = label;
    }
  }
  const moveOk = moveLeg >= FLOOR_Z;
  const solidityOk = solidityLeg >= FLOOR_Z;

  if (moveOk && solidityOk) {
    const backedPhrase = backedLabel
      ? `backed by ${backedLabel}`
      : "cleared on breadth (no single strong backer)";
    return { cleared: true, reason: `Thesis clears: ${moveLabel} ${backedPhrase}.`, penalty: 0 };
  }

  const shortfall = (moveOk ? 0 : FLOOR_Z - moveLeg) + (solidityOk ? 0 : FLOOR_Z - solidityLeg);
  const penalty = round(Math.min(MAX_THESIS_PENALTY, shortfall * 4), 1);
  const missing = [
    moveOk ? null : "no clear value or catalyst",
    solidityOk ? null : "thin fundamentals & growth",
  ]
    .filter(Boolean)
    .join(" + ");
  return { cleared: false, reason: `Soft-gated: ${missing}.`, penalty };
}
