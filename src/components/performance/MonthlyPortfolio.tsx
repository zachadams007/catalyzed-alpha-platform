import { useMemo } from "react";
import { formatPct } from "@/lib/format";
import type { OutcomeEntry } from "@/engine/outcomeLedger";
import { IconArrowUp, IconArrowDown, IconClock } from "@/components/icons";

/**
 * Monthly Portfolio View - M6 Track Record enhancement.
 *
 * Buckets settled picks by publish month, treats each month as an equal-weighted
 * portfolio (with a mild score tilt: picks scoring higher get a slightly larger
 * weight), and shows a compact performance bar per period.
 *
 * Only picks with at least one settled forward return are included.
 * The primary return window is d30 (best coverage); falls back to d20 then d7.
 *
 * Pure-presentation: never touches the ledger or scoring engine.
 */

interface MonthBucket {
  monthKey: string; // "2026-05"
  monthLabel: string; // "May 2026"
  count: number;
  settledCount: number;
  /** Score-weighted avg forward return (ratio). null if no settled picks. */
  weightedReturn: number | null;
  /** Equal-weight avg forward return (ratio). null if no settled picks. */
  equalReturn: number | null;
  /** Hit rate among settled picks. */
  hitRate: number | null;
  /** Best single pick in this month. */
  best: { ticker: string; ret: number } | null;
  /** Worst single pick in this month. */
  worst: { ticker: string; ret: number } | null;
}

/** Pick the best settled return from a pick's forward returns. */
function primaryReturn(e: OutcomeEntry): number | null {
  if (e.forwardReturns.d30 != null) return e.forwardReturns.d30;
  if (e.forwardReturns.d20 != null) return e.forwardReturns.d20;
  if (e.forwardReturns.d7 != null) return e.forwardReturns.d7;
  return null;
}

function monthKeyOf(isoDate: string): string {
  // "2026-05-14T..." → "2026-05"
  return isoDate.slice(0, 7);
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function buildMonthlyBuckets(entries: OutcomeEntry[]): MonthBucket[] {
  // Group by month
  const byMonth = new Map<string, OutcomeEntry[]>();
  for (const e of entries) {
    const key = monthKeyOf(e.publishedAtISO);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(e);
    else byMonth.set(key, [e]);
  }

  const keys = [...byMonth.keys()].sort();
  return keys.map((key) => {
    const picks = byMonth.get(key)!;
    const settled = picks.filter((e) => primaryReturn(e) != null);

    if (settled.length === 0) {
      return {
        monthKey: key,
        monthLabel: monthLabel(key),
        count: picks.length,
        settledCount: 0,
        weightedReturn: null,
        equalReturn: null,
        hitRate: null,
        best: null,
        worst: null,
      };
    }

    // Score-weighted return: weight = (score / 100)^0.5 so the tilt is mild
    // (a 90-score pick is 1.5× heavier than a 40-score pick, not 2.25×).
    const weights = settled.map((e) => Math.sqrt(e.opportunityScore / 100));
    const totalW = weights.reduce((a, b) => a + b, 0);
    let weightedReturn = 0;
    let equalReturn = 0;
    let wins = 0;
    let best: { ticker: string; ret: number } | null = null;
    let worst: { ticker: string; ret: number } | null = null;

    for (let i = 0; i < settled.length; i++) {
      const ret = primaryReturn(settled[i])!;
      weightedReturn += ret * (weights[i] / totalW);
      equalReturn += ret / settled.length;
      if (ret > 0) wins++;
      if (best === null || ret > best.ret) best = { ticker: settled[i].ticker, ret };
      if (worst === null || ret < worst.ret) worst = { ticker: settled[i].ticker, ret };
    }

    return {
      monthKey: key,
      monthLabel: monthLabel(key),
      count: picks.length,
      settledCount: settled.length,
      weightedReturn,
      equalReturn,
      hitRate: wins / settled.length,
      best,
      worst,
    };
  });
}

// ── Visualization helpers ────────────────────────────────────────────────────

const BAR_MAX_PCT = 30; // cap bar at ±30% for visual scale

function RetBar({ value }: { value: number }) {
  const pct = Math.min(Math.abs(value * 100), BAR_MAX_PCT);
  const frac = pct / BAR_MAX_PCT;
  const pos = value >= 0;
  return (
    <div className="mp-bar-track" aria-hidden="true">
      <div className="mp-bar-mid" />
      <div
        className={`mp-bar-fill mp-bar-fill--${pos ? "pos" : "neg"}`}
        style={{
          width: `${frac * 50}%`,
          left: pos ? "50%" : `${50 - frac * 50}%`,
        }}
      />
    </div>
  );
}

function tone(v: number): string {
  return v > 0 ? "pos" : v < 0 ? "neg" : "flat";
}

// ── Component ────────────────────────────────────────────────────────────────

interface MonthlyPortfolioProps {
  entries: OutcomeEntry[];
}

export function MonthlyPortfolio({ entries }: MonthlyPortfolioProps) {
  const buckets = useMemo(() => buildMonthlyBuckets(entries), [entries]);

  // Only show months that have at least some settled picks, plus the most-recent
  // unsettled month (to show "pending").
  const display = useMemo(() => {
    const settled = buckets.filter((b) => b.settledCount > 0);
    const pending = buckets.filter((b) => b.settledCount === 0 && b.count > 0);
    // Show last pending month as a "tracking" row
    const lastPending = pending.length > 0 ? pending[pending.length - 1] : null;
    // Most recent first
    const rows = [...settled].reverse();
    if (lastPending) rows.unshift(lastPending);
    return rows;
  }, [buckets]);

  if (display.length === 0) return null;

  return (
    <section className="ops-card mp-section" aria-label="Monthly portfolio performance">
      <div className="mp-head">
        <h3 className="ops-card__title mp-title">Monthly portfolios</h3>
        <p className="ops-card__sub mp-sub">
          Each month's picks as one portfolio, weighted by score. Recent months may be partly settled.
        </p>
      </div>

      <div className="mp-grid">
        {/* Column headers */}
        <div className="mp-row mp-row--header" aria-hidden="true">
          <span className="mp-col-month">Month</span>
          <span className="mp-col-bar">Return</span>
          <span className="mp-col-ret">Avg</span>
          <span className="mp-col-hit">Hit rate</span>
          <span className="mp-col-n">Picks</span>
          <span className="mp-col-best">Best</span>
          <span className="mp-col-worst">Worst</span>
        </div>

        {display.map((b) => {
          const ret = b.weightedReturn;
          const pending = b.settledCount === 0;

          return (
            <div
              key={b.monthKey}
              className={`mp-row${pending ? " mp-row--pending" : ""}`}
              aria-label={`${b.monthLabel}: ${ret != null ? formatPct(ret) : "pending"}`}
            >
              <span className="mp-col-month">{b.monthLabel}</span>

              <span className="mp-col-bar">
                {ret != null ? (
                  <RetBar value={ret} />
                ) : (
                  <span className="mp-pending-tag">
                    <IconClock size={11} /> tracking
                  </span>
                )}
              </span>

              <span className={`mp-col-ret mono${ret != null ? ` perf-figure--${tone(ret)}` : " text-faint"}`}>
                {ret != null ? (
                  <>
                    {ret > 0 ? <IconArrowUp size={11} /> : ret < 0 ? <IconArrowDown size={11} /> : null}
                    {formatPct(ret)}
                  </>
                ) : "—"}
              </span>

              <span className="mp-col-hit mono text-muted">
                {b.hitRate != null ? `${Math.round(b.hitRate * 100)}%` : "—"}
              </span>

              <span className="mp-col-n mono text-faint">
                {b.settledCount > 0 ? `${b.settledCount}/${b.count}` : b.count}
              </span>

              <span className={`mp-col-best mono${b.best ? " perf-figure--pos" : " text-faint"}`}>
                {b.best ? `${b.best.ticker} ${formatPct(b.best.ret)}` : "—"}
              </span>

              <span className={`mp-col-worst mono${b.worst ? " perf-figure--neg" : " text-faint"}`}>
                {b.worst ? `${b.worst.ticker} ${formatPct(b.worst.ret)}` : "—"}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mp-footnote text-faint">
        Weighted by score (√score); 30-day return, falling back to 20d / 7d. Past performance does
        not predict future results.
      </p>
    </section>
  );
}
