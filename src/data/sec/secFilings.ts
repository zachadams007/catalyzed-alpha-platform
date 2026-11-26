import type { SecActivity, SecFiling } from "@/types";
import { httpJson } from "@/data/http";

/**
 * SEC EDGAR - free, keyless filing data. The single highest-value "real
 * research" source: insider transactions (Form 4) and material events (8-K),
 * straight from the official regulator. Discovery/research only.
 *
 * Two endpoints:
 *   1. ticker -> CIK map (fetched + cached once per session)
 *   2. per-company submissions feed (Form 3/4/5, 8-K, 10-K, …)
 *
 * SEC requires a descriptive User-Agent with contact info. Tauri's HTTP layer
 * can set it (and bypasses CORS); a plain browser cannot set User-Agent, so in
 * the dev server this degrades to empty - the desktop app is the target.
 *
 * We surface COUNTS + recency + direct links, not parsed buy/sell amounts
 * (that needs fetching each Form 4 XML - too many requests across a universe;
 * planned as a follow-up for single-ticker deep dives).
 */

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS = (cik10: string) => `https://data.sec.gov/submissions/CIK${cik10}.json`;
/** SEC fair-access policy: identify the client with a contact. */
export const USER_AGENT = "Catalyzed Alpha research (contact: contact@example.com)";
// Only User-Agent - SEC requires it and Tauri allows it. (Accept-Encoding is a
// forbidden fetch header; Tauri strips it and warns, so we don't set it.)
const HEADERS = { "User-Agent": USER_AGENT };

const LOOKBACK_DAYS = 90;
const MAX_FILINGS = 10;
const FETCH_TIMEOUT_MS = 12_000;

// --- ticker -> CIK index ---------------------------------------------------

interface TickerRow {
  cik_str?: number;
  ticker?: string;
  title?: string;
}

let cikIndexPromise: Promise<Map<string, string>> | null = null;

function pad10(cik: number): string {
  return String(cik).padStart(10, "0");
}

async function buildCikIndex(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const raw = await httpJson<Record<string, TickerRow>>(TICKERS_URL, {
    headers: HEADERS,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  for (const row of Object.values(raw ?? {})) {
    const ticker = row.ticker?.trim().toUpperCase();
    if (ticker && typeof row.cik_str === "number" && !map.has(ticker)) {
      map.set(ticker, pad10(row.cik_str));
    }
  }
  return map;
}

/** Load (and memoize) the SEC ticker -> CIK map for this session. */
export function loadCikIndex(): Promise<Map<string, string>> {
  if (!cikIndexPromise) {
    cikIndexPromise = buildCikIndex().catch(() => new Map<string, string>());
  }
  return cikIndexPromise;
}

// --- submissions feed ------------------------------------------------------

interface RecentFilings {
  form?: string[];
  filingDate?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
}
interface Submissions {
  filings?: { recent?: RecentFilings };
}

function withinLookback(isoDate: string): boolean {
  const t = new Date(isoDate).getTime();
  return Number.isFinite(t) && t >= Date.now() - LOOKBACK_DAYS * 86_400_000;
}

/** Build the sec.gov document link for an accession + primary document. */
function filingUrl(cik10: string, accession: string, doc: string): string {
  const cikInt = String(Number(cik10)); // EDGAR archive path uses the un-padded CIK
  const accNoDashes = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/${doc}`;
}

function summarize(cik10: string, recent: RecentFilings): SecActivity {
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const accessions = recent.accessionNumber ?? [];
  const docs = recent.primaryDocument ?? [];

  let form4Count90d = 0;
  let eightKCount90d = 0;
  let latestForm4Date: string | undefined;
  let latestEightKDate: string | undefined;
  const filings: SecFiling[] = [];

  for (let i = 0; i < forms.length; i++) {
    const form = forms[i]?.trim();
    const filedAt = dates[i];
    if (!form || !filedAt || !withinLookback(filedAt)) continue;

    const isForm4 = form === "4";
    const isEightK = form === "8-K";
    if (!isForm4 && !isEightK) continue;

    if (isForm4) {
      form4Count90d++;
      if (!latestForm4Date) latestForm4Date = filedAt; // recent[] is newest-first
    } else {
      eightKCount90d++;
      if (!latestEightKDate) latestEightKDate = filedAt;
    }

    if (filings.length < MAX_FILINGS && accessions[i] && docs[i]) {
      filings.push({ form, filedAt, url: filingUrl(cik10, accessions[i]!, docs[i]!) });
    }
  }

  return { cik: cik10, form4Count90d, eightKCount90d, latestForm4Date, latestEightKDate, filings };
}

/**
 * Recent SEC filing activity for one ticker. Null when the ticker has no CIK
 * (ETFs, ADRs, delisted) or the feed is unavailable.
 */
export async function fetchSecActivity(ticker: string): Promise<SecActivity | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  const cik10 = (await loadCikIndex()).get(symbol);
  if (!cik10) return null;

  let data: Submissions;
  try {
    data = await httpJson<Submissions>(SUBMISSIONS(cik10), {
      headers: HEADERS,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  const recent = data.filings?.recent;
  if (!recent) return null;

  const activity = summarize(cik10, recent);
  // Nothing actionable in the window - don't attach a hollow record.
  if (activity.form4Count90d === 0 && activity.eightKCount90d === 0) return null;
  return activity;
}
