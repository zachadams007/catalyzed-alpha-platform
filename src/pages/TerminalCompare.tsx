import { Link, useParams } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { ScoreRing } from "@/components/common/ScoreRing";
import { CapPill, RiskPill, SectorPill } from "@/components/common/Badges";
import { FeedState } from "@/components/common/FeedState";
import { Skeleton } from "@/components/common/Skeleton";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { IconChevronLeft, IconExternal, IconScale } from "@/components/icons";
import { TerminalErrorBoundary } from "@/components/terminal/TerminalErrorBoundary";
import { useSecuritySnapshot, type SecuritySnapshot } from "@/components/terminal/useSecuritySnapshot";
import {
  buildComparison,
  pctFromHigh,
  returnOver,
  tallyWins,
  type CompareMetric,
  type CompareSide,
  type Side,
} from "@/data/terminal/compareSecurities";
import { formatMarketCap, formatPct, formatPrice } from "@/lib/format";
import { scoreLabel } from "@/lib/ui";

/* ---- per-side derivation ------------------------------------------------- */

function deriveSide(snap: SecuritySnapshot): CompareSide | null {
  const { signal, quote, history } = snap;
  if (!signal) return null;
  const closes = history?.closes ?? signal.priceHistory ?? [];
  const price = quote?.price ?? signal.price;
  const mean = signal.analyst?.consensus?.mean;
  const upside = mean && price > 0 ? (mean - price) / price : null;
  return {
    ticker: signal.ticker,
    score: signal.score.opportunityScore,
    momentum: returnOver(closes, 63),
    fromHigh: pctFromHigh(price, closes),
    marketCap:
      !Number.isFinite(signal.marketCap) || signal.marketCap <= 0 ? null : signal.marketCap,
    upside,
  };
}

/* ---- column -------------------------------------------------------------- */

function ReturnChip({ k, v }: { k: string; v: number | null }) {
  return (
    <span className="tw-returns__item">
      <span className="tw-returns__k text-faint">{k}</span>
      <span className={`mono ${v == null ? "text-faint" : v >= 0 ? "text-bull" : "text-bear"}`}>
        {v == null ? "—" : formatPct(v)}
      </span>
    </span>
  );
}

function CompareColumn({ snap }: { snap: SecuritySnapshot }) {
  const { ticker, signal, quote, history, resolving } = snap;

  if (!signal) {
    return (
      <section className="tw-panel tw-cmp-col">
        <div className="tw-panel__body">
          {resolving ? (
            <div className="col gap-2" aria-busy="true">
              <LoadingNote label={ticker} hint="Resolving its live read — not stuck." />
              <Skeleton width="50%" height={26} />
              <Skeleton width="80%" height={14} style={{ marginTop: 8 }} />
              <Skeleton width="100%" height={90} radius={12} style={{ marginTop: 14 }} />
            </div>
          ) : (
            <FeedState
              variant="error"
              title={`Couldn’t load ${ticker}`}
              action={
                <Link className="btn btn--ghost btn--sm" to="/terminal">
                  Back to the wire
                </Link>
              }
            >
              No live data resolved for {ticker}. Check the symbol and try again.
            </FeedState>
          )}
        </div>
      </section>
    );
  }

  const price = quote?.price ?? signal.price;
  const dayChange = quote?.dayChange ?? signal.dayChange;
  const up = dayChange >= 0;
  const closes = history?.closes ?? signal.priceHistory ?? [];
  const hi52 = closes.length ? Math.max(...closes) : price;
  const lo52 = closes.length ? Math.min(...closes) : price;
  const span = hi52 - lo52;
  const rangePos = span > 0 ? Math.min(1, Math.max(0, (price - lo52) / span)) : 0.5;

  return (
    <section className="tw-panel tw-cmp-col">
      <div className="tw-panel__body">
        <header className="tw-cmp-col__head">
          <div className="tw-cmp-col__id">
            <Link to={`/terminal/${signal.ticker}`} className="ticker tw-cmp-col__ticker">
              {signal.ticker}
            </Link>
            <span className="tw-cmp-col__name text-muted">{signal.name}</span>
          </div>
          <ScoreRing score={signal.score.opportunityScore} size={64} stroke={7} />
        </header>

        <div className="tw-cmp-col__price-row">
          <span className={`tw-quote__price mono ${up ? "text-bull" : "text-bear"}`} style={{ fontSize: 22 }}>
            <NumberFlow
              value={price}
              prefix="$"
              format={{ minimumFractionDigits: price < 1 ? 4 : 2, maximumFractionDigits: price < 1 ? 4 : 2 }}
              aria-label={formatPrice(price)}
            />
          </span>
          <span className={`mono ${up ? "text-bull" : "text-bear"}`} style={{ fontWeight: 600 }}>
            {up ? "▲" : "▼"} {formatPct(dayChange)}
          </span>
        </div>

        <div className="tw-range" aria-label="52-week price range">
          <span className="tw-range__lo mono">{formatPrice(lo52)}</span>
          <span className="tw-range__track">
            <span className="tw-range__fill" style={{ width: `${rangePos * 100}%` }} />
            <span className="tw-range__marker" style={{ left: `${rangePos * 100}%` }} />
          </span>
          <span className="tw-range__hi mono">{formatPrice(hi52)}</span>
        </div>

        <div className="tw-returns" style={{ marginTop: "var(--sp-3)" }}>
          <ReturnChip k="1M" v={returnOver(closes, 21)} />
          <ReturnChip k="3M" v={returnOver(closes, 63)} />
          <ReturnChip k="6M" v={returnOver(closes, 126)} />
        </div>

        <div className="tw-cmp-col__badges">
          <SectorPill sector={signal.sector} />
          <CapPill bucket={signal.marketCapBucket} />
          <RiskPill level={signal.riskLevel} />
        </div>

        <div className="tw-cmp-col__foot">
          <span className="text-faint">{scoreLabel(signal.score.opportunityScore)}</span>
          <Link className="btn btn--ghost btn--sm" to={`/terminal/${signal.ticker}`}>
            <IconExternal size={13} /> Workspace
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ---- verdict ------------------------------------------------------------- */

function formatMetric(key: string, value: number | null): string {
  if (value == null) return "—";
  switch (key) {
    case "score":
      return String(Math.round(value));
    case "marketCap":
      return formatMarketCap(value);
    default:
      return formatPct(value); // momentum, fromHigh, upside
  }
}

function cellClass(side: Side, winner: Side): string {
  return `tw-verdict__val mono${winner === side ? " tw-verdict__val--win" : ""}`;
}

function Verdict({ a, b, metrics }: { a: string; b: string; metrics: CompareMetric[] }) {
  const wins = tallyWins(metrics);
  const lead =
    wins.a === wins.b
      ? `Even — ${wins.a} metric${wins.a === 1 ? "" : "s"} each`
      : wins.a > wins.b
        ? `${a} leads ${wins.a} of ${wins.a + wins.b} metrics`
        : `${b} leads ${wins.b} of ${wins.a + wins.b} metrics`;

  return (
    <section className="tw-panel tw-verdict" id="tw-verdict">
      <div className="tw-panel__head">
        <h3 className="tw-panel__title">Head to head</h3>
        <span className="tw-panel__hint">{lead}</span>
      </div>
      <div className="tw-panel__body">
        <div className="tw-verdict__row tw-verdict__row--head">
          <span className="text-faint">Metric</span>
          <span className="tw-verdict__val mono text-faint">{a}</span>
          <span className="tw-verdict__val mono text-faint">{b}</span>
        </div>
        {metrics.map((m) => (
          <div key={m.key} className="tw-verdict__row">
            <span className="text-muted">{m.label}</span>
            <span className={cellClass("a", m.winner)}>
              {m.winner === "a" ? "▲ " : ""}
              {formatMetric(m.key, m.a)}
            </span>
            <span className={cellClass("b", m.winner)}>
              {m.winner === "b" ? "▲ " : ""}
              {formatMetric(m.key, m.b)}
            </span>
          </div>
        ))}
        <p className="tw-verdict__note text-faint">
          “Leads” means ahead on that single, objective metric — not a recommendation. Discount to
          52w high rewards the more discounted name (a value lens); market cap is informational.
        </p>
      </div>
    </section>
  );
}

/* ---- page ---------------------------------------------------------------- */

function TerminalCompareInner() {
  const { a: rawA, b: rawB } = useParams<{ a: string; b: string }>();
  const aTicker = rawA?.trim().toUpperCase();
  const bTicker = rawB?.trim().toUpperCase();

  const snapA = useSecuritySnapshot(aTicker);
  const snapB = useSecuritySnapshot(bTicker);

  const sideA = deriveSide(snapA);
  const sideB = deriveSide(snapB);
  const metrics = sideA && sideB ? buildComparison(sideA, sideB) : null;

  return (
    <div className="tw-compare">
      <div className="tw-compare__bar">
        <Link to="/terminal" className="back-link">
          <IconChevronLeft size={16} /> Terminal wire
        </Link>
        <h1 className="tw-compare__title">
          <span className="ticker">{aTicker}</span>
          <IconScale size={18} className="tw-compare__vs" />
          <span className="ticker">{bTicker}</span>
        </h1>
        {aTicker && bTicker ? (
          <Link to={`/terminal/${bTicker}/vs/${aTicker}`} className="btn btn--ghost btn--sm">
            Swap sides
          </Link>
        ) : null}
      </div>

      <div className="tw-compare__cols" key={`${aTicker}:${bTicker}`}>
        <CompareColumn snap={snapA} />
        <CompareColumn snap={snapB} />
      </div>

      {metrics && sideA && sideB ? (
        <Verdict a={sideA.ticker} b={sideB.ticker} metrics={metrics} />
      ) : null}

      <InvestingDisclaimer className="page-disclaimer" />
    </div>
  );
}

export function TerminalCompare() {
  const { a: rawA, b: rawB } = useParams<{ a: string; b: string }>();
  const resetKey = `${rawA ?? ""}:${rawB ?? ""}`;

  return (
    <TerminalErrorBoundary label="Terminal compare" resetKey={resetKey}>
      <TerminalCompareInner />
    </TerminalErrorBoundary>
  );
}
