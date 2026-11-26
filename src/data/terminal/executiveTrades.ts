import type {
  ExecutiveSignalItem,
  ExecutiveSignalKind,
  ExecutiveSignalSummary,
} from "@/types";
import type { TerminalEvent } from "@/types/terminal";
import { clamp } from "@/lib/math";
import {
  type CatalystEvent,
  daysAwayFrom,
  eventStrength,
} from "@/data/catalysts/catalystEvent";

/**
 *
 *   • DISCLOSED TRADES - the President's open-market buys/sells from the public
 *     OGE Form 278-T Periodic Transaction Reports (the same legal filings the
 *     congress lane uses for members). A disclosed BUY is a bullish smart-money
 *     style signal.
 *   • CALLOUTS - what the President SAYS: a favorable spotlight / endorsement is
 *     bullish; an ADVERSE statement (tariff threat, probe, criticism) is BEARISH
 *     even though it is "attention". Direction is hand-set per item from the
 *     source, never inferred - "a tariff threat is bearish" is the contract.
 *
 * GROUND RULES (the #1 product rule - never fabricate a catalyst):
 *   - Every item traces to a real, dated source URL.
 *   - We add an item ONLY when a real cited source confirms it. (A 2026 search for
 *     a Trump "Rockwell Automation / ROK" callout found NO confirmation, so ROK is
 *     deliberately NOT here. Do not add it without a real source.)
 *   - This is a curated seed; the daily grounded-agent auto-refresh (roadmap) will
 *     extend it over time. It is intentionally small and high-confidence.
 *
 * THREE projections, all PURE:
 *   - {@link executiveSignalsForTicker} → `ExecutiveSignalSummary` for the
 *     StockDetail badge (favorable + adverse rolled up, signed direction).
 *   - {@link executiveCatalystEvents} → `CatalystEvent[]` for SCORING (positive
 *     items fold into `CompanyData.catalyst`; negative ones flow as adverse
 *     political pressure - see `engine/catalystStrength.ts`).
 *   - {@link executiveTradeTerminalEvents} → `TerminalEvent[]` for the wire.
 */

/** A single real executive-branch political item (trade or statement). */
export interface ExecutiveItem {
  ticker: string;
  companyName: string;
  kind: ExecutiveSignalKind;
  /** Who acted (the office-holder). */
  actor: string;
  /** ISO date (YYYY-MM-DD) the disclosure is dated / the statement was made. */
  date: string;
  /** One-line, plain-English description for the badge / wire. */
  summary: string;
  /**
   * Pre-recency materiality × magnitude, 0..1. A disclosed multi-million buy or a
   * high-profile spotlight is more material than a passing mention. Recency is the
   * ENGINE's job (it re-derives earliness from the date), so this is NOT discounted
   * for age here.
   */
  magnitude: number;
  /** Direct link to the OGE filing or the reporting on the statement. */
  sourceUrl: string;
  /** Display label for the source link. */
  sourceLabel: string;
}

/** True when an item is favorable (bullish) for the named company. */
export function isFavorable(kind: ExecutiveSignalKind): boolean {
  return kind === "buy" || kind === "favorable_callout";
}

/** True when an item is adverse (bearish) for the named company. */
export function isAdverse(kind: ExecutiveSignalKind): boolean {
  return kind === "sell" || kind === "adverse_callout";
}

/**
 * REAL, sourced executive-branch items. Each one is web-verified and dated.
 * Keep this list small + high-confidence; never add an item without a real
 * source URL and a direction read off that source.
 */
export const EXECUTIVE_ITEMS: readonly ExecutiveItem[] = [
  // --- Favorable: disclosed Q1-2026 open-market BUYS (OGE Form 278-T) ---
  {
    ticker: "NOW",
    companyName: "ServiceNow, Inc.",
    kind: "buy",
    actor: "President Trump",
    date: "2026-02-10",
    summary:
      "President Trump disclosed a $1M–$5M purchase of ServiceNow (NOW) in Q1 2026 (OGE Form 278-T).",
    magnitude: 0.62,
    sourceUrl: "https://www.cnbc.com/2026/05/15/trump-stock-trade-tech-oge.html",
    sourceLabel: "OGE Form 278-T disclosure (CNBC)",
  },
  {
    ticker: "LLY",
    companyName: "Eli Lilly and Company",
    kind: "buy",
    actor: "President Trump",
    date: "2026-02-10",
    summary:
      "President Trump disclosed a Q1 2026 purchase of Eli Lilly (LLY) (OGE Form 278-T), as his administration boosted GLP-1 access.",
    magnitude: 0.6,
    sourceUrl:
      "https://www.fool.com/investing/2026/05/27/president-trump-eli-lilly-stock-q1-glp-1-drug/",
    sourceLabel: "OGE Form 278-T disclosure (Motley Fool)",
  },
  {
    ticker: "DELL",
    companyName: "Dell Technologies Inc.",
    kind: "buy",
    actor: "President Trump",
    date: "2026-02-10",
    summary:
      "President Trump disclosed a $1M–$5M purchase of Dell (DELL) Class C on Feb 10, 2026 (OGE Form 278-T), ahead of endorsing Dell hardware in May.",
    magnitude: 0.58,
    sourceUrl: "https://www.cnbc.com/2026/05/15/trump-stock-trade-tech-oge.html",
    sourceLabel: "OGE Form 278-T disclosure (CNBC)",
  },

  // --- Favorable: public CALLOUTS / endorsements (dated statements) ---
  {
    ticker: "LLY",
    companyName: "Eli Lilly and Company",
    kind: "favorable_callout",
    actor: "President Trump",
    date: "2026-06-23",
    summary:
      'President Trump spotlighted Eli Lilly\'s "$3.5 billion investment in a brand-new, state-of-the-art manufacturing facility" at a Pennsylvania event.',
    magnitude: 0.55,
    sourceUrl:
      "https://stocktwits.com/news-articles/markets/equity/lly-trump-touts-factory-weight-loss-pill-plans-go-global/cZKUwnZR7OX",
    sourceLabel: "Presidential remarks, Macungie PA (Stocktwits)",
  },
  {
    ticker: "DELL",
    companyName: "Dell Technologies Inc.",
    kind: "favorable_callout",
    actor: "President Trump",
    date: "2026-05-08",
    summary:
      "President Trump publicly endorsed Dell hardware at a White House event on May 8, 2026.",
    magnitude: 0.45,
    sourceUrl: "https://www.cnbc.com/2026/05/15/trump-stock-trade-tech-oge.html",
    sourceLabel: "Presidential endorsement (CNBC)",
  },
  {
    ticker: "NOK",
    companyName: "Nokia Corporation",
    kind: "favorable_callout",
    actor: "President Trump",
    date: "2026-06-23",
    summary:
      'President Trump spotlighted Nokia\'s "$30 million to expand its semiconductor testing and packaging operations, thousands of jobs" at a Pennsylvania event — NOK rose ~3% the next day.',
    magnitude: 0.5,
    sourceUrl:
      "https://finance.yahoo.com/technology/ai/articles/nok-stock-rises-pre-market-081559099.html",
    sourceLabel: "Presidential spotlight → NOK rally (Yahoo Finance)",
  },

  // NOTE (2026-06-25 data-quality pass): the former ABBV + REGN "tariff-exemption
  // HOLDOUT" adverse items were REMOVED - both signed Most-Favored-Nation drug-
  // pricing deals (AbbVie 2026-01-12; Regeneron 2026-04-23, the last of 17), so
  // the "has not struck a deal / still negotiating" claims became false. Don't
  // re-add a hardcoded political claim without a CURRENT cited source; the daily
  // grounded catalyst-discovery engine is the durable source for these.
] as const;

/** Index the seed by uppercase ticker, preserving order. */
function indexByTicker(): Map<string, ExecutiveItem[]> {
  const map = new Map<string, ExecutiveItem[]>();
  for (const item of EXECUTIVE_ITEMS) {
    const t = item.ticker.trim().toUpperCase();
    const list = map.get(t) ?? [];
    list.push(item);
    map.set(t, list);
  }
  return map;
}

const BY_TICKER = indexByTicker();

/**
 * Index a merged item list (the static seed + any DISCOVERED political items from
 * the catalyst-discovery engine) by uppercase ticker. The discovered items are
 * passed in by the catalyst fold so the live engine extends the static seed
 * without this pure module ever doing I/O. Empty `extra` ⇒ the cached static index.
 */
function indexMerged(extra: readonly ExecutiveItem[]): Map<string, ExecutiveItem[]> {
  if (extra.length === 0) return BY_TICKER;
  const map = new Map<string, ExecutiveItem[]>();
  for (const item of [...EXECUTIVE_ITEMS, ...extra]) {
    const t = item.ticker.trim().toUpperCase();
    const list = map.get(t) ?? [];
    list.push(item);
    map.set(t, list);
  }
  return map;
}

/** Map an item to the badge-facing `ExecutiveSignalItem` shape. */
function toSignalItem(item: ExecutiveItem): ExecutiveSignalItem {
  return {
    kind: item.kind,
    actor: item.actor,
    summary: item.summary,
    date: item.date,
    magnitude: clamp(item.magnitude, 0, 1),
    sourceUrl: item.sourceUrl,
    sourceLabel: item.sourceLabel,
  };
}

/** Pick the highest-magnitude item from a list, or undefined. */
function strongest(items: ExecutiveItem[]): ExecutiveItem | undefined {
  let best: ExecutiveItem | undefined;
  for (const it of items) {
    if (!best || it.magnitude > best.magnitude) best = it;
  }
  return best;
}

/**
 * Direction-aware rollup for one ticker - the strongest favorable item and the
 * strongest adverse item, with a signed net `direction`. Returns null when the
 * President has no real disclosed signal for this name (the common case). Pure.
 */
export function executiveSignalsForTicker(
  ticker: string | undefined,
  index: ReadonlyMap<string, ExecutiveItem[]> = BY_TICKER,
): ExecutiveSignalSummary | null {
  if (!ticker) return null;
  const items = index.get(ticker.trim().toUpperCase());
  if (!items || items.length === 0) return null;

  const favorable = strongest(items.filter((i) => isFavorable(i.kind)));
  const adverse = strongest(items.filter((i) => isAdverse(i.kind)));

  let direction: ExecutiveSignalSummary["direction"];
  if (favorable && adverse) direction = "mixed";
  else if (favorable) direction = "bullish";
  else direction = "bearish";

  return {
    ticker: ticker.trim().toUpperCase(),
    direction,
    favorable: favorable ? toSignalItem(favorable) : undefined,
    adverse: adverse ? toSignalItem(adverse) : undefined,
  };
}

/** All tickers that carry a real executive-branch signal (for telemetry/seeding). */
export function executiveSignalTickers(): string[] {
  return [...BY_TICKER.keys()];
}

/**
 * Per-ticker `ExecutiveSignalSummary` map with `daysAway` PRE-COMPUTED on each
 * item from the injected `now`, so the scorer can read recency without a clock
 * (mirrors how `RawCatalyst.daysAway` is set in enrichment). Pure. This is the
 * scoring-facing projection; the badge path uses {@link executiveSignalsForTicker}.
 */
export function executiveSignalSummaries(
  now: number = Date.now(),
  extraItems: readonly ExecutiveItem[] = [],
): Map<string, ExecutiveSignalSummary> {
  const index = indexMerged(extraItems);
  const out = new Map<string, ExecutiveSignalSummary>();
  for (const ticker of index.keys()) {
    const summary = executiveSignalsForTicker(ticker, index);
    if (!summary) continue;
    const withRecency: ExecutiveSignalSummary = {
      ...summary,
      favorable: summary.favorable
        ? { ...summary.favorable, daysAway: daysAwayFrom(summary.favorable.date, now) }
        : undefined,
      adverse: summary.adverse
        ? { ...summary.adverse, daysAway: daysAwayFrom(summary.adverse.date, now) }
        : undefined,
    };
    out.set(ticker, withRecency);
  }
  return out;
}

/**
 * Attach the executive-branch signal to a company (pure). Returns the SAME
 * reference when the President has no real signal for this ticker, so the
 * universe fold can detect "did anything change?" by identity. Only the
 * `executiveSignal` field is set - the favorable catalyst fold is the catalyst
 * pipeline's job (executiveCatalystEvents → foldCatalystEventIntoCompany).
 */
export function applyExecutiveSignalToCompany<T extends { ticker: string; executiveSignal?: ExecutiveSignalSummary }>(
  company: T,
  summaries: ReadonlyMap<string, ExecutiveSignalSummary>,
): T {
  const summary = summaries.get(company.ticker.trim().toUpperCase());
  if (!summary) return company;
  return { ...company, executiveSignal: summary };
}

/**
 * Map the executive items to scoring `CatalystEvent`s - type "Political",
 * `negative` set for adverse items so the engine reads the SIGN. Favorable items
 * fold into `CompanyData.catalyst` (positive); adverse ones flow as political
 * pressure. Pure - the clock is injected so the daily cache stays deterministic.
 */
export function executiveCatalystEvents(
  now: number = Date.now(),
  extraItems: readonly ExecutiveItem[] = [],
): CatalystEvent[] {
  return [...EXECUTIVE_ITEMS, ...extraItems].map((item) => {
    const negative = isAdverse(item.kind);
    const daysAway = daysAwayFrom(item.date, now);
    const mag = clamp(item.magnitude, 0, 1);
    return {
      ticker: item.ticker.trim().toUpperCase(),
      catalystType: "Political",
      date: item.date,
      summary: item.summary,
      sourceUrl: item.sourceUrl,
      magnitude: mag,
      strength: eventStrength(mag, daysAway, negative),
      negative,
    } satisfies CatalystEvent;
  });
}

// --------------------------------------------------------------------------
// Terminal wire projection - direction-aware TerminalEvents.
// --------------------------------------------------------------------------

function severityForItem(item: ExecutiveItem): TerminalEvent["severity"] {
  if (item.magnitude >= 0.55) return "high";
  if (item.magnitude >= 0.4) return "elevated";
  return "watch";
}

function headlineForItem(item: ExecutiveItem): string {
  switch (item.kind) {
    case "buy":
      return `${item.actor} disclosed a buy of ${item.ticker}`;
    case "sell":
      return `${item.actor} disclosed a sale of ${item.ticker}`;
    case "favorable_callout":
      return `${item.actor} spotlighted ${item.ticker} (favorable)`;
    case "adverse_callout":
      return `${item.actor} flagged ${item.ticker} (adverse policy)`;
  }
}

/**
 * Executive items as Terminal wire events (politician_trade kind reuses the
 * existing styling). Direction-aware: favorable → buy tone, adverse → sell tone.
 */
export function executiveTradeTerminalEvents(): TerminalEvent[] {
  return EXECUTIVE_ITEMS.map((item) => {
    const favorable = isFavorable(item.kind);
    const iso = new Date(`${item.date}T00:00:00Z`).toISOString();
    return {
      id: `exec-${item.ticker}-${item.kind}-${item.date}`,
      kind: "politician_trade",
      severity: severityForItem(item),
      ticker: item.ticker.trim().toUpperCase(),
      companyName: item.companyName,
      headline: headlineForItem(item),
      summary: item.summary,
      actor: { name: item.actor, role: "Executive branch" },
      trade:
        item.kind === "buy" || item.kind === "sell"
          ? { direction: item.kind }
          : { direction: favorable ? "buy" : "sell" },
      occurredAt: iso,
      surfacedAt: iso,
      source: { name: item.sourceLabel, url: item.sourceUrl },
      reason: favorable
        ? "Favorable executive-branch signal (disclosed buy / public spotlight)."
        : "Adverse executive-branch signal (policy threat / criticism).",
    } satisfies TerminalEvent;
  });
}
