import { useCallback, useId, useRef, useState } from "react";
import type { PricePoint } from "@/types";
import { formatChartDate } from "@/lib/chart";
import { formatPrice } from "@/lib/format";

interface InteractivePriceChartProps {
  series: PricePoint[];
  width?: number;
  height?: number;
  valueFormatter?: (value: number) => string;
  emptyLabel?: string;
  hint?: string;
  ariaLabel?: string;
}

const PAD = { top: 14, right: 14, bottom: 32, left: 52 };

/**
 * Hoverable price chart with time axis, price axis, crosshair, and tooltip.
 */
export function InteractivePriceChart({
  series,
  width = 560,
  height = 240,
  valueFormatter = formatPrice,
  emptyLabel = "Not enough price history to chart.",
  hint = "Move cursor over chart",
  ariaLabel = "Interactive price history chart",
}: InteractivePriceChartProps) {
  const gradId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  if (series.length < 2) {
    return <p className="text-faint">{emptyLabel}</p>;
  }

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const closes = series.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;

  const xAt = (i: number) => PAD.left + (i / (series.length - 1)) * innerW;
  const yAt = (v: number) => PAD.top + innerH * (1 - (v - min) / range);

  const points = series.map((p, i) => ({ ...p, x: xAt(i), y: yAt(p.close) }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${xAt(series.length - 1)},${PAD.top + innerH} L${xAt(0)},${PAD.top + innerH} Z`;

  const up = closes[closes.length - 1] >= closes[0];
  const lineColor = up ? "var(--bull)" : "var(--bear)";

  const yTicks = [min, min + range * 0.5, max];
  const xTickIdx = [0, Math.floor((series.length - 1) / 2), series.length - 1];

  const pickIndex = useCallback(
    (clientX: number) => {
      const svg = svgRef.current;
      if (!svg) return 0;
      const rect = svg.getBoundingClientRect();
      const relX = ((clientX - rect.left) / rect.width) * width;
      const innerX = relX - PAD.left;
      const ratio = innerX / innerW;
      return Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1))));
    },
    [innerW, series.length, width],
  );

  const onPointer = (clientX: number, clientY: number) => {
    const idx = pickIndex(clientX);
    const pt = points[idx];
    if (!pt) return;
    setHover({ index: idx, x: pt.x, y: pt.y });
  };

  const active = hover != null ? points[hover.index] : points[points.length - 1];
  const activeIdx = hover?.index ?? points.length - 1;

  return (
    <div className="interactive-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        className="interactive-chart__svg"
        aria-label={ariaLabel}
        style={{ aspectRatio: `${width} / ${height}` }}
        onMouseMove={(e) => onPointer(e.clientX, e.clientY)}
        onMouseLeave={() => setHover(null)}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (t) onPointer(t.clientX, t.clientY);
        }}
        onTouchEnd={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((v) => {
          const y = yAt(v);
          return (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="4 4"
              />
              <text x={PAD.left - 8} y={y + 4} textAnchor="end" className="interactive-chart__tick">
                {valueFormatter(v)}
              </text>
            </g>
          );
        })}

        {xTickIdx.map((i) => (
          <text
            key={i}
            x={xAt(i)}
            y={height - 8}
            textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
            className="interactive-chart__tick"
          >
            {formatChartDate(series[i]!.date, "axis")}
          </text>
        ))}

        <path d={area} fill={`url(#${gradId})`} />
        <path d={line} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {hover && (
          <>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke="var(--accent)"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.85}
            />
            <circle cx={hover.x} cy={hover.y} r={5} fill="var(--accent)" stroke="var(--bg)" strokeWidth={2} />
          </>
        )}
      </svg>

      <div
        className="interactive-chart__tooltip"
        style={{
          left: `${(active!.x / width) * 100}%`,
          transform: activeIdx > series.length * 0.65 ? "translate(-100%, 0)" : "translate(0, 0)",
        }}
      >
        <div className="interactive-chart__tooltip-date">{formatChartDate(active!.date, "tooltip")}</div>
        <div className="interactive-chart__tooltip-price mono">{valueFormatter(active!.close)}</div>
        {hover == null && <div className="interactive-chart__tooltip-hint text-faint">{hint}</div>}
      </div>
    </div>
  );
}
