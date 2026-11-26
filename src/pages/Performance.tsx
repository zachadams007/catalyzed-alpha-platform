import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { isAdminEmail } from "@/lib/admin";
import { PageHeader } from "@/components/common/PageHeader";
import { Skeleton } from "@/components/common/Skeleton";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import {
  IconTarget,
  IconArrowUp,
  IconArrowDown,
  IconInfo,
  IconAlertTriangle,
  IconClock,
  IconScale,
} from "@/components/icons";
import { formatPct, formatPctPlain, relativeTime } from "@/lib/format";
import {
  WINDOW_LABEL,
  FORWARD_WINDOWS,
  MIN_MEANINGFUL_SAMPLE,
  filterLedgerByVariant,
  ledgerVersionsPresent,
  summarizePerformance,
  type ForwardWindow,
  type LedgerVersionFilter,
  type OutcomeHighlight,
  type PerformanceSummary,
} from "@/engine/outcomeLedger";
import { VARIANT_VERSION_TAGS } from "@/engine/challenger";
import { VersionFilter } from "@/components/performance/VersionFilter";
import { VersionTag } from "@/components/performance/VersionTag";

import { ChampionChallengerBoard } from "@/components/performance/ChampionChallengerBoard";
import { RecentCalls } from "@/components/performance/RecentCalls";
import { MonthlyPortfolio } from "@/components/performance/MonthlyPortfolio";
import { PerformanceColdStart } from "@/components/performance/PerformanceColdStart";
import {
  RankPerformanceChart,
  rankPerfBucketsFromStats,
} from "@/components/performance/RankPerformanceChart";

/**
 * Performance - the app's honest scoreboard for its OWN past picks.
 *
 * Two layers, deliberately separated:
 *   (a) PUBLIC "Track Record" - un-gated, plain-language proof every tester
 *       sees: hit rate, average move, whether higher-rated picks actually did
 *       better (the lift staircase), best calls + honest misses.
 *   (b) OPERATOR cockpit - admin-only (isAdminEmail): the quant depth
 *       (champion vs challenger, rank-IC, the model-selection machinery).
 *
 * Plus an inspiring cold-start: a fresh install shows what we'll PROVE and when
 * - never a backtest seed, never a dead-end.
 *
 * This file is presentation only. It reads the append-only outcome ledger via
 * summarizePerformance() and NEVER changes scoring, the ledger, or evaluation.
 */

type ReturnTone = "pos" | "neg" | "flat";

function tone(value: number): ReturnTone {
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "flat";
}

/** Below this |lift| the top-vs-bottom spread is noise - don't claim an edge. */
const MEANINGFUL_LIFT = 0.01;

// ── (a) PUBLIC layer ─────────────────────────────────────────────────────────

/** Compact key→value pills - fact-tags that replace figure-heavy sentences. */
function FactTags({ facts }: { facts: { k: string; v: string; tone?: ReturnTone }[] }) {
  if (facts.length === 0) return null;
  return (
    <div className="fact-tags">
      {facts.map((f) => (
        <span className={`fact-tag${f.tone ? ` fact-tag--${f.tone}` : ""}`} key={f.k}>
          <span className="fact-tag__k">{f.k}</span>
          <span className="fact-tag__v mono">{f.v}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The one-line, plain-English read of the scoreboard - a tight headline + one
 * sentence, with the headline figures lifted out as scannable fact-tags instead
 * of buried in prose. Calibrated to never read as a brag: a small sample is
 * "early", a flat/negative pattern is shown honestly, a positive edge is "so
 * far", never "proven".
 */
function VerdictBanner({ summary }: { summary: PerformanceSummary }) {
  const bands = summary.byScoreDecile;
  const hasTiers = bands.length >= 2;
  const top = hasTiers ? bands[bands.length - 1] : null;
  const bottom = hasTiers ? bands[0] : null;
  const lift = summary.lift ?? null;
  const window = WINDOW_LABEL[summary.primaryWindow];

  let kind: "early" | "edge" | "flat" | "thin" = "thin";
  let headline = "";
  let body = "";
  const facts: { k: string; v: string; tone?: ReturnTone }[] = [];

  if (summary.lowSample) {
    kind = "early";
    headline = "Early read — not proof yet";
    body = "Read everything below as directional until more picks settle.";
    facts.push(
      { k: "Settled", v: summary.measuredCount.toLocaleString("en-US") },
      { k: "Solid read at", v: `${MIN_MEANINGFUL_SAMPLE}+` },
      { k: "Window", v: window },
    );
  } else if (hasTiers && lift != null && top && bottom && lift > MEANINGFUL_LIFT) {
    kind = "edge";
    headline = "Higher-rated picks have done better — so far";
    body = `Top-tier picks have out-returned the bottom tier over ${window}.`;
    facts.push(
      { k: "Top tier", v: formatPct(top.avgForwardReturn), tone: tone(top.avgForwardReturn) },
      { k: "Bottom tier", v: formatPct(bottom.avgForwardReturn), tone: tone(bottom.avgForwardReturn) },
    );
  } else if (hasTiers && lift != null && top && bottom) {
    kind = "flat";
    const inverted = lift < -MEANINGFUL_LIFT;
    headline = inverted
      ? "Higher scores haven't predicted better returns yet"
      : "No clear edge from the score yet";
    body = `The spread is ${inverted ? "inverted" : "flat"} over ${window} — shown honestly.`;
    facts.push(
      { k: "Top tier", v: formatPct(top.avgForwardReturn), tone: tone(top.avgForwardReturn) },
      { k: "Bottom tier", v: formatPct(bottom.avgForwardReturn), tone: tone(bottom.avgForwardReturn) },
    );
  } else {
    kind = "thin";
    headline = "Tracking our picks";
    body = "We need more settled picks before top-rated and bottom-rated can be compared.";
    facts.push(
      { k: "Settled", v: summary.measuredCount.toLocaleString("en-US") },
      { k: "Window", v: window },
    );
  }

  return (
    <section className={`tr-verdict tr-verdict--${kind}`} aria-label="Track record summary">
      <span className="tr-verdict__icon" aria-hidden="true">
        {kind === "edge" ? <IconArrowUp size={20} /> : kind === "flat" ? <IconScale size={20} /> : <IconClock size={20} />}
      </span>
      <div className="tr-verdict__copy">
        <h2 className="tr-verdict__headline">{headline}</h2>
        <p className="tr-verdict__body">{body}</p>
        <FactTags facts={facts} />
      </div>
    </section>
  );
}

/** A sample-size meter - shows how close a thin metric is to being trustworthy. */
function SampleMeter({ measured }: { measured: number }) {
  const pct = Math.max(4, Math.min(100, (measured / MIN_MEANINGFUL_SAMPLE) * 100));
  return (
    <div
      className="tr-meter"
      role="img"
      aria-label={`${measured} of about ${MIN_MEANINGFUL_SAMPLE} settled picks needed for a trustworthy read`}
    >
      <div className="tr-meter__track">
        <span className="tr-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="tr-meter__label">
        <span className="mono">{measured}</span>/<span className="mono">{MIN_MEANINGFUL_SAMPLE}</span> for a
        solid read
      </span>
    </div>
  );
}

function ProofStat({
  label,
  value,
  valueTone,
  hint,
  thin,
  measured,
}: {
  label: string;
  value: string;
  valueTone?: ReturnTone;
  hint: string;
  thin: boolean;
  measured?: number;
}) {
  return (
    <div className={`stat perf-stat tr-stat${thin ? " tr-stat--thin" : ""}`}>
      <div className="stat__label">{label}</div>
      <div className={`stat__value perf-figure${valueTone ? ` perf-figure--${valueTone}` : ""} mono`}>
        {value}
      </div>
      <div className="perf-stat__hint">{hint}</div>
      {thin && measured != null && <SampleMeter measured={measured} />}
    </div>
  );
}

function ProofStats({ summary }: { summary: PerformanceSummary }) {
  const measured = summary.measuredCount > 0;
  const thin = summary.lowSample && measured;
  const window = WINDOW_LABEL[summary.primaryWindow];
  const liftText = summary.lift == null ? "—" : formatPct(summary.lift);
  const liftTone: ReturnTone = summary.lift == null ? "flat" : tone(summary.lift);

  return (
    <div className="stat-grid perf-hero tr-proof">
      <ProofStat
        label="Picks that rose"
        value={measured ? formatPctPlain(summary.overallHitRate) : "—"}
        hint={`of ${summary.measuredCount.toLocaleString("en-US")} settled · ${window}`}
        thin={thin}
        measured={summary.measuredCount}
      />
      <ProofStat
        label="Average move"
        value={measured ? formatPct(summary.overallAvgReturn) : "—"}
        valueTone={measured ? tone(summary.overallAvgReturn) : "flat"}
        hint={`across every settled pick · ${window}`}
        thin={thin}
        measured={summary.measuredCount}
      />
      <ProofStat
        label="Top-vs-bottom edge"
        value={liftText}
        valueTone={liftTone}
        hint="top-tier return − bottom-tier"
        thin={thin}
        measured={summary.measuredCount}
      />
      <ProofStat
        label="Settled"
        value={`${summary.measuredCount.toLocaleString("en-US")}`}
        hint={`measured of ${summary.totalTracked.toLocaleString("en-US")} tracked`}
        thin={false}
      />
    </div>
  );
}

/** Coverage-per-window chips + last-run stamp + dropped-count transparency. */
function CoverageRow({ summary }: { summary: PerformanceSummary }) {
  const lastRun = useAppStore((s) => s.lastRun);
  return (
    <div className="perf-toolbar">
      <div className="perf-chips" role="group" aria-label="Forward-return window coverage">
        {FORWARD_WINDOWS.map((w: ForwardWindow) => {
          const active = w === summary.primaryWindow && summary.measuredCount > 0;
          return (
            <span key={w} className={`perf-chip${active ? " perf-chip--active" : ""}`}>
              <span className="perf-chip__label">{WINDOW_LABEL[w]}</span>
              <span className="perf-chip__count mono">
                {summary.windowCoverage[w].toLocaleString("en-US")}
              </span>
            </span>
          );
        })}
        {summary.droppedCount > 0 && (
          <span
            className="perf-chip perf-chip--muted"
            aria-label={`${summary.droppedCount.toLocaleString("en-US")} oldest records rotated out of the capped ledger`}
            title="Oldest records rotated out of the capped ledger"
          >
            <span className="perf-chip__label">rotated out</span>
            <span className="perf-chip__count mono">{summary.droppedCount.toLocaleString("en-US")}</span>
          </span>
        )}
      </div>
      {lastRun?.finishedAt && (
        <span className="perf-toolbar__updated text-faint">Last run {relativeTime(lastRun.finishedAt)}</span>
      )}
    </div>
  );
}

function HighlightList({
  title,
  picks,
  kind,
}: {
  title: string;
  picks: OutcomeHighlight[];
  kind: "hit" | "miss";
}) {
  return (
    <section className="ops-card perf-highlights" aria-label={title}>
      <h3 className="ops-card__title perf-highlights__title">
        {kind === "hit" ? <IconArrowUp size={15} /> : <IconArrowDown size={15} />}
        {title}
      </h3>
      {picks.length === 0 ? (
        <p className="ops-card__sub" style={{ marginTop: "var(--sp-2)" }}>
          Nothing here yet.
        </p>
      ) : (
        <ul className="perf-list">
          {picks.map((p) => (
            <li className="perf-row" key={`${p.ticker}-${p.publishedAtISO}`}>
              <div className="perf-row__id">
                <span className="perf-row__tk mono">{p.ticker}</span>
                <VersionTag variant={p.liveVariant} className="perf-highlight__version" />
                <span className="perf-row__name">{p.name}</span>
              </div>
              <span className="perf-row__score mono" title="Opportunity score at publish">
                {Math.round(p.opportunityScore)}
              </span>
              <span className={`perf-row__ret perf-figure--${tone(p.forwardReturn)} mono`}>
                {formatPct(p.forwardReturn)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Plain-language "how we measure" - the trust spine. Matches engine behavior. */
function MethodologyStrip() {
  const steps = [
    {
      icon: <IconTarget size={16} />,
      title: "Freeze the score",
      body: "Each pick's 0–100 score is locked at publish.",
    },
    {
      icon: <IconClock size={16} />,
      title: "Wait for the window",
      body: "Watch the real price 7 / 30 / 90 days out — no peeking.",
    },
    {
      icon: <IconScale size={16} />,
      title: "Compare, honestly",
      body: "Did higher scores rise more? Wins and misses both count.",
    },
  ];
  return (
    <section className="ops-card tr-method" aria-label="How performance is measured">
      <h3 className="ops-card__title">How we measure this</h3>
      <ol className="tr-method__steps">
        {steps.map((s, i) => (
          <li className="tr-method__step" key={s.title}>
            <span className="tr-method__num" aria-hidden="true">
              {s.icon}
            </span>
            <div>
              <div className="tr-method__step-title">
                <span className="tr-method__idx mono" aria-hidden="true">
                  {i + 1}
                </span>
                {s.title}
              </div>
              <p className="tr-method__step-body">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TrackRecord({
  summary,
  versionFilter,
  onVersionFilter,
}: {
  summary: PerformanceSummary;
  versionFilter: LedgerVersionFilter;
  onVersionFilter: (next: LedgerVersionFilter) => void;
}) {
  const measured = summary.measuredCount > 0;
  const noteWarn = summary.lowSample && measured;
  const canStair = measured && summary.byScoreDecile.length >= 2;
  const fullLedger = useAppStore((s) => s.outcomeLedger);
  // Every section below reads the SAME filtered slice, so the verdict, the
  // proof stats, the monthly rollup and the recent calls never disagree about
  // which engine's record is on screen.
  const ledger = useMemo(() => filterLedgerByVariant(fullLedger, versionFilter), [fullLedger, versionFilter]);
  const present = useMemo(() => ledgerVersionsPresent(fullLedger), [fullLedger]);
  const counts = useMemo(() => {
    const c: Partial<Record<LedgerVersionFilter, number>> = { all: fullLedger.entries.length, untagged: 0 };
    for (const e of fullLedger.entries) {
      const k: LedgerVersionFilter = e.liveVariant ?? "untagged";
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [fullLedger]);
  const filterLabel =
    versionFilter === "all" ? null : versionFilter === "untagged" ? "untagged" : VARIANT_VERSION_TAGS[versionFilter];

  return (
    <div className="tr">
      <VersionFilter
        value={versionFilter}
        onChange={onVersionFilter}
        variantsPresent={present.variants}
        hasUntagged={present.hasUntagged}
        counts={counts}
      />
      {filterLabel && ledger.entries.length === 0 ? (
        <div className="ops-banner perf-pending" role="status">
          <IconInfo size={16} />
          <span>
            No {filterLabel} picks recorded yet — picks are tagged with their engine version from the day
            that version goes live.
          </span>
        </div>
      ) : null}
      <VerdictBanner summary={summary} />
      <ProofStats summary={summary} />
      <CoverageRow summary={summary} />

      <div className={`perf-note${noteWarn ? " perf-note--warn" : ""}`} role="note">
        {noteWarn ? <IconAlertTriangle size={15} /> : <IconInfo size={15} />}
        <span>{summary.coverageNote}</span>
      </div>

      {measured ? (
        <>
          {canStair ? (
            <RankPerformanceChart
              buckets={rankPerfBucketsFromStats(summary.byScoreDecile)}
              windowLabel={WINDOW_LABEL[summary.primaryWindow]}
              lowSample={summary.lowSample}
            />
          ) : (
            <div className="ops-banner perf-pending" role="status">
              <IconInfo size={16} />
              <span>
                {summary.measuredCount.toLocaleString("en-US")} pick
                {summary.measuredCount === 1 ? "" : "s"} settled — a wider spread of scores is needed
                to compare top-rated against bottom-rated.
              </span>
            </div>
          )}
          <div className="perf-highlight-grid">
            <HighlightList title="Best calls" picks={summary.topHits} kind="hit" />
            <HighlightList title="Honest misses" picks={summary.worstMisses} kind="miss" />
          </div>
        </>
      ) : (
        <div className="ops-banner perf-pending" role="status">
          <IconInfo size={16} />
          <span>
            {summary.totalTracked.toLocaleString("en-US")} pick
            {summary.totalTracked === 1 ? "" : "s"} being tracked. Returns and the rank staircase
            appear here once the first 7-day window elapses.
          </span>
        </div>
      )}

      {/* Monthly portfolio rollup - groups all history into per-period buckets
          so 90+ days of picks don't scroll forever in the recent-calls list. */}
      <MonthlyPortfolio entries={ledger.entries} />

      {/* Recent-days detail - top picks per day with live progress. */}
      <RecentCalls versionFilter={versionFilter} />

      <MethodologyStrip />
      <InvestingDisclaimer className="page-disclaimer" />
    </div>
  );
}

// ── (b) OPERATOR cockpit (admin-only) ─────────────────────────────────────────

function OperatorCockpit({ summary }: { summary: PerformanceSummary }) {
  return (
    <section className="op-cockpit" id="model-lab" aria-label="Model Lab — Champion vs Challenger">
      <ChampionChallengerBoard summary={summary} />
    </section>
  );
}

// ── Shared states ─────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="perf-loading" aria-busy="true" aria-label="Loading performance">
      <LoadingNote
        label="the track record"
        hint="Reading the outcome ledger — a moment, not stuck."
      />
      <div className="stat-grid perf-hero">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat perf-stat" key={i}>
            <Skeleton width={90} height={11} />
            <Skeleton width={70} height={24} style={{ marginTop: 10 }} />
            <Skeleton width={120} height={10} style={{ marginTop: 10 }} />
          </div>
        ))}
      </div>
      <div className="ops-card" style={{ marginTop: "var(--sp-4)" }}>
        <Skeleton width={260} height={14} />
        <div className="col gap-3" style={{ marginTop: "var(--sp-4)" }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} width="100%" height={22} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="ops-banner ops-banner--error" role="alert">
      <IconAlertTriangle size={16} />
      <span>Couldn&apos;t read the outcome ledger: {message}</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Performance() {
  const ledger = useAppStore((s) => s.outcomeLedger);
  const researchStatus = useAppStore((s) => s.researchStatus);
  const email = useAuthStore((s) => s.email);
  const authReady = useAuthStore((s) => s.ready);
  const isAdmin = authReady && isAdminEmail(email);
  const { search } = useLocation();

  const [versionFilter, setVersionFilter] = useState<LedgerVersionFilter>("all");
  const { summary, error } = useMemo(() => {
    try {
      return {
        summary: summarizePerformance(filterLedgerByVariant(ledger, versionFilter)),
        error: null as string | null,
      };
    } catch (e) {
      return {
        summary: null as PerformanceSummary | null,
        error: e instanceof Error ? e.message : "unexpected ledger shape",
      };
    }
  }, [ledger, versionFilter]);

  // Two nav entries share this route, split by ?view=lab. They are DIFFERENT
  // surfaces - make that obvious in the header so they never read as duplicates:
  //   • /performance            → "Track Record": the public, plain-language proof
  //     (hit rate, average move, does-the-score-work). Visible to everyone.
  //   • /performance?view=lab   → "Model Lab": the champion-vs-challenger comparison
  //     (rank-IC, divergences). READ-ONLY - visible to everyone; the actual
  //     promote/rollback controls live in the gated Operator console, not here.
  const labView = new URLSearchParams(search).get("view") === "lab";
  const header = labView ? (
    <PageHeader
      title="Model Lab"
      description="Champion vs challenger — the same universe ranked two ways. A read-only look under the hood; promoting a model lives in the Operator console."
    />
  ) : (
    <PageHeader
      title="Track Record"
      description="Do higher scores predict better returns? Recorded from every research run."
    />
  );

  if (error || !summary) {
    return (
      <>
        {header}
        <ErrorState message={error ?? "unexpected ledger shape"} />
      </>
    );
  }

  // Model Lab (operator-only, ?view=lab) is its OWN surface - render JUST the
  // champion-vs-challenger cockpit so it never reads as a copy of the public
  // Track Record scrolling beneath it. The two nav entries now open genuinely
  // different pages.
  if (labView) {
    return (
      <>
        {header}
        <OperatorCockpit summary={summary} />
      </>
    );
  }

  // Loading: a run is in flight and we have nothing to show yet.
  if (researchStatus === "running" && summary.totalTracked === 0) {
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  }

  // Cold-start: fresh install / never recorded an outcome. Operators still get
  // a pointer to the Model Lab via the nav; here we show only the public
  // "what we'll prove and when" so Track Record stays clearly the public view.
  if (summary.totalTracked === 0) {
    return (
      <>
        {header}
        <PerformanceColdStart summary={summary} isAdmin={isAdmin} />
      </>
    );
  }

  return (
    <>
      {header}
      <TrackRecord summary={summary} versionFilter={versionFilter} onVersionFilter={setVersionFilter} />
    </>
  );
}
