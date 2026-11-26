import type { CompanyData } from "@/types";
export { harvestCatalystActiveTickers } from "./harvestCatalystTickers";
import {
  type CatalystEvent,
  dedupeEvents,
  foldCatalystEventIntoCompany,
  indexEventsByTicker,
} from "./catalystEvent";
import { fetchEdgar8KCatalystEvents } from "./edgar8kCatalysts";
import { fetchEdgar13DCatalystEvents } from "./edgar13dCatalysts";
import { fetchUsaSpendingCatalystEvents } from "./usaSpendingCatalysts";
import { fetchFdaCatalystEvents } from "./fdaCatalysts";
import { fetchNewsletterCatalystEvents } from "./newsletterCatalysts";
import {
  type InsiderAggregate,
  applyInsiderAggregateToCompany,
  fetchInsiderCatalystRollup,
} from "./insiderClusterCatalysts";
import {
  type ExecutiveItem,
  applyExecutiveSignalToCompany,
  executiveCatalystEvents,
  executiveSignalSummaries,
} from "@/data/terminal/executiveTrades";
import {
  type DiscoveredScan,
  discoveredCatalystEvents,
  discoveredExecutiveItems,
  fetchDiscoveredCatalysts,
} from "@/data/terminal/discoveredCatalysts";

/**
 * Universe-level catalyst-event enrichment - the glue that closes the pipeline
 * gap. It fetches the keyless structured catalyst sources ONCE per run and folds
 * each company's strongest event into `CompanyData.catalyst` (+ the insider
 * aggregates into `secActivity`). Lane D's `catalystStrength()` /
 * `materialSellSignal()` / `smartMoney` then weight the real events - no scoring
 * weight is touched here; we only populate the inputs.
 *
 * SOURCES (all $0, keyless except the optional Gemini-via-proxy newsletter):
 *   • SEC 8-K item events (edgar8kCatalysts)
 *   • Insider BUY clusters + material SELLS (insiderClusterCatalysts)
 *   • SC 13D/13G activist & institutional stakes (edgar13dCatalysts)
 *   • USASpending.gov federal-contract awards (usaSpendingCatalysts)
 *   • openFDA new-drug approvals (fdaCatalysts; forward PDUFA is data-blocked)
 *   • Public newsletter/RSS feeds → Gemini extract (newsletterCatalysts)
 *
 * One market-wide fetch per source, no per-ticker fan-out, degrades to the input
 * companies unchanged on any failure (so a dead source never blanks the feed).
 * Sources that need name→ticker resolution (USASpending, FDA, newsletter) are
 * anchored to the universe in hand, so no symbol we don't rank can be invented.
 */

export interface CatalystEnrichProgress {
  done: number;
  total: number;
}

export interface CatalystEnrichResult {
  companies: CompanyData[];
  /** How many companies received a folded catalyst or insider aggregate. */
  enrichedCount: number;
  /** All structured events surfaced this run (deduped) - for telemetry/feed. */
  events: CatalystEvent[];
}

export interface CatalystFoldOptions {
  /** Reference "now" (epoch ms) for recency. Injectable for tests. */
  now?: number;
  /**
   * The DISCOVERED scan from the autonomous catalyst-discovery engine
   * (research-agent `catalyst_scan`, cached in `discovered_catalysts`). Its
   * POLITICAL items extend the static executiveTrades seed (direction-aware
   * tilt); ALL its items fold into `CompanyData.catalyst` like every other
   * structured event. Absent ⇒ only the static seed + live structured sources
   * are used (the fallback). Injectable so the pure fold stays unit-testable.
   */
  discovered?: DiscoveredScan | null;
}

/**
 * PURE cross-universe fold: given pre-fetched events + insider aggregates, fold
 * them into the universe. Separated from the I/O wrapper so it is unit-testable.
 */
export function foldCatalystEventsAcrossUniverse(
  companies: readonly CompanyData[],
  events: readonly CatalystEvent[],
  aggregates: ReadonlyMap<string, InsiderAggregate>,
  opts: CatalystFoldOptions = {},
): CatalystEnrichResult {
  const now = opts.now ?? Date.now();
  const discovered = opts.discovered ?? null;
  // Executive-branch (Presidential/Congress/Fed) political signals: REAL, sourced
  // disclosures + callouts. The static executiveTrades seed is EXTENDED by the
  // discovered scan's political items (the live engine), so a freshly-discovered
  // presidential callout or congressional trade weighs in scoring automatically.
  // Favorable items fold into `catalyst` (positive "Political" events); the full
  // direction-aware summary attaches to `executiveSignal` so catalystStrength
  // (favorable) and materialSellSignal (adverse) read it.
  const extraExecItems: ExecutiveItem[] = discoveredExecutiveItems(discovered);
  const execEvents = executiveCatalystEvents(now, extraExecItems);
  const execSummaries = executiveSignalSummaries(now, extraExecItems);
  // NON-political discovered catalysts (insider buys, M&A, FDA, guidance,
  // contracts) fold into `CompanyData.catalyst` via the same event path. The
  // political ones already flow through execEvents above, so exclude them here to
  // avoid a double-count (executiveCatalystEvents handles direction/strength).
  const discoveredEvents = discoveredCatalystEvents(discovered, now).filter(
    (e) => e.catalystType !== "Political",
  );
  const deduped = dedupeEvents([...events, ...execEvents, ...discoveredEvents]);
  const byTicker = indexEventsByTicker(deduped);

  let enrichedCount = 0;
  const out: CompanyData[] = [];
  for (const company of companies) {
    const t = company.ticker.trim().toUpperCase();
    const withAgg = applyInsiderAggregateToCompany(company, aggregates.get(t));
    const withExec = applyExecutiveSignalToCompany(withAgg, execSummaries);
    const folded = foldCatalystEventIntoCompany(withExec, byTicker.get(t), { now });
    if (folded !== company) enrichedCount++;
    out.push(folded);
  }

  return { companies: out, enrichedCount, events: deduped };
}

/**
 * Fetch the keyless structured catalyst sources and fold them across the
 * universe. Any failure degrades to the input companies unchanged.
 */
export async function enrichUniverseWithCatalystEvents(
  companies: CompanyData[],
  opts: CatalystFoldOptions & { onProgress?: (p: CatalystEnrichProgress) => void } = {},
): Promise<CompanyData[]> {
  if (companies.length === 0) return companies;
  try {
    const now = opts.now ?? Date.now();
    opts.onProgress?.({ done: 0, total: companies.length });

    const [eightK, insider, thirteenD, usaSpending, fda, newsletter, discovered] = await Promise.all([
      fetchEdgar8KCatalystEvents().catch(() => [] as CatalystEvent[]),
      fetchInsiderCatalystRollup(now).catch(() => ({ events: [], aggregates: new Map() })),
      fetchEdgar13DCatalystEvents().catch(() => [] as CatalystEvent[]),
      fetchUsaSpendingCatalystEvents(companies, { now }).catch(() => [] as CatalystEvent[]),
      fetchFdaCatalystEvents(companies, { now }).catch(() => [] as CatalystEvent[]),
      fetchNewsletterCatalystEvents(companies, { now }).catch(() => [] as CatalystEvent[]),
      // DISCOVERED catalysts from the autonomous engine (cached). Degrades to null.
      fetchDiscoveredCatalysts().catch(() => null),
    ]);

    const allEvents = [
      ...eightK,
      ...insider.events,
      ...thirteenD,
      ...usaSpending,
      ...fda,
      ...newsletter,
    ];
    // Note: we do NOT early-return on an empty live-event set - the executive
    // political seed + the discovered scan (folded inside
    // foldCatalystEventsAcrossUniverse) may still attach signals, so the fold
    // must always run.

    const result = foldCatalystEventsAcrossUniverse(companies, allEvents, insider.aggregates, {
      now,
      discovered,
    });
    opts.onProgress?.({ done: companies.length, total: companies.length });
    return result.companies;
  } catch {
    return companies;
  }
}
