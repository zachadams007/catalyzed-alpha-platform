import { useState, useRef, useCallback, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { Link } from "react-router-dom";
import { ScoreRing } from "@/components/common/ScoreRing";
import { Sparkline } from "@/components/common/Sparkline";
import { PriceChartModal } from "@/components/signal/PriceChartModal";
import { InteractivePriceChart } from "@/components/common/InteractivePriceChart";
import { Popover } from "@/components/common/Popover";
import { HypeStrip, hypeTierKey } from "@/components/signal/HypeStrip";
import {
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconChevronDown,
  IconClose,
  IconExternal,
  IconMinus,
} from "@/components/icons";
import { formatMarketCap, formatPct, formatPrice } from "@/lib/format";
import { resolveChartSeries } from "@/lib/chart";
import { useLiveQuote } from "@/lib/useLivePrices";
import { hasNoLiveMarketData, isSampleProfile } from "@/lib/marketData";
import { scoreColors } from "@/lib/ui";
import type { StockSignal, WatchlistAlert } from "@/types";

type DayStyle = CSSProperties & { "--day-mag": string };
type ScoreStyle = CSSProperties & { "--score-color": string };
type RowStyle = CSSProperties & { "--reveal-index": number };

const DAY_CHANGE_REFERENCE_MAG = 0.05;

const SPARK_W = 96;
const SPARK_H = 30;

/**
 * Watchlist-row sparkline with inline drag-scrub and click-to-modal.
 * Dragging across the sparkline shows the price at that data point inline.
 * Clicking (without dragging) opens PriceChartModal.
 * Touch-friendly: touchmove scrubs, touchend resets.
 */
function WatchlistSparkline({ signal }: { signal: StockSignal }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [scrubPrice, setScrubPrice] = useState<number | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const isDragging = useRef(false);

  const series = resolveChartSeries(signal);
  const prices = series.length >= 2 ? series.map((p) => p.close) : signal.priceHistory;

  const pickPrice = useCallback(
    (clientX: number): number | null => {
      const el = btnRef.current;
      if (!el || prices.length < 2) return null;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const idx = Math.round(ratio * (prices.length - 1));
      return prices[idx] ?? null;
    },
    [prices],
  );

  const onMouseMove = (e: ReactMouseEvent<HTMLButtonElement>) => {
    isDragging.current = true;
    setScrubPrice(pickPrice(e.clientX));
  };

  const onMouseLeave = () => {
    isDragging.current = false;
    setScrubPrice(null);
  };

  const onClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging.current) {
      setModalOpen(true);
    }
    isDragging.current = false;
  };

  const onTouchMove = (e: ReactTouchEvent<HTMLButtonElement>) => {
    const t = e.touches[0];
    if (t) {
      isDragging.current = true;
      setScrubPrice(pickPrice(t.clientX));
    }
  };

  const onTouchEnd = () => {
    if (!isDragging.current) {
      setModalOpen(true);
    }
    isDragging.current = false;
    setScrubPrice(null);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="wl-spark-btn"
        aria-label={`${signal.ticker} price chart — drag to scrub, tap to expand`}
        title={scrubPrice != null ? formatPrice(scrubPrice) : "Drag to scrub price · tap to expand"}
        onClick={onClick}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <Sparkline data={prices} width={SPARK_W} height={SPARK_H} />
        {scrubPrice != null && (
          <span className="wl-spark-btn__scrub mono" aria-live="polite" aria-atomic="true">
            {formatPrice(scrubPrice)}
          </span>
        )}
      </button>
      {modalOpen && <PriceChartModal signal={signal} onClose={() => setModalOpen(false)} />}
    </>
  );
}

function alertTriggered(alert: WatchlistAlert | undefined, price: number | undefined): boolean {
  if (!alert || price == null) return false;
  return alert.direction === "above" ? price >= alert.price : price <= alert.price;
}

function DayMover({ day }: { day: number }) {
  const mag = Math.min(1, Math.abs(day) / DAY_CHANGE_REFERENCE_MAG);
  const style: DayStyle = { "--day-mag": `${mag * 100}%` };
  const dir = day > 0 ? "up" : day < 0 ? "down" : "flat";
  const Icon = day > 0 ? IconArrowUp : day < 0 ? IconArrowDown : IconMinus;
  const tone = day > 0 ? "pl-pos" : day < 0 ? "pl-neg" : "text-faint";
  return (
    <span className={`day-cell day-cell--${dir} wl-row__day`} style={style}>
      <span className={`day-cell__val mono ${tone}`}>
        <Icon size={13} />
        {formatPct(day)}
      </span>
      <span className="day-cell__bar" aria-hidden="true">
        <span className="day-cell__fill" />
      </span>
    </span>
  );
}

function AlertControl({
  ticker,
  price,
  alert,
  onSet,
  onClear,
}: {
  ticker: string;
  price?: number;
  alert?: WatchlistAlert;
  onSet: (price: number, direction: "above" | "below") => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(alert ? String(alert.price) : price ? price.toFixed(2) : "");
  const [direction, setDirection] = useState<"above" | "below">(alert?.direction ?? "above");
  // Popover (portaled to #overlay-root) owns outside-click + Escape-to-close
  // itself via anchorRef, so no bespoke listener is needed here.
  const anchorRef = useRef<HTMLButtonElement>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = Number(level);
    if (!Number.isFinite(value) || value <= 0) return;
    onSet(value, direction);
    setOpen(false);
  };

  return (
    <div className="wl-alert">
      <button
        ref={anchorRef}
        type="button"
        className={`icon-btn icon-btn--ghost wl-alert__toggle${alert ? " is-set" : ""}`}
        aria-label={alert ? `Edit research alert for ${ticker}` : `Set research alert for ${ticker}`}
        aria-expanded={open}
        title={alert ? `Alert: ${direction} $${alert.price}` : "Set a price-level research reminder"}
        onClick={() => setOpen((v) => !v)}
      >
        <IconBell size={15} />
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom"
        align="end"
        ariaLabel={`${alert ? "Edit" : "Set"} research alert for ${ticker}`}
      >
        <form className="wl-alert__pop" onSubmit={submit}>
          <span className="wl-alert__title">Research reminder</span>
          <div className="wl-alert__dir" role="group" aria-label="Alert direction">
            <button
              type="button"
              className={direction === "above" ? "is-active" : ""}
              aria-pressed={direction === "above"}
              onClick={() => setDirection("above")}
            >
              Above
            </button>
            <button
              type="button"
              className={direction === "below" ? "is-active" : ""}
              aria-pressed={direction === "below"}
              onClick={() => setDirection("below")}
            >
              Below
            </button>
          </div>
          <label className="wl-alert__field">
            <span className="sr-only">Price level for {ticker}</span>
            <span aria-hidden>$</span>
            <input
              className="cell-input"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              placeholder="Price"
              autoFocus
            />
          </label>
          <div className="wl-alert__actions">
            <button type="submit" className="btn btn--primary btn--sm">
              Save
            </button>
            {alert && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                Clear
              </button>
            )}
          </div>
          <p className="wl-alert__note">A personal price prompt — not an order or alert push.</p>
        </form>
      </Popover>
    </div>
  );
}

export function WatchlistRow({
  signal,
  alert,
  expanded,
  index,
  onToggle,
  onRemove,
  onSetAlert,
  onClearAlert,
}: {
  signal: StockSignal;
  alert?: WatchlistAlert;
  expanded: boolean;
  index: number;
  onToggle: () => void;
  onRemove: () => void;
  onSetAlert: (price: number, direction: "above" | "below") => void;
  onClearAlert: () => void;
}) {
  // A listing we have NO live data for - directory-confirmed (uncovered) OR a
  // keyless sample profile - must never surface a modeled opportunity score,
  // confidence, hype tier, or sector. Sample profiles get an explicit
  // "SAMPLE - not live" treatment; directory names a muted "unavailable" pill.
  const sample = isSampleProfile(signal);
  const noData = hasNoLiveMarketData(signal);
  const score = signal.score.opportunityScore;
  const { solid } = scoreColors(score);
  const scoreStyle: ScoreStyle = { "--score-color": solid };
  const rowStyle: RowStyle = { "--reveal-index": index };
  // Live overlay (price + day change) - the score/sparkline stay on daily research.
  const live = useLiveQuote(signal.ticker);
  const price = live?.price ?? signal.price;
  const day = live?.dayChange ?? signal.dayChange ?? 0;
  const triggered = alertTriggered(alert, price);
  const regionId = `wl-scope-${signal.ticker}`;

  return (
    <li className={`wl-row${expanded ? " is-open" : ""}`} style={rowStyle}>
      <div className="wl-row__bar">
        <button
          type="button"
          className="wl-row__main"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={onToggle}
        >
          <span className="wl-row__chev" aria-hidden>
            <IconChevronDown size={16} />
          </span>
          <span
            className={`wl-row__score mono${noData ? " wl-row__score--na" : ""}`}
            style={noData ? undefined : scoreStyle}
            title={noData ? "No live market data — opportunity score unavailable" : undefined}
          >
            {noData ? "—" : score}
          </span>
          <span className="wl-row__id">
            <span className="wl-row__ticker mono">{signal.ticker}</span>
            <span className="wl-row__name">{signal.name}</span>
          </span>
          {noData ? (
            <span
              className={`pill pill--muted wl-row__nodata${sample ? " wl-row__nodata--sample" : ""}`}
            >
              {sample ? "SAMPLE — not live" : "Live market data unavailable"}
            </span>
          ) : (
            <span className={`wl-row__hype wl-row__hype--${hypeTierKey(signal.hype.tier)}`}>
              {signal.hype.tier}
            </span>
          )}
          <span className="wl-row__spark">
            <WatchlistSparkline signal={signal} />
          </span>
          <span className="wl-row__price mono">{formatPrice(price)}</span>
          <DayMover day={day} />
        </button>
        <div className="wl-row__actions">
          {triggered && (
            <span
              className="wl-row__alert-hit"
              title={`Price ${alert?.direction} $${alert?.price}`}
              aria-label={`${signal.ticker} price alert level reached`}
            >
              <IconBell size={12} /> level reached
            </span>
          )}
          <AlertControl
            ticker={signal.ticker}
            price={price}
            alert={alert}
            onSet={onSetAlert}
            onClear={onClearAlert}
          />
          <button
            type="button"
            className="icon-btn icon-btn--ghost wl-row__remove"
            aria-label={`Remove ${signal.ticker} from watchlist`}
            title={`Remove ${signal.ticker}`}
            onClick={onRemove}
          >
            <IconClose size={15} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="wl-scope" id={regionId} role="region" aria-label={`${signal.ticker} mini-scope`}>
          <div className="wl-scope__top">
            <ScoreRing score={score} size={76} label="Opportunity" showLabel={false} unavailable={noData} />
            {noData ? (
              <p className="wl-scope__nodata text-faint">
                {sample
                  ? "Illustrative sample figures — not live market data."
                  : "No live market data for this listing yet. Score, hype, sector, and confidence stay hidden until a real quote lands."}
              </p>
            ) : (
              <div className="wl-scope__hype">
                <HypeStrip signal={signal} />
              </div>
            )}
          </div>

          {!noData && (
            <div className="wl-scope__chart">
              <InteractivePriceChart
                series={resolveChartSeries(signal)}
                height={200}
                ariaLabel={`${signal.ticker} price history`}
                hint="Hover to read price · full history in Ticker Scope"
              />
            </div>
          )}

          <p className="wl-scope__thesis">{signal.thesis}</p>

          <div className="wl-scope__stats">
            <div className="wl-scope__stat">
              <span>Price</span>
              <strong className="mono">{formatPrice(price)}</strong>
            </div>
            <div className="wl-scope__stat">
              <span>Today</span>
              <strong className={`mono ${day > 0 ? "pl-pos" : day < 0 ? "pl-neg" : ""}`}>
                {formatPct(day)}
              </strong>
            </div>
            <div className="wl-scope__stat">
              <span>Market cap</span>
              <strong className="mono">
                {signal.marketCap > 0 ? formatMarketCap(signal.marketCap) : "—"}
              </strong>
            </div>
            {!noData && (
              <div className="wl-scope__stat">
                <span>Sector</span>
                <strong>{signal.sector}</strong>
              </div>
            )}
            <div className="wl-scope__stat">
              <span>Confidence</span>
              <strong className="mono">{noData ? "N/A" : `${signal.confidence}/100`}</strong>
            </div>
          </div>

          {!noData && signal.catalyst && (
            <div className="wl-scope__catalyst">
              <span className="wl-scope__catalyst-tag">{signal.catalyst.type}</span>
              <span>
                {signal.catalyst.description}
                {signal.catalyst.daysAway != null && (
                  <span className="text-faint">
                    {" "}
                    ·{" "}
                    {signal.catalyst.daysAway >= 0
                      ? `${signal.catalyst.daysAway}d away`
                      : `${Math.abs(signal.catalyst.daysAway)}d ago`}
                  </span>
                )}
              </span>
            </div>
          )}

          <div className="wl-scope__cta">
            <Link className="btn btn--primary btn--sm" to={`/beacon?t=${signal.ticker}`}>
              Open in Ticker Scope
              <IconExternal size={14} />
            </Link>
            <Link className="btn btn--ghost btn--sm" to={`/signal/${signal.ticker}`}>
              Full detail
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}
