import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconCopy,
  IconImage,
  IconMinus,
  IconRefresh,
  IconTrash,
} from "@/components/icons";
import { AllocationStudio } from "@/components/portfolio/AllocationStudio";
import { HoldingsTable } from "@/components/portfolio/HoldingsTable";
import { HoldingInspector } from "@/components/portfolio/HoldingInspector";
import { PhotoImportModal } from "@/components/portfolio/PhotoImportModal";
import { PortfolioInsightsPanel } from "@/components/portfolio/PortfolioInsightsPanel";
import { PortfolioNewsPanel } from "@/components/portfolio/PortfolioNewsPanel";
import { PortfolioValueChart } from "@/components/portfolio/PortfolioValueChart";
import { PortfolioVitals } from "@/components/portfolio/PortfolioVitals";
import { isVisionConfigured } from "@/data/vision/extractHoldings";
import { MODE_ACCENT } from "@/data/seedPortfolios";
import { computePortfolioAnalytics, type PortfolioAnalytics } from "@/engine/portfolioAnalytics";
import { derivePortfolioHistory } from "@/engine/portfolioHistory";
import { derivePortfolioInsights } from "@/engine/portfolioInsights";
import { formatCurrency, formatPct, formatPctPlain, formatSignedCurrency } from "@/lib/format";
import { useAppStore } from "@/store/useAppStore";

type PortfolioHeroStyle = CSSProperties & {
  "--portfolio-accent": string;
};

function DirectionIcon({ value }: { value: number }) {
  if (value > 0) return <IconArrowUp size={15} />;
  if (value < 0) return <IconArrowDown size={15} />;
  return <IconMinus size={15} />;
}

function PerformanceStat({
  label,
  value,
  ratio,
  toneValue,
  available,
}: {
  label: string;
  value: string;
  ratio?: string;
  toneValue: number;
  available: boolean;
}) {
  const toneClass = toneValue > 0 ? "pl-pos" : toneValue < 0 ? "pl-neg" : "text-faint";
  const direction = toneValue > 0 ? "Up" : toneValue < 0 ? "Down" : "Flat";

  return (
    <div className="portfolio-book__metric">
      <span className="portfolio-book__metric-label">{label}</span>
      {available ? (
        <div className={`portfolio-book__metric-value ${toneClass}`} aria-label={`${direction}: ${value}`}>
          <DirectionIcon value={toneValue} />
          <span className="mono">{value}</span>
        </div>
      ) : (
        <div className="portfolio-book__metric-value text-faint">
          <IconMinus size={15} />
          <span className="mono">Not tracked</span>
        </div>
      )}
      {available && ratio && <span className={`portfolio-book__metric-sub mono ${toneClass}`}>{ratio}</span>}
    </div>
  );
}

/** Slim, scroll-condensing recap bar - the detail page's signature interaction. */
function PortfolioStickyHeader({
  shown,
  name,
  totalValue,
  valueTracked,
  dayChangeValue,
  dayChangePct,
}: {
  shown: boolean;
  name: string;
  totalValue: number;
  valueTracked: boolean;
  dayChangeValue: number;
  dayChangePct: number;
}) {
  const tone = dayChangeValue > 0 ? "pl-pos" : dayChangeValue < 0 ? "pl-neg" : "text-faint";
  return (
    <div className={`pf-stick${shown ? " is-shown" : ""}`} aria-hidden={!shown}>
      <div className="pf-stick__inner">
        <span className="pf-stick__name">{name}</span>
        <span className="pf-stick__spacer" />
        {valueTracked ? (
          <>
            <span className="pf-stick__value mono">
              <NumberFlow
                value={totalValue}
                format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }}
                aria-label={formatCurrency(totalValue)}
              />
            </span>
            <span className={`pf-stick__day mono ${tone}`}>
              <DirectionIcon value={dayChangeValue} />
              {formatSignedCurrency(dayChangeValue)} <span aria-hidden>·</span> {formatPct(dayChangePct)}
            </span>
          </>
        ) : (
          <span className="pf-stick__value pf-stick__value--muted mono">Watch-only book</span>
        )}
      </div>
    </div>
  );
}

function PortfolioDetailSkeleton() {
  return (
    <div className="portfolio-book-skeleton" aria-busy="true" aria-label="Loading portfolio values">
      <LoadingNote
        label="this book"
        hint="Valuing your holdings at market price — a moment, not stuck."
      />
      <span className="skeleton portfolio-book-skeleton__back" />
      <section className="portfolio-book-skeleton__hero">
        <div className="portfolio-book-skeleton__heading">
          <span className="skeleton portfolio-book-skeleton__eyebrow" />
          <span className="skeleton portfolio-book-skeleton__title" />
          <span className="skeleton portfolio-book-skeleton__copy" />
        </div>
        <div className="portfolio-book-skeleton__value-block">
          <span className="skeleton portfolio-book-skeleton__label" />
          <span className="skeleton portfolio-book-skeleton__value" />
        </div>
        <div className="portfolio-book-skeleton__metrics">
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index} className="skeleton portfolio-book-skeleton__metric" />
          ))}
        </div>
      </section>
      <span className="skeleton portfolio-book-skeleton__chart" />
      <div className="pf-grid">
        <span className="skeleton portfolio-book-skeleton__panel" />
        <span className="skeleton portfolio-book-skeleton__panel" />
      </div>
      <span className="skeleton portfolio-book-skeleton__table" />
    </div>
  );
}

function DataError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="portfolio-book__data-error" role="alert">
      <div>
        <strong>Live valuation is temporarily unavailable.</strong>
        <p>Snapshot values and holdings are still shown. Retry research to refresh prices.</p>
      </div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
        <IconRefresh size={15} />
        Retry
      </button>
    </div>
  );
}

function EmptyPortfolio({ owned, onImport }: { owned: boolean; onImport: () => void }) {
  return (
    <div className="empty portfolio-book__empty pf-reveal" style={{ "--reveal-index": 0 } as CSSProperties}>
      <span className="portfolio-book__empty-kicker">Your first position sets the shape of this book</span>
      <h2>No holdings yet</h2>
      <p>
        {owned
          ? "Import a portfolio image or add a ticker in the holdings row below."
          : "This public portfolio does not have any holdings yet."}
      </p>
      {owned && (
        <button type="button" className="btn btn--primary" onClick={onImport}>
          <IconImage size={15} />
          Import from photo
        </button>
      )}
    </div>
  );
}

function buildSnapshot(name: string, mode: string, analytics: PortfolioAnalytics): string {
  const lines = [`${name} · ${mode}`];
  if (analytics.totalValue > 0) {
    lines.push(`Total value: ${formatCurrency(analytics.totalValue)}`);
    lines.push(`Today: ${formatSignedCurrency(analytics.dayChangeValue)} (${formatPct(analytics.dayChangePct)})`);
  }
  if (analytics.totalCost > 0) {
    lines.push(`Total P/L: ${formatSignedCurrency(analytics.totalPL)} (${formatPct(analytics.totalPLPct)})`);
  }
  const top = analytics.holdingAllocation
    .slice(0, 5)
    .map((s) => `${s.label} ${formatPctPlain(s.pct)}`)
    .join(", ");
  if (top) lines.push(`Top: ${top}`);
  lines.push("— Catalyzed Alpha · research & discovery, not advice");
  return lines.join("\n");
}

export function PortfolioDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const portfolio = useAppStore((state) => state.portfolios.find((item) => item.id === id));
  const signals = useAppStore((state) => state.signals);
  const lookupCache = useAppStore((state) => state.lookupCache);
  const portfolioQuotes = useAppStore((state) => state.portfolioQuotes);
  const researchStatus = useAppStore((state) => state.researchStatus);
  const resolveSignal = useAppStore((state) => state.resolveSignal);
  const runResearchNow = useAppStore((state) => state.runResearchNow);
  const deletePortfolio = useAppStore((state) => state.deletePortfolio);
  const recordPortfolioValues = useAppStore((state) => state.recordPortfolioValues);
  const refreshPortfolioQuotes = useAppStore((state) => state.refreshPortfolioQuotes);
  const livePrices = useAppStore((state) => state.livePrices);
  const refreshLivePrices = useAppStore((state) => state.refreshLivePrices);
  const checkPortfolioSplits = useAppStore((state) => state.checkPortfolioSplits);
  const pushToast = useAppStore((state) => state.pushToast);

  const [photoMode, setPhotoMode] = useState<"add" | "update" | null>(null);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [condensed, setCondensed] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  const analytics = useMemo(
    () =>
      portfolio
        ? computePortfolioAnalytics(
            portfolio,
            (ticker) => resolveSignal(ticker),
            // Live overlay (Alpaca) preferred; Finnhub portfolioQuotes is the fallback.
            (ticker) => livePrices[ticker.trim().toUpperCase()] ?? portfolioQuotes[ticker],
          )
        : null,
    [portfolio, signals, lookupCache, portfolioQuotes, livePrices], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const insights = useMemo(
    () => (analytics ? derivePortfolioInsights(analytics.rows, (ticker) => resolveSignal(ticker)) : []),
    [analytics, signals, lookupCache], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const history = useMemo(
    () => (portfolio ? derivePortfolioHistory(portfolio, (ticker) => resolveSignal(ticker)) : null),
    [portfolio, signals, lookupCache], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const waitingForInitialValues = Boolean(
    portfolio &&
      analytics &&
      portfolio.holdings.length > 0 &&
      researchStatus === "running" &&
      signals.length === 0 &&
      analytics.valuedCount === 0,
  );

  useEffect(() => {
    if (!waitingForInitialValues) {
      setShowLoading(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowLoading(true), 300);
    return () => window.clearTimeout(timeout);
  }, [waitingForInitialValues]);

  useEffect(() => {
    if (portfolio?.owner === "me") recordPortfolioValues();
  }, [
    portfolio?.id,
    portfolio?.owner,
    signals,
    lookupCache,
    portfolioQuotes,
    livePrices,
    recordPortfolioValues,
  ]);

  useEffect(() => {
    if (!portfolio || portfolio.owner !== "me") return;
    if (!portfolio.holdings.some((holding) => (holding.shares ?? 0) > 0)) return;

    let active = true;
    setRefreshingPrices(true);
    // Live overlay (Alpaca bulk, one call) + the existing Finnhub value-history path.
    void refreshLivePrices(portfolio.holdings.map((h) => h.ticker));
    void refreshPortfolioQuotes(portfolio.id).finally(() => {
      if (active) setRefreshingPrices(false);
    });
    // Real corporate-action check - rescales any holding whose lot predates a
    // detected stock split (fixes the "phantom value after a reverse split" bug).
    // Never silent: applies via a visible, dismissible, undoable note.
    void checkPortfolioSplits(portfolio.id);
    return () => {
      active = false;
    };
  }, [portfolio?.id, refreshPortfolioQuotes, refreshLivePrices, checkPortfolioSplits]); // eslint-disable-line react-hooks/exhaustive-deps

  // Signature interaction: condense the hero into a slim recap bar on scroll.
  useEffect(() => {
    const scroller = rootRef.current?.closest(".content") as HTMLElement | null;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setCondensed(scroller.scrollTop > 300));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [id]);

  if (!portfolio || !analytics) {
    return (
      <div className="empty portfolio-book__not-found" role="alert">
        <h1>Portfolio unavailable</h1>
        <p>It may have been removed or is no longer shared with this profile.</p>
        <Link className="btn btn--ghost" to="/portfolios">
          <IconChevronLeft size={16} />
          Back to portfolios
        </Link>
      </div>
    );
  }

  if (showLoading) return <PortfolioDetailSkeleton />;

  const accent = portfolio.accent ?? MODE_ACCENT[portfolio.mode];
  const heroStyle: PortfolioHeroStyle = { "--portfolio-accent": accent };
  const owned = portfolio.owner === "me";
  // Photo-import (screenshot → holdings) needs a configured vision endpoint.
  // The keyless web build has none, so don't surface its trigger buttons there;
  // the modal keeps a graceful "not configured" notice as a safety net.
  const visionReady = isVisionConfigured();
  const valueTracked = analytics.totalValue > 0;
  const tickers = portfolio.holdings.map((holding) => holding.ticker);
  // Concentration headline for the allocation gauge (same basis as the vitals
  // strip): the largest single-name weight and the effective-holdings count.
  const topHolding = analytics.holdingAllocation[0];
  const concentrationSumSq = analytics.holdingAllocation.reduce((a, s) => a + s.pct * s.pct, 0);
  const effectiveHoldings = concentrationSumSq > 0 ? 1 / concentrationSumSq : 0;
  const dataFailed =
    researchStatus === "error" && signals.length === 0 && portfolio.holdings.length > 0;
  const totalPLTracked = analytics.totalCost > 0;
  const selectedRow = selectedTicker
    ? analytics.rows.find((row) => row.ticker === selectedTicker)
    : undefined;

  const copySnapshot = () => {
    const text = buildSnapshot(portfolio.name, portfolio.mode, analytics);
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(text)
        .then(() => pushToast("Snapshot copied to clipboard", "success"))
        .catch(() => pushToast("Couldn't copy snapshot", "warn"));
    } else {
      pushToast("Clipboard unavailable in this view", "warn");
    }
  };

  const metadata: ReactNode[] = [
    owned ? "Your book" : portfolio.owner,
    portfolio.isPublic ? "Public" : "Private",
    `${portfolio.holdings.length} holding${portfolio.holdings.length === 1 ? "" : "s"}`,
  ];

  return (
    <div className="portfolio-book" style={heroStyle} ref={rootRef}>
      <div className="pf-desk__aura" aria-hidden />

      <PortfolioStickyHeader
        shown={condensed}
        name={portfolio.name}
        totalValue={analytics.totalValue}
        valueTracked={valueTracked}
        dayChangeValue={analytics.dayChangeValue}
        dayChangePct={analytics.dayChangePct}
      />

      <Link to="/portfolios" className="back-link portfolio-book__back">
        <IconChevronLeft size={16} />
        Portfolios
      </Link>

      <section className="portfolio-book__hero portfolio-book__hero--lit">
        <div className="portfolio-book__hero-top">
          <div className="portfolio-book__identity">
            <span className="portfolio-book__eyebrow">{portfolio.mode}</span>
            <h1>{portfolio.name}</h1>
            <p>{portfolio.description || "Illustrative research portfolio."}</p>
            <div className="portfolio-book__meta">
              {metadata.map((item, index) => (
                <span key={index}>{item}</span>
              ))}
            </div>
          </div>

          <div className="portfolio-book__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={copySnapshot}>
              <IconCopy size={15} />
              Copy snapshot
            </button>
            {owned && (
              <>
                {visionReady && (
                  <>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setPhotoMode("update")}
                    >
                      <IconRefresh size={15} />
                      Update positions
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setPhotoMode("add")}
                    >
                      <IconImage size={15} />
                      Import photo
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm portfolio-book__delete"
                  onClick={() => {
                    deletePortfolio(portfolio.id);
                    navigate("/portfolios");
                  }}
                >
                  <IconTrash size={15} />
                  Delete
                </button>
              </>
            )}
          </div>
        </div>

        <div className="portfolio-book__valuation">
          <div className="portfolio-book__total">
            <span className="portfolio-book__total-label">Total market value</span>
            <strong className="portfolio-book__total-value mono">
              {valueTracked ? (
                <NumberFlow
                  value={analytics.totalValue}
                  format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }}
                  aria-label={formatCurrency(analytics.totalValue)}
                />
              ) : (
                "-"
              )}
            </strong>
            <span className="portfolio-book__total-sub">
              {valueTracked
                ? `${analytics.valuedCount} of ${portfolio.holdings.length} holdings valued${
                    refreshingPrices ? " · refreshing quotes" : ""
                  }`
                : "Add shares or snapshot values to track the book by market value"}
            </span>
          </div>

          <div className="portfolio-book__metrics">
            <PerformanceStat
              label="Today"
              value={formatSignedCurrency(analytics.dayChangeValue)}
              ratio={formatPct(analytics.dayChangePct)}
              toneValue={analytics.dayChangeValue}
              available={valueTracked}
            />
            <PerformanceStat
              label="Total P/L"
              value={formatSignedCurrency(analytics.totalPL)}
              ratio={formatPct(analytics.totalPLPct)}
              toneValue={analytics.totalPL}
              available={totalPLTracked}
            />
            <div className="portfolio-book__metric">
              <span className="portfolio-book__metric-label">Avg opportunity</span>
              <div className="portfolio-book__metric-value">
                <span className="portfolio-book__score mono">{analytics.avgOpportunity ?? "-"}</span>
                <span className="portfolio-book__score-denominator mono">/100</span>
              </div>
              <span className="portfolio-book__metric-sub">Research score, not advice</span>
            </div>
          </div>
        </div>
      </section>

      {dataFailed && <DataError onRetry={() => void runResearchNow("manual")} />}

      {portfolio.holdings.length > 0 ? (
        <>
          <div className="pf-reveal" style={{ "--reveal-index": 0 } as CSSProperties}>
            <PortfolioVitals analytics={analytics} valueTracked={valueTracked} />
          </div>

          {history && (
            <div className="pf-reveal" style={{ "--reveal-index": 1 } as CSSProperties}>
              <PortfolioValueChart
                history={history}
                baseline={totalPLTracked ? analytics.totalCost : undefined}
              />
            </div>
          )}

          <div className="pf-reveal" style={{ "--reveal-index": 2 } as CSSProperties}>
            <AllocationStudio
              sectorGroups={analytics.sectorGroups}
              valueTracked={valueTracked}
              totalValue={analytics.totalValue}
              holdingCount={portfolio.holdings.length}
              concentration={topHolding?.pct ?? 0}
              concentrationTicker={topHolding?.label}
              effectiveHoldings={effectiveHoldings}
              sectorCount={analytics.sectorAllocation.length}
              owned={owned}
              onTrackValue={owned ? () => setPhotoMode("update") : undefined}
              onSelectHolding={setSelectedTicker}
            />
          </div>

          <div className="pf-reveal" style={{ "--reveal-index": 3 } as CSSProperties}>
            <PortfolioInsightsPanel insights={insights} />
          </div>
        </>
      ) : (
        <EmptyPortfolio owned={owned} onImport={() => setPhotoMode("add")} />
      )}


      <section
        className="portfolio-book__holdings pf-reveal"
        style={{ "--reveal-index": 5 } as CSSProperties}
        aria-labelledby="portfolio-holdings-title"
      >
        <div className="portfolio-book__section-head section-head--sticky">
          <div>
            <h2 id="portfolio-holdings-title">Holdings</h2>
            <p>
              {owned
                ? "Select a ticker for its portfolio scope. Sort any column; edit shares and average cost inline."
                : "Illustrative positions shared for research and discovery."}
            </p>
          </div>
          <span className="portfolio-book__section-count mono">{portfolio.holdings.length}</span>
        </div>
        {(portfolio.holdings.length > 0 || owned) && (
          <HoldingsTable
            rows={analytics.rows}
            portfolioId={portfolio.id}
            owned={owned}
            onSelectTicker={setSelectedTicker}
          />
        )}
      </section>

      {portfolio.holdings.length > 0 && (
        <div className="portfolio-book__news pf-reveal" style={{ "--reveal-index": 6 } as CSSProperties}>
          <PortfolioNewsPanel tickers={tickers} />
        </div>
      )}

      <InvestingDisclaimer className="page-disclaimer" />

      {photoMode && (
        <PhotoImportModal
          key={photoMode}
          portfolioId={portfolio.id}
          initialMode={photoMode}
          onClose={() => setPhotoMode(null)}
        />
      )}

      {selectedRow && (
        <HoldingInspector
          row={selectedRow}
          signal={resolveSignal(selectedRow.ticker)}
          portfolioId={portfolio.id}
          onClose={() => setSelectedTicker(null)}
        />
      )}
    </div>
  );
}
