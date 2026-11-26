import type { EarningsEvent } from "./earningsCalendar";

/**
 * Pure ranking for the Terminal's upcoming-earnings pane.
 *
 * The whole-market earnings map (or the Finnhub per-ticker fallback) is intersected
 * with the names the user actually researches (scored universe ∪ watchlist), then
 * this collapses that to a compact, soonest-first list. Kept pure + deterministic
 * (today is passed in) so it's unit-testable and never reaches for the clock.
 */

/** One upcoming-earnings row, ready to render. */
export interface UpcomingEarnings {
  ticker: string;
  name: string;
  /** ISO day (YYYY-MM-DD) of the scheduled report. */
  dateISO: string;
  /** Consensus forward EPS estimate, or null when not reported. */
  epsEstimate: number | null;
  /** Whole days from today to the report (0 = today). */
  daysUntil: number;
}

/** A symbol + display name paired with its soonest earnings event. */
export interface EarningsCandidate {
  ticker: string;
  name: string;
  event: EarningsEvent;
}

/** YYYY-MM-DD slice, treated as a UTC midnight for stable day math. */
function dayMs(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

/** Whole days from `todayISO` to `dateISO`, floored at 0. */
export function daysUntil(dateISO: string, todayISO: string): number {
  const target = dayMs(dateISO);
  const today = dayMs(todayISO);
  if (!Number.isFinite(target) || !Number.isFinite(today)) return 0;
  return Math.max(0, Math.round((target - today) / 86_400_000));
}

/**
 * Filter to future-or-today events and return them soonest-first (ties broken by
 * ticker), capped to `limit`. `todayISO` is the inclusive lower bound.
 */
export function rankUpcoming(
  candidates: ReadonlyArray<EarningsCandidate>,
  todayISO: string,
  limit = 12,
): UpcomingEarnings[] {
  const today = todayISO.slice(0, 10);
  return candidates
    .map((c) => ({ ...c, day: c.event.dateISO.slice(0, 10) }))
    .filter((c) => c.day && c.day >= today)
    .sort((a, b) => a.day.localeCompare(b.day) || a.ticker.localeCompare(b.ticker))
    .slice(0, limit)
    .map((c) => ({
      ticker: c.ticker,
      name: c.name,
      dateISO: c.day,
      epsEstimate: c.event.epsEstimate,
      daysUntil: daysUntil(c.day, today),
    }));
}
