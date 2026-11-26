import type { CSSProperties } from "react";
import { IconArrowUp, IconLayers, IconScale } from "@/components/icons";
import { formatPct, formatPctPlain } from "@/lib/format";
import type { ScoreBucketStat } from "@/engine/outcomeLedger";
import "./rank-performance-chart.css";

/**
 * RankPerformanceChart - the portable "does our ranking actually work?" proof.
 *
 * It renders realized forward return for each rank tier as a diverging-bar
 * ladder, highest-scored tier at the TOP. If the score ranks well the ladder
 * steps down as you descend - the single most legible proof a viewer can read.
 *
 * Deliberately pure presentation: it takes already-bucketed stats as props and
 * reads NOTHING from the store, the engine, or the network. That's what lets the
 * same component back the global Track Record AND a per-watchlist, per-group, or
 * per-portfolio performance panel - pass it that slice's buckets and a title.
 */

export interface RankPerfBucket {
  /** Stable key for React + aria. */
  key: string | number;
  /** Rank-tier label, e.g. "Top 10%" / "Top half". */
  tier: string;
  /** Supporting detail, e.g. the score range "78–95". */
  detail?: string;
  /** Mean realized forward return as a ratio (0.021 = +2.1%). */
  avgReturn: number;
  /** Share of the tier that rose, 0..1. */
  hitRate: number;
  /** Settled picks in this tier. */
  count: number;
}

export interface RankPerformanceChartProps {
  /** Buckets in any order - rendered top-tier first. */
  buckets: RankPerfBucket[];
  /** Window label woven into the default copy, e.g. "30-day". */
  windowLabel?: string;
  /** Render softer + a directional caption when the sample is thin. */
  lowSample?: boolean;
  /** Override the heading (defaults to the proof question). */
  title?: string;
  /** Override the sub-line (defaults to a window-aware explainer). */
  subtitle?: string;
  /** Compact embed for narrow panels (watchlist / group / portfolio). */
  dense?: boolean;
  /** Reveal-stagger the bars (default true; auto-off under reduced-motion). */
  animate?: boolean;
  /** Extra class on the root (e.g. to drop card chrome in an embed). */
  className?: string;
}

type Tone = "pos" | "neg" | "flat";

function toneOf(value: number): Tone {
  if (value > 0.0005) return "pos";
  if (value < -0.0005) return "neg";
  return "flat";
}

/**
 * Map the engine's lowest→highest `ScoreBucketStat[]` into top-tier-first proof
 * buckets with human percentile labels. Type-only dependency on the engine - no
 * logic imported - so any view holding bucket stats can feed this chart.
 */
export function rankPerfBucketsFromStats(stats: ScoreBucketStat[]): RankPerfBucket[] {
  return stats.map((b) => ({
    key: b.index,
    tier: tierLabel(b.index - 1, b.of),
    detail:
      b.scoreRange.min === b.scoreRange.max
        ? `score ${b.scoreRange.min}`
        : `score ${b.scoreRange.min}–${b.scoreRange.max}`,
    avgReturn: b.avgForwardReturn,
    hitRate: b.hitRate,
    count: b.count,
  }));
}

/** Percentile-band label for a bucket, given its 0-based low→high index. */
function tierLabel(indexFromLow: number, of: number): string {
  const fromTop = of - 1 - indexFromLow; // 0 = top tier
  if (of <= 1) return "All picks";
  if (of === 2) return fromTop === 0 ? "Top half" : "Bottom half";
  const step = Math.round(100 / of);
  if (fromTop === 0) return `Top ${step}%`;
  if (fromTop === of - 1) return `Bottom ${step}%`;
  return `${fromTop * step}–${(fromTop + 1) * step}%`;
}

export function RankPerformanceChart({
  buckets,
  windowLabel,
  lowSample = false,
  title,
  subtitle,
  dense = false,
  animate = true,
  className = "",
}: RankPerformanceChartProps) {
  // Top tier first - the eye should read the ladder stepping DOWN.
  const ordered = [...buckets].reverse();
  const maxAbs = Math.max(0.0001, ...ordered.map((b) => Math.abs(b.avgReturn)));

  const top = ordered[0];
  const bottom = ordered[ordered.length - 1];
  const lift = top && bottom ? top.avgReturn - bottom.avgReturn : 0;
  const liftTone = toneOf(lift);
  const win = windowLabel ? `${windowLabel} ` : "";

  const heading = title ?? "Does a higher rank mean a better return?";
  const sub =
    subtitle ??
    `Average ${win}return for each rank tier — our highest-scored picks at the top. A ladder that steps down as you go lower means the score is ranking well.`;

  const rootClass = [
    "rankperf",
    dense ? "rankperf--dense" : "",
    lowSample ? "rankperf--thin" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={rootClass} aria-label="Realized return by rank tier">
      <div className="rankperf__head">
        <div className="rankperf__heading">
          <span className="rankperf__icon" aria-hidden="true">
            <IconLayers size={dense ? 14 : 16} />
          </span>
          <div>
            <h3 className="rankperf__title">{heading}</h3>
            {!dense && <p className="rankperf__sub">{sub}</p>}
          </div>
        </div>
        {ordered.length >= 2 && (
          <span
            className={`rankperf__lift rankperf__lift--${liftTone}`}
            title="Top-tier average return minus bottom-tier"
          >
            <span className="rankperf__lift-icon" aria-hidden="true">
              {liftTone === "pos" ? <IconArrowUp size={13} /> : <IconScale size={13} />}
            </span>
            <span className="rankperf__lift-k">Top − bottom</span>
            <span className={`rankperf__lift-v mono perf-figure--${liftTone}`}>{formatPct(lift)}</span>
          </span>
        )}
      </div>

      <ol className="rankperf__rows">
        {ordered.map((b, i) => {
          const t = toneOf(b.avgReturn);
          const mag = (Math.abs(b.avgReturn) / maxAbs) * 100;
          const isTop = i === 0;
          const isBottom = i === ordered.length - 1;
          return (
            <li
              key={b.key}
              className={`rankperf__row${isTop ? " rankperf__row--top" : ""}${isBottom ? " rankperf__row--bottom" : ""}`}
              style={
                {
                  "--reveal-index": animate ? i : 0,
                  "--mag": mag,
                } as CSSProperties
              }
              aria-label={`${b.tier}: ${formatPct(b.avgReturn)} average return, ${formatPctPlain(
                b.hitRate,
              )} rose, ${b.count} pick${b.count === 1 ? "" : "s"}`}
            >
              <div className="rankperf__tier">
                <span className="rankperf__rank" aria-hidden="true" />
                <span className="rankperf__tier-name">{b.tier}</span>
                {b.detail && <span className="rankperf__tier-detail mono">{b.detail}</span>}
              </div>

              <div className="rankperf__track" aria-hidden="true">
                <span className="rankperf__zero" />
                <span
                  className={`rankperf__bar rankperf__bar--${t}${animate ? " rankperf__bar--anim" : ""}`}
                />
              </div>

              <div className="rankperf__out">
                <span className={`rankperf__ret mono perf-figure--${t}`}>{formatPct(b.avgReturn)}</span>
                <span className="rankperf__facts">
                  <span className="rankperf__fact">
                    <span className="mono">{formatPctPlain(b.hitRate)}</span> rose
                  </span>
                  <span className="rankperf__fact rankperf__fact--n">
                    <span className="mono">{b.count}</span>
                  </span>
                </span>
              </div>
            </li>
          );
        })}

        <li className="rankperf__row rankperf__row--axis" aria-hidden="true">
          <span className="rankperf__tier" />
          <div className="rankperf__axis">
            <span>Loss</span>
            <span className="rankperf__axis-zero">0%</span>
            <span>Gain</span>
          </div>
          <span className="rankperf__out" />
        </li>
      </ol>

      {lowSample && (
        <p className="rankperf__note">
          Early read — the ladder firms up as more picks settle. Treat the spread as directional, not
          proof.
        </p>
      )}
    </section>
  );
}
