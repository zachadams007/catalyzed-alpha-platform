import { formatMarketCap, formatPct, formatPrice } from "@/lib/format";
import type { HeatMode } from "@/components/heatmap/colorScale";
import type { HeatTile } from "@/components/heatmap/heatmapModel";
import type { Rect } from "@/components/heatmap/treemap";

interface Props {
  tile: HeatTile;
  rect: Rect;
  mode: HeatMode;
  canvas: { w: number; h: number };
  /** Open the stock. Wired so the card's CTA is a real, clickable button. */
  onSelect: (ticker: string) => void;
}

const TIP_W = 236;

/**
 * Floating read-out for the hovered/focused tile, clamped within the canvas.
 *
 * INTERACTIVE: the card takes pointer events (CSS `pointer-events: auto` + a
 * `::before` bridge that spans the gap down to the tile) so the cursor can travel
 * onto it without crossing other tiles - moving the mouse here no longer switches
 * the hovered tile, and the "Open" button actually opens the right stock. (Was a
 * passive `pointer-events: none` tooltip: the cursor fell through to whatever tile
 * sat under the card, so the click landed on the wrong name.)
 */
export function HeatmapTooltip({ tile, rect, mode, canvas, onSelect }: Props) {
  const cx = rect.x + rect.w / 2;
  const left = Math.min(Math.max(cx - TIP_W / 2, 6), Math.max(6, canvas.w - TIP_W - 6));
  // Prefer above the tile; flip below when it would clip the top. Anchor with
  // `bottom`/`top` (not a translate) so the entrance animation's transform is
  // free to play the subtle rise without fighting a positioning transform.
  const above = rect.y > 132;
  const vstyle = above
    ? { bottom: Math.round(canvas.h - rect.y + 8) }
    : { top: Math.round(rect.y + rect.h + 8) };

  const up = tile.dayChange >= 0;

  const metrics: Array<{ key: HeatMode; label: string; value: string; tone?: string }> = [
    { key: "opportunity", label: "Opportunity", value: String(Math.round(tile.opportunity)) },
    {
      key: "day",
      label: "Day move",
      value: formatPct(tile.dayChange),
      tone: up ? "pos" : "neg",
    },
    { key: "hype", label: "Hype", value: `${Math.round(tile.hype)} · ${tile.hypeTier}` },
  ];

  return (
    <div
      className={`hm-tip ${above ? "hm-tip--above" : "hm-tip--below"}`}
      style={{ left, width: TIP_W, ...vstyle }}
      role="tooltip"
    >
      <div className="hm-tip__head">
        <span className="hm-tip__sym mono">{tile.ticker}</span>
        <span className={`hm-tip__price mono ${up ? "pos" : "neg"}`}>
          {tile.price > 0 ? formatPrice(tile.price) : "—"}
        </span>
      </div>
      <div className="hm-tip__name">{tile.name}</div>
      <div className="hm-tip__meta">
        <span className="hm-tip__sector">{tile.sector}</span>
        <span className="hm-tip__cap mono">{formatMarketCap(tile.marketCap)}</span>
      </div>
      <div className="hm-tip__metrics">
        {metrics.map((m) => (
          <div key={m.key} className={`hm-tip__metric ${m.key === mode ? "is-active" : ""}`}>
            <span className="hm-tip__metric-label">{m.label}</span>
            <span className={`hm-tip__metric-value mono ${m.tone ?? ""}`}>{m.value}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="hm-tip__cta"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(tile.ticker);
        }}
      >
        Open {tile.ticker} <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
