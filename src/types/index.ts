/**
 * Core domain types for Catalyzed Alpha.
 *
 * The data flows in one direction:
 *   CompanyData (raw, from a DataProvider)
 *     -> scoring engine
 *       -> StockSignal (enriched, scored, display-ready)
 *
 * Keeping the raw inputs separate from the scored output keeps the scoring
 * engine pure and makes it trivial to swap the MockDataProvider for a real
 * market-data provider later (see src/data/providers).
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

export type Sector =
  | "Technology"
  | "Healthcare"
  | "Financials"
  | "Energy"
  | "Consumer"
  | "Industrials"
  | "Communications"
  | "Materials"
  | "Utilities"
  | "Real Estate";

// "Unknown" is a first-class bucket for a missing/zero/garbage market cap. It must
// NEVER be silently folded into "Nano" - a megacap (e.g. NVDA) whose live cap field
// failed to populate would then match a small/nano-cap screener filter and surface
// as a tiny name. Unknown matches no size filter; surfaces render it explicitly.
export type MarketCapBucket = "Nano" | "Micro" | "Small" | "Mid" | "Large" | "Mega" | "Unknown";

export type RiskLevel = "Low" | "Moderate" | "Elevated" | "High" | "Extreme";

export type CatalystType =
  | "Earnings"
  | "Product"
  | "M&A"
  | "Regulatory"
  | "Political"
  | "Macro"
  | "Technical"
  | "Insider"
  | "Partnership"
  | "Clinical"
  | "Institutional"
  // Honest "no dated catalyst" - a name with no REAL structured catalyst event.
  // Never inferred from a news headline. magnitude 0 + catalystLive:false, so it
  // scores ~0 on the catalyst dimension and the UI hides the catalyst chip.
  | "None";

/** The personalization signals a user can emit from a card. */
export type InteractionKind =
  | "like"
  | "more_like_this"
  | "less_like_this"
  | "higher_market_cap"
  | "lower_market_cap"
  | "more_sector"
  | "less_sector"
  | "more_catalyst_driven"
  | "more_fundamentals_driven"
  | "shorter_horizon"
  | "longer_horizon"
  | "add_to_portfolio"
  | "share"
  | "save_watchlist"
  | "view_detail";

/** Holding style / time horizon (standard trading terms). */
export type TradeHorizon = "scalping" | "day_trading" | "swing_trading" | "position_trading";

export const TRADE_HORIZON_LABELS: Record<TradeHorizon, string> = {
  scalping: "Scalping",
  day_trading: "Day trading",
  swing_trading: "Swing trading",
  position_trading: "Position trading",
};

/** Compact labels for chips/tiles (e.g. the per-signal time-scale pill). */
export const TRADE_HORIZON_SHORT: Record<TradeHorizon, string> = {
  scalping: "Scalp",
  day_trading: "Day trade",
  swing_trading: "Swing",
  position_trading: "Position",
};

export const TRADE_HORIZON_HINTS: Record<TradeHorizon, string> = {
  scalping: "Ultra-short — biases volatile, liquid names (not a scalp terminal)",
  day_trading: "Intraday — catalyst & news timing",
  swing_trading: "Days to weeks — momentum & setup",
  position_trading: "Weeks to months — quality, growth & structure",
};

/**
 * How the Blueprint screener orders results. Each mode isolates one lane of the
 * fit model except `blended`, which fuses them. The engine always reports every
 * lane (see {@link ScreenFitComponents}) so the active mode only changes the
 * ordering, never what's explainable.
 *
 * Collapsed from 5 modes to 3 (owner request 2026-06-20 - the extra two pills were
 * confusing). `theme` and `ai_description` were never full standalone
 * concepts: their lanes (`components.theme`, `components.description`)
 * already feed `blended`'s fused score, so removing them as distinct ranking
 * pills loses no reachable behavior - a user who wants theme-led or
 * description-led ranking gets there via `blended` (optionally raising
 * `narrativeWeight`), which already weights theme + description explicitly.
 *
 * - `fundamentals` - quality only (fundamentals, growth, entry value, liquidity).
 * - `blended` - description + structured filters + fundamentals fused (default).
 * - `ai` - AI research-agent relevance (offline: a description+theme proxy).
 */
export type RankingMode = "fundamentals" | "blended" | "ai";

export const RANKING_MODE_LABELS: Record<RankingMode, string> = {
  fundamentals: "Fundamentals only",
  blended: "Blended",
  ai: "AI only",
};

export const RANKING_MODE_HINTS: Record<RankingMode, string> = {
  fundamentals:
    "Pure quality — fundamentals, growth, and entry value. Ignores narrative, theme, and hype.",
  blended: "Fuses your description, the structured filters, and fundamentals into one ranking.",
  ai: "Auto-runs a web deep-search and ranks by the AI research agent's relevance to your thesis (offline: a local description + theme match).",
};

/** Filters for Blueprint screening and portfolio discovery (pure-engine input). */
export interface ScreenCriteria {
  /** How results are ordered. Defaults to `blended` when unset. */
  rankingMode?: RankingMode;
  sectors?: Sector[];
  capBuckets?: MarketCapBucket[];
  catalystTypes?: CatalystType[];
  riskLevels?: RiskLevel[];
  /** Curated theme tag ids - see `src/constants/screenThemes.ts`. */
  themeTags?: string[];
  minOpportunityScore?: number;
  minConfidence?: number;
  /** Min YoY revenue growth as ratio (0.25 = +25%). */
  minRevenueGrowth?: number;
  /** Min YoY EPS growth as ratio. */
  minEpsGrowth?: number;
  minGrossMargin?: number;
  minCategoryScores?: Partial<Record<ScoreCategoryKey, number>>;
  /** Parsed from the user's narrative description. */
  keywords?: string[];
  /** 0..100 - narrative + theme weight in fit score (default blended in engine). */
  narrativeWeight?: number;
  /** Boost news / social / catalyst attention in ranking. */
  preferHype?: boolean;
  minAvgDollarVolume?: number;
  maxShortInterestPct?: number;
  minPeRatio?: number;
  maxPeRatio?: number;
  requireAboveSMA50?: boolean;
  requireAboveSMA200?: boolean;
  minNewsArticles7d?: number;
  minSocialMentions24h?: number;
  /** Only catalysts within this many days (negative = already occurred). */
  maxDaysToCatalyst?: number;
  maxResults?: number;
}

/**
 * The per-lane fit a signal earned for a screen, each 0..100. The active
 * {@link RankingMode} decides how these fuse into `fitScore`, but ALL lanes are
 * always reported so the UI can explain exactly why a name ranked where it did.
 */
export interface ScreenFitComponents {
  /** Quality composite: fundamentals, growth, entry value, liquidity. */
  fundamentals: number;
  /** Curated theme-tag evidence match. */
  theme: number;
  /** Free-text narrative ("description") match. */
  description: number;
  /** Structured-filter satisfaction + horizon fit. */
  filters: number;
  /** News / social / catalyst attention. */
  hype: number;
  /** AI research-agent relevance, or `null` when no agent relevance is available. */
  ai: number | null;
}

export interface ScreenMatch {
  signal: StockSignal;
  /** 0..100 fit for this screen under the active ranking mode. */
  fitScore: number;
  reasons: string[];
  /** Which ranking mode produced this ordering. */
  mode: RankingMode;
  /** Per-lane fit breakdown (always populated) for "why ranked here" UI. */
  components: ScreenFitComponents;
  /**
   * True when the signal misses one or more ACTIVE hard filters. Weak matches
   * are demoted below full matches but never removed - screening is soft, so the
   * leaderboard always returns the best-fit names and is never empty when the
   * universe has any stocks.
   */
  weakMatch: boolean;
  /** The active gates this signal FAILED (empty when it passes them all). */
  failedGates: ScreenGateResult[];
  /** Active gates passed / total active gates (0 / 0 when no hard filters are set). */
  gatesPassed: number;
  gatesTotal: number;
}

/**
 * One hard-filter gate evaluated against one signal - produced by the SAME
 * logic the screener uses (`evaluateScreenGates` in `src/engine/screen.ts`),
 * so UI explanations of why a name passed/failed can never drift from the
 * engine. Only gates active in the criteria are emitted.
 */
export interface ScreenGateResult {
  /** Stable gate id, e.g. "sectors", "minOpportunityScore", "cat:growth". */
  key: string;
  /** Short human label, e.g. "Sector", "Min opportunity". */
  label: string;
  pass: boolean;
  /** The signal's actual value, human-readable (e.g. "Technology", "62", "N/A"). */
  actual: string;
  /** The requirement, human-readable (e.g. "≥ 70", "Healthcare or Energy"). */
  required: string;
  /**
   * True when the underlying datum is genuinely unavailable in the live feed
   * (e.g. Finnhub returned no fundamental), so `actual` is "N/A" and the gate
   * must NOT count as a real-value pass OR a fail. Display-only: a name is
   * never demoted or zeroed because a metric is simply unknown. Absent/false
   * means a normal, scored gate. See `evaluateScreenGates`.
   */
  unknown?: boolean;
}

/** Saved Blueprint screen - criteria persist; results grow over time. */
export interface ScreenPreset {
  id: string;
  name: string;
  /** Primary horizon label (first selected). */
  horizon: TradeHorizon;
  /** One or more horizons blended in fit score. */
  horizons?: TradeHorizon[];
  criteria: ScreenCriteria;
  /** Free-text goals (e.g. "small cap quantum & robotics"). */
  description: string;
  savedTickers: string[];
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Portfolio-level discovery config (same engine as Blueprint). */
export interface PortfolioDiscovery {
  horizon: TradeHorizon;
  horizons?: TradeHorizon[];
  criteria: ScreenCriteria;
  description: string;
  targetCount: number;
  lastRunAt?: string;
}

// ---------------------------------------------------------------------------
// Raw provider data (inputs to the scoring engine)
// ---------------------------------------------------------------------------

export interface SourceLink {
  label: string;
  url: string;
  /** ISO timestamp the source was published / captured. */
  publishedAt?: string;
}

/** What kind of executive-branch political signal this is. */
export type ExecutiveSignalKind =
  /** A disclosed open-market PURCHASE (OGE Form 278-T). */
  | "buy"
  /** A disclosed open-market SALE (OGE Form 278-T). */
  | "sell"
  /** A favorable public statement / endorsement / spotlight. */
  | "favorable_callout"
  /** An adverse public statement - tariff threat, probe, criticism. */
  | "adverse_callout";

/**
 * Per-ticker rollup of the President's direction-aware political signal: the
 * strongest favorable item and the strongest adverse item (when each exists),
 * plus a signed net `direction` for the badge/scoring. Each item is REAL and
 * sourced (OGE Form 278-T disclosures or a dated public statement). Pure data -
 * no scoring math here; the engine derives the bounded tilt from `magnitude`.
 */
export interface ExecutiveSignalSummary {
  ticker: string;
  /** Net read for the card badge: favorable, adverse, or genuinely mixed. */
  direction: "bullish" | "bearish" | "mixed";
  /** The strongest FAVORABLE item (disclosed buy / praise), when present. */
  favorable?: ExecutiveSignalItem;
  /** The strongest ADVERSE item (tariff / probe / criticism), when present. */
  adverse?: ExecutiveSignalItem;
}

export interface ExecutiveSignalItem {
  kind: ExecutiveSignalKind;
  /** Who acted - e.g. "President Trump". */
  actor: string;
  /** One-line, plain-English description for the badge/wire. */
  summary: string;
  /** ISO date (YYYY-MM-DD) the disclosure/statement is dated. */
  date: string;
  /**
   * Days from the research "now" to {@link date} - NEGATIVE = already happened
   * (still potentially fresh), matching `RawCatalyst.daysAway`. Pre-computed in
   * the enrichment layer so the scorer stays a PURE, clock-free function. Absent
   * on the raw seed (e.g. the StockDetail badge path, which doesn't need it).
   */
  daysAway?: number;
  /** Pre-recency materiality × magnitude, 0..1 (recency is the engine's job). */
  magnitude: number;
  /** Direct link to the OGE filing or the reporting on the statement. */
  sourceUrl: string;
  /** Display label for the source link. */
  sourceLabel: string;
}

export interface NewsItem {
  headline: string;
  source: string;
  url: string;
  publishedAt: string;
  /** -1 (very negative) .. 1 (very positive). */
  sentiment: number;
}

/** One analyst / consensus price-target row (live Finnhub/FMP or outbound link). */
export interface AnalystTargetRow {
  source: string;
  label: string;
  url: string;
  target?: number;
  targetHigh?: number;
  targetLow?: number;
  targetMedian?: number;
  updatedAt?: string;
  isSample?: boolean;
  /** Number of analysts behind this row, when the source reports it. */
  analystCount?: number;
  /** Provenance of this row's numbers. */
  origin?: "finnhub" | "fmp" | "yahoo" | "estimated" | "sample" | "ai" | "link";
}

export interface AnalystRecommendations {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  period?: string;
}

export interface AnalystCoverage {
  /**
   * live = single live consensus PT; aggregated = blended across ≥2 live sources;
   * estimated = modeled from ratings; sample = demo universe; links_only = outbound only.
   */
  status: "loading" | "live" | "aggregated" | "sample" | "estimated" | "links_only";
  spotPrice: number;
  consensus?: {
    mean?: number;
    median?: number;
    high?: number;
    low?: number;
    updatedAt?: string;
    /** Live sources blended into this consensus (e.g. ["Finnhub", "FMP"]). */
    contributors?: string[];
    /** Total analysts across blended sources, when known. */
    analystCount?: number;
  };
  recommendations?: AnalystRecommendations;
  rows: AnalystTargetRow[];
  sources: Array<{ id: string; name: string; blurb: string; url: string }>;
}

// ---------------------------------------------------------------------------
// Optional AI research lane (user-controlled server-side proxy)
// ---------------------------------------------------------------------------

/** A single cited finding returned by the research proxy. */
export interface ResearchCitation {
  title: string;
  url: string;
  source?: string;
  publishedAt?: string;
}

/**
 * A filing (or earnings call) that fed the analysis, with its date - always
 * surfaced so a read is presented "as of <date>", never as live condition.
 * Mirrors the Research Desk `FilingRef` wire model.
 */
export interface FilingRef {
  /** "10-K" | "10-Q" | "8-K" | "earnings_call" | … */
  form: string;
  /** ISO date the document became public. */
  filingDate?: string;
  /** ISO date the reporting period ended. */
  periodOfReport?: string;
  accessionNo?: string;
  url?: string;
}

/** FinBERT tone components behind an earnings-call score (deterministic). */
export interface CallScoreComponents {
  preparedRemarksSentiment?: number;
  qaSentiment?: number;
  /** prepared − Q&A: the "say one thing, hedge another" tell. */
  toneGap?: number;
  /** "raised" | "held" | "cut" | "unknown" */
  guidanceDirection?: string;
  guidanceScore?: number;
  preparedChunks?: number;
  qaChunks?: number;
}

/**
 * Earnings-call read from the Research Desk. `available: false` (and a null
 * `score`) means the desk couldn't source a call to score - surface "unavailable"
 * with the `reason`, never a fabricated number.
 */
export interface CallScore {
  /** 0–100, or null when unavailable. */
  score?: number | null;
  /** "constructive" | "balanced" | "cautious" | "unavailable" */
  label?: string;
  available?: boolean;
  /** Why it's unavailable / prepared-remarks-only, when applicable. */
  reason?: string;
  components?: CallScoreComponents;
  /** "Finnhub" | "8-K Exhibit 99.1" | … */
  source?: string;
  callDate?: string;
}

/** A single dated, cited span supporting a claim (look-ahead filtered). */
export interface SpanCitation {
  spanId?: string;
  /** "10-K · Risk Factors" | "Q1'25 call · Q&A" */
  source: string;
  /** Publish / as-of date. */
  date?: string;
  url?: string;
  /** Supporting snippet, verbatim from the cited span. */
  quote?: string;
}

/**
 * A verified bull/bear claim. Every number in `claim` is grounded in one of its
 * `citations` (the desk drops anything it can't cite). `kind` is the primary
 * case point or a disconfirming counter.
 */
export interface CitedClaim {
  claim: string;
  /** "bull" | "bear" */
  side?: string;
  /** "primary" | "counter" */
  kind?: string;
  citations?: SpanCitation[];
  quotedNumbers?: string[];
}

/** A real, exchange-listed stock the AI surfaced from the user's narrative. */
export interface TickerSuggestion {
  /** Uppercase US exchange symbol (e.g. "IONQ"). */
  ticker: string;
  /** Company name as reported by the agent. */
  name: string;
  /** One-line, web-grounded reason it fits the thesis. */
  rationale?: string;
}

/**
 * One disclosed insider (Form 4) transaction the desk fetched server-side from
 * the free Finnhub `stock/insider-transactions` endpoint. Surfaced verbatim so a
 * material open-market BUY (code "P") by an officer/director is visible - e.g.
 * SOFI's CEO Anthony Noto.
 */
export interface InsiderTxn {
  name: string;
  /** SEC transaction code: "P" open-market buy, "S" open-market sell. */
  code: string;
  shares: number;
  /** Signed share delta (positive = acquired). */
  change: number;
  price: number;
  /** ISO transaction date. */
  date: string;
  valueUsd: number;
}

/**
 * Authoritative, server-fetched "ground truth" the desk anchors its read to -
 * price, profitability, valuation, and recent insider flow - so a stale model
 * claim can't hide. Profitability is decided by EPS-TTM sign FIRST (never net
 * margin alone, which lags/distorts), so the strip never lies about whether a
 * company is profitable. Discovery/research only.
 */
export interface VerifiedFacts {
  ticker: string;
  name?: string;
  price?: number;
  dayChangePct?: number;
  /** Market cap in billions USD. */
  marketCapB?: number;
  industry?: string;
  epsTTM?: number;
  peTTM?: number;
  revenueGrowthYoYPct?: number;
  week52High?: number;
  week52Low?: number;
  /** The single most-abused fact - decided by EPS sign first, never net margin alone. */
  profitability: "profitable" | "unprofitable" | "unknown";
  profitabilityBasis?: string;
  asOf?: string | null;
  insiderBuys: InsiderTxn[];
  insiderSells: InsiderTxn[];
}

/**
 * The desk's Bull/Bear/Judge debate: two full prose arguments and the judge's
 * verdict (stance + conviction) plus the catalysts/risks that decided it. The
 * remodeled desk LEADS with the verdict, then shows the bull/bear prose as two
 * equal first-class columns. Every field is optional/defensive - older `deep_
 * research` responses (pre-debate) simply omit it and the desk falls back to the
 * cited bull/bear claim cards.
 */
export interface ResearchDebate {
  /** Full bull-case prose argument. */
  bull: string;
  /** Full bear-case prose argument. */
  bear: string;
  /** The judge's overall lean. */
  stance?: "bullish" | "bearish" | "mixed";
  /** 0–100 conviction behind the stance. */
  confidence?: number;
  /** The catalysts that could drive the move (chips). */
  keyCatalysts: string[];
  /** The risks that could break the thesis (chips). */
  keyRisks: string[];
}

/**
 * Structured output from an optional AI research agent the user hosts behind
 * `VITE_RESEARCH_PROXY_URL`. The client never holds the LLM/search keys - the
 * proxy runs the agent and returns this contract. Discovery/research only.
 */
export interface ResearchIntel {
  ticker?: string;
  /** Plain-language synthesis of current situation (no buy/sell advice). */
  summary: string;
  /** Bullish / catalyst points with citations. */
  bullPoints?: string[];
  /** Bearish / risk points with citations. */
  bearPoints?: string[];
  /** Theme/keyword tags the agent extracted (feed back into the screen). */
  themes?: string[];
  /** Real tickers the agent found for the narrative (task: "discover"). */
  suggestions?: TickerSuggestion[];
  /** Optional sentiment read, -1..1. */
  sentiment?: number;
  citations: ResearchCitation[];
  /** ISO timestamp the agent produced this. */
  generatedAt?: string;
  /** Model / agent identifier the proxy reports. */
  model?: string;

  // ---- AI Research Desk extension (superset; optional on the base lane) ----
  // The hosted desk behind VITE_RESEARCH_PROXY_URL returns these on top of the
  // base contract for task: "deep_research". They stay optional so the thin
  // proxy (or theme/discover tasks) remains a valid ResearchIntel.

  /** One-line analyst thesis (the headline read). */
  thesis?: string;
  /** Calibrated 0–100 conviction; null/undefined → present as "unavailable". */
  confidence?: number | null;
  /** The honesty surface: what evidence would change the thesis. */
  whatWouldFlipIt?: string[];
  /** Deterministic earnings-call tone read. */
  callScore?: CallScore | null;
  /** The look-ahead cutoff the analysis respected (ISO date). */
  asOfDate?: string;
  /** Filings/calls that fed the read, each with its date. */
  filingsUsed?: FilingRef[];
  /** Citation-verified bull case (each claim grounded in dated spans). */
  citedBull?: CitedClaim[];
  /** Citation-verified bear case. */
  citedBear?: CitedClaim[];

  /**
   * The Bull/Bear/Judge debate (deep_research). Present on newer responses; the
   * remodeled desk leads with the verdict and renders bull/bear as two equal
   * prose columns. Absent on older responses → fall back to citedBull/citedBear.
   */
  debate?: ResearchDebate;
  /**
   * Authoritative current facts the desk fetched live (server-side, from market
   * data) and used to anchor + claim-check the read. Rendered verbatim as a trust
   * strip - NEVER guessed. Present only on the grounded `deep_research` desk lane.
   */
  verifiedFacts?: VerifiedFacts;
  /**
   * How the read was grounded - e.g. "web" (live grounded search) or a degraded
   * tag. Informational provenance; absent on older responses.
   */
  grounding?: string;
}

/** One open-market insider transaction (SEC Form 4 via Finnhub). */
export interface InsiderTxn {
  name: string;
  /** SEC transaction code: "P" open-market buy, "S" open-market sell. */
  code: string;
  shares: number;
  /** Signed share delta (positive = acquired). */
  change: number;
  price: number;
  /** ISO transaction date. */
  date: string;
  valueUsd: number;
}

/**
 * Authoritative current facts for a ticker, fetched live from market data and
 * used to anchor the Research Desk's grounded read + claim-check its output.
 * Everything here is real-or-absent - the desk renders it verbatim, never guesses.
 */
export interface VerifiedFacts {
  ticker: string;
  name?: string;
  price?: number;
  dayChangePct?: number;
  /** Market cap in billions USD. */
  marketCapB?: number;
  industry?: string;
  epsTTM?: number;
  peTTM?: number;
  revenueGrowthYoYPct?: number;
  week52High?: number;
  week52Low?: number;
  /** The single most-abused fact - decided by EPS sign first, never net margin alone. */
  profitability: "profitable" | "unprofitable" | "unknown";
  profitabilityBasis?: string;
  asOf?: string | null;
  insiderBuys: InsiderTxn[];
  insiderSells: InsiderTxn[];
}

/** One dated close for interactive charts (oldest → newest). */
export interface PricePoint {
  date: string;
  close: number;
}

/** Sample social post used for X / political attention modeling (not live data). */
export interface SocialPost {
  platform: "x" | "reddit";
  author: string;
  handle: string;
  text: string;
  publishedAt: string;
  url: string;
  sentiment: number;
  /** Congressional / political figure or policy-related mention. */
  isPolitical: boolean;
  severity: "watch" | "elevated" | "high";
}

/**
 * One disclosed congressional stock transaction (House or Senate). Sourced from
 * the free, keyless House/Senate Stock Watcher datasets - discovery/research only.
 */
export interface CongressTrade {
  /** Filer name as disclosed (e.g. "Hon. Nancy Pelosi"). */
  representative: string;
  chamber: "House" | "Senate";
  /** "buy" (purchase), "sell" (any sale), or "exchange". */
  transaction: "buy" | "sell" | "exchange";
  /** Disclosed dollar band, e.g. "$1,001 - $15,000". */
  amountRange: string;
  /** ISO date of the trade. */
  transactionDate: string;
  /** ISO date the trade was publicly disclosed, when known. */
  disclosedDate?: string;
  /** Link to the underlying disclosure (PTR), when available. */
  url?: string;
}

/** One recent SEC filing (EDGAR), kept for links/recency on the card. */
export interface SecFiling {
  /** EDGAR form type, e.g. "4" (insider transaction) or "8-K" (material event). */
  form: string;
  /** ISO date the filing was submitted. */
  filedAt: string;
  /** Direct link to the filing document on sec.gov. */
  url: string;
}

/**
 * Real SEC EDGAR filing activity for one ticker - insider transactions (Form 4)
 * and material events (8-K). Sourced from the free, keyless EDGAR submissions
 * API. Discovery/research only; counts + recency, not buy/sell amounts (that
 * requires parsing each Form 4 XML - a planned follow-up).
 */
export interface SecActivity {
  /** Zero-padded 10-digit CIK. */
  cik: string;
  /** Insider-transaction (Form 4) filings in the trailing window. */
  form4Count90d: number;
  /** Material-event (8-K) filings in the trailing window. */
  eightKCount90d: number;
  /** ISO date of the most recent Form 4, when any. */
  latestForm4Date?: string;
  /** ISO date of the most recent 8-K, when any. */
  latestEightKDate?: string;
  /** Recent insider + material-event filings (newest first, capped). */
  filings: SecFiling[];
  /**
   * Count of OPEN-MARKET insider purchases (Form 4 "P" code) in the trailing
   * window, when an aggregated source has computed it. Distinct from
   * `form4Count90d` (all Form 4s, any code). OPTIONAL and typically ABSENT
   * universe-wide: deriving it requires parsing each Form 4's ownership XML,
   * which the universe scan deliberately skips under SEC's fair-access policy.
   * The smart-money catalyst boost consumes it only when present (degrading to
   * zero otherwise) and never triggers the per-filing fetch itself.
   */
  form4BuyCount90d?: number;
  /**
   * Net open-market insider dollars (Σ P-code buys − Σ S-code sells) in the
   * trailing window, when aggregated. Positive = net insider buying. Same
   * provenance/optionality as {@link form4BuyCount90d}.
   */
  form4NetBuyValue90d?: number;
  /**
   * Recent activist / strategic 13D-style stake disclosures, when a scan has
   * already folded them into the company record. Optional; absent means neutral.
   */
  thirteenDCount90d?: number;
}

/** Derived alert surfaced in the Terminal alert feed (from posts + mention spikes). */
export interface SocialAlert {
  id: string;
  ticker: string;
  companyName: string;
  kind: "post" | "mention_spike" | "political_catalyst";
  severity: "watch" | "elevated" | "high";
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
  opportunityScore: number;
}

export interface RawFundamentals {
  /** Year-over-year revenue growth, as a ratio (0.25 = +25%). */
  revenueGrowthYoY: number;
  /** Year-over-year EPS growth, as a ratio. Can be negative. */
  epsGrowthYoY: number;
  grossMargin: number; // 0..1
  netMargin: number; // can be negative for unprofitable names
  /** Trailing P/E. null when not meaningful (e.g. negative earnings). */
  peRatio: number | null;
  /** Price/Earnings-to-Growth. null when not meaningful. */
  pegRatio: number | null;
  debtToEquity: number;
  fcfMargin: number; // free cash flow / revenue, can be negative
}

export interface RawMomentum {
  return1M: number; // ratio
  return3M: number; // ratio
  return6M: number; // ratio
  /** Relative Strength Index, 0..100. */
  rsi: number;
  aboveSMA50: boolean;
  aboveSMA200: boolean;
  /** Performance vs the broad market over 3M, as a ratio spread. */
  relativeStrength3M: number;
}

export interface RawCatalyst {
  type: CatalystType;
  description: string;
  /** Days until the catalyst. Negative = it already happened (still fresh). */
  daysAway: number;
  /** Expected impact, 0 (minor) .. 1 (transformational). */
  magnitude: number;
}

export interface RawNews {
  items: NewsItem[];
  /** Aggregate sentiment, -1 .. 1. */
  sentiment: number;
  /** Article count in the trailing 7 days. */
  count7d: number;
  /** Hours since the most recent qualifying headline. */
  freshnessHours: number;
}

export interface RawSocial {
  redditMentions24h: number;
  xMentions24h: number;
  /** Mentions in political / congressional-trade / lobbying feeds. */
  politicalMentions: number;
  /** Aggregate social sentiment, -1 .. 1. */
  sentiment: number;
  /** Day-over-day change in mention volume, as a ratio (1.0 = +100%). */
  trendDelta: number;
  /** Human-readable one-liner shown on the card. */
  summary: string;
}

export interface RawVolatility {
  beta: number;
  /** Average True Range as a % of price. */
  atrPct: number;
  /** Implied volatility (annualized), as a ratio. */
  impliedVol: number;
}

export interface RawLiquidity {
  /** Average daily traded value in USD. */
  avgDollarVolume: number;
  /** Free float in shares. */
  floatShares: number;
}

export interface RawRisk {
  shortInterestPct: number; // 0..1 of float
  /** Days-to-cover for short interest. Optional; absent keeps SI as risk-only. */
  daysToCover?: number;
  /** Dividend cut / suspension flag. Optional; absent is neutral. */
  dividendCutOrSuspended?: boolean;
  /** Recent reverse-split history. Optional; absent is neutral. */
  reverseSplitHistory?: boolean;
  /** Going-concern / severe solvency warning. Optional; absent is neutral. */
  goingConcernFlag?: boolean;
  /** MAX-style spike without a primary-source filing. Optional; absent is neutral. */
  maxSpikeNoFiling?: boolean;
  /** Dilution / financing overhang risk, 0 (none) .. 1 (severe). */
  dilutionRisk: number;
  /** Quarters of cash runway. High number = safe. */
  cashRunwayQuarters: number;
  /** Governance / accounting red-flag, 0 (clean) .. 1 (severe). */
  governanceFlag: number;
}

/**
 * One exchange listing of a company, for the dual-listing surface. The PRIMARY
 * (`isPrimary: true`) is the listing the headline quote reflects; alternates are
 * its genuine cross-border cross-listings (e.g. SHOP on NASDAQ ↔ SHOP.TO on TSX).
 */
export interface CrossListing {
  /** Directory symbol, e.g. "SHOP" or "SHOP.TO". */
  symbol: string;
  /** Short display exchange label, e.g. "NASDAQ", "TSX", "TSX-V". */
  exchangeLabel: string;
  country: "US" | "CA";
  /** Trading currency of this listing ("USD" | "CAD"). */
  currency: string;
  isPrimary: boolean;
}

/** Everything a provider must supply about one company. */
export interface CompanyData {
  ticker: string;
  name: string;
  sector: Sector;
  /**
   * Finnhub's finer-grained industry label (e.g. "Semiconductors",
   * "Aerospace & Defense", "Banking") - more specific than the broad {@link Sector}.
   * Live-data only; absent on sample/synthetic/directory records. Used to make the
   * company blurb specific ("a semiconductor company") instead of generic.
   */
  finnhubIndustry?: string;
  /** Spot/last price in the listing's {@link CompanyData.currency} (default USD). */
  price: number;
  /** Intraday change as a ratio (0.034 = +3.4%). */
  dayChange: number;
  /** Market capitalization in USD. */
  marketCap: number;
  /**
   * ISO trading currency of `price` (e.g. "USD", "CAD"). Absent → treat as USD.
   * Set for TSX (.TO/.V) listings so the UI labels CAD prices honestly.
   */
  currency?: string;
  /** Short display label for the headline listing's exchange (e.g. "TSX", "NASDAQ"). */
  listingExchange?: string;
  /** Country of the headline listing. */
  listingCountry?: "US" | "CA";
  /**
   * The company's exchange listings, primary first, when more than one was found
   * (brokerage-style dual-listing surface on the detail view). Absent for
   * single-listing names.
   */
  crossListings?: CrossListing[];
  /** ~30 trailing closes for the sparkline (oldest -> newest). */
  priceHistory: number[];
  /** Dated closes for interactive charts (parallel to priceHistory). */
  priceSeries: PricePoint[];

  fundamentals: RawFundamentals;
  momentum: RawMomentum;
  catalyst: RawCatalyst;
  news: RawNews;
  social: RawSocial;
  /** Recent posts feeding social / political scoring (sample until live X API). */
  socialPosts: SocialPost[];
  volatility: RawVolatility;
  liquidity: RawLiquidity;
  risk: RawRisk;

  sources: SourceLink[];

  /**
   * Per-field provenance for fundamentals. `true` = the value came from a live
   * provider; `false` = the field isn't in the live feed (UI shows "N/A" rather
   * than presenting a modeled placeholder as real). Absent = sample/modeled
   * universe, where the existing sample framing applies.
   */
  fundamentalsAvailability?: Partial<Record<keyof RawFundamentals, boolean>>;
  /**
   * As-of / reporting period for the live fundamentals, when known - an ISO date
   * (YYYY-MM-DD) or fiscal-period label (e.g. "2025-09" / "TTM 2025-Q3"). Used to
   * (a) reject stale figures via a freshness window and (b) append an honest "as
   * of …" qualifier so a 1–2-quarter-lagged Finnhub TTM is never shown as
   * current. Absent = no dated provenance (treated as undatable → not fresh).
   */
  fundamentalsAsOf?: string;
  /**
   * True when the catalyst was inferred from real headlines; false when this is
   * a live record with no dated catalyst in the feed yet (so copy stays honest).
   */
  catalystLive?: boolean;
  /**
   * Set when this record has NO live market data behind it. Every
   * market-derived surface (sector, market cap, P/E, fundamentals, catalyst,
   * momentum, valuation, risk, hype, opportunity score, archetypes, narrative)
   * must then render "unavailable" rather than presenting a modeled/seeded
   * value as if it were real:
   *  - "directory": a real, listed security the live provider couldn't quote
   *    (e.g. a TSX/Cboe-Canada name on a US free tier). Name + exchange are real.
   *  - "sample": a fictional/illustrative profile generated for an unknown-ticker
   *    lookup - everything is illustrative and must be labeled "SAMPLE - not live".
   * Absent = a live-quoted record or the curated demo universe (existing framing).
   */
  marketDataUnavailable?: "directory" | "sample";
  /**
   * Next scheduled earnings event for this ticker, when the earnings-calendar
   * lane found one (challenger only - see src/data/earnings/). `daysAway` powers
   * the "see it before the move" catalyst-timing countdown, and `epsEstimate`
   * (consensus forward EPS) is snapshotted daily so the engine can detect
   * estimate-revision momentum. Absent when no upcoming earnings is on the feed.
   */
  nextEarnings?: {
    /** ISO date (YYYY-MM-DD) of the next scheduled earnings report. */
    dateISO: string;
    /** Calendar days until the report (0 = today; negative shouldn't occur). */
    daysAway: number;
    /** Consensus forward EPS estimate, or null when the calendar omits it. */
    epsEstimate: number | null;
  };
  /**
   * Recent disclosed congressional trades for this ticker (House/Senate Stock
   * Watcher). Drives `social.politicalMentions` and the hype "political" driver.
   */
  congressTrades?: CongressTrade[];
  /**
   * Real SEC EDGAR filing activity (insider Form 4 + 8-K material events).
   * Surfaced on the card and annotated into the news/catalyst summary.
   */
  secActivity?: SecActivity;

  /**
   * Direction-aware executive-branch (Presidential) political signal for this
   * ticker, when the President has DISCLOSED a buy/sell or publicly CALLED OUT the
   * company (praise / endorsement / adverse policy such as a tariff threat). Real,
   * sourced OGE Form 278-T disclosures + dated public statements only - never
   * inferred. A FAVORABLE signal folds into `catalyst` as a positive "Political"
   * catalyst (so it flows through the unified catalyst strength); an ADVERSE one
   * is read here by `materialSellSignal` as a bounded negative tilt. Absent for
   * the vast majority of names. See `src/data/terminal/executiveTrades.ts`.
   */
  executiveSignal?: ExecutiveSignalSummary;

  /**
   * (v2 - Pre-Move Inflection Engine) Pre-computed fundamental-INFLECTION inputs:
   * the 2nd-derivative re-acceleration off a depressed base that research shows
   * most reliably precedes a major run (CVNA/ANF/POWL/AEHR). Derived in the daily
   * scan from FMP quarterly statements; ABSENT until a scan with the v2 financials
   * fold runs. Every field optional → the `inflection` scorer returns a neutral 50
   * when the group (or a field) is missing, so a cold start never penalizes a name
   * and never fabricates a trend. All values are ratios unless noted.
   */
  inflection?: {
    /** 2nd-derivative of QoQ revenue growth: this-quarter QoQ minus the trailing
     *  2-quarter average QoQ (>0 ⇒ growth is RE-accelerating). */
    revAccelQoQ?: number;
    /** ΔYoY revenue growth vs the prior quarter (this-q YoY − prior-q YoY). */
    revYoYAccel?: number;
    /** Gross-margin change YoY (this fiscal quarter vs the year-ago quarter). */
    grossMarginDeltaYoY?: number;
    /** Operating margin this quarter (op income / revenue). */
    opMarginNow?: number;
    /** Operating margin in the year-ago quarter (for the loss→profit turn). */
    opMarginPrevYearQ?: number;
    /** Opex/revenue change YoY (negative ⇒ operating leverage improving). */
    opexPctRevDeltaYoY?: number;
    /** Enterprise-value / TTM sales (a small-cap quality/value tell). */
    evToSales?: number;
  };

  /**
   * (v4) Valuation versus the company's own long-run multiple history. Bottom
   * third means the name is cheap relative to itself (the T1 reversal spine).
   * Optional and cold-start neutral.
   */
  valuation?: {
    /** 0..1 percentile of P/E (or P/S for cyclicals) vs the trailing 5-year range. */
    peVsOwn5yrPctile?: number;
    /**
     * Revenue CAGR minus price CAGR over the same multi-year window, as a ratio
     * (+0.29 = the business compounded 29 percentage points a year faster than the
     * stock). Positive means the multiple COMPRESSED - the market is paying less
     * for the same business than it used to. Negative means the stock ran ahead of
     * its fundamentals. Computed in `engine/valuationHistory.ts` from disclosed
     * SEC annual revenue and real closes; absent when there is not enough history.
     */
    revenueVsPriceDivergence?: number;
  };

  /**
   * (v2) The earliest HARD pre-move signal - order book / backlog / a named
   * contract win that LEADS the revenue line. Derived in the scan (book-to-bill &
   * backlog from FMP where available; `namedContractPctRev` = a disclosed
   * 8-K Item 1.01 / USASpending award ÷ TTM revenue). ABSENT for most names →
   * `pipeline` scorer returns neutral 50 (cold-start safe, never penalizes).
   */
  pipeline?: {
    /** Bookings ÷ billings; >1 ⇒ order book growing faster than revenue. */
    bookToBill?: number;
    /** Disclosed backlog ÷ TTM revenue. */
    backlogToRevTTM?: number;
    /** A single disclosed award ÷ TTM revenue (one big contract relative to size). */
    namedContractPctRev?: number;
    /** Backlog / cRPO growth YoY. Used against recognized revenue growth. */
    backlogYoY?: number;
    /** Deferred revenue growth YoY. Used against recognized revenue growth. */
    deferredRevYoY?: number;
    /** Net revenue retention / DBNR, as a ratio (1.12 = 112%). */
    nrr?: number;
    /** Market/share delta in basis points; positive means share gains. */
    shareDeltaBps?: number;
  };

  /**
   * (v4) Strategic capital / disclosed outside investment at a named price.
   * Additive-only in conviction: absent means neutral, never a penalty.
   */
  strategicCapital?: {
    /** Strategic, sovereign, activist, or corporate investor name. */
    investor?: string;
    /** Fresh disclosed capital in USD. */
    amountUsd?: number;
    /** Disclosed strike / purchase price, when known. */
    disclosedStrike?: number;
    /** Filing/news source URL or short source label. */
    source?: string;
  };

  /**
   * (v2) Trailing-20-day series feeding the `sentimentShift` dimension's
   * z-vs-own-baseline math. Each array is oldest→newest, ENDING at the as-of date,
   * persisted across daily scans from the signal-history store. ABSENT on a cold
   * start (or for a name with <2 days of history) → every z=0 → `sentimentShift`
   * returns a neutral ~50. Never fabricated; built only from observed values.
   */
  sentimentSeries?: {
    /** Daily social-polarity (−1..1) over the trailing window. */
    socialPolarity?: number[];
    /** Daily total social mention counts. */
    socialVolume?: number[];
    /** Daily aggregate news tone (−1..1). */
    newsTone?: number[];
    /** Daily qualifying-news / 8-K event counts. */
    newsVolume?: number[];
  };

  /**
   * (v2) Trailing-twelve-month revenue in USD, when the scan's quarterly-financials
   * fold computed it. Used by the anti-lottery guard's "no-revenue shell" check and
   * as the denominator for pipeline ratios. ABSENT ⇒ the no-revenue penalty is 0
   * (we never assert "no revenue" from missing data - only from an observed ~0).
   */
  revenueTTM?: number;

  /**
   * (v2) True when this name's thesis is a single upcoming binary readout (an FDA
   * / clinical Phase-2/3 catalyst with no real revenue line). Such names are
   * EXEMPT from the no-revenue pump penalty (§ anti-lottery) but carry an explicit
   * "high-variance, binary-on-outcome" watch-out and are NOT scored like a
   * fundamental compounder. Set by the catalyst enrichment when it sees a clinical
   * catalyst on a pre-revenue issuer.
   */
  binaryCatalystTag?: boolean;
}

// ---------------------------------------------------------------------------
// Scoring output
// ---------------------------------------------------------------------------

/** Stable keys for each scored category. */
export type ScoreCategoryKey =
  | "fundamentals"
  | "growth"
  | "momentum"
  | "catalyst"
  /** (v4) Additive-only smart-money / strategic-capital conviction. */
  | "conviction"
  | "news"
  | "social"
  | "volatility"
  | "liquidity"
  /** Entry/value timing - is the price discounted vs. its range, or chasing a top? */
  | "valuation"
  /** (v2) Fundamental re-acceleration - the 2nd-derivative pre-move trigger:
   *  revenue/margin re-accelerating off a depressed base, BEFORE it's obvious. */
  | "inflection"
  /** (v2) The earliest HARD signal - backlog / book-to-bill / a named contract
   *  win that leads the revenue line (POWL/AEHR/SYM/SOUN pattern). */
  | "pipeline"
  /** (v2) Sentiment SHIFT - the DELTA of tone/attention vs the stock's OWN 20-day
   *  baseline, gated for substance (not raw hype). */
  | "sentimentShift";

export interface ScoreCategory {
  key: ScoreCategoryKey;
  label: string;
  /** Sub-score, 0..100. */
  score: number;
  /** Weight applied in the blended opportunity score, 0..1. */
  weight: number;
  /** weight * score, i.e. the points this category added before penalties. */
  contribution: number;
  /** Plain-English reason this category scored the way it did. */
  explanation: string;
}

export interface ScoreBreakdown {
  /** Final blended opportunity score, 0..100. */
  opportunityScore: number;
  /** How trustworthy the inputs are, 0..100. */
  confidence: number;
  /** Why confidence landed where it did (coverage, corroboration, agreement). */
  confidenceExplanation: string;
  /** Points subtracted by the risk model, 0..~25. */
  riskPenalty: number;
  /** Human-readable summary of the risk penalty. */
  riskExplanation: string;
  categories: ScoreCategory[];
}

// ---------------------------------------------------------------------------
// Hype layer ("why it'll pop")
// ---------------------------------------------------------------------------

export type HypeDriverKey =
  | "catalyst"
  | "news"
  | "social"
  | "political"
  | "momentum"
  | "volatility";

/** One structured reason a name is heating up - never free-form prose. */
export interface HypeDriver {
  key: HypeDriverKey;
  /** Short label, e.g. "Fresh news". */
  label: string;
  /** Concrete detail pulled from raw data, e.g. "8 stories, freshest 3h ago". */
  detail: string;
  /** This driver's contribution to the hype score, 0..100. */
  points: number;
}

export type HypeTier = "Cooling" | "Warming" | "Heating up" | "On fire";

/**
 * A composite "is this about to move?" read, distinct from the opportunity
 * score. Tilts hard toward freshness/attention/catalyst timing and is rendered
 * as a structured, interactive strip on the card - not an LLM essay.
 */
export interface HypeScore {
  /** 0..100 hype intensity. */
  score: number;
  tier: HypeTier;
  /** One-line synthesis of the top drivers ("why it'll pop"). */
  tldr: string;
  /** Strongest drivers first; cards show the top few. */
  drivers: HypeDriver[];
}

// ---------------------------------------------------------------------------
// Smart-list "why this is interesting" tags
// ---------------------------------------------------------------------------

/**
 * The discrete reasons a name earns a place on a smart list. Rendered as premium
 * chips on the card/tile. The FEED lane is the canonical source (it sees the full
 * universe); when it hasn't attached any, the card derives an HONEST fallback set
 * from the signal's already-computed fields (see deriveWhyTags in WhyTags.tsx).
 */
export type WhyTagKind =
  /** Open-market insider purchases disclosed on Form 4. */
  | "insider_buying"
  /** A live, high-magnitude catalyst inside the near-term window. */
  | "fresh_catalyst"
  /** Trading at a discount to its range WITH positive earnings growth. */
  | "discounted_earnings"
  /** A small/micro/nano-cap scoring well with little coverage. */
  | "overlooked_small_cap"
  /** Top hype tier - attention is spiking right now. */
  | "on_fire"
  /** Disclosed congressional / political buying. */
  | "smart_money"
  /** Material disclosed selling by major insiders / important people (watch-out). */
  | "sell_watch"
  /** (v2) Revenue / margin RE-accelerating off a depressed base - the early
   *  inflection that precedes a move. */
  | "reaccelerating"
  /** (v2) A hard forward signal: backlog / book-to-bill / a named contract win
   *  leading the revenue line. */
  | "backlog_building"
  /** (v2) Sentiment turning vs the stock's own 20-day baseline, with substance. */
  | "sentiment_turning"
  /** High score AND high input confidence. */
  | "high_conviction";

/** One "why this is interesting" smart-list tag for a card/tile. */
export interface WhyTag {
  kind: WhyTagKind;
  /** Display label; the card falls back to a default per-kind label when omitted. */
  label?: string;
  /** One-line evidence shown on hover / in the chip title (never fabricated). */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Enriched, display-ready signal
// ---------------------------------------------------------------------------

export interface KeyFundamental {
  label: string;
  value: string;
  /** Optional sentiment tint for the value chip. */
  tone?: "positive" | "negative" | "neutral";
  /** Optional hover explanation (e.g. why a value reads "N/A"). */
  hint?: string;
}

export type LookupProvenance = "curated" | "finnhub" | "yahoo" | "synthetic" | "directory";

export interface StockSignal extends CompanyData {
  /** True when scored via ad-hoc lookup (outside the curated universe run). */
  isLookup?: boolean;
  /** Where lookup inputs came from (curated mock, Finnhub quote, or fully synthetic). */
  lookupProvenance?: LookupProvenance;
  /** Stable id: `${ticker}` (one signal per ticker per run). */
  id: string;
  score: ScoreBreakdown;
  marketCapBucket: MarketCapBucket;
  riskLevel: RiskLevel;
  /** Mirror of score.confidence for convenient sorting/badging. */
  confidence: number;
  catalystType: CatalystType;
  /** ISO timestamp this signal was generated by a research run. */
  generatedAt: string;

  // Pre-computed display strings so cards stay dumb/presentational.
  thesis: string;
  /**
   * One-sentence plain-English descriptor of what the company does (e.g.
   * "Rocket Lab is a technology company."). Sourced from the signal's sector
   * field - never fabricated. Absent for no-data listings or when sector is
   * unrecognised. Rendered as a muted subtitle above the thesis on the detail page.
   */
  companyBlurb?: string;
  newsInsight: string;
  momentumNote: string;
  socialSummary: string;
  keyFundamentals: KeyFundamental[];
  /** Composite "why it'll pop" read (catalyst + freshness + attention timing). */
  hype: HypeScore;
  /** Analyst price targets & outlet links (sample at enrich; live after feed refresh). */
  analyst?: AnalystCoverage;
  /**
   * Smart-list "why this is interesting" tags. Populated by the feed lane; when
   * absent the card derives an honest fallback from existing fields. Optional so
   * every existing producer of a StockSignal stays valid.
   */
  whyInteresting?: WhyTag[];
}

// ---------------------------------------------------------------------------
// Personalization
// ---------------------------------------------------------------------------

/**
 * For-You feed filter toggles - each makes its TYPE of setup dominate the feed
 * (hard filter + divider, not a gentle boost). Definitions and matching live in
 * `src/feed/feedFilters.ts`; extensible by adding an id here + a def there.
 */
export type ForYouFilterId =
  | "early_catalyst"
  | "emerging_themes"
  | "reversal_setups"
  | "breakout_watch"
  | "smart_money"
  | "discounted_quality";

/** A learned preference vector that powers the "For You" feed. */
export interface UserPreferences {
  /** Per-sector affinity. Defaults to 0; range roughly -3..3. */
  sectorWeights: Partial<Record<Sector, number>>;
  /** Per-cap-bucket affinity. */
  capWeights: Partial<Record<MarketCapBucket, number>>;
  /** Per-catalyst-type affinity. */
  catalystWeights: Partial<Record<CatalystType, number>>;
  /**
   * Style tilt. -1 = fully fundamentals-driven, +1 = fully catalyst-driven.
   */
  styleTilt: number;
  /**
   * Risk appetite. 0 = capital preservation, 1 = max aggression. Nudged by
   * higher/lower market-cap taps and likes on volatile names - unless the user
   * has set it explicitly (see {@link riskAppetiteLocked}).
   */
  riskAppetite: number;
  /**
   * True once the user sets the risk dial by hand. Locks out the implicit ±0.05
   * interaction nudges so a deliberate choice isn't quietly drifted away.
   */
  riskAppetiteLocked?: boolean;
  /** Tickers the user explicitly liked. */
  likedTickers: string[];
  /** Tickers the user explicitly down-ranked ("less like this"). */
  mutedTickers: string[];
  /** Default holding style for For You ranking and new screens. */
  tradeHorizon: TradeHorizon;
  /**
   * "Discounted-with-a-catalyst" dial, 0..1. Higher = the feed leans harder
   * toward names trading at a discount with a live catalyst, and pushes down
   * names that have already run to highs ("chasing"). Learns from feed taps and
   * from how the user's own holdings perform.
   */
  archetypeTilt: number;
  /**
   * Active For-You filter toggles. HARD filters: matched names dominate the
   * feed and the rest of the board renders behind a divider. Absent/empty =
   * the classic personalized ranking.
   */
  forYouFilters?: ForYouFilterId[];
  /**
   * Emerging-theme slugs in scope while `emerging_themes` is active (see
   * `src/feed/emergingThemes.ts`). Absent = all curated themes count.
   */
  forYouThemes?: string[];
}

export interface InteractionEvent {
  id: string;
  kind: InteractionKind;
  ticker: string;
  sector: Sector;
  catalystType: CatalystType;
  marketCapBucket: MarketCapBucket;
  at: string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Portfolios & research runs
// ---------------------------------------------------------------------------

export type PortfolioMode =
  | "High Volatility Catalyst"
  | "Small Cap Momentum"
  | "Fundamental Growth"
  | "Political/News Heat"
  | "Balanced Aggressive"
  | "Custom";

/**
 * Audit trail of an auto-detected corporate-action (stock split) rescale
 * applied to a {@link PortfolioHolding}'s `shares`/`costBasis`. Sourced from a
 * REAL splits feed (Alpaca corporate-actions; Finnhub attempted first when its
 * plan supports it) - never inferred from a price jump alone. Presence of this
 * field means the UI MUST show a dismissible "Adjusted for a 1:X split" note
 * with an Undo action that restores `originalShares`/`originalCostBasis` - the
 * rescale is never a silent rewrite.
 */
export interface PortfolioSplitAdjustment {
  /** Cumulative factor applied to the ORIGINAL shares to reach the current
   *  `shares` value (current = original × factor). A reverse split → factor < 1. */
  factor: number;
  /** Effective dates (YYYY-MM-DD) of every split folded into `factor`, oldest→newest.
   *  Idempotency marker: a date already in this list is never re-applied. */
  appliedDates: string[];
  /** Human label for the split(s) that triggered the most recent recompute,
   *  e.g. "1-for-10 reverse split" or "2 splits since your entry". */
  label: string;
  /** ISO timestamp the adjustment was last (re)computed. */
  appliedAt: string;
  /** Shares as originally entered, before ANY split adjustment - what Undo restores. */
  originalShares: number;
  /** Cost basis as originally entered, before ANY split adjustment - what Undo restores. */
  originalCostBasis?: number;
  /** Set when the user dismissed the visible note (hides the banner; the
   *  rescale itself stays applied - dismiss is not the same as Undo). */
  dismissedAt?: string;
}

export interface PortfolioHolding {
  ticker: string;
  addedAt: string;
  note?: string;
  /** Shares held - manual entry. Optional: legacy/watch-only holdings have none. */
  shares?: number;
  /** Average cost basis per share in USD - manual entry. Enables real P/L. */
  costBasis?: number;
  /**
   * Imported/snapshot market value of the position in USD (e.g. read off a
   * brokerage screenshot). Drives value-weighted allocation when a live
   * price × shares isn't available. Live data still takes precedence when present.
   */
  value?: number;
  /** Present when a real detected stock split has rescaled this holding. See
   *  {@link PortfolioSplitAdjustment}. */
  splitAdjustment?: PortfolioSplitAdjustment;
  /**
   * Split effective dates (YYYY-MM-DD) the user has explicitly UNDONE for this
   * holding - permanently excluded from future auto-detection so declining an
   * adjustment doesn't get silently reapplied on the next refresh.
   */
  rejectedSplitDates?: string[];
}

export interface PortfolioValuePoint {
  date: string;
  value: number;
  valuedCount: number;
}

/**
 * A research reminder a user attaches to a watched ticker - purely a personal
 * "ping me when price crosses this level" prompt, NOT an order or trading
 * instruction (hard product constraint: no brokerage / execution). Persisted
 * locally; the UI lights up the row when the live price has crossed the level.
 */
export interface WatchlistAlert {
  ticker: string;
  /** Price level to watch, in USD. */
  price: number;
  /** Fire when the live price moves above or below the level. */
  direction: "above" | "below";
  createdAt: string;
}

export interface PortfolioQuote {
  ticker: string;
  price: number;
  dayChange: number;
  /** Wall-clock time the overlay last FETCHED this quote (not the data's age). */
  updatedAt: string;
  /**
   * ISO timestamp of the underlying market data point (latest trade / bar). Used to
   * decide whether the quote is genuinely live vs a prior-session close shown
   * overnight. Optional: legacy/fallback quotes without it are treated as not-fresh.
   */
  asOf?: string;
}

export interface Portfolio {
  id: string;
  name: string;
  mode: PortfolioMode;
  description: string;
  /** "me" for the user; otherwise a mock friend/public handle. */
  owner: string;
  isPublic: boolean;
  holdings: PortfolioHolding[];
  createdAt: string;
  updatedAt: string;
  /** Accent used by the UI; falls back to a mode-derived color. */
  accent?: string;
  /** Optional saved screen + narrative for incremental discovery runs. */
  discovery?: PortfolioDiscovery;
  /** Daily portfolio valuation snapshots used for the progression chart. */
  valueHistory?: PortfolioValuePoint[];
}

// "loading" = reading the already-published daily board from the shared cache
// (a fast network read on boot), as distinct from "running" = a real multi-minute
// client-side market scan. The split lets the UI show honest skeletons on open
// WITHOUT the "Scanning…"/"Running research" copy that made opening the app look
// like it re-scans the market every time (the owner's repeated complaint).
export type ResearchRunStatus = "idle" | "loading" | "running" | "complete" | "error";

export interface ResearchStage {
  key: string;
  label: string;
  status: "pending" | "running" | "done";
  detail?: string;
}

export interface ResearchRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  provider: string;
  universeSize: number;
  signalsGenerated: number;
  trigger: "manual" | "scheduled";
  status: ResearchRunStatus;
  stages: ResearchStage[];
  /**
   * Optional honest one-line summary of how the universe was assembled - e.g. the
   * full-market funnel's "5,182 listed → 2,140 passed → top 240 scored". Set from
   * the provider's `telemetry()` when it offers one.
   */
  discoverySummary?: string;
}
