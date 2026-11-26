import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EngineCore } from "@/components/algorithm/EngineCore";
import {
  FEED_RULES,
  PORTFOLIO_LEARNING,
  STORY_BRANCHES,
  type StoryBranch,
} from "@/viz/pipelineModel";
import { springs } from "@/lib/motionTokens";
import { useAppStore } from "@/store/useAppStore";
import { TRADE_HORIZON_LABELS } from "@/types";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * Chapter 6 - the ending. The pathways that converged at the top now diverge:
 * one glowing route to every destination in the app. Every route carries live
 * energy on its own cadence (packets + a breathing glow wave), and hovering or
 * focusing a destination pins its route fully lit - driven by the node itself,
 * never by cursor-distance math. Choosing a destination CONTINUES the
 * cinematic along that branch's OWN vector: the camera dives toward the node
 * and the destination's chamber arrives from the same direction, so each of
 * the seven branches travels its own way. Portfolios' route loops BACK into
 * the engine - because it really does (learnFromPortfolios runs after every
 * research run).
 */

const NODE_POS: Record<string, { x: number; y: number }> = {
  today: { x: 150, y: 430 },
  weekly: { x: 305, y: 508 },
  "for-you": { x: 465, y: 552 },
  forge: { x: 630, y: 558 },
  beacon: { x: 795, y: 524 },
  terminal: { x: 950, y: 458 },
  portfolios: { x: 1085, y: 372 },
};

const CORE = { x: 600, y: 120 };

function branchPath(id: string): string {
  const p = NODE_POS[id]!;
  return `M ${CORE.x} ${CORE.y + 64} C ${CORE.x} ${CORE.y + 190}, ${p.x} ${p.y - 140}, ${p.x} ${p.y - 26}`;
}

/** Portfolios feeds back into the engine - drawn as a distinct return route. */
const LOOP_PATH = `M ${NODE_POS.portfolios!.x + 18} ${NODE_POS.portfolios!.y - 30} C 1170 160, 850 30, ${CORE.x + 66} ${CORE.y - 10}`;

/** Unit vector from the engine's exit toward a node - the branch's travel direction. */
function branchVector(id: string): { x: number; y: number } {
  const p = NODE_POS[id]!;
  const dx = p.x - CORE.x;
  const dy = p.y - (CORE.y + 64);
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** How far (px) the camera and chamber travel along the branch vector. */
const TRAVEL = 170;

export function SceneDivergence({ data }: { data: StoryData }) {
  const reduced = useReducedMotion() ?? false;
  const sectionRef = useRef<HTMLElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [openBranch, setOpenBranch] = useState<StoryBranch | null>(null);
  /** Remembered through the return trip so the camera zooms back out of the
      same corner it dove into. */
  const lastBranchRef = useRef<StoryBranch | null>(null);
  if (openBranch) lastBranchRef.current = openBranch;

  /** The chosen route stays hot while its chamber is open. */
  const hot = hovered ?? openBranch?.id ?? null;

  const closeChamber = useCallback(() => setOpenBranch(null), []);

  // Moving into a chamber hands focus to its title (no scroll - the room
  // replaces the map in place).
  useEffect(() => {
    if (!openBranch) return;
    const raf = requestAnimationFrame(() => {
      sectionRef.current
        ?.querySelector<HTMLElement>(".branch-space__title")
        ?.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeChamber();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
    };
  }, [openBranch, closeChamber]);

  // Camera travel: zoom anchored at the chosen node, sliding along the
  // branch's own vector - a different direction for every destination.
  const travelBranch = openBranch ?? lastBranchRef.current;
  const stageStyle: React.CSSProperties = {};
  if (travelBranch) {
    const p = NODE_POS[travelBranch.id]!;
    stageStyle.transformOrigin = `${((p.x / 1200) * 100).toFixed(2)}% ${((p.y / 640) * 100).toFixed(2)}%`;
    if (openBranch && !reduced) {
      const v = branchVector(travelBranch.id);
      stageStyle.transform = `translate3d(${(-v.x * TRAVEL).toFixed(1)}px, ${(-v.y * TRAVEL).toFixed(1)}px, 0) scale(1.6)`;
    }
  }

  const enterOffset = openBranch && !reduced ? branchVector(openBranch.id) : null;

  return (
    <section
      ref={sectionRef}
      className="algo-scene algo-scene--divergence"
      id="algo-divergence"
    >
      <div className="algo-scene__stage">
        <header className="algo-scene__head">
          <p className="algo-eyebrow">Where it lands</p>
          <h2 className="algo-headline">One engine. Every surface.</h2>
          <p className="algo-dek">
            The same scored universe powers every tab — every route here is
            live. Hover a destination to light its path; step in to see what
            each one does with the signal.
          </p>
        </header>

        <div className="div-viewport">
          <div
            className={`div-stage${openBranch ? " div-stage--away" : ""}`}
            style={stageStyle}
            aria-hidden={openBranch ? true : undefined}
          >
            <svg className="div-svg" viewBox="0 0 1200 640" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              {/* Pre-rendered glow underlays - opacity-only (breathing wave +
                  hover pin) so nothing re-rasters. */}
              {STORY_BRANCHES.map((b, i) => (
                <path
                  key={`glow-${b.id}`}
                  className={`div-wire-glow${hot === b.id ? " div-wire-glow--on" : ""}${b.kind === "loop" ? " div-wire-glow--loop" : ""}`}
                  style={{ animationDelay: `${(i * 0.7).toFixed(2)}s` }}
                  d={branchPath(b.id)}
                />
              ))}
              <path
                className={`div-wire-glow div-wire-glow--loop${hot === "portfolios" ? " div-wire-glow--on" : ""}`}
                style={{ animationDelay: "2.1s" }}
                d={LOOP_PATH}
              />
              {STORY_BRANCHES.map((b) => (
                <path
                  key={b.id}
                  className={`div-wire${hot === b.id ? " div-wire--hot" : ""}`}
                  d={branchPath(b.id)}
                />
              ))}
              <path
                className={`div-wire div-wire--loop${hot === "portfolios" ? " div-wire--hot" : ""}`}
                d={LOOP_PATH}
              />
              {/* Always-on energy packets riding each route (CSS offset-path -
                  compositor-driven, no JS). */}
              {STORY_BRANCHES.map((b, i) => (
                <circle
                  key={`flow-${b.id}`}
                  className={`div-flow${b.kind === "loop" ? " div-flow--loop" : ""}`}
                  r={3.2}
                  style={{
                    offsetPath: `path("${branchPath(b.id)}")`,
                    animationDelay: `${(i * 0.52).toFixed(2)}s`,
                  }}
                />
              ))}
              <circle
                className="div-flow div-flow--loop"
                r={3.2}
                style={{ offsetPath: `path("${LOOP_PATH}")`, animationDelay: "1.3s" }}
              />
            </svg>

            <div className="div-core">
              <EngineCore size={128} state={data.isRunning ? "live" : "charged"} />
            </div>

            {STORY_BRANCHES.map((b) => {
              const p = NODE_POS[b.id]!;
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`div-node div-node--${b.kind}${hot === b.id ? " div-node--hot" : ""}`}
                  style={{ left: `${(p.x / 1200) * 100}%`, top: `${(p.y / 640) * 100}%` }}
                  onMouseEnter={() => setHovered(b.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(b.id)}
                  onBlur={() => setHovered(null)}
                  onClick={() => setOpenBranch(b)}
                >
                  <span className="div-node__label">{b.label}</span>
                  <span className="div-node__tagline">{b.tagline}</span>
                  {b.kind === "loop" ? (
                    <span className="div-node__loop">feeds back in ↺</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <AnimatePresence>
            {openBranch ? (
              <motion.div
                key={openBranch.id}
                className="branch-chamber"
                initial={{
                  opacity: 0,
                  scale: 0.96,
                  x: enterOffset ? enterOffset.x * TRAVEL : 0,
                  y: enterOffset ? enterOffset.y * TRAVEL : 0,
                }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  x: 0,
                  y: 0,
                  transition: { ...springs.gentle, delay: 0.16 },
                }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  x: enterOffset ? enterOffset.x * TRAVEL : 0,
                  y: enterOffset ? enterOffset.y * TRAVEL : 0,
                  transition: { duration: 0.32, ease: "easeOut" },
                }}
              >
                <BranchChamber
                  branch={openBranch}
                  data={data}
                  onClose={closeChamber}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Branch chambers - a "room" per destination that replaces the map in place,
// arriving from its branch's own direction. The story never scrolls away.
// ---------------------------------------------------------------------------

function BranchChamber({
  branch,
  data,
  onClose,
}: {
  branch: StoryBranch;
  data: StoryData;
  onClose: () => void;
}) {
  return (
    <div
      className={`branch-space__room branch-space__room--${branch.id}`}
      role="region"
      aria-label={`About ${branch.label}`}
    >
      <header className="branch-space__head">
        <div>
          <p className="algo-eyebrow">{branch.kind === "loop" ? "Feedback loop" : branch.kind === "feed" ? "Feed" : "Instrument"}</p>
          <h3 className="branch-space__title" tabIndex={-1}>{branch.label}</h3>
          <p className="branch-space__tagline">{branch.tagline}</p>
        </div>
        <div className="branch-space__actions">
          <Link to={branch.path} className="btn btn--primary btn--sm">
            Open {branch.label} →
          </Link>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            ← Back to the map
          </button>
        </div>
      </header>
      <div className="branch-space__body">
        <BranchContent branch={branch} data={data} />
      </div>
    </div>
  );
}

function BranchContent({ branch, data }: { branch: StoryBranch; data: StoryData }) {
  const preferences = useAppStore((s) => s.preferences);

  switch (branch.id) {
    case "today": {
      const rows = data.today.slice(0, 3);
      return (
        <div className="branch-today">
          {rows.length > 0 ? (
            <div className="branch-rows">
              {rows.map((s, i) => (
                <div key={s.ticker} className="branch-row">
                  <span className="mono branch-row__pos">{i + 1}</span>
                  <span className="mono branch-row__ticker">{s.ticker}</span>
                  <span className="branch-row__name">{s.name}</span>
                  <span className="mono branch-row__score">{s.score.opportunityScore}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="branch-empty">Scan Market to fill today’s lineup.</p>
          )}
          <p className="branch-copy">
            Today is the curated front page: the top {FEED_RULES.today.limit}{" "}
            ranked signals with a soft {FEED_RULES.today.sectorCap}-per-sector
            cap so one hot sector can’t monopolize the morning.
          </p>
        </div>
      );
    }
    case "weekly": {
      const filled = Math.min(data.weekly.length, FEED_RULES.weekly.limit);
      return (
        <div className="branch-weekly">
          <div className="branch-weekly__grid" aria-hidden="true">
            {Array.from({ length: FEED_RULES.weekly.limit }, (_, i) => (
              <span key={i} className={`branch-weekly__dot${i < filled ? " branch-weekly__dot--on" : ""}`} />
            ))}
          </div>
          <p className="branch-copy">
            The wider board — top {FEED_RULES.weekly.limit} by rank, no
            diversity rule. {filled > 0 ? `${filled} filled right now.` : "Scan Market to fill it."}{" "}
            Where you scan beyond the front page.
          </p>
        </div>
      );
    }
    case "for-you": {
      const sectors = Object.entries(preferences.sectorWeights ?? {})
        .filter(([, w]) => (w ?? 0) > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3);
      return (
        <div className="branch-foryou">
          <div className="branch-foryou__profile">
            <p className="branch-foryou__row">
              Horizon <strong>{TRADE_HORIZON_LABELS[preferences.tradeHorizon]}</strong>
            </p>
            <p className="branch-foryou__row">
              Discount + catalyst dial{" "}
              <strong className="mono">{Math.round(preferences.archetypeTilt * 100)}%</strong>
            </p>
            {sectors.length > 0 ? (
              <p className="branch-foryou__row">
                Learned sectors{" "}
                <strong>{sectors.map(([s]) => s).join(", ")}</strong>
              </p>
            ) : (
              <p className="branch-foryou__row branch-foryou__row--fresh">
                Fresh profile — like, mute, and tap to teach it.
              </p>
            )}
          </div>
          <p className="branch-copy">
            The only feed that reacts to you. Every tap nudges weights (likes
            +14, mutes −30, sector affinity ×5) and each research run learns
            from your own portfolio’s wins and losses.
          </p>
        </div>
      );
    }
    case "forge":
      return (
        <div className="branch-forge">
          <div className="branch-gates" aria-hidden="true">
            <span className="branch-gate">min opportunity ≥ 60</span>
            <span className="branch-gate">cap: Nano–Small</span>
            <span className="branch-gate branch-gate--kill">revenue growth ≥ 25% ✕</span>
          </div>
          <p className="branch-copy">
            Blueprint is your own screen over the scored universe — stack soft
            gates, weight a narrative, blend horizons. Gates demote, never
            delete: misses sink below the line, and one Run Blueprint folds AI
            niche research into the same ranked board.
          </p>
        </div>
      );
    case "beacon":
      return (
        <div className="branch-beacon">
          <div className="branch-beacon__scan mono" aria-hidden="true">
            <span className="branch-beacon__prompt">scope ▸</span> NVDA
            <span className="branch-beacon__cursor" />
          </div>
          <p className="branch-copy">
            Ticker Scope runs any single symbol through the exact same weighted
            dimensions, risk model, and confidence math — a one-off research run
            for whatever name is on your mind.
          </p>
        </div>
      );
    case "terminal":
      return (
        <div className="branch-terminal">
          <div className="branch-tape mono" aria-hidden="true">
            <span>▮ 8-K filed · material event</span>
            <span>▮ Form 4 · insider buy</span>
            <span>▮ congressional disclosure</span>
            <span>⌘K ▸ AAPL · open workspace</span>
          </div>
          <p className="branch-copy">
            Terminal is the live wire — breaking catalysts, insider Form 4s, and
            political trades as they hit, plus watchlist, day-mover, and
            upcoming-earnings monitors, independent of the scoring runs. A global{" "}
            <strong>⌘K command bar</strong> jumps to any ticker’s security
            workspace: price, news, SEC filings, congress, analyst targets, an AI
            brief, social heat, and your own notes on one dense board. The feed
            tells you what ranks; Terminal tells you what’s moving{" "}
            <em>right now</em>.
          </p>
        </div>
      );
    case "portfolios":
      return (
        <div className="branch-portfolios">
          <div className="branch-loop" aria-hidden="true">
            <span className="branch-loop__ring" />
            <span className="branch-loop__label mono">P/L → preferences</span>
          </div>
          <p className="branch-copy">{PORTFOLIO_LEARNING.summary}</p>
          <p className="branch-copy branch-copy--sub">
            Winners above {PORTFOLIO_LEARNING.winnerThreshold} pull the feed
            toward what’s working; losers past{" "}
            {PORTFOLIO_LEARNING.loserThreshold} push it away. The loop closes
            after every research run — automatically.
          </p>
        </div>
      );
    default:
      return null;
  }
}
