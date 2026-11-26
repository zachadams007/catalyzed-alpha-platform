import { httpJson, httpText } from "@/data/http";
import { secEndpoint } from "@/data/sec/secEndpoint";
import type { TerminalEvent } from "@/types/terminal";
import { classifyTradeSeverity } from "./severity";

/**
 * Market-wide insider BUYS (SEC Form 4) - keyless, authoritative, free.
 *
 * WHY THIS EXISTS
 * ---------------
 * FMP's `insider-trading/latest` is a premium endpoint (free tier 403s), so on a
 * keyless build the "Insider buys" lane comes back empty. SEC EDGAR is the
 * sanctioned, keyless source, so this builds the lane straight from Form 4
 * filings - exactly the "SoFi CEO bought shares" signal testers expect - and it
 * routes through the hosted proxy on every build:
 *   1. EDGAR full-text search (efts.sec.gov) lists recent Form 4 filings.
 *   2. Each filing's ownership XML (www.sec.gov/Archives) is fetched + parsed for
 *      open-market PURCHASES (transaction code "P") and notable sales ("S", ≥ $100K).
 *
 * Both SEC subdomains are reached the same way as the 8-K source: absolute URLs
 * that resolveMarketRequest rewrites to <proxy>/sec/… (the proxy's secOrigin()
 * routes /LATEST/search-index → efts and /Archives → www). On the Tauri desktop
 * build they go direct; only a dev browser without a proxy falls back to the
 * Vite `/__sec` proxy (which covers efts only - the per-filing XML then needs the
 * proxy, so dev-without-proxy degrades to the FMP/empty path, by design).
 *
 * Bounded by construction: we fetch at most MAX_DOCS of the newest filings with
 * limited concurrency and cache the result for CACHE_TTL_MS, so a refresh storm
 * can't hammer EDGAR (or the shared proxy). Discovery/research only.
 */

interface Form4Hit {
  accession: string;
  /** Filer CIK (from the accession prefix) - the Archives path segment. */
  cik: string;
  /** Ownership-XML filename from the FTS `_id`. */
  xmlFile: string;
  /** Filing date (when it was disclosed), ISO. */
  fileDateIso: string;
}

export interface Form4Transaction {
  /** SEC transaction code: P = open-market purchase, S = sale, A = award, … */
  code: string;
  shares: number;
  pricePerShare: number;
  /** "A" = acquired, "D" = disposed. */
  acquiredDisposed: "A" | "D" | "";
  /** Transaction date, ISO (falls back to the report period). */
  dateIso: string;
}

export interface Form4Doc {
  issuerSymbol: string;
  issuerName: string;
  ownerName: string;
  /** Human role, e.g. "CEO", "Director", "10% owner". */
  ownerRole: string;
  transactions: Form4Transaction[];
}

// Pull a wider slice of the newest filings (was 20) so a busy filing day can't
// crowd ~1-day-old notable trades out of the window before they're ever fetched.
const MAX_DOCS = 40;
const CONCURRENCY = 5;
// A full week of Form 4s (was 5d) so yesterday's notable buys AND sells still
// surface on the wire. Bounded by MAX_DOCS + the 10-min cache, so still cheap.
const LOOKBACK_DAYS = 7;
const FTS_TIMEOUT_MS = 12_000;
const XML_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/**
 * Surface open-market sales at or above this notional. Open-market buys are the
 * headline signal, but testers explicitly want to see notable SELLS too (e.g.
 * "who sold Nvidia yesterday"), so the floor is $100K - low enough to catch a
 * meaningful disposal, high enough to drop pure option-exercise / tax noise.
 * The per-actor cap upstream keeps even an active seller from flooding a tab.
 */
const MIN_SELL_USD = 100_000;

const USER_AGENT = "Catalyzed Alpha research (contact: contact@example.com)";
const HEADERS = { "User-Agent": USER_AGENT };

/** efts.sec.gov full-text search - via SEC proxy on the cloud scan (SEC blocks the
 *  GitHub IP), absolute on desktop, dev-proxy in the browser. See secEndpoint. */
function eftsSearchUrl(): string {
  return secEndpoint("efts", "/LATEST/search-index");
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

/** The 10-digit filer CIK lives in the accession prefix, e.g. 0002140696-26-000002. */
function cikFromAccession(accession: string): string {
  const head = accession.replace(/-/g, "").slice(0, 10);
  return String(parseInt(head, 10) || 0);
}

interface EftsSource {
  adsh?: string;
  ciks?: string[];
  file_date?: string;
  file_type?: string;
  root_forms?: string[];
}
interface EftsHit {
  _id?: string; // "<adsh>:<filename>"
  _source?: EftsSource;
}
interface EftsResponse {
  hits?: { hits?: EftsHit[] };
}

/** List the newest Form 4 filings, one hit per accession (collapse exhibits). */
export async function fetchForm4Hits(limit = MAX_DOCS, lookbackDays = LOOKBACK_DAYS): Promise<Form4Hit[]> {
  const today = new Date();
  const from = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const url =
    `${eftsSearchUrl()}?forms=4&dateRange=custom` +
    `&startdt=${ymd(from)}&enddt=${ymd(today)}`;

  const res = await httpJson<EftsResponse>(url, { headers: HEADERS, timeoutMs: FTS_TIMEOUT_MS });
  const hits = res.hits?.hits;
  if (!Array.isArray(hits)) return [];

  const seen = new Set<string>();
  const out: Form4Hit[] = [];
  for (const hit of hits) {
    const s = hit._source;
    const accession = s?.adsh || hit._id?.split(":")[0] || "";
    if (!accession || seen.has(accession)) continue;

    // Form 4 only (FTS `forms=4` can include 4/A amendments - keep those too).
    const form = (s?.file_type || s?.root_forms?.[0] || "4").toUpperCase();
    if (!form.startsWith("4")) continue;

    const xmlFile = (hit._id?.split(":")[1] ?? "").replace(/^.*\//, ""); // strip any xsl…/ prefix
    if (!/\.xml$/i.test(xmlFile)) continue; // need the machine-readable ownership XML

    seen.add(accession);
    out.push({
      accession,
      cik: cikFromAccession(accession),
      xmlFile,
      fileDateIso: safeIso(s?.file_date),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function archiveXmlUrl(hit: Form4Hit): string {
  const folder = hit.accession.replace(/-/g, "");
  return secEndpoint("www", `/Archives/edgar/data/${hit.cik}/${folder}/${hit.xmlFile}`);
}

function indexUrl(hit: Form4Hit): string {
  const folder = hit.accession.replace(/-/g, "");
  return secEndpoint("www", `/Archives/edgar/data/${hit.cik}/${folder}/${hit.accession}-index.htm`);
}

/** Read `<tag><value>X</value>` (Form 4 amounts nest their value), as a finite number. */
function nestedNumber(block: string, tag: string): number {
  const m = block.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`, "i"));
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function nestedText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`, "i"));
  return m ? m[1].trim() : "";
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
  return roles.join(" · ");
}

/**
 * Pure Form 4 ownership-XML parser (regex-based, no DOM - runs in node tests too).
 * Extracts the issuer, the reporting owner, and each non-derivative transaction.
 */
export function parseForm4Xml(xml: string): Form4Doc | null {
  if (typeof xml !== "string" || !xml.includes("<ownershipDocument")) return null;

  const issuerSymbol = tagText(xml, "issuerTradingSymbol").toUpperCase();
  const issuerName = tagText(xml, "issuerName");
  const ownerName = tagText(xml, "rptOwnerName");
  const ownerRole = parseOwnerRole(xml);

  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) ?? [];
  const transactions: Form4Transaction[] = [];
  for (const block of blocks) {
    const code = block.match(/<transactionCode>\s*([^<\s]+)\s*<\/transactionCode>/i)?.[1] ?? "";
    if (!code) continue;
    const ad = nestedText(block, "transactionAcquiredDisposedCode").toUpperCase();
    transactions.push({
      code: code.toUpperCase(),
      shares: nestedNumber(block, "transactionShares"),
      pricePerShare: nestedNumber(block, "transactionPricePerShare"),
      acquiredDisposed: ad === "A" ? "A" : ad === "D" ? "D" : "",
      dateIso: safeIso(nestedText(block, "transactionDate") || tagText(xml, "periodOfReport")),
    });
  }

  return { issuerSymbol, issuerName, ownerName, ownerRole, transactions };
}

/** Turn one parsed Form 4 into terminal events (open-market buys, notable sells). */
export function form4DocToEvents(doc: Form4Doc, hit: Form4Hit): TerminalEvent[] {
  if (!doc.issuerSymbol) return []; // need a ticker to be useful on the wire
  const out: TerminalEvent[] = [];
  const url = indexUrl(hit);
  const who = doc.ownerName || "Insider";

  for (let i = 0; i < doc.transactions.length; i++) {
    const t = doc.transactions[i];
    const direction = t.code === "P" ? "buy" : t.code === "S" ? "sell" : null;
    if (!direction) continue; // awards/exercises/gifts/tax are noise

    const valueUsd = t.shares > 0 && t.pricePerShare > 0 ? t.shares * t.pricePerShare : undefined;
    if (direction === "sell" && (valueUsd ?? 0) < MIN_SELL_USD) continue; // only big sells

    const { severity, reason } = classifyTradeSeverity(direction, valueUsd);
    out.push({
      id: `form4-${hit.accession}-${i}`,
      kind: direction === "buy" ? "insider_buy" : "insider_sell",
      severity,
      ticker: doc.issuerSymbol,
      companyName: doc.issuerName || undefined,
      headline:
        `${who} ${direction === "buy" ? "bought" : "sold"} ` +
        `${t.shares.toLocaleString("en-US")} ${doc.issuerSymbol} shares`,
      actor: { name: who, role: doc.ownerRole || undefined },
      trade: {
        direction,
        valueUsd,
        shares: t.shares || undefined,
        pricePerShare: t.pricePerShare || undefined,
        code: t.code,
      },
      occurredAt: t.dateIso,
      surfacedAt: hit.fileDateIso,
      source: { name: "SEC Form 4 · EDGAR", url },
      reason,
    });
  }
  return out;
}

/** Run an async mapper over items with a fixed concurrency ceiling. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

let cache: { at: number; events: TerminalEvent[] } | null = null;

/**
 * Fetch recent market-wide insider open-market buys (+ notable sells) from SEC
 * Form 4. Bounded + cached; degrades to [] on any error so it never blanks the
 * feed or throws into the render.
 */
export async function fetchSecForm4Insider(limit = MAX_DOCS): Promise<TerminalEvent[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.events;

  try {
    const hits = await fetchForm4Hits(limit);
    if (hits.length === 0) {
      cache = { at: Date.now(), events: [] };
      return [];
    }

    const parsed = await mapLimit(hits, CONCURRENCY, async (hit) => {
      try {
        const xml = await httpText(archiveXmlUrl(hit), { headers: HEADERS, timeoutMs: XML_TIMEOUT_MS });
        const doc = parseForm4Xml(xml);
        return doc ? form4DocToEvents(doc, hit) : [];
      } catch {
        return []; // one bad filing never sinks the lane
      }
    });

    const events = parsed.flat();
    cache = { at: Date.now(), events };
    return events;
  } catch {
    return []; // FTS failed entirely - honest empty state upstream
  }
}
