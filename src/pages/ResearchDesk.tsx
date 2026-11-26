import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/common/PageHeader";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { Skeleton } from "@/components/common/Skeleton";
import { FeedState } from "@/components/common/FeedState";
import { ExternalLink } from "@/components/common/ExternalLink";
import {
  IconSearch,
  IconSparkle,
  IconScale,
  IconShield,
  IconExternal,
  IconRefresh,
  IconClock,
  IconCheck,
  IconInfo,
  IconArrowUp,
  IconArrowDown,
  IconTarget,
  IconAlertTriangle,
} from "@/components/icons";
import {
  researchAgentStatus,
  type ResearchAgentLane,
  type ResearchProxyErrorKind,
} from "@/data/ai/researchAgent";
import { useResearchDeskStore } from "@/store/useResearchDeskStore";
import { useAppStore } from "@/store/useAppStore";
import { SparklineButton } from "@/components/signal/SparklineButton";
import { subscribeApiUsage } from "@/lib/apiUsage";
import { formatMarketCap } from "@/lib/format";
import type {
  CallScore,
  CitedClaim,
  FilingRef,
  ResearchDebate,
  ResearchIntel,
  VerifiedFacts,
} from "@/types";
import { resolveVerdict } from "@/engine/deskVerdict";
import "@/styles/research-desk.css";

const EXAMPLE_TICKERS = ["NOW", "ACHR", "SOFI"];
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,6}$/;
/** Typical end-to-end grounded-run duration, used only to pace the progress UI. */
const TYPICAL_RUN_MS = 95_000;

/** Mirrors the agent's failure kinds (lane-off/paused/invalid map onto these). */
type ErrorKind = ResearchProxyErrorKind;

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/** 0–100 → score-band class used across the app's tokenized palette. */
function band(v: number): "high" | "good" | "mid" | "low" {
  if (v >= 75) return "high";
  if (v >= 55) return "good";
  if (v >= 35) return "mid";
  return "low";
}

function fmtDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Honest, human title for each failure mode - never a raw `HTTP 500`. */
function errorTitle(kind: ErrorKind): string {
  switch (kind) {
    case "timeout":
      return "The desk timed out";
    case "rate_limited":
      return "The desk is busy";
    case "bad_request":
      return "Couldn’t run that ticker";
    case "unconfigured":
      return "Research desk not connected";
    case "empty":
      return "Nothing to report yet";
    default:
      return "Diligence unavailable";
  }
}

/**
 * Calibrated conviction. A null/undefined score is a real answer ("the desk
 * couldn't calibrate") - we surface it honestly rather than inventing a number.
 */
function ConfidenceMeter({ value }: { value?: number | null }) {
  if (value == null) {
    return (
      <div className="rd-confidence rd-confidence--na">
        <div className="rd-confidence__head">
          <span className="rd-confidence__label">Conviction</span>
          <span className="rd-chip rd-chip--muted">Unavailable</span>
        </div>
        <p className="rd-confidence__na-note">
          Not enough dated, citable evidence to put a confidence number behind
          this read.
        </p>
      </div>
    );
  }
  const b = band(value);
  return (
    <div className="rd-confidence">
      <div className="rd-confidence__head">
        <span className="rd-confidence__label">Conviction</span>
        <span className={`rd-confidence__value mono rd-band--${b}`}>{value}</span>
        <span className="rd-confidence__scale text-faint mono">/100</span>
      </div>
      <div
        className="rd-meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-label="Calibrated conviction"
      >
        <div className={`rd-meter__fill rd-band-bg--${b}`} style={{ width: `${value}%` }} />
      </div>
      <p className="rd-confidence__cal text-faint">Calibrated, not a price target.</p>
    </div>
  );
}

/** Semicircular earnings-call gauge (deterministic FinBERT tone read). */
function CallGauge({ score }: { score?: CallScore | null }) {
  const available = score?.available && score?.score != null;
  const value = available ? (score!.score as number) : 0;
  const b = band(value);
  const callDate = fmtDate(score?.callDate);
  return (
    <div className="rd-gauge-card">
      <div className="rd-gauge__top">
        <span className="rd-section-eyebrow">Earnings call</span>
        {callDate ? <span className="text-faint mono rd-gauge__date">{callDate}</span> : null}
      </div>
      <div className={`rd-gauge ${available ? "" : "rd-gauge--na"}`}>
        <svg viewBox="0 0 160 92" className="rd-gauge__svg" aria-hidden="true">
          <path className="rd-gauge__track" d="M12,84 A68,68 0 0 1 148,84" pathLength={100} />
          {available ? (
            <path
              className={`rd-gauge__fill rd-band-stroke--${b}`}
              d="M12,84 A68,68 0 0 1 148,84"
              pathLength={100}
              style={{ strokeDasharray: `${value} 100` }}
            />
          ) : null}
        </svg>
        <div className="rd-gauge__readout">
          {available ? (
            <>
              <span className={`rd-gauge__num mono rd-band--${b}`}>{value}</span>
              <span className="rd-gauge__lbl">{score?.label ?? ""}</span>
            </>
          ) : (
            <>
              <span className="rd-gauge__num rd-gauge__num--na">—</span>
              <span className="rd-gauge__lbl text-faint">Unavailable</span>
            </>
          )}
        </div>
      </div>
      <p className="rd-gauge__reason text-faint">
        {available
          ? score?.source
            ? `Tone scored from ${score.source}.`
            : "Tone scored from the latest call."
          : score?.reason ?? "No call was available to score for this name yet."}
      </p>
    </div>
  );
}

/** One citation-verified claim with its dated, sourced evidence. */
function ClaimCard({ claim, side }: { claim: CitedClaim; side: "bull" | "bear" }) {
  const counter = claim.kind === "counter";
  return (
    <article className={`rd-claim rd-claim--${side}`}>
      <p className="rd-claim__text">
        {counter ? <span className="rd-claim__counter">Counterpoint</span> : null}
        {claim.claim}
      </p>
      {claim.citations && claim.citations.length > 0 ? (
        <ul className="rd-claim__cites">
          {claim.citations.map((c, i) => {
            const date = fmtDate(c.date);
            return (
              <li key={c.spanId ?? `${side}-${i}`} className="rd-cite">
                <div className="rd-cite__meta">
                  <span className="rd-cite__source">{c.source}</span>
                  {date ? <span className="rd-cite__date mono">{date}</span> : null}
                  {c.url ? (
                    <ExternalLink href={c.url} className="rd-cite__link" aria-label="Open source">
                      <IconExternal size={12} />
                    </ExternalLink>
                  ) : null}
                </div>
                {c.quote ? <blockquote className="rd-cite__quote">“{c.quote}”</blockquote> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rd-claim__uncited text-faint">Stated without a dated citation.</p>
      )}
    </article>
  );
}

function ProvenanceBar({ asOfDate, filings }: { asOfDate?: string; filings?: FilingRef[] }) {
  const asOf = fmtDate(asOfDate);
  if (!asOf && (!filings || filings.length === 0)) return null;
  return (
    <div className="rd-provenance">
      <IconClock size={14} />
      <span className="rd-provenance__lead">
        {asOf ? <>As of <strong>{asOf}</strong></> : "Point-in-time read"}
        {filings && filings.length > 0 ? ` · from ${filings.length} filing${filings.length > 1 ? "s" : ""}` : ""}
      </span>
      {filings && filings.length > 0 ? (
        <div className="rd-provenance__chips">
          {filings.map((f, i) => {
            const d = fmtDate(f.filingDate);
            const label = d ? `${f.form} · ${d}` : f.form;
            return f.url ? (
              <ExternalLink key={`${f.form}-${i}`} href={f.url} className="rd-filing-chip">
                {label}
              </ExternalLink>
            ) : (
              <span key={`${f.form}-${i}`} className="rd-filing-chip rd-filing-chip--static">
                {label}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Desk page
// ---------------------------------------------------------------------------

export function ResearchDesk() {
  const [params, setParams] = useSearchParams();
  const paramTicker = (params.get("ticker") ?? params.get("t") ?? "").trim().toUpperCase();

  const [query, setQuery] = useState(paramTicker);
  const [validationError, setValidationError] = useState<string>("");

  // Run state lives in the store (module scope) so leaving the tab mid-run keeps
  // the run alive and returning re-reads it - never a destroyed run / lost result.
  const entries = useResearchDeskStore((s) => s.entries);
  const activeTicker = useResearchDeskStore((s) => s.activeTicker);
  const runStore = useResearchDeskStore((s) => s.run);

  const [lane, setLane] = useState<ResearchAgentLane>(() => researchAgentStatus().lane);
  const [pausedReason, setPausedReason] = useState<string | undefined>(
    () => researchAgentStatus().reason,
  );

  const entry = activeTicker ? entries[activeTicker] : undefined;
  // A local validation failure (bad ticker) trumps the store entry - it's a
  // pre-flight reject, no run was started.
  const state: "idle" | "loading" | "done" | "error" = validationError
    ? "error"
    : entry?.state ?? "idle";

  const run = (raw: string) => {
    const ticker = raw.trim().toUpperCase();
    if (!ticker) return;
    setValidationError("");
    if (!TICKER_RE.test(ticker)) {
      setValidationError(
        `“${ticker}” doesn’t look like a US ticker. Try a symbol like NOW, ACHR or SOFI.`,
      );
      useResearchDeskStore.getState().setActiveTicker(null);
      return;
    }
    const live = researchAgentStatus();
    setLane(live.lane);
    setPausedReason(live.reason);
    // Force a fresh run on explicit submit/re-run; the store still de-dupes
    // remount re-fetches.
    runStore(ticker, { force: true });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = query.trim().toUpperCase();
    if (!t) return;
    setParams({ ticker: t }, { replace: true });
    run(t);
  };

  // Auto-run when arrived via deep-link (?ticker=). The store de-dupes: if a run
  // is already loading/done for this ticker it just re-focuses it (no re-fetch).
  useEffect(() => {
    if (!paramTicker) return;
    setQuery(paramTicker);
    if (TICKER_RE.test(paramTicker)) {
      setValidationError("");
      runStore(paramTicker); // not forced - re-focuses an existing read
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the URL ticker
  }, [paramTicker]);

  // Keep the lane status fresh for the inline banner / button.
  useEffect(() => {
    const s = researchAgentStatus();
    setLane(s.lane);
    setPausedReason(s.reason);
  }, [state]);

  // Live-reflect Operator pause/unpause + budget changes so the lane banner and
  // button never lie about whether the desk can run right now.
  useEffect(() => {
    const refresh = () => {
      const s = researchAgentStatus();
      setLane(s.lane);
      setPausedReason(s.reason);
    };
    return subscribeApiUsage(refresh);
  }, []);

  const running = state === "loading";
  const intel = state === "done" ? entry?.intel ?? null : null;
  const errorKind: ErrorKind = validationError ? "bad_request" : entry?.errorKind ?? "unreachable";
  const errorMsg = validationError || entry?.error || "Research service unavailable — try again.";
  const inFlightTicker = entry?.ticker ?? activeTicker ?? query;

  const hasDeskFields =
    intel != null &&
    (Boolean(intel.thesis) ||
      Boolean(intel.debate?.bull) ||
      Boolean(intel.debate?.bear) ||
      (intel.citedBull?.length ?? 0) > 0 ||
      (intel.citedBear?.length ?? 0) > 0 ||
      intel.confidence != null ||
      (intel.whatWouldFlipIt?.length ?? 0) > 0);

  return (
    <div className="research-desk">
      <PageHeader
        title="Research Desk"
        description="Pick any stock for a deep read: a Bull vs Bear debate and a judge’s verdict. The daily scan narrows the U.S. market to roughly 500 actively-traded stocks to research."
      />

      {/* Stock picker - the one primary action */}
      <form className="rd-picker" onSubmit={submit}>
        <div className="rd-picker__field">
          <IconSearch size={18} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            placeholder="Ticker — e.g. NOW, ACHR, SOFI"
            spellCheck={false}
            autoFocus
            aria-label="Ticker to research"
          />
          <button className="btn btn--primary" type="submit" disabled={running || !query.trim()}>
            {running ? <span className="spinner" /> : <IconSparkle size={15} />}
            {running ? "Researching…" : "Run research"}
          </button>
        </div>
        <div className="rd-picker__examples">
          <span className="text-faint">Try</span>
          {EXAMPLE_TICKERS.map((t) => (
            <button
              key={t}
              type="button"
              className="rd-example-chip"
              onClick={() => {
                setQuery(t);
                setParams({ ticker: t }, { replace: true });
                run(t);
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </form>

      {/* Lane status - proactive context before the user acts. Once a run starts
          (loading / error / done) the dedicated surface below takes over, so the
          message never double-renders. */}
      {lane === "off" && state === "idle" ? (
        <div className="rd-banner">
          <IconInfo size={15} />
          <span>The research desk isn&apos;t connected in this build — runs will explain how to enable it.</span>
        </div>
      ) : null}
      {lane === "paused" && state === "idle" ? (
        <div className="rd-banner rd-banner--warn">
          <IconClock size={15} />
          <span>{pausedReason ?? "The desk’s daily budget is spent. It resets at local midnight."}</span>
        </div>
      ) : null}

      {/* Live progress - the desk is doing real grounded web research (~60-120s),
          so narrate the stages + ETA right below the search bar instead of leaving
          only bare skeletons. The skeleton beneath reserves the result layout. */}
      {running ? (
        <>
          <DeskProgress ticker={inFlightTicker} />
          <DeskSkeleton />
        </>
      ) : null}

      {/* Error - honest title per failure mode, with a useful next action. A
          missing proxy can't be retried, so it links to the explainer instead. */}
      {state === "error" ? (
        <FeedState
          variant={errorKind === "unconfigured" || errorKind === "empty" ? "empty" : "error"}
          title={errorTitle(errorKind)}
          action={
            errorKind === "unconfigured" ? (
              <Link to="/core" className="btn btn--ghost btn--sm">
                How the desk connects →
              </Link>
            ) : (
              <button className="btn btn--ghost btn--sm" onClick={() => run(query)}>
                Try again
              </button>
            )
          }
        >
          {errorMsg}
        </FeedState>
      ) : null}

      {/* Result */}
      {state === "done" && intel ? (
        <DeskResult intel={intel} hasDeskFields={hasDeskFields} onRerun={() => run(intel.ticker ?? query)} />
      ) : null}

      {/* Empty / first-run */}
      {state === "idle" && lane !== "off" ? (
        <div className="rd-empty">
          <div className="rd-empty__icon" aria-hidden="true">
            <IconScale size={26} />
          </div>
          <h3>Pick a stock to research</h3>
          <p className="text-muted">
            Each day we narrow the U.S. market to roughly 500 actively-traded stocks, then pull live
            prices, fundamentals, news, congressional disclosures, and SEC filings (Form 4 insider
            trades, 8-K material events). For any ticker, the desk argues the bull case and the bear
            case from dated, citable evidence — then a judge weighs in with a verdict.
          </p>
        </div>
      ) : null}

      <InvestingDisclaimer className="page-disclaimer" />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Cosmetic, time-paced stages for the live grounded run (the desk has no
 *  store-backed pipeline like the market scan, so we narrate by elapsed time). */
const RUN_STAGES = [
  { label: "Searching the live web", detail: "Pulling the freshest sources for this ticker" },
  { label: "Reading news, filings & catalysts", detail: "Earnings, 8-Ks, FDA/clinical, M&A, contracts" },
  { label: "Arguing bull vs bear", detail: "Building both cases from dated, citable evidence" },
  { label: "Writing the judge’s verdict", detail: "Weighing the debate into a stance + conviction" },
] as const;

/**
 * Live progress narrator for a deep run - mirrors the market-scan ResearchNarrator
 * (headline + ETA + bar + stages) so the wait reads as "the AI is working", not a
 * frozen screen. Pure cosmetic pacing off elapsed time; the real result replaces it.
 */
function DeskProgress({ ticker }: { ticker: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - start), 200);
    return () => window.clearInterval(id);
  }, []);
  const frac = Math.min(0.97, elapsed / TYPICAL_RUN_MS);
  const stageIdx = Math.min(RUN_STAGES.length - 1, Math.floor(frac * RUN_STAGES.length));
  const active = RUN_STAGES[stageIdx]!;
  const remainingMs = Math.max(0, TYPICAL_RUN_MS - elapsed);
  const eta =
    frac >= 0.95
      ? "wrapping up…"
      : remainingMs > 1500
        ? `~${Math.ceil(remainingMs / 1000)}s left`
        : "a few seconds left";

  return (
    <div className="rd-progress" role="status" aria-live="polite">
      <div className="rd-progress__glyph" aria-hidden="true">
        <span className="rd-progress__pulse" />
        <IconSparkle size={16} />
      </div>
      <div className="rd-progress__body">
        <div className="rd-progress__head">
          <span className="rd-progress__title">
            Researching <span className="mono">{ticker || "—"}</span>
            <span className="rd-progress__dots" aria-hidden="true" />
          </span>
          <span className="rd-progress__eta mono">{eta}</span>
        </div>
        <p className="rd-progress__detail">{active.detail}</p>
        <div className="rd-progress__track">
          <span className="rd-progress__fill" style={{ width: `${Math.round(frac * 100)}%` }} />
        </div>
        <ol className="rd-progress__stages">
          {RUN_STAGES.map((s, i) => {
            const st = i < stageIdx ? "done" : i === stageIdx ? "active" : "todo";
            return (
              <li key={s.label} className={`rd-progress__stage rd-progress__stage--${st}`}>
                <span className="rd-progress__stage-dot" aria-hidden="true" />
                {s.label}
              </li>
            );
          })}
        </ol>
        <p className="rd-progress__note text-faint">
          Live research — not cached. The AI is reading real sources, so a thorough read takes a bit.
        </p>
      </div>
    </div>
  );
}

function DeskSkeleton() {
  return (
    <div className="rd-result" aria-busy="true">
      <div className="rd-verdict rd-card">
        <Skeleton height={14} width={90} />
        <Skeleton height={26} width={140} style={{ marginTop: 14, borderRadius: 999 }} />
        <Skeleton height={20} width="86%" style={{ marginTop: 16 }} />
        <Skeleton height={20} width="62%" style={{ marginTop: 6 }} />
      </div>
      <div className="rd-debate">
        {["bull", "bear"].map((s) => (
          <div className="rd-card" key={s}>
            <Skeleton height={16} width={120} />
            <Skeleton height={64} width="100%" style={{ marginTop: 14 }} />
            <Skeleton height={64} width="100%" style={{ marginTop: 10 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Verified-facts surfaces (authoritative, server-fetched; never guessed) ---

function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function usdShort(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}
function compactShares(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(a / 1e3).toFixed(0)}K`;
  return `${a}`;
}

/**
 * Compact, honest facts strip the desk shows ABOVE the AI read - price,
 * profitability, valuation, and recent insider buys/sells - all fetched live
 * server-side and rendered verbatim. This is the trust anchor: the numbers the
 * analyst read is checked against, shown to the user so a stale model claim can't
 * hide.
 */
function VerifiedFactsPanel({ facts, ticker }: { facts: VerifiedFacts; ticker?: string }) {
  const signal = useAppStore((s) => s.signals).find((x) => x.ticker === (ticker ?? facts.ticker));
  const prof = facts.profitability;
  const profChip =
    prof === "profitable"
      ? { cls: "rd-fact--good", label: "Profitable" }
      : prof === "unprofitable"
        ? { cls: "rd-fact--warn", label: "Not yet profitable" }
        : null;
  const buys = facts.insiderBuys ?? [];
  const sells = facts.insiderSells ?? [];

  return (
    <div className="rd-vfacts">
      <div className="rd-vfacts__row">
        {facts.price != null ? (
          <div className="rd-vfacts__price">
            <span className="rd-vfacts__px mono">${facts.price.toFixed(2)}</span>
            {facts.dayChangePct != null ? (
              <span className={`rd-vfacts__chg mono ${facts.dayChangePct >= 0 ? "rd-band--high" : "rd-band--low"}`}>
                {facts.dayChangePct >= 0 ? "+" : ""}
                {facts.dayChangePct.toFixed(1)}%
              </span>
            ) : null}
            <span className="rd-vfacts__live">Live</span>
          </div>
        ) : null}
        {signal ? <SparklineButton signal={signal} width={104} height={34} /> : null}
        {(ticker ?? facts.ticker) ? (
          <Link
            to={`/beacon?t=${encodeURIComponent((ticker ?? facts.ticker).toUpperCase())}`}
            className="rd-vfacts__scope linkish"
          >
            Ticker Scope →
          </Link>
        ) : null}
      </div>
      <div className="rd-vfacts__chips">
        {profChip ? (
          <span className={`rd-fact ${profChip.cls}`} title={facts.profitabilityBasis}>
            {profChip.label}
          </span>
        ) : null}
        {facts.marketCapB != null ? (
          <span className="rd-fact">
            <span className="rd-fact__k">Mkt cap</span>
            <span className="rd-fact__v mono">{formatMarketCap(facts.marketCapB * 1e9)}</span>
          </span>
        ) : null}
        {facts.peTTM != null && facts.peTTM > 0 && facts.peTTM < 2000 ? (
          <span className="rd-fact">
            <span className="rd-fact__k">P/E</span>
            <span className="rd-fact__v mono">{facts.peTTM.toFixed(1)}</span>
          </span>
        ) : null}
        {facts.revenueGrowthYoYPct != null ? (
          <span className="rd-fact">
            <span className="rd-fact__k">Rev YoY</span>
            <span className="rd-fact__v mono">
              {facts.revenueGrowthYoYPct >= 0 ? "+" : ""}
              {facts.revenueGrowthYoYPct.toFixed(0)}%
            </span>
          </span>
        ) : null}
        {facts.week52Low != null && facts.week52High != null ? (
          <span className="rd-fact">
            <span className="rd-fact__k">52wk</span>
            <span className="rd-fact__v mono">
              ${facts.week52Low.toFixed(2)}–${facts.week52High.toFixed(2)}
            </span>
          </span>
        ) : null}
      </div>
      {buys.length > 0 || sells.length > 0 ? (
        <div className="rd-insider">
          <span className="rd-insider__eyebrow">Insider activity · last ~120d · SEC Form 4</span>
          {buys.length > 0 ? (
            <div className="rd-insider__line rd-insider__line--buy">
              <span className="rd-insider__tag">Buys</span>
              {buys.slice(0, 3).map((b, i) => (
                <span key={`b-${i}`} className="rd-insider__item">
                  {b.name} <span className="mono">+{compactShares(b.change)}</span> (~{usdShort(b.valueUsd)}){" "}
                  {shortDate(b.date)}
                </span>
              ))}
            </div>
          ) : null}
          {sells.length > 0 ? (
            <div className="rd-insider__line rd-insider__line--sell">
              <span className="rd-insider__tag">Sells</span>
              {sells.slice(0, 3).map((s, i) => (
                <span key={`s-${i}`} className="rd-insider__item">
                  {s.name} <span className="mono">−{compactShares(s.change)}</span> (~{usdShort(s.valueUsd)}){" "}
                  {shortDate(s.date)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- The debate (judge verdict → equal bull/bear columns → catalysts/risks) ---

type Stance = NonNullable<ResearchDebate["stance"]>;

/** Stance → tokenized pill style + label. Bullish leans to the brand's positive
 *  (azure/high), bearish to coral (low/bear), mixed to a neutral gold (mid). */
function stancePill(stance?: Stance): { cls: string; label: string } {
  switch (stance) {
    case "bullish":
      return { cls: "rd-stance--bull", label: "Bullish" };
    case "bearish":
      return { cls: "rd-stance--bear", label: "Bearish" };
    case "mixed":
      return { cls: "rd-stance--mixed", label: "Mixed" };
    default:
      // Unreachable now that `resolveVerdict` always yields a stance, but kept as
      // a typed total-function fallback rather than a user-visible shrug.
      return { cls: "rd-stance--mixed", label: "Balanced" };
  }
}

/**
 * The JUDGE VERDICT - the lead. A prominent, color-coded stance pill + conviction
 * meter + the 2-3 sentence synthesis. This is the one primary element of the
 * result: it answers "so what's the read?" before the user reads either case.
 */
function JudgeVerdict({
  intel,
  synthesis,
  onRerun,
}: {
  intel: ResearchIntel;
  synthesis: string;
  onRerun: () => void;
}) {
  const debate = intel.debate;
  // NEVER render "No verdict". When the judge lane fails to return a stance the
  // desk still has a full cited bull case, bear case and sentiment read, so the
  // resolver nets those into an honestly-labelled LEAN at capped conviction
  // instead of refusing to answer. See engine/deskVerdict.ts.
  const verdict = resolveVerdict(intel);
  const pill = { ...stancePill(verdict.stance), label: verdict.label };
  const conviction = verdict.confidence;

  return (
    <section className={`rd-verdict rd-card rd-verdict--${verdict.stance}`}>
      <div className="rd-verdict__top">
        <div className="rd-verdict__id">
          <span className="rd-ticker mono">{intel.ticker ?? "—"}</span>
          {intel.model ? <span className="rd-model mono text-faint">{intel.model}</span> : null}
        </div>
        <button className="rd-icon-btn" onClick={onRerun} title="Re-run research" aria-label="Re-run research">
          <IconRefresh size={15} />
        </button>
      </div>

      {intel.verifiedFacts ? <VerifiedFactsPanel facts={intel.verifiedFacts} ticker={intel.ticker} /> : null}

      <div className="rd-verdict__head">
        <span className="rd-section-eyebrow">The verdict</span>
        <span className={`rd-stance ${pill.cls}`} title={verdict.basis}>
          {verdict.stance === "bullish" ? (
            <IconArrowUp size={13} />
          ) : verdict.stance === "bearish" ? (
            <IconArrowDown size={13} />
          ) : (
            <IconScale size={13} />
          )}
          {pill.label}
        </span>
      </div>

      <div className="rd-verdict__body">
        <p className="rd-verdict__synthesis">{synthesis}</p>
        <div className="rd-verdict__conviction">
          <ConfidenceMeter value={conviction} />
          {intel.callScore?.available ? <CallGauge score={intel.callScore} /> : null}
        </div>
      </div>
    </section>
  );
}

/** One side of the debate as a first-class column: prose case + dated citations,
 *  or - when the debate prose is absent - the cited claim cards / degraded points
 *  for that side. Equal visual weight to its sibling. */
function CaseColumn({
  side,
  prose,
  claims,
  fallbackPoints,
}: {
  side: "bull" | "bear";
  prose?: string;
  claims: CitedClaim[];
  fallbackPoints?: string[];
}) {
  const isBull = side === "bull";
  const count = claims.length;
  return (
    <section className={`rd-case-col rd-case-col--${side}`}>
      <header className="rd-case-col__head">
        <span className="rd-case-col__icon" aria-hidden="true">
          {isBull ? <IconArrowUp size={15} /> : <IconArrowDown size={15} />}
        </span>
        <h3 className="rd-case-col__title">{isBull ? "Bull case" : "Bear case"}</h3>
        {count > 0 ? <span className="rd-case-col__count mono">{count}</span> : null}
      </header>

      {prose ? (
        <p className="rd-case-col__prose">{prose}</p>
      ) : null}

      {claims.length > 0 ? (
        <div className="rd-case-col__claims">
          {claims.map((c, i) => (
            <ClaimCard key={`${side}-${i}`} claim={c} side={side} />
          ))}
        </div>
      ) : !prose && fallbackPoints && fallbackPoints.length > 0 ? (
        <ul className="rd-points">
          {fallbackPoints.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : !prose ? (
        <p className="rd-case-col__empty text-faint">
          {isBull
            ? "No bull claims had a dated source to back them up."
            : "No bear claims had a dated source to back them up."}
        </p>
      ) : null}
    </section>
  );
}

/** Key catalysts / key risks as tokenized chips - the debate's drivers at a glance. */
function DriverChips({
  catalysts,
  risks,
}: {
  catalysts: string[];
  risks: string[];
}) {
  if (catalysts.length === 0 && risks.length === 0) return null;
  return (
    <section className="rd-drivers">
      {catalysts.length > 0 ? (
        <div className="rd-drivers__group rd-drivers__group--cat">
          <div className="rd-drivers__head">
            <IconTarget size={14} />
            <span className="rd-section-eyebrow">Key catalysts</span>
          </div>
          <div className="rd-drivers__chips">
            {catalysts.map((c, i) => (
              <span key={`cat-${i}`} className="rd-driver-chip rd-driver-chip--cat">
                {c}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {risks.length > 0 ? (
        <div className="rd-drivers__group rd-drivers__group--risk">
          <div className="rd-drivers__head">
            <IconAlertTriangle size={14} />
            <span className="rd-section-eyebrow">Key risks</span>
          </div>
          <div className="rd-drivers__chips">
            {risks.map((r, i) => (
              <span key={`risk-${i}`} className="rd-driver-chip rd-driver-chip--risk">
                {r}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DeskResult({
  intel,
  hasDeskFields,
  onRerun,
}: {
  intel: ResearchIntel;
  hasDeskFields: boolean;
  onRerun: () => void;
}) {
  const debate = intel.debate;
  const bullClaims = intel.citedBull ?? [];
  const bearClaims = intel.citedBear ?? [];
  const hasDegradedPoints = Boolean(intel.bullPoints?.length || intel.bearPoints?.length);

  // The synthesis the verdict leads with: the 2-3 sentence summary, falling back
  // to the thesis line (older responses put the headline in `thesis`).
  const synthesis =
    intel.summary?.trim() ||
    intel.thesis?.trim() ||
    (debate ? "The desk weighed both sides below." : "No synthesis returned.");

  // Both prose sides present → render the debate columns. Otherwise fall back to
  // the cited claim cards (or degraded bullet points) so older responses still read.
  const hasDebateProse = Boolean(debate?.bull || debate?.bear);
  const hasAnyCase =
    hasDebateProse || bullClaims.length > 0 || bearClaims.length > 0 || hasDegradedPoints;

  // The desk answered (verdict / thesis / confidence) but grounded no case at all.
  const casesUnavailable = hasDeskFields && !hasAnyCase;

  return (
    <div className="rd-result">
      {/* LEAD: the judge's verdict */}
      <JudgeVerdict intel={intel} synthesis={synthesis} onRerun={onRerun} />

      {/* Two EQUAL, first-class bull/bear columns */}
      {hasAnyCase ? (
        <div className="rd-debate">
          <CaseColumn
            side="bull"
            prose={debate?.bull || undefined}
            claims={bullClaims}
            fallbackPoints={intel.bullPoints}
          />
          <CaseColumn
            side="bear"
            prose={debate?.bear || undefined}
            claims={bearClaims}
            fallbackPoints={intel.bearPoints}
          />
        </div>
      ) : null}

      {/* Key catalysts / key risks chips */}
      {debate ? <DriverChips catalysts={debate.keyCatalysts} risks={debate.keyRisks} /> : null}

      {/* No case at all - mark it unavailable rather than silently omitting. */}
      {casesUnavailable ? (
        <section className="rd-card">
          <div className="rd-flip__head">
            <IconScale size={16} />
            <span className="rd-section-eyebrow">Bull · bear</span>
            <span className="rd-chip rd-chip--muted">Unavailable</span>
          </div>
          <p className="rd-case-col__empty text-faint">
            The desk reached a verdict but couldn’t back a full case with dated, citable evidence.
            Re-run after the next filing, or check the sources below.
          </p>
        </section>
      ) : null}

      {/* What would change our mind - the honesty surface */}
      {intel.whatWouldFlipIt && intel.whatWouldFlipIt.length > 0 ? (
        <section className="rd-card rd-flip">
          <div className="rd-flip__head">
            <IconShield size={16} />
            <span className="rd-section-eyebrow">What would change our mind</span>
          </div>
          <ul className="rd-flip__list">
            {intel.whatWouldFlipIt.map((f, i) => (
              <li key={i}>
                <IconCheck size={13} />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Sources (base citations) */}
      {intel.citations.length > 0 ? (
        <section className="rd-card rd-sources">
          <span className="rd-section-eyebrow">Sources</span>
          <div className="rd-sources__list">
            {intel.citations.map((c, i) => (
              <ExternalLink key={`${c.url}-${i}`} href={c.url} className="source-link">
                <IconExternal size={13} />
                <span className="grow">{c.title}</span>
                {c.source ? <span className="text-faint" style={{ fontSize: 11 }}>{c.source}</span> : null}
              </ExternalLink>
            ))}
          </div>
        </section>
      ) : null}

      <ProvenanceBar asOfDate={intel.asOfDate} filings={intel.filingsUsed} />

      <p className="rd-disclaimer text-faint">
        Cited research — informational, not advice. The desk argues both sides for one stock and a
        judge weighs in; it never tells you to buy or sell. Verify against the filings and source
        links below before acting.{" "}
        <Link to="/core" className="linkish">
          How the desk works →
        </Link>
      </p>
    </div>
  );
}
