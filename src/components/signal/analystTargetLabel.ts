import type { AnalystCoverage } from "@/types";

/**
 * Honest provenance of an analyst price target as shown to the user.
 *
 *  - `analyst` - real street data from a market vendor (Finnhub / FMP / Yahoo).
 *  - `estimated` - a modeled figure derived from LIVE inputs (consensus estimated
 *                  from live Finnhub buy/hold/sell ratings via
 *                  estimateConsensusFromRatings). Strictly status === "estimated".
 *  - `sample` - the fictional demo universe's seeded-random numbers. These are
 *                  a deterministic hash of the symbol, NOT a market input, so the
 *                  data layer now only ever produces status === "sample" coverage
 *                  when Sample data mode is ON. When it is OFF, the live path
 *                  returns links_only instead (no numeric consensus), so a
 *                  status === "sample" coverage reaching the UI implies sample
 *                  mode - it is honestly labeled "Sample", never relabeled "Est."
 */
export type TargetProvenance = "analyst" | "estimated" | "sample";

/**
 * Provenance is derived from `coverage.status`, which is the canonical record of
 * where a consensus came from (`live`/`aggregated` = blended vendor data,
 * `estimated` = modeled, `sample` = demo). The per-row `origin` field is only
 * populated on a subset of rows (link rows and live per-source rows), so it is
 * not reliable for the consensus the cards actually display - status is.
 */
export function targetProvenance(
  coverage: AnalystCoverage | null | undefined,
): TargetProvenance {
  const status = coverage?.status;
  if (status === "live" || status === "aggregated") return "analyst";
  if (status === "estimated") return "estimated";
  if (status === "sample") return "sample";
  // links_only / undefined / anything else carrying no real consensus: treat as
  // a modeled estimate label (these paths render no numeric target anyway).
  return "estimated";
}

const FULL_LABEL: Record<TargetProvenance, string> = {
  analyst: "Analyst target",
  estimated: "Est. target",
  sample: "Sample target",
};

const SHORT_LABEL: Record<TargetProvenance, string> = {
  analyst: "Analyst consensus",
  estimated: "Estimated from live ratings",
  sample: "Sample",
};

/** Full provenance label for the price-target chip beside the score ring. */
export function analystTargetLabel(coverage: AnalystCoverage | null | undefined): string {
  return FULL_LABEL[targetProvenance(coverage)];
}

/** Compact provenance note for the analyst strip's meta row. */
export function analystTargetShortLabel(coverage: AnalystCoverage | null | undefined): string {
  return SHORT_LABEL[targetProvenance(coverage)];
}
