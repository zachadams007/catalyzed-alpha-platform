import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { StockSignal } from "@/types";
import { buildWatchOuts } from "@/feed/negativeSignals";
import { IconAlertTriangle, IconChevronDown } from "@/components/icons";
import { useAppStore } from "@/store/useAppStore";
import { useGroupsStore } from "@/store/useGroupsStore";
import "@/components/signal/negative-badges.css";

interface WatchOutsStripProps {
  /** The full scored universe (not just the on-screen cut) so a held name that
   *  fell out of today's opportunity cut still raises its flag. */
  signals: StockSignal[];
  /** Watchlisted + held tickers, upper-cased. */
  ownedTickers: ReadonlySet<string>;
}

const PREVIEW = 4;

/** Short badge label for the priority tier a watch-out leads with. */
const PRIORITY_LABEL: Partial<Record<string, { text: string; title: string }>> = {
  held: { text: "Held", title: "In your holdings" },
  watched: { text: "Watching", title: "On your watchlist or a group's shared watchlist" },
  suggested: { text: "Followed", title: "You've engaged with this before" },
};

/**
 * "Watch-outs today" - the honest top-of-feed strip, now about CHANGE.
 *
 * Major market names you don't hold still show their current red flags. Portfolio holdings lead,
 * then watchlist/group, then prior engagement, then price warnings, majors, and the rest.
 */
export function WatchOutsStrip({ signals, ownedTickers }: WatchOutsStripProps) {
  const portfolios = useAppStore((s) => s.portfolios);
  const interactions = useAppStore((s) => s.interactions);
  const baselines = useAppStore((s) => s.watchOutBaselines);
  const ensureWatchOutBaselines = useAppStore((s) => s.ensureWatchOutBaselines);
  const groupWatchlist = useGroupsStore((s) => s.watchlist);
  const groupCalls = useGroupsStore((s) => s.calls);

  // Names the user is involved with beyond their own holdings/watchlist: a group's
  // shared watchlist and names group members have called.
  const groupTickers = useMemo(() => {
    const set = new Set<string>();
    for (const w of groupWatchlist) set.add(w.ticker.toUpperCase());
    for (const c of groupCalls) set.add(c.ticker.toUpperCase());
    return set;
  }, [groupWatchlist, groupCalls]);

  // Every ticker the user is involved with - the set that earns a baseline.
  const involved = useMemo(() => {
    const set = new Set<string>([...ownedTickers, ...groupTickers]);
    for (const ev of interactions) set.add(ev.ticker.toUpperCase());
    return [...set];
  }, [ownedTickers, groupTickers, interactions]);

  // Capture a baseline for every involved ticker the moment we have a live signal for
  // it (first-sight, never overwritten). Idempotent, so once captured it no-ops - no
  // render loop. This is what makes watch-outs surface only CHANGE going forward.
  useEffect(() => {
    if (involved.length > 0 && signals.length > 0) ensureWatchOutBaselines(involved, signals);
  }, [involved, signals, ensureWatchOutBaselines]);

  const entries = useMemo(
    () => buildWatchOuts(signals, ownedTickers, { portfolios, interactions, groupTickers, baselines }),
    [signals, ownedTickers, portfolios, interactions, groupTickers, baselines],
  );
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return null;

  const alerts = entries.filter((e) => e.topSeverity === "alert").length;
  const heldCount = entries.filter((e) => e.priority === "held").length;
  const shown = expanded ? entries : entries.slice(0, PREVIEW);
  const hidden = entries.length - shown.length;

  return (
    <section
      className="watch-outs"
      aria-label={`Watch-outs — ${entries.length} name${entries.length === 1 ? "" : "s"} with a new red flag`}
    >
      <div className="watch-outs__head">
        <span className="watch-outs__title">
          <IconAlertTriangle size={13} className="watch-outs__title-icon" aria-hidden />
          Watch-outs
        </span>
        <span className="watch-outs__count">
          {heldCount > 0 ? `${heldCount} held` : `${entries.length} flagged`}
          {alerts > 0 && <span className="watch-outs__count-alert"> · {alerts} material</span>}
        </span>
      </div>

      <ul className="watch-outs__list">
        {shown.map(({ signal, negatives, priority }) => {
          const tag = PRIORITY_LABEL[priority];
          return (
            <li key={signal.id} className="watch-out-row">
              <Link to={`/signal/${signal.ticker}`} className="watch-out-row__name" title={signal.name}>
                <span className="watch-out-row__head">
                  <span className="watch-out-row__ticker">{signal.ticker}</span>
                  {tag && (
                    <span className="watch-out-row__owned" title={tag.title}>
                      {tag.text}
                    </span>
                  )}
                </span>
                <span className="watch-out-row__company">{signal.name}</span>
              </Link>
              <div className="watch-out-row__flags">
                {negatives.map((n) => (
                  <span
                    key={n.kind}
                    className={`neg-badge neg-badge--${n.severity}`}
                    title={n.detail}
                  >
                    <span className="neg-badge__label">{n.label}</span>
                  </span>
                ))}
              </div>
              <span className="watch-out-row__lead" title={negatives[0].detail}>
                {negatives[0].detail}
              </span>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && !expanded && (
        <button
          type="button"
          className="watch-outs__more"
          onClick={() => setExpanded(true)}
        >
          Show {hidden} more
          <IconChevronDown size={13} aria-hidden />
        </button>
      )}
    </section>
  );
}
