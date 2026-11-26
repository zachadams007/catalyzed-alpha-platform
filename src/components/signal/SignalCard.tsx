import { Link } from "react-router-dom";
import type { StockSignal } from "@/types";
import { formatPrice, formatPct, formatMarketCap } from "@/lib/format";
import { useLiveQuote } from "@/lib/useLivePrices";
import { SparklineButton } from "@/components/signal/SparklineButton";
import { NewsPanel } from "@/components/signal/NewsPanel";
import { HypeStrip, hypeTierKey } from "@/components/signal/HypeStrip";
import { CardChartBackdrop } from "@/components/signal/CardChartBackdrop";
import { AnalystTargetsStrip } from "@/components/signal/AnalystTargetsStrip";
import { Snowflake } from "@/components/signal/Snowflake";
import { ListingBadge } from "@/components/signal/ListingBadge";
import { WhyTags } from "@/components/signal/WhyTags";
import { NegativeBadges } from "@/components/signal/NegativeBadges";
import { CongressBadge } from "@/components/signal/CongressBadge";
import { RisksRewards, ValuationChip } from "@/components/signal/RisksRewards";
import { useOwnedTickers } from "@/feed/useOwnedTickers";
import { ScoreRing } from "@/components/common/ScoreRing";
import { ScoreAnalystBadge } from "@/components/signal/ScoreAnalystBadge";
import { isStrongUpside, upsideVsSpot } from "@/lib/analystStats";
import {
  CapPill,
  CatalystPill,
  ConfidencePill,
  HorizonPill,
  RiskPill,
  SectorPill,
} from "@/components/common/Badges";
import { ActionBar } from "@/components/signal/ActionBar";
import { IconMega, IconPulse } from "@/components/icons";
import { useCardMotion } from "@/lib/useCardMotion";
import { isMarketDataUnavailable, isSampleProfile } from "@/lib/marketData";

interface SignalCardProps {
  signal: StockSignal;
  index?: number;
  /** Optional personalization context for the For You feed. */
  match?: { matchScore: number; reasons: string[] };
  /** Expose the per-card Tune + Time-scale controls. Only the For You feed opts
   *  in - the curated Today / Weekly / Friends tiles stay clean (D2). */
  enableTuning?: boolean;
}

export function SignalCard({ signal, index = 0, match, enableTuning = false }: SignalCardProps) {
  // Live-price overlay: only the displayed price/day-change ticks live; the
  // opportunity score below stays on the shared daily research.
  const live = useLiveQuote(signal.ticker);
  // A real listing with no live data behind it: suppress every market-derived
  // surface (score, sector, catalyst, P/E, valuation, archetypes, hype) so the
  // card is honest-incomplete, never confidently wrong.
  const noData = isMarketDataUnavailable(signal);
  const sample = isSampleProfile(signal);
  const price = live?.price ?? signal.price;
  const hasQuotePrice = Number.isFinite(price) && price > 0;
  const dayChange = live?.dayChange ?? signal.dayChange;
  const up = dayChange >= 0;
  const detailPath = `/signal/${signal.ticker}`;
  const ptHighlight = !noData && isStrongUpside(signal.price, signal.analyst);
  const { ref } = useCardMotion<HTMLElement>();
  // Honest downside applies to names the user actually follows - held or
  // watchlisted. The opportunity feed leads positive; for YOUR names we also
  // surface the real red flags inline.
  const owned = useOwnedTickers();
  const isOwned = owned.has(signal.ticker.toUpperCase());

  return (
    <article
      ref={ref}
      data-heat={noData ? undefined : hypeTierKey(signal.hype.tier)}
      className={`signal-card signal-card--feed${ptHighlight ? " signal-card--pt-highlight" : ""}`}
      style={
        {
          "--dock-delay": `${Math.min(index * 0.04, 0.4)}s`,
          animationDelay: "var(--dock-delay)",
        } as React.CSSProperties
      }
    >
      <div className="signal-card__hero">
        <CardChartBackdrop data={signal.priceHistory} up={up} />
        <div className="signal-card__top">
          <div className="grow signal-id">
            <div className="signal-id__row">
              <span className="card-rank mono" aria-hidden>
                {String(index + 1).padStart(2, "0")}
              </span>
              <Link to={detailPath} className="ticker">
                {signal.ticker}
              </Link>
              {!noData && <SparklineButton signal={signal} />}
            </div>
            <div className="company">{signal.name}</div>
            <div className="price-row">
              <span className="price mono">{formatPrice(price, signal.currency)}</span>
              <span className={`change ${up ? "change--up" : "change--down"}`}>
                {formatPct(dayChange)}
              </span>
              <ListingBadge exchange={signal.listingExchange} currency={signal.currency} />
              {match && <span className="match-badge" style={{ marginLeft: "auto" }}>{match.matchScore}% match</span>}
            </div>
            {!hasQuotePrice && <div className="company">Live market data unavailable.</div>}
          </div>
          <Link to={detailPath} className="score-stack" aria-label={`${signal.ticker} details`}>
            <ScoreRing score={signal.score.opportunityScore} unavailable={noData} />
            {!noData && <ScoreAnalystBadge signal={signal} compact />}
          </Link>
        </div>
      </div>

      {ptHighlight && (
        <p className="pt-highlight-banner">
          Strong street upside — consensus target {formatPct(upsideVsSpot(signal.price, signal.analyst!.consensus!.mean!))}{" "}
          above spot
        </p>
      )}

      {sample && (
        <p className="lookup-banner lookup-banner--sample">
          <strong>SAMPLE — not live.</strong> Illustrative figures for an unknown ticker, not real
          market data.
        </p>
      )}

      {/* Top glance row: cap + valuation VERDICT only. P/E lives once, in the
          key-fundamentals grid below - showing it here too just duplicated the
          number on every card (refinement: declutter, no info lost). */}
      <div className="report-stats">
        <div className="report-stat">
          <span className="report-stat__label">Market cap</span>
          <span className="report-stat__value mono">
            {signal.marketCap > 0 ? formatMarketCap(signal.marketCap) : "—"}
          </span>
        </div>
        {!noData && <ValuationChip signal={signal} />}
      </div>

      {noData ? (
        <div className="signal-card__badges">
          <span className="pill pill--muted" title="No live market data for this listing yet">
            Live market data unavailable
          </span>
        </div>
      ) : (
        <div className="signal-card__badges">
          {/* Lead with the differentiated SIGNALS (catalyst type + congress buying),
              then the context tags (sector / cap / horizon / volatility / confidence)
               - the order a reader scans for "why this one". */}
          <CatalystPill type={signal.catalystType} />
          <CongressBadge signal={signal} />
          <SectorPill sector={signal.sector} />
          <CapPill bucket={signal.marketCapBucket} />
          <HorizonPill signal={signal} />
          <RiskPill level={signal.riskLevel} />
          <ConfidencePill confidence={signal.confidence} explanation={signal.score.confidenceExplanation} />
        </div>
      )}

      {!noData && <WhyTags signal={signal} />}

      {!noData && isOwned && <NegativeBadges signal={signal} />}

      {!noData && <HypeStrip signal={signal} />}

      {match && (
        <div className="reasons">
          {match.reasons.map((r) => (
            <span className="reason" key={r}>
              {r}
            </span>
          ))}
        </div>
      )}

      <p className="thesis">{signal.thesis}</p>

      {!noData && (
        <div className="report-row">
          <div className="report-row__viz">
            <span className="report-row__label">Signal shape</span>
            <Snowflake signal={signal} variant="card" />
          </div>
          <RisksRewards signal={signal} variant="card" />
        </div>
      )}

      <div className="kfs">
        {signal.keyFundamentals.map((kf) => (
          <div className="kf" key={kf.label}>
            <div className="kf__label">{kf.label}</div>
            <div
              className={`kf__value ${kf.tone ? `kf__value--${kf.tone}` : ""}`}
              title={kf.hint}
            >
              {kf.value}
            </div>
          </div>
        ))}
      </div>

      {!noData && <AnalystTargetsStrip signal={signal} />}

      <NewsPanel signal={signal} limit={2} variant="feed" showCatalyst />

      <div className="insights insights--compact">
        <div className="insight">
          <IconPulse className="insight__icon" />
          <div>
            <div className="insight__label">Momentum / Volume</div>
            <div className="insight__text">{signal.momentumNote}</div>
          </div>
        </div>
        <div className="insight">
          <IconMega className="insight__icon" />
          <div>
            <div className="insight__label">Social / Political</div>
            <div className="insight__text">{signal.socialSummary}</div>
          </div>
        </div>
      </div>

      <ActionBar signal={signal} enableTuning={enableTuning} />
    </article>
  );
}
