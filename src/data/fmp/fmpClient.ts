/**
 * Financial Modeling Prep (FMP) client.
 *
 * Real, sanctioned API. The key is read from VITE_FMP_API_KEY and is bundled
 * into the desktop app (treat as public - free tier only). For paid/secret
 * tiers, proxy these calls server-side (see docs/data-sources.md).
 *
 * ── API GENERATION (migrated 2026-09-03) ──────────────────────────────────
 * FMP RETIRED the legacy `/api/v3` + `/api/v4` endpoints on 2025-08-31. They
 * now answer every request with HTTP 403 "Legacy Endpoint : ... only available
 * for legacy users who have valid subscriptions prior August 31, 2025". That
 * single fact caused ~99% of this app's daily API failures (2,008 of 2,024 FMP
 * calls) and made the Terminal's earnings pane silently render "No reports
 * scheduled" instead of real rows.
 *
 * Everything here therefore targets `/stable`, which takes the ticker as a
 * `?symbol=` QUERY PARAM instead of the old `/path/SYMBOL` style, and which
 * renamed several response fields. The interfaces below carry the STABLE names
 * first and keep the legacy aliases as optional extras, so a grandfathered
 * legacy subscription still resolves through the same readers.
 *
 * Verified in-plan on this key (free tier): quote · profile · ratios-ttm ·
 * key-metrics-ttm · financial-growth · income-statement · cash-flow-statement ·
 * price-target-consensus · grades-consensus · analyst-estimates ·
 * earnings-calendar · most-actives · biggest-gainers · biggest-losers.
 * Verified NOT in plan (HTTP 402): company-screener · news/stock · stock-list ·
 * batch-quote-short - those are tripped off after one failure, not retried per
 * ticker forever.
 */
import {
  httpJson,
  isPlanBlocked,
  isPlanBlockedSymbol,
  nextFmpKey,
  notePlanBlocked,
  notePlanBlockedSymbol,
} from "@/data/http";

const FMP = "https://financialmodelingprep.com/stable";

export interface FmpQuote {
  symbol: string;
  name?: string;
  price?: number;
  /** `/stable` name. */
  changePercentage?: number;
  /** Legacy `/api/v3` alias - kept for grandfathered keys. */
  changesPercentage?: number;
  marketCap?: number;
  sector?: string;
  exchange?: string;
  volume?: number;
  avgVolume?: number;
}

export interface FmpProfile {
  symbol: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  price?: number;
  beta?: number;
  /** `/stable` names. */
  marketCap?: number;
  averageVolume?: number;
  /** Legacy `/api/v3` aliases. */
  mktCap?: number;
  volAvg?: number;
}

export interface FmpRatios {
  grossProfitMarginTTM?: number;
  netProfitMarginTTM?: number;
  /** `/stable` names. */
  priceToEarningsRatioTTM?: number;
  priceToEarningsGrowthRatioTTM?: number;
  debtToEquityRatioTTM?: number;
  /** Legacy `/api/v3` aliases. */
  peRatioTTM?: number;
  priceEarningsToGrowthRatioTTM?: number;
  debtEquityRatioTTM?: number;
}

export interface FmpFinancialGrowth {
  revenueGrowth?: number;
  grossProfitGrowth?: number;
  netIncomeGrowth?: number;
  epsgrowth?: number;
  epsdilutedGrowth?: number;
  freeCashFlowGrowth?: number;
  operatingCashFlowGrowth?: number;
}

export interface FmpIncomeStatement {
  revenue?: number;
  grossProfit?: number;
  netIncome?: number;
  eps?: number;
  /** `/stable` name. */
  epsDiluted?: number;
  /** Legacy `/api/v3` alias. */
  epsdiluted?: number;
}

export interface FmpCashFlowStatement {
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  freeCashFlow?: number;
}

export interface FmpPriceTargetConsensus {
  symbol?: string;
  targetHigh?: number;
  targetLow?: number;
  targetConsensus?: number;
  targetMedian?: number;
}

export interface FmpScreenerRow {
  symbol: string;
  companyName?: string;
  marketCap?: number;
  sector?: string;
  price?: number;
  beta?: number;
  volume?: number;
  exchangeShortName?: string;
  isActivelyTrading?: boolean;
}

/**
 * Build a `/stable` URL. Unlike the legacy client the symbol is a QUERY PARAM,
 * never a path segment - `/stable/quote?symbol=AAPL`, not `/quote/AAPL`.
 */
function stableUrl(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): string | null {
  const key = nextFmpKey();
  if (!key) return null;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") usp.set(k, String(v));
  }
  usp.set("apikey", key);
  return `${FMP}${path}?${usp.toString()}`;
}

/**
 * GET an array endpoint. A 402/403 means "your plan does not include this
 * endpoint" - a PERMANENT condition for this key, so the endpoint is tripped
 * off for the rest of the session instead of re-failing once per scanned
 * ticker. Every caller already degrades on an empty array.
 */
async function getArray<T>(path: string, url: string | null, symbol?: string): Promise<T[]> {
  if (!url) return [];
  if (isPlanBlocked("fmp", path)) return [];
  if (symbol && isPlanBlockedSymbol("fmp", symbol)) return [];
  try {
    const res = await httpJson<T[] | { "Error Message"?: string }>(url);
    return Array.isArray(res) ? res : [];
  } catch (err) {
    const e = err as { status?: number; body?: string };
    if (e?.status === 402 || e?.status === 403) {
      // The BODY decides the scope. FMP answers 402 both for "this endpoint is
      // not in your plan" (disable the endpoint) and for "this ticker is
      // premium" (disable just that ticker) - conflating them would take the
      // whole /quote lane down because two mid-caps are gated.
      notePlanBlocked("fmp", path, e.status, e.body ?? "");
      if (symbol) notePlanBlockedSymbol("fmp", symbol, e.body ?? "");
    }
    return [];
  }
}

export async function fmpQuote(symbol: string): Promise<FmpQuote | null> {
  const rows = await getArray<FmpQuote>("/quote", stableUrl("/quote", { symbol }), symbol);
  return rows[0] ?? null;
}

export async function fmpProfile(symbol: string): Promise<FmpProfile | null> {
  const rows = await getArray<FmpProfile>("/profile", stableUrl("/profile", { symbol }), symbol);
  return rows[0] ?? null;
}

export async function fmpRatios(symbol: string): Promise<FmpRatios | null> {
  const rows = await getArray<FmpRatios>("/ratios-ttm", stableUrl("/ratios-ttm", { symbol }), symbol);
  return rows[0] ?? null;
}

export async function fmpFinancialGrowth(symbol: string): Promise<FmpFinancialGrowth | null> {
  const rows = await getArray<FmpFinancialGrowth>(
    "/financial-growth",
    stableUrl("/financial-growth", { symbol, period: "annual", limit: 2 }),
    symbol,
  );
  return rows[0] ?? null;
}

export async function fmpIncomeStatement(symbol: string): Promise<FmpIncomeStatement | null> {
  const rows = await getArray<FmpIncomeStatement>(
    "/income-statement",
    stableUrl("/income-statement", { symbol, period: "annual", limit: 2 }),
    symbol,
  );
  return rows[0] ?? null;
}

export async function fmpCashFlowStatement(symbol: string): Promise<FmpCashFlowStatement | null> {
  const rows = await getArray<FmpCashFlowStatement>(
    "/cash-flow-statement",
    stableUrl("/cash-flow-statement", { symbol, period: "annual", limit: 2 }),
    symbol,
  );
  return rows[0] ?? null;
}

export async function fmpPriceTargetConsensus(
  symbol: string,
): Promise<FmpPriceTargetConsensus | null> {
  const rows = await getArray<FmpPriceTargetConsensus>(
    "/price-target-consensus",
    stableUrl("/price-target-consensus", { symbol }),
    symbol,
  );
  return rows[0] ?? null;
}

export interface FmpScreenerParams {
  marketCapMoreThan?: number;
  marketCapLowerThan?: number;
  sector?: string;
  betaMoreThan?: number;
  volumeMoreThan?: number;
  limit?: number;
  exchange?: string;
  isActivelyTrading?: boolean;
}

/**
 * Discover niche names dynamically via the FMP company screener.
 *
 * NOTE: `/stable/company-screener` is a PAID endpoint - this key's plan answers
 * 402. `getArray` trips it off after the first 402, so a screener sweep costs
 * one failed call per session rather than one per sweep. Paid keys keep the
 * full behaviour unchanged.
 */
export async function fmpScreener(params: FmpScreenerParams): Promise<FmpScreenerRow[]> {
  const rows = await getArray<FmpScreenerRow>(
    "/company-screener",
    stableUrl("/company-screener", {
      marketCapMoreThan: params.marketCapMoreThan,
      marketCapLowerThan: params.marketCapLowerThan,
      sector: params.sector,
      betaMoreThan: params.betaMoreThan,
      volumeMoreThan: params.volumeMoreThan,
      limit: params.limit ?? 40,
      exchange: params.exchange ?? "NASDAQ,NYSE,AMEX",
      isActivelyTrading: params.isActivelyTrading ? "true" : undefined,
    }),
  );
  return rows.filter((r) => r.symbol && (r.isActivelyTrading ?? true));
}

/** True while the screener lane is still believed to be inside this key's plan. */
export function isFmpScreenerAvailable(): boolean {
  return !isPlanBlocked("fmp", "/company-screener");
}
