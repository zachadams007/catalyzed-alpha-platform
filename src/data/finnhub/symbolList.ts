import { finnhubKey, httpJson, type HttpGetOptions } from "@/data/http";

/**
 * The full U.S. common-stock symbol list - the top of the broad-universe funnel.
 *
 * Finnhub's `/stock/symbol?exchange=US` returns ~18k US-listed symbols (every
 * class: ETFs, warrants, units, rights, preferreds, ADRs…) in ONE free call. We
 * keep the tradable common-stock spine - ordinary shares, ADRs, and REITs with a
 * clean root ticker - and drop the derivatives/structured products the discovery
 * feed has no business ranking. The daily scan then bulk-snapshots this list and
 * pre-ranks it down to the names worth a full scoring pass.
 *
 * Pure parsing is exported separately so it's unit-testable without a network.
 */

const FINNHUB = "https://finnhub.io/api/v1";
/**
 * A healthy US common-stock spine is in the thousands. This is deliberately only
 * a minimum-coverage floor: crossing it detects the common exact-1,000 truncation
 * shape, but it does not prove the provider returned its complete current universe.
 * Tests may inject a lower adapter threshold; archive validation still requires
 * the production floor and quarantines completeness as unproven.
 */
export const FINNHUB_MIN_EXPECTED_ELIGIBLE = 1_001;

export interface FinnhubSymbolRow {
  symbol?: string;
  displaySymbol?: string;
  description?: string;
  type?: string;
  mic?: string;
  currency?: string;
}

/** Security types we keep - ordinary tradable equities (not ETPs/warrants/etc.). */
const KEPT_TYPES = new Set(["Common Stock", "ADR", "REIT"]);

/** A clean root ticker: 1–5 letters, no dots/dashes/digits (drops units, warrants,
 *  preferreds like ABC.U / ABC-PA / BRK.B). Keeps the discovery universe tradable. */
function isCleanRootTicker(symbol: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbol);
}

export interface ParseSymbolsOptions {
  /** Keep only these security types (default: Common Stock, ADR, REIT). */
  keepTypes?: Set<string>;
  /** Require currency to be USD (default true; empty currency is allowed). */
  requireUsd?: boolean;
}

/** One clean universe entry - ticker plus the listing's company name. */
export interface FinnhubSymbolEntry {
  symbol: string;
  name: string;
}

export type FinnhubUniverseFetchStatus =
  | "minimum_coverage_met"
  | "not_configured"
  | "request_failed"
  | "invalid_payload"
  | "empty_payload"
  | "empty_eligible"
  | "coverage_below_minimum";

/** Sanitized request evidence. It deliberately contains no URL query or key. */
export interface FinnhubUniverseFetchAudit {
  provider: "finnhub";
  endpoint: "/stock/symbol?exchange=US";
  status: FinnhubUniverseFetchStatus;
  requestedAtISO: string;
  receivedAtISO: string;
  rawRowCount: number;
  eligibleEntryCount: number;
  minimumExpectedEligibleCount: number;
}

export interface AuditedFinnhubUniverse {
  entries: FinnhubSymbolEntry[];
  audit: FinnhubUniverseFetchAudit;
}

interface FinnhubUniverseFetchDeps {
  getKey?: () => string | undefined;
  fetchJson?: (url: string, opts?: HttpGetOptions) => Promise<unknown>;
  now?: () => Date;
  minimumExpectedEligibleCount?: number;
}

/** Pure: filter + de-dupe a raw Finnhub symbol payload into clean entries. */
export function parseFinnhubSymbolEntries(
  rows: unknown,
  opts: ParseSymbolsOptions = {},
): FinnhubSymbolEntry[] {
  if (!Array.isArray(rows)) return [];
  const keep = opts.keepTypes ?? KEPT_TYPES;
  const requireUsd = opts.requireUsd ?? true;
  const seen = new Set<string>();
  const out: FinnhubSymbolEntry[] = [];

  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as FinnhubSymbolRow;
    const symbol = row.symbol?.trim().toUpperCase();
    if (!symbol || !isCleanRootTicker(symbol)) continue;
    if (row.type && !keep.has(row.type)) continue;
    if (!row.type) continue; // unknown type - be conservative, skip
    if (requireUsd && row.currency && row.currency.toUpperCase() !== "USD") continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name: titleCaseName(row.description) || symbol });
  }
  return out;
}

/** Pure: filter + de-dupe a raw Finnhub symbol payload into clean root tickers. */
export function parseFinnhubSymbols(rows: unknown, opts: ParseSymbolsOptions = {}): string[] {
  return parseFinnhubSymbolEntries(rows, opts).map((e) => e.symbol);
}

/** Finnhub descriptions are ALL CAPS ("ROCKET LAB CORP") - soften to title case. */
function titleCaseName(desc?: string): string {
  const raw = desc?.trim();
  if (!raw) return "";
  if (raw !== raw.toUpperCase()) return raw; // already mixed-case - leave it
  return raw
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/**
 * Fetch the clean U.S. common-stock universe (ticker + name). Returns [] on any
 * failure (never throws) so the scan can fall back to its always-include set.
 */
export async function fetchUsCommonStockUniverseAudited(
  deps: FinnhubUniverseFetchDeps = {},
): Promise<AuditedFinnhubUniverse> {
  const getKey = deps.getKey ?? finnhubKey;
  const fetchJson = deps.fetchJson ?? ((url, opts) => httpJson<unknown>(url, opts));
  const now = deps.now ?? (() => new Date());
  const minimumExpectedEligibleCount = Math.max(
    1,
    Math.floor(deps.minimumExpectedEligibleCount ?? FINNHUB_MIN_EXPECTED_ELIGIBLE),
  );
  const requestedAtISO = now().toISOString();
  const key = getKey();
  const finish = (
    status: FinnhubUniverseFetchStatus,
    entries: FinnhubSymbolEntry[] = [],
    rawRowCount = 0,
  ): AuditedFinnhubUniverse => ({
    entries,
    audit: {
      provider: "finnhub",
      endpoint: "/stock/symbol?exchange=US",
      status,
      requestedAtISO,
      receivedAtISO: now().toISOString(),
      rawRowCount,
      eligibleEntryCount: entries.length,
      minimumExpectedEligibleCount,
    },
  });

  if (!key) return finish("not_configured");
  try {
    const url = `${FINNHUB}/stock/symbol?exchange=US&token=${encodeURIComponent(key)}`;
    const rows = await fetchJson(url, { timeoutMs: 30_000 });
    if (!Array.isArray(rows)) return finish("invalid_payload");
    if (rows.length === 0) return finish("empty_payload");
    const entries = parseFinnhubSymbolEntries(rows);
    if (entries.length === 0) return finish("empty_eligible", [], rows.length);
    return finish(
      entries.length < minimumExpectedEligibleCount
        ? "coverage_below_minimum"
        : "minimum_coverage_met",
      entries,
      rows.length,
    );
  } catch {
    return finish("request_failed");
  }
}

export async function fetchUsCommonStockUniverse(): Promise<FinnhubSymbolEntry[]> {
  return (await fetchUsCommonStockUniverseAudited()).entries;
}

/** Convenience: just the tickers (kept for callers that don't need names). */
export async function fetchUsCommonStockSymbols(): Promise<string[]> {
  return (await fetchUsCommonStockUniverse()).map((e) => e.symbol);
}
