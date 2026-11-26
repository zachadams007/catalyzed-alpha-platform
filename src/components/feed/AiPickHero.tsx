import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ScoreRing } from "@/components/common/ScoreRing";
import { fetchTodayAiPicks, fetchRecentAiPicks } from "@/data/aiPick/fetchAiPicks";
import { marketDayKey } from "@/data/dailySignalsCache";
import { readCachedAiPicks, writeCachedAiPicks } from "@/data/dailySignalsIdbCache";
import type { AiPick } from "@/data/aiPick/types";
import { useAppStore } from "@/store/useAppStore";
import { stripSourceUrls } from "@/lib/format";

/**
 * AI Pick of the Day - the AI-only exclusive hero tile at the TOP of the feed.
 *
 * Shows up to 3 picks (hero rank 0 + runners rank 1, 2) in a single tile with a
 * segmented pill-tab selector at the top. Switching picks plays a crossfade +
 * slide animation. Each view is the full AI report - catalyst, score, thesis,
 * chips, dated source link, and the expandable bull/bear/skeptic debate.
 *
 * Data: fetchTodayAiPicks() → fetchRecentAiPicks() fallback (both return AiPick[]).
 * Shows nothing until picks land; degrades silently on errors.
 */

/* ── catalyst label map ─────────────────────────────────────────────────── */
const CATALYST_LABEL: Record<string, string> = {
  earnings: "Earnings",
  fda: "FDA",
  insider_buy: "Insider buy",
  ma: "M&A",
  political: "Political",
  guidance: "Guidance",
  other: "Catalyst",
};

function catalystLabel(t: string): string {
  return CATALYST_LABEL[t] ?? "Catalyst";
}

/* ── skeleton ────────────────────────────────────────────────────────────── */
function AiPickSkeleton() {
  return (
    <div className="aipick aipick--skeleton" aria-busy="true" aria-label="Loading AI Pick">
      <div className="aipick__glow" aria-hidden="true" />
      {/* fake tabs */}
      <div className="aipick__tabs-row" aria-hidden="true">
        <div className="skeleton-line" style={{ width: 56, height: 26, borderRadius: 999 }} />
        <div className="skeleton-line" style={{ width: 56, height: 26, borderRadius: 999 }} />
        <div className="skeleton-line" style={{ width: 56, height: 26, borderRadius: 999 }} />
      </div>
      <div className="skeleton-line" style={{ width: "32%", height: 14, marginTop: 18 }} />
      <div className="skeleton-line" style={{ width: "55%", height: 32, marginTop: 12 }} />
      <div className="skeleton-line" style={{ width: "90%", height: 14, marginTop: 14 }} />
      <div className="skeleton-line" style={{ width: "76%", height: 14, marginTop: 7 }} />
    </div>
  );
}

/* ── debate section (expandable) ────────────────────────────────────────── */
interface DebateProps {
  pick: AiPick;
}
function Debate({ pick }: DebateProps) {
  const [open, setOpen] = useState(false);
  const hasContent = pick.bull_case || pick.bear_case || pick.skeptic_note;
  if (!hasContent) return null;

  return (
    <div className="aipick__debate-wrap">
      <button
        type="button"
        className="aipick__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon className={`aipick__chevron${open ? " is-open" : ""}`} />
        {open ? "Hide the debate" : "Why — bull, bear & the skeptic"}
      </button>
      {open && (
        <div className="aipick__debate" role="region" aria-label="Bull bear skeptic debate">
          {pick.bull_case && (
            <div className="aipick__case aipick__case--bull">
              <span className="aipick__case-label">Bull</span>
              <p>{pick.bull_case}</p>
            </div>
          )}
          {pick.bear_case && (
            <div className="aipick__case aipick__case--bear">
              <span className="aipick__case-label">Bear</span>
              <p>{pick.bear_case}</p>
            </div>
          )}
          {pick.skeptic_note && (
            <div className="aipick__case aipick__case--skeptic">
              <span className="aipick__case-label">Skeptic — what must be false</span>
              <p>{pick.skeptic_note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── individual pick body ───────────────────────────────────────────────── */
interface PickBodyProps {
  pick: AiPick;
  animKey: number;
  dir: "left" | "right";
}
function PickBody({ pick, animKey, dir }: PickBodyProps) {
  const conf = Math.round((pick.confidence ?? 0) * 100);
  const horizon = `${pick.horizon_days}-day swing`;

  // Show the EXACT same 0-100 score the rest of the app shows for this ticker.
  // The detail page (/signal/:ticker) renders the live board's decompressed
  // opportunityScore, so prefer that when the pick is on the board - it stays in
  // lock-step even if the board rescanned after the pick was stored. Falls back to
  // the stored engine_score for a fresh name that isn't on today's board.
  const boardScore = useAppStore(
    (s) => s.signals.find((x) => x.ticker === pick.ticker)?.score.opportunityScore,
  );
  const displayScore = boardScore ?? pick.engine_score;

  return (
    <div
      key={animKey}
      className={`aipick__pick-body aipick__pick-body--${dir}`}
      aria-live="polite"
    >
      <div className="aipick__body">
        <div className="aipick__main">
          {/* Large ticker - links to stock detail */}
          <Link to={`/signal/${pick.ticker}`} className="aipick__ticker mono">
            {pick.ticker}
          </Link>

          {/* Full catalyst write-up */}
          <p className="aipick__thesis">{stripSourceUrls(pick.catalyst_summary)}</p>

          {/* Chips row */}
          <div className="aipick__meta">
            <span className="aipick__chip aipick__chip--cat">
              {catalystLabel(pick.catalyst_type)}
            </span>
            <span className="aipick__chip">{horizon}</span>
            <span className="aipick__chip">{conf}% conviction</span>
            {pick.macro_driven && (
              <span className="aipick__chip aipick__chip--warn">Macro-driven — higher risk</span>
            )}
            {pick.primary_source_url && (
              <a
                className="aipick__source"
                href={pick.primary_source_url}
                target="_blank"
                rel="noreferrer noopener"
              >
                Source ↗
              </a>
            )}
          </div>
        </div>

        {/* Score ring - the SAME 0-100 engine score every card/detail page uses
            (live board score when on the board, else the stored engine_score);
            never a separate blended "AI score". */}
        <Link
          to={`/signal/${pick.ticker}`}
          className="aipick__ring"
          aria-label={`Open ${pick.ticker} details`}
          tabIndex={-1}
        >
          <ScoreRing score={displayScore} size={88} label="Score" />
        </Link>
      </div>

      {/* Expandable debate */}
      <Debate pick={pick} />
    </div>
  );
}

/* ── main component ─────────────────────────────────────────────────────── */
export function AiPickHero() {
  const [picks, setPicks] = useState<AiPick[] | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [animKey, setAnimKey] = useState(0);
  const [dir, setDir] = useState<"left" | "right">("right");
  const tabListRef = useRef<HTMLDivElement>(null);
  const navId = useId();

  useEffect(() => {
    let alive = true;
    void (async () => {
      // STALE-WHILE-REVALIDATE. The picks are published once a day, but the
      // ai-pick writer can legitimately re-run and replace today's rows, so a
      // cached copy is a FIRST PAINT, never the final word. Paint it instantly
      // (no skeleton flash on the 2nd+ open of the day), then fetch, and only
      // re-render if the network answer actually differs. A cache miss - first
      // open, private browsing, no IndexedDB - falls through to the exact
      // network path that existed before, skeleton and all.
      const today = marketDayKey();
      const cached = await readCachedAiPicks<AiPick>(today).catch(() => null);
      if (alive && cached && cached.length > 0) setPicks(cached);

      let p = await fetchTodayAiPicks();
      if (p.length === 0) p = await fetchRecentAiPicks();
      if (!alive) return;
      // Cheap structural equality: same tickers in the same rank order with the
      // same generation timestamps means nothing the user can see has changed.
      const sig = (rows: AiPick[]) =>
        [...rows].sort((a, b) => a.rank - b.rank).map((r) => `${r.rank}:${r.ticker}:${r.created_at}`).join("|");
      if (!cached || sig(cached) !== sig(p)) setPicks(p);
      // Write-through under the rows' OWN market day (a recent-day fallback
      // caches under its real day, so tomorrow's read for "today" still misses).
      const day = p[0]?.market_day;
      if (day) void writeCachedAiPicks(day, p);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (picks === null) return <AiPickSkeleton />;
  if (picks.length === 0) return null;

  // Sort by rank to guarantee 0→1→2 order
  const sorted = [...picks].sort((a, b) => a.rank - b.rank);
  const activePick = sorted[activeIdx] ?? sorted[0]!;

  function switchTo(idx: number) {
    if (idx === activeIdx) return;
    setDir(idx > activeIdx ? "right" : "left");
    setActiveIdx(idx);
    setAnimKey((k) => k + 1);
  }

  // Keyboard nav: arrow keys on the tab list
  function handleTabKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = (idx + 1) % sorted.length;
      switchTo(next);
      const btns = tabListRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
      btns?.[next]?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = (idx - 1 + sorted.length) % sorted.length;
      switchTo(prev);
      const btns = tabListRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
      btns?.[prev]?.focus();
    }
  }

  const tabPanelId = `${navId}-panel`;

  return (
    <section className="aipick" aria-label="AI Pick of the Day">
      {/* Ambient glow */}
      <div className="aipick__glow" aria-hidden="true" />

      {/* Header row: badge + eyebrow */}
      <header className="aipick__head">
        <span className="aipick__badge">
          <SparkIcon />
          AI Pick
        </span>
        <span className="aipick__eyebrow">Pick of the Day · scanned from the news</span>
      </header>

      {/* Pill-tab selector (only when > 1 pick) */}
      {sorted.length > 1 && (
        <div
          ref={tabListRef}
          className="aipick__tabs-row"
          role="tablist"
          aria-label="Select pick"
        >
          {sorted.map((pick, idx) => (
            <button
              key={pick.ticker}
              type="button"
              role="tab"
              aria-selected={idx === activeIdx}
              aria-controls={tabPanelId}
              id={`${navId}-tab-${idx}`}
              className={`aipick__tab${idx === activeIdx ? " is-active" : ""}`}
              onClick={() => switchTo(idx)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              tabIndex={idx === activeIdx ? 0 : -1}
            >
              <span className="aipick__tab-rank">
                {idx === 0 ? "Today" : `#${idx + 1}`}
              </span>
              <span className="aipick__tab-ticker mono">{pick.ticker}</span>
            </button>
          ))}
        </div>
      )}

      {/* Pick content - animated on switch */}
      <div
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={`${navId}-tab-${activeIdx}`}
        className="aipick__panel"
      >
        <PickBody
          key={animKey}
          pick={activePick}
          animKey={animKey}
          dir={dir}
        />
      </div>
    </section>
  );
}

/* ── icons ──────────────────────────────────────────────────────────────── */
function SparkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M12 2l2.2 6.3L20.5 11l-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2L12 2z"
        fill="currentColor"
      />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
