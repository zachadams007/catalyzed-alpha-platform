/**
 * Curated U.S. equities for live research runs (Finnhub quote, news, analyst).
 * Expanded for Blueprint - large caps plus niche themes (quantum, robotics, biotech, etc.).
 * Not a full market scan; rate limits apply per ticker.
 */

import { isKnownSymbol } from "@/data/symbols/symbolDirectory";

export const REAL_UNIVERSE_TICKERS = [
  // Mega / large core
  "AAPL",
  "MSFT",
  "NVDA",
  "GOOG",
  "AMZN",
  "META",
  "TSLA",
  "AMD",
  "NFLX",
  "CRM",
  "ORCL",
  "INTC",
  "AVGO",
  "JPM",
  "BAC",
  "XOM",
  "CVX",
  "UNH",
  "JNJ",
  "PFE",
  "BA",
  "LMT",
  "DIS",
  "WMT",
  "COST",
  // High-beta / platform growth
  "PLTR",
  "SMCI",
  "COIN",
  "HOOD",
  "SOFI",
  "RIVN",
  "SNOW",
  "NET",
  "DDOG",
  "ZS",
  "SHOP",
  "U",
  "RBLX",
  "DUOL",
  // Quantum & deep tech
  "IONQ",
  "RGTI",
  "QBTS",
  "QUBT",
  "ARQQ",
  // Robotics & automation
  "SERV",
  "SYM",
  "TER",
  "PATH",
  "IRBT",
  // Space & aerospace niche
  "RKLB",
  "ASTS",
  "LUNR",
  "ACHR",
  // Biotech / genomics
  "MRNA",
  "CRSP",
  "NTLA",
  "BEAM",
  "DNA",
  // AI infra / semis / networking
  "ARM",
  "MRVL",
  "SNPS",
  "ANET",
  "MU",
  // Clean energy & power
  "ENPH",
  "FSLR",
  "PLUG",
  "BE",
  // Crypto miners / sentiment
  "MARA",
  "RIOT",
  "CLSK",
  // Retail attention / volatile midcaps
  "GME",
  "AMC",
  "SOUN",
  "BBAI",
  "AI",
] as const;

/**
 * Niche-forward anchor set for the AI Discovery provider. A specialized,
 * recognizable spine (quantum, robotics, space, biotech, crypto miners, high-
 * beta growth, retail-attention) that guarantees coverage even when AI web
 * discovery is rate-limited or returns nothing. Mega-caps are intentionally
 * excluded so the feed stays specialized, not "Walmart-generic".
 */
export const NICHE_ANCHOR_TICKERS = [
  // Quantum & deep tech
  "IONQ",
  "RGTI",
  "QBTS",
  // Robotics & automation
  "SERV",
  "SYM",
  "PATH",
  // Space & aerospace
  "RKLB",
  "ASTS",
  "LUNR",
  "ACHR",
  // Biotech / genomics
  "CRSP",
  "NTLA",
  "BEAM",
  // AI / data platforms (mid-cap, not mega)
  "PLTR",
  "SOUN",
  "BBAI",
  // Energy transition & power
  "ENPH",
  "BE",
  // Crypto miners / sentiment
  "MARA",
  "RIOT",
  "CLSK",
  // Retail attention / volatile midcaps
  "GME",
  "AMC",
] as const;

export type RealUniverseTicker = (typeof REAL_UNIVERSE_TICKERS)[number];

const REAL_SET = new Set<string>(REAL_UNIVERSE_TICKERS);

/**
 * Membership in the curated ~75-name live-research universe (the seed for
 * Today's feed / Blueprint runs). This is the *small* hand-picked set - use it
 * to decide whether a ticker is a curated universe member, NOT whether it is a
 * real listed security.
 */
export function isCuratedResearchTicker(ticker: string): boolean {
  return REAL_SET.has(ticker.trim().toUpperCase());
}

/**
 * True when a query maps to a real listed security in the bundled offline symbol
 * directory (~13.8k US + CA listings). This is the "is this a findable, real
 * ticker?" gate that powers ad-hoc lookup - deliberately far broader than the
 * curated research universe ({@link isCuratedResearchTicker}). Suffix-tolerant
 * (".TO"/".V"/".NE") and case-insensitive via the directory resolver.
 */
export function isRealUniverseTicker(ticker: string): boolean {
  return isKnownSymbol(ticker);
}

export const REAL_UNIVERSE_SIZE = REAL_UNIVERSE_TICKERS.length;
