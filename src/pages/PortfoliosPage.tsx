import { useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { useAppStore } from "@/store/useAppStore";
import { PortfolioCard } from "@/components/portfolio/PortfolioCard";
import { PortfolioDeskEmptyState } from "@/components/portfolio/PortfolioDeskEmptyState";
import { CreatePortfolioModal } from "@/components/portfolio/CreatePortfolioModal";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { PageHeader } from "@/components/common/PageHeader";
import { computePortfolioAnalytics } from "@/engine/portfolioAnalytics";
import { formatPct, formatSignedCurrency } from "@/lib/format";
import { IconArrowDown, IconArrowUp, IconMinus, IconPlus } from "@/components/icons";
import type { Portfolio } from "@/types";

/** Aggregate stats across the user's own books - the desk's focal readout. */
function PortfolioDeskSummary({ portfolios }: { portfolios: Portfolio[] }) {
  const signals = useAppStore((s) => s.signals);
  const portfolioQuotes = useAppStore((s) => s.portfolioQuotes);
  const resolveSignal = useAppStore((s) => s.resolveSignal);
  const researchStatus = useAppStore((s) => s.researchStatus);

  const desk = useMemo(() => {
    let totalValue = 0;
    let dayChangeValue = 0;
    const opportunities: number[] = [];
    let holdings = 0;
    for (const p of portfolios) {
      const a = computePortfolioAnalytics(
        p,
        (t) => resolveSignal(t),
        (t) => portfolioQuotes[t],
      );
      totalValue += a.totalValue;
      dayChangeValue += a.dayChangeValue;
      holdings += p.holdings.length;
      if (a.avgOpportunity != null) opportunities.push(a.avgOpportunity);
    }
    const avgOpportunity = opportunities.length
      ? Math.round(opportunities.reduce((x, y) => x + y, 0) / opportunities.length)
      : null;
    return {
      totalValue,
      dayChangeValue,
      dayChangePct: totalValue > 0 ? dayChangeValue / totalValue : 0,
      holdings,
      avgOpportunity,
      tracked: totalValue > 0,
    };
  }, [portfolios, signals, portfolioQuotes, resolveSignal]);

  const toneClass =
    desk.dayChangeValue > 0 ? "pl-pos" : desk.dayChangeValue < 0 ? "pl-neg" : "text-faint";
  const busy = researchStatus === "running";

  return (
    <section className="pf-desk__summary" aria-label="Portfolio overview">
      <div className="pf-desk__summary-sheen" aria-hidden />
      <div className="pf-desk__summary-head">
        <span className={`pf-desk__lamp${busy ? " is-busy" : ""}`} aria-hidden />
        <span className="pf-desk__summary-title">Your desk</span>
        <span className="pf-desk__summary-sub text-faint">
          {desk.tracked
            ? `${portfolios.length} ${portfolios.length === 1 ? "book" : "books"} valued live`
            : busy
              ? "Valuing your books…"
              : "Scan Market to value your books by market price"}
        </span>
      </div>

      <div className="pf-desk__metrics">
        <div className="pf-desk__metric pf-desk__metric--hero">
          <span className="pf-desk__metric-label">Total market value</span>
          <strong className="pf-desk__metric-value mono">
            {desk.tracked ? (
              <NumberFlow
                value={desk.totalValue}
                format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }}
              />
            ) : (
              "—"
            )}
          </strong>
        </div>

        <div className="pf-desk__metric">
          <span className="pf-desk__metric-label">Today</span>
          <span className={`pf-desk__metric-value pf-desk__metric-value--row ${desk.tracked ? toneClass : "text-faint"}`}>
            {desk.tracked ? (
              <>
                {desk.dayChangeValue > 0 ? (
                  <IconArrowUp size={16} />
                ) : desk.dayChangeValue < 0 ? (
                  <IconArrowDown size={16} />
                ) : (
                  <IconMinus size={16} />
                )}
                <span className="mono">{formatSignedCurrency(desk.dayChangeValue)}</span>
              </>
            ) : (
              <span className="mono">—</span>
            )}
          </span>
          {desk.tracked && (
            <span className={`pf-desk__metric-foot mono ${toneClass}`}>
              {formatPct(desk.dayChangePct)}
            </span>
          )}
        </div>

        <div className="pf-desk__metric">
          <span className="pf-desk__metric-label">Books</span>
          <strong className="pf-desk__metric-value mono">
            <NumberFlow value={portfolios.length} />
          </strong>
          <span className="pf-desk__metric-foot text-faint">{desk.holdings} holdings</span>
        </div>

        <div className="pf-desk__metric">
          <span className="pf-desk__metric-label">Avg opportunity</span>
          <strong className="pf-desk__metric-value mono">
            {desk.avgOpportunity != null ? <NumberFlow value={desk.avgOpportunity} /> : "—"}
            <span className="pf-desk__metric-denominator mono">/100</span>
          </strong>
          <span className="pf-desk__metric-foot text-faint">Research score, not advice</span>
        </div>
      </div>
    </section>
  );
}

export function PortfoliosPage() {
  const portfolios = useAppStore((s) => s.portfolios);
  const [showCreate, setShowCreate] = useState(false);

  const mine = portfolios.filter((p) => p.owner === "me");
  const others = portfolios.filter((p) => p.owner !== "me");

  return (
    <div className="pf-desk">
      <div className="pf-desk__aura" aria-hidden />

      <PageHeader
        title="Portfolios"
        description="Curate stocks into themed, playlist-style books. Add names straight from any feed card."
        action={
          <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
            <IconPlus size={16} /> New portfolio
          </button>
        }
      />

      {mine.length > 0 && <PortfolioDeskSummary portfolios={mine} />}

      <div className="section-title pf-desk__section-title">Your portfolios</div>
      {mine.length > 0 ? (
        <div className="feed-grid pf-desk__grid">
          {mine.map((p, i) => (
            <PortfolioCard key={p.id} portfolio={p} index={i} />
          ))}
        </div>
      ) : (
        <PortfolioDeskEmptyState onCreate={() => setShowCreate(true)} />
      )}

      {others.length > 0 && (
        <>
          <div className="pf-divider" role="separator">
            <span className="pf-divider__line" aria-hidden />
            <span className="pf-divider__label">Discover · channels &amp; public</span>
            <span className="pf-divider__count mono">{others.length}</span>
            <span className="pf-divider__line" aria-hidden />
          </div>
          <div className="feed-grid pf-desk__grid">
            {others.map((p, i) => (
              <PortfolioCard key={p.id} portfolio={p} index={i} />
            ))}
          </div>
        </>
      )}

      {showCreate && <CreatePortfolioModal onClose={() => setShowCreate(false)} />}

      <InvestingDisclaimer className="page-disclaimer" />
    </div>
  );
}
