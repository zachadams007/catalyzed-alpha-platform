import type { StockSignal } from "@/types";
import { consensusMean, hasDisplayableTargets, upsideVsSpot } from "@/lib/analystStats";
import { analystTargetLabel } from "@/components/signal/analystTargetLabel";
import { formatPct, formatPrice } from "@/lib/format";

interface ScoreAnalystBadgeProps {
  signal: StockSignal;
  compact?: boolean;
}

/** Compact price-target chip beside the opportunity score ring. */
export function ScoreAnalystBadge({ signal, compact }: ScoreAnalystBadgeProps) {
  const coverage = signal.analyst;
  if (!hasDisplayableTargets(coverage)) return null;

  const spot = signal.price;
  const mean = consensusMean(coverage)!;
  const upside = upsideVsSpot(spot, mean);
  const up = upside >= 0;

  // Honest provenance - never says "Sample" to a live tester (sample mode off).
  const statusLabel = analystTargetLabel(coverage);

  if (compact) {
    return (
      <div className="score-pt score-pt--compact" title={`${statusLabel}: ${formatPrice(mean)}`}>
        <span className="score-pt__label">{statusLabel}</span>
        <span className="score-pt__value mono">{formatPrice(mean)}</span>
        <span className={`score-pt__upside ${up ? "change--up" : "change--down"}`}>{formatPct(upside)}</span>
      </div>
    );
  }

  return (
    <div className="score-pt">
      <div className="score-pt__label">{statusLabel}</div>
      <div className="score-pt__value mono">{formatPrice(mean)}</div>
      <div className={`score-pt__upside ${up ? "change--up" : "change--down"}`}>{formatPct(upside)} vs spot</div>
      {coverage?.consensus?.low != null && coverage.consensus.high != null && (
        <div className="score-pt__range text-faint">
          {formatPrice(coverage.consensus.low)} – {formatPrice(coverage.consensus.high)}
        </div>
      )}
    </div>
  );
}
