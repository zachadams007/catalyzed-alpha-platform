import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { springs } from "@/lib/motionTokens";
import { IconPlus } from "@/components/icons";
import { formatMarketCap } from "@/lib/format";
import type {
  Portfolio,
  RankingMode,
  ScreenFitComponents,
  ScreenMatch,
  StockSignal,
} from "@/types";

/**
 * The Blueprint live leaderboard - the hero of the Gate Deck. Matches re-rank
 * as criteria change: survivors travel to their new position (layout
 * animation) with ▲/▼ movement badges, newcomers flash NEW, and culled names
 * exit - the exact gate that killed them reported in the cut strip (computed
 * by the engine's own evaluateScreenGates, so the explanation can never lie).
 *
 * AI-discovered names ride the SAME blended board (a small "AI boosted" badge), never a separate
 * panel. The board windows long universes (hundreds of names) behind "Show more".
 */

export interface ScreenCut {
  ticker: string;
  gateLabel: string;
  actual: string;
  required: string;
  /** Unique per event so repeat cuts of one ticker still render. */
  id: string;
}

export function CutStrip({ cuts }: { cuts: ScreenCut[] }) {
  if (cuts.length === 0) return null;
  return (
    <div className="cut-strip" aria-label="Names cut by the last change" role="log">
      <AnimatePresence mode="popLayout">
        {cuts.map((cut) => (
          <motion.span
            key={cut.id}
            layout
            className="cut-chip"
            initial={{ opacity: 0, y: -8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={springs.snappy}
          >
            <span className="cut-chip__x">✕</span>
            <span className="mono cut-chip__ticker">{cut.ticker}</span>
            <span className="cut-chip__gate">
              {cut.gateLabel}: {cut.actual}
              <em> (need {cut.required})</em>
            </span>
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Inspector - score anatomy (9 categories) + fit lanes + missed gates.
 * ------------------------------------------------------------------------- */

const FIT_LANES: Array<{ key: keyof ScreenFitComponents; label: string }> = [
  { key: "filters", label: "Filters + horizon" },
  { key: "theme", label: "Theme" },
  { key: "description", label: "Description" },
  { key: "fundamentals", label: "Quality" },
  { key: "hype", label: "Attention" },
  { key: "ai", label: "AI relevance" },
];

/** Which fit lanes the active ranking mode actually reads (mirrors modeFitScore). */
function activeLaneKeys(mode: RankingMode, comp: ScreenFitComponents): Set<string> {
  switch (mode) {
    case "fundamentals":
      return new Set(["fundamentals"]);
    case "ai":
      return comp.ai != null ? new Set(["ai"]) : new Set(["description", "theme"]);
    case "blended":
    default:
      return new Set(FIT_LANES.map((l) => l.key));
  }
}

/** "$253B · Mega", or a faint "cap - " when the size is a genuine data gap. */
function capLine(signal: StockSignal): { text: string; unknown: boolean } {
  if (!signal.marketCap || signal.marketCap <= 0 || signal.marketCapBucket === "Unknown") {
    return { text: "cap —", unknown: true };
  }
  return { text: `${formatMarketCap(signal.marketCap)} · ${signal.marketCapBucket}`, unknown: false };
}

function MatchInspector({ match }: { match: ScreenMatch }) {
  const { signal, components, mode } = match;
  const activeLanes = activeLaneKeys(mode, components);
  return (
    <div className="lb-inspector">
      <div className="lb-inspector__col">
        <span className="lb-inspector__title">Score anatomy — 9 categories</span>
        <div className="lb-inspector__cats">
          {signal.score.categories.map((cat) => (
            <div key={cat.key} className="lb-cat" title={cat.explanation}>
              <span className="lb-cat__label">{cat.label}</span>
              <span className="lb-cat__weight mono">×{Math.round(cat.weight * 100)}%</span>
              <span className="lb-cat__track">
                <span className="lb-cat__fill" style={{ width: `${cat.score}%` }} />
              </span>
              <span className="lb-cat__score mono">{Math.round(cat.score)}</span>
            </div>
          ))}
        </div>
        <div className="lb-inspector__axes">
          <p className="lb-meta">
            <span>Risk penalty</span>
            <span className="mono lb-meta__risk">−{signal.score.riskPenalty}</span>
          </p>
          <p className="lb-meta">
            <span>Opportunity</span>
            <span className="mono">{signal.score.opportunityScore}</span>
          </p>
          <p className="lb-meta">
            <span>Confidence</span>
            <span className="mono lb-meta__conf">{signal.confidence}</span>
          </p>
        </div>
      </div>

      <div className="lb-inspector__col">
        <span className="lb-inspector__title">Fit lanes — why it ranks here</span>
        <div className="lb-inspector__lanes">
          {FIT_LANES.map((lane) => {
            const value = components[lane.key];
            if (value == null) return null;
            const on = activeLanes.has(lane.key);
            return (
              <div key={lane.key} className={`lb-lane${on ? " lb-lane--on" : ""}`}>
                <span className="lb-lane__label">{lane.label}</span>
                <span className="lb-lane__track">
                  <span className="lb-lane__fill" style={{ width: `${value}%` }} />
                </span>
                <span className="lb-lane__score mono">{value}</span>
              </div>
            );
          })}
        </div>
        {match.weakMatch && match.failedGates.length > 0 ? (
          <div className="lb-inspector__gates">
            <span className="lb-inspector__title">Missed gates</span>
            {match.failedGates.map((g) => (
              <p key={g.key} className="lb-gate-miss">
                <span className="lb-gate-miss__x" aria-hidden>
                  ✕
                </span>
                <span className="lb-gate-miss__label">{g.label}</span>
                <span className="mono">{g.actual}</span>
                <em className="mono">need {g.required}</em>
              </p>
            ))}
          </div>
        ) : (
          <p className="lb-inspector__why">{signal.score.confidenceExplanation}</p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Row
 * ------------------------------------------------------------------------- */

type RankDelta = number | "new";

function BoardRow({
  match,
  rank,
  delta,
  researched,
  isOpen,
  onToggle,
  portfolios,
  onAddToPortfolio,
}: {
  match: ScreenMatch;
  rank: number;
  /** Rank movement on the main board; null in the "missed the cut" section. */
  delta: RankDelta | null;
  researched: boolean;
  isOpen: boolean;
  onToggle: () => void;
  portfolios: Portfolio[];
  onAddToPortfolio: (portfolioId: string, signal: StockSignal) => void;
}) {
  const { signal } = match;
  const topReason = match.reasons[0];
  const cap = capLine(signal);
  return (
    <motion.article
      key={signal.ticker}
      layout="position"
      className={`lb-row${isOpen ? " lb-row--open" : ""}${match.weakMatch ? " lb-row--weak" : ""}`}
      initial={{ opacity: 0, y: 22, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 32, scale: 0.97 }}
      transition={springs.gentle}
    >
      <button
        type="button"
        className="lb-row__main"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="lb-row__rank mono">{rank}</span>
        <span
          className={`lb-row__delta mono${
            delta === "new"
              ? " is-new"
              : delta != null && delta > 0
                ? " is-up"
                : delta != null && delta < 0
                  ? " is-down"
                  : ""
          }`}
          title={
            delta === "new"
              ? "New on the board since the last retune"
              : delta == null
                ? "Cut by the screen"
                : delta === 0
                  ? "Held rank"
                  : delta > 0
                    ? `Climbed ${delta} on the last retune`
                    : `Slipped ${Math.abs(delta)} on the last retune`
          }
        >
          {delta === "new"
            ? "NEW"
            : delta == null || delta === 0
              ? "·"
              : delta > 0
                ? `▲${delta}`
                : `▼${Math.abs(delta)}`}
        </span>
        <span className="lb-row__ticker mono">{signal.ticker}</span>
        {/* AI badge lives INSIDE the name cell - keeping it out of the grid flow
            so the optional badge can't shift every following column. */}
        <span className="lb-row__name">
          <span className="lb-row__name-text">{signal.name}</span>
          {researched ? <span className="lb-row__ai">AI boosted</span> : null}
        </span>
        {/* Sector + real market cap / tier - so a demotion is self-evidently
            correct (e.g. "MRVL · $253B · Mega" misses a Micro filter) instead of
            an unexplained red chip. */}
        <span className="lb-row__sector">
          <span className="lb-row__sector-name">{signal.sector}</span>
          <span className={`lb-row__cap mono${cap.unknown ? " lb-row__cap--unknown" : ""}`}>
            {cap.text}
          </span>
        </span>
        {/* Stable slot (gates / reason / empty) so the column count is constant. */}
        <span className="lb-row__signal">
          {match.weakMatch && match.failedGates.length > 0 ? (
            <span className="lb-row__gates">
              {match.failedGates.slice(0, 2).map((g) => (
                <span key={g.key} className="lb-gate-tag">
                  <i aria-hidden>✕</i>
                  {g.label}
                </span>
              ))}
              {match.failedGates.length > 2 ? (
                <span className="lb-gate-tag lb-gate-tag--more mono">
                  +{match.failedGates.length - 2}
                </span>
              ) : null}
            </span>
          ) : topReason ? (
            <span className="lb-row__reason">{topReason}</span>
          ) : null}
        </span>
        <span className="lb-row__fit">
          <span className="lb-row__fit-num mono">
            <span className="lb-row__fit-val">{match.fitScore}</span>
            <em>fit</em>
          </span>
          <span className="lb-row__fit-track">
            <span className="lb-row__fit-fill" style={{ width: `${match.fitScore}%` }} />
          </span>
        </span>
        <span className="lb-row__chev" aria-hidden="true">
          {isOpen ? "−" : "+"}
        </span>
      </button>

      {isOpen ? (
        <motion.div
          className="lb-row__detail"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          <div className="lb-row__reasons">
            {match.reasons.map((reason) => (
              <span key={reason} className="reason">
                {reason}
              </span>
            ))}
          </div>
          <MatchInspector match={match} />
          <div className="lb-row__actions">
            <Link to={`/signal/${signal.ticker}`} className="btn btn--ghost btn--sm">
              Full card →
            </Link>
            {portfolios.slice(0, 3).map((pf) => (
              <button
                key={pf.id}
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onAddToPortfolio(pf.id, signal)}
              >
                <IconPlus size={13} /> {pf.name}
              </button>
            ))}
          </div>
        </motion.div>
      ) : null}
    </motion.article>
  );
}

/* ---------------------------------------------------------------------------
 * Board
 * ------------------------------------------------------------------------- */

const BOARD_WINDOW = 50;

export function LiveLeaderboard({
  matches,
  researchedTickers,
  portfolios,
  onAddToPortfolio,
}: {
  matches: ScreenMatch[];
  researchedTickers: ReadonlySet<string>;
  portfolios: Portfolio[];
  onAddToPortfolio: (portfolioId: string, signal: StockSignal) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visible, setVisible] = useState(BOARD_WINDOW);
  const [missedVisible, setMissedVisible] = useState(BOARD_WINDOW);
  const [showMissed, setShowMissed] = useState(false);
  const prevRanks = useRef<Map<string, number> | null>(null);
  const [deltas, setDeltas] = useState<ReadonlyMap<string, RankDelta>>(() => new Map());

  // A screener screens: passers are the board; names that miss an active hard
  // filter are hard-removed into the collapsed "missed the cut" section.
  const { passers, missed } = useMemo(() => {
    const pass: ScreenMatch[] = [];
    const miss: ScreenMatch[] = [];
    for (const m of matches) (m.weakMatch ? miss : pass).push(m);
    return { passers: pass, missed: miss };
  }, [matches]);

  // Rank movement vs the PREVIOUS board - over the PASSERS (the visible board),
  // computed once per re-rank so badges survive unrelated re-renders.
  useEffect(() => {
    const prev = prevRanks.current;
    const next = new Map<string, RankDelta>();
    passers.forEach((m, i) => {
      const p = prev?.get(m.signal.ticker);
      next.set(m.signal.ticker, p == null ? (prev ? "new" : 0) : p - i);
    });
    setDeltas(next);
    prevRanks.current = new Map(passers.map((m, i) => [m.signal.ticker, i]));
  }, [passers]);

  const toggle = (ticker: string) => setExpanded((cur) => (cur === ticker ? null : ticker));

  const shownPassers = passers.slice(0, visible);
  const hiddenPassers = passers.length - shownPassers.length;
  const shownMissed = missed.slice(0, missedVisible);
  const hiddenMissed = missed.length - shownMissed.length;

  return (
    <MotionConfig reducedMotion="user">
      <div className="lb-board">
        <AnimatePresence mode="popLayout" initial={false}>
          {shownPassers.map((match, i) => (
            <BoardRow
              key={match.signal.ticker}
              match={match}
              rank={i + 1}
              delta={deltas.get(match.signal.ticker) ?? 0}
              researched={researchedTickers.has(match.signal.ticker)}
              isOpen={expanded === match.signal.ticker}
              onToggle={() => toggle(match.signal.ticker)}
              portfolios={portfolios}
              onAddToPortfolio={onAddToPortfolio}
            />
          ))}
        </AnimatePresence>

        {passers.length === 0 ? (
          <div className="lb-empty" role="status">
            <span className="lb-empty__title">No names pass your filters yet</span>
            <span className="lb-empty__hint">
              Your filters screened out the current universe. Loosen a filter, or run the
              AI to discover names that fit — they’ll appear here, ranked.
            </span>
          </div>
        ) : null}

        {hiddenPassers > 0 ? (
          <button type="button" className="lb-more" onClick={() => setVisible((v) => v + BOARD_WINDOW)}>
            Show {Math.min(BOARD_WINDOW, hiddenPassers)} more
            <em className="mono">{hiddenPassers} below board</em>
          </button>
        ) : visible > BOARD_WINDOW && passers.length > BOARD_WINDOW ? (
          <button
            type="button"
            className="lb-more lb-more--collapse"
            onClick={() => setVisible(BOARD_WINDOW)}
          >
            Collapse to top {BOARD_WINDOW}
          </button>
        ) : null}

        {missed.length > 0 ? (
          <div className="lb-missed">
            <button
              type="button"
              className="lb-missed__toggle"
              onClick={() => setShowMissed((s) => !s)}
              aria-expanded={showMissed}
            >
              <span className="lb-missed__chev" aria-hidden>
                {showMissed ? "▾" : "▸"}
              </span>
              <span className="lb-missed__label">Missed the cut</span>
              <span className="lb-missed__count mono">{missed.length}</span>
              <span className="lb-missed__hint">
                {showMissed ? "screened out by your filters" : "screened out — tap to review"}
              </span>
            </button>

            {showMissed ? (
              <div className="lb-missed__list">
                <AnimatePresence mode="popLayout" initial={false}>
                  {shownMissed.map((match, i) => (
                    <BoardRow
                      key={match.signal.ticker}
                      match={match}
                      rank={i + 1}
                      delta={null}
                      researched={researchedTickers.has(match.signal.ticker)}
                      isOpen={expanded === match.signal.ticker}
                      onToggle={() => toggle(match.signal.ticker)}
                      portfolios={portfolios}
                      onAddToPortfolio={onAddToPortfolio}
                    />
                  ))}
                </AnimatePresence>
                {hiddenMissed > 0 ? (
                  <button
                    type="button"
                    className="lb-more"
                    onClick={() => setMissedVisible((v) => v + BOARD_WINDOW)}
                  >
                    Show {Math.min(BOARD_WINDOW, hiddenMissed)} more
                    <em className="mono">{hiddenMissed} more cut</em>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </MotionConfig>
  );
}
