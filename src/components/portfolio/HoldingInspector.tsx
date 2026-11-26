import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ScoreRing } from "@/components/common/ScoreRing";
import { Sparkline } from "@/components/common/Sparkline";
import { HypeStrip } from "@/components/signal/HypeStrip";
import { SplitAdjustmentNote } from "@/components/portfolio/SplitAdjustmentNote";
import {
  IconArrowDown,
  IconArrowUp,
  IconClose,
  IconExternal,
  IconMinus,
} from "@/components/icons";
import type { HoldingRow } from "@/engine/portfolioAnalytics";
import {
  formatCurrency,
  formatMarketCap,
  formatNumber,
  formatPct,
  formatPctPlain,
  formatPrice,
  formatSignedCurrency,
} from "@/lib/format";
import type { StockSignal } from "@/types";

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="holding-inspector__stat">
      <span>{label}</span>
      <strong className={`mono${tone ? ` pl-${tone === "positive" ? "pos" : "neg"}` : ""}`}>
        {value}
      </strong>
    </div>
  );
}

export function HoldingInspector({
  row,
  signal,
  portfolioId,
  onClose,
}: {
  row: HoldingRow;
  signal?: StockSignal;
  portfolioId: string;
  onClose: () => void;
}) {
  const dayChange = signal?.dayChange ?? row.dayChange;
  const DirectionIcon =
    dayChange == null || dayChange === 0
      ? IconMinus
      : dayChange > 0
        ? IconArrowUp
        : IconArrowDown;

  // Escape closes - standard dialog behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { prev?.focus(); };
  }, []);

  const catalyst = signal?.catalyst;

  return (
    <div className="holding-inspector-layer" role="none">
      <button
        type="button"
        className="holding-inspector__backdrop"
        aria-label="Close holding details"
        onClick={onClose}
      />
      <aside
        className="holding-inspector"
        role="dialog"
        aria-modal="true"
        aria-labelledby="holding-inspector-title"
      >
        <div className="holding-inspector__top">
          <div>
            <span className="holding-inspector__eyebrow">Portfolio position</span>
            <h2 id="holding-inspector-title" className="mono">
              {row.ticker}
            </h2>
            <p>{row.name ?? signal?.name ?? "Current holding"}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn icon-btn--ghost"
            aria-label="Close holding details"
            onClick={onClose}
          >
            <IconClose size={18} />
          </button>
        </div>

        {/* Mini-dashboard: score ring + live quote side by side. */}
        <div className="holding-inspector__dash">
          {signal ? (
            <ScoreRing score={signal.score.opportunityScore} size={88} label="Opportunity" />
          ) : (
            <div className="holding-inspector__noring">
              <span className="mono">—</span>
              <span>Not researched</span>
            </div>
          )}
          <div className="holding-inspector__quote">
            <span className="holding-inspector__quote-label">Current price</span>
            <strong className="mono">{row.price != null ? formatPrice(row.price) : "Not loaded"}</strong>
            {dayChange != null && (
              <span
                className={`holding-inspector__quote-day ${
                  dayChange > 0 ? "pl-pos" : dayChange < 0 ? "pl-neg" : "text-faint"
                }`}
              >
                <DirectionIcon size={15} />
                <span className="mono">{formatPct(dayChange)}</span>
                <span className="holding-inspector__quote-day-label">today</span>
              </span>
            )}
          </div>
        </div>

        {signal?.priceHistory && signal.priceHistory.length > 1 && (
          <div className="holding-inspector__spark">
            <Sparkline data={signal.priceHistory} width={344} height={70} />
          </div>
        )}

        <div className="holding-inspector__stats">
          <Stat label="Portfolio weight" value={formatPctPlain(row.weight)} />
          <Stat
            label="Position value"
            value={row.marketValue != null ? formatCurrency(row.marketValue) : "-"}
          />
          <Stat label="Shares held" value={row.shares != null ? formatNumber(row.shares) : "-"} />
          <Stat
            label="Total P/L"
            value={row.pl != null ? formatSignedCurrency(row.pl) : "-"}
            tone={row.pl == null || row.pl === 0 ? undefined : row.pl > 0 ? "positive" : "negative"}
          />
          <Stat label="Sector" value={signal?.sector ?? row.sector ?? "Unclassified"} />
          <Stat
            label="Market cap"
            value={signal?.marketCap ? formatMarketCap(signal.marketCap) : "-"}
          />
        </div>

        {row.splitAdjustment && (
          <SplitAdjustmentNote portfolioId={portfolioId} ticker={row.ticker} adjustment={row.splitAdjustment} />
        )}

        {/* TickerScope mini-scope - hype, thesis, and live catalyst. */}
        {signal ? (
          <div className="holding-inspector__scope">
            <div className="holding-inspector__scope-head">
              <span className="holding-inspector__scope-eyebrow">Ticker Scope rundown</span>
            </div>
            <HypeStrip signal={signal} />
            <p className="holding-inspector__thesis">{signal.thesis}</p>
            {catalyst && (
              <div className="holding-inspector__catalyst">
                <span className="holding-inspector__catalyst-tag">{catalyst.type}</span>
                <span className="holding-inspector__catalyst-text">
                  {catalyst.description}
                  {catalyst.daysAway != null && (
                    <span className="text-faint">
                      {" "}
                      ·{" "}
                      {catalyst.daysAway >= 0
                        ? `${catalyst.daysAway}d away`
                        : `${Math.abs(catalyst.daysAway)}d ago`}
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="holding-inspector__notice">
            Current research isn&rsquo;t loaded for this ticker yet. Open Ticker Scope to resolve it live —
            position allocation stays available from your saved book.
          </p>
        )}

        <Link className="btn btn--primary holding-inspector__cta" to={`/beacon?t=${row.ticker}`}>
          Open {row.ticker} in Ticker Scope
          <IconExternal size={15} />
        </Link>
      </aside>
    </div>
  );
}
