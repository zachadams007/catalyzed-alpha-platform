import { useState, useEffect, useCallback, useRef } from "react";
import { Modal } from "@/components/common/Modal";
import { InteractivePriceChart } from "@/components/common/InteractivePriceChart";
import { ExternalLink } from "@/components/common/ExternalLink";
import { IconExternal } from "@/components/icons";
import { externalChartUrl, isSampleUniverseTicker } from "@/lib/links";
import { resolveChartSeries } from "@/lib/chart";
import { formatPct, formatPrice } from "@/lib/format";
import { useLiveQuote } from "@/lib/useLivePrices";
import {
  fetchYahooChartForTimeframe,
  type ChartTimeframe,
} from "@/data/prices/yahooChart";
import type { PricePoint, StockSignal } from "@/types";

interface PriceChartModalProps {
  signal: StockSignal;
  onClose: () => void;
}

const TIMEFRAMES: { label: string; value: ChartTimeframe }[] = [
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
  { label: "1M", value: "1m" },
  { label: "3M", value: "3m" },
  { label: "1Y", value: "1y" },
  { label: "Max", value: "max" },
];

/** Approx number of trailing daily points to show per timeframe when falling back to
 *  the signal's own daily series (live per-timeframe bars unavailable). Keeps each
 *  tab a visibly different window of the data. */
const TF_TRAILING_POINTS: Record<ChartTimeframe, number> = {
  "1d": 2,
  "1w": 6,
  "1m": 22,
  "3m": 66,
  "1y": 252,
  max: Number.POSITIVE_INFINITY,
};

function windowSeriesByTimeframe(series: PricePoint[], tf: ChartTimeframe): PricePoint[] {
  const n = TF_TRAILING_POINTS[tf];
  if (!Number.isFinite(n) || series.length <= n) return series;
  return series.slice(-n);
}

/** Expanded interactive chart with selectable timeframes plus TradingView link. */
export function PriceChartModal({ signal, onClose }: PriceChartModalProps) {
  const [timeframe, setTimeframe] = useState<ChartTimeframe>("1m");
  const [liveSeries, setLiveSeries] = useState<PricePoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedFor, setFetchedFor] = useState<ChartTimeframe | null>(null);
  const userPickedTf = useRef(false);

  const sampleTicker = isSampleUniverseTicker(signal.ticker);
  const tvHref = externalChartUrl(signal.ticker);
  // Live quote overlay (Alpaca IEX) - the scanned `signal.price` is from the last
  // research run and can be a DAY stale. The ELTX bug: the stock crashed −37% after
  // the scan, the hero showed the live fall, but this modal still did its math off
  // the pre-crash scan price and read "+42%" with no hint it was a multi-week window.
  const liveQuote = useLiveQuote(sampleTicker ? undefined : signal.ticker);
  const livePrice = Number.isFinite(liveQuote?.price) && (liveQuote?.price ?? 0) > 0 ? liveQuote!.price : null;
  const liveDayChange = Number.isFinite(liveQuote?.dayChange) ? liveQuote!.dayChange! : null;

  // Use the fetched LIVE per-timeframe bars when available. Approx trading-day counts per
  // timeframe.
  const fallbackSeries = resolveChartSeries(signal);
  const series = liveSeries ?? windowSeriesByTimeframe(fallbackSeries, timeframe);

  // On a BIG live move day (±10%+), the user almost certainly opened the chart to see
  // TODAY - auto-select the intraday 1D view once (never after they pick a tab).
  useEffect(() => {
    if (userPickedTf.current || liveDayChange == null) return;
    if (Math.abs(liveDayChange) >= 0.1 && timeframe !== "1d") setTimeframe("1d");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveDayChange]);

  // WINDOW change of the series ACTUALLY displayed (first → last close of the chart
  // in view) - never "series start → a price the chart doesn't even show". Labeled
  // with the window so it can't read as today's move.
  const start = series[0]?.close ?? 0;
  const end = series.length > 0 ? series[series.length - 1]!.close : signal.price;
  const periodChange = start > 0 ? (end - start) / start : 0;
  const up = periodChange >= 0;
  const tfLabel = TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? "Window";
  // The fallback series is daily closes from the last research scan - it does NOT
  // include today's live move. Say so instead of letting the chart read as current.
  const staleFallback = liveSeries == null && !loading;
  const latestPrice = livePrice ?? signal.price;

  const fetchSeries = useCallback(
    async (tf: ChartTimeframe) => {
      if (sampleTicker) return; // sample tickers have no live data
      setLoading(true);
      setLiveSeries(null); // fall back to the signal's own series while loading
      try {
        const chart = await fetchYahooChartForTimeframe(signal.ticker, tf);
        // fetchYahooChart NEVER throws - it returns null on failure AND on no-result.
        // So ONLY adopt the live series when it genuinely has bars; otherwise leave
        // liveSeries null so the resolved series stays the signal's always-present
        // fallback. (The old code set [] here, which forced the "No data" empty state
        // even when the signal had a perfectly good series - the regression this guards against.)
        setLiveSeries(chart && chart.series.length > 0 ? chart.series : null);
      } catch {
        setLiveSeries(null);
      } finally {
        setLoading(false);
        setFetchedFor(tf);
      }
    },
    [signal.ticker, sampleTicker],
  );

  // Fetch on mount and on timeframe change.
  useEffect(() => {
    void fetchSeries(timeframe);
  }, [fetchSeries, timeframe]);

  // "No data" ONLY when the resolved series - live OR the signal's own fallback - is
  // truly empty (a genuinely dataless ticker). A failed/empty live fetch shows the
  // fallback series, never a blank.
  const isEmpty = !loading && fetchedFor === timeframe && series.length === 0;

  return (
    <Modal
      className="modal--chart"
      title={`${signal.ticker} · price chart`}
      onClose={onClose}
      footer={
        <ExternalLink
          className="btn btn--primary"
          href={tvHref}
          style={{ width: "100%", justifyContent: "center" }}
        >
          <IconExternal size={16} />
          {sampleTicker ? "Search symbol on TradingView" : "Open live chart on TradingView"}
        </ExternalLink>
      }
    >
      <div className="price-chart-modal">
        {/* Timeframe segmented control */}
        <div className="price-chart-modal__timeframes" role="group" aria-label="Chart timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              type="button"
              className={`price-chart-modal__tf-btn${timeframe === tf.value ? " price-chart-modal__tf-btn--active" : ""}`}
              onClick={() => {
                userPickedTf.current = true;
                setTimeframe(tf.value);
              }}
              aria-pressed={timeframe === tf.value}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* Chart area */}
        <div className="price-chart-modal__chart">
          {loading ? (
            <div className="price-chart-modal__loading" aria-live="polite" aria-label="Loading chart data">
              <div className="price-chart-modal__loading-bar" />
            </div>
          ) : isEmpty ? (
            <div className="price-chart-modal__empty">
              <span className="text-muted" style={{ fontSize: 13 }}>
                No price data available for this range.
              </span>
            </div>
          ) : (
            <InteractivePriceChart series={series} height={248} />
          )}
        </div>

        {/* Stats row */}
        <div className="price-chart-modal__stats">
          <div>
            <div className="text-faint" style={{ fontSize: 12 }}>
              Period start
            </div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
              {formatPrice(start)}
            </div>
          </div>
          <div>
            <div className="text-faint" style={{ fontSize: 12 }}>
              {livePrice != null ? "Latest (live)" : "Latest (last scan)"}
            </div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
              {formatPrice(latestPrice)}
            </div>
          </div>
          {liveDayChange != null ? (
            <div>
              <div className="text-faint" style={{ fontSize: 12 }}>
                Today
              </div>
              <div
                className={`mono ${liveDayChange >= 0 ? "change--up" : "change--down"}`}
                style={{ fontSize: 16, fontWeight: 600 }}
              >
                {formatPct(liveDayChange)}
              </div>
            </div>
          ) : null}
          <div>
            <div className="text-faint" style={{ fontSize: 12 }}>
              {tfLabel} change
            </div>
            <div
              className={`mono ${up ? "change--up" : "change--down"}`}
              style={{ fontSize: 16, fontWeight: 600 }}
            >
              {formatPct(periodChange)}
            </div>
          </div>
        </div>

        <p className="text-faint" style={{ fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>
          Hover or drag across the chart to inspect price at each point.
          {staleFallback && !sampleTicker ? (
            <>
              {" "}
              This view shows daily closes from the last research scan — today&apos;s live move
              may not be on the chart yet (the Today figure above is live).
            </>
          ) : null}
          {sampleTicker ? (
            <>
              {" "}
              <strong>{signal.ticker}</strong> is a fictional demo ticker — TradingView opens a symbol
              search, not a live chart.
            </>
          ) : (
            <> Use TradingView for real-time prices on {signal.ticker}.</>
          )}
        </p>
      </div>
    </Modal>
  );
}
