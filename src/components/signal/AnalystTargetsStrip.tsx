import type { StockSignal } from "@/types";
import { Link } from "react-router-dom";
import { ExternalLink } from "@/components/common/ExternalLink";
import { IconExternal } from "@/components/icons";
import {
  analystRatingTotal,
  consensusMean,
  hasDisplayableTargets,
  isStrongUpside,
  upsideVsSpot,
} from "@/lib/analystStats";
import { formatPct, formatPrice } from "@/lib/format";
import { isSampleAnalystCoverage } from "@/data/analyst/sanitizeAnalystCoverage";
import { useSampleDataMode } from "@/hooks/useSampleDataMode";

interface AnalystTargetsStripProps {
  signal: StockSignal;
}

/** Analyst targets on feed cards - beside score ring and in card body. */
export function AnalystTargetsStrip({ signal }: AnalystTargetsStripProps) {
  // Reactive sample-mode: re-renders the instant the operator's controls resolve,
  // so a card decided during the fail-closed pre-load window can't keep showing
  // seeded numbers after the mode flips to live. An imperative read here would
  // snapshot the stale pending value and never update.
  const sampleMode = useSampleDataMode();
  const coverage = signal.analyst ?? null;
  if (!hasDisplayableTargets(coverage)) return null;
  // Defense-in-depth: seeded-random sample numbers must never render outside
  // Sample data mode. The data layer already returns links_only in live mode, so
  // a sample-origin coverage here with sample mode OFF is an unexpected leak
  // (e.g. a polluted shared-cache row) - render nothing rather than relabel it as
  // a live "Estimated" target. Checks status AND sample-tagged rows.
  if (!sampleMode && isSampleAnalystCoverage(coverage)) return null;

  const spot = signal.price;
  const mean = consensusMean(coverage)!;
  const consensus = coverage?.consensus;
  const median = consensus?.median;
  const high = consensus?.high;
  const low = consensus?.low;
  const analysts = analystRatingTotal(coverage?.recommendations);
  const status = coverage?.status;
  const highlight = isStrongUpside(spot, coverage);
  // In live mode, never render a seeded "Sample consensus" row even if a coverage
  // somehow mixes real + sample rows. Sample mode keeps them (honestly labelled).
  const rows = (coverage?.rows ?? [])
    .filter((r) => r.target != null && (sampleMode || r.isSample !== true))
    .slice(0, 4);

  const statusNote =
    status === "live"
      ? "Finnhub consensus"
      : status === "aggregated"
        ? "Blended consensus"
        : status === "estimated"
          ? "Estimated from live ratings"
          : status === "sample"
            ? // status === "sample" only reaches here in Sample data mode (the
              // early return above drops it in live mode), so it is honestly
              // labelled "Sample" - never relabeled as a live "Estimated" target.
              "Sample"
            : "";

  return (
    <div className={`analyst-strip${highlight ? " analyst-strip--highlight" : ""}`}>
      <div className="analyst-strip__head">
        <span className="analyst-strip__title">
          {highlight ? "Strong analyst upside" : "Analyst price targets"}
        </span>
        <Link to={`/signal/${signal.ticker}`} className="analyst-strip__detail text-faint">
          Full analysis →
        </Link>
      </div>

      <div className="analyst-strip__consensus">
        <span className="mono" style={{ fontWeight: 700, fontSize: 16 }}>
          {formatPrice(mean)}
        </span>
        <span className="text-faint" style={{ fontSize: 11 }}>
          {status === "estimated" ? "est. mean" : "avg"}
        </span>
        {median != null && (
          <>
            <span className="text-faint">·</span>
            <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
              {formatPrice(median)}
            </span>
            <span className="text-faint" style={{ fontSize: 11 }}>
              median
            </span>
          </>
        )}
        <span className={`change ${mean >= spot ? "change--up" : "change--down"}`} style={{ fontSize: 12 }}>
          {formatPct(upsideVsSpot(spot, mean))}
        </span>
      </div>

      {(high != null || low != null || analysts > 0 || statusNote) && (
        <div className="analyst-strip__meta text-faint">
          {low != null && high != null && (
            <span>
              Range {formatPrice(low)} – {formatPrice(high)}
            </span>
          )}
          {analysts > 0 && (
            <span>
              {low != null ? " · " : ""}
              {analysts} analysts
            </span>
          )}
          {statusNote && <span> · {statusNote}</span>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="analyst-strip__links">
          {rows.map((row) => (
            <ExternalLink
              key={`${row.source}-${row.label}`}
              href={row.url}
              className="analyst-strip__chip"
              onClick={(e) => e.stopPropagation()}
              title={row.label}
            >
              {row.source}
              {row.target != null ? ` ${formatPrice(row.target)}` : ""}
              <IconExternal size={11} />
            </ExternalLink>
          ))}
        </div>
      )}
    </div>
  );
}
