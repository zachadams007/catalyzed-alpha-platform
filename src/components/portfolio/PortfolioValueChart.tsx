import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import NumberFlow from "@number-flow/react";
import type { PortfolioHistoryResult } from "@/engine/portfolioHistory";
import type { PricePoint } from "@/types";
import { formatChartDate } from "@/lib/chart";
import { formatCurrency, formatPct, formatSignedCurrency } from "@/lib/format";

interface RangeOption {
  key: string;
  label: string;
  days: number;
}

const RANGES: ReadonlyArray<RangeOption> = [
  { key: "1W", label: "1W", days: 7 },
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 90 },
  { key: "1Y", label: "1Y", days: 365 },
  { key: "All", label: "All", days: Number.POSITIVE_INFINITY },
];

const W = 760;
const H = 300;
const PAD = { top: 18, right: 18, bottom: 30, left: 58 };

type ChartVars = CSSProperties & { "--pf-chart-x": string };

function sliceByRange(series: PricePoint[], days: number): PricePoint[] {
  if (!Number.isFinite(days)) return series;
  const last = series[series.length - 1];
  if (!last) return series;
  const cutoff = new Date(last.date).getTime() - days * 86_400_000;
  const within = series.filter((p) => new Date(p.date).getTime() >= cutoff);
  return within.length >= 2 ? within : series;
}

export function PortfolioValueChart({
  history,
  baseline,
}: {
  history: PortfolioHistoryResult;
  /** Cost-basis / invested reference line, when the book is fully tracked. */
  baseline?: number;
}) {
  const gradId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [range, setRange] = useState<string>("All");
  const [hover, setHover] = useState<number | null>(null);

  const full = history.series;
  const hasSeries = full.length >= 2;

  // Which ranges actually contain ≥2 points - others are disabled, never faked.
  const rangeEnabled = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const r of RANGES) map[r.key] = sliceByRange(full, r.days).length >= 2;
    return map;
  }, [full]);

  const series = useMemo(() => {
    const opt = RANGES.find((r) => r.key === range) ?? RANGES[RANGES.length - 1];
    return sliceByRange(full, opt.days);
  }, [full, range]);

  const sourceLabel =
    history.source === "recorded"
      ? "Daily portfolio snapshots"
      : history.source === "reconstructed"
        ? "Reconstructed from held shares & price history"
        : "Waiting for share-backed price history";

  if (!hasSeries) {
    return (
      <section className="pf-panel pf-chart" aria-labelledby="pf-chart-title">
        <div className="pf-chart__head">
          <div>
            <span className="pf-panel__title" id="pf-chart-title">
              Portfolio progression
            </span>
            <p className="pf-panel__description">{sourceLabel}</p>
          </div>
        </div>
        <div className="pf-chart__empty">
          <span className="pf-chart__empty-spark" aria-hidden />
          <p>Add share counts and refresh research to begin charting this book&rsquo;s value over time.</p>
        </div>
      </section>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const closes = series.map((p) => p.close);
  const lo = Math.min(...closes, baseline ?? Number.POSITIVE_INFINITY);
  const hi = Math.max(...closes, baseline ?? Number.NEGATIVE_INFINITY);
  const pad = (hi - lo) * 0.08 || hi * 0.04 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const span = max - min || 1;

  const xAt = (i: number) => PAD.left + (i / (series.length - 1)) * innerW;
  const yAt = (v: number) => PAD.top + innerH * (1 - (v - min) / span);

  const points = series.map((p, i) => ({ ...p, x: xAt(i), y: yAt(p.close) }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${xAt(series.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;

  const rangeStart = closes[0];
  const rangeEnd = closes[closes.length - 1];
  const up = rangeEnd >= rangeStart;
  const tone = up ? "var(--bull)" : "var(--bear)";

  const activeIdx = hover ?? series.length - 1;
  const active = points[activeIdx]!;
  const anchor = rangeStart;
  const delta = active.close - anchor;
  const deltaPct = anchor > 0 ? delta / anchor : 0;
  const deltaTone = delta > 0 ? "pl-pos" : delta < 0 ? "pl-neg" : "text-faint";

  const yTicks = [min + span * 0.12, min + span * 0.5, max - span * 0.12];
  const xTickIdx = [0, Math.floor((series.length - 1) / 2), series.length - 1];

  const baselineY = baseline != null && baseline > 0 ? yAt(baseline) : null;

  const pickIndex = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * W - PAD.left;
    const ratio = relX / innerW;
    return Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setHover((h) => Math.max(0, (h ?? series.length - 1) - 1));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setHover((h) => Math.min(series.length - 1, (h ?? series.length - 1) + 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHover(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHover(series.length - 1);
    } else if (event.key === "Escape") {
      setHover(null);
    }
  };

  const chartStyle: ChartVars = { "--pf-chart-x": `${(active.x / W) * 100}%` };

  return (
    <section className="pf-panel pf-chart" aria-labelledby="pf-chart-title">
      <div className="pf-chart__head">
        <div>
          <span className="pf-panel__title" id="pf-chart-title">
            Portfolio progression
          </span>
          <p className="pf-panel__description">{sourceLabel}</p>
        </div>
        <div className="pf-chart__readout">
          <span className="pf-chart__readout-value mono">
            <NumberFlow
              value={active.close}
              format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }}
              aria-label={formatCurrency(active.close)}
            />
          </span>
          <span className={`pf-chart__readout-delta mono ${deltaTone}`}>
            {formatSignedCurrency(delta)} <span aria-hidden>·</span> {formatPct(deltaPct)}
          </span>
          <span className="pf-chart__readout-date">{formatChartDate(active.date, "tooltip")}</span>
        </div>
      </div>

      <div className="pf-chart__ranges" role="group" aria-label="Chart range">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`pf-chart__range${range === r.key ? " is-active" : ""}`}
            aria-pressed={range === r.key}
            disabled={!rangeEnabled[r.key]}
            onClick={() => {
              setRange(r.key);
              setHover(null);
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="pf-chart__plot" style={chartStyle}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="pf-chart__svg"
          role="img"
          tabIndex={0}
          aria-label={`Portfolio value history. ${formatChartDate(active.date, "tooltip")}: ${formatCurrency(active.close)}, ${formatPct(deltaPct)} versus range start.`}
          aria-describedby={`${gradId}-hint`}
          onMouseMove={(e) => setHover(pickIndex(e.clientX))}
          onMouseLeave={() => setHover(null)}
          onTouchMove={(e) => {
            const t = e.touches[0];
            if (t) setHover(pickIndex(t.clientX));
          }}
          onTouchEnd={() => setHover(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tone} stopOpacity="0.34" />
              <stop offset="62%" stopColor={tone} stopOpacity="0.08" />
              <stop offset="100%" stopColor={tone} stopOpacity="0" />
            </linearGradient>
          </defs>

          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yAt(v)}
                y2={yAt(v)}
                className="pf-chart__grid"
              />
              <text x={PAD.left - 10} y={yAt(v) + 4} textAnchor="end" className="pf-chart__tick">
                {formatCurrency(v)}
              </text>
            </g>
          ))}

          {xTickIdx.map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
              className="pf-chart__tick"
            >
              {formatChartDate(series[i]!.date, "axis")}
            </text>
          ))}

          {baselineY != null && (
            <g>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={baselineY}
                y2={baselineY}
                className="pf-chart__baseline"
              />
              <text x={W - PAD.right} y={baselineY - 6} textAnchor="end" className="pf-chart__baseline-label">
                Cost basis {formatCurrency(baseline!)}
              </text>
            </g>
          )}

          <path d={area} fill={`url(#${gradId})`} className="pf-chart__area" key={`area-${range}`} />
          <path
            d={line}
            fill="none"
            stroke={tone}
            strokeWidth={2.4}
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
            className="pf-chart__line"
            key={`line-${range}`}
          />

          {/* Today marker (last point) */}
          <circle cx={points[points.length - 1]!.x} cy={points[points.length - 1]!.y} r={4.5} fill={tone} className="pf-chart__today" />

          {/* Scrubber */}
          <line
            x1={active.x}
            x2={active.x}
            y1={PAD.top}
            y2={PAD.top + innerH}
            className="pf-chart__crosshair"
            style={{ opacity: hover != null ? 1 : 0 }}
          />
          <circle
            cx={active.x}
            cy={active.y}
            r={5.5}
            className="pf-chart__dot"
            style={{ opacity: hover != null ? 1 : 0 }}
          />
        </svg>
      </div>

      <div className="pf-chart__foot">
        <span>
          Covers <strong className="mono">{history.coverageCount}</strong> of{" "}
          <strong className="mono">{history.holdingCount}</strong> holdings
        </span>
        <span className="pf-chart__hint" id={`${gradId}-hint`}>
          Hover, or use the left/right arrow keys, Home, and End to scrub the chart; Escape resets.
        </span>
      </div>
    </section>
  );
}
