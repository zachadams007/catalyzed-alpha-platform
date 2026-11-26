/**
 * Daily research cadence.
 *
 * The research engine refreshes the Today / For You feed once per "research
 * day": the first time the app is opened after the daily boundary hour. Opening
 * the app again later the same day reuses the cached run for free - no API
 * quota is spent. Pressing **Scan the Market** always forces a fresh run.
 *
 * The boundary hour is configurable via `VITE_RESEARCH_RUN_HOUR` (local time)
 * and defaults to 08:00 - a pre-market refresh so the feed is ready for the
 * open. This is a soft, app-open-triggered cadence; a true background run while
 * the app is closed needs an OS scheduler / Tauri autostart (see roadmap).
 */
export const RESEARCH_RUN_HOUR: number = (() => {
  const raw = Number(import.meta.env.VITE_RESEARCH_RUN_HOUR ?? 8);
  return Number.isFinite(raw) && raw >= 0 && raw <= 23 ? Math.floor(raw) : 8;
})();

/**
 * The most recent daily research boundary, as an epoch-ms timestamp: today at
 * {@link RESEARCH_RUN_HOUR} local time, or yesterday at that hour if the app is
 * opened before the boundary has passed today. A run that finished on/after
 * this instant is considered current for the day.
 */
export function lastResearchBoundary(now: Date = new Date()): number {
  const boundary = new Date(now);
  boundary.setHours(RESEARCH_RUN_HOUR, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) {
    // Today's boundary hasn't arrived yet - the active window opened yesterday.
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary.getTime();
}

/**
 * True when a research run finished after the most recent daily boundary - i.e.
 * the cached signals are current for today, so reopening the app need not
 * re-run research (and must not spend API quota).
 */
export function isResearchFreshForToday(
  finishedAtIso: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!finishedAtIso) return false;
  const finished = Date.parse(finishedAtIso);
  if (!Number.isFinite(finished)) return false;
  return finished >= lastResearchBoundary(now);
}
