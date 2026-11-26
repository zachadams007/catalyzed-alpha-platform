import type { InteractionEvent, InteractionKind, Portfolio, StockSignal } from "@/types";
import { formatPct, formatPctPlain } from "@/lib/format";
import { materialSellSignal } from "@/engine/catalystStrength";
import { looksUnprofitable } from "@/engine/profitability";
import { isSampleProfile, isMarketDataUnavailable } from "@/lib/marketData";
import { asOfQualifier, isFundamentalsFresh } from "@/data/fundamentals/fundamentalsProvenance";

/**
 *
 * One pure derivation of the genuinely-bad changes on a name, from the signal's
 * ALREADY-computed fields. Every rule fires only on a real, observable condition
 * (a material disclosed sale, a real analyst sell-skew, a real fundamental
 * deterioration, a real negative-toned headline) - NOTHING is fabricated, and a
 * record with no live market data (sample / directory-unavailable) yields nothing
 * so a synthetic figure is never presented as a red flag.
 *
 * Used in two places so the feed reads the same downside everywhere:
 *   • inline NEGATIVE BADGES on held / watchlisted feed cards, and
 *   • the top-of-feed "Watch-outs today" strip (aggregated across the user's
 *     watchlist + holdings).
 *
 * Severity ranks the badges: "alert" (material selling / governance) outranks
 * "warn" (deteriorating fundamentals, sell-skew, negative news) so the strip and
 * the tile lead with the worst thing first.
 */

export type NegativeKind =
  | "insider_selling"
  | "congress_selling"
  | "downgrade"
  | "deteriorating"
  | "bad_news"
  | "high_risk";

export type NegativeSeverity = "alert" | "warn";

export interface NegativeSignal {
  kind: NegativeKind;
  /** Short tile/strip label, e.g. "Insider selling". */
  label: string;
  /** Plain-English specifics for the tooltip / strip sub-line. */
  detail: string;
  severity: NegativeSeverity;
}

const SEVERITY_RANK: Record<NegativeSeverity, number> = { alert: 0, warn: 1 };

/**
 * Field-availability guard for fundamentals-derived watch-outs - FAILS CLOSED.
 *
 * A red flag derived from a fundamental (deteriorating EPS / revenue / margin)
 * fires ONLY when the record explicitly vouches for that field AND the figure is
 * fresh:
 *   1. an availability map is present (every LIVE builder always sets one), and
 *   2. `availability[key] === true` (the value came from a real provider), and
 *   3. the fundamentals are fresh (a present, in-window as-of stamp) - so a
 *      1–2-quarter-stale Finnhub TTM can't print a watch-out as if it were now.
 *
 * The ONLY fail-open case is the curated MOCK_UNIVERSE / modeled demo record,
 * which carries NO availability map at all - there the existing sample framing
 * applies. Any LIVE-shaped record that lost or never got a map yields nothing,
 * so a synthetic random can never surface as a fabricated red flag (the SOFI
 * "Unprofitable −19.8% net margin" bug).
 */
function fundAvailable(signal: StockSignal, key: keyof StockSignal["fundamentals"]): boolean {
  const av = signal.fundamentalsAvailability;
  if (!av) return true; // modeled/curated record (no provenance) - legacy framing.
  if (av[key] !== true) return false; // live record: must be explicitly available.
  // Live + available → also require freshness so a stale figure isn't shown as current.
  return isFundamentalsFresh(signal.fundamentalsAsOf);
}

/**
 * Derive the honest negative signals for one name, worst-first. Returns [] when
 * there is genuinely nothing bad to flag (honest both ways) or when the record
 * has no real market data behind it.
 */
export function deriveNegativeSignals(signal: StockSignal): NegativeSignal[] {
  // Integrity gate: never flag a red flag off a synthetic / unquoted profile.
  if (isSampleProfile(signal) || isMarketDataUnavailable(signal)) return [];

  const out: NegativeSignal[] = [];
  const f = signal.fundamentals;

  // --- Material disclosed SELLING (insiders + congress) - the heaviest flag.
  // Reuses the SAME materiality-gated engine signal the score is built on, then
  // splits it so the badge names WHO is selling (insider vs. congress).
  const sell = materialSellSignal(signal);
  if (sell.intensity > 0) {
    const congSells = (signal.congressTrades ?? []).filter((t) => t.transaction === "sell");
    const insiderNet = signal.secActivity?.form4NetBuyValue90d ?? 0;
    if (congSells.length > 0) {
      const sellers = new Set(congSells.map((t) => t.representative)).size;
      out.push({
        kind: "congress_selling",
        label: "Congress selling",
        detail: `${sellers || congSells.length} disclosed congressional sell${
          congSells.length === 1 ? "" : "s"
        } recently.`,
        severity: "alert",
      });
    }
    if (insiderNet < 0) {
      out.push({
        kind: "insider_selling",
        label: "Insider selling",
        detail: `Net insider selling (~$${(-insiderNet / 1e6).toFixed(1)}M, 90d).`,
        severity: "alert",
      });
    }
    // Material selling with neither leg attributable (defensive) - still honest.
    if (congSells.length === 0 && insiderNet >= 0) {
      out.push({
        kind: "insider_selling",
        label: "Insider selling",
        detail: sell.reason,
        severity: "alert",
      });
    }
  }

  // --- Governance / accounting red flag (real engine risk field).
  if (signal.risk.governanceFlag >= 0.4) {
    out.push({
      kind: "high_risk",
      label: "Governance flag",
      detail: "Governance / accounting red flag in the risk model.",
      severity: "alert",
    });
  }

  // --- Analyst SELL skew - more sells than buys on real disclosed ratings.
  const rec = signal.analyst?.recommendations;
  if (rec) {
    const buys = rec.strongBuy + rec.buy;
    const sells = rec.sell + rec.strongSell;
    if (sells > buys && sells > 0) {
      out.push({
        kind: "downgrade",
        label: "Analyst sells",
        detail: `Street skews sell — ${sells} sell vs ${buys} buy rating${buys === 1 ? "" : "s"}.`,
        severity: "warn",
      });
    }
  }

  // --- Deteriorating fundamentals - shrinking earnings or declining revenue.
  // Each fires only on a real, available, FRESH figure, and the detail carries
  // an honest "as of …" qualifier so a lagged TTM is never shown as current.
  const asOf = asOfQualifier(signal.fundamentalsAsOf);
  if (fundAvailable(signal, "epsGrowthYoY") && f.epsGrowthYoY < 0) {
    out.push({
      kind: "deteriorating",
      label: "Deteriorating",
      detail: `Earnings shrinking — EPS ${formatPct(f.epsGrowthYoY)} YoY${asOf}.`,
      severity: "warn",
    });
  } else if (fundAvailable(signal, "revenueGrowthYoY") && f.revenueGrowthYoY < 0) {
    out.push({
      kind: "deteriorating",
      label: "Deteriorating",
      detail: `Revenue declining — ${formatPct(f.revenueGrowthYoY)} YoY${asOf}.`,
      severity: "warn",
    });
  } else if (
    fundAvailable(signal, "netMargin") &&
    // See looksUnprofitable(). Only consider the P/E when it's a real, available value.
    looksUnprofitable(f.netMargin, fundAvailable(signal, "peRatio") ? f.peRatio : null)
  ) {
    out.push({
      kind: "deteriorating",
      label: "Unprofitable",
      detail: `Unprofitable — ${formatPctPlain(f.netMargin)} net margin${asOf}.`,
      severity: "warn",
    });
  }

  // --- Genuinely bad news - negative aggregate tone with real coverage. Quote
  // the most-negative recent headline when we have one (real, sourced).
  if (signal.news.sentiment <= -0.2 && signal.news.count7d > 0) {
    const worst = [...(signal.news.items ?? [])]
      .filter((n) => typeof n.sentiment === "number")
      .sort((a, b) => a.sentiment - b.sentiment)[0];
    out.push({
      kind: "bad_news",
      label: "Bad news",
      detail: worst?.headline
        ? `Negative news flow — “${worst.headline}”`
        : "Negative news tone in this week's coverage.",
      severity: "warn",
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** True when a name has at least one honest negative to flag. */
export function hasNegativeSignal(signal: StockSignal): boolean {
  return deriveNegativeSignals(signal).length > 0;
}

/**
 * A snapshot of a name's negative-relevant facts at the moment the user got involved with it
 * (added to a portfolio/watchlist/group, or it was suggested).
 */
export interface WatchOutBaseline {
  ticker: string;
  capturedAtISO: string;
  epsGrowthYoY: number | null;
  revenueGrowthYoY: number | null;
  netMargin: number | null;
  peRatio: number | null;
  /** Street skewed sell at baseline. */
  analystSellSkew: boolean;
  /** Net insider selling disclosed at baseline. */
  insiderSelling: boolean;
  /** Congressional selling disclosed at baseline. */
  congressSelling: boolean;
  /** Governance/accounting flag at baseline. */
  governanceFlag: boolean;
  /** Aggregate news tone at baseline (null when there was no coverage). */
  newsSentiment: number | null;
}

/** Extract the baseline facts from a live signal. Returns null for a sample /
 *  unquoted record so a synthetic figure is never captured as a real baseline. */
export function snapshotWatchOutFacts(signal: StockSignal, nowISO: string): WatchOutBaseline | null {
  if (isSampleProfile(signal) || isMarketDataUnavailable(signal)) return null;
  const f = signal.fundamentals;
  const sell = materialSellSignal(signal);
  const congSells = (signal.congressTrades ?? []).filter((t) => t.transaction === "sell");
  const insiderNet = signal.secActivity?.form4NetBuyValue90d ?? 0;
  const rec = signal.analyst?.recommendations;
  const buys = rec ? rec.strongBuy + rec.buy : 0;
  const sells = rec ? rec.sell + rec.strongSell : 0;
  return {
    ticker: signal.ticker.toUpperCase(),
    capturedAtISO: nowISO,
    epsGrowthYoY: fundAvailable(signal, "epsGrowthYoY") ? f.epsGrowthYoY : null,
    revenueGrowthYoY: fundAvailable(signal, "revenueGrowthYoY") ? f.revenueGrowthYoY : null,
    netMargin: fundAvailable(signal, "netMargin") ? f.netMargin : null,
    peRatio: fundAvailable(signal, "peRatio") ? f.peRatio : null,
    analystSellSkew: rec ? sells > buys && sells > 0 : false,
    insiderSelling: sell.intensity > 0 && insiderNet < 0,
    congressSelling: sell.intensity > 0 && congSells.length > 0,
    governanceFlag: signal.risk.governanceFlag >= 0.4,
    newsSentiment: (signal.news?.count7d ?? 0) > 0 ? signal.news.sentiment : null,
  };
}

/** A YoY growth figure must be this much worse than baseline (5 percentage points)
 *  to count as a NEW deterioration rather than the same-old already-known state. */
const WORSE_GROWTH_DELTA = 0.05;
/** News tone must be this much more negative than baseline to re-surface. */
const WORSE_NEWS_DELTA = 0.1;

/**
 * The watch-out surface for ONE name, honest about CHANGE.
 *
 * With a baseline (a name you hold / watch / were shown before), only surface a
 * negative that is genuinely NEW or materially WORSE than when you got in - a fresh
 * downgrade, new disclosed selling, revenue that turned negative, a name that turned
 * unprofitable, newly worse news. A condition that was ALREADY true at baseline (the
 * classic "it was 3% unprofitable when we suggested it") is NOT re-surfaced, so the
 * app never flips from "buy" to "beware" on something that never changed.
 *
 * Without a baseline (e.g. a major market name you don't hold), fall back to the
 * current-state {@link deriveNegativeSignals} so genuinely market-moving events still
 * show. Both paths only ever surface REAL, sourced negatives.
 */
export function deriveWatchOutSignals(
  signal: StockSignal,
  baseline?: WatchOutBaseline | null,
): NegativeSignal[] {
  const current = deriveNegativeSignals(signal);
  if (!baseline) return current;
  const cur = snapshotWatchOutFacts(signal, baseline.capturedAtISO);
  if (!cur) return [];

  const asOf = asOfQualifier(signal.fundamentalsAsOf);
  const out: NegativeSignal[] = [];
  for (const n of current) {
    switch (n.kind) {
      case "insider_selling":
        if (!baseline.insiderSelling) out.push(n);
        break;
      case "congress_selling":
        if (!baseline.congressSelling) out.push(n);
        break;
      case "downgrade":
        if (!baseline.analystSellSkew) out.push(n);
        break;
      case "high_risk":
        if (!baseline.governanceFlag) out.push(n);
        break;
      case "bad_news":
        if (
          baseline.newsSentiment == null ||
          (cur.newsSentiment != null && cur.newsSentiment < baseline.newsSentiment - WORSE_NEWS_DELTA)
        ) {
          out.push(n);
        }
        break;
      case "deteriorating": {
        // Re-derive WHICH deterioration fired and whether it's new/worse vs baseline.
        if (
          cur.epsGrowthYoY != null &&
          cur.epsGrowthYoY < 0 &&
          (baseline.epsGrowthYoY == null ||
            baseline.epsGrowthYoY >= 0 ||
            cur.epsGrowthYoY < baseline.epsGrowthYoY - WORSE_GROWTH_DELTA)
        ) {
          out.push({
            kind: "deteriorating",
            label: "Earnings turned down",
            detail: `Earnings now shrinking — EPS ${formatPct(cur.epsGrowthYoY)} YoY${asOf}.`,
            severity: "warn",
          });
        } else if (
          cur.revenueGrowthYoY != null &&
          cur.revenueGrowthYoY < 0 &&
          (baseline.revenueGrowthYoY == null ||
            baseline.revenueGrowthYoY >= 0 ||
            cur.revenueGrowthYoY < baseline.revenueGrowthYoY - WORSE_GROWTH_DELTA)
        ) {
          out.push({
            kind: "deteriorating",
            label: "Revenue turned down",
            detail: `Revenue now declining — ${formatPct(cur.revenueGrowthYoY)} YoY${asOf}.`,
            severity: "warn",
          });
        } else if (
          cur.netMargin != null &&
          looksUnprofitable(cur.netMargin, cur.peRatio) &&
          baseline.netMargin != null &&
          baseline.netMargin >= 0
        ) {
          // Only when it TURNED unprofitable (was profitable at baseline). A name
          // that was already unprofitable when you got in is NOT re-flagged.
          out.push({
            kind: "deteriorating",
            label: "Turned unprofitable",
            detail: `Now unprofitable — ${formatPctPlain(cur.netMargin)} net margin${asOf}.`,
            severity: "warn",
          });
        }
        break;
      }
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export interface WatchOutEntry {
  signal: StockSignal;
  negatives: NegativeSignal[];
  /** Worst severity present, for sorting the strip. */
  topSeverity: NegativeSeverity;
  /** Why this watch-out leads or trails in the strip. */
  priority: WatchOutPriority;
}

export type WatchOutPriority =
  | "held"
  | "watched"
  | "suggested"
  | "price_warning"
  | "major"
  | "other";

/** A "major" name - large/mega cap - whose red flags are market-moving enough to
 *  significant events"). Missing/Unknown cap is NOT major. */
function isMajorStock(signal: StockSignal): boolean {
  return signal.marketCapBucket === "Mega" || signal.marketCapBucket === "Large";
}


export const WATCH_OUTS_LIMIT = 8;

const PRICE_WARNING_THRESHOLD = -0.03;
const PRIORITY_ORDER: Record<WatchOutPriority, number> = {
  held: 0,
  watched: 1,
  suggested: 2,
  price_warning: 3,
  major: 4,
  other: 5,
};
const ENGAGED_INTERACTION_KINDS = new Set<InteractionKind>([
  "add_to_portfolio",
  "save_watchlist",
  "view_detail",
  "like",
]);

function buildHeldTickers(
  ownedTickers: ReadonlySet<string>,
  portfolios?: Portfolio[],
): ReadonlySet<string> {
  if (!portfolios) return ownedTickers;
  const held = new Set<string>();
  for (const portfolio of portfolios) {
    for (const holding of portfolio.holdings) held.add(holding.ticker.toUpperCase());
  }
  return held;
}

function buildEngagedTickers(interactions: InteractionEvent[]): ReadonlySet<string> {
  const tickers = new Set<string>();
  for (const event of interactions) {
    if (ENGAGED_INTERACTION_KINDS.has(event.kind)) tickers.add(event.ticker.toUpperCase());
  }
  return tickers;
}

function priorityForWatchOut(
  signal: StockSignal,
  heldTickers: ReadonlySet<string>,
  watchedTickers: ReadonlySet<string>,
  engagedTickers: ReadonlySet<string>,
): WatchOutPriority {
  const ticker = signal.ticker.toUpperCase();
  if (heldTickers.has(ticker)) return "held";
  // Interacted-with but not held: your watchlist or a group's shared watchlist.
  if (watchedTickers.has(ticker)) return "watched";
  if (engagedTickers.has(ticker)) return "suggested";
  if (signal.dayChange <= PRICE_WARNING_THRESHOLD) return "price_warning";
  if (isMajorStock(signal)) return "major";
  return "other";
}

/**
 *   1. Portfolio holdings lead.
 *   2. Names the user previously engaged with follow.
 *   3. Real red flags on names down more than the day-move threshold follow.
 *   4. Major names and other relevant red flags fill the rest.
 * Capped at a reasonable number so it's neither sparse nor a wall. Today's picks
 * aren't special-cased; their downside already lives on the tile/detail page.
 * Everything is real (deriveNegativeSignals is honest); names with nothing bad
 * are omitted.
 */
export interface BuildWatchOutsOptions {
  portfolios?: Portfolio[];
  interactions?: InteractionEvent[];
  /** Tickers on a group's shared watchlist / called by a group member (interacted-with). */
  groupTickers?: ReadonlySet<string>;
  /** Per-ticker baseline facts captured when you got involved with the name; watch-outs
   *  on these names surface only what's NEW or materially worse since. */
  baselines?: Record<string, WatchOutBaseline>;
  limit?: number;
}

export function buildWatchOuts(
  signals: StockSignal[],
  ownedTickers: ReadonlySet<string>,
  options: BuildWatchOutsOptions = {},
): WatchOutEntry[] {
  const {
    portfolios,
    interactions = [],
    groupTickers = new Set<string>(),
    baselines = {},
    limit = WATCH_OUTS_LIMIT,
  } = options;
  const seen = new Set<string>();
  const heldTickers = buildHeldTickers(ownedTickers, portfolios);
  // "Interacted, not held" = your watchlist (ownedTickers minus held) ∪ a group's
  // shared watchlist / called names. Held is checked first, so those aren't double-tiered.
  const watchedTickers = new Set<string>([...ownedTickers, ...groupTickers]);
  const engagedTickers = buildEngagedTickers(interactions);
  const entries: WatchOutEntry[] = [];
  for (const signal of signals) {
    const tkr = signal.ticker.toUpperCase();
    if (seen.has(tkr)) continue;
    seen.add(tkr);
    // Delta-aware: names you're involved with have a baseline, so only NEW/worse
    // changes surface; other names (e.g. majors) fall back to current-state.
    const negatives = deriveWatchOutSignals(signal, baselines[tkr]);
    if (negatives.length === 0) continue;
    const entry: WatchOutEntry = {
      signal,
      negatives,
      topSeverity: negatives[0].severity,
      priority: priorityForWatchOut(signal, heldTickers, watchedTickers, engagedTickers),
    };
    entries.push(entry);
  }
  const bySeverity = (a: WatchOutEntry, b: WatchOutEntry) =>
    SEVERITY_RANK[a.topSeverity] - SEVERITY_RANK[b.topSeverity];
  entries.sort((a, b) => {
    const priorityDelta = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDelta !== 0) return priorityDelta;
    const severityDelta = bySeverity(a, b);
    if (severityDelta !== 0) return severityDelta;
    if (a.priority === "major") return (b.signal.marketCap ?? 0) - (a.signal.marketCap ?? 0);
    return 0;
  });
  const heldCount = entries.filter((entry) => entry.priority === "held").length;
  return entries.slice(0, Math.max(heldCount, limit));
}
