import type { CompanyData } from "@/types";
import {
  fetchEarningsCalendarMap,
  fetchFinnhubEarningsCalendarMap,
  fetchFinnhubNextEarnings,
  isEarningsCalendarConfigured,
  type EarningsEvent,
} from "./earningsCalendar";
import { isFmpConfigured } from "@/data/http";
import { peekApiAllowed } from "@/lib/apiUsage";
import { isRealCatalyst } from "@/data/catalysts/catalystState";

/**
 * Earnings-date countdown lane (challenger only) - wires the next scheduled
 * earnings into `catalyst.daysAway` so the deterministic catalyst scorer rewards
 * proximity, and attaches the consensus EPS estimate (snapshotted downstream for
 * estimate-revision momentum). This is the "see it before the move" lever.
 *
 * COVERAGE FIX (2026-07-02): a forward earnings date is itself a REAL, dated
 * catalyst - most names in the universe have one within a quarter, and the
 * scorer already scales the score by `daysAway` (far-out ⇒ modest, imminent ⇒
 * strong), so gating adoption tightly just starves the catalyst dimension for
 * ~95% of names (few top picks carried a structured catalyst pre-fix).
 * The rule now: earnings WIRES IN whenever it's within the horizon, UNLESS a
 * REAL (not modeled/placeholder) catalyst is genuinely CLOSER - a closer real
 * event keeps precedence, and earnings still populates `nextEarnings` for
 * display either way.
 */

const DAY_MS = 86_400_000;
/** How far ahead the lane looks for the next earnings (covers a quarter). */
const LANE_HORIZON_DAYS = 90;
/** Only within this window does earnings take the catalyst slot (matches the
 *  catalyst scorer's timing band, scaleBand(daysAway, 3, 45)). */
export const EARNINGS_CATALYST_HORIZON_DAYS = 45;
/** Baseline magnitude for a scheduled-earnings catalyst (a real, dated mover). */
export const EARNINGS_BASE_MAGNITUDE = 0.5;
/** Sequential gap for the per-ticker Finnhub fallback: ~1 call/sec keeps it
 *  inside Finnhub's 60-calls/min free tier (see API_VENDORS in lib/apiUsage). */
const GAP_MS = 1100;
/** Finnhub endpoint used only to PEEK the budget gate (no call is recorded). */
const FINNHUB_EARNINGS_URL = "https://finnhub.io/api/v1/calendar/earnings";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface EarningsEnrichProgress {
  done: number;
  total: number;
  ticker?: string;
}

/**
 * Merge a real upcoming earnings event into a company. PURE: company + event +
 * precomputed `daysAway` in, new company out. Always attaches `nextEarnings`.
 *
 * Adopts the catalyst slot whenever the earnings date is within the horizon
 * (`0 <= daysAway <= EARNINGS_CATALYST_HORIZON_DAYS`) - UNLESS the company
 * already carries a REAL catalyst (see `isRealCatalyst`, i.e. a genuine
 * structured event, not a modeled placeholder) that is strictly CLOSER. A
 * closer real event keeps precedence over the earnings date; a further-out
 * (or absent, or modeled) one loses the slot to earnings.
 */
export function applyEarningsToCompany(
  company: CompanyData,
  event: EarningsEvent,
  daysAway: number,
): CompanyData {
  const nextEarnings = { dateISO: event.dateISO, daysAway, epsEstimate: event.epsEstimate };
  const cat = company.catalyst;
  const withinHorizon = daysAway >= 0 && daysAway <= EARNINGS_CATALYST_HORIZON_DAYS;
  const closerRealCatalystExists =
    isRealCatalyst(cat, company.catalystLive) && cat.daysAway < daysAway;
  const adopt = withinHorizon && !closerRealCatalystExists;

  if (!adopt) return { ...company, nextEarnings };

  const epsNote = event.epsEstimate != null ? ` (consensus EPS ${event.epsEstimate})` : "";
  return {
    ...company,
    nextEarnings,
    catalystLive: true,
    catalyst: {
      ...cat,
      type: "Earnings",
      daysAway,
      magnitude: Math.max(cat.magnitude, EARNINGS_BASE_MAGNITUDE),
      description: `Scheduled earnings on ${event.dateISO}${epsNote}`,
    },
  };
}

/**
 * Enrich the universe with next-earnings dates + consensus EPS. FMP-first (one
 * bulk call for the whole market), Finnhub per-ticker fallback. Returns the
 * universe unchanged when no earnings transport is configured. Pure scoring stays
 * downstream - this lane only improves the raw catalyst data.
 */
export async function enrichUniverseWithEarnings(
  companies: CompanyData[],
  onProgress?: (p: EarningsEnrichProgress) => void,
  now: Date = new Date(),
): Promise<CompanyData[]> {
  if (companies.length === 0 || !isEarningsCalendarConfigured()) return companies;

  const todayMs = Date.parse(ymd(now.getTime()));
  const fromISO = ymd(todayMs);
  const toISO = ymd(todayMs + LANE_HORIZON_DAYS * DAY_MS);
  const total = companies.length;

  const daysAwayOf = (event: EarningsEvent): number =>
    Math.max(0, Math.round((Date.parse(event.dateISO) - todayMs) / DAY_MS));

  // BULK path: FMP (one call) merged with Finnhub (one call per two-week chunk),
  // then a pure map over the universe - zero per-name cost. The two are merged,
  // soonest date per symbol, because neither is complete on its own: the FMP
  // free plan returns a few dozen rows, and Finnhub is the one that actually
  // carries the market. This used to STOP after FMP whenever an FMP key was
  // configured, which is how the daily scan published "0 earnings" catalysts
  // for 500 names right through Q2 earnings season (2026-07-29: Amazon, Meta
  // and Microsoft all reported within two days and none carried a date).
  const calendar = isFmpConfigured()
    ? await fetchEarningsCalendarMap(fromISO, toISO)
    : new Map<string, EarningsEvent>();
  const finnhubBulk = await fetchFinnhubEarningsCalendarMap(fromISO, toISO);
  for (const [symbol, event] of finnhubBulk) {
    const existing = calendar.get(symbol);
    if (!existing || event.dateISO < existing.dateISO) calendar.set(symbol, event);
  }
  if (calendar.size > 0) {
    const out = companies.map((company) => {
      const event = calendar.get(company.ticker.trim().toUpperCase());
      return event ? applyEarningsToCompany(company, event, daysAwayOf(event)) : company;
    });
    onProgress?.({ done: total, total });
    return out;
  }

  // Finnhub per-ticker last resort (both bulk calls came back empty): sequential
  // with a rate-limit gap. Stop early
  // once the budget gate closes (daily quota spent / paused) so we don't spin
  // through guaranteed-rejected calls + their delays - the remaining names just
  // keep no earnings (same as a null result), so the universe stays intact.
  const out: CompanyData[] = [];
  for (let i = 0; i < companies.length; i++) {
    if (!peekApiAllowed(FINNHUB_EARNINGS_URL).allowed) {
      out.push(...companies.slice(i));
      break;
    }
    const company = companies[i]!;
    const event = await fetchFinnhubNextEarnings(company.ticker, fromISO, toISO);
    out.push(event ? applyEarningsToCompany(company, event, daysAwayOf(event)) : company);
    onProgress?.({ done: i + 1, total, ticker: company.ticker });
    if (i < companies.length - 1) await delay(GAP_MS);
  }
  return out;
}
