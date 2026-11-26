import { httpJson } from "@/data/http";
import { isMarketProxyConfigured } from "@/data/marketProxy";
import type { TerminalEvent } from "@/types/terminal";
import { ITEM_8K_LABELS, classify8kSeverity } from "./severity";

/**
 * Market-wide recent SEC 8-K (material-event) filings via EDGAR's full-text
 * search API:
 *   https://efts.sec.gov/LATEST/search-index?forms=8-K&dateRange=custom&startdt=…&enddt=…
 *
 * This is the live, client-side counterpart of `scripts/terminal_miner/
 * edgar_8k_miner.py`. The full-text search index returns JSON (not the per-CIK
 * submissions feed the miner walks), so we get a single market-wide call that
 * already includes the company name, ticker, and 8-K item codes - no ticker→CIK
 * map download and no per-company fan-out needed.
 *
 * It is **keyless**, so no vendor key is ever exposed. EDGAR omits its CORS
 * header when an Origin is present, though, so a browser can't call it directly:
 *   - Tauri desktop  → absolute URL via the HTTP plugin (no browser CORS).
 *   - `npm run dev`   → the `/__sec` Vite proxy (see vite.config.ts) forwards a
 *                       compliant User-Agent and strips Origin/Referer.
 *   - production web  → skipped (served from the edge cache instead).
 *
 * Discovery/research only. Degrades to [] on any error so one dead source never
 * blanks the feed (mirrors the other terminal sources).
 */

/**
 * Base for the EDGAR full-text search endpoint. Tauri hits SEC directly; the
 * browser goes through the dev proxy (which injects the SEC User-Agent).
 */
function eftsSearchUrl(): string {
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;
  // Use the ABSOLUTE efts URL when we can reach SEC without the dev proxy:
  //   - Tauri desktop (no browser CORS), or
  //   - any build with the hosted market proxy configured - resolveMarketRequest
  //     rewrites it to <proxy>/sec/LATEST/search-index, which the proxy routes
  //     back to efts.sec.gov (see supabase/functions/market-proxy secOrigin()).
  // Only the dev browser WITHOUT a proxy needs the Vite `/__sec` proxy. Node (the
  // scan, vite-node) has no dev proxy → must fetch SEC absolutely.
  const node = typeof window === "undefined";
  const direct = node || desktop || isMarketProxyConfigured();
  return direct
    ? "https://efts.sec.gov/LATEST/search-index"
    : "/__sec/LATEST/search-index";
}

interface EftsSource {
  adsh?: string; // accession number, e.g. "0001951070-26-000021"
  ciks?: string[]; // zero-padded CIK strings
  display_names?: string[]; // e.g. "McGraw Hill, Inc.  (MH)  (CIK 0001951070)"
  file_date?: string; // "YYYY-MM-DD"
  file_type?: string; // "8-K" | "8-K/A"
  form?: string;
  items?: string[]; // ["2.02", "9.01", …]
}

interface EftsHit {
  _id?: string; // "<adsh>:<filename>"
  _source?: EftsSource;
}

interface EftsResponse {
  hits?: { hits?: EftsHit[] };
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

/** Pull the company name + ticker(s) out of an EDGAR display name. */
function parseDisplayName(dn: string): { company: string; ticker: string; related: string[] } {
  // "McGraw Hill, Inc.  (MH)  (CIK 0001951070)" → strip the trailing "(CIK …)"
  const cikMatch = dn.match(/\(CIK\s+\d+\)\s*$/i);
  const head = (cikMatch && cikMatch.index != null ? dn.slice(0, cikMatch.index) : dn).trim();
  // …then the trailing "(SYM)" group on what remains - which may list several
  // share classes, e.g. "(COPL, COPL-UN, COPL-WT)".
  const tk = head.match(/\(([A-Za-z0-9.\-]{1,10}(?:\s*,\s*[A-Za-z0-9.\-]{1,10})*)\)\s*$/);
  if (tk && tk.index != null) {
    const tickers = tk[1].split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    return {
      company: head.slice(0, tk.index).trim(),
      ticker: tickers[0] ?? "",
      related: tickers.slice(1),
    };
  }
  return { company: head, ticker: "", related: [] };
}

/** Build the canonical EDGAR filing-index URL for an accession number. */
function indexUrl(cikPadded: string | undefined, accession: string): string {
  const cikInt = String(parseInt(cikPadded ?? "0", 10) || 0);
  const folder = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${folder}/${accession}-index.htm`;
}

export async function fetchEdgar8K(limit = 60, lookbackDays = 7): Promise<TerminalEvent[]> {
  const today = new Date();
  const from = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const url =
    `${eftsSearchUrl()}?forms=8-K&dateRange=custom` +
    `&startdt=${ymd(from)}&enddt=${ymd(today)}`;

  const res = await httpJson<EftsResponse>(url, { timeoutMs: 12_000 });
  const hits = res.hits?.hits;
  if (!Array.isArray(hits)) return [];

  // EFTS indexes per-document, so one filing can appear as several hits
  // (primary doc + exhibits). Collapse on accession number → one card.
  const byAccession = new Map<string, TerminalEvent>();

  for (const hit of hits) {
    const s = hit._source;
    if (!s) continue;
    const accession = s.adsh || hit._id?.split(":")[0] || "";
    if (!accession || byAccession.has(accession)) continue;

    const form = (s.file_type || s.form || "8-K").toUpperCase();
    if (!form.startsWith("8-K")) continue;

    const items = Array.isArray(s.items) ? s.items.map((i) => i.trim()).filter(Boolean) : [];
    const { severity, reason } = classify8kSeverity(items);
    const { company, ticker, related } = parseDisplayName(s.display_names?.[0] ?? "");

    // Headline leads with the most material item (already named in `reason`).
    const primaryLabel = reason.startsWith("8-K: ") ? reason.slice(5) : "Material event";
    const who = company || ticker || "SEC filer";

    // When several items are present, list them all in the summary.
    const summary =
      items.length > 1
        ? items.map((i) => `Item ${i}: ${ITEM_8K_LABELS[i] ?? "Other"}`).join(" · ")
        : undefined;

    const occurredAt = safeIso(s.file_date);
    byAccession.set(accession, {
      id: `8k-${accession}`,
      kind: "filing_8k",
      severity,
      ticker,
      relatedTickers: related.length > 0 ? related : undefined,
      companyName: company || undefined,
      headline: `${who} — ${primaryLabel}`,
      summary,
      occurredAt,
      surfacedAt: occurredAt,
      source: {
        name: form === "8-K/A" ? "SEC 8-K/A · EDGAR" : "SEC 8-K · EDGAR",
        url: indexUrl(s.ciks?.[0], accession),
      },
      reason,
    });

    if (byAccession.size >= limit) break;
  }

  return Array.from(byAccession.values());
}
