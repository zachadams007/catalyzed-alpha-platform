import { useMemo } from "react";
import { useAppStore } from "@/store/useAppStore";
import { buildModelScores } from "@/engine/modelScores";
import { getActiveVariant, VARIANT_LABELS, type EngineVariantId } from "@/engine/challenger";
import {
  compareModels,
  PROMOTION_MIN_COHORTS,
  PROMOTION_MIN_TSTAT,
} from "@/engine/outcomeEval";
import {
  variantForRegistry,
  type ModelRegistry,
  type ModelRegistryEntry,
} from "@/engine/modelRegistry";
import { RANK_TILT } from "@/viz/pipelineModel";
import { EngineLineageStrip } from "@/components/ops/EngineLineageStrip";
import {
  WINDOW_LABEL,
  type ForwardWindow,
  type OutcomeLedger,
  type PerformanceSummary,
} from "@/engine/outcomeLedger";
import type { MarketCapBucket, StockSignal } from "@/types";
import {
  IconArrowUp,
  IconArrowDown,
  IconInfo,
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconScale,
  IconTarget,
} from "@/components/icons";

/**
 * Champion vs Challenger - the operator's one designated comparison space
 * (discovery-overhaul / adaptive-algorithm program).
 *
 * Three honest layers, top to bottom:
 *   1. EXPLAINER - what each engine is and how a challenger earns promotion,
 *      in plain language, grounded in the live model registry + the engine code.
 *   2. SCOREBOARD - the track-record metric (rank-IC ΔIC, win rate, cohorts)
 *      from the outcome ledger, with the pre-registered promotion test and the
 *      IC reality-check honesty guardrail.
 *   3. BOARD - the SAME scored universe ranked two ways, with the divergences
 *      called out: what the challenger promotes, and what it demotes.
 *
 * Reads the live signals + outcome ledger + model registry; it NEVER changes
 * scoring, the ledger, or evaluation. Presentation only.
 */

const TOP_N = 10;

interface BoardRow {
  ticker: string;
  name: string;
  bucket: MarketCapBucket;
  championOpp: number;
  challengerOpp: number;
}

type RankedRow = BoardRow & { confidence: number; riskPenalty: number };

interface Board {
  byChampion: RankedRow[];
  byChallenger: RankedRow[];
  championRank: Map<string, number>;
  challengerRank: Map<string, number>;
}

interface DivergeRow {
  ticker: string;
  bucket: MarketCapBucket;
  championRank: number;
  challengerRank: number;
}

function rankKey(opp: number, confidence: number, riskPenalty: number): number {
  return (
    opp +
    (confidence - RANK_TILT.confidencePivot) * RANK_TILT.confidencePerPoint -
    riskPenalty * RANK_TILT.riskPenaltyFactor
  );
}

function isMegaLarge(bucket: MarketCapBucket): boolean {
  return bucket === "Mega" || bucket === "Large";
}

function buildBoard(signals: StockSignal[]): Board {
  const models = buildModelScores(signals, getActiveVariant());
  const rows: RankedRow[] = signals.map((s) => {
    const m = models.get(s.ticker);
    const championOpp = m?.champion?.opportunityScore ?? s.score.opportunityScore;
    const challengerOpp = m?.challenger?.opportunityScore ?? championOpp;
    return {
      ticker: s.ticker,
      name: s.name,
      bucket: s.marketCapBucket,
      championOpp,
      challengerOpp,
      confidence: s.confidence,
      riskPenalty: s.score.riskPenalty,
    };
  });

  const byChampion = [...rows].sort(
    (a, b) =>
      rankKey(b.championOpp, b.confidence, b.riskPenalty) -
        rankKey(a.championOpp, a.confidence, a.riskPenalty) ||
      (a.ticker < b.ticker ? -1 : 1),
  );
  const byChallenger = [...rows].sort(
    (a, b) =>
      rankKey(b.challengerOpp, b.confidence, b.riskPenalty) -
        rankKey(a.challengerOpp, a.confidence, a.riskPenalty) ||
      (a.ticker < b.ticker ? -1 : 1),
  );
  const championRank = new Map(byChampion.map((r, i) => [r.ticker, i]));
  const challengerRank = new Map(byChallenger.map((r, i) => [r.ticker, i]));
  return { byChampion, byChallenger, championRank, challengerRank };
}

/**
 * The set-difference of the two top-N lists - the heart of "what each picks
 * differently". `promotes` = names the challenger lifts into the top N that the
 * champion leaves out; `demotes` = names the champion ranks in the top N that
 * the challenger pushes below it.
 */
function buildDivergence(board: Board): { promotes: DivergeRow[]; demotes: DivergeRow[] } {
  const champTop = board.byChampion.slice(0, TOP_N);
  const challTop = board.byChallenger.slice(0, TOP_N);
  const champTopSet = new Set(champTop.map((r) => r.ticker));
  const challTopSet = new Set(challTop.map((r) => r.ticker));
  const toRow = (r: RankedRow): DivergeRow => ({
    ticker: r.ticker,
    bucket: r.bucket,
    championRank: board.championRank.get(r.ticker) ?? -1,
    challengerRank: board.challengerRank.get(r.ticker) ?? -1,
  });
  const promotes = challTop.filter((r) => !champTopSet.has(r.ticker)).map(toRow);
  const demotes = champTop.filter((r) => !challTopSet.has(r.ticker)).map(toRow);
  return { promotes, demotes };
}

function rankLabel(index: number): string {
  return index < 0 ? "—" : `#${index + 1}`;
}

function MoveTag({ move }: { move: number }) {
  if (move === 0) return <span className="cc-move cc-move--flat" aria-label="rank unchanged">—</span>;
  const up = move > 0;
  const mag = Math.abs(move);
  return (
    <span
      className={`cc-move cc-move--${up ? "up" : "down"}`}
      aria-label={`${up ? "up" : "down"} ${mag} ${mag === 1 ? "rank" : "ranks"}`}
    >
      {up ? <IconArrowUp size={11} /> : <IconArrowDown size={11} />}
      {mag}
    </span>
  );
}

/* ── 1. Explainer ──────────────────────────────────────────────────────────── */

function EngineCard({
  kind,
  entry,
  live,
}: {
  kind: EngineVariantId;
  entry: ModelRegistryEntry | undefined;
  live: boolean;
}) {
  const isChampion = kind === "champion";
  const role = isChampion
    ? "Computes every rank a tester sees, across the whole US market."
    : "Scores the same universe in parallel — same names, only the algorithm differs. Goes live only if it proves better.";
  return (
    <article className={`cc-engine cc-engine--${kind}${live ? " cc-engine--live" : ""}`}>
      <div className="cc-engine__top">
        <span className="cc-engine__role">{VARIANT_LABELS[kind]}</span>
        <span className={`cc-engine__tag cc-engine__tag--${live ? "live" : "shadow"}`}>
          {live ? "Live · users see this" : "Shadow · no one sees this"}
        </span>
      </div>
      <h4 className="cc-engine__name">{entry?.label ?? (isChampion ? "Curated engine" : "Candidate engine")}</h4>
      <p className="cc-engine__role-line">{role}</p>
      {entry?.changeSummary ? <p className="cc-engine__how">{entry.changeSummary}</p> : null}
    </article>
  );
}

function PromotionExplainer({
  championEntry,
  challengerEntry,
  liveKind,
}: {
  championEntry: ModelRegistryEntry | undefined;
  challengerEntry: ModelRegistryEntry | undefined;
  liveKind: EngineVariantId;
}) {
  const steps: {
    icon: JSX.Element;
    title: string;
    body: string;
    facts?: { k: string; v: string }[];
  }[] = [
    {
      icon: <IconScale size={15} />,
      title: "Score both, in parallel",
      body: "Both engines score the same picks each run — same price, same forward return.",
    },
    {
      icon: <IconClock size={15} />,
      title: "Measure rank-IC",
      body: "Did each engine's higher-ranked names rise more? That correlation is its rank-IC.",
    },
    {
      icon: <IconTarget size={15} />,
      title: "Clear a pre-set bar",
      body: "Promote only when the challenger leads on ΔIC by the bar:",
      facts: [
        { k: "Cohorts", v: `≥ ${PROMOTION_MIN_COHORTS}` },
        { k: "t-stat", v: `≥ ${PROMOTION_MIN_TSTAT.toFixed(1)}` },
      ],
    },
    {
      icon: <IconCheck size={15} />,
      title: "Operator promotes",
      body: "You flip it live by hand — nothing auto-promotes. Promotion is app-wide: the new model goes live for every user at once.",
    },
  ];

  return (
    <section className="cc-explainer" aria-label="What the two engines are">
      <div className="cc-engines">
        <EngineCard kind="champion" entry={championEntry} live={liveKind === "champion"} />
        <EngineCard kind="challenger" entry={challengerEntry} live={liveKind === "challenger"} />
      </div>

      <div className="cc-promo">
        <div className="cc-promo__head">
          <h4 className="cc-promo__title">How a challenger gets promoted</h4>
        </div>
        <ol className="cc-promo__steps">
          {steps.map((s, i) => (
            <li className="cc-promo__step" key={s.title}>
              <span className="cc-promo__icon" aria-hidden="true">
                {s.icon}
              </span>
              <div>
                <div className="cc-promo__step-title">
                  <span className="cc-promo__idx mono" aria-hidden="true">
                    {i + 1}
                  </span>
                  {s.title}
                </div>
                <p className="cc-promo__step-body">{s.body}</p>
                {s.facts && (
                  <div className="fact-tags cc-promo__facts">
                    {s.facts.map((f) => (
                      <span className="fact-tag" key={f.k}>
                        <span className="fact-tag__k">{f.k}</span>
                        <span className="fact-tag__v mono">{f.v}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        <p className="cc-promo__scope">
          <IconInfo size={13} />
          <span>
            Champion vs Challenger is for the <strong>stock-picking math only</strong> — how names are
            scored and ranked. It never changes coverage, data sources, or features.
          </span>
        </p>
      </div>
    </section>
  );
}

/* ── 2. Scoreboard (the track-record metric) ───────────────────────────────── */

/**
 * Honest framing of the rank-IC so a big number never reads as a brag. Real
 * cross-sectional equity rank-IC lives around 0.02–0.08 IN MAGNITUDE; anything
 * beyond ±0.15 - in EITHER direction - is far more likely a data / look-ahead /
 * small-sample artifact than genuine signal. Suppressed entirely until at least
 * one paired cohort exists, so a not-yet-measured 0.0000 never gets a caption.
 * Presentation only - it just interprets the numbers the eval already produced.
 */
function ICRealityCheck({
  championIC,
  challengerIC,
  cohorts,
}: {
  championIC: number;
  challengerIC: number;
  cohorts: number;
}) {
  if (cohorts === 0) return null; // nothing measured yet - the rationale already says so
  // Key the suspicion on magnitude: a strongly NEGATIVE IC is just as much an
  // artifact as a strongly positive one, so |IC|, not signed max, drives it.
  const offending = Math.abs(championIC) >= Math.abs(challengerIC) ? championIC : challengerIC;
  const suspicious = Math.abs(offending) > 0.15;
  return (
    <p className={`cc-reality${suspicious ? " cc-reality--warn" : ""}`}>
      {suspicious ? <IconAlertTriangle size={14} /> : <IconInfo size={14} />}
      <span>
        Reality check: real-world equity rank-IC typically sits around 0.02–0.08 in magnitude.
        {suspicious
          ? ` A meanIC of ${offending.toFixed(4)} is implausibly extreme — suspect a data, look-ahead, or small-sample artifact, not genuine edge.`
          : " Anything beyond ±0.15 (either direction) is more likely a data or look-ahead artifact than real skill — read a large IC with suspicion, not celebration."}
      </span>
    </p>
  );
}

function Scoreboard({
  ledger,
  win,
  lowSample,
}: {
  ledger: OutcomeLedger;
  win: ForwardWindow;
  lowSample: boolean;
}) {
  const cmp = useMemo(() => compareModels(ledger, win), [ledger, win]);
  const paired = cmp.cohorts > 0;
  const fmtIC = (stat: { meanIC: number; cohorts: number }) =>
    stat.cohorts > 0 ? stat.meanIC.toFixed(4) : "—";
  const deltaText = paired ? `${cmp.deltaIC >= 0 ? "+" : ""}${cmp.deltaIC.toFixed(4)}` : "—";

  return (
    <section className="ops-card cc-scoreboard" aria-label="Which engine ranks better">
      <div className="cc-board__head">
        <div>
          <h3 className="ops-card__title">Which engine ranks better</h3>
          <p className="ops-card__sub">
            ΔIC = challenger IC − champion IC on {WINDOW_LABEL[win]} returns. Positive = challenger ordered names closer to reality.
          </p>
        </div>
        <span
          className={`cc-verdict${cmp.promote ? " cc-verdict--ready" : ""}`}
          title={cmp.promote ? "Cleared the pre-registered promotion bar" : "Not yet conclusive"}
        >
          {cmp.promote ? "Ready to promote" : "Directional"}
        </span>
      </div>

      <div className="cc-metrics" role="group" aria-label={`Rank-IC comparison (${WINDOW_LABEL[win]})`}>
        <div className="cc-metric cc-metric--lead">
          <span className="cc-metric__label">ΔIC · {WINDOW_LABEL[win]}</span>
          <span
            className={`cc-metric__value mono${paired ? ` perf-figure--${cmp.deltaIC > 0 ? "pos" : cmp.deltaIC < 0 ? "neg" : "flat"}` : ""}`}
          >
            {deltaText}
          </span>
        </div>
        <div className="cc-metric">
          <span className="cc-metric__label">Challenger IC</span>
          <span className="cc-metric__value mono">{fmtIC(cmp.challenger)}</span>
        </div>
        <div className="cc-metric">
          <span className="cc-metric__label">Champion IC</span>
          <span className="cc-metric__value mono">{fmtIC(cmp.champion)}</span>
        </div>
        <div className="cc-metric">
          <span className="cc-metric__label">Win rate</span>
          <span className="cc-metric__value mono">{paired ? `${Math.round(cmp.winRate * 100)}%` : "—"}</span>
        </div>
        <div className="cc-metric">
          <span className="cc-metric__label">Cohorts</span>
          <span className="cc-metric__value mono">
            {cmp.cohorts}
            <span className="cc-metric__of">/{PROMOTION_MIN_COHORTS}</span>
          </span>
        </div>
      </div>

      <p className="cc-rationale">{cmp.rationale}</p>

      {lowSample && paired ? (
        <p className="cc-rationale cc-rationale--note">
          <IconInfo size={13} /> Small sample so far — read ΔIC as directional, not conclusive.
        </p>
      ) : null}

      <ICRealityCheck
        championIC={cmp.champion.meanIC}
        challengerIC={cmp.challenger.meanIC}
        cohorts={cmp.cohorts}
      />
    </section>
  );
}

/* ── 3. Side-by-side board + divergence ────────────────────────────────────── */

function DivergenceList({
  title,
  rows,
  tone,
  empty,
}: {
  title: string;
  rows: DivergeRow[];
  tone: "up" | "down";
  empty: string;
}) {
  return (
    <div className={`cc-diverge__col cc-diverge__col--${tone}`}>
      <div className="cc-diverge__head">
        {tone === "up" ? <IconArrowUp size={13} /> : <IconArrowDown size={13} />}
        <span>{title}</span>
        <span className="cc-diverge__count mono">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="cc-diverge__empty text-faint">{empty}</p>
      ) : (
        <ul className="cc-diverge__list">
          {rows.map((r) => (
            <li className="cc-diverge__row" key={r.ticker}>
              <span className="cc-row__tk mono">{r.ticker}</span>
              <span className={`cc-cap cc-cap--${isMegaLarge(r.bucket) ? "big" : "small"}`}>{r.bucket}</span>
              <span className="cc-diverge__move mono">
                <span className="cc-diverge__from">{rankLabel(r.championRank)}</span>
                <span className="cc-diverge__arrow" aria-hidden="true">→</span>
                <span className="cc-diverge__to">{rankLabel(r.challengerRank)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ComparisonBoard({ board }: { board: Board }) {
  const champTop = board.byChampion.slice(0, TOP_N);
  const challTop = board.byChallenger.slice(0, TOP_N);
  const champTopSet = new Set(champTop.map((r) => r.ticker));
  const challTopSet = new Set(challTop.map((r) => r.ticker));
  const { promotes, demotes } = buildDivergence(board);
  const megaInTop5 = (rows: RankedRow[]) =>
    rows.slice(0, 5).filter((r) => isMegaLarge(r.bucket)).length;

  const columns = [
    { title: "Champion", rows: champTop, kind: "champion" as const },
    { title: "Challenger", rows: challTop, kind: "challenger" as const },
  ];

  return (
    <section className="ops-card cc-board" aria-label="Same universe, two rankings">
      <div className="cc-board__head">
        <div>
          <h3 className="ops-card__title">Same universe, two rankings</h3>
          <p className="ops-card__sub">Today's top 10 by each engine. Badges show rank moves.</p>
        </div>
      </div>

      <div className="cc-columns">
        {columns.map((col) => (
          <div key={col.kind} className={`cc-col cc-col--${col.kind}`}>
            <div className="cc-col__head">
              <span className="cc-col__title">{col.title}</span>
              <span className="cc-col__stat">{megaInTop5(col.rows)} mega/large in top 5</span>
            </div>
            <ol className="cc-list">
              {col.rows.map((r, i) => {
                const move =
                  col.kind === "challenger" ? (board.championRank.get(r.ticker) ?? i) - i : 0;
                const opp = col.kind === "challenger" ? r.challengerOpp : r.championOpp;
                // Highlight the rows that drive the divergence: names the
                // challenger surfaces into its top N, and names it drops from
                // the champion's top N.
                const surface = col.kind === "challenger" && !champTopSet.has(r.ticker);
                const drop = col.kind === "champion" && !challTopSet.has(r.ticker);
                return (
                  <li
                    key={r.ticker}
                    className={`cc-row${surface ? " cc-row--surface" : ""}${drop ? " cc-row--drop" : ""}`}
                  >
                    <span className="cc-row__pos mono">{i + 1}</span>
                    <span className="cc-row__tk mono">{r.ticker}</span>
                    <span className={`cc-cap cc-cap--${isMegaLarge(r.bucket) ? "big" : "small"}`}>
                      {r.bucket}
                    </span>
                    <span className="cc-row__score mono">{opp}</span>
                    {col.kind === "challenger" ? <MoveTag move={move} /> : null}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>

      <div className="cc-diverge" aria-label="What each engine picks differently">
        <div className="cc-diverge__caption">
          <span className="cc-diverge__caption-title">What the challenger picks differently</span>
          <span className="text-faint">vs the champion&apos;s top {TOP_N} · rank moves shown champion → challenger</span>
        </div>
        <div className="cc-diverge__cols">
          <DivergenceList
            title="Challenger promotes into top 10"
            rows={promotes}
            tone="up"
            empty="Same top 10 — no names lifted in."
          />
          <DivergenceList
            title="Challenger demotes out of top 10"
            rows={demotes}
            tone="down"
            empty="Same top 10 — no names dropped out."
          />
        </div>
      </div>
    </section>
  );
}

/* ── Component ──────────────────────────────────────────────────────────────── */

function findEntry(registry: ModelRegistry, kind: EngineVariantId): ModelRegistryEntry | undefined {
  return registry.entries.find((e) => e.kind === kind);
}

export function ChampionChallengerBoard({ summary }: { summary: PerformanceSummary }) {
  const ledger = useAppStore((s) => s.outcomeLedger);
  const signals = useAppStore((s) => s.signals);
  const registry = useAppStore((s) => s.modelRegistry);

  const win: ForwardWindow = summary.measuredCount > 0 ? summary.primaryWindow : "d30";
  // `registry` is in the deps because buildBoard() reads the active variant via
  // getActiveVariant(): when an operator promotes/rolls back the variant the
  // ranked columns must recompute, not just the labels.
  const board = useMemo(() => (signals.length > 0 ? buildBoard(signals) : null), [signals, registry]);
  const liveKind = variantForRegistry(registry);
  const championEntry = findEntry(registry, "champion");
  const challengerEntry = findEntry(registry, "challenger");

  return (
    <div className="cc-lab">
      <EngineLineageStrip />

      <PromotionExplainer
        championEntry={championEntry}
        challengerEntry={challengerEntry}
        liveKind={liveKind}
      />

      <Scoreboard ledger={ledger} win={win} lowSample={summary.lowSample} />

      {board ? (
        <ComparisonBoard board={board} />
      ) : (
        <section className="ops-card cc-board" aria-label="Same universe, two rankings">
          <div className="cc-board__head">
            <div>
              <h3 className="ops-card__title">Same universe, two rankings</h3>
              <p className="ops-card__sub">
                The live side-by-side board appears as soon as the universe is scored.
              </p>
            </div>
          </div>
          <p className="cc-empty text-faint">The head-to-head board fills in after the next market scan.</p>
        </section>
      )}
    </div>
  );
}
