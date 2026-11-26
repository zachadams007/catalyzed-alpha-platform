import {
  isLiveDataActive,
  isSampleDataModeEnabled,
  resolveProviderId,
} from "@/data/providers";
import { isMarketProxyConfigured } from "@/data/marketProxy";

/**
 * Tells the user whether Blueprint is screening real market data or the
 * fictional sample universe, and how to switch on live data.
 */
export function DataModeBanner() {
  const live = isLiveDataActive();
  const sampleDataMode = isSampleDataModeEnabled();
  const providerId = resolveProviderId();

  if (live) {
    const label =
      providerId === "funnel"
        ? "Full-market funnel"
        : providerId === "hybrid"
          ? "Hybrid live universe"
          : providerId === "fmp"
            ? "Financial Modeling Prep"
            : "Finnhub";
    const detail =
      providerId === "funnel"
        ? "The whole US market is screened to a budget-derived top set each scan, then scored. Scan Market to refresh the scored universe."
        : providerId === "hybrid"
          ? "Finnhub core + FMP screener + AI web discovery feed one Blueprint ranking. Scan Market to refresh the scored universe."
          : `${label}. Scan Market to refresh the scored universe.`;

    return (
      <div className="data-mode-banner data-mode-banner--live" role="status">
        <span className="data-mode-banner__dot" aria-hidden />
        <div>
          <strong>Live market data</strong>
          <span className="data-mode-banner__detail">{detail}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="data-mode-banner data-mode-banner--sample" role="status">
      <span className="data-mode-banner__dot" aria-hidden />
      <div>
        <strong>Sample data</strong>
        <span className="data-mode-banner__detail">
          {sampleDataMode ? (
            <>
              No live market-data or research API calls can fire. Turn off Sample data mode in the
              Operator Console to restore the configured live provider.
            </>
          ) : isMarketProxyConfigured() ? (
            <>
              Live data is paused right now. An operator can switch it back on in the Operator
              Console — nothing to set up on your end.
            </>
          ) : (
            <>
              Tickers here are fictional demo names. Add{" "}
              <code className="env-code">VITE_FINNHUB_API_KEY</code> or{" "}
              <code className="env-code">VITE_FMP_API_KEY</code> to{" "}
              <code className="env-code">.env</code>, then Scan Market for real stocks and analyst
              targets.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
