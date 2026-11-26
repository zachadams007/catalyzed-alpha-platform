/**
 * The catalyst-spark reactor - the brand glyph (bright core + diagonal light
 * cross, see `.brand__mark` in components.css) reimagined as the living engine
 * at the center of the Algorithm story. Pure DOM/SVG: transforms + opacity
 * only, no animated filters (WebView2-friendly).
 */

export type EngineCoreState = "idle" | "live" | "charged";

export function EngineCore({
  size = 220,
  state = "idle",
  className = "",
}: {
  size?: number;
  state?: EngineCoreState;
  className?: string;
}) {
  return (
    <div
      className={`engine-core engine-core--${state} ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <div className="engine-core__halo" />
      <svg className="engine-core__rings" viewBox="0 0 200 200">
        <circle
          className="engine-core__ring engine-core__ring--outer"
          cx="100"
          cy="100"
          r="92"
          fill="none"
        />
        <circle
          className="engine-core__ring engine-core__ring--mid"
          cx="100"
          cy="100"
          r="74"
          fill="none"
        />
        <circle
          className="engine-core__ring engine-core__ring--orbit"
          cx="100"
          cy="100"
          r="92"
          fill="none"
          pathLength={100}
        />
      </svg>
      <div className="engine-core__tile">
        <span className="engine-core__spark" />
        <span className="engine-core__beam" />
        <span className="engine-core__beam engine-core__beam--cross" />
      </div>
    </div>
  );
}
