/**
 * Dual-listing resolver - turns a ticker/name query into the PRIMARY listing to
 * quote plus any genuine cross-border cross-listings of the SAME company.
 *
 * WHY THIS EXISTS
 * ---------------
 * Many names the owner researches list in more than one place - e.g. Shopify on
 * NASDAQ (`SHOP`, USD) and TSX (`SHOP.TO`, CAD), or Gunnison Copper only on TSX
 * (`GCU.TO`, CAD) with no senior US line at all. The app must:
 *   • quote the listing the user actually meant (the PRIMARY), with its real
 *     currency clearly labeled, and
 *   • surface the OTHER listing(s) on the detail view, brokerage-style.
 *
 * PRIMARY selection is intent-first: the offline directory's {@link getSymbol}
 * already resolves a bare base to the senior US line (`SHOP` → NASDAQ) and a
 * suffixed query to that exact listing (`SHOP.TO` → TSX, `GCU` → `GCU.TO` via
 * the suffix fallback). We honor that resolution as the headline; cross-listings
 * become alternates. A caller can pass a liquidity hint to order alternates
 * most-liquid first ("most-liquid breaks ties").
 *
 * CROSS-LISTING matching is HIGH PRECISION on purpose: two listings are linked
 * only when they share a base ticker AND a normalized company name. Base-ticker
 * alone is unsafe - `ABX` (NYSE) is now *Abacus Global Management* while `ABX.TO`
 * is *Barrick* (a recycled symbol), and `AAPL.TO` is an *Apple CDR derivative*,
 * not Apple's listing. Requiring the names to agree rejects all three.
 *
 * Pure + synchronous + dependency-light (directory reads only) so it stays
 * trivially testable and can run anywhere (app, tests, Node scripts).
 */

import { allSymbolRecords, getSymbol, type SymbolRecord } from "@/data/symbols/symbolDirectory";

export type ExchangeTier = "senior_us" | "senior_ca" | "venture" | "other";

export interface ResolvedListing {
  /** Directory symbol, e.g. "SHOP" or "GCU.TO". */
  symbol: string;
  name: string;
  /** Raw directory exchange, e.g. "NASDAQ", "TSX", "TSXV", "Cboe Canada". */
  exchange: string;
  /** Short display label, e.g. "NASDAQ", "TSX", "TSX-V", "Cboe CA". */
  exchangeLabel: string;
  country: "US" | "CA";
  /** Trading currency of this listing ("USD" for US, "CAD" for CA). */
  currency: "USD" | "CAD";
  isEtf: boolean;
  tier: ExchangeTier;
}

export interface ListingResolution {
  /** The listing to quote in the headline (intent-first). */
  primary: ResolvedListing;
  /** Genuine cross-border listings of the same company (most-liquid first). */
  alternates: ResolvedListing[];
}

export interface ResolveListingsOptions {
  /**
   * Optional per-symbol liquidity (e.g. dollar volume). Used ONLY to order the
   * alternates most-liquid-first - never to override the intent-resolved primary.
   */
  liquidity?: Record<string, number>;
}

const SUFFIX_RE = /\.(TO|V|NE)$/;

/** A short, human exchange label for the headline + cross-listing chips. */
export function exchangeShortLabel(exchange: string): string {
  switch (exchange) {
    case "TSX":
      return "TSX";
    case "TSXV":
      return "TSX-V";
    case "Cboe Canada":
      return "Cboe CA";
    case "NYSE American":
      return "NYSE American";
    case "NYSE Arca":
      return "NYSE Arca";
    default:
      // NASDAQ, NYSE, Cboe - already short.
      return exchange;
  }
}

/** Trading currency for a listing's country. */
export function listingCurrency(country: "US" | "CA"): "USD" | "CAD" {
  return country === "CA" ? "CAD" : "USD";
}

/** Coarse exchange tier used for ranking + labeling. */
export function exchangeTier(exchange: string, country: "US" | "CA"): ExchangeTier {
  if (country === "US") return "senior_us"; // NYSE / NASDAQ / AMEX / Arca / Cboe US
  if (exchange === "TSX") return "senior_ca";
  if (exchange === "TSXV") return "venture";
  return "other"; // Cboe Canada / anything else
}

/** Strip the Canadian exchange suffix (.TO/.V/.NE), leaving the base symbol. */
function stripExchangeSuffix(symbol: string): string {
  return symbol.replace(SUFFIX_RE, "");
}

/**
 * True when a (suffix-stripped) symbol looks like a plain common share - 1–6
 * letters with at most a single `-A`/`-B` dual-class qualifier. This EXCLUDES
 * preferreds (`MFC-PR-B`), warrants (`AEC-WT`), units, rights, and notes, which
 * must never be treated as a company's cross-listing.
 */
function isCommonShareBase(base: string): boolean {
  return /^[A-Z]{1,6}(-[AB])?$/.test(base);
}

/** Root used to match cross-listings: suffix + dual-class qualifier removed. */
function baseRoot(symbol: string): string {
  return stripExchangeSuffix(symbol).replace(/-[AB]$/, "");
}

const CORPORATE_STOPWORDS = new Set([
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "company",
  "co",
  "plc",
  "holdings",
  "holding",
  "group",
  "sa",
  "nv",
  "ag",
  "the",
  "common",
  "stock",
  "shares",
  "share",
  "ordinary",
  "class",
  "subordinate",
  "voting",
  "depositary",
  "depository",
  "new",
  "registry",
]);

/**
 * Normalize a listed company name to a comparable core, so two real listings of
 * the same company match across small directory differences (suffix words,
 * class descriptors, parentheticals, punctuation). E.g.
 *   "Shopify Inc. - Class A Subordinate Voting Shares" → "shopify"
 *   "Wheaton Precious Metals Corp Common Shares (Canada)" → "wheaton precious metals"
 *   "NexGen Energy Ltd." / "Nexgen Energy Ltd. Common Shares" → "nexgen energy"
 * while keeping distinct companies distinct (Abacus ≠ Barrick).
 */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .split(" - ")[0]! // drop class/series descriptor after " - "
    .replace(/\([^)]*\)/g, " ") // drop parentheticals like "(Canada)" / "(CAD Hedged)"
    .replace(/&/g, " and ")
    .replace(/[.,/]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !CORPORATE_STOPWORDS.has(w))
    .join(" ")
    .trim();
}

/** A CDR / depositary-receipt wrapper is a derivative, not a cross-listing. */
function isDerivativeName(name: string): boolean {
  return /\bCDR\b/i.test(name);
}

function toResolvedListing(record: SymbolRecord): ResolvedListing {
  return {
    symbol: record.symbol,
    name: record.name,
    exchange: record.exchange,
    exchangeLabel: exchangeShortLabel(record.exchange),
    country: record.country,
    currency: listingCurrency(record.country),
    isEtf: record.isEtf,
    tier: exchangeTier(record.exchange, record.country),
  };
}

const TIER_RANK: Record<ExchangeTier, number> = {
  senior_us: 3,
  senior_ca: 2,
  venture: 1,
  other: 0,
};

/**
 * Resolve a query into a PRIMARY listing + genuine cross-listings. Returns null
 * only when the query maps to no real listed security in the directory.
 */
export function resolveListings(
  query: string,
  opts: ResolveListingsOptions = {},
): ListingResolution | null {
  const record = getSymbol(query);
  if (!record) return null;

  const primary = toResolvedListing(record);

  // Cross-listings only apply to plain common shares - ETFs, CDRs, preferreds,
  // warrants, etc. resolve to themselves.
  const primaryBaseStripped = stripExchangeSuffix(record.symbol);
  if (record.isEtf || isDerivativeName(record.name) || !isCommonShareBase(primaryBaseStripped)) {
    return { primary, alternates: [] };
  }

  const root = baseRoot(record.symbol);
  const core = normalizeCompanyName(record.name);
  if (!core) return { primary, alternates: [] };

  const alternates: ResolvedListing[] = [];
  for (const r of allSymbolRecords()) {
    if (r.symbol === record.symbol) continue;
    if (r.country === record.country) continue; // cross-BORDER listings only
    if (r.isEtf || isDerivativeName(r.name)) continue;
    const stripped = stripExchangeSuffix(r.symbol);
    if (!isCommonShareBase(stripped)) continue;
    if (baseRoot(r.symbol) !== root) continue; // same base ticker …
    if (normalizeCompanyName(r.name) !== core) continue; // … AND same company name
    alternates.push(toResolvedListing(r));
  }

  const liquidity = opts.liquidity ?? {};
  alternates.sort((a, b) => {
    const la = liquidity[a.symbol] ?? -1;
    const lb = liquidity[b.symbol] ?? -1;
    if (la !== lb) return lb - la; // most-liquid first
    return TIER_RANK[b.tier] - TIER_RANK[a.tier]; // else senior exchange first
  });

  return { primary, alternates };
}
