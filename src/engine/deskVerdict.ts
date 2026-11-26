import type { ResearchIntel } from "@/types";

/**
 * The desk's verdict resolver - why "No verdict" is not an acceptable answer.
 *
 * The Research Desk runs a Bull / Bear / Judge debate. The Judge is asked for a
 * `stance`, but that field goes missing whenever the judge lane fails to parse
 * and the pipeline falls back to the plain structurer, which never emits one. The
 * UI then rendered a literal "No verdict" pill - the desk had gathered a full
 * cited bull case, a full cited bear case and a sentiment read, and still refused
 * to say which way it landed. That is the least useful possible output: the user
 * did the work of reading and got no conclusion.
 *
 * This module resolves a stance in one of two ways and is explicit about which:
 *   • `judge` - the Judge committed to a stance; use it verbatim.
 *   • `derived` - the Judge did not, so we net the evidence the desk DID gather
 *                 (the balance of surviving bull vs bear points and the sentiment
 *                 read) into a directional lean, and mark it as derived so the UI
 *                 can label it honestly and show a lower conviction.
 *
 * "Mixed" remains a real, reachable answer - but it now means "the evidence is
 * genuinely balanced", not "the judge lane errored". Pure and deterministic.
 */

export type DeskStance = "bullish" | "bearish" | "mixed";
export type StanceSource = "judge" | "derived";

export interface ResolvedVerdict {
  stance: DeskStance;
  source: StanceSource;
  /** Display label - a derived lean is worded as a lean, never as a firm call. */
  label: string;
  /**
   * 0–100 conviction. A derived stance is capped, because a netted read is
   * genuinely weaker evidence than an explicit judgement.
   */
  confidence: number | null;
  /** Short plain-English note on how the stance was reached (for a tooltip). */
  basis: string;
}

/** A derived stance can never present as more certain than this. */
export const DERIVED_CONFIDENCE_CAP = 45;
/**
 * How lopsided the surviving points must be before a derived read is directional.
 * One extra point either way is noise; two is a lean.
 */
const POINT_MARGIN = 2;
/** Sentiment magnitude that counts as a directional read on its own. */
const SENTIMENT_MARGIN = 0.15;

function isStance(value: unknown): value is DeskStance {
  return value === "bullish" || value === "bearish" || value === "mixed";
}

/**
 * Net the desk's own gathered evidence into a lean. Uses the two things that are
 * present even when the Judge lane failed: the balance of surviving bull vs bear
 * points, and the grounded sentiment read.
 */
function deriveStance(intel: ResearchIntel): { stance: DeskStance; basis: string } {
  const bull = intel.debate?.bull ? 1 : 0;
  const bear = intel.debate?.bear ? 1 : 0;
  const bullCount = (intel.bullPoints?.length ?? 0) + (intel.citedBull?.length ?? 0) + bull;
  const bearCount = (intel.bearPoints?.length ?? 0) + (intel.citedBear?.length ?? 0) + bear;
  const pointDelta = bullCount - bearCount;
  const sentiment = Number.isFinite(intel.sentiment) ? (intel.sentiment as number) : 0;

  const byPoints = pointDelta >= POINT_MARGIN ? 1 : pointDelta <= -POINT_MARGIN ? -1 : 0;
  const bySentiment = sentiment >= SENTIMENT_MARGIN ? 1 : sentiment <= -SENTIMENT_MARGIN ? -1 : 0;

  // Both signals agreeing is the clearest derived read; a single directional
  // signal still produces a lean rather than a shrug.
  const net = byPoints + bySentiment;
  const evidenceNote =
    `${bullCount} bull vs ${bearCount} bear point${bearCount === 1 ? "" : "s"}` +
    (bySentiment !== 0 ? `, sentiment ${sentiment > 0 ? "+" : ""}${sentiment.toFixed(2)}` : "");

  if (net > 0) {
    return { stance: "bullish", basis: `Netted from the desk's own evidence: ${evidenceNote}.` };
  }
  if (net < 0) {
    return { stance: "bearish", basis: `Netted from the desk's own evidence: ${evidenceNote}.` };
  }
  return {
    stance: "mixed",
    basis: `The evidence genuinely balances: ${evidenceNote}.`,
  };
}

/**
 * Resolve the verdict the desk should display. Never returns "no verdict" - when
 * the Judge did not commit, the desk's own evidence is netted into an honestly-
 * labelled lean at capped conviction.
 */
export function resolveVerdict(intel: ResearchIntel): ResolvedVerdict {
  const judgeStance = intel.debate?.stance;
  const judgeConfidence = intel.debate?.confidence ?? intel.confidence ?? null;

  if (isStance(judgeStance)) {
    return {
      stance: judgeStance,
      source: "judge",
      label:
        judgeStance === "bullish" ? "Bullish" : judgeStance === "bearish" ? "Bearish" : "Mixed",
      confidence: Number.isFinite(judgeConfidence as number) ? (judgeConfidence as number) : null,
      basis: "The judge weighed the bull and bear cases and committed to this stance.",
    };
  }

  const { stance, basis } = deriveStance(intel);
  const raw = Number.isFinite(judgeConfidence as number) ? (judgeConfidence as number) : null;
  return {
    stance,
    source: "derived",
    label:
      stance === "bullish"
        ? "Leaning bullish"
        : stance === "bearish"
          ? "Leaning bearish"
          : "Balanced",
    confidence: raw == null ? DERIVED_CONFIDENCE_CAP : Math.min(raw, DERIVED_CONFIDENCE_CAP),
    basis: `${basis} The judge did not return an explicit stance, so this is a derived lean — treat it as weaker than a full verdict.`,
  };
}
