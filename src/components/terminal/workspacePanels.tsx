import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { fetchLiveNews, isLikelyLiveTicker } from "@/data/news/liveNews";
import { fetchCongressTrades } from "@/data/congress/congressTrades";
import { fetchForm4TradeSummary, type Form4TradeSummary } from "@/data/sec/form4";
import { fetchAnalystCoverage } from "@/data/analyst/fetchAnalystCoverage";
import { isDirectNewsUrl } from "@/lib/links";
import { TerminalPanel } from "./TerminalPanel";
import { InteractivePriceChart } from "@/components/common/InteractivePriceChart";
import { CatalystNewsPanel } from "@/components/signal/CatalystNewsPanel";
import { SecFilingsPanel } from "@/components/signal/SecFilingsPanel";
import { CongressTradesPanel } from "@/components/signal/CongressTradesPanel";
import { PriceTargetsPanel } from "@/components/signal/PriceTargetsPanel";
import { ScoreBreakdown } from "@/components/signal/ScoreBreakdown";
import { FeedState } from "@/components/common/FeedState";
import { Skeleton } from "@/components/common/Skeleton";
import { formatPct } from "@/lib/format";
import { isMarketDataUnavailable, isSampleProfile } from "@/lib/marketData";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import type { YahooHistory } from "@/data/prices/yahooHistory";
import type { AnalystCoverage, CongressTrade, NewsItem, StockSignal } from "@/types";

/**
 * Self-contained per-ticker panels shared by the security workspace
 * (/terminal/:ticker) and the linked-parameter spread (/terminal/spread). Each
 * owns its own fetch + four states and wraps the app's existing per-ticker
 * components exactly as StockDetail wires them, so a panel renders identically
 * wherever it appears.
 */

export function ChartPanel({ signal, history }: { signal: StockSignal; history: YahooHistory | null }) {
  const series = history?.series ?? signal.priceSeries;
  const closes = history?.closes ?? signal.priceHistory ?? [];
  const ret = (lookback: number) =>
    closes.length > lookback
      ? (closes[closes.length - 1]! - closes[closes.length - 1 - lookback]!) /
        closes[closes.length - 1 - lookback]!
      : null;
  const r1m = ret(21);
  const r3m = ret(63);
  const r6m = ret(126);

  return (
    <TerminalPanel
      id="tw-chart"
      title="Price · 1Y"
      hint={history ? "Yahoo daily closes" : "modeled history"}
      span="wide"
      headerRight={
        <span className="tw-returns">
          {[
            { k: "1M", v: r1m },
            { k: "3M", v: r3m },
            { k: "6M", v: r6m },
          ].map(({ k, v }) => (
            <span key={k} className="tw-returns__item">
              <span className="tw-returns__k text-faint">{k}</span>
              <span className={`mono ${v == null ? "text-faint" : v >= 0 ? "text-bull" : "text-bear"}`}>
                {v == null ? "—" : formatPct(v)}
              </span>
            </span>
          ))}
        </span>
      }
    >
      <InteractivePriceChart
        series={series}
        width={680}
        height={260}
        ariaLabel={`${signal.ticker} one-year price history`}
        emptyLabel="Not enough price history to chart this symbol."
      />
    </TerminalPanel>
  );
}

type NewsStatus = "loading" | "live" | "sample";

/**
 * Decide which headlines to show once the live fetch resolves with ZERO live
 * items, given the cached/seeded `sampleItems` and whether Sample data mode is
 * ON. PRIME DIRECTIVE: with sample mode OFF, the modeled `signal.news.items`
 * (fabricated headlines, no real article URL) must NEVER render - return an
 * empty set so the panel shows its honest "No headlines available" state. Only
 * fall back to the sample set when sample mode is explicitly ON.
 */
export function resolveLiveNewsOutcome(
  liveItems: NewsItem[],
  sampleItems: NewsItem[],
  sampleModeOn: boolean,
): { items: NewsItem[]; status: NewsStatus } {
  if (liveItems.length > 0) return { items: liveItems, status: "live" };
  if (sampleModeOn) return { items: sampleItems, status: "sample" };
  return { items: [], status: "live" };
}

export function NewsPanelCard({ signal }: { signal: StockSignal }) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [status, setStatus] = useState<NewsStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const cached = signal.news.items.filter((n) => isDirectNewsUrl(n.url));
    if (cached.length > 0) {
      setItems(cached);
      setStatus("live");
      return () => {
        cancelled = true;
      };
    }
    void fetchLiveNews(signal.ticker).then((live) => {
      if (cancelled) return;
      const outcome = resolveLiveNewsOutcome(live, signal.news.items, isSampleDataModeEnabled());
      setItems(outcome.items);
      setStatus(outcome.status);
    });
    return () => {
      cancelled = true;
    };
  }, [signal.ticker, signal.news.items]);

  return (
    <TerminalPanel id="tw-news">
      <CatalystNewsPanel signal={signal} items={items} liveStatus={status} />
    </TerminalPanel>
  );
}

export function FilingsPanelCard({ signal }: { signal: StockSignal }) {
  const activity = signal.secActivity;
  const [summary, setSummary] = useState<Form4TradeSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSummary(null);
    if (!activity || activity.form4Count90d === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchForm4TradeSummary(activity)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activity]);

  if (!activity) {
    return (
      <TerminalPanel id="tw-filings" title="SEC filings" hint="EDGAR">
        <FeedState title="No recent SEC activity">
          No Form 4 or 8-K filings on EDGAR for {signal.ticker} in the trailing 90 days.
        </FeedState>
      </TerminalPanel>
    );
  }

  return (
    <TerminalPanel id="tw-filings">
      <SecFilingsPanel activity={activity} form4Summary={summary} form4Loading={loading} />
    </TerminalPanel>
  );
}

export function CongressPanelCard({ signal }: { signal: StockSignal }) {
  const [trades, setTrades] = useState<CongressTrade[]>(signal.congressTrades ?? []);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTrades(signal.congressTrades ?? []);
    if (!isLikelyLiveTicker(signal.ticker)) return;
    setLoading(true);
    void fetchCongressTrades(signal.ticker)
      .then((live) => {
        if (!cancelled && live.length > 0) setTrades(live);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [signal.ticker, signal.congressTrades]);

  if (trades.length === 0) {
    return (
      <TerminalPanel id="tw-congress" title="Congress trades" hint="House & Senate">
        {loading ? (
          <div className="col gap-2" aria-busy="true">
            <Skeleton height={14} width="90%" />
            <Skeleton height={14} width="75%" />
          </div>
        ) : (
          <FeedState title="No disclosed trades">
            No congressional disclosures on file for {signal.ticker}.
          </FeedState>
        )}
      </TerminalPanel>
    );
  }

  return (
    <TerminalPanel id="tw-congress">
      <CongressTradesPanel trades={trades} limit={8} />
    </TerminalPanel>
  );
}

export function AnalystPanelCard({ signal }: { signal: StockSignal }) {
  const setAnalystCache = useAppStore((s) => s.setAnalystCache);
  const [coverage, setCoverage] = useState<AnalystCoverage | null>(signal.analyst ?? null);
  const [loading, setLoading] = useState(!signal.analyst);

  useEffect(() => {
    let cancelled = false;
    if (signal.analyst) {
      setCoverage(signal.analyst);
      setAnalystCache(signal.ticker, signal.analyst);
    }
    setLoading(!signal.analyst);
    void fetchAnalystCoverage(signal.ticker, signal.price).then((c) => {
      if (cancelled) return;
      setCoverage(c);
      setAnalystCache(signal.ticker, c);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [signal.ticker, signal.price, signal.analyst, setAnalystCache]);

  return (
    <TerminalPanel id="tw-analyst">
      <PriceTargetsPanel ticker={signal.ticker} coverage={coverage} loading={loading} spot={signal.price} />
    </TerminalPanel>
  );
}

export function ScorePanelCard({ signal }: { signal: StockSignal }) {
  // A real listing with no live data ("directory") or a fictional sample profile
  // has no honest opportunity score - never render "Why it scored N" or the
  // fabricated breakdown. Mirror StockDetail's "Why there's no score yet" copy.
  const noData = isMarketDataUnavailable(signal);
  const sample = isSampleProfile(signal);
  if (noData || sample) {
    return (
      <TerminalPanel id="tw-score" title="Why there’s no score yet" span="wide">
        <FeedState title="Opportunity score unavailable">
          {sample
            ? `${signal.name} is a sample profile, not a live listing — we don’t compute an opportunity score from illustrative data.`
            : `${signal.name} is a real listing, but our live data provider couldn’t return a quote or fundamentals for it. We don’t score a name we can’t source data for.`}
        </FeedState>
      </TerminalPanel>
    );
  }

  return (
    <TerminalPanel id="tw-score" title={`Why it scored ${signal.score.opportunityScore}`} span="wide">
      <ScoreBreakdown breakdown={signal.score} />
    </TerminalPanel>
  );
}
