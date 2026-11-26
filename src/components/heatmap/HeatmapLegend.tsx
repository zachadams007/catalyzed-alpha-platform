import { legendForMode, rampGradientCss, type HeatMode } from "@/components/heatmap/colorScale";

interface Props {
  mode: HeatMode;
}

/** Low/high end-cap words for the active scale. */
const CAPS: Record<HeatMode, [string, string]> = {
  day: ["−5%", "+5%"],
  opportunity: ["Weak", "Exceptional"],
  hype: ["Cooler", "Hotter"],
};

/**
 * Color key for the active mode - a continuous gradient scale bar (reads as a real
 * scale, not a row of chips) + the constant "size = market cap" reminder. Day is
 * diverging, so it carries a neutral center notch.
 */
export function HeatmapLegend({ mode }: Props) {
  const [low, high] = CAPS[mode];
  const swatches = legendForMode(mode);
  const scaleLabel = `Color scale, ${low} to ${high}: ${swatches.map((s) => s.label).join(", ")}`;

  return (
    <div className="hm-legend">
      <div className="hm-legend__scale" role="img" aria-label={scaleLabel}>
        <span className="hm-legend__cap" aria-hidden="true">
          {low}
        </span>
        <span
          className={`hm-legend__bar${mode === "day" ? " hm-legend__bar--diverging" : ""}`}
          style={{ background: rampGradientCss(mode) }}
          aria-hidden="true"
        />
        <span className="hm-legend__cap" aria-hidden="true">
          {high}
        </span>
      </div>
      <span className="hm-legend__size">
        <span className="hm-legend__size-mark" aria-hidden="true" />
        Tile size = market cap
      </span>
    </div>
  );
}
