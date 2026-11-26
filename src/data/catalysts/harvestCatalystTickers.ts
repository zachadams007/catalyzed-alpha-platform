import { httpJson, httpText } from "@/data/http";
import { secEndpoint } from "@/data/sec/secEndpoint";

/**
 * Market-wide catalyst-ticker harvest for pre-rank seed injection.
 *
 * Returns the set of tickers that FILED a material event in the look-back
 * window - 8-K material items, Form 4 open-market code-P buys, SC 13D/13G
 * activist + institutional stakes - so those names are guaranteed to be
 * scored even if they would otherwise miss the top-500 liquidity cut.
 *
 * SOURCES (all $0, keyless):
 *   • SEC 8-K EFTS (EDGAR full-text search) - items 1.01/2.01/2.02/5.01/5.02
 *   • SEC Form 4 EFTS → per-filing XML → code-P open-market buys only
 *   • SEC SC 13D / SC 13G EFTS
 *
 * Contract:
 *   • Every SEC request carries the required User-Agent header (env SEC_UA
 *     overrides; 403 = blocked ~10 min without it).
 *   • Paced at ~9 req/s (110ms gap) to stay inside SEC's 10 req/s fair-use cap.
 *   • Degrades silently: any failure returns the empty-result sentinel so the
 *     scan continues without catalyst seeds rather than crashing.
 *   • Runs under vite-node (Node 22) and GitHub Actions - pure fetch + standard
 *     Node APIs only (no DOM, no Tauri, no browser-only globals).
 *
 * The pure helper functions (parseDisplayNameTicker, keepableItems,
 * containsCodeP, extractIssuerSymbol) are exported for unit testing.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface HarvestResult {
  tickers: Set<string>;
  bySource: { eightK: number; insider: number; thirteenD: number };
}

const EMPTY_RESULT: HarvestResult = {
  tickers: new Set<string>(),
  bySource: { eightK: 0, insider: 0, thirteenD: 0 },
};

// ── Constants ──────────────────────────────────────────────────────────────

/** SEC fair-use User-Agent (required - 403 without it). Env override: SEC_UA. */
function secUserAgent(): string {
  // process.env works in Node/vite-node; gracefully absent in browser (harvest
  // is scan-only, but we guard anyway so the module doesn't throw on import).
  // Access via bracket notation on a loosely-typed global to avoid TS errors
  // in the browser-lib tsconfig (which doesn't include @types/node).
  const nodeEnv = (
    typeof globalThis !== "undefined"
      ? (globalThis as Record<string, unknown>)["process"]
      : undefined
  ) as { env?: Record<string, string | undefined> } | undefined;
  const override =
    nodeEnv?.env?.["SEC_UA"] ??
    (import.meta.env as Record<string, string | undefined>)["SEC_UA"];
  return override?.trim() || "Catalyzed Alpha contact@example.com";
}

const SEC_TIMEOUT_MS = 15_000;
/** 8-K look-back for the harvest (7 days). */
const EIGHTK_LOOKBACK_DAYS = 7;
/** Form 4 look-back (3 days; we cap total XML fetches, not the window). */
const FORM4_LOOKBACK_DAYS = 3;
/** SC 13D/13G look-back. */
const THIRTEEND_LOOKBACK_DAYS = 7;

/** Max EFTS pages for 8-K harvest (100 hits/page; 5 pages = 500 filings). */
const EIGHTK_MAX_PAGES = 5;
/** Hard cap on Form 4 XML fetches (rate-limit buffer). */
const FORM4_MAX_XML_FETCHES = 150;
/** Max Form 4 EFTS hits to collect before XML stage. */
const FORM4_MAX_HITS = 200;
/** Concurrency cap for Form 4 XML fetches (SEC rate limit). */
const FORM4_XML_CONCURRENCY = 5;

/**
 * 8-K item codes we treat as catalyst-active. Skip-only-9.01 guard is in
 * `keepableItems` - these are the POSITIVE keep set.
 */
const KEEP_ITEMS = new Set(["1.01", "2.01", "2.02", "5.01", "5.02"]);

/** Minimum ms gap between SEC requests (~9 req/s, inside the 10/s cap). */
const SEC_PACE_MS = 110;

// ── Pure helpers (exported for unit tests) ─────────────────────────────────

/**
 * Extract the ticker from the LAST parenthesised group in an EDGAR display_name,
 * ignoring the trailing "(CIK …)" group.
 *
 * Examples:
 *   "American Outdoor Brands, Inc.  (AOUT)  (CIK 0001808997)" → "AOUT"
 *   "Acme Corp (ACME)" → "ACME"
 *   "No Ticker Corp" → ""
 *
 * The CIK group is always "(CIK <digits>)" - we strip it first, then pick the
 * last remaining "(<TICKER>)" group. Tickers are ≤5 uppercase A-Z chars with
 * an optional dot (e.g. "BRK.B").
 */
export function parseDisplayNameTicker(displayName: string): string {
  if (!displayName) return "";
  // Strip trailing "(CIK …)" group (case-insensitive, possibly multiple spaces).
  const withoutCik = displayName.replace(/\s*\(CIK\s+\d+\)\s*$/i, "").trim();
  // Find the last "(TICKER)" group - 1–5 uppercase letters, optional dot.
  const m = withoutCik.match(/\(([A-Z][A-Z0-9.]{0,4})\)\s*$/);
  return m ? m[1]!.trim() : "";
}

/**
 * Given the `items` array from an EFTS 8-K hit, return true when the filing
 * should be counted as catalyst-active:
 *   • At least one item code in KEEP_ITEMS is present.
 *   • The filing is NOT exhibits-only (i.e. not ONLY 9.01 / unmapped codes).
 *
 * Item codes arrive as e.g. "1.01" or "Item 1.01" - normalise before lookup.
 */
export function keepableItems(rawItems: string[]): boolean {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return false;
  for (const raw of rawItems) {
    const code = raw.replace(/^item\s*/i, "").trim();
    if (KEEP_ITEMS.has(code)) return true;
  }
  return false;
}

/**
 * Detect an open-market purchase (code "P") in a Form 4 XML string.
 * Scans every <transactionCode> element in the document.
 */
export function containsCodeP(xmlText: string): boolean {
  // Match all transactionCode elements (there can be several per filing).
  const matches = xmlText.matchAll(/<transactionCode>([^<]*)<\/transactionCode>/gi);
  for (const m of matches) {
    if (m[1]!.trim().toUpperCase() === "P") return true;
  }
  return false;
}

/**
 * Extract the issuer trading symbol from a Form 4 XML string.
 * Returns an uppercase ticker or "" when absent/malformed.
 */
export function extractIssuerSymbol(xmlText: string): string {
  const m = xmlText.match(/<issuerTradingSymbol>([^<]*)<\/issuerTradingSymbol>/i);
  const raw = m ? m[1]!.trim() : "";
  return raw.toUpperCase();
}

/**
 * True for a valid US-listable ticker: 1-5 uppercase A-Z with an optional dot,
 * no leading/trailing whitespace, no numbers-only. Drops OTC/junk/empty strings.
 */
export function isValidTicker(t: string): boolean {
  return /^[A-Z][A-Z.]{0,4}$/.test(t);
}

// ── Rate-pacing helper ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── EFTS helpers ────────────────────────────────────────────────────────────

function eftsBase(): string {
  return secEndpoint("efts", "/LATEST/search-index");
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface EftsSource {
  adsh?: string;
  ciks?: string[];
  display_names?: string[];
  file_date?: string;
  file_type?: string;
  root_forms?: string[];
  items?: string[];
}
interface EftsHit {
  _id?: string;
  _source?: EftsSource;
}
interface EftsResponse {
  hits?: {
    total?: { value?: number };
    hits?: EftsHit[];
  };
}

// ── 8-K harvest ─────────────────────────────────────────────────────────────

/**
 * Harvest catalyst-active tickers from SEC 8-K filings filed in the last
 * EIGHTK_LOOKBACK_DAYS days. Pages EFTS in 100-hit increments up to
 * EIGHTK_MAX_PAGES. Returns { tickers, count }.
 */
async function harvest8K(ua: string): Promise<{ tickers: Set<string>; count: number }> {
  const tickers = new Set<string>();
  const today = new Date();
  const from = new Date(today.getTime() - EIGHTK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startdt = ymd(from);
  const enddt = ymd(today);

  let page = 0;
  let totalHits = Infinity;

  while (page < EIGHTK_MAX_PAGES && page * 100 < totalHits) {
    if (page > 0) await sleep(SEC_PACE_MS);
    const from100 = page * 100;
    const url =
      `${eftsBase()}?forms=8-K&dateRange=custom&startdt=${startdt}&enddt=${enddt}` +
      `&from=${from100}`;

    const res = await httpJson<EftsResponse>(url, {
      headers: { "User-Agent": ua },
      timeoutMs: SEC_TIMEOUT_MS,
    });

    // Capture total on first page.
    if (page === 0) {
      const tv = res.hits?.total?.value;
      totalHits = typeof tv === "number" && tv > 0 ? tv : 0;
      if (totalHits === 0) break;
    }

    const hits = res.hits?.hits;
    if (!Array.isArray(hits) || hits.length === 0) break;

    for (const hit of hits) {
      const s = hit._source;
      if (!s) continue;
      // Filter by item codes first (fast, no extra fetch).
      const rawItems: string[] = Array.isArray(s.items) ? s.items : [];
      if (!keepableItems(rawItems)) continue;
      // Parse ticker from display_names[0].
      const dn = s.display_names?.[0] ?? "";
      const ticker = parseDisplayNameTicker(dn);
      if (ticker && isValidTicker(ticker)) tickers.add(ticker);
    }

    page++;
  }

  return { tickers, count: tickers.size };
}

// ── Form 4 harvest ───────────────────────────────────────────────────────────

interface Form4Hit {
  accession: string;
  cik: string;
  xmlFile: string;
}

/** Extract 10-digit CIK from an EFTS Form 4 hit. */
function cikFromSource(s: EftsSource, accession: string): string {
  // ciks[] is the most reliable source; fall back to accession prefix.
  const raw = s.ciks?.[0] ?? accession.replace(/-/g, "").slice(0, 10);
  return String(parseInt(raw, 10) || 0);
}

/**
 * Collect EFTS Form 4 envelope hits (no XML yet), capped at FORM4_MAX_HITS.
 * Uses only a 3-day window; the XML fetch stage is the bottleneck.
 */
async function collectForm4Hits(ua: string): Promise<Form4Hit[]> {
  const today = new Date();
  const from = new Date(today.getTime() - FORM4_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const url =
    `${eftsBase()}?forms=4&dateRange=custom` +
    `&startdt=${ymd(from)}&enddt=${ymd(today)}`;

  const res = await httpJson<EftsResponse>(url, {
    headers: { "User-Agent": ua },
    timeoutMs: SEC_TIMEOUT_MS,
  });

  const hits = res.hits?.hits;
  if (!Array.isArray(hits)) return [];

  const seen = new Set<string>();
  const out: Form4Hit[] = [];

  for (const hit of hits) {
    if (out.length >= FORM4_MAX_HITS) break;
    const s = hit._source;
    const accession = s?.adsh || hit._id?.split(":")[0] || "";
    if (!accession || seen.has(accession)) continue;
    const form = (s?.file_type || s?.root_forms?.[0] || "4").toUpperCase();
    if (!form.startsWith("4")) continue;
    // The XML filename lives in the _id after the colon: "<adsh>:<path/form4.xml>"
    const xmlFile = (hit._id?.split(":")[1] ?? "").replace(/^.*\//, "");
    if (!xmlFile || !/\.xml$/i.test(xmlFile)) continue;
    seen.add(accession);
    out.push({ accession, cik: cikFromSource(s ?? {}, accession), xmlFile });
  }
  return out;
}

/** Fetch and parse one Form 4 XML; return ticker if it contains code-P buys. */
async function fetchForm4Ticker(hit: Form4Hit, ua: string): Promise<string> {
  const folder = hit.accession.replace(/-/g, "");
  const url = secEndpoint(
    "www",
    `/Archives/edgar/data/${hit.cik}/${folder}/${hit.xmlFile}`,
  );
  const xml = await httpText(url, {
    headers: { "User-Agent": ua },
    timeoutMs: SEC_TIMEOUT_MS,
  });
  if (!containsCodeP(xml)) return "";
  return extractIssuerSymbol(xml);
}

/**
 * Harvest tickers from Form 4 open-market purchases (code P) filed in the
 * last FORM4_LOOKBACK_DAYS days. Caps XML fetches at FORM4_MAX_XML_FETCHES
 * with FORM4_XML_CONCURRENCY parallel requests (paced).
 */
async function harvestInsiderBuys(ua: string): Promise<{ tickers: Set<string>; count: number }> {
  const tickers = new Set<string>();
  const hits = await collectForm4Hits(ua);
  // Take only the first N hits for XML fetching.
  const toFetch = hits.slice(0, FORM4_MAX_XML_FETCHES);

  // Batched fetch with concurrency cap + inter-batch pace.
  for (let i = 0; i < toFetch.length; i += FORM4_XML_CONCURRENCY) {
    if (i > 0) await sleep(SEC_PACE_MS * FORM4_XML_CONCURRENCY);
    const batch = toFetch.slice(i, i + FORM4_XML_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((h) => fetchForm4Ticker(h, ua)),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value && isValidTicker(r.value)) {
        tickers.add(r.value);
      }
    }
  }

  return { tickers, count: tickers.size };
}

// ── SC 13D / 13G harvest ─────────────────────────────────────────────────────

/**
 * Fetch one EFTS form-type query and extract issuer tickers from display_names[0].
 * SC 13D/G: the ISSUER (the stock the stake is IN) is the first display_name entry;
 * the FILER is the second. Same parseDisplayNameTicker logic applies.
 */
async function fetchThirteenDForm(
  forms: string,
  startdt: string,
  enddt: string,
  ua: string,
  limit: number,
): Promise<Set<string>> {
  const url = `${eftsBase()}?forms=${forms}&startdt=${startdt}&enddt=${enddt}`;
  const res = await httpJson<EftsResponse>(url, {
    headers: { "User-Agent": ua },
    timeoutMs: SEC_TIMEOUT_MS,
  });

  const hits = res.hits?.hits;
  if (!Array.isArray(hits)) return new Set();

  const seen = new Set<string>();
  const tickers = new Set<string>();
  let count = 0;

  for (const hit of hits) {
    if (count >= limit) break;
    const s = hit._source;
    if (!s) continue;
    const accession = s.adsh || hit._id?.split(":")[0] || "";
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    // For 13D/G the ISSUER is display_names[0].
    const dn = s.display_names?.[0] ?? "";
    const ticker = parseDisplayNameTicker(dn);
    if (ticker && isValidTicker(ticker)) tickers.add(ticker);
    count++;
  }

  return tickers;
}

/**
 * Harvest tickers from SC 13D, SC 13D/A, and SC 13G filings filed in the last
 * THIRTEEND_LOOKBACK_DAYS days. Two paced EFTS calls. Degrades to empty set.
 */
async function harvest13D(ua: string): Promise<{ tickers: Set<string>; count: number }> {
  const today = new Date();
  const from = new Date(today.getTime() - THIRTEEND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startdt = ymd(from);
  const enddt = ymd(today);
  const LIMIT = 200;

  // Fetch 13D (activist) and 13G (passive) in sequence, paced.
  const dTickers = await fetchThirteenDForm(
    "SC+13D%2CSC+13D%2FA",
    startdt,
    enddt,
    ua,
    LIMIT,
  );
  await sleep(SEC_PACE_MS);
  const gTickers = await fetchThirteenDForm(
    "SC+13G%2CSC+13G%2FA",
    startdt,
    enddt,
    ua,
    LIMIT,
  );

  const tickers = new Set<string>([...dTickers, ...gTickers]);
  return { tickers, count: tickers.size };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Harvest catalyst-active tickers from SEC EDGAR for the daily scan's
 * pre-rank seed injection. All three sources run in parallel; any individual
 * failure degrades to 0 seeds from that source (never throws).
 *
 * Return shape is EXACTLY what scan.mts expects:
 *   `Promise<{ tickers: Set<string>; bySource: { eightK: number; insider: number; thirteenD: number } }>`
 */
export async function harvestCatalystActiveTickers(): Promise<HarvestResult> {
  try {
    const ua = secUserAgent();

    // All three sources in parallel - each has its own internal pacing.
    const [eightKResult, insiderResult, thirteenDResult] = await Promise.allSettled([
      harvest8K(ua).catch(() => ({ tickers: new Set<string>(), count: 0 })),
      harvestInsiderBuys(ua).catch(() => ({ tickers: new Set<string>(), count: 0 })),
      harvest13D(ua).catch(() => ({ tickers: new Set<string>(), count: 0 })),
    ]);

    const eightK =
      eightKResult.status === "fulfilled"
        ? eightKResult.value
        : { tickers: new Set<string>(), count: 0 };
    const insider =
      insiderResult.status === "fulfilled"
        ? insiderResult.value
        : { tickers: new Set<string>(), count: 0 };
    const thirteenD =
      thirteenDResult.status === "fulfilled"
        ? thirteenDResult.value
        : { tickers: new Set<string>(), count: 0 };

    const tickers = new Set<string>([
      ...eightK.tickers,
      ...insider.tickers,
      ...thirteenD.tickers,
    ]);

    return {
      tickers,
      bySource: {
        eightK: eightK.count,
        insider: insider.count,
        thirteenD: thirteenD.count,
      },
    };
  } catch {
    // Top-level safety net - should never reach here, but never throw.
    return { ...EMPTY_RESULT, tickers: new Set<string>() };
  }
}
