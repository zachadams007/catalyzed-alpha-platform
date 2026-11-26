import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { useLiveSafeSignals } from "@/store/useLiveSafeSignals";
import { composeForYou, forYouFilterById } from "@/feed/feedFilters";
import { emergingThemeBySlug } from "@/feed/emergingThemes";
import { SignalCard } from "@/components/signal/SignalCard";
import { FeedTabHeader } from "@/components/feed/FeedTabHeader";
import { FeedSkeleton } from "@/components/common/FeedSkeleton";
import { FeedAwaitingRun, FeedState, feedIsPreparing } from "@/components/common/FeedState";
import { FeedBriefing } from "@/components/feed/FeedBriefing";
import { ForYouFilterBar } from "@/components/feed/ForYouFilterBar";
import { WatchOutsStrip } from "@/components/feed/WatchOutsStrip";
import { useOwnedTickers } from "@/feed/useOwnedTickers";
import { LivePriceControl } from "@/components/common/LivePriceControl";
import { Link } from "react-router-dom";
import { SYSTEM_NAV } from "@/config/navigationLabels";
import type { Sector, TradeHorizon } from "@/types";
import { TRADE_HORIZON_LABELS } from "@/types";
import { TradeHorizonPicker } from "@/components/screen/TradeHorizonPicker";
import "@/styles/foryou.css";

/** Cards per window - For You curates the top of the ranked universe. */
const FEED_WINDOW = 30;

/** How much of the beyond-filters board shows before "clear filters" is the answer. */
const BACKFILL_WINDOW = 12;

function topSectors(weights: Partial<Record<Sector, number>>): string[] {
  return (Object.entries(weights) as Array<[Sector, number]>)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => s);
}

function styleLabel(tilt: number): string {
  if (tilt > 0.33) return "Catalyst-driven";
  if (tilt < -0.33) return "Fundamentals-driven";
  return "Balanced";
}
function riskLabel(r: number): string {
  if (r > 0.66) return "Aggressive";
  if (r < 0.4) return "Conservative";
  return "Moderate";
}

export function ForYouFeed() {
  const signals = useLiveSafeSignals();
  const preferences = useAppStore((s) => s.preferences);
  const interactions = useAppStore((s) => s.interactions);
  const reset = useAppStore((s) => s.resetPersonalization);
  const setTradeHorizon = useAppStore((s) => s.setTradeHorizon);
  const setRiskAppetite = useAppStore((s) => s.setRiskAppetite);
  const toggleForYouFilter = useAppStore((s) => s.toggleForYouFilter);
  const toggleForYouTheme = useAppStore((s) => s.toggleForYouTheme);
  const setForYouThemesAll = useAppStore((s) => s.setForYouThemesAll);
  const status = useAppStore((s) => s.researchStatus);
  const hasCheckedSharedScan = useAppStore((s) => s.hasCheckedSharedScan);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const ownedTickers = useOwnedTickers();

  const composition = useMemo(
    () => composeForYou(signals, preferences),
    [signals, preferences],
  );
  const { ranked, backfill, counts, activeFilters } = composition;
  const filtersActive = activeFilters.length > 0;

  const [visible, setVisible] = useState(FEED_WINDOW);
  const [showBackfill, setShowBackfill] = useState(false);
  // New filter mix = a new feed: rewind the windows so the matches lead.
  const filterKey = `${activeFilters.join("|")}·${preferences.forYouThemes?.join(",") ?? "all"}`;
  useEffect(() => {
    setVisible(FEED_WINDOW);
    setShowBackfill(false);
  }, [filterKey]);

  const shown = useMemo(() => ranked.slice(0, visible), [ranked, visible]);

  if (signals.length === 0) {
    const emptyHeader = (
      <FeedTabHeader
        feed="for-you"
        action={
          <Link
            to={`${SYSTEM_NAV.core.path}?run=live`}
            className="btn btn--primary btn--sm"
          >
            Run live & watch in {SYSTEM_NAV.core.label} →
          </Link>
        }
      />
    );
    if (status === "error") {
      return (
        <>
          {emptyHeader}
          <FeedState
            variant="error"
            title="Research run failed"
            action={
              <button className="btn btn--primary btn--sm" onClick={() => void runResearchNow("manual")}>
                Retry market scan
              </button>
            }
          >
            The last scan didn't finish, so there's nothing to personalize yet. Retry, or check
            Your Desk for the scan log.
          </FeedState>
        </>
      );
    }
    if (!feedIsPreparing(status) && hasCheckedSharedScan) {
      return (
        <>
          {emptyHeader}
          <FeedAwaitingRun onRun={() => void runResearchNow("manual")} />
        </>
      );
    }
    return (
      <>
        {emptyHeader}
        <FeedSkeleton count={3} label="your personalized feed" />
      </>
    );
  }

  const sectors = topSectors(preferences.sectorWeights);
  const hasTaste = interactions.length > 0;
  // Name the narrowed themes in the briefing/empty-state copy so "Emerging
  // themes (Rare earths)" reads truthfully instead of the generic label.
  const themeDetail =
    activeFilters.includes("emerging_themes") && preferences.forYouThemes?.length
      ? ` (${preferences.forYouThemes
          .map((s) => emergingThemeBySlug(s)?.label ?? s)
          .join(", ")})`
      : "";
  const activeLabels = activeFilters.map((id) => {
    const label = forYouFilterById(id)?.label ?? id;
    return id === "emerging_themes" ? `${label}${themeDetail}` : label;
  });
  const boardSize = ranked.length + backfill.length;

  return (
    <>
      <FeedTabHeader
        feed="for-you"
        action={
          hasTaste || filtersActive ? (
            <button className="btn btn--ghost btn--sm" onClick={reset}>
              Reset
            </button>
          ) : undefined
        }
      />

      <div className="card" style={{ padding: 18, marginBottom: 20 }}>
        <TradeHorizonPicker
          value={preferences.tradeHorizon ?? "swing_trading"}
          onChange={(h: TradeHorizon) => setTradeHorizon(h)}
        />
        <div className="row gap-2 wrap" style={{ rowGap: 10, marginTop: 16 }}>
          <span className="act-group-label">Your taste profile</span>
          <span className="pill">{TRADE_HORIZON_LABELS[preferences.tradeHorizon ?? "swing_trading"]}</span>
          <span className="pill">{styleLabel(preferences.styleTilt)}</span>
          <span className="pill">{riskLabel(preferences.riskAppetite)} risk</span>
          {sectors.length > 0 ? (
            sectors.map((s) => (
              <span className="pill pill--sector" key={s}>
                {s}
              </span>
            ))
          ) : (
            <span className="text-faint" style={{ fontSize: 13 }}>
              {hasTaste ? "Building your profile…" : "Like or tune any card to start personalizing."}
            </span>
          )}
          {preferences.likedTickers.length > 0 && (
            <span className="pill pill--confidence">{preferences.likedTickers.length} liked</span>
          )}
        </div>

        <ForYouFilterBar
          active={activeFilters}
          themeScope={preferences.forYouThemes}
          counts={counts}
          onToggleFilter={toggleForYouFilter}
          onToggleTheme={toggleForYouTheme}
          onAllThemes={setForYouThemesAll}
        />

        <div className="row gap-2 wrap" style={{ rowGap: 10, marginTop: 14, alignItems: "center" }}>
          <span className="act-group-label" title="Conservative favors larger, easy-to-trade companies and weighs risk more heavily; aggressive widens the search and tolerates more.">
            Risk dial
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={preferences.riskAppetite}
            onChange={(e) => setRiskAppetite(Number(e.target.value))}
            aria-label="Risk appetite"
            style={{ accentColor: "var(--accent)", flex: "1 1 160px", maxWidth: 240 }}
          />
          <span className="pill">
            {riskLabel(preferences.riskAppetite)} · {Math.round(preferences.riskAppetite * 100)}%
          </span>
        </div>
      </div>

      {ranked.length === 0 && !filtersActive ? (
        // Defensive only - with no filters, composeForYou re-ranks without
        // filtering, so this can't fire while signals exist.
        <FeedState title="Nothing to rank yet">
          Your personalized feed appears here once the first research run lands.
        </FeedState>
      ) : (
        <div className="feed-stage">
          {ranked.length > 0 ? (
            <>
              <FeedBriefing
                signals={shown.map((r) => r.signal)}
                label={filtersActive ? "Filtered for you" : "Tuned for you"}
                aside={<LivePriceControl tickers={shown.map((r) => r.signal.ticker)} />}
                note={[
                  filtersActive
                    ? `${ranked.length} of ${boardSize} scored names match ${activeLabels.join(" + ")}`
                    : `top ${shown.length} of ${ranked.length} ranked`,
                  hasTaste ? `${interactions.length} tune choices shaping this order` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
              <div className="feed feed--timeline">
                {shown.map((r, i) => (
                  <SignalCard
                    key={r.signal.id}
                    signal={r.signal}
                    index={i}
                    match={{ matchScore: r.matchScore, reasons: r.reasons }}
                    enableTuning
                  />
                ))}
              </div>
              {ranked.length > visible && (
                <button
                  type="button"
                  className="lb-more"
                  onClick={() => setVisible((v) => v + FEED_WINDOW)}
                >
                  Show {Math.min(FEED_WINDOW, ranked.length - visible)} more
                  <em className="mono">{ranked.length - visible} ranked below</em>
                </button>
              )}
            </>
          ) : (
            <FeedState title="No matches on today's board">
              None of the {boardSize} scored names match {activeLabels.join(" + ")} right now.
              Filters re-check automatically on every research run — or widen the theme scope /
              toggle a filter off to see more.
            </FeedState>
          )}

          {filtersActive && backfill.length > 0 && (
            <>
              {/* Not role="separator": it holds an interactive toggle, and a11y
                  trees flatten/hide interactive children of a separator (Codex QA
                  saw the toggle drop out of the tree). Plain container + the visible
                  label span keep the meaning; the button is now a first-class node. */}
              <div className="fy-divider">
                <span className="fy-divider__label">Beyond your filters</span>
                <button
                  type="button"
                  className="fy-divider__toggle"
                  onClick={() => setShowBackfill((v) => !v)}
                >
                  {showBackfill ? "Hide" : `Show the rest of the board (${backfill.length})`}
                </button>
              </div>
              {showBackfill && (
                <div className="feed feed--timeline fy-backfill">
                  {backfill.slice(0, BACKFILL_WINDOW).map((r, i) => (
                    <SignalCard
                      key={r.signal.id}
                      signal={r.signal}
                      index={i}
                      match={{ matchScore: r.matchScore, reasons: r.reasons }}
                      enableTuning
                    />
                  ))}
                  {backfill.length > BACKFILL_WINDOW && (
                    <p className="text-faint" style={{ fontSize: 13, textAlign: "center" }}>
                      Top {BACKFILL_WINDOW} of {backfill.length} shown — clear filters to explore the
                      whole board.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/* Watch-outs at the BOTTOM of every feed tab (owner request 2026-06-21) - a risk
              footer under the picks, identical placement to Today. */}
          <WatchOutsStrip signals={signals} ownedTickers={ownedTickers} />
        </div>
      )}
    </>
  );
}
