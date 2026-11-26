import type { AnalystCoverage, StockSignal } from "@/types";

/**
 * PRIME-DIRECTIVE guard for analyst coverage - sample-origin numbers must never
 * reach a live (sample-OFF) surface.
 *
 * `sampleCoverage()` (fetchAnalystCoverage.ts) seeds illustrative consensus from
 * `seededRandom("<ticker>-pt")` - a hash of the SYMBOL, not a market input - and
 * tags it `status: "sample"` with `source: "Sample consensus"` / `isSample: true`
 * rows. That payload is the demo-mode baseline ONLY. If it is ever rendered while
 * Sample data mode is OFF, the user sees fabricated dollar targets under a green
 * "Live data" badge - the exact bug this module exists to prevent.
 *
 * Two leak paths converge here:
 *   1. The server-side scan (`scripts/universe_scan/scan.mts`) runs in Node where
 *      `isSampleDataModeEnabled()` fails closed to TRUE (no operator-controls
 *      cache), so `enrich.ts` seeds sample coverage into every published
 *      `daily_signals` row.
 *   2. A client reading that already-published cache renders the baked-in sample
 *      coverage directly (the shared-cache reader never re-enriches).
 *
 * So both the scan (before upload) and the client (on cache ingest) call
 * {@link stripSampleAnalyst} to neutralize it - the honest live empty state is
 * an absent coverage, which the client then re-enriches to links-only.
 */

/** True when this coverage is the illustrative demo baseline, not real market data. */
export function isSampleAnalystCoverage(coverage: AnalystCoverage | null | undefined): boolean {
  if (!coverage) return false;
  if (coverage.status === "sample") return true;
  // Defensive: a malformed/legacy coverage whose status was lost but whose rows
  // are still the seeded "Sample consensus" baseline must also be treated sample.
  return coverage.rows.some((r) => r.isSample === true || r.origin === "sample");
}

/**
 * Return analyst coverage safe to show in LIVE mode: `undefined` when the input
 * is sample-origin (caller re-enriches to links-only / absent), else unchanged.
 * Real coverage (live/aggregated/estimated/links_only) passes through untouched.
 */
export function stripSampleAnalyst(
  coverage: AnalystCoverage | null | undefined,
): AnalystCoverage | undefined {
  if (!coverage) return undefined;
  return isSampleAnalystCoverage(coverage) ? undefined : coverage;
}

/**
 * Sanitize a batch of signals for a LIVE-mode surface: drop any sample-origin
 * `analyst` so a polluted cache row can never render fabricated targets. Pure -
 * returns a new array; only mutates the `analyst` field of affected signals.
 *
 * Pass `sampleModeEnabled = true` to leave coverage intact (Sample data mode is a
 * legitimate place to show the illustrative baseline).
 */
export function sanitizeSignalsAnalyst(
  signals: StockSignal[],
  sampleModeEnabled: boolean,
): StockSignal[] {
  if (sampleModeEnabled) return signals;
  let changed = false;
  const out = signals.map((s) => {
    if (!isSampleAnalystCoverage(s.analyst)) return s;
    changed = true;
    return { ...s, analyst: undefined };
  });
  return changed ? out : signals;
}
