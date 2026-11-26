import type { CompanyData, PortfolioQuote, Sector } from "@/types";
import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { finnhubKey, httpJson } from "@/data/http";
import { finnhubSymbolUrl } from "@/lib/analystLinks";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import {
  unknownRisk,
  unknownSocial,
  unknownVolatility,
} from "@/data/fundamentals/unknownNonFundamentals";
import { noCatalyst } from "@/data/catalysts/catalystState";
import { getSymbol } from "@/data/symbols/symbolDirectory";
import { isPlausibleMarketCap } from "@/lib/format";
import { resolveSector } from "@/data/symbols/sectorOverrides";
import {
  allFalseFundamentalsAvailability,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";

const FINNHUB = "https://finnhub.io/api/v1";

interface FinnhubQuote {
  c: number;
  d: number;
  dp: number;
  pc: number;
}

interface FinnhubProfile {
  name?: string;
  marketCapitalization?: number;
  finnhubIndustry?: string;
  exchange?: string;
  ticker?: string;
  /** Reporting currency of `marketCapitalization` - NOT always USD. */
  currency?: string;
}

const INDUSTRY_TO_SECTOR: Record<string, Sector> = {
  technology: "Technology",
  software: "Technology",
  semiconductor: "Technology",
  automobile: "Consumer",
  consumer: "Consumer",
  retail: "Consumer",
  bank: "Financials",
  financial: "Financials",
  insurance: "Financials",
  health: "Healthcare",
  pharmaceutical: "Healthcare",
  biotech: "Healthcare",
  oil: "Energy",
  energy: "Energy",
  industrial: "Industrials",
  telecom: "Communications",
  media: "Communications",
  material: "Materials",
  utility: "Utilities",
  reit: "Real Estate",
};

function sectorFromIndustry(ticker: string, industry?: string): Sector {
  let fallback: Sector = "Technology";
  if (industry) {
    const lower = industry.toLowerCase();
    for (const [needle, sector] of Object.entries(INDUSTRY_TO_SECTOR)) {
      if (lower.includes(needle)) {
        fallback = sector;
        break;
      }
    }
  }
  // A curated override wins over the raw industry-substring match - see
  // sectorOverrides.ts for why (sector-neutralization integrity; some names'
  // finnhubIndustry string misses every needle above and silently falls back
  // to "Technology", e.g. CRSP/TNYA/EVMN/PCT/JOBY).
  return resolveSector(ticker, fallback);
}

function anchorSeriesToSpot(series: CompanyData["priceSeries"], spot: number): CompanyData["priceSeries"] {
  if (series.length === 0) return series;
  const last = series[series.length - 1]!.close;
  if (last === spot) return series;
  const scale = last > 0 ? spot / last : 1;
  return series.map((p) => ({ ...p, close: Number((p.close * scale).toFixed(p.close < 5 ? 3 : 2)) }));
}

/** Lightweight live quote used to refresh many portfolio positions without profile/news requests. */
export async function fetchFinnhubPortfolioQuote(symbol: string): Promise<PortfolioQuote | null> {
  const key = finnhubKey();
  const ticker = symbol.trim().toUpperCase();
  if (!key || !ticker) return null;

  try {
    const quote = await httpJson<FinnhubQuote>(
      `${FINNHUB}/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`,
    );
    if (!quote.c || quote.c <= 0) return null;
    return {
      ticker,
      price: Number(quote.c.toFixed(quote.c < 5 ? 3 : 2)),
      dayChange: Number.isFinite(quote.dp) ? quote.dp / 100 : 0,
      updatedAt: new Date().toISOString(),
      // Fetched on demand, so the data is as-of now during a live fetch; the session
      // gate downgrades it to "at close" wording outside regular hours regardless.
      asOf: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Build company inputs from Finnhub quote + profile when a key is configured.
 * Momentum / social / catalyst remain modeled; spot price and name are live.
 */
export async function fetchFinnhubCompany(symbol: string): Promise<CompanyData | null> {
  const key = finnhubKey();
  if (!key) return null;

  const ticker = symbol.trim().toUpperCase();
  if (!ticker) return null;

  try {
    const [quote, profile] = await Promise.all([
      httpJson<FinnhubQuote>(
        `${FINNHUB}/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`,
        { timeoutMs: 10_000 },
      ),
      httpJson<FinnhubProfile>(
        `${FINNHUB}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`,
        { timeoutMs: 10_000 },
      ),
    ]);

    if (!quote.c || quote.c <= 0) return null;

    const synthetic = buildSyntheticCompany(ticker);
    const dayChange = Number.isFinite(quote.dp) ? quote.dp / 100 : synthetic.dayChange;
    const return1M = quote.pc > 0 ? (quote.c - quote.pc) / quote.pc : synthetic.momentum.return1M;
    const priceSeries = anchorSeriesToSpot(
      genPriceSeries(ticker, quote.c, return1M, synthetic.volatility.atrPct),
      quote.c,
    );
    // Finnhub reports market cap in MILLIONS **of the listing currency**, which is
    // NOT always USD. SK Hynix (SKHY) comes back as 1,163,269,303 million KRW; the
    // old code multiplied that by 1e6 and compared the result against USD
    // thresholds, producing a nonsense ~$1.16 QUADRILLION cap. The plausibility
    // guard correctly rejected it - and then the name fell through to cap 0
    // ("Unknown"), where the screen's cap gate deliberately does NOT bury unknowns.
    // Net effect: every foreign-listed / ADR name silently ignored the user's
    // market-cap filter, which is why filtering out small caps still surfaced a
    // $1.26T Korean chipmaker.
    //
    // So: only trust Finnhub's cap when it is actually denominated in USD. A
    // non-USD cap is DISCARDED here rather than converted - we have no FX rate at
    // this layer, and a wrong number is worse than a missing one. The fundamentals
    // enrichment pass fills these from FMP's `/stable/profile`, which reports the
    // ADR's cap in USD ($1.256T for SKHY, bucketing correctly as "Mega").
    const capCurrency = profile.currency?.trim().toUpperCase();
    const capIsUsd = !capCurrency || capCurrency === "USD";
    const liveCap =
      capIsUsd && profile.marketCapitalization && profile.marketCapitalization > 0
        ? profile.marketCapitalization * 1_000_000
        : 0;
    const marketCap = isPlausibleMarketCap(liveCap) ? liveCap : 0;

    return {
      ...synthetic,
      ticker,
      // Prefer the live profile name, then the offline directory's real listed
      // name, before any synthetic placeholder.
      name: profile.name?.trim() || getSymbol(ticker)?.name || synthetic.name.replace(" (sample)", ""),
      sector: sectorFromIndustry(ticker, profile.finnhubIndustry),
      // Keep the finer industry label (discarded before) so the company blurb can
      // be specific ("a semiconductor company") rather than just the broad sector.
      finnhubIndustry: profile.finnhubIndustry?.trim() || undefined,
      price: Number(quote.c.toFixed(quote.c < 5 ? 3 : 2)),
      dayChange,
      marketCap,
      priceSeries,
      priceHistory: closesFromSeries(priceSeries),
      // A live-quoted record starts with NO real fundamentals: NEVER inherit the
      // synthetic PRNG seed (the SOFI "Unprofitable −19.8% net margin" bug). Every
      // field is a neutral placeholder gated OFF until the fundamentals-enrichment
      // stage layers in real, freshness-checked provider values + an as-of stamp.
      fundamentals: unknownFundamentals(),
      fundamentalsAvailability: allFalseFundamentalsAvailability(),
      // A live-quoted record starts with NO catalyst: NEVER inherit the synthetic
      // PRNG catalyst, and a catalyst is NEVER inferred from a news headline (the
      // ANET "Regulatory catalyst landing today" fabrication). Only a REAL
      // structured event (8-K / 13D-G / insider cluster / federal contract / FDA /
      // congress / newsletter) in the catalyst-events stage sets a genuine catalyst
      // and flips catalystLive true.
      catalyst: noCatalyst(),
      catalystLive: false,
      // A live-quoted record carries NO synthetic RISK, VOLATILITY or SOCIAL block.
      //
      // This spread starts from `synthetic`, whose every field is a deterministic
      // HASH OF THE TICKER STRING (see engine/syntheticTicker.ts). `fundamentals`
      // and `catalyst` were already guarded above after the SOFI and ANET
      // fabrications; `risk`, `volatility` and `social` were not, so the published
      // board shipped hash-derived numbers as live data for every name - Amazon at
      // 21.5% short interest, Meta at a 0.46 "dilution risk", NVIDIA on a 9.9-quarter
      // cash runway. Those fed a risk penalty worth up to 30 points, the archetype
      // quality floor, and the volatility/social dimensions, so a large part of the
      // ranking was being driven by ticker-name noise.
      //
      // Neutral placeholders instead: the enrichment stages layer in what is REAL
      // (volatility is recomputed from live Alpaca closes, free cash flow and
      // solvency from SEC XBRL, social from the live social lane), and anything
      // still missing scores an honest neutral rather than an invented number.
      risk: unknownRisk(),
      volatility: unknownVolatility(),
      social: unknownSocial(),
      socialPosts: [],
      sources: [
        {
          label: "Finnhub quote & profile",
          url: finnhubSymbolUrl(ticker),
          publishedAt: new Date().toISOString(),
        },
      ],
    };
  } catch {
    return null;
  }
}
