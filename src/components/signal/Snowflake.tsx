import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ScoreCategory, ScoreCategoryKey, StockSignal } from "@/types";
import { scoreColors } from "@/lib/ui";
import "./company-report.css";

/** Short, radar-friendly axis labels (the full labels are too long for spokes). */
const SHORT_LABEL: Record<ScoreCategoryKey, string> = {
  inflection: "Inflection",
  conviction: "Conviction",
  catalyst: "Catalyst",
  sentimentShift: "Sentiment Δ",
  pipeline: "Pipeline",
  news: "News",
  momentum: "Momentum",
  social: "Social",
  valuation: "Value",
  volatility: "Volatility",
  fundamentals: "Quality",
  growth: "Growth",
  liquidity: "Liquidity",
};

const TAU = Math.PI * 2;

interface SnowflakeProps {
  signal: StockSignal;
  /** "card" = compact, no perimeter labels; "detail" = large, labelled. */
  variant?: "card" | "detail";
  className?: string;
}

/**
 * The Signal Snowflake - a multi-axis radar of the engine's sub-scores. Each
 * spoke is one scored dimension; the crystal blooms from the hub on mount and
 * each angular SECTOR is hoverable / focusable to read that dimension's score
 * and the engine's own plain-English explanation. Purely presentational: it
 * reads `signal.score.categories` and never recomputes a score.
 *
 * Interaction model: one transparent pie-wedge `<path>` per axis tiles the whole
 * disc (hub → rim), so every pixel maps to exactly one axis - no dead gaps, no
 * center overlap, no hover flicker. A single `activeIdx` drives all promote/dim
 * styling via a `data-active` attribute on the root; visual layers are
 * `pointer-events:none` so only the wedges receive events.
 */
export function Snowflake({ signal, variant = "detail", className }: SnowflakeProps) {
  const gradId = useId();
  const cats = signal.score.categories;
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const wedgeRefs = useRef<(SVGPathElement | null)[]>([]);
  const legendRefs = useRef<(HTMLLIElement | null)[]>([]);

  // Geometry - a fixed viewBox the SVG scales into; CSS sizes the container.
  const detail = variant === "detail";
  const N = cats.length;

  // Long names or many axes → numbered legend instead of perimeter labels.
  // (Crowded perimeter text is the #1 "AI-generated" tell.)
  const longest = useMemo(
    () => cats.reduce((m, c) => Math.max(m, SHORT_LABEL[c.key].length), 0),
    [cats],
  );
  const useLegend = N >= 7 || longest > 10;

  // viewBox + radius budget. Perimeter mode needs rim margin for two-line
  // labels; legend mode lets the disc breathe larger (text lives outside SVG).
  const VB = detail ? 300 : 168;
  const C = VB / 2;
  // Nudge the visual center up a touch so the disc + denser bottom labels
  // optically center within the chart box (perimeter mode only).
  const cy = detail && !useLegend ? C - 6 : detail ? C - 2 : C;
  const cx = C;
  const R = detail
    ? useLegend
      ? VB * 0.42
      : VB * 0.36
    : useLegend
      ? VB * 0.41
      : VB * 0.38;
  const r0 = R * 0.07; // tiny hub hole so the exact center isn't a fight

  const geom = useMemo(() => {
    const angle = (i: number) => -Math.PI / 2 + (i * TAU) / N;
    const polar = (r: number, a: number): [number, number] => [
      cx + r * Math.cos(a),
      cy + r * Math.sin(a),
    ];
    const onAxis = (i: number, frac: number): [number, number] => polar(R * frac, angle(i));
    const atScore = (i: number, score: number) =>
      onAxis(i, Math.max(0, Math.min(100, score)) / 100);
    return { angle, polar, onAxis, atScore };
  }, [N, cx, cy, R]);

  const wedges = useMemo(() => {
    const half = Math.PI / N;
    const wedge = (aStart: number, aEnd: number) => {
      const [x0o, y0o] = geom.polar(R, aStart);
      const [x1o, y1o] = geom.polar(R, aEnd);
      const [x1i, y1i] = geom.polar(r0, aEnd);
      const [x0i, y0i] = geom.polar(r0, aStart);
      // Sweep > half-circle → SVG large-arc flag. The span is always TAU/N, so a
      // raw compare is correct (the old `% TAU` made N=1's full-circle span read
      // as 0 and render a degenerate wedge). Set for N ≤ 2.
      const large = aEnd - aStart > Math.PI ? 1 : 0;
      return (
        `M${x0o} ${y0o} A${R} ${R} 0 ${large} 1 ${x1o} ${y1o}` +
        ` L${x1i} ${y1i} A${r0} ${r0} 0 ${large} 0 ${x0i} ${y0i} Z`
      );
    };
    return cats.map((_, i) => {
      const a = geom.angle(i);
      return wedge(a - half, a + half); // owns the slice centered on spoke i
    });
  }, [cats, geom, N, R, r0]);

  // Keyboard: roving focus across a metric surface in axis order. Shared by the
  // SVG wedges AND the visible legend rows so both input surfaces behave the same
  // (Arrow = step, Home/End = jump). Each handler then re-focuses the element on
  // its own surface so focus tracks the active axis.
  const navKeyTarget = useCallback((key: string, i: number): number | null => {
    switch (key) {
      case "ArrowRight":
      case "ArrowDown":
        return (i + 1) % N;
      case "ArrowLeft":
      case "ArrowUp":
        return (i - 1 + N) % N;
      case "Home":
        return 0;
      case "End":
        return N - 1;
      default:
        return null;
    }
  }, [N]);

  const onWedgeKeyDown = useCallback(
    (e: KeyboardEvent<SVGPathElement>, i: number) => {
      const next = navKeyTarget(e.key, i);
      if (next == null) return;
      e.preventDefault();
      setActiveIdx(next);
      wedgeRefs.current[next]?.focus();
    },
    [navKeyTarget],
  );

  const onLegendKeyDown = useCallback(
    (e: KeyboardEvent<HTMLLIElement>, i: number) => {
      const next = navKeyTarget(e.key, i);
      if (next == null) return;
      e.preventDefault();
      setActiveIdx(next);
      legendRefs.current[next]?.focus();
    },
    [navKeyTarget],
  );

  if (N === 0) return null;

  const band = scoreColors(signal.score.opportunityScore);
  // 3–4 quiet concentric rings; fewer on the small card.
  const rings = detail ? [0.33, 0.66, 1] : [0.5, 1];
  const polyFor = (frac: number) =>
    cats.map((_, i) => geom.onAxis(i, frac).join(",")).join(" ");
  const dataPoly = cats.map((c, i) => geom.atScore(i, c.score).join(",")).join(" ");

  const sorted = [...cats].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const low = sorted[sorted.length - 1];
  const active: ScoreCategory | null = activeIdx != null ? cats[activeIdx] : null;

  const dotR = detail ? 4 : 3.1;

  const ariaSummary = `Signal snowflake. ${cats
    .map((c) => `${SHORT_LABEL[c.key]} ${c.score}`)
    .join(", ")}.`;

  const clearActive = () => setActiveIdx(null);

  return (
    <div
      className={`snowflake snowflake--${variant} ${useLegend ? "snowflake--legend" : "snowflake--perimeter"} ${className ?? ""}`}
      data-active={activeIdx ?? -1}
      onMouseLeave={clearActive}
    >
      <div className="snowflake__chart">
        <svg
          viewBox={`0 0 ${VB} ${VB}`}
          className="snowflake__svg"
          role="img"
          aria-label={ariaSummary}
        >
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={band.a} stopOpacity={0.34} />
              <stop offset="100%" stopColor={band.b} stopOpacity={0.14} />
            </linearGradient>
          </defs>

          {/* Static grid - concentric polygon rings + spokes. */}
          <g className="snowflake__grid" aria-hidden="true">
            {rings.map((frac) => (
              <polygon key={frac} className="snowflake__ring" points={polyFor(frac)} />
            ))}
            {cats.map((c, i) => {
              const [x, y] = geom.onAxis(i, 1);
              return (
                <line
                  key={c.key}
                  className={`snowflake__spoke${activeIdx === i ? " is-active" : activeIdx != null ? " is-dim" : ""}`}
                  data-axis={i}
                  x1={cx}
                  y1={cy}
                  x2={x}
                  y2={y}
                />
              );
            })}
          </g>

          {/* Data crystal - blooms from the hub on mount (CSS). */}
          <g
            className="snowflake__data"
            style={{ filter: `drop-shadow(0 0 7px ${band.solid}66)` }}
          >
            <polygon
              className={`snowflake__poly${activeIdx != null ? " is-dim" : ""}`}
              points={dataPoly}
              fill={`url(#${gradId})`}
              stroke={band.solid}
            />
            {cats.map((c, i) => {
              const [x, y] = geom.atScore(i, c.score);
              return (
                <circle
                  key={c.key}
                  className={`snowflake__dot${activeIdx === i ? " is-active" : activeIdx != null ? " is-dim" : ""}`}
                  data-axis={i}
                  cx={x}
                  cy={y}
                  r={dotR}
                  fill={scoreColors(c.score).solid}
                  style={
                    activeIdx === i
                      ? { filter: `drop-shadow(0 0 6px ${scoreColors(c.score).solid})` }
                      : undefined
                  }
                />
              );
            })}
          </g>

          {/* Perimeter labels - two lines (name + value). Hidden in legend mode. */}
          {!useLegend && (
            <g className="snowflake__labels" aria-hidden="true">
              {cats.map((c, i) => {
                const a = geom.angle(i);
                const [lx, ly] = geom.polar(R + (detail ? 18 : 13), a);
                const cos = Math.cos(a);
                const sin = Math.sin(a);
                const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
                // Outward nudge along the axis when active (deliberate lift).
                const dx = activeIdx === i ? cos * 1.6 : 0;
                const dy = activeIdx === i ? sin * 1.6 : 0;
                return (
                  <text
                    key={c.key}
                    className={`snowflake__label${activeIdx === i ? " is-active" : activeIdx != null ? " is-dim" : ""}`}
                    data-axis={i}
                    x={lx + dx}
                    y={ly + dy}
                    textAnchor={anchor}
                  >
                    <tspan
                      className="snowflake__label-name"
                      x={lx + dx}
                      dy={sin > 0.4 ? "0" : "-0.35em"}
                    >
                      {SHORT_LABEL[c.key]}
                    </tspan>
                    <tspan className="snowflake__label-val" x={lx + dx} dy="1.05em">
                      {c.score}
                    </tspan>
                  </text>
                );
              })}
            </g>
          )}

          {/* Numbered rim pills (legend mode) - pair the spoke to its key row. */}
          {useLegend && (
            <g className="snowflake__pins" aria-hidden="true">
              {cats.map((c, i) => {
                // Pin centers sit a hair inside the rim; even with the ~7px pin
                // circle they stay honestly within the viewBox rather than
                // straddling the exact edge and relying on overflow:visible.
                const [px, py] = geom.polar(R + (detail ? 13 : 8), geom.angle(i));
                return (
                  <g
                    key={c.key}
                    className={`snowflake__pin${activeIdx === i ? " is-active" : activeIdx != null ? " is-dim" : ""}`}
                    data-axis={i}
                  >
                    <circle cx={px} cy={py} r={detail ? 8.5 : 7} className="snowflake__pin-bg" />
                    <text
                      x={px}
                      y={py}
                      className="snowflake__pin-num"
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {i + 1}
                    </text>
                  </g>
                );
              })}
            </g>
          )}

          {/* Interaction layer - transparent angular sectors, on top. Every pixel
              of the disc maps to exactly one axis. In PERIMETER mode the wedges are
              the keyboard/AT interactive surface (focusable buttons). In LEGEND
              mode the legend rows below are that surface, so here the wedges become
              a pointer-only convenience (hidden from AT and out of the tab order)
              to avoid double tab stops / redundant announcements for one dataset. */}
          <g
            className="snowflake__wedges"
            role={useLegend ? undefined : "group"}
            aria-label={useLegend ? undefined : `Signal radar, ${N} metrics`}
            aria-hidden={useLegend ? "true" : undefined}
          >
            {cats.map((c, i) => (
              <path
                key={c.key}
                ref={(el) => {
                  wedgeRefs.current[i] = el;
                }}
                className="snowflake__wedge"
                data-axis={i}
                d={wedges[i]}
                tabIndex={useLegend ? -1 : 0}
                role={useLegend ? undefined : "button"}
                aria-label={useLegend ? undefined : `${c.label}: ${c.score} of 100`}
                onMouseEnter={() => setActiveIdx(i)}
                onFocus={useLegend ? undefined : () => setActiveIdx(i)}
                onBlur={useLegend ? undefined : clearActive}
                onKeyDown={useLegend ? undefined : (e) => onWedgeKeyDown(e, i)}
              >
                {!useLegend && <title>{`${SHORT_LABEL[c.key]} · ${c.score}`}</title>}
              </path>
            ))}
          </g>
        </svg>
      </div>

      {/* Numbered legend/key (legend mode) - compact 2-column grid. In legend mode
          this IS the primary label surface, so the rows are a fully keyboard-
          operable list (roving tabindex, Arrow/Home/End) that drives the same
          activeIdx as the SVG wedges - premium interaction parity across both
          input surfaces, not hover-only. */}
      {useLegend && (
        <ul
          className="snowflake__legend"
          role="group"
          aria-label={`Signal metrics, ${N} entries`}
        >
          {cats.map((c, i) => (
            <li
              key={c.key}
              ref={(el) => {
                legendRefs.current[i] = el;
              }}
              className={`snowflake__legend-row${activeIdx === i ? " is-active" : activeIdx != null ? " is-dim" : ""}`}
              data-axis={i}
              role="button"
              tabIndex={activeIdx == null ? (i === 0 ? 0 : -1) : activeIdx === i ? 0 : -1}
              aria-label={`${c.label}: ${c.score} of 100`}
              onMouseEnter={() => setActiveIdx(i)}
              onFocus={() => setActiveIdx(i)}
              onBlur={clearActive}
              onKeyDown={(e) => onLegendKeyDown(e, i)}
            >
              <span className="snowflake__legend-num">{i + 1}</span>
              <span className="snowflake__legend-name">{SHORT_LABEL[c.key]}</span>
              <span
                className="snowflake__legend-val"
                style={{ color: scoreColors(c.score).solid }}
              >
                {c.score}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Readout - reserved space, updates on hover/focus. */}
      <div className="snowflake__readout" aria-hidden="true">
        {active ? (
          <>
            <span
              className="snowflake__readout-cat"
              style={{ color: scoreColors(active.score).solid }}
            >
              {SHORT_LABEL[active.key]} · {active.score}
            </span>
            <span className="snowflake__readout-exp">{active.explanation}</span>
          </>
        ) : (
          <>
            <span className="snowflake__readout-pair">
              <span className="snowflake__readout-k">Strongest</span>
              <span style={{ color: scoreColors(top.score).solid }}>
                {SHORT_LABEL[top.key]} {top.score}
              </span>
            </span>
            <span className="snowflake__readout-sep" aria-hidden>
              ·
            </span>
            <span className="snowflake__readout-pair">
              <span className="snowflake__readout-k">Weakest</span>
              <span style={{ color: scoreColors(low.score).solid }}>
                {SHORT_LABEL[low.key]} {low.score}
              </span>
            </span>
          </>
        )}
      </div>

      {/* Full data, always available to assistive tech. */}
      <ul className="sr-only">
        {cats.map((c) => (
          <li key={c.key}>{`${c.label}: ${c.score} of 100. ${c.explanation}`}</li>
        ))}
      </ul>
    </div>
  );
}
