import { useEffect, useMemo, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import type { StockSignal } from "@/types";

interface FeedBriefingProps {
  /** The signals actually shown on this feed (post-selection). */
  signals: StockSignal[];
  /** Console line label, e.g. "TODAY'S CUT" / "WEEKLY BOARD" / "TUNED FEED". */
  label: string;
  /** Trailing free-form note (e.g. run freshness). */
  note?: string;
  /** Optional right-aligned control (e.g. the live-price refresh pill). */
  aside?: ReactNode;
}

/**
 * Console briefing strip above a feed - the run, summarized like an
 * instrument readout. Purely presentational: every stat derives from the
 * signals already on screen.
 */
export function FeedBriefing({ signals, label, note, aside }: FeedBriefingProps) {
  const stats = useMemo(() => {
    const n = signals.length;
    const avg = n ? Math.round(signals.reduce((s, x) => s + x.score.opportunityScore, 0) / n) : 0;
    const hot = signals.filter((s) => s.hype.tier === "On fire" || s.hype.tier === "Heating up").length;
    const bySector = new Map<string, number>();
    for (const s of signals) bySector.set(s.sector, (bySector.get(s.sector) ?? 0) + 1);
    const topSector = [...bySector.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
    return { n, avg, hot, topSector };
  }, [signals]);

  // Mount at the REAL values (not 0) so first paint is honest - a briefing only
  // renders when there are already signals on screen, so a "0 signals" count-up
  // start reads as broken (Codex QA caught it mid-frame on mobile). NumberFlow
  // still animates on genuine updates (a re-score changes stats → the effect below
  // sets `live` and it counts to the new value).
  const [live, setLive] = useState(() => ({ n: stats.n, avg: stats.avg, hot: stats.hot }));
  useEffect(() => {
    const t = requestAnimationFrame(() => setLive({ n: stats.n, avg: stats.avg, hot: stats.hot }));
    return () => cancelAnimationFrame(t);
  }, [stats.n, stats.avg, stats.hot]);

  return (
    <div className="feed-briefing" role="status" aria-label={`${label}: ${stats.n} signals`}>
      <span className="feed-briefing__lamp" aria-hidden />
      <span className="feed-briefing__label">{label}</span>
      <span className="feed-briefing__stat">
        <strong className="mono">
          <NumberFlow value={live.n} />
        </strong>
        signals
      </span>
      <span className="feed-briefing__sep" aria-hidden />
      <span className="feed-briefing__stat feed-briefing__stat--hot">
        <strong className="mono">
          <NumberFlow value={live.hot} />
        </strong>
        heating&nbsp;up+
      </span>
      <span className="feed-briefing__sep" aria-hidden />
      <span className="feed-briefing__stat">
        <strong className="mono">
          <NumberFlow value={live.avg} />
        </strong>
        avg score
      </span>
      <span className="feed-briefing__sep" aria-hidden />
      <span className="feed-briefing__stat feed-briefing__stat--sector">
        top sector <strong>{stats.topSector}</strong>
      </span>
      {note && <span className="feed-briefing__note">{note}</span>}
      {aside && (
        <span className="feed-briefing__aside" style={{ marginLeft: "auto" }}>
          {aside}
        </span>
      )}
    </div>
  );
}
