import { useMemo } from "react";
import { useAppStore } from "@/store/useAppStore";
import { useLiveSafeSignals } from "@/store/useLiveSafeSignals";
import { selectWeekly, WEEKLY_LIMIT } from "@/feed/feeds";
import { riskAdjustedRankScore } from "@/feed/riskTilt";
import { SignalCard } from "@/components/signal/SignalCard";
import { FeedTabHeader } from "@/components/feed/FeedTabHeader";
import { FeedSkeleton } from "@/components/common/FeedSkeleton";
import { FeedAwaitingRun, FeedState, feedIsPreparing } from "@/components/common/FeedState";
import { FeedBriefing } from "@/components/feed/FeedBriefing";
import { WatchOutsStrip } from "@/components/feed/WatchOutsStrip";
import { useOwnedTickers } from "@/feed/useOwnedTickers";
import { LivePriceControl } from "@/components/common/LivePriceControl";

export function WeeklyFeed() {
  const signals = useLiveSafeSignals();
  const status = useAppStore((s) => s.researchStatus);
  const hasCheckedSharedScan = useAppStore((s) => s.hasCheckedSharedScan);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const riskAppetite = useAppStore((s) => s.preferences.riskAppetite);
  const ownedTickers = useOwnedTickers();
  const weekly = useMemo(
    () => selectWeekly(signals, WEEKLY_LIMIT, (s) => riskAdjustedRankScore(s, riskAppetite)),
    [signals, riskAppetite],
  );

  const header = <FeedTabHeader feed="weekly" />;

  if (signals.length === 0) {
    if (status === "error") {
      return (
        <>
          {header}
          <FeedState
            variant="error"
            title="Research run failed"
            action={
              <button className="btn btn--primary btn--sm" onClick={() => void runResearchNow("manual")}>
                Retry market scan
              </button>
            }
          >
            The last scan didn't finish, so there's no board to rank this week. Retry, or check
            Your Desk for the scan log.
          </FeedState>
        </>
      );
    }
    if (!feedIsPreparing(status) && hasCheckedSharedScan) {
      return (
        <>
          {header}
          <FeedAwaitingRun onRun={() => void runResearchNow("manual")} />
        </>
      );
    }
    return (
      <>
        {header}
        <FeedSkeleton count={6} layout="grid" label="this week's signals" />
      </>
    );
  }

  // Defensive only - selectWeekly is a sort+slice and can't go empty while
  // signals exist, but keep a truthful fallback if that ever changes.
  if (weekly.length === 0) {
    return (
      <>
        {header}
        <FeedState title="Nothing on the weekly board">
          The latest run finished without anything for this cut. Scan Market to rebuild
          the board.
        </FeedState>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="feed-stage">
        <FeedBriefing signals={weekly} label="Weekly board" aside={<LivePriceControl tickers={weekly.map((s) => s.ticker)} />} />
        <div className="feed-grid">
          {weekly.map((signal, i) => (
            <SignalCard key={signal.id} signal={signal} index={i} />
          ))}
        </div>
        {/* Watch-outs at the BOTTOM of every feed tab (owner request 2026-06-21) - a risk
            footer under the picks, identical placement to Today. */}
        <WatchOutsStrip signals={signals} ownedTickers={ownedTickers} />
      </div>
    </>
  );
}
