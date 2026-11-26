import type { CompanyData, CongressTrade } from "@/types";
import { loadCongressIndex } from "@/data/congress/congressTrades";

/**
 * SCAN-PATH smart-money enrichment: attach recent congressional open-market BUYS
 * to each scored company so the bounded smart-money catalyst boost
 * (src/engine/smartMoney.ts) actually fires on the daily broad board.
 *
 * Why this exists: the broad scan (scripts/universe_scan/scan.mts) never ran the
 * per-ticker congressional lane (enrichCompanyCongress, used by the research
 * path), so `c.congressTrades` was always empty universe-wide and the boost was a
 * permanent 0 in production. This module closes that gap cheaply and safely:
 *
 *   • ONE dataset fetch. `loadCongressIndex()` pulls the keyless House Stock
 *     Watcher dump once per run and memoizes a ticker → trades Map; every company
 *     is then a pure Map lookup. No per-ticker EDGAR / Form 4 XML, no rate-limit
 *     exposure - exactly the SEC-rate-limit-safe contract smartMoney.ts requires.
 *   • SMALL & pre-aggregated. We keep only RECENT open-market BUYS (the only
 *     trades the boost rewards), newest-first, capped per company.
 *   • DEGRADES SILENTLY. A failed/empty dataset → companies returned unchanged →
 *     boost stays 0. Names with no recent buys are returned untouched.
 *
 * The pure mapping (`recentOpenMarketBuys` / `attachCongressBuys` /
 * `mapCongressBuysAcrossUniverse`) is unit-tested in isolation; the async wrapper
 * only adds the one-time fetch and never throws.
 */

const DAY_MS = 86_400_000;

/** Trailing window for "recent" buys - matches enrichCompanyCongress's LOOKBACK_DAYS. */
const DEFAULT_LOOKBACK_DAYS = 120;
/** Max buys kept per company. Small by design - the boost saturates at 4 buys. */
const DEFAULT_MAX_PER_COMPANY = 6;

export interface CongressBuyMapOptions {
  /** Reference "now" (epoch ms) for the recency window. Injectable for tests. */
  now?: number;
  /** Only buys within this many days of `now` qualify. Default 120. */
  lookbackDays?: number;
  /** Max buys kept per company (small / pre-aggregated). Default 6. */
  maxPerCompany?: number;
  /**
   * Max companies that may receive a buy attachment in one run - a scope / safety
   * valve. 0 (default) = no cap. The mapping is pure in-memory work after the one
   * fetch, so a cap is rarely needed, but it bounds the per-run blast radius when
   * desired (e.g. a smoke run).
   */
  maxCompanies?: number;
}

/**
 * The recent open-market BUYS from a ticker's disclosed trades: transaction
 * "buy", dated within `lookbackDays` of `now`, newest-first, capped to
 * `maxPerCompany`. Pure - the recency clock is injected via `opts.now`.
 */
export function recentOpenMarketBuys(
  trades: readonly CongressTrade[] | undefined,
  opts: CongressBuyMapOptions = {},
): CongressTrade[] {
  if (!trades || trades.length === 0) return [];
  const now = opts.now ?? Date.now();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const maxPerCompany = opts.maxPerCompany ?? DEFAULT_MAX_PER_COMPANY;
  const cutoff = now - lookbackDays * DAY_MS;

  return trades
    .filter((t) => t.transaction === "buy")
    .filter((t) => {
      const ms = new Date(t.transactionDate).getTime();
      return Number.isFinite(ms) && ms >= cutoff;
    })
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
    .slice(0, Math.max(0, maxPerCompany));
}

/**
 * Attach recent congressional buys to one company (immutably). Returns the SAME
 * company reference when there are no qualifying buys, so the smart-money boost
 * degrades to exactly zero for the vast majority of names and callers can detect
 * "did anything attach?" by identity.
 */
export function attachCongressBuys(
  company: CompanyData,
  trades: readonly CongressTrade[] | undefined,
  opts: CongressBuyMapOptions = {},
): CompanyData {
  const buys = recentOpenMarketBuys(trades, opts);
  if (buys.length === 0) return company;
  return { ...company, congressTrades: buys };
}

export interface CongressMapResult {
  companies: CompanyData[];
  /** How many companies received a buy attachment. */
  enrichedCount: number;
}

/**
 * Map a pre-built congress index across a universe, attaching recent buys. Pure:
 * the index is passed in (the async wrapper does the one-time fetch). Honors an
 * optional per-run cap (`maxCompanies`) on how many companies may be enriched;
 * once the cap is hit, the remaining companies pass through untouched.
 */
export function mapCongressBuysAcrossUniverse(
  companies: readonly CompanyData[],
  index: ReadonlyMap<string, CongressTrade[]>,
  opts: CongressBuyMapOptions = {},
): CongressMapResult {
  const maxCompanies = opts.maxCompanies ?? 0;
  let enrichedCount = 0;
  const out: CompanyData[] = [];

  for (const company of companies) {
    const capped = maxCompanies > 0 && enrichedCount >= maxCompanies;
    const trades = capped ? undefined : index.get(company.ticker.trim().toUpperCase());
    const next = attachCongressBuys(company, trades, opts);
    if (next !== company) enrichedCount++;
    out.push(next);
  }

  return { companies: out, enrichedCount };
}

/**
 * Scan entry point: load the congress index ONCE, then map recent buys across the
 * universe. Any failure (network, parse, empty dataset) degrades to the input
 * companies unchanged - no boost, never a throw, so the scan keeps running on its
 * modeled baseline. Not unit-tested here (it does real I/O); the pure mapping it
 * delegates to is.
 */
export async function enrichScanUniverseWithCongressBuys(
  companies: CompanyData[],
  opts: CongressBuyMapOptions = {},
): Promise<CongressMapResult> {
  if (companies.length === 0) return { companies, enrichedCount: 0 };
  try {
    const index = await loadCongressIndex();
    if (index.size === 0) return { companies, enrichedCount: 0 };
    return mapCongressBuysAcrossUniverse(companies, index, opts);
  } catch {
    return { companies, enrichedCount: 0 };
  }
}
