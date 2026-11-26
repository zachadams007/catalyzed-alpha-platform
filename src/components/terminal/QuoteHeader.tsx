import { Link } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { ScoreRing } from "@/components/common/ScoreRing";
import {
  CapPill,
  CatalystPill,
  ConfidencePill,
  HorizonPill,
  RiskPill,
  SectorPill,
} from "@/components/common/Badges";
import { IconBookmark, IconBookmarkFilled, IconExternal } from "@/components/icons";
import { useAppStore } from "@/store/useAppStore";
import { formatMarketCap, formatPct, formatPrice, relativeTime } from "@/lib/format";
import { scoreLabel } from "@/lib/ui";
import { isMarketDataUnavailable, isSampleProfile } from "@/lib/marketData";
import type { PortfolioQuote, StockSignal } from "@/types";
import type { YahooHistory } from "@/data/prices/yahooHistory";

interface QuoteHeaderProps {
  signal: StockSignal;
  quote: PortfolioQuote | null;
  history: YahooHistory | null;
  quoteLoading: boolean;
}

/** Dense security-overview header: live price, 52-week range, score ring, badges. */
export function QuoteHeader({ signal, quote, history, quoteLoading }: QuoteHeaderProps) {
  const isWatchlisted = useAppStore((s) => s.isWatchlisted);
  const toggleWatchlist = useAppStore((s) => s.toggleWatchlist);
  const watched = isWatchlisted(signal.ticker);

  // Integrity gate (mirrors StockDetail): a real listing with no live quote
  // ("directory") or a fictional unknown-ticker profile ("sample") must NOT
  // present a fabricated opportunity score, catalyst/risk/confidence pills, a
  // modeled market cap, or a modeled 52-week range as if they were real.
  const noData = isMarketDataUnavailable(signal);
  const sample = isSampleProfile(signal);
  const guarded = noData || sample;

  const price = quote?.price ?? signal.price;
  const dayChange = quote?.dayChange ?? signal.dayChange;
  const up = dayChange >= 0;

  // A real live quote always overrides the gate for price-derived rows; without
  // one, a guarded listing has no honest range/cap to draw.
  const hasLivePrice = quote != null;
  const closes = history?.closes ?? (guarded && !hasLivePrice ? [] : signal.priceHistory ?? []);
  const hasRange = closes.length > 0;
  const hi52 = hasRange ? Math.max(...closes) : price;
  const lo52 = hasRange ? Math.min(...closes) : price;
  const span = hi52 - lo52;
  const rangePos = span > 0 ? Math.min(1, Math.max(0, (price - lo52) / span)) : 0.5;
  // Cap is honest only with a real, positive value; a guarded listing reads " - ".
  const showCap = !guarded && signal.marketCap > 0;

  return (
    <header className="tw-quote">
      <div className="tw-quote__main">
        <div className="tw-quote__id">
          <span className="ticker tw-quote__ticker">{signal.ticker}</span>
          <span className="tw-quote__name">{signal.name}</span>
        </div>

        <div className="tw-quote__price-row">
          <span className={`tw-quote__price mono ${up ? "text-bull" : "text-bear"}`}>
            <NumberFlow
              value={price}
              prefix="$"
              format={{
                minimumFractionDigits: price < 1 ? 4 : 2,
                maximumFractionDigits: price < 1 ? 4 : 2,
              }}
              aria-label={formatPrice(price)}
            />
          </span>
          <span className={`tw-quote__chg mono ${up ? "text-bull" : "text-bear"}`}>
            {up ? "▲" : "▼"} {formatPct(dayChange)}
          </span>
          <span className="tw-quote__cap text-faint mono">
            {showCap ? formatMarketCap(signal.marketCap) : "—"}
          </span>
          {quote ? (
            <span className="tw-quote__live" title={`Live quote · ${relativeTime(quote.updatedAt)}`}>
              <span className="tw-quote__live-dot" /> live
            </span>
          ) : quoteLoading ? (
            <span className="text-faint" style={{ fontSize: 12 }}>
              syncing quote…
            </span>
          ) : (
            <span className="text-faint" style={{ fontSize: 12 }}>
              modeled price
            </span>
          )}
        </div>

        {/* 52-week range bar - only with a real series; never a modeled range. */}
        {hasRange ? (
          <div className="tw-range" aria-label="52-week price range">
            <span className="tw-range__lo mono">{formatPrice(lo52)}</span>
            <span className="tw-range__track">
              <span className="tw-range__fill" style={{ width: `${rangePos * 100}%` }} />
              <span className="tw-range__marker" style={{ left: `${rangePos * 100}%` }} />
            </span>
            <span className="tw-range__hi mono">{formatPrice(hi52)}</span>
            <span className="tw-range__label text-faint">52w</span>
          </div>
        ) : (
          <div className="tw-range tw-range--empty" aria-label="52-week price range">
            <span className="tw-range__lo mono text-faint">—</span>
            <span className="tw-range__track" aria-hidden />
            <span className="tw-range__hi mono text-faint">—</span>
            <span className="tw-range__label text-faint">52w unavailable</span>
          </div>
        )}

        {guarded ? (
          <div className="tw-quote__badges">
            <span className="pill pill--muted" title="No live market data for this listing">
              {sample ? "SAMPLE — not live" : "Live market data unavailable"}
            </span>
          </div>
        ) : (
          <div className="tw-quote__badges">
            <CatalystPill type={signal.catalystType} />
            <HorizonPill signal={signal} />
            <SectorPill sector={signal.sector} />
            {signal.marketCapBucket !== "Unknown" && <CapPill bucket={signal.marketCapBucket} />}
            <RiskPill level={signal.riskLevel} />
            <ConfidencePill
              confidence={signal.confidence}
              explanation={signal.score.confidenceExplanation}
            />
          </div>
        )}
      </div>

      <div className="tw-quote__aside">
        <ScoreRing
          score={signal.score.opportunityScore}
          size={96}
          stroke={9}
          unavailable={guarded}
        />
        <span className="tw-quote__score-label text-muted">
          {guarded ? "No live market data" : scoreLabel(signal.score.opportunityScore)}
        </span>
        <div className="tw-quote__actions">
          <button
            type="button"
            className={`btn ${watched ? "btn--primary" : "btn--ghost"}`}
            onClick={() => toggleWatchlist(signal)}
            aria-pressed={watched}
          >
            {watched ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
            {watched ? "Watching" : "Watch"}
          </button>
          <Link className="btn btn--ghost" to={`/signal/${signal.ticker}`}>
            <IconExternal size={14} />
            Full detail
          </Link>
        </div>
      </div>
    </header>
  );
}
