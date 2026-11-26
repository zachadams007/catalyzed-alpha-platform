import { useMemo, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { Portfolio } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { computePortfolioAnalytics } from "@/engine/portfolioAnalytics";
import { MODE_ACCENT } from "@/data/seedPortfolios";
import { formatCurrency, formatPct } from "@/lib/format";

type PortfolioCardStyle = CSSProperties & {
  "--portfolio-accent": string;
  "--reveal-index"?: number;
};

export function PortfolioCard({ portfolio, index = 0 }: { portfolio: Portfolio; index?: number }) {
  const signals = useAppStore((s) => s.signals);
  const portfolioQuotes = useAppStore((s) => s.portfolioQuotes);
  const resolveSignal = useAppStore((s) => s.resolveSignal);
  const accent = portfolio.accent ?? MODE_ACCENT[portfolio.mode];

  const analytics = useMemo(
    () =>
      computePortfolioAnalytics(
        portfolio,
        (t) => resolveSignal(t),
        (t) => portfolioQuotes[t],
      ),
    [portfolio, signals, portfolioQuotes, resolveSignal],
  );
  const tracked = analytics.totalValue > 0;
  const plTracked = tracked && analytics.totalCost > 0;
  // Top weighted slices for the allocation micro-bar (the alive element).
  const bar = analytics.holdingAllocation.slice(0, 6);

  const style: PortfolioCardStyle = { "--portfolio-accent": accent, "--reveal-index": index };

  return (
    <Link to={`/portfolios/${portfolio.id}`} className="portfolio-card pf-card" style={style}>
      <span className="portfolio-card__accent" aria-hidden />
      <div className="row-between pf-card__top">
        <span className="portfolio-card__mode">{portfolio.mode}</span>
        {plTracked ? (
          <span className={`pl-badge ${analytics.totalPLPct >= 0 ? "pl-pos" : "pl-neg"}`}>
            {formatPct(analytics.totalPLPct)}
          </span>
        ) : (
          analytics.avgOpportunity != null && (
            <span className="match-badge">avg {analytics.avgOpportunity}</span>
          )
        )}
      </div>

      <div className="portfolio-card__name">{portfolio.name}</div>
      {tracked && (
        <div className="portfolio-card__value mono">{formatCurrency(analytics.totalValue)}</div>
      )}
      <div className="portfolio-card__desc">{portfolio.description || "—"}</div>

      {bar.length > 0 && (
        <div
          className="pf-card__alloc"
          role="img"
          aria-label={`Allocation across ${bar.length} top holdings`}
        >
          {bar.map((seg, i) => (
            <span
              key={seg.label}
              className="pf-card__alloc-seg"
              style={{ background: seg.color, width: `${Math.max(seg.pct * 100, 3)}%`, "--seg-index": i } as CSSProperties}
            />
          ))}
        </div>
      )}

      <div className="holdings-strip">
        {portfolio.holdings.slice(0, 8).map((h) => (
          <span className="holding-chip" key={h.ticker}>
            {h.ticker}
          </span>
        ))}
        {portfolio.holdings.length > 8 && (
          <span className="holding-chip holding-chip--more">+{portfolio.holdings.length - 8}</span>
        )}
      </div>

      <div className="row-between pf-card__foot">
        <span className="pf-card__owner text-faint">
          {portfolio.owner === "me" ? "You" : portfolio.owner}
          {portfolio.isPublic ? " · Public" : ""}
        </span>
        <span className="pf-card__count text-faint">{portfolio.holdings.length} holdings</span>
      </div>
    </Link>
  );
}
