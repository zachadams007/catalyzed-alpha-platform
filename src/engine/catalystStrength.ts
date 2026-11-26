import type { CatalystType, CompanyData } from "@/types";
import { clamp, round, scaleLinear } from "@/lib/math";
import { disclosedFloorUsd, smartMoneyCatalystBoost } from "./smartMoney";

/**
 * How strongly a favorable / adverse Presidential signal moves the catalyst read,
 * as a fraction of the unified 0..1 strength. Kept SMALL so a real political
 * signal is a clearly-felt corroborator/penalty, never a dominant driver: at the
 * normalization caps (catalyst +10, sell −8) a maxed favorable item adds ≲ +5
 * display pts and a maxed adverse item subtracts ≲ −5. Direction is read from the
 * signal itself (favorable bullish, adverse bearish) - set in executiveTrades.ts.
 */
const EXECUTIVE_FAVORABLE_WEIGHT = 0.5;
const EXECUTIVE_ADVERSE_WEIGHT = 0.6;

/**
 * Unified catalyst strength + material-sell signal - the heart of "Catalyzed
 * Alpha" (catch catalysts EARLY, across ALL types, and let real conviction move
 * the score).
 *
 * Two pure, deterministic functions of `CompanyData` only (no clocks/RNG/I/O -
 * recency is the enrichment layer's job, exactly like `catalyst.daysAway`):
 *
 *   • {@link catalystStrength} - scores EVERY catalyst on ONE common scale
 *     (materiality × magnitude × credibility × how EARLY/fresh) so a strong,
 *     not-yet-priced-in catalyst of ANY type - earnings, news, partnership, M&A,
 *     regulatory/FDA, product, analyst, or a MAJOR insider / congressional buy -
 *     moves the score, while a weak or stale one barely does. It is a BOOST scale:
 *     a name with no catalyst scores ~0 and is therefore never penalized for
 *     lacking one (quality stays a valid path - there is no gate). It also names
 *     the LEAD catalyst driving the pick so the feed tile can surface it.
 *
 *   • {@link materialSellSignal} - heavy disclosed selling by significant
 *     insiders / important people is a NEGATIVE catalyst. A materiality threshold
 *     (transaction size + cluster of sellers) filters noise: a small routine
 *     insider sale is NOT a signal (it can just be liquidity/diversification), so
 *     only material selling lowers a score. Buys are handled elsewhere
 *     (smartMoney.ts); this is the honest downside.
 *
 * Both consume ONLY pre-aggregated fields and NEVER fetch per-ticker EDGAR XML
 * (same SEC fair-access contract as smartMoney.ts). They degrade to a neutral
 * zero when the inputs are absent, so most names get nothing from either.
 *
 * These feed the CHALLENGER normalization as bounded, additive tilts (see
 * normalizeUniverse.ts) - a MODERATE, clearly-felt weight in the blend, never a
 * dominant driver and never a hard gate. The live champion is unaffected.
 */

/** Materiality thresholds for the negative-sell signal (real disclosed data). */
export const MATERIAL_SELL = {
  /** A single disclosed sale below this $ floor, with no cluster, is treated as
   *  routine liquidity - NOT a signal. */
  minMaterialUsd: 50_000,
  /** Distinct sellers at/above this count is itself material (a cluster), even if
   *  each individual disclosed band is modest. */
  clusterSellers: 2,
  /** Disclosed congressional sell $ that saturates the size path. Mirrors the
   *  buy-side `SMART_MONEY.congress.usdForFull` so buys and sells are symmetric. */
  congressUsdForFull: 250_000,
  /** Net open-market insider $ sold (−`form4NetBuyValue90d`) that saturates. */
  insiderUsdForFull: 1_000_000,
} as const;

export interface CatalystStrength {
  /** Unified strength on a 0..100 common scale across ALL catalyst types. */
  strength: number;
  /** Expected impact of the lead catalyst, 0..1 (corroborated by news volume). */
  magnitude: number;
  /** How early/fresh - 1 = imminent or just-fired, decays as it ages/distances. */
  earliness: number;
  /** How trustworthy the read is - live-dated beats modeled, 0..1. */
  credibility: number;
  /** The catalyst type driving the pick (or "Smart money" for a buy cluster). */
  leadType: CatalystType | "Smart money" | null;
  /** Plain-English description of the lead catalyst for the feed tile. */
  leadDescription: string;
}

const NO_CATALYST: CatalystStrength = {
  strength: 0,
  magnitude: 0,
  earliness: 0,
  credibility: 0,
  leadType: null,
  leadDescription: "",
};

/** Earliness of the dated catalyst, 0..1 - peaks imminent/just-fired, decays
 *  the further out (not yet here) or the staler (long gone) it is. "Not yet
 *  priced in is worth more": an upcoming or just-broken catalyst scores highest. */
function catalystEarliness(daysAway: number): number {
  if (daysAway >= 0) {
    // Upcoming: 1 at "today", fading to 0 by ~60 days out.
    return scaleLinear(daysAway, 60, 0) / 100;
  }
  // Just-fired: still fresh within ~10d, gone by ~30 days ago.
  return scaleLinear(-daysAway, 30, 0) / 100;
}

export function catalystStrength(c: CompanyData): CatalystStrength {
  const cat = c.catalyst;
  const news = c.news;

  // --- Primary dated catalyst (any type), on the common materiality scale. ---
  const magnitude01 = cat ? clamp(cat.magnitude, 0, 1) : 0;
  // News volume corroborates materiality: a real catalyst draws coverage.
  const newsVol01 = news ? clamp(scaleLinear(news.count7d, 0, 12) / 100, 0, 1) : 0;
  const corroboratedMag = clamp(0.82 * magnitude01 + 0.18 * newsVol01, 0, 1);

  // Earliness blends the catalyst's own timing with how fresh the news flow is.
  const newsFresh01 = news ? clamp(scaleLinear(news.freshnessHours, 96, 0) / 100, 0, 1) : 0;
  const earliness01 = cat
    ? clamp(0.7 * catalystEarliness(cat.daysAway) + 0.3 * newsFresh01, 0, 1)
    : 0;

  // Credibility: a live-dated catalyst is far more trustworthy than a modeled one.
  const credibility01 = c.catalystLive === true ? 0.85 : 0.5;

  // The legs MODULATE magnitude rather than gate it: a big-but-stale or
  // big-but-modeled catalyst is heavily discounted, never zeroed by a single leg.
  // News only CORROBORATES a real catalyst's magnitude - it never manufactures
  // strength on its own, so a name with no catalyst stays at exactly zero (and is
  // therefore never penalized for lacking one).
  const primary01 = cat
    ? clamp(corroboratedMag * (0.4 + 0.6 * earliness01) * (0.55 + 0.45 * credibility01), 0, 1)
    : 0;

  // --- Smart-money BUY conviction. Counted ONCE - in the catalyst SUB-SCORE
  //     (scoring.ts scoreCatalyst, SMART_MONEY.maxBoost=20), which feeds BOTH the
  //     live-feed blend AND this model's catalyst dimension. We deliberately do NOT
  //     re-add it to `strength` here (that was the PATH-2 double-count - a disclosed
  //     buy used to add ~1.5 in the sub-score AND ~9 in the tilt ≈ ~10.5 total). We
  //     read its intensity ONLY to NAME the lead, so the tile can still surface
  //     "Smart money buying" without weighting it twice. ---
  const smart = smartMoneyCatalystBoost(c);
  const smartIntensity01 = clamp(smart.congress + smart.insider, 0, 1);

  // --- Favorable PRESIDENTIAL signal as its own bullish lane: a disclosed buy or
  //     a favorable public callout (real, dated, sourced - executiveTrades.ts).
  //     Decays with the item's date exactly like the other catalysts, so a stale
  //     callout barely registers. Adverse executive signals are NOT here - they
  //     subtract via materialSellSignal (honest downside). ---
  const fav = c.executiveSignal?.favorable;
  // Recency is pre-computed (fav.daysAway, like RawCatalyst.daysAway) so this stays
  // a pure, clock-free function. Absent ⇒ treat as just-fired (earliness 1).
  const favEarliness01 = fav ? catalystEarliness(fav.daysAway ?? 0) : 0;
  const exec01 = fav
    ? clamp(EXECUTIVE_FAVORABLE_WEIGHT * clamp(fav.magnitude, 0, 1) * (0.5 + 0.5 * favEarliness01), 0, 1)
    : 0;

  if (primary01 <= 0 && exec01 <= 0 && smartIntensity01 <= 0) return NO_CATALYST;

  // Strength (→ catalystTilt) is the dated-catalyst + favorable-Presidential lanes
  // ONLY - smart-money's weight lives in the sub-score (single-count). The stronger
  // leads; the other corroborates.
  const lead = Math.max(primary01, exec01);
  const support = Math.min(primary01, exec01);
  const strength01 = clamp(lead + 0.25 * support, 0, 1);

  // Lead LABEL: whichever signal is most notable names the pick - smart-money can be
  // the headline (its weight is in the sub-score) even though its tilt here is 0.
  const execLeads = exec01 >= primary01 && exec01 >= smartIntensity01 && exec01 > 0;
  const smartLeads = !execLeads && smartIntensity01 >= primary01 && smartIntensity01 > 0;
  let leadType: CatalystStrength["leadType"];
  let leadDescription: string;
  if (execLeads) {
    leadType = "Political";
    leadDescription = fav?.summary ?? "Favorable Presidential signal.";
  } else if (smartLeads) {
    leadType = "Smart money";
    leadDescription = smart.reason || "Disclosed smart-money buying.";
  } else {
    leadType = cat?.type ?? null;
    leadDescription = cat?.description ?? "";
  }
  return {
    strength: round(strength01 * 100, 1),
    magnitude: round(corroboratedMag, 3),
    earliness: round(earliness01, 3),
    credibility: credibility01,
    leadType,
    leadDescription,
  };
}

export interface MaterialSell {
  /** Strength of the negative sell signal, 0..1 (0 = no material selling). */
  intensity: number;
  /** Distinct disclosed sellers that cleared the materiality threshold. */
  sellers: number;
  /** Plain-English watch-out for the tile; "" when there is no material selling. */
  reason: string;
}

const NO_SELL: MaterialSell = { intensity: 0, sellers: 0, reason: "" };

/**
 * Material disclosed SELLING by significant insiders / important people, scored
 * 0..1 with a noise filter. Role seniority is implicit in the sources (Form 4
 * filers are officers/directors; congressional filers are members), so
 * materiality here = transaction SIZE + a CLUSTER of sellers. A lone small sale
 * stays below the floor and scores 0 - it could just be liquidity needs.
 *
 * It ALSO carries the ADVERSE Presidential signal (a tariff threat / probe /
 * public criticism - direction set in executiveTrades.ts): a real, dated policy
 * threat is bearish "attention" and subtracts here, bounded by
 * EXECUTIVE_ADVERSE_WEIGHT so it stays a clearly-felt watch-out, not a driver.
 */
export function materialSellSignal(c: CompanyData): MaterialSell {
  // --- Congressional open-market SELLS - size + cluster. ---
  const congSells = (c.congressTrades ?? []).filter((t) => t.transaction === "sell");
  const congFloorUsd = congSells.reduce((sum, t) => sum + disclosedFloorUsd(t.amountRange), 0);
  const congSellers = new Set(congSells.map((t) => t.representative)).size;
  const congMaterial =
    congFloorUsd >= MATERIAL_SELL.minMaterialUsd || congSellers >= MATERIAL_SELL.clusterSellers;
  const congSizePath = clamp(scaleLinear(congFloorUsd, 0, MATERIAL_SELL.congressUsdForFull) / 100, 0, 1);
  const congClusterPath =
    congSellers >= MATERIAL_SELL.clusterSellers ? clamp(scaleLinear(congSellers, 1, 4) / 100, 0, 1) : 0;
  const congress01 = congMaterial ? clamp(Math.max(congSizePath, congClusterPath), 0, 1) : 0;

  // --- Insider net open-market SELLING (negative aggregated net buy value). ---
  const netBuyValue = c.secActivity?.form4NetBuyValue90d ?? 0;
  const insiderSoldUsd = netBuyValue < 0 ? -netBuyValue : 0;
  const insider01 =
    insiderSoldUsd >= MATERIAL_SELL.minMaterialUsd
      ? clamp(scaleLinear(insiderSoldUsd, 0, MATERIAL_SELL.insiderUsdForFull) / 100, 0, 1)
      : 0;

  // --- Adverse PRESIDENTIAL signal (tariff threat / probe / criticism). Real,
  //     dated, sourced. Decays with the item's date (pre-computed daysAway) so a
  //     stale threat fades; bounded by EXECUTIVE_ADVERSE_WEIGHT. ---
  const adverse = c.executiveSignal?.adverse;
  const adverseEarliness01 = adverse ? catalystEarliness(adverse.daysAway ?? 0) : 0;
  const exec01 = adverse
    ? clamp(EXECUTIVE_ADVERSE_WEIGHT * clamp(adverse.magnitude, 0, 1) * (0.5 + 0.5 * adverseEarliness01), 0, 1)
    : 0;

  const intensity = clamp(Math.max(congress01, insider01, exec01), 0, 1);
  if (intensity <= 0) return NO_SELL;

  const parts: string[] = [];
  if (congress01 > 0) {
    parts.push(`${congSellers || congSells.length} disclosed congressional sell${congSells.length === 1 ? "" : "s"}`);
  }
  if (insider01 > 0) {
    parts.push(`net insider selling (~$${(insiderSoldUsd / 1e6).toFixed(1)}M, 90d)`);
  }
  if (exec01 > 0) {
    parts.push("adverse Presidential signal (policy threat / criticism)");
  }
  // "selling" only when there is real disclosed selling; otherwise the lead-in is
  // honest about being a political pressure read.
  const hasRealSelling = congress01 > 0 || insider01 > 0;
  const leadIn = hasRealSelling ? "Material disclosed selling" : "Negative political pressure";
  return {
    intensity: round(intensity, 3),
    sellers: congSellers,
    reason: `${leadIn}: ${parts.join(" + ")}.`,
  };
}
