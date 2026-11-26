import {
  isLiveDataActive,
  isProviderResolutionPending,
  isSampleDataModeEnabled,
} from "@/data/providers";

/**
 * Compact, always-visible data-provenance pill for the global TopBar.
 *
 * Testers must be able to tell at a glance whether the names on screen are real
 * market data or the fictional sample universe - sample mode is no longer the
 * default on the hosted build, so the cue can't live only on Blueprint. Mirrors
 * the `.pill` pattern (azure = live, gold = sample) and drives its colour with a
 * token so it never hardcodes hex or drifts to the forbidden green.
 */
export function DataModePill() {
  // While the GLOBAL operator controls are still resolving we don't yet know the
  // live/sample choice - show a neutral "Connecting…" cue, NEVER a Live badge and
  // never "Sample data" (the screen is a skeleton, not the fictional universe).
  const pending = isProviderResolutionPending();
  const live = !pending && isLiveDataActive();
  const sample = !pending && isSampleDataModeEnabled();

  const tone = pending
    ? "var(--faint)"
    : live
      ? "var(--accent)"
      : sample
        ? "var(--warn)"
        : "var(--faint)";
  const text = pending ? "Connecting…" : live ? "Live data" : sample ? "Sample data" : "No live data";
  const title = pending
    ? "Loading live-data settings — the board will fill in once the operator controls resolve."
    : live
      ? "Live market data — the scan screens real US-listed securities."
      : sample
        ? "Sample data mode — a fictional demo universe; no live API calls fire."
        : "No live data source is configured for this build.";

  return (
    <span
      className="pill data-mode-pill"
      style={{ color: tone, marginLeft: 4 }}
      title={title}
      role="status"
    >
      <span className="pill__dot" />
      {text}
    </span>
  );
}
