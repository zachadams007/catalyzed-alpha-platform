import { useMemo } from "react";
import { useAppStore } from "@/store/useAppStore";
import { useLiveSafeSignals } from "@/store/useLiveSafeSignals";
import { selectToday, TODAY_LIMIT } from "@/feed/feeds";
import { riskAdjustedRankScore } from "@/feed/riskTilt";
import { SignalCard } from "@/components/signal/SignalCard";
import { FeedTabHeader } from "@/components/feed/FeedTabHeader";
import { FeedSkeleton } from "@/components/common/FeedSkeleton";
import { FeedAwaitingRun, FeedState, feedIsPreparing } from "@/components/common/FeedState";
import { FeedBriefing } from "@/components/feed/FeedBriefing";
import { AiPickHero } from "@/components/feed/AiPickHero";
import { WatchOutsStrip } from "@/components/feed/WatchOutsStrip";
import { useOwnedTickers } from "@/feed/useOwnedTickers";
import { LivePriceControl } from "@/components/common/LivePriceControl";
import { relativeTime } from "@/lib/format";

export function TodayFeed() {
  const signals = useLiveSafeSignals();
  const status = useAppStore((s) => s.researchStatus);
  const hasCheckedSharedScan = useAppStore((s) => s.hasCheckedSharedScan);
  const lastRun = useAppStore((s) => s.lastRun);
  const fromShared = useAppStore((s) => s.signalsFromShared);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const riskAppetite = useAppStore((s) => s.preferences.riskAppetite);
  const ownedTickers = useOwnedTickers();

  // Today leans on the algorithm, lightly tilted by the user's risk dial.
  const today = useMemo(
    () => selectToday(signals, TODAY_LIMIT, (s) => riskAdjustedRankScore(s, riskAppetite)),
    [signals, riskAppetite],
  );

  // Honest provenance: when these picks came from the shared daily compute (the
  // first tester to open the app today ran the scan; this device just read it),
  // say so - and always show the local clock time they were computed.
  const computedNote = useMemo(() => {
    if (!lastRun?.finishedAt) return undefined;
    const t = new Date(lastRun.finishedAt);
    const when = Number.isNaN(t.getTime())
      ? `run ${relativeTime(lastRun.finishedAt)}`
      : `computed ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return fromShared ? `shared · ${when}` : when;
  }, [lastRun?.finishedAt, fromShared]);

  if (signals.length === 0) {
    if (status === "error") {
      return (
        <>
          <FeedTabHeader feed="today" />
          <FeedState
            variant="error"
            title="Research run failed"
            action={
              <button className="btn btn--primary btn--sm" onClick={() => void runResearchNow("manual")}>
                Retry market scan
              </button>
            }
          >
            The last scan didn't finish — usually a data provider issue. Retry, or check
            Your Desk for the scan log.
          </FeedState>
        </>
      );
    }
    if (!feedIsPreparing(status) && hasCheckedSharedScan) {
      return (
        <>
          <FeedTabHeader feed="today" />
          <FeedAwaitingRun onRun={() => void runResearchNow("manual")} />
        </>
      );
    }
    return (
      <>
        <FeedTabHeader
          feed="today"
          description={
            status === "running"
              ? "Running this morning's research…"
              : status === "loading"
                ? "Loading today's board…"
                : "Preparing your feed…"
          }
        />
        <FeedSkeleton count={4} showHeader={false} label="today's signals" />
      </>
    );
  }

  // Defensive only - selectToday always returns at least one signal when the
  // universe is non-empty, but keep a truthful fallback if that ever changes.
  if (today.length === 0) {
    return (
      <>
        <FeedTabHeader feed="today" />
        <FeedState title="Nothing to show on Today">
          The latest run finished without anything for this cut. Scan Market to rebuild
          the board, or check This Week.
        </FeedState>
      </>
    );
  }

  return (
    <>
      <FeedTabHeader feed="today" />
      <div className="feed-stage">
        <AiPickHero />
        <FeedBriefing
          signals={today}
          label="Today's cut"
          note={computedNote}
          aside={<LivePriceControl tickers={today.map((s) => s.ticker)} />}
        />
        <div className="feed feed--timeline">
          {today.map((signal, i) => (
            <SignalCard key={signal.id} signal={signal} index={i} />
          ))}
        </div>
        {/* Watch-outs live at the BOTTOM of Today (owner request 2026-06-20) - a risk
            footer under the picks, not a banner above them. Real negatives only. */}
        <WatchOutsStrip signals={signals} ownedTickers={ownedTickers} />
      </div>
    </>
  );
}
