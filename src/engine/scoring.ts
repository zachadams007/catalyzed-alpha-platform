import type {
  CompanyData,
  ScoreBreakdown,
  ScoreCategory,
  ScoreCategoryKey,
} from "@/types";
import { clamp, round, scaleBand, scaleLinear, weightedAverage } from "@/lib/math";
import { formatPct, formatPctPlain } from "@/lib/format";
import { CATEGORY_CONFIG, CONFIDENCE, LIQUIDITY_BANDS, RISK } from "./scoringConfig";
import { capCohort } from "./capCurve";
import { smartMoneyCatalystBoost } from "./smartMoney";
import { isRealCatalyst } from "@/data/catalysts/catalystState";
import { computeSentimentShift } from "./sentimentShift";
import { materialSellSignal } from "./catalystStrength";
import { hasPositiveEarningsEvidence } from "./profitability";

/**
 * The scoring engine.
 *
 * `scoreCompany()` turns raw CompanyData into an explainable 0..100
 * ScoreBreakdown. It is a PURE function - same input always yields the same
 * output - which keeps it trivially testable and provider-agnostic.
 *
 * Each category scorer returns both a number and a plain-English `explanation`
 * so every signal can answer "why did it score that way?".
 */

interface SubScore {
  score: number;
  explanation: string;
}

interface ConfidenceResult {
  confidence: number;
  explanation: string;
}

type FundamentalKey = keyof CompanyData["fundamentals"];

function fundamentalValue<K extends FundamentalKey>(
  c: CompanyData,
  key: K,
  neutral: CompanyData["fundamentals"][K],
): CompanyData["fundamentals"][K] {
  const availability = c.fundamentalsAvailability;
  if (!availability) return c.fundamentals[key];
  return availability[key] === true ? c.fundamentals[key] : neutral;
}

/**
 * Whether a fundamental field is genuinely available (a real value from the live
 * feed, or a modeled/sample value when there is no availability map). When it is
 * NOT available the explanation must say "not disclosed" and the scorer must fall
 * back to a truly-neutral 50 - never print a fabricated placeholder number or let a
 * missing field drag the dimension down. This is the no-fabrication guarantee: the
 * headline dimension score and its explanation must agree with the Key Fundamentals
 * grid, which honestly shows "N/A" for the same unavailable field.
 */
function fundAvailable(c: CompanyData, key: FundamentalKey): boolean {
  const availability = c.fundamentalsAvailability;
  return availability ? availability[key] === true : true;
}

function liveInputNote(c: CompanyData, keys: FundamentalKey[]): string {
  const availability = c.fundamentalsAvailability;
  if (!availability) return "";
  const live = keys.filter((key) => availability[key] === true).length;
  if (live === keys.length) return "";
  return ` Live feed has ${live}/${keys.length} inputs; unavailable fields are scored neutral.`;
}

// ---------------------------------------------------------------------------
// Category scorers
// ---------------------------------------------------------------------------

function scoreFundamentals(c: CompanyData): SubScore {
  const f = {
    ...c.fundamentals,
    grossMargin: fundamentalValue(c, "grossMargin", 0.35),
    netMargin: fundamentalValue(c, "netMargin", 0),
    debtToEquity: fundamentalValue(c, "debtToEquity", 0.8),
    fcfMargin: fundamentalValue(c, "fcfMargin", 0),
    pegRatio: fundamentalValue(c, "pegRatio", null),
  };

  // NO FABRICATION (the contract documented on `fundAvailable`): an UNAVAILABLE
  // field scores a truly-neutral 50 rather than being run through the scale with a
  // placeholder value, which both invents a number and quietly drags the
  // dimension down. `scoreGrowth` already worked this way; this dimension did not,
  // and it mattered: `fcfMargin` is disclosed for 0% of the live board, so every
  // single name was carrying a fabricated ~45 on a 20%-weighted leg.
  const grossScore = fundAvailable(c, "grossMargin") ? scaleLinear(f.grossMargin, 0.15, 0.75) : 50;
  const netScore = fundAvailable(c, "netMargin") ? scaleLinear(f.netMargin, -0.2, 0.3) : 50;
  const fcfScore = fundAvailable(c, "fcfMargin") ? scaleLinear(f.fcfMargin, -0.25, 0.3) : 50;

  // Balance-sheet health, scored on SERVICEABILITY rather than the raw ratio.
  // Debt carried by real earnings is a financing choice, not distress: a 3x
  // debt/equity on a 25% net margin was scoring a flat 0 here, which is the same
  // judgement the archetype quality floor explicitly rejects. Book equity shrunk
  // by years of buybacks can even push the ratio NEGATIVE, which the raw scale
  // would have rewarded as "lowest leverage on the board" - so that case is
  // handled explicitly and split on whether the business is actually profitable.
  const SERVICEABLE_NET_MARGIN = 0.05;
  const serviced = fundAvailable(c, "netMargin") && f.netMargin >= SERVICEABLE_NET_MARGIN;
  const rawLeverageScore = scaleLinear(f.debtToEquity, 2.5, 0.1);
  const leverageScore = !fundAvailable(c, "debtToEquity")
    ? 50
    : f.debtToEquity < 0
      ? serviced
        ? 50 // negative book equity from buybacks, covered by real profits
        : 5 // negative equity WITHOUT profitability is genuine balance-sheet damage
      : serviced
        ? Math.max(rawLeverageScore, 50) // serviced leverage is not a penalty…
        : rawLeverageScore; // …but unserviced leverage still scores on the ratio

  // Valuation sanity: a sane PEG (~1) is rewarded; absurd or N/A is neutral-low.
  const valuationScore =
    f.pegRatio == null
      ? 45
      : scaleBand(f.pegRatio, 1.0, 2.0);

  const score = weightedAverage([
    { score: grossScore, weight: 0.25 },
    { score: netScore, weight: 0.25 },
    { score: leverageScore, weight: 0.2 },
    { score: fcfScore, weight: 0.2 },
    { score: valuationScore, weight: 0.1 },
  ]);

  // NO FABRICATION: each phrase cites a figure only when it is genuinely available;
  // otherwise it says "not disclosed" so the narrative agrees with the Key
  // Fundamentals grid (which shows N/A) instead of printing a neutral placeholder.
  const grossPhrase = fundAvailable(c, "grossMargin")
    ? `${formatPctPlain(f.grossMargin)} gross margin`
    : "gross margin not disclosed";
  const profitability = !fundAvailable(c, "netMargin")
    ? "profitability not disclosed"
    : f.netMargin >= 0
      ? `${formatPctPlain(f.netMargin)} net margin`
      : hasPositiveEarningsEvidence(f.peRatio)
        ? "profitable on trailing earnings"
        : "currently unprofitable";
  const leverage = !fundAvailable(c, "debtToEquity")
    ? "leverage not disclosed"
    : f.debtToEquity <= 0.5
      ? "a clean balance sheet"
      : `${f.debtToEquity.toFixed(1)}x debt/equity`;
  const valuation = !fundAvailable(c, "pegRatio")
    ? "PEG not disclosed"
    : f.pegRatio == null
      ? "no meaningful PEG (negative earnings)"
      : `a ${f.pegRatio.toFixed(1)} PEG`;

  return {
    score,
    explanation: `${grossPhrase} and ${profitability}, carrying ${leverage} at ${valuation}.${liveInputNote(
      c,
      ["grossMargin", "netMargin", "debtToEquity", "fcfMargin", "pegRatio"],
    )}`,
  };
}

function scoreGrowth(c: CompanyData): SubScore {
  // NO FABRICATION: only score/print a growth figure that is genuinely available.
  // An unavailable field scores a truly-neutral 50 (never a placeholder like 3% that
  // both fabricates a number AND quietly drags the dimension down) and the
  // explanation says "not disclosed" so it agrees with the Key Fundamentals grid.
  const revAvail = fundAvailable(c, "revenueGrowthYoY");
  const epsAvail = fundAvailable(c, "epsGrowthYoY");
  const revValue = c.fundamentals.revenueGrowthYoY;
  const epsValue = c.fundamentals.epsGrowthYoY;

  // A percentage change on a near-zero base is arithmetic, not evidence, so growth credit is
  // scaled toward neutral until the revenue line is big enough for the rate to mean something.
  // Unknown revenue scale sits at half credit rather than full, so a name that discloses nothing
  // cannot outscore one that does.
  const revenueTTM = c.revenueTTM;
  const baseCredibility =
    revenueTTM == null
      ? 0.5
      : clamp(scaleLinear(revenueTTM, 20_000_000, 250_000_000, 0, 1), 0, 1);
  const dampToNeutral = (score: number): number => 50 + (score - 50) * baseCredibility;

  const revScore = revAvail ? dampToNeutral(scaleLinear(revValue, -0.1, 0.6)) : 50;
  const epsScore = epsAvail ? dampToNeutral(scaleLinear(epsValue, -0.3, 0.8)) : 50;

  const score = weightedAverage([
    { score: revScore, weight: 0.55 },
    { score: epsScore, weight: 0.45 },
  ]);

  const revPhrase = revAvail ? `Revenue ${formatPct(revValue)} YoY` : "Revenue growth not disclosed";
  const epsPhrase = epsAvail
    ? epsValue >= 0
      ? `EPS up ${formatPctPlain(epsValue)} YoY`
      : `EPS down ${formatPctPlain(Math.abs(epsValue))} YoY`
    : "EPS growth not disclosed";

  const note = liveInputNote(c, ["revenueGrowthYoY", "epsGrowthYoY"]);
  const explanation =
    !revAvail && !epsAvail
      ? `Revenue and EPS growth not disclosed in the live feed — scored neutral.${note}`
      : `${revPhrase} with ${epsPhrase}${
          revAvail ? (revScore > 70 ? " — a strong top-line expansion." : " — moderate top-line momentum.") : "."
        }${note}`;

  return { score, explanation };
}

function scoreMomentum(c: CompanyData): SubScore {
  const m = c.momentum;
  const trendScore = weightedAverage([
    { score: scaleLinear(m.return1M, -0.15, 0.25), weight: 0.3 },
    { score: scaleLinear(m.return3M, -0.25, 0.5), weight: 0.4 },
    { score: scaleLinear(m.return6M, -0.4, 0.8), weight: 0.3 },
  ]);
  // RSI: reward healthy uptrend (~55-65), penalize overbought/oversold extremes.
  const rsiScore = scaleBand(m.rsi, 60, 35);
  const structureScore = (m.aboveSMA50 ? 50 : 0) + (m.aboveSMA200 ? 50 : 0);
  const rsScore = scaleLinear(m.relativeStrength3M, -0.2, 0.3);
  const healthyEarlyTrend =
    m.rsi >= 55 &&
    m.rsi <= 75 &&
    (m.aboveSMA50 || m.aboveSMA200) &&
    m.return3M > 0 &&
    m.return3M < 0.65;
  const parabolic = m.rsi > 80 || (m.return3M > 0.65 && m.relativeStrength3M > 0.3);
  const momentumQualityScore = parabolic ? 20 : healthyEarlyTrend ? 85 : 50;

  const rawScore = weightedAverage([
    { score: trendScore, weight: 0.4 },
    { score: rsiScore, weight: 0.15 },
    { score: structureScore, weight: 0.2 },
    { score: rsScore, weight: 0.15 },
    { score: momentumQualityScore, weight: 0.1 },
  ]);
  const score = parabolic ? Math.min(rawScore, 62) : rawScore;

  const structure =
    m.aboveSMA50 && m.aboveSMA200
      ? "trading above both its 50- and 200-day averages"
      : m.aboveSMA50
        ? "back above its 50-day average"
        : "below key moving averages";

  return {
    score,
    explanation: `${formatPct(m.return3M)} over 3M, ${structure}, RSI ${Math.round(m.rsi)}${
      parabolic ? " — parabolic/overbought move is down-weighted." : "."
    }`,
  };
}

function scoreCatalyst(c: CompanyData): SubScore {
  const cat = c.catalyst;
  // No REAL dated catalyst (no structured event; catalysts are never inferred from
  // news) -> this dimension contributes nothing. V4 moved smart-money buying into
  // the separate additive-only `conviction` category, so it is not double-counted.
  if (!isRealCatalyst(cat, c.catalystLive)) {
    return {
      score: 0,
      explanation: "No dated catalyst surfaced in our scan (we only count structured events, never news).",
    };
  }
  const magnitudeScore = scaleLinear(cat.magnitude, 0.2, 1.0);

  const freshScore =
    cat.daysAway >= -30 && cat.daysAway <= 14
      ? 100
      : cat.daysAway < -30
        ? scaleLinear(cat.daysAway, -90, -30)
        : scaleLinear(cat.daysAway, 180, 14);
  const specificityScore = catalystSpecificityScore(cat.description);

  const base = weightedAverage([
    { score: magnitudeScore, weight: 0.55 },
    { score: freshScore, weight: 0.3 },
    { score: specificityScore, weight: 0.15 },
  ]);

  const staleDowntrend =
    cat.daysAway < -30 &&
    !c.momentum.aboveSMA50 &&
    c.momentum.return1M < 0 &&
    c.momentum.return3M < 0;
  const score = staleDowntrend ? Math.min(base, 5) : base;

  const timing =
    cat.daysAway < 0
      ? `${Math.abs(cat.daysAway)}d ago`
      : cat.daysAway === 0
        ? "today"
        : `in ${cat.daysAway}d`;

  const explanation = `${cat.type} catalyst ${timing}: ${cat.description}${
    staleDowntrend ? " Stale catalyst plus continued downtrend is scored near zero." : ""
  }`;

  return { score, explanation };
}

function catalystSpecificityScore(description: string): number {
  const text = description.trim();
  if (!text) return 40;
  const words = text.split(/\s+/).filter(Boolean).length;
  const concrete =
    /\b(contract|partnership|approval|launch|earnings|index|award|filing|phase|customer|guidance|backlog|order)\b/i.test(
      text,
    ) || /\d/.test(text);
  return clamp(40 + Math.min(words, 10) * 4 + (concrete ? 20 : 0));
}

function thirteenDCount(c: CompanyData): number {
  const explicit = c.secActivity?.thirteenDCount90d;
  if (explicit != null && Number.isFinite(explicit)) return Math.max(0, explicit);
  return (
    c.secActivity?.filings?.filter((filing) => /13D/i.test(filing.form)).length ?? 0
  );
}

function scoreConviction(c: CompanyData): SubScore {
  const smart = smartMoneyCatalystBoost(c);

  const activistCount = thirteenDCount(c);
  const activist01 = clamp(scaleLinear(activistCount, 0, 2) / 100, 0, 1);

  const strategic = c.strategicCapital;
  const strategicAmount01 =
    strategic?.amountUsd != null && strategic.amountUsd > 0
      ? clamp(scaleLinear(strategic.amountUsd, 5_000_000, 500_000_000) / 100, 0, 1)
      : 0;
  const strategicCapPct01 =
    strategic?.amountUsd != null && strategic.amountUsd > 0 && c.marketCap > 0
      ? clamp(scaleLinear(strategic.amountUsd / c.marketCap, 0.002, 0.05) / 100, 0, 1)
      : 0;
  const strategicStrike01 =
    strategic?.disclosedStrike != null && strategic.disclosedStrike > 0 && c.price > 0
      ? c.price <= strategic.disclosedStrike * 1.25
        ? 0.35
        : 0.15
      : 0;
  const strategic01 = clamp(
    strategicAmount01 * 0.45 + strategicCapPct01 * 0.4 + strategicStrike01,
    0,
    1,
  );

  const convictionPoints = Math.min(
    50,
    smart.points + activist01 * 15 + strategic01 * 20,
  );
  if (convictionPoints <= 0) {
    return { score: 50, explanation: "No disclosed conviction buy on file — scored neutral." };
  }

  const parts: string[] = [];
  if (smart.points > 0) {
    const cleanReason = smart.reason
      .replace("Smart-money tilt: ", "")
      .replace(/\s*\(\+\d+(?:\.\d+)? conviction\)\./, "");
    parts.push(cleanReason);
  }
  if (activistCount > 0) {
    parts.push(`${activistCount} recent activist / 13D stake disclosure${activistCount === 1 ? "" : "s"}`);
  }
  if (strategic01 > 0) {
    const investor = strategic?.investor ? `${strategic.investor} strategic capital` : "strategic capital";
    parts.push(investor);
  }

  return {
    score: 50 + convictionPoints,
    explanation: `Disclosed conviction support: ${parts.join(" + ")}.`,
  };
}

function scoreNews(c: CompanyData): SubScore {
  const n = c.news;
  const volumeScore = scaleLinear(n.count7d, 0, 25);
  const freshnessScore = scaleLinear(n.freshnessHours, 96, 0); // fresher = higher
  // Map sentiment -1..1 onto 0..100, with neutral landing mid.
  const sentimentScore = scaleLinear(n.sentiment, -1, 1);

  const score = weightedAverage([
    { score: freshnessScore, weight: 0.4 },
    { score: volumeScore, weight: 0.3 },
    { score: sentimentScore, weight: 0.3 },
  ]);

  const tone = n.sentiment > 0.2 ? "positive" : n.sentiment < -0.2 ? "negative" : "mixed";
  return {
    score,
    explanation: `${n.count7d} stories in 7d, freshest ${Math.round(
      n.freshnessHours,
    )}h ago, ${tone} tone.`,
  };
}

function scoreSocial(c: CompanyData): SubScore {
  const s = c.social;
  const totalMentions = s.redditMentions24h + s.xMentions24h;
  const volumeScore = scaleLinear(Math.log10(totalMentions + 1), 0, 4.5);
  const trendScore = scaleLinear(s.trendDelta, -0.5, 2.0);
  const politicalScore = scaleLinear(s.politicalMentions, 0, 6);
  const sentimentScore = scaleLinear(s.sentiment, -1, 1);

  const score = weightedAverage([
    { score: volumeScore, weight: 0.4 },
    { score: trendScore, weight: 0.25 },
    { score: politicalScore, weight: 0.2 },
    { score: sentimentScore, weight: 0.15 },
  ]);

  const political =
    s.politicalMentions > 0 ? ` ${s.politicalMentions} political/insider mention(s).` : "";
  const posts = c.socialPosts ?? [];
  const postNote =
    posts.length > 0
      ? ` ${posts.filter((p) => p.isPolitical).length} political post(s) in sample X scan.`
      : "";
  return {
    score,
    explanation: `${totalMentions.toLocaleString("en-US")} social mentions (${formatPct(
      s.trendDelta,
    )} DoD).${political}${postNote}`,
  };
}

function scoreVolatility(c: CompanyData): SubScore {
  const v = c.volatility;
  // We want OPPORTUNITY-grade volatility: enough to move, not so much it's a
  // coin flip. ATR sweet spot ~6%, IV sweet spot ~0.7 annualized.
  //
  // NO FABRICATION: only legs with a genuinely measured input are blended. ATR and
  // beta are computed from real Alpaca closes; IMPLIED volatility needs an options
  // feed this app does not carry, and it used to arrive as a ticker-hash value from
  // the synthetic seed. With that removed it is simply absent, and an absent leg is
  // dropped from the average rather than scored as a zero - otherwise every live
  // name would take a 35%-weighted zero for data nobody has.
  const parts: Array<{ score: number; weight: number }> = [];
  if (v.atrPct > 0) parts.push({ score: scaleBand(v.atrPct, 0.06, 0.07), weight: 0.45 });
  if (v.impliedVol > 0) parts.push({ score: scaleBand(v.impliedVol, 0.7, 0.7), weight: 0.35 });
  if (Number.isFinite(v.beta) && v.beta !== 0) {
    parts.push({ score: scaleLinear(v.beta, 0.6, 2.2), weight: 0.2 });
  }
  if (parts.length === 0) {
    return { score: 50, explanation: "No volatility read available — scored neutral." };
  }
  const score = weightedAverage(parts);

  return {
    score,
    explanation: `${v.atrPct > 0 ? `${formatPctPlain(v.atrPct)} ATR` : "ATR not available"}, ${
      Number.isFinite(v.beta) && v.beta !== 0 ? `${v.beta.toFixed(2)} beta` : "beta not measured"
    } — ${score > 65 ? "tradable volatility with room to run." : "volatility is muted or excessive."}`,
  };
}

function scoreLiquidity(c: CompanyData): SubScore {
  const l = c.liquidity;
  // Log-banded so $1M and $1B both land sensibly.
  const lowScore = scaleLinear(
    Math.log10(l.avgDollarVolume),
    Math.log10(LIQUIDITY_BANDS.thin),
    Math.log10(LIQUIDITY_BANDS.deep),
  );
  return {
    score: lowScore,
    explanation: `${(l.avgDollarVolume / 1e6).toFixed(1)}M/day in dollar volume — ${
      l.avgDollarVolume >= LIQUIDITY_BANDS.healthy
        ? "comfortably tradable."
        : "thin; mind slippage on size."
    }`,
  };
}

/**
 * Cap-aware FUNDAMENTAL cheapness (0..100), or `null` when no valuation inputs exist
 * (cold-start → the caller keeps its pure off-high read, unchanged).
 *
 *   • LARGER caps (mid/large): a real value read - PEG (cheap-for-growth) + a low,
 *     positive trailing P/E. Large caps have trustworthy earnings, so statistical
 *     cheapness is meaningful. (Sector-relativity is added downstream by the
 *     cross-sectional sector-demean; this is the coarse per-company read.)
 *   • SMALLER caps (small/unknown): a growth-ADJUSTED read - a low EV/Sales RELATIVE
 *     to revenue growth (a cheap entry into a growth story), never punished for weak
 *     or negative current earnings (a small-cap's raw P/E is usually meaningless).
 *
 * Uses only fields with real live coverage (peRatio ~68%, pegRatio ~54%, evToSales
 * ~28% on the 2026-07-03 board); the dead `peVsOwn5yrPctile` (0% populated) is left
 * to `scoreValuation`'s existing own-history leg.
 */
function fundamentalCheapness(c: CompanyData): number | null {
  const cohort = capCohort(c.marketCap);
  // NO FABRICATION: an unavailable multiple must not drive the read (else a placeholder
  // number would leak in) - gate each field by fundamentalsAvailability, exactly like
  // the rest of the scorer. evToSales is a separate optional inflection field (absent ⇒
  // simply unused), not a fundamentals-availability item.
  const pe = fundAvailable(c, "peRatio") ? c.fundamentals.peRatio : null;
  const peg = fundAvailable(c, "pegRatio") ? c.fundamentals.pegRatio : null;
  // EV/SALES IS ONLY A VALUE SIGNAL IF SALES CONVERT TO PROFIT. A gross-flow
  // reporter books transaction volume as revenue, so its EV/Sales is arithmetically
  // tiny and means nothing: Galaxy Digital showed 0.18x on $60.2B of "revenue"
  // against an $8.8B market cap and a 0.4% net margin - the multiple read as the
  // cheapest on the board while describing a business whose sales are not its
  // economics. Require a real margin before sales are allowed to imply value.
  // The gate is ASYMMETRIC on purpose: without a real margin, a LOW EV/Sales may
  // not claim "cheap", but a HIGH one may still say "expensive". Switching the
  // signal off entirely would make the score non-monotonic in margin - a company
  // could look better by being less profitable, purely because its sales multiple
  // stopped counting.
  const marginKnown = fundAvailable(c, "netMargin");
  const netMarginForValue = marginKnown ? c.fundamentals.netMargin : null;
  const salesAreEconomic = netMarginForValue == null || netMarginForValue >= 0.02;
  const evSales = c.inflection?.evToSales;
  const capSalesValue = (score: number): number => (salesAreEconomic ? score : Math.min(score, 50));
  const revGrowth = fundAvailable(c, "revenueGrowthYoY") ? c.fundamentals.revenueGrowthYoY : NaN;
  const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0;

  const parts: Array<{ score: number; weight: number }> = [];
  if (cohort === "large" || cohort === "mid") {
    // PEG < 1 cheap-for-growth (100), ~2 fair (50), > 3 rich (0).
    if (finite(peg)) parts.push({ score: scaleLinear(peg, 3, 0.5), weight: 0.55 });
    // Low positive P/E = value; a rich multiple isn't cheap.
    if (finite(pe)) parts.push({ score: scaleLinear(pe, 45, 8), weight: 0.35 });
    // EV/Sales supports the read where present.
    if (finite(evSales)) parts.push({ score: capSalesValue(scaleLinear(evSales, 12, 1)), weight: 0.2 });
  } else {
    // SMALL / UNKNOWN - growth-adjusted EV/Sales: a higher multiple is justified by
    // faster growth, so we compare EV/Sales against a growth-scaled "fair" band
    // (~1x at 0% growth, ~5x still reasonable at +40% growth). NO raw-P/E and NO
    // margin leg - that's the "don't mark every small-cap expensive" adjustment.
    if (finite(evSales)) {
      const g = Number.isFinite(revGrowth) ? Math.max(revGrowth, 0) : 0;
      const fairEvSales = 1 + g * 10;
      const ratio = evSales / Math.max(fairEvSales, 0.5); // < 1 cheap-for-growth, > 1 rich
      parts.push({ score: capSalesValue(scaleLinear(ratio, 2.5, 0.4)), weight: 0.6 });
    }
    // A cheap PEG still counts for a small-cap that DOES have real earnings.
    if (finite(peg)) parts.push({ score: scaleLinear(peg, 3, 0.5), weight: 0.4 });
  }

  return parts.length > 0 ? weightedAverage(parts) : null;
}

function scoreValuation(c: CompanyData): SubScore {
  const closes = c.priceHistory ?? [];
  const price = c.price > 0 ? c.price : (closes[closes.length - 1] ?? 0);
  const ownPctile = c.valuation?.peVsOwn5yrPctile;
  const cohort = capCohort(c.marketCap);
  const fundCheap = fundamentalCheapness(c);
  // Cap-aware weight on the fundamental-cheapness leg: a larger cap has trustworthy
  // earnings so real value matters more; a smaller cap leans on the (growth-adjusted)
  // read lightly and stays off-high-led (the reversal-first identity is preserved).
  // When absent, this is 0 and the leg folds back onto the off-high read, so a
  // data-less name scores EXACTLY as before (cold-start safe).
  const fundWeight =
    fundCheap == null ? 0 : cohort === "large" ? 0.32 : cohort === "mid" ? 0.24 : 0.18;
  const fundValueNote =
    fundCheap == null
      ? ""
      : cohort === "small" || cohort === "unknown"
        ? ` Value: cheap-for-growth read ${Math.round(fundCheap)}/100 (small-cap, growth-adjusted).`
        : ` Value: ${Math.round(fundCheap)}/100 on P/E & PEG${(c.inflection?.evToSales ?? 0) > 0 ? " & EV/Sales" : ""}.`;
  /** Blend `parts` with the cap-aware fundamental-cheapness leg folded in (weights
   *  scaled so the total stays 1.0); no-op fold when `fundCheap` is null. */
  const withFundamental = (parts: Array<{ score: number; weight: number }>): number =>
    fundCheap != null && fundWeight > 0
      ? weightedAverage([
          ...parts.map((p) => ({ score: p.score, weight: p.weight * (1 - fundWeight) })),
          { score: fundCheap, weight: fundWeight },
        ])
      : weightedAverage(parts);
  const ownHistoryScore =
    ownPctile != null && Number.isFinite(ownPctile)
      ? scaleLinear(ownPctile, 0.66, 0.05)
      : null;

  // Judging "discounted vs extended" needs a real, DEEP base. With a shallow or
  // MODELED series (a recent IPO, or a name the daily Alpaca-bars fetch couldn't
  // reach and that fell back to the ~30-pt modeled window) we CANNOT honestly say a
  // name is discounted or extended - so we stay NEUTRAL rather than fabricate a
  // "chasing highs" read off a thin window. This was the BMNR bug: near its IPO
  // lows, yet flagged "chasing highs" because its 30-pt modeled window put it ~12%
  // off that window's high. ~120 closes ≈ 6 months - enough to read a real base.
  const MIN_HISTORY_FOR_ENTRY = 120;
  if (closes.length < MIN_HISTORY_FOR_ENTRY || price <= 0) {
    if (ownHistoryScore != null) {
      return {
        score: weightedAverage([
          { score: ownHistoryScore, weight: 0.65 },
          { score: 50, weight: 0.35 },
        ]),
        explanation: `Limited price history (${closes.length}d), but own-history multiple percentile is ${Math.round(
          clamp(ownPctile ?? 0, 0, 1) * 100,
        )}% — scored from own-history value with neutral entry timing.`,
      };
    }
    // No price base to read an entry off, but a fundamental value read still stands
    // (a cheap recent-IPO isn't "neutral" just because it lacks 120 closes).
    if (fundCheap != null) {
      return {
        score: weightedAverage([
          { score: fundCheap, weight: 0.6 },
          { score: 50, weight: 0.4 },
        ]),
        explanation: `Limited price history (${closes.length}d) — entry timing not assessed, scored from fundamental value.${fundValueNote}`,
      };
    }
    return {
      score: 50,
      explanation: `Limited price history (${closes.length}d) — entry timing not assessed (neutral until a real base is available).`,
    };
  }

  const windowLabel = closes.length >= 180 ? "52-week" : "recent";
  const high = Math.max(price, ...closes);
  const low = Math.min(price, ...closes);
  const range = high - low;
  const offHigh = high > 0 ? (high - price) / high : 0; // 0 = sitting at the high
  const rangePos = range > 0 ? (price - low) / range : 0.5; // 1 = at the top of the range

  // Discount from the high - DEPRESSED-BASE REWARD (v2). We catch names EARLY, off
  // a washed-out base, so a deep discount is credited (scores 0 at the high, ramps
  // to 100 by ~55% off) instead of being clamped down as a "value trap". The
  // catastrophe guard that used to live here (the old second clamp punishing >55%-
  // off names) moved to where it belongs - the anti-lottery `pumpRisk` + the thesis
  // gate reject a falling knife by its LACK of inflection/substance, not by capping
  // the discount. P/E is never a gate; `inflection` carries "catch it before obvious".
  const discountScore = scaleLinear(offHigh, 0, 0.55);
  // Position in the range - the lower half is a better entry than the top.
  const rangeScore = scaleLinear(rangePos, 1.0, 0.25);
  // Overbought RSI = expensive right now; neutral/mildly-washed RSI = calmer entry.
  const rsiScore = scaleBand(c.momentum.rsi, 45, 40);

  const score = withFundamental(
    ownHistoryScore != null
      ? [
          { score: discountScore, weight: 0.4 },
          { score: rangeScore, weight: 0.2 },
          { score: rsiScore, weight: 0.15 },
          { score: ownHistoryScore, weight: 0.25 },
        ]
      : [
          { score: discountScore, weight: 0.55 },
          { score: rangeScore, weight: 0.25 },
          { score: rsiScore, weight: 0.2 },
        ],
  );

  const pctOffHigh = Math.round(offHigh * 100);
  const where =
    offHigh <= 0.04 ? `at its ${windowLabel} high` : `${pctOffHigh}% below its ${windowLabel} high`;
  const nearHigh = offHigh < 0.1;
  const read =
    score >= 65
      ? nearHigh && fundCheap != null && fundCheap >= 60
        ? "attractively valued even near its highs."
        : "discounted with room to run."
      : score >= 45
        ? "a fair, mid-range entry."
        : "extended near highs — chasing the top.";
  return {
    score,
    explanation: `Trading ${where}, RSI ${Math.round(c.momentum.rsi)}${
      ownPctile != null ? `, own-history multiple percentile ${Math.round(clamp(ownPctile, 0, 1) * 100)}%` : ""
    } — ${read}${fundValueNote}`,
  };
}

// ---------------------------------------------------------------------------
// v2 dimensions - the leading pre-move signals (cold-start safe: a missing input
// group scores a neutral 50, which contributes ZERO cross-sectional spread, so the
// dimension is inert until the daily scan's v2 financials/series fold populates it.
// None ever fabricates a trend from absent data.)
// ---------------------------------------------------------------------------

/**
 * `inflection` - the single most reliable pre-move trigger in the research: revenue
 * / margin RE-acceleration (a positive 2nd derivative) off a depressed base, caught
 * BEFORE the P/E looks cheap. Averaged over only the components actually present, so
 * a partial fold never penalizes; no inputs at all → neutral 50.
 */
function scoreInflection(c: CompanyData): SubScore {
  const inf = c.inflection;
  if (!inf) {
    return { score: 50, explanation: "No fundamental-inflection inputs yet — scored neutral." };
  }
  const parts: Array<{ score: number; weight: number }> = [];
  const notes: string[] = [];

  // PLAUSIBILITY BOUNDS on the raw inputs (owner request 2026-07-26).
  //
  // These ratios are computed against a revenue line that can be near zero, which
  // makes them explode into numbers that are arithmetic noise rather than
  // fundamentals. Quantum Computing Inc filed a quarter with `revAccelQoQ` of
  // 15.26 (+1,526%), `revYoYAccel` of 53.5 (+5,350%) and an operating margin
  // improving from −212.46 (−21,246% of revenue) to −5.57 - and the margin leg
  // scored a perfect 100 for an "improvement" of twenty thousand percentage points
  // while the company remained deeply unprofitable.
  //
  // Damping alone could not fix this: half credit on a nonsense number is still
  // nonsense. A value outside these bounds is DISCARDED - the component simply
  // does not participate - because the honest reading of an exploded ratio is "we
  // learn nothing here", not "this is the best inflection on the board".
  const plausible = (v: number | null | undefined, limit: number): v is number =>
    v != null && Number.isFinite(v) && Math.abs(v) <= limit;
  /** A revenue 2nd-derivative beyond ±200% is a base effect, not re-acceleration. */
  const ACCEL_LIMIT = 2;
  /** An operating margin outside ±300% of revenue describes a pre-revenue shell. */
  const MARGIN_LIMIT = 3;

  // A revenue 2nd-derivative on a near-zero base is arithmetic noise - QUBT's "+1526% QoQ" and
  // EMPD's "+92%" are base effects on a micro revenue line, not a real re-acceleration. Scale
  // the REVENUE-acceleration components toward neutral until the base is real, and only apply
  // the "re-accelerating" LABEL for a meaningful move on a credible base - so the signal is
  // selective, not the default.
  const revenueTTM = c.revenueTTM;
  const baseCredibility =
    revenueTTM == null
      ? 0.5
      : clamp(scaleLinear(revenueTTM, 20_000_000, 250_000_000, 0, 1), 0, 1);
  const dampToNeutral = (score: number): number => 50 + (score - 50) * baseCredibility;

  if (plausible(inf.revAccelQoQ, ACCEL_LIMIT)) {
    parts.push({ score: dampToNeutral(scaleLinear(inf.revAccelQoQ, -0.02, 0.1)), weight: 0.3 });
    if (inf.revAccelQoQ > 0.03 && baseCredibility >= 0.5)
      notes.push(`revenue re-accelerating (QoQ 2nd-deriv +${formatPctPlain(inf.revAccelQoQ)})`);
  }
  if (plausible(inf.revYoYAccel, ACCEL_LIMIT)) {
    // Graduated (was a binary 100/0 that scored ANY positive YoY-accel as a perfect
    // re-acceleration - part of why the label hit the whole board), then base-damped.
    parts.push({ score: dampToNeutral(scaleLinear(inf.revYoYAccel, -0.03, 0.05)), weight: 0.15 });
  }
  if (plausible(inf.grossMarginDeltaYoY, 1)) {
    parts.push({ score: dampToNeutral(scaleLinear(inf.grossMarginDeltaYoY, 0, 0.06)), weight: 0.25 });
    if (inf.grossMarginDeltaYoY > 0.01) notes.push(`gross margin +${formatPctPlain(inf.grossMarginDeltaYoY)} YoY`);
  }
  if (plausible(inf.opMarginNow, MARGIN_LIMIT) && plausible(inf.opMarginPrevYearQ, MARGIN_LIMIT)) {
    // A SIGN CHANGE IS NOT AUTOMATICALLY AN INFLECTION. This used to award a flat
    // 100 for any crossing from negative to non-negative, so Galaxy Digital's
    // −26.1% → +1.9% swing - a barely-positive quarter on a violently swinging
    // base - scored a perfect margin turn and, with the opex leg below, produced a
    // 100/100 inflection that put it top of the board. Credit now scales with how
    // MEANINGFUL the new margin is, so a turn to +1.9% earns a fraction of what a
    // turn to +15% earns, and both still beat no turn at all.
    const crossed = inf.opMarginPrevYearQ < 0 && inf.opMarginNow >= 0;
    const durability = clamp(scaleLinear(inf.opMarginNow, 0, 0.12, 0, 1), 0, 1);
    const turnScore = crossed
      ? 50 + 50 * durability
      : scaleLinear(inf.opMarginNow - inf.opMarginPrevYearQ, 0, 0.1);
    parts.push({ score: dampToNeutral(turnScore), weight: 0.2 });
    if (crossed && durability >= 0.35) notes.push("operating margin turned positive");
  }
  if (inf.opexPctRevDeltaYoY != null) {
    // Graduated, not binary - and bounded. This was `< 0 ? 100 : 0`, so a −0.1%
    // drift and a −125% swing scored identically at 100. An opex/revenue move of
    // more than ~30 percentage points in a year is a DENOMINATOR artifact (revenue
    // spiking or collapsing), not operating leverage, so it is treated as
    // uninformative rather than as the strongest possible signal.
    const swing = inf.opexPctRevDeltaYoY;
    const implausible = Math.abs(swing) > 0.3;
    parts.push({
      score: implausible ? 50 : dampToNeutral(scaleLinear(swing, 0.02, -0.06)),
      weight: 0.1,
    });
  }

  if (parts.length === 0) {
    return { score: 50, explanation: "No fundamental-inflection inputs yet — scored neutral." };
  }
  const score = weightedAverage(parts);
  // Direction-aware lead so the copy matches the score: a low inflection read
  // should never narrate "roughly steady". Positive notes (re-accel, margin up)
  // win; otherwise describe the read honestly from the computed sub-score.
  const lead =
    notes.length > 0
      ? notes.slice(0, 2).join(", ")
      : score >= 55
        ? "fundamentals improving"
        : score <= 45
          ? "fundamentals softening"
          : "fundamentals roughly steady";
  return { score, explanation: `Inflection read: ${lead}.` };
}

/**
 * `pipeline` - the earliest HARD signal: an order book / backlog / named contract
 * win that LEADS the revenue line (POWL, AEHR, SYM, SOUN). The strongest of the
 * three available ratios carries it; none present → neutral 50 (never penalized).
 */
function scorePipeline(c: CompanyData): SubScore {
  const p = c.pipeline;
  if (!p) return { score: 50, explanation: "No order-book / backlog signal on file — scored neutral." };

  // BASE MATERIALITY. An order book grows by a large PERCENTAGE very easily when
  // the absolute book is tiny: Rigetti's "+133% backlog" sat on a company with no
  // disclosed revenue line at all, and scored a perfect 100 on this dimension -
  // the same score Microsoft earns on $633B of contracted obligations. Percentage
  // growth is only evidence when there is something material growing, so credit is
  // scaled toward neutral until a real revenue base exists. Unknown base ⇒ half
  // credit, never full.
  const revenueTTM = c.revenueTTM;
  const baseCredibility =
    revenueTTM == null
      ? 0.5
      : clamp(scaleLinear(revenueTTM, 20_000_000, 250_000_000, 0, 1), 0, 1);
  const dampToNeutral = (score: number): number => 50 + (score - 50) * baseCredibility;

  const hardSignals: Array<{ score: number; label: string }> = [];
  if (p.bookToBill != null) {
    hardSignals.push({ score: scaleLinear(p.bookToBill, 1.0, 1.6), label: `book-to-bill ${p.bookToBill.toFixed(2)}` });
  }
  if (p.backlogToRevTTM != null) {
    hardSignals.push({ score: scaleLinear(p.backlogToRevTTM, 0.8, 2.0), label: `backlog ${p.backlogToRevTTM.toFixed(1)}× revenue` });
  }
  if (p.namedContractPctRev != null) {
    hardSignals.push({ score: scaleLinear(p.namedContractPctRev, 0.05, 0.3), label: `a contract worth ${formatPctPlain(p.namedContractPctRev)} of revenue` });
  }
  const supportSignals: Array<{ score: number; label: string }> = [];
  const visibilityYoY = Math.max(
    p.backlogYoY ?? Number.NEGATIVE_INFINITY,
    p.deferredRevYoY ?? Number.NEGATIVE_INFINITY,
  );
  // The visibility read is a RATIO against recognized revenue growth, so it is only
  // meaningful when that growth is genuinely disclosed. When it is not, the field
  // defaults to 0, the denominator floors at 0.05, and any positive deferred-revenue
  // growth explodes into a perfect score - SoFi scored a 100 here purely because its
  // revenue growth was missing. An undisclosed denominator means no ratio, not a win.
  if (Number.isFinite(visibilityYoY) && fundAvailable(c, "revenueGrowthYoY")) {
    const revenueGrowth = c.fundamentals.revenueGrowthYoY;
    const denominator = Math.max(revenueGrowth, 0.05);
    const ratio = visibilityYoY / denominator;
    supportSignals.push({
      score: scaleLinear(ratio, 0.5, 1.5),
      label: `forward visibility ${ratio.toFixed(1)}× recognized revenue growth`,
    });
  }
  if (p.nrr != null) {
    supportSignals.push({ score: scaleLinear(p.nrr, 0.95, 1.25), label: `NRR ${Math.round(p.nrr * 100)}%` });
  }
  if (p.shareDeltaBps != null) {
    supportSignals.push({
      score: scaleLinear(p.shareDeltaBps, -200, 500),
      label: `share delta ${Math.round(p.shareDeltaBps)} bps`,
    });
  }
  if (hardSignals.length === 0 && supportSignals.length === 0) {
    return { score: 50, explanation: "No order-book / backlog signal on file — scored neutral." };
  }
  const topHard = hardSignals.length > 0 ? hardSignals.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  const support =
    supportSignals.length > 0
      ? weightedAverage(supportSignals.map((signal) => ({ score: signal.score, weight: 1 })))
      : null;
  const blended =
    topHard && support != null
      ? weightedAverage([
          { score: topHard.score, weight: 0.55 },
          { score: support, weight: 0.45 },
        ])
      : topHard?.score ?? support ?? 50;
  // DISCLOSING A WEAK ORDER BOOK MUST NOT BE WORSE THAN DISCLOSING NOTHING.
  // A company that reports no pipeline at all scores the cold-start neutral 50.
  // Amazon, which does disclose contract liabilities but grew them slower than
  // revenue, was scoring 0 - so filing the data actively cost it 50 points against
  // a silent peer. The dimension is a POSITIVE-evidence signal: a strong order book
  // lifts, an unremarkable one is simply uninformative. Floor at neutral so the
  // only thing this dimension can do is reward genuine forward visibility.
  const score = Math.max(dampToNeutral(blended), 50);
  const labels = [topHard?.label, supportSignals.reduce<{ score: number; label: string } | null>(
    (best, signal) => (best == null || signal.score > best.score ? signal : best),
    null,
  )?.label].filter(Boolean);
  return { score, explanation: `Forward pipeline: ${labels.join("; ")}.` };
}

/**
 * `sentimentShift` - the early "the conversation is turning" signal, scored as a
 * z-DELTA vs the stock's own 20-day baseline with anti-hype gates. Delegates to the
 * pure {@link computeSentimentShift}; cold-start (no trailing series) → neutral 50.
 */
function scoreSentimentShift(c: CompanyData): SubScore {
  const r = computeSentimentShift(c);
  const explanation = r.coldStart
    ? "No trailing sentiment baseline yet — scored neutral."
    : r.lead
      ? `${r.lead}.`
      : r.unconfirmedHype
        ? "Attention rising but unconfirmed by a hard event."
        : "Sentiment steady vs its own 20-day baseline.";
  return { score: r.score, explanation };
}

const SCORERS: Record<ScoreCategoryKey, (c: CompanyData) => SubScore> = {
  fundamentals: scoreFundamentals,
  growth: scoreGrowth,
  momentum: scoreMomentum,
  conviction: scoreConviction,
  catalyst: scoreCatalyst,
  news: scoreNews,
  social: scoreSocial,
  volatility: scoreVolatility,
  liquidity: scoreLiquidity,
  valuation: scoreValuation,
  inflection: scoreInflection,
  pipeline: scorePipeline,
  sentimentShift: scoreSentimentShift,
};

function hasConfirmedFundamentalTurn(c: CompanyData): boolean {
  const inf = c.inflection;
  if (!inf) return false;
  return (
    (inf.revAccelQoQ ?? 0) > 0.01 ||
    (inf.revYoYAccel ?? 0) > 0.01 ||
    ((inf.grossMarginDeltaYoY ?? 0) > 0.01 && (inf.opexPctRevDeltaYoY ?? 0) <= 0) ||
    (inf.opMarginPrevYearQ != null && inf.opMarginPrevYearQ < 0 && (inf.opMarginNow ?? -1) >= 0)
  );
}

function hasHardPipelineEvidence(c: CompanyData): boolean {
  const p = c.pipeline;
  if (!p) return false;
  const visibilityYoY = Math.max(
    p.backlogYoY ?? Number.NEGATIVE_INFINITY,
    p.deferredRevYoY ?? Number.NEGATIVE_INFINITY,
  );
  const revGrowth = Math.max(c.fundamentals.revenueGrowthYoY, 0.05);
  return (
    (p.bookToBill ?? 0) > 1.1 ||
    (p.backlogToRevTTM ?? 0) > 0.8 ||
    (p.namedContractPctRev ?? 0) >= 0.05 ||
    (Number.isFinite(visibilityYoY) && visibilityYoY / revGrowth >= 1) ||
    (p.nrr ?? 0) >= 1.05 ||
    (p.shareDeltaBps ?? 0) > 0
  );
}

function hasConvictionEvidence(c: CompanyData): boolean {
  return (
    smartMoneyCatalystBoost(c).points > 0 ||
    thirteenDCount(c) > 0 ||
    (c.strategicCapital?.amountUsd ?? 0) > 0
  );
}

function hasPrimarySubstance(c: CompanyData): boolean {
  return (
    hasConfirmedFundamentalTurn(c) ||
    hasHardPipelineEvidence(c) ||
    hasConvictionEvidence(c) ||
    isRealCatalyst(c.catalyst, c.catalystLive) ||
    (c.revenueTTM != null && c.revenueTTM >= 1_000_000)
  );
}

function valueTrapRisk(c: CompanyData): number {
  const inf = c.inflection;
  const revenueDecline =
    c.fundamentals.revenueGrowthYoY < -0.08 &&
    ((inf?.revYoYAccel ?? 0) < -0.02 || (inf?.revAccelQoQ ?? 0) < -0.01);
  const fcfWorsening =
    c.fundamentals.fcfMargin < -0.05 &&
    ((inf?.opexPctRevDeltaYoY ?? 0) > 0.02 || c.risk.cashRunwayQuarters < 4);
  const shareLoss = (c.pipeline?.shareDeltaBps ?? 0) <= -150;
  const dividendCut = c.risk.dividendCutOrSuspended === true;
  const balanceSheetStress = c.fundamentals.debtToEquity > 2.5 || c.risk.dilutionRisk > 0.35;
  const trapLegs = [revenueDecline, fcfWorsening, shareLoss, dividendCut, balanceSheetStress].filter(Boolean).length;
  return trapLegs >= 2 ? Math.min(6, 2 + trapLegs) : 0;
}

function smallCapFallingKnifeRisk(c: CompanyData): number {
  const isSmallOrUnknown = !Number.isFinite(c.marketCap) || c.marketCap <= 3_000_000_000;
  if (!isSmallOrUnknown) return 0;
  const freshCatalyst =
    isRealCatalyst(c.catalyst, c.catalystLive) &&
    c.catalyst.daysAway >= -30 &&
    c.catalyst.daysAway <= 180;
  const downtrend =
    !c.momentum.aboveSMA50 &&
    !c.momentum.aboveSMA200 &&
    c.momentum.return1M <= 0 &&
    c.momentum.return3M < -0.12;
  return downtrend && !freshCatalyst && !hasConfirmedFundamentalTurn(c) && !hasHardPipelineEvidence(c)
    ? 4
    : 0;
}

// ---------------------------------------------------------------------------
// Risk penalty
// ---------------------------------------------------------------------------

function computeRiskPenalty(c: CompanyData): { penalty: number; explanation: string } {
  const r = c.risk;
  const fcfMargin = fundamentalValue(c, "fcfMargin", 0);
  const reasons: string[] = [];
  let penalty = 0;

  // Solvency. This used to require BOTH negative free cash flow AND a short cash
  // runway. In production neither leg was real - `fcfMargin` was disclosed for 0%
  // of the board and `cashRunwayQuarters` was a ticker-hash - so the entire
  // component was dead, and a company burning several times its revenue was
  // published as "Low risk". Free cash flow is now a filed XBRL figure, so the
  // BURN ITSELF carries the judgement and the runway only sharpens it.
  //
  // Deliberately NOT a hard rule (owner request 2026-07-25): an unprofitable, cash-burning
  // name is not disqualified - it is asked to earn its place. This is a bounded
  // penalty, so a genuine setup with a real catalyst and a real order book (an
  // early-stage contractor, say) can still out-rank a safe-but-dull large cap.
  // What it stops is a name reaching the top of the board while the fact that it
  // spends multiples of its revenue is invisible.
  const burnAvailable = fundAvailable(c, "fcfMargin");
  const netMargin = fundamentalValue(c, "netMargin", 0);
  const netAvailable = fundAvailable(c, "netMargin");
  // Severity of the burn relative to the business: -20% of revenue is a heavy
  // investment year, -100%+ is a company consuming multiples of what it earns.
  // Starts at −10% of revenue (a business consuming a tenth of its top line in
  // cash is funding itself from somewhere other than operations) and saturates at
  // −150% (consuming more than it earns, several times over).
  const burnSeverity = burnAvailable
    ? clamp(scaleLinear(fcfMargin, -0.1, -1.5, 0, 1), 0, 1)
    : netAvailable
      ? clamp(scaleLinear(netMargin, -0.1, -1.5, 0, 1), 0, 1)
      : 0;
  if (burnSeverity > 0) {
    // A short runway compounds it; an unknown runway neither adds nor excuses.
    const runwayRisk = clamp(scaleLinear(r.cashRunwayQuarters, 8, 1, 0, 1), 0, 1);
    const add = RISK.components.solvency.max * clamp(burnSeverity * (0.7 + 0.3 * runwayRisk), 0, 1);
    if (add > 0.5) {
      penalty += add;
      const pctOfRevenue = burnAvailable ? fcfMargin : netMargin;
      reasons.push(
        `consuming ${Math.abs(Math.round(pctOfRevenue * 100))}% of revenue in cash${
          runwayRisk > 0.5 ? ` on a ~${r.cashRunwayQuarters.toFixed(1)}q runway` : ""
        }`,
      );
    }
  }

  // Dilution overhang.
  const dilutionAdd = RISK.components.dilution.max * clamp(r.dilutionRisk, 0, 1);
  if (dilutionAdd > 0.5) {
    penalty += dilutionAdd;
    reasons.push("financing/dilution overhang");
  }

  // Crowded short. High SI is risk unless it is fuel attached to a confirmed turn.
  const shortInterestFuel =
    r.shortInterestPct > 0.2 &&
    (r.daysToCover ?? 0) > 5 &&
    (hasConfirmedFundamentalTurn(c) || hasHardPipelineEvidence(c));
  if (r.shortInterestPct > 0.1 && !shortInterestFuel) {
    const add = RISK.components.shortInterest.max * scaleLinear(r.shortInterestPct, 0.1, 0.4, 0, 1);
    penalty += add;
    reasons.push(`${formatPctPlain(r.shortInterestPct)} short interest`);
  }

  // Governance / accounting flags.
  const govAdd = RISK.components.governance.max * clamp(r.governanceFlag, 0, 1);
  if (govAdd > 0.5) {
    penalty += govAdd;
    reasons.push("governance / accounting flags");
  }

  // Uninvestable-grade volatility (beyond the "opportunity" band).
  if (c.volatility.atrPct > 0.12) {
    const add = RISK.components.extremeVol.max * scaleLinear(c.volatility.atrPct, 0.12, 0.25, 0, 1);
    penalty += add;
    reasons.push("extreme daily swings");
  }

  // --- Anti-lottery / quality-vs-pump guard (v2). The decisive distinction between
  //     a real small-cap setup and a pump: real winners pass the "boring questions";
  //     pumps are a tiny float + no revenue + a promo-only catalyst + insider
  //     selling + chronic dilution. This LOWERS the score (it never zeroes a name),
  //     so a genuine coiled-spring with real inflection still ranks - it's the small
  //     curve's safety valve, symmetric with how dilution/short-interest penalize. A
  //     biotech-binary name is exempt from the no-revenue leg (it has no revenue line
  //     by design) but carries its own honest watch-out elsewhere. */
  const pumpReasons: string[] = [];
  let pump = 0;

  // (a) no-revenue shell - observed ~0 revenue (never asserted
  //     from MISSING data: undefined revenueTTM ⇒ 0 here). Biotech-binary exempt.
  if (
    c.revenueTTM != null &&
    c.revenueTTM < 1_000_000 &&
    !c.binaryCatalystTag
  ) {
    pump += 4;
    pumpReasons.push("no revenue line");
  }

  // (b) manipulation-prone microstructure - a thin float AND thin dollar volume
  //     together (graduated; a reasonable small-cap with healthy ADV scores ~0).
  const floatAdv = Math.max((c.liquidity.floatShares || 0) * (c.liquidity.avgDollarVolume || 0), 1);
  const lowFloatLowAdv = clamp(scaleLinear(Math.log10(floatAdv), 14, 12, 0, 1), 0, 1);
  if (lowFloatLowAdv > 0.15) {
    pump += 3 * lowFloatLowAdv;
    pumpReasons.push("thin float / thin volume");
  }

  // (c) promo-only catalyst - a positive attention/sentiment spike with NO hard
  //     event behind it (the substance gate fired). Pump tickets live here.
  const shift = computeSentimentShift(c);
  const promoOnly =
    !shift.coldStart && shift.unconfirmedHype && c.catalystLive !== true && !isRealCatalyst(c.catalyst, c.catalystLive);
  if (promoOnly) {
    pump += 3;
    pumpReasons.push("promo-only hype, no primary source");
  }

  // (d) material insider / congressional SELLING (size + cluster gated upstream).
  const sell = materialSellSignal(c);
  if (sell.intensity > 0) {
    pump += 3 * sell.intensity;
    pumpReasons.push("material insider/congress selling");
  }

  // (e) chronic dilution / going-concern overhang (distinct framing from the
  //     dilution component above; both bounded by RISK.cap so it can't run away).
  if (c.risk.dilutionRisk > 0.3) {
    pump += 3 * clamp(c.risk.dilutionRisk, 0, 1);
    pumpReasons.push("chronic dilution overhang");
  }

  // (f) value trap - cheap only works when the business is not structurally eroding.
  const trap = valueTrapRisk(c);
  if (trap > 0) {
    pump += trap;
    pumpReasons.push("value trap: accelerating decline / weak quality floor");
  }

  // (g) small-cap falling knife - downtrend plus no fresh primary-source reason.
  const fallingKnife = smallCapFallingKnifeRisk(c);
  if (fallingKnife > 0) {
    pump += fallingKnife;
    pumpReasons.push("small-cap falling knife, no fresh catalyst");
  }

  // (h) missing-substance / MAX-style tickets. Missing optional flags are neutral;
  // observed red flags demote names that would otherwise rank on attention alone.
  const attentionHeavy =
    c.news.count7d >= 8 ||
    c.social.trendDelta > 0.6 ||
    c.social.redditMentions24h + c.social.xMentions24h > 4_000;
  if (!hasPrimarySubstance(c) && attentionHeavy) {
    pump += 3;
    pumpReasons.push("attention-heavy with no primary-source substance");
  }
  if (c.risk.maxSpikeNoFiling === true) {
    pump += 4;
    pumpReasons.push("MAX-style spike with no filing");
  }
  if (c.risk.reverseSplitHistory === true) {
    pump += 2;
    pumpReasons.push("reverse-split history");
  }
  if (c.risk.goingConcernFlag === true) {
    pump += 4;
    pumpReasons.push("going-concern warning");
  }

  pump = clamp(pump, 0, RISK.components.pumpRisk.max);
  if (pump > 0.5) {
    penalty += pump;
    reasons.push(`pump-risk (${pumpReasons.slice(0, 2).join(", ")})`);
  }

  const extCloses = c.priceHistory ?? [];
  if (extCloses.length >= 40 && c.price > 0) {
    const trailingLow = Math.min(c.price, ...extCloses);
    if (trailingLow > 0) {
      const runFromLow = (c.price - trailingLow) / trailingLow; // 0=at the low, 9≈+900%
      // CAP-AWARE ramp (owner request 2026-07-01): a LARGE-cap up ~100% in a year with no fresh
      // catalyst is chasing highs and must be demoted, but a small/micro cap legitimately
      // runs much further early in a real move. So large-caps ramp EARLY (0.6x→2.5x: up
      // ~60% starts, up ~250% is full), while small/micro keep the lenient 1.3x→5x. This
      // is the extension half of the cap-specific strategy (chasers out, discounted bases in).
      // EFFECTIVELY large: a real large-cap OR an unknown-cap name trading like a mega-cap
      // (>$1B/day volume) - so a $450B ADR that published with cap 0 (TSM) still gets the
      // strict large-cap chasing ramp instead of the lenient small-cap one. Real-data only.
      const capKnown = Number.isFinite(c.marketCap) && c.marketCap > 0;
      const isLargeCap =
        (capKnown && c.marketCap > 3_000_000_000) ||
        (!capKnown && (c.liquidity?.avgDollarVolume ?? 0) > 1_000_000_000);
      const rampLo = isLargeCap ? 0.6 : 1.3;
      const rampHi = isLargeCap ? 2.5 : 5;
      let ext = RISK.components.extension.max * clamp(scaleLinear(runFromLow, rampLo, rampHi, 0, 1), 0, 1);
      // Soften ONLY when a GENUINE 2nd-derivative re-acceleration or a real dated catalyst
      // justifies continuation (aligned with the tightened archetype threshold - a
      // marginally-positive number no longer excuses a chaser). Smart-money conviction
      // (congress/insider buys) is NOT a dated catalyst and does not soften this.
      const inf = c.inflection;
      const reaccelerating =
        inf != null &&
        ((inf.revAccelQoQ ?? -1) > 0.02 ||
          (inf.revYoYAccel ?? -1) > 0.03 ||
          (inf.grossMarginDeltaYoY ?? -1) > 0.01);
      if (reaccelerating || isRealCatalyst(c.catalyst, c.catalystLive)) ext *= 0.65;
      if (ext > 0.5) {
        penalty += ext;
        reasons.push(`extended ~${Math.round(runFromLow * 100)}% above its base (already ran)`);
      }
    }
  }

  penalty = clamp(penalty, 0, RISK.cap);

  const explanation =
    reasons.length === 0
      ? "No major risk flags detected."
      : `Penalized ${round(penalty, 1)} pts for ${reasons.join(", ")}.`;

  return { penalty, explanation };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

const FUNDAMENTAL_KEYS: Array<keyof CompanyData["fundamentals"]> = [
  "revenueGrowthYoY",
  "epsGrowthYoY",
  "grossMargin",
  "netMargin",
  "peRatio",
  "pegRatio",
  "debtToEquity",
  "fcfMargin",
];

function isModeledUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("example-research.local") || lower.includes("/synthetic");
}

function realSourceLabels(c: CompanyData): Set<string> {
  const labels = new Set<string>();
  for (const source of c.sources ?? []) {
    if (!isModeledUrl(source.url)) labels.add(source.label.trim().toLowerCase());
  }
  for (const item of c.news?.items ?? []) {
    if (!isModeledUrl(item.url)) labels.add(item.source.trim().toLowerCase());
  }
  for (const post of c.socialPosts ?? []) {
    if (!isModeledUrl(post.url)) labels.add(post.platform);
  }
  return labels;
}

function newsSourceLabels(c: CompanyData): Set<string> {
  const labels = new Set<string>();
  for (const item of c.news?.items ?? []) {
    if (!isModeledUrl(item.url)) labels.add(item.source.trim().toLowerCase());
  }
  return labels;
}

function hasModeledOnlySources(c: CompanyData): boolean {
  return c.sources.length > 0 && realSourceLabels(c).size === 0;
}

function liveFundamentalsCoverage(c: CompanyData): { score: number; present: number; total: number } {
  const availability = c.fundamentalsAvailability;
  const total = FUNDAMENTAL_KEYS.length;

  if (!availability) {
    // Older/live records without field provenance are treated as partial, not
    // full confidence. Sample-only records are lower because the source is modeled.
    return { score: hasModeledOnlySources(c) ? 42 : 55, present: 0, total };
  }

  const present = FUNDAMENTAL_KEYS.filter((key) => availability[key] === true).length;
  return { score: (present / total) * 100, present, total };
}

function priceEvidenceScore(c: CompanyData): number {
  const points = Math.max(c.priceSeries.length, c.priceHistory.length);
  if (points >= 200) return 96;
  if (points >= 120) return 85;
  if (points >= 60) return 72;
  if (points >= 30) return 58;
  return 35;
}

function newsEvidenceScore(c: CompanyData): number {
  const sources = newsSourceLabels(c).size;
  const liveHeadlineCount = c.news.items.filter((n) => !isModeledUrl(n.url)).length;
  const headlineCount = liveHeadlineCount > 0 ? liveHeadlineCount : c.news.count7d;
  const freshnessScore = scaleLinear(c.news.freshnessHours, 96, 0);
  const volumeScore = scaleLinear(headlineCount, 0, 10);
  const diversityScore = scaleLinear(sources, 0, 4);
  const base = weightedAverage([
    { score: freshnessScore, weight: 0.4 },
    { score: volumeScore, weight: 0.35 },
    { score: diversityScore, weight: 0.25 },
  ]);
  return liveHeadlineCount > 0 ? base : base * 0.72;
}

function socialEvidenceScore(c: CompanyData): number {
  const hasStockTwits =
    c.social.summary.toLowerCase().includes("stocktwits") ||
    (c.socialPosts ?? []).some((p) => p.url.toLowerCase().includes("stocktwits.com"));
  const mentions = c.social.redditMentions24h + c.social.xMentions24h;
  const volumeScore = scaleLinear(Math.log10(mentions + 1), 0, 3);
  if (hasStockTwits) {
    return weightedAverage([
      { score: 78, weight: 0.55 },
      { score: volumeScore, weight: 0.45 },
    ]);
  }
  return weightedAverage([
    { score: hasModeledOnlySources(c) ? 38 : 50, weight: 0.6 },
    { score: volumeScore, weight: 0.4 },
  ]);
}

function catalystEvidenceScore(c: CompanyData): number {
  const timingScore = scaleBand(c.catalyst.daysAway, 3, 60);
  const magnitudeScore = scaleLinear(c.catalyst.magnitude, 0.25, 0.9);
  const raw = weightedAverage([
    { score: magnitudeScore, weight: 0.58 },
    { score: timingScore, weight: 0.42 },
  ]);
  return c.catalystLive === true ? raw : raw * 0.55;
}

function evidenceCoverageScore(c: CompanyData): {
  score: number;
  fundamentals: ReturnType<typeof liveFundamentalsCoverage>;
  sourceCount: number;
  newsSources: number;
} {
  const fundamentals = liveFundamentalsCoverage(c);
  const sourceCount = realSourceLabels(c).size;
  const newsSources = newsSourceLabels(c).size;
  const score = weightedAverage([
    { score: fundamentals.score, weight: 0.28 },
    { score: priceEvidenceScore(c), weight: 0.2 },
    { score: newsEvidenceScore(c), weight: 0.24 },
    { score: socialEvidenceScore(c), weight: 0.1 },
    { score: catalystEvidenceScore(c), weight: 0.12 },
    { score: scaleLinear(sourceCount, 0, 5), weight: 0.06 },
  ]);
  return { score, fundamentals, sourceCount, newsSources };
}

function agreementScore(categories: ScoreCategory[]): number {
  const scores = categories.map((cat) => cat.score);
  const avg = scores.reduce((sum, n) => sum + n, 0) / Math.max(1, scores.length);
  const variance = scores.reduce((sum, n) => sum + (n - avg) ** 2, 0) / Math.max(1, scores.length);
  const stdev = Math.sqrt(variance);
  const dispersionPenalty = scaleLinear(stdev, 8, 35, 0, 45);

  const fund = categories.find((x) => x.key === "fundamentals")?.score ?? 50;
  const mom = categories.find((x) => x.key === "momentum")?.score ?? 50;
  const directConflict = Math.max(0, Math.abs(fund - mom) - 25) * 0.45;

  return clamp(100 - dispersionPenalty - directConflict, 35, 100);
}

function computeConfidence(c: CompanyData, categories: ScoreCategory[]): ConfidenceResult {
  const evidence = evidenceCoverageScore(c);
  const agreement = agreementScore(categories);
  const fund = categories.find((x) => x.key === "fundamentals")?.score ?? 50;
  const mom = categories.find((x) => x.key === "momentum")?.score ?? 50;
  const modeledOnly = hasModeledOnlySources(c);
  const reasons: string[] = [];

  let confidence = weightedAverage([
    { score: evidence.score, weight: CONFIDENCE.evidenceWeight },
    { score: agreement, weight: CONFIDENCE.agreementWeight },
  ]);

  if (c.news.count7d < 3) {
    confidence -= CONFIDENCE.thinNewsPenalty;
    reasons.push("thin recent news coverage");
  }

  if (Math.abs(fund - mom) > 45) {
    confidence -= CONFIDENCE.signalConflictPenalty;
    reasons.push("fundamentals and momentum disagree");
  }

  if (c.liquidity.avgDollarVolume < LIQUIDITY_BANDS.thin) {
    confidence -= CONFIDENCE.illiquidityPenalty;
    reasons.push("thin trading liquidity");
  }

  if (c.catalystLive === false || c.catalyst.magnitude < 0.35 || c.catalyst.daysAway > 60) {
    confidence -= CONFIDENCE.weakCatalystPenalty;
    reasons.push(c.catalystLive === false ? "no live dated catalyst yet" : "weak or distant catalyst");
  }

  if (modeledOnly) {
    confidence -= CONFIDENCE.modeledSourcePenalty;
    reasons.push("sample or modeled source coverage");
  }

  const rounded = clamp(round(confidence), CONFIDENCE.floor, 100);
  const coverage =
    c.fundamentalsAvailability
      ? `${evidence.fundamentals.present}/${evidence.fundamentals.total} live fundamentals`
      : modeledOnly
        ? "modeled fundamentals"
        : "partial fundamentals provenance";
  const sources =
    evidence.sourceCount >= 3
      ? `${evidence.sourceCount} independent source groups`
      : `${evidence.sourceCount} live source group${evidence.sourceCount === 1 ? "" : "s"}`;
  const agreementText =
    agreement >= 75 ? "signals mostly agree" : agreement >= 58 ? "signals are mixed" : "signals conflict";
  const pressure = reasons.length > 0 ? ` Reduced for ${reasons.slice(0, 3).join(", ")}.` : "";

  return {
    confidence: rounded,
    explanation: `${coverage}; ${sources}; ${agreementText}.${pressure}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scoreCompany(c: CompanyData): ScoreBreakdown {
  const categories: ScoreCategory[] = CATEGORY_CONFIG.map((cfg) => {
    const { score, explanation } = SCORERS[cfg.key](c);
    const rounded = round(clamp(score), 0);
    return {
      key: cfg.key,
      label: cfg.label,
      score: rounded,
      weight: cfg.weight,
      contribution: round(rounded * cfg.weight, 1),
      explanation,
    };
  });

  const blended = weightedAverage(
    categories.map((cat) => ({ score: cat.score, weight: cat.weight })),
  );

  const { penalty, explanation: riskExplanation } = computeRiskPenalty(c);
  const opportunityScore = clamp(round(blended - penalty), 0, 100);
  const { confidence, explanation: confidenceExplanation } = computeConfidence(c, categories);

  return {
    opportunityScore,
    confidence,
    confidenceExplanation,
    riskPenalty: round(penalty, 1),
    riskExplanation,
    categories,
  };
}
