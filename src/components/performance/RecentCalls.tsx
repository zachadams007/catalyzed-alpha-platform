import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { buildRecentCalls } from "@/engine/recentCalls";
import { filterLedgerByVariant, type LedgerVersionFilter } from "@/engine/outcomeLedger";
import { VersionTag } from "@/components/performance/VersionTag";
import { formatPct, formatPrice } from "@/lib/format";
import { isUsMarketOpen } from "@/lib/marketStatus";
import { useLivePriceSync } from "@/lib/useLivePrices";

function band(v: number): "high" | "good" | "mid" | "low" {
  if (v >= 75) return "high";
  if (v >= 55) return "good";
  if (v >= 35) return "mid";
  return "low";
}

/** A day's up/down/flat tally with a thin diverging bar - degrades to a clean
 *  "tracking" pill when no pick in the day has a measurable move yet. */
function DayTally({ calls }: { calls: { ret: number | null }[] }) {
  const moved = calls.filter((c) => c.ret != null) as { ret: number }[];
  if (moved.length === 0) {
    return <span className="perf-calls__tally perf-calls__tally--pending">tracking</span>;
  }
  const up = moved.filter((c) => c.ret > 0).length;
  const down = moved.filter((c) => c.ret < 0).length;
  const total = moved.length;
  const upPct = (up / total) * 100;
  const downPct = (down / total) * 100;
  return (
    <span
      className="perf-calls__tally"
      title={`${up} up · ${down} down of ${total} settled`}
    >
      <span className="perf-calls__tally-bar" aria-hidden="true">
        <span className="perf-calls__tally-up" style={{ width: `${upPct}%` }} />
        <span className="perf-calls__tally-down" style={{ width: `${downPct}%` }} />
      </span>
      <span className="perf-calls__tally-count mono">
        <span className="perf-figure--pos">{up}</span>
        <span className="perf-calls__tally-sep">·</span>
        <span className="perf-figure--neg">{down}</span>
      </span>
    </span>
  );
}

function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * "The model's calls" - the top picks per recent day with LIVE progress, so the
 * Track Record isn't empty while forward returns settle into the staircase above.
 */
export function RecentCalls({ versionFilter = "all" }: { versionFilter?: LedgerVersionFilter }) {
  const ledger = useAppStore((s) => s.outcomeLedger);
  const entries = useMemo(() => filterLedgerByVariant(ledger, versionFilter).entries, [ledger, versionFilter]);
  const livePrices = useAppStore((s) => s.livePrices);
  const signals = useAppStore((s) => s.signals);
  // When the market's closed, the "current price" is the last session's close - so
  // the progress is a real return AS OF that close, not a live one. Label it honestly.
  const marketOpen = isUsMarketOpen();

  const days = useMemo(() => {
    const priceOf = (t: string): number | undefined =>
      livePrices[t]?.price ?? signals.find((x) => x.ticker === t)?.price;
    return buildRecentCalls(entries, priceOf, Date.now());
  }, [entries, livePrices, signals]);

  // Refreshes on view-open like the feeds, not per-second; the ticker SET is stable so it fires
  // once, not in a loop. Honest "live" vs "at close" labeling is handled by `marketOpen` above.
  const allTickers = useMemo(
    () => [...new Set(days.flatMap((d) => d.calls.map((c) => c.ticker)))],
    [days],
  );
  useLivePriceSync(allTickers, { auto: true });

  if (days.length === 0) return null;

  return (
    <section className="perf-calls">
      <header className="perf-calls__head">
        <span className="rd-section-eyebrow">The model&rsquo;s calls</span>
        <p className="text-faint perf-calls__sub">
          Top picks per day and their move since publish — live in-session, at last close
          otherwise. Each joins the staircase above once its 7-day window elapses.
        </p>
      </header>

      {days.map(({ day, calls }) => (
        <div key={day} className="perf-calls__day">
          <div className="perf-calls__day-head">
            <span className="perf-calls__date">{fmtDay(day)}</span>
            <DayTally calls={calls} />
          </div>
          <div className="perf-calls__rows">
            {calls.map((c) => (
              <Link key={c.ticker} to={`/signal/${c.ticker}`} className="perf-call" title={`Open ${c.ticker}`}>
                <span className={`perf-call__score mono rd-band--${band(c.score)}`}>{Math.round(c.score)}</span>
                <span className="perf-call__id">
                  <span className="perf-call__tk mono">
                    {c.ticker}
                    <VersionTag variant={c.liveVariant} className="perf-highlight__version" />
                  </span>
                  <span className="perf-call__name">{c.name}</span>
                </span>
                <span className="perf-call__px mono">
                  {formatPrice(c.priceAtPublish)}
                  {c.currentPrice != null ? <span className="perf-call__arrow"> → {formatPrice(c.currentPrice)}</span> : null}
                </span>
                <span
                  className={`perf-call__ret mono ${
                    c.ret == null ? "text-faint" : c.ret >= 0 ? "perf-figure--pos" : "perf-figure--neg"
                  }`}
                >
                  {c.ret == null ? "—" : formatPct(c.ret)}
                </span>
                <span
                  className={`perf-call__tag perf-call__tag--${c.basis === "live" && !marketOpen ? "settled" : c.basis}`}
                >
                  {c.basis === "live"
                    ? marketOpen
                      ? "live"
                      : "at close"
                    : c.basis === "settled"
                      ? `${c.heldDays}d`
                      : `${c.heldDays}d · tracking`}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
