import { useId } from "react";

interface CardChartBackdropProps {
  data: number[];
  /** Direction tints the wash: bull green vs bear red. */
  up: boolean;
}

/**
 * Panoramic price-history wash behind a feed card's hero band. Decorative
 * only (aria-hidden) - the interactive chart stays on SparklineButton.
 * Stretches to the band via preserveAspectRatio="none"; a horizontal mask
 * fades it out toward the left so the ticker block stays readable.
 */
export function CardChartBackdrop({ data, up }: CardChartBackdropProps) {
  const uid = useId();
  if (data.length < 2) return null;

  const W = 100;
  const H = 32;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = W / (data.length - 1);
  const pad = 4;
  const usableH = H - pad * 2;

  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = pad + usableH * (1 - (v - min) / range);
    return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = pts.join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const color = up ? "var(--bull)" : "var(--bear)";

  return (
    <svg
      className="card-chart-backdrop"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.34" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${uid}-fade`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="42%" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id={`${uid}-mask`}>
          <rect x="0" y="0" width={W} height={H} fill={`url(#${uid}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${uid}-mask)`}>
        <path d={area} fill={`url(#${uid}-fill)`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeOpacity="0.55"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
          pathLength={1}
          className="card-chart-backdrop__line"
        />
      </g>
    </svg>
  );
}
