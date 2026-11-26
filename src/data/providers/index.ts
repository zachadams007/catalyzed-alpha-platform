import { MockDataProvider } from "./MockDataProvider";
import { FinnhubDataProvider } from "./FinnhubDataProvider";
import { FmpDataProvider } from "./FmpDataProvider";
import { HybridDataProvider } from "./HybridDataProvider";
import { DiscoveryDataProvider } from "./DiscoveryDataProvider";
import { FunnelDataProvider } from "./FunnelDataProvider";
import { LiveProviderStub } from "./LiveProviderStub";
import {
  isFinnhubConfigured,
  isFmpConfigured,
  isFmpKeyPresent,
  isResearchProxyConfigured,
} from "@/data/http";
import { isApiAccessPaused } from "@/lib/apiUsage";
import {
  getSampleDataModeState,
  isSampleDataModeEnabled,
  isSampleDataModePending,
  setSampleDataModeEnabled,
  subscribeSampleDataMode,
  SAMPLE_DATA_MODE_STORAGE_KEY,
} from "./sampleDataMode";
import type { DataProvider, ProviderInfo } from "./types";

export type { DataProvider, ProviderInfo } from "./types";
export {
  getSampleDataModeState,
  isSampleDataModeEnabled,
  isSampleDataModePending,
  setSampleDataModeEnabled,
  subscribeSampleDataMode,
  SAMPLE_DATA_MODE_STORAGE_KEY,
};

/**
 * Provider registry + selector.
 *
 * The active provider is chosen by VITE_DATA_PROVIDER. When it is unset we
 * auto-pick the broadest configured live provider so the app doesn't silently
 * show fictional sample tickers when a key is present.
 */
const REGISTRY: Record<string, () => DataProvider> = {
  mock: () => new MockDataProvider(),
  funnel: () =>
    isFmpConfigured()
      ? new FunnelDataProvider()
      : new LiveProviderStub("funnel", "Full-Market Funnel", "VITE_FMP_API_KEY"),
  discovery: () =>
    isResearchProxyConfigured() && isFinnhubConfigured()
      ? new DiscoveryDataProvider()
      : new LiveProviderStub(
          "discovery",
          "AI Niche Discovery",
          "VITE_RESEARCH_PROXY_URL + VITE_FINNHUB_API_KEY",
        ),
  hybrid: () =>
    isFinnhubConfigured() && isFmpConfigured()
      ? new HybridDataProvider()
      : new LiveProviderStub("hybrid", "Hybrid Live Universe", "VITE_FINNHUB_API_KEY + VITE_FMP_API_KEY"),
  finnhub: () =>
    isFinnhubConfigured()
      ? new FinnhubDataProvider()
      : new LiveProviderStub("finnhub", "Finnhub", "VITE_FINNHUB_API_KEY"),
  fmp: () =>
    isFmpConfigured()
      ? new FmpDataProvider()
      : new LiveProviderStub("fmp", "Financial Modeling Prep", "VITE_FMP_API_KEY"),
  alphavantage: () =>
    new LiveProviderStub("alphavantage", "Alpha Vantage", "VITE_ALPHAVANTAGE_API_KEY"),
  polygon: () => new LiveProviderStub("polygon", "Polygon.io", "VITE_POLYGON_API_KEY"),
};

/**
 * Provider id we'll actually use.
 *
 * The device-local Sample data mode takes priority over environment settings.
 * Otherwise honors an explicit `VITE_DATA_PROVIDER` (including `mock` as a
 * deliberate sample opt-in), then auto-picks the broadest configured live
 * provider. Returns `null` when nothing real is configured so sample data is
 * never presented as live by accident.
 *
 * Coverage breadth is FUNCTIONALITY, not an A/B experiment: the full-market
 * funnel is the DEFAULT live universe whenever FMP is configured, independent of
 * the engine variant. Champion and challenger therefore see the SAME wide
 * universe and differ only in the downstream scoring pass (see
 * `src/engine/challenger.ts`). The narrower `hybrid`/`fmp` universes remain
 * available only by explicit `VITE_DATA_PROVIDER` opt-in.
 */
export function resolveProviderId(): string | null {
  // Fail CLOSED to a loading state, never to the fictional sample universe. While
  // the operator's GLOBAL sample/live choice is still resolving (configured but no
  // `app_controls` row cached yet - first fetch in flight or failed), we resolve
  // to `null` ("loading"). Feeds/heatmap render a skeleton, no Live badge shows,
  // and the MockDataProvider's `MOCK_UNIVERSE` is NEVER served under a Live badge.
  // The sample universe is served ONLY when sample mode is EXPLICITLY on AND the
  // controls have actually loaded (so it's the operator's real intent, not a
  // pre-load default). See `isProviderResolutionPending`.
  if (isProviderResolutionPending()) return null;
  if (isSampleDataModeEnabled()) return "mock";
  const requested = (import.meta.env.VITE_DATA_PROVIDER as string | undefined)?.trim();
  const discoveryReady = isResearchProxyConfigured() && isFinnhubConfigured();
  if (requested === "mock") return "mock"; // explicit sample opt-in
  if (requested === "funnel" && isFmpConfigured()) return "funnel";
  if (requested === "discovery" && discoveryReady) return "discovery";
  if (requested === "hybrid" && isFinnhubConfigured() && isFmpConfigured()) return "hybrid";
  if (requested === "finnhub" && isFinnhubConfigured()) return "finnhub";
  if (requested === "fmp" && isFmpConfigured()) return "fmp";
  // Auto-pick the broadest configured live universe. The full-market funnel
  // (the "wider net") is the default coverage path - it sweeps the whole market
  // each run - so it wins whenever FMP is configured, for champion and
  // challenger alike. Falls back to AI niche discovery, then a single vendor.
  if (isFmpConfigured()) return "funnel";
  if (discoveryReady) return "discovery";
  if (isFinnhubConfigured()) return "finnhub";
  return null;
}

/**
 * The provider can't be resolved yet because the operator's GLOBAL sample/live
 * choice is still loading (configured but no `app_controls` row cached). The app
 * must show a skeleton / "loading" state and must NOT auto-run research or render
 * any universe (mock OR live) until this clears. Distinct from
 * `isDataSourceConfigured() === false`, which means nothing is configured at all.
 */
export function isProviderResolutionPending(): boolean {
  return isSampleDataModePending();
}

/** True when a data source (live key, or explicit sample opt-in) is available. */
export function isDataSourceConfigured(): boolean {
  return !isProviderResolutionPending() && resolveProviderId() !== null;
}

/** True when the active provider can run without violating the API kill switch. */
export function isResearchRunAllowed(): boolean {
  const id = resolveProviderId();
  return id === "mock" || (id !== null && !isApiAccessPaused());
}

export function getActiveProvider(): DataProvider {
  const id = resolveProviderId();
  if (!id) {
    throw new Error(
      "No data source configured. Add VITE_FINNHUB_API_KEY or VITE_FMP_API_KEY (or set VITE_DATA_PROVIDER=mock for the sample universe).",
    );
  }
  return (REGISTRY[id] ?? REGISTRY.mock)();
}

/** True when the resolved provider serves real market data (not the sample set). */
export function isLiveDataActive(): boolean {
  if (isApiAccessPaused()) return false;
  const id = resolveProviderId();
  return (
    id === "finnhub" || id === "fmp" || id === "hybrid" || id === "discovery" || id === "funnel"
  );
}

/**
 * Whether the FULL-MARKET FUNNEL can actually run its live screener sweep.
 *
 * The funnel's Stage-0b sweep hits FMP's `/stock-screener` endpoint, which is a
 * PAID-TIER FMP capability. It is genuinely reachable only with a real local FMP
 * key (desktop `.env` / `npm run dev`) hitting FMP directly. On the KEYLESS web
 * build the proxy injects a placeholder so `isFmpConfigured()` is true and the
 * funnel is *selected* - but the screener endpoint isn't available on the
 * free/proxied path, so the sweep returns 0 rows and the funnel throws
 * "produced no candidates". That throw is what spammed the console on web boot.
 *
 * So: the funnel is only VIABLE when a real local FMP key is present. On a
 * keyless web build this is false, and the scheduled research path must rely on
 * the cloud `daily_signals` cache (the real pre-market scan the feed already
 * uses) instead of running the live funnel. Desktop / a real key is unchanged -
 * the live funnel keeps running there. Sample mode forces it off.
 */
export function isLiveFunnelViable(): boolean {
  if (isSampleDataModeEnabled()) return false;
  if (resolveProviderId() !== "funnel") return false;
  return isFmpKeyPresent();
}

export function listProviders(): ProviderInfo[] {
  return Object.values(REGISTRY).map((factory) => {
    const p = factory();
    return { id: p.id, name: p.name, isLive: p.isLive };
  });
}
