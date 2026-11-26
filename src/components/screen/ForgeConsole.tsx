import { useMemo, useState, type CSSProperties } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import NumberFlow from "@number-flow/react";
import { motionTokens, springs } from "@/lib/motionTokens";
import { effectiveScreenCriteria, evaluateScreenGates } from "@/engine/screen";
import { REAL_UNIVERSE_SIZE } from "@/data/realUniverse";
import { FUNNEL } from "@/viz/pipelineModel";
import { isLiveDataActive, resolveProviderId } from "@/data/providers";
import { CutStrip, type ScreenCut } from "@/components/screen/LiveLeaderboard";
import { InfoTip, Tooltip } from "@/components/common/Tooltip";
import {
  RESEARCH_STAGES,
  isResearchInFlight,
  researchStageStatus,
  type BlueprintResearchState,
} from "@/components/screen/researchFlow";
import type { ResearchAgentLane } from "@/data/ai/researchAgent";
import type { ScreenCriteria, ScreenMatch, TradeHorizon } from "@/types";

/**
 * ForgeConsole - the Blueprint "Gate Deck".
 *
 * One instrument strip that shows the WHOLE screen as a signal chain:
 *
 *   UNIVERSE ──▶ [ gate ▸ −kills ] [ gate ▸ −kills ] … ──▶ FULL PASS
 *
 * Every chip is a real active hard filter (engine `evaluateScreenGates`), its
 * kill count aggregated from the matches' own `failedGates` - the console can
 * never disagree with the board below it. Clicking a gate opens the exact
 * names it demotes, with actual vs required values. The right block is a fit
 * spectrum: the ranked fit curve as analyzer bars (weak matches dimmed).
 *
 * The deck also narrates the unified Run Blueprint flow: a slim stage strip
 * while the AI lane researches, and a CALM note row for paused/error states -
 * the proxy hitting its daily budget is an expected condition, not a fault.
 */

interface GateNode {
  key: string;
  label: string;
  required: string;
  kills: number;
  victims: Array<{ ticker: string; actual: string }>;
}

const SPECTRUM_BARS = 56;
const VICTIM_PREVIEW = 8;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function ForgeConsole({
  matches,
  cuts,
  horizons,
  criteria,
  research,
  lane,
  aiMode,
}: {
  matches: ScreenMatch[];
  cuts: ScreenCut[];
  horizons: TradeHorizon[];
  criteria: ScreenCriteria;
  /** Unified Run Blueprint progress (idle for the local-only modes). */
  research: BlueprintResearchState;
  /** Live availability of the AI lane (off / paused / ready). */
  lane: ResearchAgentLane;
  /** True when the active ranking mode includes the AI lane. */
  aiMode: boolean;
}) {
  const [openGate, setOpenGate] = useState<string | null>(null);

  const { gates, fullPass, demoted } = useMemo(() => {
    const probe = matches[0]?.signal;
    if (!probe) return { gates: [] as GateNode[], fullPass: 0, demoted: 0 };
    const eff = effectiveScreenCriteria(horizons, criteria);
    const nodes: GateNode[] = evaluateScreenGates(probe, eff).map((gate) => {
      const victims: GateNode["victims"] = [];
      for (const m of matches) {
        const failed = m.failedGates.find((g) => g.key === gate.key);
        if (failed) victims.push({ ticker: m.signal.ticker, actual: failed.actual });
      }
      return {
        key: gate.key,
        label: gate.label,
        required: gate.required,
        kills: victims.length,
        victims,
      };
    });
    const pass = matches.reduce((n, m) => n + (m.weakMatch ? 0 : 1), 0);
    return { gates: nodes, fullPass: pass, demoted: matches.length - pass };
  }, [matches, horizons, criteria]);

  const spectrum = useMemo(() => {
    const n = matches.length;
    if (n === 0) return [];
    const bars = Math.min(SPECTRUM_BARS, n);
    return Array.from({ length: bars }, (_, i) => {
      const m = matches[Math.round((i * (n - 1)) / Math.max(1, bars - 1))]!;
      return { fit: m.fitScore, weak: m.weakMatch };
    });
  }, [matches]);

  const fits = matches.map((m) => m.fitScore);
  const open = openGate ? gates.find((g) => g.key === openGate && g.kills > 0) ?? null : null;

  const live = isLiveDataActive();
  const providerId = resolveProviderId();
  const provenance = live
    ? providerId === "funnel"
      ? `Full-market funnel — top ${FUNNEL.targetMax} of the whole US market`
      : providerId === "hybrid"
        ? "Hybrid live: Finnhub + FMP + AI discovery"
        : `Live universe targets ${REAL_UNIVERSE_SIZE} tickers`
    : "Sample universe — fictional tickers";

  const busy = isResearchInFlight(research.phase);
  const paused = aiMode && (research.phase === "paused" || lane === "paused");

  const statusText = busy ? "AI RESEARCHING" : paused ? "AI PAUSED" : "LIVE";
  const statusMod = busy ? "is-busy" : paused ? "is-paused" : "is-live";

  // Calm narration - never a red fault. Paused is an expected daily condition.
  const note: { tone: "paused" | "warn" | "done"; text: string } | null = paused
    ? {
        tone: "paused",
        text:
          "AI web search is paused for today — the board shows filter results only. An operator can raise the daily budget in the Operator console to resume.",
      }
    : aiMode && research.phase === "error"
      ? {
          tone: "warn",
          text: `AI web search didn't complete — ${research.note ?? "no results came back"}. Filter results are still live on the board.`,
        }
      : aiMode && research.phase === "complete"
        ? {
            tone: "done",
            text:
              research.acceptedCount > 0
                ? `AI web search done — ${research.acceptedCount} additional ${
                    research.acceptedCount === 1 ? "stock" : "stocks"
                  } found and merged into the board.`
                : "AI web search done — no additional stocks to add this run.",
          }
        : null;

  return (
    <MotionConfig reducedMotion="user">
      <section className="gate-deck" aria-label="Screen console">
        <header className="gate-deck__bar">
          <span className={`gate-deck__lamp ${statusMod}`} aria-hidden />
          <span className="gate-deck__title">Screen console</span>
          <InfoTip
            label="How to read the screen console"
            placement="bottom"
            content={
              <>
                Reads left to right: all scored stocks enter, each active filter removes the stocks
                that don't meet it (they appear under <strong>”Missed the cut”</strong> below the
                board), and the stocks that clear every filter show as{" "}
                <strong>full pass</strong>. The ranked board below is these same stocks in order —
                the console is its summary.
              </>
            }
          />
          <Tooltip
            placement="bottom"
            content={
              busy
                ? "AI web search is running — counts update live as stocks are found and merged in."
                : paused
                  ? "AI web search is paused for today (daily budget spent). Filter results are still fully live."
                  : "Live — the board and counts update instantly as you change filters."
            }
          >
            <span className={`gate-deck__status mono ${statusMod}`} role="status">
              {statusText}
            </span>
          </Tooltip>
          <span className="gate-deck__provenance">{provenance}</span>
        </header>

        <AnimatePresence initial={false}>
          {aiMode && busy ? (
            <motion.div
              key="stages"
              className="gate-deck__stages"
              role="status"
              aria-label="AI web search in progress"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: motionTokens.duration.base, ease: motionTokens.easing.out }}
            >
              <span className="gate-deck__stages-label">AI searching the web for niche stocks…</span>
              {RESEARCH_STAGES.map((stage) => {
                const status = researchStageStatus(stage.key, research.phase);
                return (
                  <span key={stage.key} className={`gate-deck__stage is-${status}`} title={stage.detail}>
                    <i aria-hidden />
                    {stage.label}
                  </span>
                );
              })}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="gate-deck__rail" role="group" aria-label="Active hard-filter gates">
          <Tooltip
            placement="bottom"
            content="All scored stocks available right now. Active filters remove stocks that don’t qualify — they appear under ‘Missed the cut’ below the board."
          >
            <div className="gate-deck__node">
              <em>universe</em>
              <span className="mono">
                <NumberFlow value={matches.length} />
              </span>
            </div>
          </Tooltip>
          <div className="gate-deck__chain">
            <AnimatePresence initial={false}>
              {gates.length === 0 ? (
                <motion.span
                  key="no-gates"
                  className="gate-deck__nogates"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  no hard gates — the full universe ranks on fit
                </motion.span>
              ) : (
                gates.map((gate) => (
                  <motion.button
                    key={gate.key}
                    layout
                    type="button"
                    className={`gate-deck__gate${gate.kills > 0 ? " is-cutting" : ""}${
                      openGate === gate.key ? " is-open" : ""
                    }`}
                    initial={{ opacity: 0, y: -6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.94 }}
                    transition={springs.snappy}
                    onClick={() => setOpenGate(openGate === gate.key ? null : gate.key)}
                    aria-expanded={openGate === gate.key}
                    title={`${gate.label} — requires ${gate.required}. Click to see which stocks this filter removes.`}
                  >
                    <em>{gate.label}</em>
                    <span className="gate-deck__kills mono">
                      {gate.kills > 0 ? `−${gate.kills}` : "clear"}
                    </span>
                  </motion.button>
                ))
              )}
            </AnimatePresence>
          </div>
          <Tooltip
            placement="bottom"
            content="Stocks that pass every active filter — these appear on the ranked board. Stocks that don’t qualify are shown under ‘Missed the cut’ below."
          >
            <div className="gate-deck__node gate-deck__node--pass">
              <em>full pass</em>
              <span className="mono">
                <NumberFlow value={fullPass} />
              </span>
            </div>
          </Tooltip>
        </div>

        <div className="gate-deck__body">
          <div className="gate-deck__readout">
            <Tooltip
              placement="bottom"
              content="Every scored stock the screen evaluated. Active filters split these into stocks on the board and stocks under 'Missed the cut'."
            >
              <span className="gate-deck__readout-label">scanned</span>
            </Tooltip>
            <span className="gate-deck__big mono" data-count={matches.length}>
              <NumberFlow value={matches.length} />
            </span>
            <div className="gate-deck__stats">
              {(
                [
                  {
                    key: "full pass",
                    tip: "Passed every active filter — these appear on the ranked board.",
                    mod: " gate-deck__stat-v--pass",
                    value: fullPass,
                  },
                  {
                    key: "missed cut",
                    tip: "Removed by an active filter — shown under ‘Missed the cut’ below the board, with the specific filter named on each row.",
                    mod: " gate-deck__stat-v--demoted",
                    value: demoted,
                  },
                  {
                    key: "top fit",
                    tip: "The #1 name's fit score under the current ranking mode.",
                    mod: "",
                    value: fits[0] ?? 0,
                  },
                  {
                    key: "median",
                    tip: "The middle fit score across the whole board — watch it move as you tune.",
                    mod: "",
                    value: median(fits),
                  },
                ] as const
              ).map((stat) => (
                <Tooltip key={stat.key} placement="bottom" content={stat.tip}>
                  <div className="gate-deck__stat">
                    <span className="gate-deck__stat-k">{stat.key}</span>
                    <span className={`gate-deck__stat-v mono${stat.mod}`}>
                      <NumberFlow value={stat.value} />
                    </span>
                  </div>
                </Tooltip>
              ))}
            </div>
          </div>

          <div className="gate-deck__spectrum">
            <div className="gate-deck__spec-bars" aria-hidden="true">
              {spectrum.length === 0 ? (
                <span className="gate-deck__spec-empty mono">no signal</span>
              ) : (
                spectrum.map((bar, i) => (
                  <span
                    key={i}
                    className={`gate-deck__spec-bar${bar.weak ? " is-weak" : ""}`}
                    style={{ "--h": `${Math.max(4, bar.fit)}%` } as CSSProperties}
                  />
                ))
              )}
            </div>
            <Tooltip
              placement="top"
              content="One bar per name, rank 1 on the left; height = fit score, dimmed = cut. Tighten a gate and watch the curve reshape."
            >
              <span className="gate-deck__spec-caption">fit by rank</span>
            </Tooltip>
          </div>
        </div>

        <AnimatePresence>
          {open ? (
            <motion.div
              key={open.key}
              className="gate-deck__detail"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: motionTokens.duration.base, ease: motionTokens.easing.out }}
            >
              <span className="gate-deck__detail-head">
                <strong>{open.label}</strong> removes{" "}
                <span className="mono">{open.kills}</span> {open.kills === 1 ? "stock" : "stocks"} —
                requires <span className="mono">{open.required}</span>
              </span>
              <div className="gate-deck__victims">
                {open.victims.slice(0, VICTIM_PREVIEW).map((v) => (
                  <span key={v.ticker} className="gate-deck__victim">
                    <span className="mono">{v.ticker}</span>
                    <em className="mono">{v.actual}</em>
                  </span>
                ))}
                {open.kills > VICTIM_PREVIEW ? (
                  <span className="gate-deck__victim gate-deck__victim--more mono">
                    +{open.kills - VICTIM_PREVIEW} more
                  </span>
                ) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {note || cuts.length > 0 ? (
          <div className="gate-deck__log">
            {note ? (
              <p className={`gate-deck__note gate-deck__note--${note.tone}`} role="status">
                <span className="gate-deck__note-dot" aria-hidden />
                {note.text}
              </p>
            ) : null}
            <CutStrip cuts={cuts} />
          </div>
        ) : null}
      </section>
    </MotionConfig>
  );
}
