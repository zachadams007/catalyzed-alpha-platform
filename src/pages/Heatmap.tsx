import "@/styles/heatmap.css";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useLiveSafeSignals } from "@/store/useLiveSafeSignals";
import { useLivePriceSync } from "@/lib/useLivePrices";
import { PageHeader } from "@/components/common/PageHeader";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { FeedAwaitingRun, FeedState, feedIsPreparing } from "@/components/common/FeedState";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { HeatmapControls } from "@/components/heatmap/HeatmapControls";
import { HeatmapLegend } from "@/components/heatmap/HeatmapLegend";
import { HeatmapStats } from "@/components/heatmap/HeatmapStats";
import { HeatmapTreemap } from "@/components/heatmap/HeatmapTreemap";
import {
  buildHeatTiles,
  groupBySector,
  heatStats,
  hypeDomain,
  HEAT_MODES,
} from "@/components/heatmap/heatmapModel";
import type { HeatMode } from "@/components/heatmap/colorScale";
import { relativeTime } from "@/lib/format";

const PAGE_DESC =
  "The whole scored universe at a glance — every company sized by market cap, grouped by sector, colored by our opportunity score. Toggle to day-move or hype, and click any tile to open it.";

export function Heatmap() {
  const navigate = useNavigate();
  const signals = useLiveSafeSignals();
  const status = useAppStore((s) => s.researchStatus);
  const livePrices = useAppStore((s) => s.livePrices);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  // Default to the live DAY-MOVE view (the classic market-map heat). Opportunity +
  // Hype are precomputed in the daily scan (zero per-view API cost), so they stay as
  // optional toggles - they're not what API budget is spent on.
  const [mode, setMode] = useState<HeatMode>("day");

  // Overlay any live day-change the store already holds (no mass fetch here -
  // the daily scan's move stands until another surface refreshes prices).
  const liveDayChange = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [ticker, q] of Object.entries(livePrices)) {
      if (Number.isFinite(q.dayChange)) map[ticker] = q.dayChange;
    }
    return map;
  }, [livePrices]);

  // Live last-price overlay for the hover read-out - prefer it over the daily price.
  const livePrice = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [ticker, q] of Object.entries(livePrices)) {
      if (Number.isFinite(q.price) && q.price > 0) map[ticker] = q.price;
    }
    return map;
  }, [livePrices]);

  // Build tiles from the scored universe. SpaceX (SPCX) is now a real public
  // mega-cap (NASDAQ, 2026-06-12) - it flows through as an ordinary signal, sized
  // at its true ~$2.44T cap, no private/pre-IPO special-casing.
  const tiles = useMemo(
    () => buildHeatTiles(signals, liveDayChange, livePrice),
    [signals, liveDayChange, livePrice],
  );
  const groups = useMemo(() => groupBySector(tiles), [tiles]);
  const stats = useMemo(() => heatStats(tiles), [tiles]);
  const hd = useMemo(() => hypeDomain(tiles), [tiles]);

  // The whole-universe ticker set, stable across re-renders so the live overlay
  // fires exactly once per mode switch (and a manual refresh), never on relayout.
  const universeTickers = useMemo(() => signals.map((s) => s.ticker), [signals]);

  // Day-move is the only intraday-live mode - opportunity/hype are daily-scored and
  // don't tick during the session. So we only pull the (cheap, batched) Alpaca IEX
  // overlay when DAY is active: ~3 requests for the whole map, on demand.
  const live = useLivePriceSync(mode === "day" ? universeTickers : [], { auto: true });

  // Freshness: the daily scan timestamp (when the scores + base day-move were built).
  const scanAt = useMemo(
    () => signals.reduce((max, s) => (s.generatedAt > max ? s.generatedAt : max), ""),
    [signals],
  );

  const activeMeta = HEAT_MODES.find((m) => m.mode === mode)!;
  // Canonical per-ticker destination is the full stock page (/signal/:ticker) -
  // the SAME page the feed tiles and Ticker Scope open. Every "open a stock" link
  // in the app funnels here, not to an isolated per-surface view. StockDetail
  // resolves unknown symbols gracefully (skeleton → honest "couldn't resolve").
  const openTicker = (ticker: string) => navigate(`/signal/${ticker}`);

  if (tiles.length === 0) {
    if (status === "error") {
      return (
        <>
          <PageHeader title="Market Map" description={PAGE_DESC} />
          <FeedState
            variant="error"
            title="Market scan failed"
            action={
              <button className="btn btn--primary btn--sm" onClick={() => void runResearchNow("manual")}>
                Retry market scan
              </button>
            }
          >
            The last scan didn't finish — usually a data-provider hiccup. Retry, or check Your Desk
            for the scan log.
          </FeedState>
        </>
      );
    }
    if (!feedIsPreparing(status)) {
      return (
        <>
          <PageHeader title="Market Map" description={PAGE_DESC} />
          <FeedAwaitingRun onRun={() => void runResearchNow("manual")} />
        </>
      );
    }
    return (
      <>
        <PageHeader title="Market Map" description={PAGE_DESC} />
        <LoadingNote
          label="the market map"
          hint="Laying out the scored universe — a few seconds, not stuck."
        />
        <div className="hm-skeleton skeleton" aria-busy="true" aria-label="Building the market map…" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Market Map" description={PAGE_DESC} />

      <section className="hm" aria-label="Market map">
        <div className="hm-toolbar">
          <div className="hm-toolbar__modes">
            <HeatmapControls mode={mode} onChange={setMode} />
            <p className="hm-blurb">{activeMeta.blurb}</p>
          </div>
          <div className="hm-toolbar__aside">
            <HeatmapLegend mode={mode} />
            <div className="hm-fresh">
              {mode === "day" ? (
                <>
                  <span className={`hm-fresh__dot ${live.refreshing ? "is-live" : ""}`} aria-hidden="true" />
                  <span className="hm-fresh__text">
                    {live.refreshing
                      ? "Refreshing live prices…"
                      : live.updatedAt
                        ? `Live prices · ${relativeTime(live.updatedAt)}`
                        : "Showing today's scan move"}
                  </span>
                  <button
                    type="button"
                    className="hm-fresh__btn"
                    onClick={live.refresh}
                    disabled={live.refreshing}
                  >
                    Refresh
                  </button>
                </>
              ) : (
                <>
                  <span className="hm-fresh__dot" aria-hidden="true" />
                  <span className="hm-fresh__text">
                    Daily score{scanAt ? ` · scored ${relativeTime(scanAt)}` : ""}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <HeatmapStats stats={stats} onSelect={openTicker} />

        <HeatmapTreemap groups={groups} mode={mode} onSelect={openTicker} hypeDomain={hd} />

        <InvestingDisclaimer className="page-disclaimer" />
      </section>
    </>
  );
}
