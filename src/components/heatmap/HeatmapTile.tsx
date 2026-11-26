import { memo } from "react";
import { formatMarketCap, formatPct } from "@/lib/format";
import { readableInk, tileColor, type HeatMode, type HypeDomain } from "@/components/heatmap/colorScale";
import { metricText, type HeatTile as HeatTileData } from "@/components/heatmap/heatmapModel";
import type { Rect } from "@/components/heatmap/treemap";

interface Props {
  tile: HeatTileData;
  rect: Rect;
  mode: HeatMode;
  index: number;
  active: boolean;
  /** Contrast-stretch window for hype coloring (stable reference for memo). */
  hypeDomain: HypeDomain;
}

const GAP = 1.5;

/**
 * One treemap cell. Memoized so the ~300–500-tile grid doesn't re-render on
 * hover (handled by delegation on the canvas) - only a mode change, a relayout,
 * or this tile gaining/losing the roving focus rebuilds it.
 */
function HeatmapTileImpl({ tile, rect, mode, index, active, hypeDomain }: Props) {
  const color = tileColor(mode, tile, hypeDomain);
  const ink = readableInk(color);
  const w = Math.max(0, rect.w - GAP);
  const h = Math.max(0, rect.h - GAP);
  const showTicker = w >= 34 && h >= 18;
  const showMetric = w >= 50 && h >= 36;

  // Full read-out for assistive tech (the visual tooltip is pointer/AT-orphaned
  // otherwise) - sector, cap, and all three metrics announced on focus.
  const label =
    `${tile.ticker} ${tile.name}, ${tile.sector}, market cap ${formatMarketCap(tile.marketCap)}, ` +
    `opportunity ${Math.round(tile.opportunity)}, day ${formatPct(tile.dayChange)}, ` +
    `hype ${Math.round(tile.hype)} ${tile.hypeTier}`;

  return (
    <button
      type="button"
      data-i={index}
      data-ticker={tile.ticker}
      tabIndex={active ? 0 : -1}
      className="hm-tile"
      aria-label={label}
      style={{
        left: rect.x + GAP / 2,
        top: rect.y + GAP / 2,
        width: w,
        height: h,
        background: color,
        color: ink,
      }}
    >
      {showTicker && (
        <span className="hm-tile__sym mono" style={{ fontSize: Math.min(15, Math.max(9, w / 5.2)) }}>
          {tile.ticker}
        </span>
      )}
      {showMetric && <span className="hm-tile__val mono">{metricText(mode, tile)}</span>}
    </button>
  );
}

export const HeatmapTile = memo(HeatmapTileImpl);
