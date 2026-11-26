import { Link } from "react-router-dom";
import { TerminalPanel } from "./TerminalPanel";
import { FeedState } from "@/components/common/FeedState";
import { useAppStore } from "@/store/useAppStore";
import { scoreColors } from "@/lib/ui";
import { formatPct, formatPrice } from "@/lib/format";
import { isMarketDataUnavailable } from "@/lib/marketData";
import type { StockSignal } from "@/types";

function Row({ ticker, signal }: { ticker: string; signal: StockSignal | undefined }) {
  // No resolved signal at all, OR a directory-confirmed listing with no live
  // market data behind it: both render the muted "no live data" treatment rather
  // than a fabricated score / flat $0 / +0.00% day change.
  if (!signal || isMarketDataUnavailable(signal)) {
    return (
      <Link to={`/signal/${encodeURIComponent(ticker)}`} className="data-row tw-wl-row" title={`Open ${ticker}`}>
        <span className="data-cell mono tw-wl-row__ticker">{ticker}</span>
        {signal && <span className="data-cell text-muted">{signal.name}</span>}
        <span className="data-cell text-faint">{signal ? "No live data" : "Open →"}</span>
      </Link>
    );
  }
  const score = signal.score.opportunityScore;
  const { solid } = scoreColors(score);
  const up = signal.dayChange >= 0;
  return (
    <Link to={`/signal/${encodeURIComponent(ticker)}`} className="data-row tw-wl-row" title={signal.name}>
      <span className="tw-wl-row__score mono" style={{ color: solid }}>
        {score}
      </span>
      <span className="data-cell mono tw-wl-row__ticker">{ticker}</span>
      <span className="data-cell text-muted">{signal.name}</span>
      <span className="data-cell--num">{formatPrice(signal.price)}</span>
      <span className={`data-cell--num ${up ? "text-bull" : "text-bear"}`}>{formatPct(signal.dayChange)}</span>
    </Link>
  );
}

/** Compact monitor of the user's watchlist - each row opens the canonical stock page. */
export function WatchlistMonitor({ id }: { id?: string }) {
  const watchlist = useAppStore((s) => s.watchlist);
  const resolveSignal = useAppStore((s) => s.resolveSignal);

  let body;
  if (watchlist.length === 0) {
    body = (
      <FeedState title="No watchlist yet">
        Press <span className="mono">⌘K</span>, open a ticker, and Watch it — it’ll monitor here.
      </FeedState>
    );
  } else {
    body = (
      <div className="data-list">
        {watchlist.map((t) => (
          <Row key={t} ticker={t} signal={resolveSignal(t)} />
        ))}
      </div>
    );
  }

  return (
    <TerminalPanel id={id} title="Watchlist" hint={`${watchlist.length} tracked`}>
      {body}
    </TerminalPanel>
  );
}
