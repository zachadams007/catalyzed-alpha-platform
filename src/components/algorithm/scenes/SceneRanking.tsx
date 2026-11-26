import { useMemo, useRef } from "react";
import { useScrubScene } from "@/viz/useStoryScroll";
import {
  ACTIVE_VARIANT,
  CHALLENGER_CATALYST_BLEND,
  CHALLENGER_REFINEMENTS,
  CHALLENGER_REFINEMENT_COUNT_WORD,
  FEED_RULES,
  PERSONALIZATION_BOOSTS,
  V4_ARCHETYPE_EXPLANATION,
  V4_IS_LIVE,
  lineageIdForVariant,
  V4_REGIME_TILT,
  stageLabel,
} from "@/viz/pipelineModel";
import { runsCatalystDrivenProfile } from "@/engine/challenger";
import { useActiveVariant } from "@/hooks/useActiveVariant";
import { researchRankScore } from "@/engine/ranking";
import { useAppStore } from "@/store/useAppStore";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * Chapter 5 - ranking & the feedback loop. The scored board cascades into the
 * real feeds: Today (top 8, soft ≤3-per-sector), Weekly (top 16, ≤4/sector), and For You
 * - the only feed that reacts to you. With live signals the rows are REAL
 * tickers and the sector cull is computed from the actual lineup.
 */

interface RankRow {
  ticker: string;
  score: number;
  sector: string;
  dest: "today" | "weekly" | "cull";
}

const SAMPLE_ROWS: RankRow[] = [
  { ticker: "IONQ", score: 71, sector: "Technology", dest: "today" },
  { ticker: "RKLB", score: 68, sector: "Industrials", dest: "today" },
  { ticker: "SOUN", score: 66, sector: "Technology", dest: "today" },
  { ticker: "BBAI", score: 64, sector: "Technology", dest: "cull" },
  { ticker: "CRSP", score: 63, sector: "Healthcare", dest: "today" },
  { ticker: "ASTS", score: 61, sector: "Communications", dest: "today" },
  { ticker: "ACHR", score: 59, sector: "Industrials", dest: "today" },
  { ticker: "ENPH", score: 57, sector: "Energy", dest: "today" },
  { ticker: "MARA", score: 56, sector: "Financials", dest: "today" },
  { ticker: "BEAM", score: 54, sector: "Healthcare", dest: "weekly" },
];

export function SceneRanking({
  scroller,
  data,
}: {
  scroller: HTMLElement | null;
  data: StoryData;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const signals = useAppStore((s) => s.signals);

  const rows: RankRow[] = useMemo(() => {
    if (!data.hasSignals) return SAMPLE_ROWS;
    const todaySet = new Set(data.today.map((s) => s.ticker));
    return [...signals]
      .sort((a, b) => researchRankScore(b) - researchRankScore(a))
      .slice(0, 10)
      .map((s, i) => ({
        ticker: s.ticker,
        score: s.score.opportunityScore,
        sector: s.sector,
        dest: todaySet.has(s.ticker)
          ? ("today" as const)
          : i < FEED_RULES.today.limit
            ? ("cull" as const)
            : ("weekly" as const),
      }));
  }, [data.hasSignals, data.today, signals]);

  const likeRows = rows.slice(0, 3);
  const cullRow = rows.find((r) => r.dest === "cull");

  useScrubScene(
    scroller,
    ref,
    (tl, q) => {
      // Destination tags are data-dependent (a lineup may have no plain
      // "Weekly" rows, or no culls) - only tween the ones that rendered.
      const fromIf = (sel: string, vars: gsap.TweenVars, at: number) => {
        const targets = q(sel);
        if (targets.length > 0) tl.from(targets, vars, at);
      };

      tl.from(
        q(".rank-row"),
        { opacity: 0, y: 18, stagger: 0.055, duration: 0.35 },
        0,
      );
      fromIf(
        ".rank-row__dest--today",
        { opacity: 0, scale: 0.7, stagger: 0.05, duration: 0.25 },
        0.6,
      );
      fromIf(".rank-row__dest--cull", { opacity: 0, x: -8, duration: 0.35 }, 1.0);
      const culled = q(".rank-row--cull");
      if (culled.length > 0) {
        tl.to(culled, { opacity: 0.55, x: 10, duration: 0.35 }, 1.05);
      }
      fromIf(
        ".rank-row__dest--weekly",
        { opacity: 0, scale: 0.7, stagger: 0.05, duration: 0.25 },
        1.2,
      );
      tl.from(q(".rank-feeds__fact"), { opacity: 0, y: 10, stagger: 0.08, duration: 0.3 }, 1.3)
        // For You beat: tap → boost chip → re-rank → loop back to preferences.
        .from(q(".fy-panel"), { opacity: 0, y: 24, duration: 0.45 }, 1.55)
        .from(q(".fy-heart"), { scale: 0, duration: 0.3, ease: "back.out(2.5)" }, 1.95)
        .from(q(".fy-boost"), { opacity: 0, y: 8, duration: 0.3 }, 2.1)
        .to(q(".fy-row--liked"), { y: -44, duration: 0.45, ease: "power2.inOut" }, 2.3)
        .to(q(".fy-row--displaced"), { y: 44, duration: 0.45, ease: "power2.inOut" }, 2.3)
        .from(q(".fy-loop"), { strokeDashoffset: 420, duration: 0.5, ease: "none" }, 2.45)
        .from(q(".fy-prefs"), { opacity: 0, scale: 0.85, duration: 0.3 }, 2.7)
        .from(q(".fy-reason"), { opacity: 0, duration: 0.3 }, 2.8);
    },
    { end: "+=240%" },
    [rows.map((r) => r.ticker).join(",")],
  );

  const liveLabel = lineageIdForVariant(useActiveVariant()).toUpperCase();
  return (
    <section ref={ref} className="algo-scene algo-scene--ranking" id="algo-ranking">
      <div className="algo-scene__stage">
        <header className="algo-scene__head">
          <p className="algo-eyebrow">Ranking · “{stageLabel("rank")}”</p>
          <h2 className="algo-headline">The board becomes your feeds</h2>
          <p className="algo-dek">
            Signals rank by opportunity with a light evidence tilt, then split:
            Today takes the top {FEED_RULES.today.limit} with a soft{" "}
            {FEED_RULES.today.sectorCap}-per-sector cap, Weekly takes the top{" "}
            {FEED_RULES.weekly.limit} — and For You re-ranks around{" "}
            <em>you</em>.
            {!data.hasSignals ? " Representative lineup shown — scan the market for the real one." : null}
          </p>
          <p className="rank-live-note mono" role="note">
            ▸ first every dimension is re-scored across the whole universe —
            size-residualized &amp; sector-neutral — then a bounded small/mid
            tilt rebalances by size, so a catalyzed small-cap can out-rank a
            covered megacap. The live {liveLabel} engine &amp; the
            shadow model both run this pass.
          </p>
          {runsCatalystDrivenProfile(ACTIVE_VARIANT) ? (
            <div className="rank-champion" role="note">
              <span className="rank-champion__tag mono">Live V4 engine adds</span>
              <ul className="rank-champion__list">
                <li>
                  <strong>Soft thesis gate</strong> — demotes names with no
                  reason to move, over the same gentle anti-megacap tilt, its
                  catalyst/discount tilts size-balanced for an even mix
                </li>
                {V4_IS_LIVE ? (
                  <>
                    <li>
                      <strong>V4 archetypes</strong> -{" "}
                      {V4_ARCHETYPE_EXPLANATION.map((r) => (
                        <span key={r.id} className="rank-champion__chip mono">
                          {r.label}
                        </span>
                      ))}
                    </li>
                    <li>
                      <strong>{V4_REGIME_TILT.label}</strong> - SPY trend + breadth lean the
                      ranker toward value, quality, and low volatility in risk-off tape
                    </li>
                  </>
                ) : null}
                <li>
                  <strong>Catalyst-driven blend</strong> —{" "}
                  {CHALLENGER_CATALYST_BLEND.map((r) => (
                    <span key={r.id} className="rank-champion__chip mono">
                      {r.label}
                    </span>
                  ))}
                </li>
                <li>
                  <strong>{CHALLENGER_REFINEMENT_COUNT_WORD} time-aware signals</strong> —{" "}
                  {CHALLENGER_REFINEMENTS.map((r) => (
                    <span key={r.id} className="rank-champion__chip mono">
                      {r.label}
                    </span>
                  ))}
                </li>
              </ul>
            </div>
          ) : null}
          {data.hasSignals ? (
            <p className="rank-live-note mono" role="status">
              ▸ live board — this run’s {data.signalCount} scored names, the very
              lineup powering Today &amp; Weekly right now
            </p>
          ) : null}
        </header>

        <div className="rank-grid">
          <div className="rank-board" aria-label="Ranked signals">
            {rows.map((row, i) => (
              <div
                key={row.ticker}
                className={`rank-row${row.dest === "cull" ? " rank-row--cull" : ""}`}
              >
                <span className="rank-row__pos mono">{i + 1}</span>
                <span className="rank-row__ticker mono">{row.ticker}</span>
                <span className="rank-row__sector">{row.sector}</span>
                <span className="rank-row__score mono">{row.score}</span>
                {row.dest === "today" ? (
                  <span className="rank-row__dest rank-row__dest--today">Today</span>
                ) : row.dest === "cull" ? (
                  <span className="rank-row__dest rank-row__dest--cull">
                    sector cap → Weekly
                  </span>
                ) : (
                  <span className="rank-row__dest rank-row__dest--weekly">Weekly</span>
                )}
              </div>
            ))}
            <div className="rank-feeds">
              <p className="rank-feeds__fact">
                <strong>Today</strong> top {FEED_RULES.today.limit} · ≤
                {FEED_RULES.today.sectorCap} per sector (soft — tops up if thin)
              </p>
              <p className="rank-feeds__fact">
                <strong>Weekly</strong> top {FEED_RULES.weekly.limit} by rank
              </p>
              {cullRow ? (
                <p className="rank-feeds__fact rank-feeds__fact--cull">
                  {cullRow.ticker} hit the {cullRow.sector} cap — diversity kept
                  the lineup from going single-sector
                </p>
              ) : null}
            </div>
          </div>

          <div className="fy-panel" aria-label="For You feedback loop">
            <div className="fy-head">
              <p className="fy-title">For You — the loop</p>
              <span className="fy-prefs">Preferences</span>
            </div>
            <svg className="fy-svg" viewBox="0 0 320 60" aria-hidden="true">
              <path
                className="fy-loop"
                d="M 36 56 C 30 18, 200 2, 292 14"
                strokeDasharray={420}
              />
            </svg>
            <div className="fy-rows">
              {likeRows.map((row, i) => (
                <div
                  key={row.ticker}
                  className={`fy-row${i === 1 ? " fy-row--liked" : ""}${i === 0 ? " fy-row--displaced" : ""}`}
                >
                  <span className="mono">{row.ticker}</span>
                  <span className="fy-row__sector">{row.sector}</span>
                  {i === 1 ? (
                    <>
                      <span className="fy-heart" aria-hidden="true">♥</span>
                      <span className="fy-boost mono">+14 You liked this</span>
                    </>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="fy-reason">
              Likes nudge sector & catalyst affinity; “more like this” boosts
              caps; mutes subtract 30. Every tap re-ranks this feed — and after
              each run your own portfolio’s wins and losses nudge it too.
            </p>
            <ul className="fy-boosts" aria-label="Personalization boosts">
              {PERSONALIZATION_BOOSTS.slice(0, 5).map((b) => (
                <li key={b.id}>
                  {b.label} <span className="mono">{b.effect}</span>
                </li>
              ))}
              <li>
                Liked <span className="mono">+14</span> · Muted{" "}
                <span className="mono">−30</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
