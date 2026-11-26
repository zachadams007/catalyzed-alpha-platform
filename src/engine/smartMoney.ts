import type { CompanyData, CongressTrade } from "@/types";
import { clamp, round, scaleLinear } from "@/lib/math";
import { SMART_MONEY } from "./scoringConfig";

/**
 * "Smart-money" catalyst boost - a small, BOUNDED lift to the Catalyst sub-score
 * when the people closest to a name are buying it on the open market:
 *
 *   • CONGRESS - recently disclosed congressional open-market BUYS
 *     (House Stock Watcher), weighted by the disclosed dollar band.
 *   • INSIDERS - open-market insider purchases (Form 4 "P" code), net positive,
 *     read from ALREADY-AGGREGATED counts/fields on `secActivity`.
 *
 * Design contract (this is scoring logic - it must stay honest and cheap):
 *
 *   1. PURE & deterministic. A function of `CompanyData` only - no clocks, no
 *      I/O, no globals (recency windowing is the enrichment layer's job, exactly
 *      like `catalyst.daysAway`). Same input ⇒ same boost.
 *   2. DEGRADES TO ZERO. No congressional buys and no aggregated insider-buy
 *      fields ⇒ exactly `{ points: 0 }`. Most names get nothing.
 *   3. BOOST ONLY. Net SELLING never subtracts here (risk is handled separately).
 *   4. SEC-RATE-LIMIT-SAFE. It consumes pre-aggregated fields and NEVER fetches
 *      per-ticker EDGAR Form 4 XML (that lazy deep-dive lives in
 *      `src/data/sec/form4.ts`, off the universe path). The insider fields are
 *      therefore usually absent universe-wide, so the congressional lane carries
 *      the signal in practice - the insider lane lights up only where an
 *      aggregated read has been attached.
 *   5. BOUNDED. `points ∈ [0, SMART_MONEY.maxBoost]`, and the catalyst weight
 *      (0.18) keeps the final-score impact ≤ ~1.8 pts - a tie-breaker, never a
 *      driver. It adds NO new category, so the positive weights still sum to 1.0.
 */

export interface SmartMoneyBoost {
  /** Points added to the Catalyst sub-score, 0..SMART_MONEY.maxBoost. */
  points: number;
  /** Congressional-buying component intensity, 0..1. */
  congress: number;
  /** Insider-buying (Form 4 "P", net positive) component intensity, 0..1. */
  insider: number;
  /** Plain-English reason naming the contributing source(s); "" when no boost. */
  reason: string;
}

const ZERO: SmartMoneyBoost = { points: 0, congress: 0, insider: 0, reason: "" };

/**
 * Lower-bound USD of a disclosed congressional amount band, conservatively (the
 * disclosed FLOOR, not the midpoint). "$1,001 - $15,000" → 1001, "$50,000,000+"
 * → 50000000, "Undisclosed"/malformed → 0.
 */
export function disclosedFloorUsd(amountRange: string | undefined): number {
  if (!amountRange) return 0;
  const match = amountRange.match(/\$\s*([\d,]+)/);
  if (!match) return 0;
  const value = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Congressional open-market BUY intensity, 0..1 (the stronger of count vs size). */
function congressIntensity(trades: CongressTrade[] | undefined): number {
  if (!trades || trades.length === 0) return 0;
  const buys = trades.filter((t) => t.transaction === "buy");
  if (buys.length === 0) return 0;

  const floorUsd = buys.reduce((sum, t) => sum + disclosedFloorUsd(t.amountRange), 0);
  const countPath = scaleLinear(buys.length, 0, SMART_MONEY.congress.buysForFull, 0, 1);
  const sizePath = scaleLinear(floorUsd, 0, SMART_MONEY.congress.usdForFull, 0, 1);
  return clamp(Math.max(countPath, sizePath), 0, 1);
}

/** Net-positive insider open-market BUY intensity, 0..1, from aggregated fields. */
function insiderIntensity(c: CompanyData): number {
  const a = c.secActivity;
  if (!a) return 0;
  const buys = a.form4BuyCount90d ?? 0;
  const netValue = a.form4NetBuyValue90d ?? 0;
  // Only NET-POSITIVE open-market buying earns the boost - net selling is neutral
  // here (the risk model, not this boost, handles the downside).
  if (buys <= 0 || netValue <= 0) return 0;

  const countPath = scaleLinear(buys, 0, SMART_MONEY.insider.buysForFull, 0, 1);
  const valuePath = scaleLinear(netValue, 0, SMART_MONEY.insider.netUsdForFull, 0, 1);
  return clamp(Math.max(countPath, valuePath), 0, 1);
}

function congressBuyCount(trades: CongressTrade[] | undefined): number {
  return (trades ?? []).filter((t) => t.transaction === "buy").length;
}

/**
 * Compute the bounded smart-money boost for one company. Either lane can carry
 * the signal alone; when both fire, corroboration adds - clamped to 1.0 so the
 * boost can never exceed `SMART_MONEY.maxBoost`.
 */
export function smartMoneyCatalystBoost(c: CompanyData): SmartMoneyBoost {
  const congress = congressIntensity(c.congressTrades);
  const insider = insiderIntensity(c);
  const combined = clamp(congress + insider, 0, 1);
  if (combined <= 0) return ZERO;

  const points = round(SMART_MONEY.maxBoost * combined, 1);
  if (points <= 0) return ZERO;

  const parts: string[] = [];
  if (congress > 0) {
    const buys = congressBuyCount(c.congressTrades);
    parts.push(`${buys} disclosed congressional buy${buys === 1 ? "" : "s"}`);
  }
  if (insider > 0) {
    const buys = c.secActivity?.form4BuyCount90d ?? 0;
    parts.push(`net insider buying (${buys} open-market buy${buys === 1 ? "" : "s"})`);
  }

  return {
    points,
    congress,
    insider,
    reason: `Smart-money tilt: ${parts.join(" + ")} (+${points} conviction).`,
  };
}
