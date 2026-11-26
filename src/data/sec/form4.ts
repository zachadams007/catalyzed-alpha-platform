import type { SecActivity, SecFiling } from "@/types";
import { httpText } from "@/data/http";

/**
 * Form 4 buy/sell parser - a SINGLE-TICKER deep dive only.
 *
 * `secFilings.ts` deliberately surfaces COUNTS (cheap, one request per company)
 * so it can run across the whole universe. Parsing actual buy/sell amounts means
 * fetching each Form 4's XML, which is too many requests to do universe-wide
 * under SEC's fair-access policy. So this runs lazily, on demand, from the stock
 * detail page for one ticker at a time.
 *
 * EDGAR's `primaryDocument` for a Form 4 is the XSL-rendered HTML view, e.g.
 *   .../<accession>/xslF345X06/form4.xml
 * The raw machine-readable ownership XML lives at the same path with the
 * `xsl…/` segment stripped:
 *   .../<accession>/form4.xml
 *
 * Transaction codes we score: P = open-market purchase (buy), S = open-market
 * sale (sell). Other codes (A award, G gift, M exercise, F tax) are ignored so
 * the summary reflects discretionary open-market activity. Degrades silently on
 * any failure - a missing or partial summary just isn't shown.
 */

const USER_AGENT = "Catalyzed Alpha research (contact: contact@example.com)";
const HEADERS = { "User-Agent": USER_AGENT };
const FETCH_TIMEOUT_MS = 10_000;
/** Cap requests per deep dive - newest Form 4s only, to respect rate limits. */
const MAX_FORM4_DOCS = 8;
/** Maximum per-transaction detail rows surfaced in the UI (newest first). */
const MAX_DETAIL_ROWS = 6;

/**
 * One per-transaction insider detail row, extracted from the ownership XML.
 * Shown as a Bloomberg-style row in SecFilingsPanel: "CEO bought 12,500 sh · Jun 18".
 *
 * NOTE: US EDGAR provides Form 4 data for US-listed securities only.
 * Canadian insider transactions (TSX: TD.TO, RY.TO, etc.) are filed with
 * Canada's SEDI (System for Electronic Disclosure by Insiders) - a separate
 * source not yet integrated here.
 */
export interface Form4InsiderRow {
  /** Full name as reported on the Form 4 (e.g. "Anthony Noto"). */
  insiderName: string;
  /** Role label, e.g. "CEO", "CFO", "Director", "10% owner". */
  insiderRole: string;
  /** "buy" (P code) or "sell" (S code). */
  direction: "buy" | "sell";
  shares: number;
  pricePerShare: number;
  /** Approximate dollar value (shares × price). 0 when price is unavailable. */
  valueUsd: number;
  /** ISO transaction date. */
  date: string;
  /** Direct link to the filing index on sec.gov. */
  edgarUrl: string;
}

export interface Form4TradeSummary {
  /** Count of open-market purchase (P) transactions across the parsed filings. */
  buys: number;
  /** Count of open-market sale (S) transactions. */
  sells: number;
  /** Dollar value bought (Σ shares × price for P transactions). */
  buyValue: number;
  /** Dollar value sold (Σ shares × price for S transactions). */
  sellValue: number;
  /** buyValue − sellValue. Positive = net insider buying. */
  netValue: number;
  /** How many Form 4 documents were successfully fetched + parsed. */
  filingsParsed: number;
  /** Human one-liner, e.g. "2 buys, 1 sell, net +$1.2M". */
  summary: string;
  /**
   * Per-transaction detail rows (newest first, capped at MAX_DETAIL_ROWS).
   * Each row has the insider's name, role, direction, shares, value, date,
   * and a direct EDGAR link. Empty when the filing didn't yield open-market
   * P/S transactions.
   */
  insiderRows: Form4InsiderRow[];
}

interface ParsedTxns {
  buys: number;
  sells: number;
  buyValue: number;
  sellValue: number;
  rows: Form4InsiderRow[];
}

/** Turn an XSL-rendered Form 4 URL into its raw ownership-XML URL. */
function rawXmlUrl(filing: SecFiling): string | null {
  if (!/\.xml$/i.test(filing.url)) return null;
  return filing.url.replace(/\/xsl[^/]*\//i, "/");
}

/** Turn the raw XML URL back into the human-friendly EDGAR filing index URL. */
function edgarIndexUrl(xmlUrl: string): string {
  // Strip the filename to get the accession folder, then append -index.htm.
  // e.g. https://www.sec.gov/Archives/edgar/data/1341439/000134143925000001/form4.xml
  //   -> https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&... (simplest: just the folder)
  // We use the folder index which always exists:
  //   .../Archives/edgar/data/<cik>/<accFolder>/<accFolder>-index.htm  (not always present)
  // Safest: just return the Archives folder URL (removing the filename).
  return xmlUrl.replace(/\/[^/]+\.xml$/i, "/");
}

function firstValue(block: string, tag: string): number {
  const m = block.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`, "i"));
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function tagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

function isTrueFlag(xml: string, tag: string): boolean {
  const v = tagText(xml, tag).toLowerCase();
  return v === "1" || v === "true";
}

/** Build a short owner role label from the reportingOwnerRelationship block. */
function parseOwnerRole(xml: string): string {
  const officerTitle = tagText(xml, "officerTitle");
  const roles: string[] = [];
  if (isTrueFlag(xml, "isOfficer")) roles.push(officerTitle || "Officer");
  if (isTrueFlag(xml, "isDirector")) roles.push("Director");
  if (isTrueFlag(xml, "isTenPercentOwner")) roles.push("10% owner");
  return roles.join(" / ") || "Insider";
}

/**
 * Sum P (buy) / S (sell) open-market transactions in one Form 4 XML document,
 * and also extract per-row insider detail (name, role, shares, price, date).
 * The `xmlUrl` is passed through so the EDGAR link can be attached to each row.
 */
function parseForm4Xml(xml: string, xmlUrl: string, filingDate: string): ParsedTxns {
  const out: ParsedTxns = { buys: 0, sells: 0, buyValue: 0, sellValue: 0, rows: [] };
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi);
  if (!blocks) return out;

  // Extract the insider's name and role once per filing (applies to all txns).
  const insiderName = tagText(xml, "rptOwnerName") || "Insider";
  const insiderRole = parseOwnerRole(xml);
  const edgarUrl = edgarIndexUrl(xmlUrl);

  for (const block of blocks) {
    const code = block.match(/<transactionCode>\s*([^<\s]+)\s*<\/transactionCode>/i)?.[1];
    if (code !== "P" && code !== "S") continue;
    const shares = firstValue(block, "transactionShares");
    const pricePerShare = firstValue(block, "transactionPricePerShare");
    const valueUsd = shares * pricePerShare;
    // Transaction date: prefer the per-transaction date, fall back to filing date.
    const txDateRaw =
      block.match(/<transactionDate>\s*<value>([^<]*)<\/value>/i)?.[1]?.trim() ||
      filingDate;
    const txDate = txDateRaw.length >= 10 ? txDateRaw.slice(0, 10) : filingDate.slice(0, 10);
    if (code === "P") {
      out.buys++;
      out.buyValue += valueUsd;
      out.rows.push({ insiderName, insiderRole, direction: "buy", shares, pricePerShare, valueUsd, date: txDate, edgarUrl });
    } else {
      out.sells++;
      out.sellValue += valueUsd;
      out.rows.push({ insiderName, insiderRole, direction: "sell", shares, pricePerShare, valueUsd, date: txDate, edgarUrl });
    }
  }
  return out;
}

/** Compact signed USD, e.g. +$1.2M, -$420K, $0. */
function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1e9) body = `$${(abs / 1e9).toFixed(1)}B`;
  else if (abs >= 1e6) body = `$${(abs / 1e6).toFixed(1)}M`;
  else if (abs >= 1e3) body = `$${(abs / 1e3).toFixed(0)}K`;
  else body = `$${abs.toFixed(0)}`;
  return `${sign}${body}`;
}

function buildSummary(s: Pick<Form4TradeSummary, "buys" | "sells" | "netValue">): string {
  return [
    `${s.buys} buy${s.buys === 1 ? "" : "s"}`,
    `${s.sells} sell${s.sells === 1 ? "" : "s"}`,
    `net ${formatSignedUsd(s.netValue)}`,
  ].join(", ");
}

/**
 * Parse the most recent Form 4 filings already discovered for one ticker into a
 * buy/sell summary. Pass the ticker's `secActivity` (its `filings` already hold
 * the Form 4 document links). Returns null when there are no Form 4s, nothing
 * parses, or the network is unavailable - callers should treat null as "no data".
 */
export async function fetchForm4TradeSummary(
  activity: SecActivity | null | undefined,
): Promise<Form4TradeSummary | null> {
  if (!activity) return null;

  const form4Filings = (activity.filings ?? []).filter((f) => f.form === "4");
  const urlPairs = form4Filings
    .map((f) => ({ rawUrl: rawXmlUrl(f), filedAt: f.filedAt }))
    .filter((p): p is { rawUrl: string; filedAt: string } => Boolean(p.rawUrl))
    .slice(0, MAX_FORM4_DOCS);
  if (urlPairs.length === 0) return null;

  const agg: ParsedTxns = { buys: 0, sells: 0, buyValue: 0, sellValue: 0, rows: [] };
  let filingsParsed = 0;

  for (const { rawUrl, filedAt } of urlPairs) {
    try {
      const xml = await httpText(rawUrl, { headers: HEADERS, timeoutMs: FETCH_TIMEOUT_MS });
      const parsed = parseForm4Xml(xml, rawUrl, filedAt);
      agg.buys += parsed.buys;
      agg.sells += parsed.sells;
      agg.buyValue += parsed.buyValue;
      agg.sellValue += parsed.sellValue;
      agg.rows.push(...parsed.rows);
      filingsParsed++;
    } catch {
      // Skip this document; a partial read is still useful.
    }
  }

  // Null means "couldn't read any filing" (network/parse failure) - the panel
  // degrades silently. A successful parse that found zero open-market trades is
  // NOT null: we return buys=0/sells=0 so the panel can say "grants/exercises
  // only" instead of looking half-rendered.
  if (filingsParsed === 0) return null;

  // Sort newest-first by transaction date, then cap to the display limit.
  const insiderRows = agg.rows
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_DETAIL_ROWS);

  const netValue = agg.buyValue - agg.sellValue;
  return {
    buys: agg.buys,
    sells: agg.sells,
    buyValue: agg.buyValue,
    sellValue: agg.sellValue,
    netValue,
    filingsParsed,
    summary: buildSummary({ buys: agg.buys, sells: agg.sells, netValue }),
    insiderRows,
  };
}
