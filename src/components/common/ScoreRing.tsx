import { useEffect, useId, useRef, useState } from "react";
import { scoreColors } from "@/lib/ui";

interface ScoreRingProps {
  /** 0..100 */
  score: number;
  size?: number;
  stroke?: number;
  /** @deprecated Ignored - the ring shows only the number now (no caption). */
  label?: string;
  /** @deprecated Ignored - the ring shows only the number now (no caption). */
  showLabel?: boolean;
  /**
   * Render an honest "no score" state (empty ring + " - ") instead of a number.
   * Used when there's no live market data to score, so we never show a
   * fabricated opportunity score for an uncovered listing.
   */
  unavailable?: boolean;
}

/** Accessible label for the populated ring, e.g. "Opportunity score 72 of 100". */
export function scoreRingLabel(score: number): string {
  const clamped = Math.max(0, Math.min(100, score));
  return `Opportunity score ${Math.round(clamped)} of 100`;
}

/**
 * Drive a 0 → target count-up that completes in ~900ms (easeOutCubic), honoring
 * prefers-reduced-motion (jumps straight to the value). Used to animate both the
 * numeral and the arc off a SINGLE source of truth so they never desync.
 */
function useCountUp(target: number): number {
  const [live, setLive] = useState(0);
  const rafRef = useRef(0);
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      setLive(target);
      return;
    }
    const DURATION = 900;
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    let startTs = 0;
    const tick = (ts: number) => {
      if (!startTs) startTs = ts;
      const t = Math.min(1, (ts - startTs) / DURATION);
      setLive(target * easeOutCubic(t));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    // Safety net: requestAnimationFrame is paused while the tab/webview is
    // backgrounded, which would otherwise freeze the numeral at 0. setTimeout
    // still fires (throttled) so the final score always lands.
    const settle = setTimeout(() => setLive(target), DURATION + 120);
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(settle);
    };
  }, [target]);
  return live;
}

/**
 * Circular gauge for the opportunity score, with a band-colored gradient.
 *
 * The numeral is rendered as SVG <text> centered via dominant-baseline="central"
 * - the SVG renderer computes the same baseline geometry on every platform
 * (desktop, Android, iOS Safari / standalone PWA), so the number sits DEAD CENTER
 * of the ring everywhere. (The prior HTML+NumberFlow overlay reserved asymmetric
 * vertical space for its digit-roll that pushed the number off-center on iOS.)
 * The SVG itself is responsive (viewBox + width/height 100%) so a CSS size
 * override scales the ring, numeral, and stroke together with no misalignment.
 */
export function ScoreRing({
  score,
  size = 78,
  stroke = 7,
  unavailable = false,
}: ScoreRingProps) {
  const gradId = useId();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const { a, b } = scoreColors(score);

  // Hooks run before any early return so hook order stays stable across the
  // unavailable/available states.
  const live = useCountUp(unavailable ? 0 : clamped);

  const cx = size / 2;
  const cy = size / 2;
  const numberFontSize = size * 0.3;

  if (unavailable) {
    return (
      <div
        className="score-ring score-ring--unavailable"
        style={{ width: size, height: size }}
        role="img"
        aria-label="Opportunity score unavailable — no live market data"
        title="No live market data — opportunity score unavailable"
      >
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={stroke}
          />
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            className="score-ring__value mono text-faint"
            fontSize={numberFontSize}
          >
            —
          </text>
        </svg>
      </div>
    );
  }

  const offset = circumference * (1 - live / 100);

  return (
    <div
      className="score-ring"
      style={{ width: size, height: size, color: a }}
      role="img"
      aria-label={scoreRingLabel(score)}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={a} />
            <stop offset="100%" stopColor={b} />
          </linearGradient>
        </defs>
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
        />
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          className="score-ring__value mono"
          fontSize={numberFontSize}
          fill="currentColor"
        >
          {Math.round(live)}
        </text>
      </svg>
    </div>
  );
}
