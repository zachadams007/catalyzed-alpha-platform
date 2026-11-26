import type { RawRisk, RawSocial, RawVolatility } from "@/types";

/**
 * Neutral placeholders for the input groups that must NEVER be inherited from
 * `buildSyntheticCompany`'s ticker-hash PRNG on a live record.
 *
 * `fundamentals` and `catalyst` already had this treatment (after the SOFI
 * "-19.8% net margin" and ANET "regulatory catalyst landing today" fabrications).
 * `risk`, `volatility` and `social` did not - so every live name on the published
 * board carried a hash of its own ticker string as short interest, dilution risk,
 * cash runway, governance flag, beta, ATR, implied vol and social mention counts.
 *
 * That was not cosmetic. Those fields drive a risk penalty worth up to 30 points,
 * the `hasQualityFloor` gate that every quality archetype depends on, and two
 * scored dimensions - so a meaningful slice of the ranking was noise. Meta was
 * excluded from the misunderstood-quality archetype purely because its ticker
 * hashed to a 0.463 "dilution risk" against a 0.45 threshold.
 *
 * These values are chosen to be genuinely INERT rather than merely small:
 * whatever the scorer does with them, the answer must be "we have no evidence
 * here", never "we have evidence of safety". The enrichment stages overwrite them
 * with real figures where a real source exists.
 */

/**
 * No disclosed risk evidence. Every field sits where its scorer contributes no
 * penalty, because an ABSENT input must never be read as a present danger - the
 * risk penalty is only ever applied from something actually observed.
 *
 * `cashRunwayQuarters` is the one that needs care: the solvency penalty fires on
 * "negative FCF AND a short runway", so an unknown runway must be high enough not
 * to trigger it on its own. Once XBRL free cash flow is folded in, the FCF leg
 * carries that judgement on real data.
 */
export function unknownRisk(): RawRisk {
  return {
    shortInterestPct: 0,
    dilutionRisk: 0,
    cashRunwayQuarters: 12,
    governanceFlag: 0,
  };
}

/**
 * No volatility read yet. Beta 1 is the market itself (no tilt either way) and a
 * zero ATR/IV keeps the `volatility` dimension and the extreme-vol risk component
 * inert until the Alpaca-bars stage computes realized volatility from REAL closes.
 */
export function unknownVolatility(): RawVolatility {
  return { beta: 1, atrPct: 0, impliedVol: 0 };
}

/** No social evidence: zero counts, neutral tone, and copy that says so. */
export function unknownSocial(): RawSocial {
  return {
    redditMentions24h: 0,
    xMentions24h: 0,
    politicalMentions: 0,
    sentiment: 0,
    trendDelta: 0,
    summary: "No social signal collected for this name.",
  };
}
