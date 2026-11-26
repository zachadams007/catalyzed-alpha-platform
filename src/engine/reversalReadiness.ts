import type { StockSignal } from "@/types";
import { clamp, round, scaleLinear, stdev } from "@/lib/math";

/**
 * reversalReadiness - P1 (refinement proposal 2026-07-02): "require down-leg
 * EXHAUSTION before we pay for a discount".
 *
 * The board's flagship failure (§1b) was that the discount machinery paid its
 * MAX reward to names mid-crash - PCT (RSI 21, −34.5% in a month), EVMN
 * (−42.8%/1M), EMPD, BMNR - purely because they had fallen far. "How far a name
 * has fallen" is not "whether the fall has stopped". This module adds the missing
 * TIMING content, computed ENTIRELY from the ≥120-close `priceHistory` the engine
 * already requires - zero new data, pure and deterministic.
 *
 * It returns a 0..1 `readiness` that SCALES the discount-tilt REWARD in
 * normalizeUniverse (it never adds a penalty): a discounted name earns full
 * discount points only once its decline has measurably decelerated and/or based;
 * a knife still accelerating down earns little or none.
 *
 * NON-NEGOTIABLE (the owner): being below a moving average is NEVER itself a
 * disqualifier. A quiet name six months under its 50-DMA with a flat base scores
 * WELL here - that is exactly where reversals are caught, before the move. Only an
 * ACTIVE crash (deeply oversold + a fresh >25% monthly drop + no live catalyst) is
 * vetoed, and even then the effect is only "no discount BONUS", never a penalty. A
 * live dated catalyst bypasses the gate entirely, because a catalyst is precisely
 * the event that ends a down-leg.
 */

export interface ReversalReadiness {
  /** 0..1 - the fraction of the discount reward to pay (1 = fall stopped / bypass). */
  readiness: number;
  /** Down-leg deceleration: 0 = still accelerating down, 0.5 = flat, 1 = decelerating/turning up. */
  deceleration: number;
  /** Basing / vol-contraction: 0 = expanding vol or fresh lows, 1 = compressed, not making new lows. */
  basing: number;
  /** A live dated catalyst bypassed the gate (readiness pinned to 1). */
  catalystBypass: boolean;
  /** The falling-knife veto fired (readiness pinned to 0). */
  fallingKnifeVeto: boolean;
  /** A FRESH adverse shock - a sharp recent single-session gap-down or fresh,
   *  corroborated, strongly-negative news. The washout is digesting an EVENT, not
   *  gently basing, so the caller dampens the discount reward (AEM mine-halt case,
   *  owner request 2026-07-03). Exposed as a flag; the damper is applied in normalizeUniverse
   *  AFTER the quality floor, so it can cut through even a megaReversal's floor. */
  freshShock: boolean;
}

/** A single-session drop worse than this reads as an EVENT (a gap), not drift. */
const SHOCK_GAP = -0.06;
const SHOCK_LOOKBACK = 6;

/**
 * A fresh adverse shock: (a) a sharp single-session gap-down in the last few
 * sessions, or (b) fresh + corroborated + strongly-negative news. Not a live
 * catalyst (that's handled by the bypass). Computed from data always on the signal.
 */
/**
 * Disclosed forward evidence that CONTRADICTS a price shock.
 *
 * A gap-down is only an adverse EVENT if the business actually deteriorated. SoFi
 * fell ~10% on a quarter that beat on revenue and EPS, raised full-year revenue
 * guidance, and posted record originations - the market re-rated the multiple, it
 * did not learn the business was worse. Treating that identically to a mine halt
 * (the AEM case this damper was built for) is exactly backwards: a sharp drop on
 * intact-or-improving disclosed fundamentals is the "misunderstood" setup this
 * product exists to find, and damping the discount reward there suppresses the
 * best entries at the moment they appear.
 *
 * Only FILED / disclosed figures count - never the tone of the coverage, which is
 * the very thing that is negative in this scenario.
 */
function forwardEvidenceIntact(signal: StockSignal): boolean {
  const revenueGrowing = (signal.fundamentals?.revenueGrowthYoY ?? 0) >= 0.05;
  const pipe = signal.pipeline;
  const bookingsGrowing =
    (pipe?.backlogYoY ?? Number.NEGATIVE_INFINITY) > 0 ||
    (pipe?.deferredRevYoY ?? Number.NEGATIVE_INFINITY) > 0;
  return revenueGrowing && bookingsGrowing;
}

function detectFreshShock(signal: StockSignal, closes: number[]): boolean {
  // A price shock contradicted by growing disclosed revenue AND a growing order
  // book is a re-rating, not damage. See forwardEvidenceIntact.
  if (forwardEvidenceIntact(signal)) return false;

  const n = closes.length;
  if (n >= SHOCK_LOOKBACK + 1) {
    for (let i = n - SHOCK_LOOKBACK; i < n; i++) {
      const prev = closes[i - 1]!;
      if (prev > 0 && (closes[i]! - prev) / prev <= SHOCK_GAP) return true;
    }
  }
  const news = signal.news;
  return (
    news != null &&
    Number.isFinite(news.freshnessHours) &&
    news.freshnessHours < 72 &&
    Number.isFinite(news.sentiment) &&
    news.sentiment < -0.25 &&
    (news.count7d ?? 0) >= 3
  );
}

/** Enough closes to read a real base - mirrors scoreValuation's MIN_HISTORY_FOR_ENTRY. */
const MIN_HISTORY = 120;
/** RSI below this + a fresh >25% monthly drop + no live catalyst = an active falling knife. */
const KNIFE_RSI = 35;
const KNIFE_1M_DROP = -0.25;

/** No real base to judge on ⇒ don't gate. Discount reward already needs ≥120 closes
 *  to earn a real discount z, and we must never neglect a name just for thin history. */
const READY_NEUTRAL: ReversalReadiness = {
  readiness: 1,
  deceleration: 0.5,
  basing: 0.5,
  catalystBypass: false,
  fallingKnifeVeto: false,
  freshShock: false,
};

/**
 * A live, dated, material catalyst - the event that legitimately ends a down-leg,
 * so we don't demand the price has already stopped falling. Mirrors the freshness
 * window used by the archetype router (`inferArchetypeFlags`).
 */
function hasLiveCatalystBypass(signal: StockSignal): boolean {
  const cat = signal.catalyst;
  const daysAway = cat?.daysAway ?? Number.POSITIVE_INFINITY;
  if (signal.catalystLive !== true || (cat?.magnitude ?? 0) < 0.35) return false;
  // A scheduled EARNINGS report is graduated by proximity (see
  // `earningsReadinessFloor`), never a blanket bypass: every name has one every
  // quarter, so "a report is scheduled" cannot by itself mean the down-leg is
  // over. Only an imminent print bypasses outright.
  if (cat?.type === "Earnings") return daysAway >= 0 && daysAway <= EARNINGS_BYPASS_DAYS;
  return daysAway >= -30 && daysAway <= 180;
}

/** A scheduled report this close IS the event that resolves the down-leg. */
const EARNINGS_BYPASS_DAYS = 7;
/** Inside this window the print is the setup: a floor, not a bypass. */
const EARNINGS_FLOOR_DAYS = 21;
const EARNINGS_FLOOR = 0.6;

/**
 * The gate asks "has the fall stopped?"; for an oversold quality name a week out from its print
 * that is the wrong question - the report is what ends the leg either way (Amazon reported the
 * day after the 2026-07-29 board and gapped up). Graduated so the gate is only relaxed when the
 * resolution is genuinely near: ≤ 7 days  → full bypass (handled in `hasLiveCatalystBypass`) ≤
 * 21 days → readiness floor 0.6 otherwise → nothing; the price-action gate applies as before A
 * report that already happened (daysAway < 0) is a fact being digested, not a coming catalyst.
 * The falling-knife veto still wins: an active crash INTO a print is the riskiest setup there
 * is.
 */
function earningsReadinessFloor(signal: StockSignal): number {
  const cat = signal.catalyst;
  if (signal.catalystLive !== true || cat?.type !== "Earnings") return 0;
  const daysAway = cat.daysAway ?? Number.POSITIVE_INFINITY;
  return daysAway >= 0 && daysAway <= EARNINGS_FLOOR_DAYS ? EARNINGS_FLOOR : 0;
}

export function reversalReadiness(signal: StockSignal): ReversalReadiness {
  if (hasLiveCatalystBypass(signal)) {
    return { readiness: 1, deceleration: 1, basing: 1, catalystBypass: true, fallingKnifeVeto: false, freshShock: false };
  }

  const closes = signal.priceHistory ?? [];
  const n = closes.length;
  const last = n > 0 ? closes[n - 1]! : 0;
  const price = signal.price > 0 ? signal.price : last;
  if (n < MIN_HISTORY || price <= 0 || last <= 0) return { ...READY_NEUTRAL };

  // --- Down-leg deceleration: recent 10-session daily rate vs the prior 20-session
  //     daily rate. A knife still accelerating down → 0; a decline that has slowed
  //     or turned up → 1; a flat trajectory → 0.5.
  const cRecentStart = closes[n - 11]!; // 10 sessions ago
  const cPriorStart = closes[n - 31]!; //  30 sessions ago
  let deceleration = 0.5;
  if (cRecentStart > 0 && cPriorStart > 0) {
    const retRecent = (last - cRecentStart) / cRecentStart; // over the last 10 sessions
    const retPrior = (cRecentStart - cPriorStart) / cPriorStart; // over the prior 20 sessions
    const dRecent = retRecent / 10;
    const dPrior = retPrior / 20;
    deceleration = scaleLinear(dRecent - dPrior, -0.003, 0.003, 0, 1);
  }

  // --- Basing / volatility contraction: realized vol of the last 10 daily returns
  //     vs the prior 20, plus a damper while the name is still probing fresh 20-day
  //     lows (a compressing base that has stopped making new lows is the setup).
  const dailyReturns: number[] = [];
  for (let i = n - 30; i < n; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    dailyReturns.push(prev > 0 ? (cur - prev) / prev : 0);
  }
  const volPrior = stdev(dailyReturns.slice(0, 20));
  const volRecent = stdev(dailyReturns.slice(-10));
  const vr = volPrior > 0 ? volRecent / volPrior : 1;
  let basing = scaleLinear(vr, 1.2, 0.5, 0, 1); // vol halving ⇒ 1, vol expanding ⇒ 0
  const low20 = Math.min(...closes.slice(n - 20));
  if (low20 > 0 && price <= low20 * 1.02) basing *= 0.4; // still making / near fresh lows

  const readiness0 = clamp(0.55 * deceleration + 0.45 * basing, 0, 1);

  // --- Falling-knife veto: deeply oversold AND a fresh >25% monthly drop = an
  //     active crash (a live catalyst already bypassed above). Strip the discount
  //     BONUS (readiness 0) - never a penalty, and never fired by "below an MA" alone.
  const rsi = signal.momentum?.rsi ?? 50;
  const priorMonth = closes[Math.max(0, n - 22)]!;
  const ret1M =
    signal.momentum?.return1M != null && Number.isFinite(signal.momentum.return1M)
      ? signal.momentum.return1M
      : priorMonth > 0
        ? (last - priorMonth) / priorMonth
        : 0;
  const fallingKnifeVeto = rsi < KNIFE_RSI && ret1M < KNIFE_1M_DROP;
  const readiness = fallingKnifeVeto ? 0 : Math.max(readiness0, earningsReadinessFloor(signal));

  return {
    readiness: round(readiness, 3),
    deceleration: round(deceleration, 3),
    basing: round(basing, 3),
    catalystBypass: false,
    fallingKnifeVeto,
    freshShock: detectFreshShock(signal, closes),
  };
}
