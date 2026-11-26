import { formatPct } from "@/lib/format";
import type { HeatStats } from "@/components/heatmap/heatmapModel";

interface Props {
  stats: HeatStats;
  /** Open a ticker (the biggest-mover cell is a live link). */
  onSelect: (ticker: string) => void;
}

/** Sign → tone class for a tinted numeric value. */
function tone(v: number): string {
  return v > 0 ? "pos" : v < 0 ? "neg" : "";
}

/**
 * The market summary tape above the map - a full-width strip of premium stats that
 * describe TODAY across the whole universe: the cap-weighted move and the dollar
 * change in total market value, breadth (advancers vs decliners) with a meter, the
 * average move, the biggest single mover (a live link), the hottest sector, and the
 * universe's scale. All derived in one pass by {@link heatStats}.
 */
export function HeatmapStats({ stats, onSelect }: Props) {
  const { advancers, decliners, unchanged } = stats;
  const breadthTotal = Math.max(1, advancers + decliners + unchanged);

  return (
    <div className="hm-stats" role="group" aria-label="Market summary">
      <div className="hm-stat hm-stat--lead">
        <span className="hm-stat__label" title="The market's overall move, with bigger companies counting more (weighted by company size).">Cap-weighted move</span>
        <span className={`hm-stat__value mono ${tone(stats.capWeightedMove)}`}>
          {formatPct(stats.capWeightedMove, 2)}
        </span>
        <span className={`hm-stat__sub mono ${tone(stats.capChangeAbs)}`}>
          {stats.capChangeLabel} today
        </span>
      </div>

      <div className="hm-stat hm-stat--breadth">
        <span className="hm-stat__label" title="How many stocks are up versus down today.">Breadth</span>
        <span className="hm-stat__value mono">
          <span className="pos">{advancers}</span>
          <span className="hm-stat__slash">/</span>
          <span className="neg">{decliners}</span>
        </span>
        <span className="hm-breadth" aria-hidden="true">
          <span className="hm-breadth__up" style={{ flexGrow: advancers / breadthTotal }} />
          <span className="hm-breadth__flat" style={{ flexGrow: unchanged / breadthTotal }} />
          <span className="hm-breadth__down" style={{ flexGrow: decliners / breadthTotal }} />
        </span>
        <span className="hm-stat__sub">
          {Math.round(stats.advancersShare * 100)}% advancing
        </span>
      </div>

      <div className="hm-stat">
        <span className="hm-stat__label" title="The simple average move across every stock, counting each one equally (regardless of company size).">Avg move</span>
        <span className={`hm-stat__value mono ${tone(stats.avgMove)}`}>
          {formatPct(stats.avgMove, 2)}
        </span>
        <span className="hm-stat__sub">every stock counts equally</span>
      </div>

      {stats.biggestMover && (
        <button
          type="button"
          className="hm-stat hm-stat--mover"
          onClick={() => onSelect(stats.biggestMover!.ticker)}
          aria-label={`Biggest mover ${stats.biggestMover.ticker}, ${formatPct(stats.biggestMover.dayChange)} — open`}
        >
          <span className="hm-stat__label">Biggest mover</span>
          <span className="hm-stat__value mono">
            <span className="hm-stat__ticker">{stats.biggestMover.ticker}</span>{" "}
            <span className={tone(stats.biggestMover.dayChange)}>
              {formatPct(stats.biggestMover.dayChange)}
            </span>
          </span>
          <span className="hm-stat__sub hm-stat__sub--name">{stats.biggestMover.name}</span>
        </button>
      )}

      {stats.hottestSector && (
        <div className="hm-stat">
          <span className="hm-stat__label">Hottest sector</span>
          <span className="hm-stat__value hm-stat__value--sector">
            {stats.hottestSector.sector}
          </span>
          <span className={`hm-stat__sub mono ${tone(stats.hottestSector.move)}`}>
            {formatPct(stats.hottestSector.move, 2)} cap-weighted
          </span>
        </div>
      )}

      <div className="hm-stat">
        <span className="hm-stat__label">Total market cap</span>
        <span className="hm-stat__value mono">{stats.totalCapLabel}</span>
        <span className="hm-stat__sub">
          {stats.companies.toLocaleString("en-US")} cos · {stats.sectors} sectors
        </span>
      </div>
    </div>
  );
}
