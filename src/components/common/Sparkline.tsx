import { useId } from "react";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Color of the line; area fades from it. */
  color?: string;
}

/** Tiny area sparkline rendered from a price-history series. */
export function Sparkline({ data, width = 116, height = 40, color }: SparklineProps) {
  const gradId = useId();
  if (data.length < 2)
    return <svg width={width} height={height} className="sparkline" aria-hidden="true" focusable="false" />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pad = 3;
  const usableH = height - pad * 2;

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = pad + usableH * (1 - (v - min) / range);
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  const up = data[data.length - 1] >= data[0];
  const lineColor = color ?? (up ? "var(--bull)" : "var(--bear)");

  return (
    <svg
      width={width}
      height={height}
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={lineColor} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
