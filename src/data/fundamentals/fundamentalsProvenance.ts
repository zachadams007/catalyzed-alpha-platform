import type { RawFundamentals } from "@/types";

/**
 * Honest-fundamentals provenance helpers - the single source of truth for the
 * invariant the owner's prime directive turns on:
 *
 *   `fundamentalsAvailability[X] === true`  IFF  `fundamentals.X` came from a
 *   real provider, fresh, THIS run - never a modeled/seeded/stale value.
 *
 * A live-quoted record starts with NOTHING real about its fundamentals: every
 * field is a neutral placeholder (`0` / `null`) gated OFF by an all-false
 * availability map, so the UI reads "N/A" rather than presenting the old
 * synthetic PRNG seed (the SOFI "Unprofitable −19.8% net margin" bug) as fact.
 * Real values + a freshness-checked as-of stamp are layered on later by the
 * fundamentals-enrichment stage.
 */

/** Every fundamentals field, for exhaustive availability-map construction. */
export const FUNDAMENTAL_KEYS: ReadonlyArray<keyof RawFundamentals> = [
  "revenueGrowthYoY",
  "epsGrowthYoY",
  "grossMargin",
  "netMargin",
  "peRatio",
  "pegRatio",
  "debtToEquity",
  "fcfMargin",
];

/**
 * Neutral placeholder fundamentals for a live record with no real values yet.
 * Numbers are inert zeros and the nullable ratios are null; NONE of these is
 * ever shown, because {@link allFalseFundamentalsAvailability} gates them all
 * off until a real provider value (with a fresh as-of) replaces them.
 */
export function unknownFundamentals(): RawFundamentals {
  return {
    revenueGrowthYoY: 0,
    epsGrowthYoY: 0,
    grossMargin: 0,
    netMargin: 0,
    peRatio: null,
    pegRatio: null,
    debtToEquity: 0,
    fcfMargin: 0,
  };
}

/** Availability map with every fundamentals field explicitly unavailable. */
export function allFalseFundamentalsAvailability(): Record<keyof RawFundamentals, boolean> {
  return {
    revenueGrowthYoY: false,
    epsGrowthYoY: false,
    grossMargin: false,
    netMargin: false,
    peRatio: false,
    pegRatio: false,
    debtToEquity: false,
    fcfMargin: false,
  };
}

/**
 * True when at least one fundamentals field is flagged available. Used by the
 * pre-publish invariant: a record that exposes an `available === true`
 * fundamental MUST also carry a freshness-checked as-of stamp.
 */
export function hasAnyAvailableFundamental(
  availability: Partial<Record<keyof RawFundamentals, boolean>> | undefined,
): boolean {
  if (!availability) return false;
  return FUNDAMENTAL_KEYS.some((k) => availability[k] === true);
}

/**
 * Default freshness window (days) for live fundamentals. Finnhub free
 * `metric=all` TTM/annual figures lag 1–2+ quarters; a value whose reporting
 * period is older than this is treated as STALE → unavailable, so a long-stale
 * figure (e.g. SOFI's pre-profitability margin) can never read as current.
 *
 * 135 days ≈ ONE fiscal quarter plus its ~45-day reporting lag - old enough to keep the
 * most-recently-reported quarter through its whole life, but tight enough to reject a
 * 6-month-old figure that's already been priced in. Fail-closed: if the only fundamentals we
 * have are older than this, the watch-out simply doesn't fire (better silent than stale).
 */
export const FUNDAMENTALS_FRESHNESS_DAYS = 135;

/**
 * Parse a fundamentals as-of stamp (ISO date, "YYYY-MM", or fiscal-period label
 * like "TTM 2025-Q3") to epoch ms, or null when undatable. Quarter labels map
 * to the quarter-END month so a freshness check is conservative-but-fair.
 */
export function parseAsOfMs(asOf: string | undefined | null): number | null {
  if (!asOf) return null;
  const s = asOf.trim();
  if (!s) return null;

  // Fiscal quarter: "...2025-Q3" / "...2025Q3" → quarter-end date.
  const q = s.match(/(\d{4})[ -]?Q([1-4])/i);
  if (q) {
    const year = Number(q[1]);
    const quarter = Number(q[2]);
    const monthEnd = quarter * 3; // Q1→Mar, Q2→Jun, Q3→Sep, Q4→Dec
    const t = Date.UTC(year, monthEnd, 0); // day 0 of next month = last day of monthEnd
    return Number.isNaN(t) ? null : t;
  }

  // ISO date or YYYY-MM (Date treats the latter as the 1st of that month).
  const isoMatch = s.match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]) - 1;
    const day = isoMatch[3] ? Number(isoMatch[3]) : 1;
    const t = Date.UTC(year, month, day);
    return Number.isNaN(t) ? null : t;
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True when an as-of stamp is present AND within the freshness window relative
 * to `now`. Undatable (no stamp / unparseable) is NOT fresh - we refuse to
 * present an undated provider figure as current.
 */
export function isFundamentalsFresh(
  asOf: string | undefined | null,
  now: number = Date.now(),
  windowDays: number = FUNDAMENTALS_FRESHNESS_DAYS,
): boolean {
  const ms = parseAsOfMs(asOf);
  if (ms == null) return false;
  const ageDays = (now - ms) / 86_400_000;
  // Reject future-dated stamps (data error) and anything past the window.
  return ageDays >= 0 && ageDays <= windowDays;
}

/**
 * Short human "as of" qualifier for a fundamentals figure, e.g. " (TTM as of
 * 2025-09)". Empty string when there's no datable stamp, so callers can append
 * unconditionally.
 */
export function asOfQualifier(asOf: string | undefined | null): string {
  if (!asOf) return "";
  const s = asOf.trim();
  if (!s) return "";
  // Already carries a label (TTM/FY/Q…) - show verbatim.
  if (/[a-z]/i.test(s)) return ` (as of ${s})`;
  // Bare ISO date → trim to year-month for a tidy "as of 2025-09".
  const ym = s.match(/^(\d{4}-\d{2})/);
  return ` (TTM as of ${ym ? ym[1] : s})`;
}
