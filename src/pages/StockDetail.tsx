import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { resolveSymbolFromQuery } from "@/data/finnhub/symbolSearch";
import { getSymbol } from "@/data/symbols/symbolDirectory";
import { useAppStore } from "@/store/useAppStore";
import { useLiveQuote } from "@/lib/useLivePrices";
import { LivePriceControl } from "@/components/common/LivePriceControl";
import { StockDetailSkeleton } from "@/components/common/StockDetailSkeleton";
import { ExternalLink } from "@/components/common/ExternalLink";
import { ScoreRing } from "@/components/common/ScoreRing";
import { ScoreAnalystBadge } from "@/components/signal/ScoreAnalystBadge";
import { SparklineButton } from "@/components/signal/SparklineButton";
import { InfoTip } from "@/components/common/Tooltip";
import { externalXSearchUrl, isDirectNewsUrl, sourceItemHref } from "@/lib/links";
import { CatalystNewsPanel } from "@/components/signal/CatalystNewsPanel";
import { HypeStrip } from "@/components/signal/HypeStrip";
import { CongressTradesPanel } from "@/components/signal/CongressTradesPanel";
import { ExecutiveSignalCallout } from "@/components/signal/ExecutiveSignalCallout";
import { executiveSignalsForTicker } from "@/data/terminal/executiveTrades";
import { SecFilingsPanel } from "@/components/signal/SecFilingsPanel";
import { Snowflake } from "@/components/signal/Snowflake";
import { ListingBadge, CrossListings } from "@/components/signal/ListingBadge";
import { WhyTags } from "@/components/signal/WhyTags";
import { RisksRewards, ValuationChip } from "@/components/signal/RisksRewards";
import { fetchLiveNews, isLikelyLiveTicker } from "@/data/news/liveNews";
import { fetchCongressTrades } from "@/data/congress/congressTrades";
import { fetchForm4TradeSummary, type Form4TradeSummary } from "@/data/sec/form4";
import { fetchAnalystCoverage } from "@/data/analyst/fetchAnalystCoverage";
import { PriceTargetsPanel } from "@/components/signal/PriceTargetsPanel";
import { AiBriefPanel } from "@/components/terminal/AiBriefPanel";
import { ScoreBreakdown } from "@/components/signal/ScoreBreakdown";
import { ActionBar } from "@/components/signal/ActionBar";
import {
  CapPill,
  CatalystPill,
  ConfidencePill,
  HorizonPill,
  RiskPill,
  SectorPill,
} from "@/components/common/Badges";
import { IconChevronLeft, IconExternal } from "@/components/icons";
import {
  formatMarketCap,
  formatPct,
  formatPctPlain,
  formatPrice,
  formatVolume,
  hostnameOf,
  relativeTime,
} from "@/lib/format";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { scoreLabel } from "@/lib/ui";
import { isMarketDataUnavailable, isSampleProfile } from "@/lib/marketData";
import { getSampleDataModeState } from "@/data/providers/sampleDataMode";
import type { AnalystCoverage, CongressTrade, NewsItem, RawFundamentals } from "@/types";

// Command-bar `?panel=` deep-links (CommandBar.tsx TICKER_ACTIONS) land here -
// map each panel key to the id of the closest equivalent section on the
// consolidated stock page. Keys with no real target are dropped from
// TICKER_ACTIONS entirely rather than pointing at nothing.
const PANEL_TARGETS: Record<string, string> = {
  chart: "sd-panel-chart",
  news: "sd-panel-news",
  filings: "sd-panel-filings",
  congress: "sd-panel-congress",
  analyst: "sd-panel-analyst",
  ai: "sd-panel-ai",
  score: "sd-panel-score",
  social: "sd-panel-social",
};

export function StockDetail() {
  const navigate = useNavigate();
  const { ticker: param } = useParams<{ ticker: string }>();
  const ticker = param?.trim().toUpperCase();
  const [searchParams] = useSearchParams();
  const panelTarget = searchParams.get("panel");
  const [flashId, setFlashId] = useState<string | null>(null);
  const resolveSignal = useAppStore((s) => s.resolveSignal);
  const lookupTicker = useAppStore((s) => s.lookupTicker);
  const setAnalystCache = useAppStore((s) => s.setAnalystCache);
  const liveQuote = useLiveQuote(ticker);
  const signal = ticker ? resolveSignal(ticker) : undefined;
  const directoryRecord = ticker ? getSymbol(ticker) : null;
  const [loading, setLoading] = useState(false);
  const [resolveError, setResolveError] = useState(false);
  const [liveNews, setLiveNews] = useState<NewsItem[]>([]);
  const [newsStatus, setNewsStatus] = useState<"loading" | "live" | "sample">("loading");
  const [analystCoverage, setAnalystCoverage] = useState<AnalystCoverage | null>(null);
  const [analystLoading, setAnalystLoading] = useState(true);
  const [congressTrades, setCongressTrades] = useState<CongressTrade[]>([]);
  const [form4Summary, setForm4Summary] = useState<Form4TradeSummary | null>(null);
  const [form4Loading, setForm4Loading] = useState(false);

  useEffect(() => {
    if (!ticker || signal) return;
    let cancelled = false;
    setResolveError(false);
    setLoading(true);
    void (async () => {
      try {
        // Canonicalise through the live resolver when a key is present; fall
        // back to the ticker itself (offline / direct symbol) instead of
        // throwing, so a real listing still loads its modeled profile.
        const resolved = await resolveSymbolFromQuery(ticker).catch(() => ticker);
        if (cancelled) return;
        if (resolved !== ticker) {
          navigate(`/signal/${resolved}`, { replace: true });
          return;
        }
        await lookupTicker(resolved);
      } catch {
        // No live quote and no synthetic profile - render a graceful fallback
        // rather than hanging on the skeleton forever.
        if (!cancelled) setResolveError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticker, signal, navigate, lookupTicker]);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setNewsStatus("loading");
    setLiveNews([]);

    const cached = signal?.news.items.filter((n) => isDirectNewsUrl(n.url)) ?? [];
    if (cached.length > 0) {
      setLiveNews(cached);
      setNewsStatus("live");
      return () => {
        cancelled = true;
      };
    }

    void fetchLiveNews(ticker).then((items) => {
      if (cancelled) return;
      if (items.length > 0) {
        setLiveNews(items);
        setNewsStatus("live");
      } else {
        setLiveNews(signal?.news.items ?? []);
        setNewsStatus("sample");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [ticker, signal?.news.items]);

  useEffect(() => {
    if (!ticker || !signal) return;
    if (signal.analyst) {
      setAnalystCoverage(signal.analyst);
      setAnalystCache(ticker, signal.analyst);
      setAnalystLoading(false);
    }
    let cancelled = false;
    setAnalystLoading(!signal.analyst);

    void fetchAnalystCoverage(ticker, signal.price).then((coverage) => {
      if (cancelled) return;
      setAnalystCoverage(coverage);
      setAnalystCache(ticker, coverage);
      setAnalystLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [ticker, signal?.price, setAnalystCache]);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    // Seed from the scored signal (a research run already attached trades),
    // then fetch the live disclosure index for direct navigations.
    setCongressTrades(signal?.congressTrades ?? []);
    if (!isLikelyLiveTicker(ticker)) return;
    void fetchCongressTrades(ticker).then((trades) => {
      if (!cancelled && trades.length > 0) setCongressTrades(trades);
    });
    return () => {
      cancelled = true;
    };
  }, [ticker, signal?.congressTrades]);

  // Lazy single-ticker deep dive: parse the recent Form 4 XML into a buy/sell
  // breakdown. Runs only when this ticker has insider filings - never universe-wide
  // (SEC rate limits). Degrades silently to "no breakdown" on any failure.
  useEffect(() => {
    const activity = signal?.secActivity;
    setForm4Summary(null);
    if (!activity || activity.form4Count90d === 0) {
      setForm4Loading(false);
      return;
    }
    let cancelled = false;
    setForm4Loading(true);
    void fetchForm4TradeSummary(activity)
      .then((summary) => {
        if (!cancelled) setForm4Summary(summary);
      })
      .finally(() => {
        if (!cancelled) setForm4Loading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, signal?.secActivity]);

  // Command-bar `?panel=` deep-link: scroll to the target section and flash it.
  // The signal - and several panels ABOVE the target (analyst coverage, AI brief,
  // Form-4) plus the news list itself - load async and EXPAND after first paint.
  // A single scroll was computed while everything above was a skeleton, so it
  // landed short and the viewport ended up above the real section (the "CEG news
  // lands on analyst targets" QA fail). We poll until the target mounts, scroll,
  // then RE-ALIGN while the layout above it keeps settling - tracking the target's
  // absolute document position (invariant under scrolling, moves only on reflow) -
  // and hold the flash until the section has stopped moving.
  useEffect(() => {
    if (!panelTarget || !signal) return;
    const targetId = PANEL_TARGETS[panelTarget];
    if (!targetId) return;
    let cancelled = false;
    let timer: number | undefined;
    let flashTimer: number | undefined;
    let findAttempts = 0;
    let settleTicks = 0;
    let stableStreak = 0;
    let lastTop = Number.NaN;

    const absoluteTop = (el: HTMLElement) =>
      Math.round(window.scrollY + el.getBoundingClientRect().top);

    const step = () => {
      if (cancelled) return;
      const el = document.getElementById(targetId);
      if (!el) {
        // Target not mounted yet (signal / panels still resolving) - poll ~3s.
        findAttempts += 1;
        if (findAttempts < 20) timer = window.setTimeout(step, 150);
        return;
      }
      const top = absoluteTop(el);
      const drifted = Number.isNaN(lastTop) || Math.abs(top - lastTop) > 4;
      if (drifted) {
        // First alignment, or content above the section just expanded - (re)align
        // and restart the flash so it is visible once the section finally settles.
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setFlashId(targetId);
        if (flashTimer !== undefined) window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => {
          if (!cancelled) setFlashId(null);
        }, 1700);
        lastTop = top;
        stableStreak = 0;
      } else {
        stableStreak += 1;
      }
      // Keep sampling until the section holds still twice running, capped ~2s so a
      // slow news fetch can't loop forever.
      settleTicks += 1;
      if (stableStreak < 2 && settleTicks < 15) timer = window.setTimeout(step, 140);
    };
    step();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (flashTimer !== undefined) window.clearTimeout(flashTimer);
    };
  }, [panelTarget, signal]);

  if (!ticker) {
    return (
      <div className="empty">
        <h3>No ticker specified</h3>
        <Link className="btn btn--ghost" to="/beacon">
          Ticker Lookup
        </Link>
      </div>
    );
  }

  if (!signal) {
    if (resolveError) {
      return (
        <>
          <button type="button" className="back-link" onClick={() => navigate(-1)}>
            <IconChevronLeft size={16} /> Back
          </button>
          <div className="empty sd-unresolved">
            <h3>
              {directoryRecord
                ? `${directoryRecord.symbol} — ${directoryRecord.name}`
                : `We couldn’t resolve “${ticker}”`}
            </h3>
            <p className="text-muted">
              {directoryRecord
                ? `Listed on ${directoryRecord.exchange}${
                    directoryRecord.country === "CA" ? " · Canada" : ""
                  }. Live research isn’t available for this listing right now — it loads here once a research run includes it.`
                : "No live or listed match for this symbol. Check the ticker, or search by company name."}
            </p>
            <div className="row gap-3 beacon-actions">
              <Link className="btn btn--primary" to="/beacon">
                Ticker Scope
              </Link>
              <Link className="btn btn--ghost" to="/today">
                Browse Today
              </Link>
            </div>
          </div>
          <InvestingDisclaimer className="page-disclaimer" />
        </>
      );
    }
    return <StockDetailSkeleton ticker={ticker} busy={loading} />;
  }

  const f = signal.fundamentals;
  // A real listing with no live data behind it: suppress every market-derived
  // surface (score, badges, valuation, fundamentals, snowflake) so the page is
  // honest-incomplete rather than confidently wrong.
  const noData = isMarketDataUnavailable(signal);
  const sample = isSampleProfile(signal);
  // Live mode must NEVER surface synthetic "(sample)" social content (owner request 2026-06-19):
  // when sample mode is OFF and this signal carries the modeled sample social set,
  // hide the fabricated summary/mentions/posts and point to the live X search instead.
  const liveSocial = !getSampleDataModeState().enabled;
  const socialIsSynthetic =
    /\(sample\)|sample (?:social|data|alert|political)/i.test(signal.socialSummary ?? "") ||
    (signal.socialPosts ?? []).some((p) => /\(sample\)/i.test(p.author ?? ""));
  const hideSyntheticSocial = liveSocial && socialIsSynthetic;
  const visibleSocialPosts = hideSyntheticSocial ? [] : signal.socialPosts ?? [];
  const socialSummaryText = hideSyntheticSocial
    ? "Live social — see the X search below for current posts."
    : signal.socialSummary;
  // Live-price overlay - the score & breakdown below stay on the daily research.
  const price = liveQuote?.price ?? signal.price;
  const dayChange = liveQuote?.dayChange ?? signal.dayChange;
  const up = dayChange >= 0;
  const newsItems = newsStatus === "live" ? liveNews : signal.news.items;
  // Direction-aware Presidential signal (real, sourced OGE 278-T disclosures +
  // dated callouts). Pure static lookup - independent of whether a scoring run
  // attached it - so the badge is correct even on a direct navigation. Suppressed
  // on a no-data listing (we don't decorate a name we can't otherwise source).
  const executiveSignal = !noData ? executiveSignalsForTicker(signal.ticker) : null;

  // Respect per-field fundamentals provenance: a field the live feed didn't
  // return (or anything on a no-data listing) reads "N/A", never a modeled value.
  const av = signal.fundamentalsAvailability;
  const fav = (k: keyof RawFundamentals): boolean => !noData && (!av || av[k] !== false);
  const naStat = (label: string) => ({ label, value: "N/A" as const });
  const fundamentals: Array<{ label: string; value: string; tone?: "positive" | "negative" }> = [
    fav("revenueGrowthYoY")
      ? { label: "Revenue Growth", value: formatPct(f.revenueGrowthYoY), tone: f.revenueGrowthYoY >= 0 ? "positive" : "negative" }
      : naStat("Revenue Growth"),
    fav("epsGrowthYoY")
      ? { label: "EPS Growth", value: formatPct(f.epsGrowthYoY), tone: f.epsGrowthYoY >= 0 ? "positive" : "negative" }
      : naStat("EPS Growth"),
    fav("grossMargin") ? { label: "Gross Margin", value: formatPctPlain(f.grossMargin) } : naStat("Gross Margin"),
    fav("netMargin")
      ? { label: "Net Margin", value: formatPctPlain(f.netMargin), tone: f.netMargin >= 0 ? "positive" : "negative" }
      : naStat("Net Margin"),
    fav("peRatio") && f.peRatio != null ? { label: "P/E", value: `${f.peRatio.toFixed(0)}x` } : naStat("P/E"),
    fav("pegRatio") && f.pegRatio != null ? { label: "PEG", value: f.pegRatio.toFixed(2) } : naStat("PEG"),
    fav("debtToEquity") ? { label: "Debt / Equity", value: `${f.debtToEquity.toFixed(2)}x` } : naStat("Debt / Equity"),
    fav("fcfMargin")
      ? { label: "FCF Margin", value: formatPctPlain(f.fcfMargin), tone: f.fcfMargin >= 0 ? "positive" : "negative" }
      : naStat("FCF Margin"),
    noData ? naStat("Beta") : { label: "Beta", value: signal.volatility.beta.toFixed(2) },
    noData ? naStat("ATR") : { label: "ATR", value: formatPctPlain(signal.volatility.atrPct) },
    noData ? naStat("Avg $ Vol") : { label: "Avg $ Vol", value: formatVolume(signal.liquidity.avgDollarVolume) },
    noData ? naStat("Short Int.") : { label: "Short Int.", value: formatPctPlain(signal.risk.shortInterestPct) },
  ];

  // Appends the deep-link flash class only to the section the command bar
  // just scrolled to (see the `?panel=` effect above).
  const flashClass = (id: string) => (flashId === id ? " sd-panel--flash" : "");

  return (
    <>
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        <IconChevronLeft size={16} /> Back to feed
      </button>

      <div
        id="sd-panel-chart"
        className={`signal-card signal-card--detail sd-block sd-reveal${flashClass("sd-panel-chart")}`}
        style={{ "--reveal-index": 0 } as CSSProperties}
      >
        <div className="signal-card__top">
          <div className="grow">
            <div className="sd-hero__head">
              <span className="ticker">{signal.ticker}</span>
              {!noData && <SparklineButton signal={signal} width={150} height={46} />}
            </div>
            <div className="company">{signal.name}</div>
            <div className="price-row">
              <span className="price mono">{formatPrice(price, signal.currency)}</span>
              <span className={`change ${up ? "change--up" : "change--down"}`}>
                {formatPct(dayChange)}
              </span>
              <ListingBadge exchange={signal.listingExchange} currency={signal.currency} />
              <span className="text-faint sd-hero__cap">
                {signal.marketCap > 0 ? `${formatMarketCap(signal.marketCap)} market cap` : "Market cap —"}
              </span>
              {!noData && <ValuationChip signal={signal} />}
              {!noData && <LivePriceControl tickers={ticker ? [ticker] : []} />}
            </div>
            <CrossListings listings={signal.crossListings} activeSymbol={signal.ticker} />
            {noData && (
              <p className="sd-hero__unavailable text-faint">
                Live market data is unavailable for this listing — price, fundamentals, sector, and
                catalyst can&apos;t be sourced right now.
              </p>
            )}
            {sample && (
              <p className="lookup-banner lookup-banner--sample">
                <strong>SAMPLE — not live.</strong> Illustrative figures for an unknown ticker, not real
                market data.
              </p>
            )}
            {noData ? (
              <div className="signal-card__badges">
                <span className="pill pill--muted" title="No live market data for this listing yet">
                  Live market data unavailable
                </span>
              </div>
            ) : (
              <div className="signal-card__badges">
                <CatalystPill type={signal.catalystType} />
                <HorizonPill signal={signal} />
                <SectorPill sector={signal.sector} />
                <CapPill bucket={signal.marketCapBucket} />
                <RiskPill level={signal.riskLevel} />
                <ConfidencePill confidence={signal.confidence} explanation={signal.score.confidenceExplanation} />
              </div>
            )}
            {signal.companyBlurb && !noData && (
              <p className="sd-company-blurb">{signal.companyBlurb}</p>
            )}
          </div>
          <div className="col score-stack">
            <ScoreRing score={signal.score.opportunityScore} size={104} stroke={9} unavailable={noData} />
            {!noData && (
              <>
                <ScoreAnalystBadge signal={{ ...signal, analyst: analystCoverage ?? signal.analyst }} />
                <span className="sd-score__label">{scoreLabel(signal.score.opportunityScore)}</span>
              </>
            )}
          </div>
        </div>
        <p className="thesis">{signal.thesis}</p>
        {!noData && <WhyTags signal={signal} />}
        {executiveSignal && <ExecutiveSignalCallout signal={executiveSignal} />}
        {!noData && <HypeStrip signal={signal} />}
        <ActionBar signal={signal} />
      </div>

      {!noData && (
        <div
          id="sd-panel-analyst"
          className={`signal-card sd-block sd-reveal${flashClass("sd-panel-analyst")}`}
          style={{ "--reveal-index": 1 } as CSSProperties}
        >
          <PriceTargetsPanel ticker={signal.ticker} coverage={analystCoverage} loading={analystLoading} spot={price} />
        </div>
      )}

      {!noData && (
        <div
          id="sd-panel-ai"
          className={`sd-block sd-reveal${flashClass("sd-panel-ai")}`}
          style={{ "--reveal-index": 2 } as CSSProperties}
        >
          <AiBriefPanel ticker={signal.ticker} companyName={signal.name} />
        </div>
      )}

      {!noData && (
        <div
          className="company-report sd-reveal"
          style={{ "--reveal-index": 2 } as CSSProperties}
        >
          <div className="signal-card company-report__viz">
            <div className="section-title">
              Signal Snowflake
              <InfoTip
                label="About the Catalyst axis"
                content={
                  <>
                    <strong className="tip__range">Catalyst counts dated events only</strong>
                    <span className="tip__hint">
                      Earnings, M&amp;A, FDA, contracts — a scheduled, structured event. Congress
                      or insider buying isn&apos;t a dated catalyst, so it shows up in Conviction
                      and the Warming/Heat score instead. A 0 here means no dated catalyst yet,
                      not that nothing is happening.
                    </span>
                  </>
                }
              />
            </div>
            <Snowflake signal={signal} variant="detail" />
          </div>
          <div className="signal-card company-report__rr">
            <div className="section-title">Risks &amp; Rewards</div>
            <RisksRewards signal={signal} variant="detail" />
          </div>
        </div>
      )}

      <div
        className="detail-grid sd-reveal"
        style={{ "--reveal-index": 3 } as CSSProperties}
      >
        <div id="sd-panel-score" className={`detail-grid__main signal-card${flashClass("sd-panel-score")}`}>
          {noData ? (
            <>
              <div className="section-title">Why there&apos;s no score yet</div>
              <p className="text-muted">
                {signal.name} is a real listing, but our live data provider couldn&apos;t return a quote
                or fundamentals for it. We don&apos;t score a name we can&apos;t source data for — it will
                appear with a full breakdown once a research run can cover it.
              </p>
            </>
          ) : (
            <>
              <div className="section-title">Why it scored {signal.score.opportunityScore}</div>
              <ScoreBreakdown breakdown={signal.score} />
            </>
          )}
        </div>

        <div className="detail-grid__side col gap-4">
          <div className="signal-card">
            <div className="section-title">Key Fundamentals</div>
            <div className="kfs sd-fundamentals">
              {fundamentals.map((kf) => (
                <div className="kf" key={kf.label}>
                  <div className="kf__label">{kf.label}</div>
                  <div className={`kf__value ${kf.tone ? `kf__value--${kf.tone}` : ""}`}>
                    {kf.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div id="sd-panel-social" className={`signal-card${flashClass("sd-panel-social")}`}>
            <div className="section-title">Social / Political</div>
            <p className="thesis sd-social__summary">{socialSummaryText}</p>
            {!noData && !hideSyntheticSocial && (
              <p className="text-faint sd-social__meta">
                {signal.social.xMentions24h.toLocaleString("en-US")} X mentions / 24h ·{" "}
                {signal.social.politicalMentions} political flag
                {signal.social.politicalMentions === 1 ? "" : "s"}
              </p>
            )}
            {visibleSocialPosts.length > 0 && (
              <div className="social-posts">
                {visibleSocialPosts.map((post) => (
                  <ExternalLink
                    key={`${post.handle}-${post.publishedAt}`}
                    className={`social-post social-post--${post.severity}`}
                    href={post.url}
                  >
                    <div className="social-post__head">
                      <span className="social-post__author">{post.author}</span>
                      <span className="text-faint">{post.handle}</span>
                      <span className="text-faint sd-social__post-time">
                        {relativeTime(post.publishedAt)}
                      </span>
                    </div>
                    <p className="social-post__text">{post.text}</p>
                    <span className="social-post__link-hint text-faint">
                      {post.platform === "x"
                        ? `Opens X search for $${signal.ticker}`
                        : "Opens Reddit search for this ticker"}
                    </span>
                  </ExternalLink>
                ))}
              </div>
            )}
            <ExternalLink
              className="insight__link sd-social__banner"
              href={externalXSearchUrl(signal.ticker)}
            >
              Live X search for {signal.ticker}
              <IconExternal size={13} />
            </ExternalLink>
            {signal.lookupProvenance === "finnhub" && (
              <p className="lookup-banner lookup-banner--curated sd-social__banner">
                Live quote from Finnhub; social and catalyst fields are still modeled for scoring.
              </p>
            )}
            {signal.lookupProvenance === "yahoo" && (
              <p className="lookup-banner lookup-banner--curated sd-social__banner">
                Live {signal.listingExchange ?? "exchange"} quote &amp; chart from Yahoo Finance
                {signal.currency ? ` (${signal.currency})` : ""}; market cap, fundamentals, social
                and catalyst are unavailable for this listing and shown as N/A.
              </p>
            )}
            {signal.lookupProvenance === "synthetic" && (
              <p className="lookup-banner sd-social__banner">
                Lookup profile — sample data, not a live social feed.
              </p>
            )}
          </div>

          {!noData && (
            <div id="sd-panel-filings" className={`signal-card${flashClass("sd-panel-filings")}`}>
              {signal.secActivity &&
              (signal.secActivity.form4Count90d > 0 ||
                signal.secActivity.eightKCount90d > 0 ||
                (signal.secActivity.filings?.length ?? 0) > 0) ? (
                <SecFilingsPanel
                  activity={signal.secActivity}
                  form4Summary={form4Summary}
                  form4Loading={form4Loading}
                />
              ) : (
                <>
                  <div className="section-title">SEC filings · insider &amp; 8-K</div>
                  <p className="text-muted">
                    No insider (Form 4) buys/sales or 8-K filings on EDGAR for {signal.ticker} in the
                    last 90 days.
                  </p>
                </>
              )}
              {/* Congressional disclosures are FILINGS - they live here with insider /
                  SEC data, not in the Social/Political (sentiment) tile above. Own anchor
                  id so the command bar's "congress" action can deep-link past the SEC
                  section above it, even though both live in the same card. */}
              <div
                id="sd-panel-congress"
                className={flashId === "sd-panel-congress" ? "sd-panel--flash" : undefined}
              >
                <CongressTradesPanel trades={congressTrades} />
              </div>
            </div>
          )}
        </div>

        <div id="sd-panel-news" className={`detail-grid__news signal-card${flashClass("sd-panel-news")}`}>
          <CatalystNewsPanel signal={signal} items={newsItems} liveStatus={newsStatus} />
        </div>

        <div className="detail-grid__sources signal-card">
          <div className="section-title">Sources</div>
          <div className="col gap-2">
            {(signal.sources ?? []).map((s) => (
              <ExternalLink
                key={s.url}
                href={sourceItemHref(signal.ticker, s.url, s.label)}
                className="source-link"
              >
                <IconExternal size={15} />
                <span className="grow">{s.label}</span>
                <span className="text-faint" style={{ fontSize: 12 }}>
                  {hostnameOf(sourceItemHref(signal.ticker, s.url, s.label))}
                </span>
              </ExternalLink>
            ))}
          </div>
        </div>
      </div>

      <InvestingDisclaimer className="page-disclaimer" />
    </>
  );
}
