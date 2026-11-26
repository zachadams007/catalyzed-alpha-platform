import { PriceTargetsSkeleton } from "@/components/common/PriceTargetsSkeleton";
import type { AnalystCoverage } from "@/types";
import { ExternalLink } from "@/components/common/ExternalLink";
import { IconExternal } from "@/components/icons";
import { analystRatingTotal, consensusSpread, upsideVsSpot } from "@/lib/analystStats";
import { formatPct, formatPrice } from "@/lib/format";
import { isFinnhubConfigured } from "@/data/http";
import { isSampleAnalystCoverage } from "@/data/analyst/sanitizeAnalystCoverage";
import { useSampleDataMode } from "@/hooks/useSampleDataMode";

interface PriceTargetsPanelProps {
  ticker: string;
  coverage: AnalystCoverage | null;
  loading: boolean;
  /**
   * The LIVE spot price the surrounding page shows in its header. Passed in so the
   * "Spot price" stat + implied-move hero read the SAME number the user sees up top,
   * instead of `coverage.spotPrice` (snapshotted when analyst coverage was fetched,
   * which drifts stale) - fixes the "two different spot prices on one screen" bug.
   */
  spot?: number;
}

export function PriceTargetsPanel({ ticker, coverage, loading, spot: liveSpot }: PriceTargetsPanelProps) {
  // Reactive sample-mode so a pending→live transition re-suppresses immediately,
  // rather than snapshotting the stale fail-closed pre-load value.
  const sampleMode = useSampleDataMode();
  // Prefer the page's live header price so the panel never contradicts it; fall
  // back to the coverage snapshot only when no live price is available.
  const spot = liveSpot != null && liveSpot > 0 ? liveSpot : (coverage?.spotPrice ?? 0);
  const consensus = coverage?.consensus;
  const mean = consensus?.mean;
  const median = consensus?.median;
  const high = consensus?.high;
  const low = consensus?.low;
  const spread = consensusSpread(consensus);
  const analysts = analystRatingTotal(coverage?.recommendations);
  const up = mean != null && spot > 0 ? upsideVsSpot(spot, mean) : null;

  // Seeded-random sample numbers are a hash of the symbol, not a market input.
  // Outside Sample data mode they must be ABSENT: suppress every numeric target
  // (stat cells, the implied-move hero, per-row $ targets) and fall back to the
  // honest outlet-links + lookup-a-real-symbol path. Real-sample-mode is unchanged.
  // Matches status:"sample" AND any sample-tagged-row coverage (a polluted cache).
  const suppressSampleNumbers = !sampleMode && isSampleAnalystCoverage(coverage);

  // The "All sources" grid renders each row's `source` verbatim - including the
  // literal "Sample consensus" label - so suppressing only the NUMBERS still
  // leaks the sample TEXT in live mode. Drop sample-tagged rows entirely outside
  // Sample data mode; the honest outlet links (origin "link") remain.
  const visibleRows = (coverage?.rows ?? []).filter(
    (r) => sampleMode || r.isSample !== true,
  );

  const statCells: Array<{ label: string; value: string; tone?: "up" | "down" }> = [];
  if (!suppressSampleNumbers) {
    if (mean != null) statCells.push({ label: "Average (mean)", value: formatPrice(mean), tone: up != null && up >= 0 ? "up" : "down" });
    if (median != null) statCells.push({ label: "Median", value: formatPrice(median) });
    if (high != null) statCells.push({ label: "High target", value: formatPrice(high) });
    if (low != null) statCells.push({ label: "Low target", value: formatPrice(low) });
    if (spread != null) statCells.push({ label: "Range (spread)", value: formatPrice(spread) });
    if (analysts > 0) statCells.push({ label: "Analysts rated", value: String(analysts) });
  }
  if (spot > 0) statCells.push({ label: "Spot price", value: formatPrice(spot) });

  return (
    <section className="price-targets" aria-label="Analyst price targets">
      <div className="section-title">Analyst Price Targets</div>

      {loading && <PriceTargetsSkeleton />}

      {!loading && coverage?.status === "sample" && (
        <p className="lookup-banner">
          {sampleMode ? (
            <>
              Illustrative sample targets for <strong>{ticker}</strong>. Add your Finnhub key in{" "}
              <code className="env-code">.env</code> and restart, or lookup a real symbol (e.g. AAPL)
              for live street data.
            </>
          ) : (
            <>
              No live analyst consensus on file for <strong>{ticker}</strong>. Use the outlet cards
              below, or look up a real symbol (e.g. AAPL) for live consensus.
            </>
          )}
        </p>
      )}

      {!loading && coverage?.status === "estimated" && (
        <p className="lookup-banner lookup-banner--curated">
          Finnhub street <strong>price targets</strong> need a paid tier on this key. Targets below are{" "}
          <strong>estimated from live buy/hold/sell counts</strong> — use outlet links for published ranges.
        </p>
      )}

      {!loading && coverage?.status === "links_only" && (
        <p className="text-muted price-targets__status-note">
          {isFinnhubConfigured() ? (
            <>No analyst ratings or consensus on file for {ticker}. Use the outlet cards below.</>
          ) : (
            <>
              Paste your key into <code className="env-code">.env</code> as{" "}
              <code className="env-code">VITE_FINNHUB_API_KEY</code>, then restart the app.
            </>
          )}
        </p>
      )}

      {!loading && statCells.length > 0 && (
        <div className="price-targets__stats">
          {statCells.map((cell) => (
            <div key={cell.label} className="price-targets__stat">
              <div className="price-targets__stat-label">{cell.label}</div>
              <div
                className={`price-targets__stat-value mono ${cell.tone === "up" ? "change--up" : cell.tone === "down" ? "change--down" : ""}`}
              >
                {cell.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !suppressSampleNumbers && mean != null && spot > 0 && up != null && (
        <div className="price-targets__hero">
          <div className="text-faint price-targets__eyebrow">
            Implied move to consensus mean
          </div>
          <div className={`price-targets__upside ${up >= 0 ? "change--up" : "change--down"}`}>
            {formatPct(up)} ({formatPrice(mean)} vs {formatPrice(spot)} spot)
          </div>
          {consensus?.updatedAt && (
            <span className="text-faint price-targets__updated">
              Consensus updated {consensus.updatedAt}
            </span>
          )}
        </div>
      )}

      {!suppressSampleNumbers && coverage?.recommendations && analysts > 0 && (
        <div className="price-targets__recs">
          <div className="text-faint price-targets__eyebrow">
            Rating breakdown · {analysts} analysts
            {coverage.recommendations.period ? ` · ${coverage.recommendations.period}` : ""}
          </div>
          <div className="price-targets__rec-bars">
            {(
              [
                ["Strong buy", coverage.recommendations.strongBuy, "price-targets__rec-fill--strong-buy"],
                ["Buy", coverage.recommendations.buy, "price-targets__rec-fill--buy"],
                ["Hold", coverage.recommendations.hold, "price-targets__rec-fill--hold"],
                ["Sell", coverage.recommendations.sell, "price-targets__rec-fill--sell"],
                ["Strong sell", coverage.recommendations.strongSell, "price-targets__rec-fill--strong-sell"],
              ] as const
            ).map(([label, count, colorClass]) => (
              <div key={label} className="price-targets__rec-row">
                <span className="price-targets__rec-label">{label}</span>
                <div className="price-targets__rec-track">
                  <div
                    className={`price-targets__rec-fill ${colorClass}`}
                    style={{ width: `${analysts > 0 ? Math.min(100, (count / analysts) * 100) : 0}%` }}
                  />
                </div>
                <span className="mono price-targets__rec-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && coverage && visibleRows.length > 0 && (
        <>
          <div className="text-faint price-targets__eyebrow price-targets__sources-heading">
            All sources ({visibleRows.length})
          </div>
          <div className="price-targets__grid">
            {visibleRows.map((row) => (
              <ExternalLink
                key={`${row.source}-${row.label}-${row.target ?? "link"}`}
                href={row.url}
                className="price-targets__card"
              >
                <div className="price-targets__card-source">{row.source}</div>
                <div className="price-targets__card-label">{row.label}</div>
                {!suppressSampleNumbers && row.target != null && (
                  <div className="price-targets__card-pt mono">{formatPrice(row.target)}</div>
                )}
                {!suppressSampleNumbers &&
                  row.targetHigh != null &&
                  row.targetLow != null &&
                  row.target == null && (
                    <div className="price-targets__card-pt price-targets__card-pt--range mono text-faint">
                      {formatPrice(row.targetLow)} – {formatPrice(row.targetHigh)}
                    </div>
                  )}
                <span className="price-targets__card-go text-faint">
                  Open
                  <IconExternal size={12} />
                </span>
                {row.isSample && sampleMode && (
                  <span className="price-targets__sample-pill">Sample</span>
                )}
              </ExternalLink>
            ))}
          </div>
        </>
      )}

      <p className="text-faint price-targets__fineprint">
        Third-party analyst pages are for research only — not buy/sell recommendations from Catalyzed Alpha.
      </p>
    </section>
  );
}
