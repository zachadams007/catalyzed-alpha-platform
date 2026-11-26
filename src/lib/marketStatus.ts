/**
 * US equity market session + quote-freshness helpers - the honest gate behind the
 * live-price overlay.
 *
 * The overlay fetches an Alpaca snapshot whenever a view opens - including
 * overnight, pre-market, and weekends - and Alpaca happily returns the LAST
 * session's print. Without this gate a frozen prior-session price renders under a
 * green "Live" badge with a colored day-change, implying a freshness it doesn't
 * have. (That is exactly the "looks like +5% but the market was closed" case.)
 * These functions let the UI label closed-market data honestly - "Markets closed ·
 * at close" - instead of asserting "Live".
 *
 * Pure + timezone-correct via {@link Intl.DateTimeFormat} (handles EST/EDT
 * automatically). Market holidays are intentionally NOT encoded: on a holiday
 * {@link isUsMarketOpen} can read "open" during 9:30–16:00 ET, but
 * {@link quoteIsFresh} backstops it - with no fresh trades the snapshot `asOf` is
 * the prior session, so the quote is still correctly flagged stale.
 */

const ET_TZ = "America/New_York";

interface EtClock {
  /** 0 = Sunday … 6 = Saturday, in ET. */
  weekday: number;
  /** Minutes since ET midnight. */
  minutes: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Project an instant onto the ET wall clock (weekday + minutes since midnight). */
function etClock(now: Date): EtClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[get("weekday")] ?? 1;
  let hour = Number(get("hour"));
  // Some engines emit "24" for the midnight hour under hour12:false - normalize.
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  const minute = Number(get("minute")) || 0;
  return { weekday, minutes: hour * 60 + minute };
}

const OPEN_MIN = 9 * 60 + 30; // 9:30 ET
const CLOSE_MIN = 16 * 60; // 16:00 ET
const PREMARKET_MIN = 4 * 60; // 4:00 ET
const AFTERHOURS_END_MIN = 20 * 60; // 20:00 ET

export type MarketSession = "open" | "premarket" | "afterhours" | "closed";

/** Which US-equity session is live right now (regular / pre / after / closed). */
export function marketSession(now: Date = new Date()): MarketSession {
  const { weekday, minutes } = etClock(now);
  if (weekday === 0 || weekday === 6) return "closed";
  if (minutes < OPEN_MIN) return minutes >= PREMARKET_MIN ? "premarket" : "closed";
  if (minutes >= CLOSE_MIN) return minutes < AFTERHOURS_END_MIN ? "afterhours" : "closed";
  return "open";
}

/** True only during the regular cash session (9:30–16:00 ET, Mon–Fri). */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  return marketSession(now) === "open";
}

/** Staleness tolerated during regular hours before a quote stops reading "live". */
const FRESH_MS = 15 * 60 * 1000;

/**
 * A live overlay quote is trustworthy-as-current only when the regular session is
 * open AND its data timestamp is recent. Outside that window the UI must label it a
 * prior-session ("at close") figure, never "live".
 */
export function quoteIsFresh(asOfISO: string | null | undefined, now: Date = new Date()): boolean {
  if (!isUsMarketOpen(now)) return false;
  if (!asOfISO) return false;
  const t = Date.parse(asOfISO);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= FRESH_MS;
}

const SESSION_LABEL: Record<MarketSession, string> = {
  open: "Live IEX",
  premarket: "Pre-market",
  afterhours: "After hours",
  closed: "Markets closed",
};

/** Short human label for a session, used on the live-price badge. */
export function sessionLabel(session: MarketSession): string {
  return SESSION_LABEL[session];
}
