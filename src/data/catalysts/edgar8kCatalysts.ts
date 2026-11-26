import type { CatalystType } from "@/types";
import { httpJson } from "@/data/http";
import { secEndpoint } from "@/data/sec/secEndpoint";
import { ITEM_8K_LABELS } from "@/data/terminal/severity";
import { type CatalystEvent, daysAwayFrom, eventStrength } from "./catalystEvent";

/**
 * SEC 8-K material-event filings → structured catalyst events for SCORING.
 *
 * The Terminal already renders 8-K filings (see `src/data/terminal/edgar8k.ts`),
 * but those events never reach the engine's catalyst sub-score. This module maps
 * an 8-K's ITEM CODES onto the engine's `CatalystType` and a materiality-scored
 * `CatalystEvent`, so a real "entered a material agreement / acquired / went
 * bankrupt" filing folds into `CompanyData.catalyst` (where Lane D weights it).
 *
 * Keyless + bounded: one market-wide EDGAR full-text-search call per scan, no
 * per-ticker fan-out, same SEC-fair-access contract (descriptive User-Agent, ≤10
 * req/s) as the other SEC sources. Degrades to [] on any error.
 *
 * The item→type/materiality table is the SCORING half of the Terminal's
 * `classify8kSeverity` (which only buckets severity for the feed); here we also
 * choose a catalyst TYPE and a 0..1 magnitude, and flag clearly-negative items so
 * they flow as negative catalysts.
 */

/** Per-item catalyst mapping: which `CatalystType`, how material (0..1), sign. */
interface ItemMeta {
  type: CatalystType;
  /** Pre-recency materiality × magnitude, 0..1. */
  mag: number;
  /** True = a clearly negative event (bankruptcy, delisting, restatement, …). */
  negative?: boolean;
}

/**
 * 8-K item → catalyst mapping. Tiers: HIGH 0.85 (binary, market-moving),
 * MED 0.55 (notable), LOW 0.25 (routine). Items not listed (9.01 exhibits, 6.x
 * ABS-only) carry no event and are skipped.
 */
const ITEM_META: Record<string, ItemMeta> = {
  "1.01": { type: "Partnership", mag: 0.55 }, // material definitive agreement
  "1.02": { type: "Partnership", mag: 0.55, negative: true }, // agreement termination
  "1.03": { type: "Regulatory", mag: 0.85, negative: true }, // bankruptcy / receivership
  "2.01": { type: "M&A", mag: 0.85 }, // acquisition / disposition of assets
  "2.02": { type: "Earnings", mag: 0.55 }, // results of operations
  "2.03": { type: "Regulatory", mag: 0.25 }, // new debt obligation
  "2.04": { type: "Regulatory", mag: 0.25 }, // triggering events
  "2.05": { type: "Regulatory", mag: 0.25 }, // exit / restructuring costs
  "2.06": { type: "Regulatory", mag: 0.55, negative: true }, // material impairment
  "3.01": { type: "Regulatory", mag: 0.85, negative: true }, // delisting notice
  "3.02": { type: "Regulatory", mag: 0.55, negative: true }, // unregistered equity (dilution)
  "4.01": { type: "Regulatory", mag: 0.55 }, // auditor change
  "4.02": { type: "Regulatory", mag: 0.85, negative: true }, // financial restatement
  "5.01": { type: "M&A", mag: 0.85 }, // change in control
  "5.02": { type: "Regulatory", mag: 0.55 }, // director/officer change
  "5.03": { type: "Regulatory", mag: 0.25 }, // charter/bylaw amendment
  "7.01": { type: "Macro", mag: 0.25 }, // Reg FD disclosure
  "8.01": { type: "Product", mag: 0.25 }, // other events (catch-all)
};

/** Normalize an item code: "Item 1.01" / " 1.01 " → "1.01". */
function normalizeItem(raw: string): string {
  return raw.replace(/^item\s*/i, "").trim();
}

export interface EightKInput {
  ticker: string;
  companyName?: string;
  items: string[];
  /** ISO date the 8-K was filed. */
  dateIso: string;
  /** Direct EDGAR filing-index URL. */
  url: string;
}

/**
 * Map one 8-K's items to a single catalyst event, choosing the MOST material item
 * (highest magnitude). Returns null when the filing carries no scorable item
 * (e.g. exhibits-only) or has no ticker. Pure - the clock is injected.
 */
export function eightKToCatalystEvent(input: EightKInput, now: number = Date.now()): CatalystEvent | null {
  const ticker = input.ticker.trim().toUpperCase();
  if (!ticker || !Array.isArray(input.items)) return null;

  let bestCode: string | null = null;
  let bestMeta: ItemMeta | null = null;
  for (const raw of input.items) {
    const code = normalizeItem(raw);
    const meta = ITEM_META[code];
    if (!meta) continue;
    if (!bestMeta || meta.mag > bestMeta.mag) {
      bestCode = code;
      bestMeta = meta;
    }
  }
  if (!bestCode || !bestMeta) return null;

  const daysAway = daysAwayFrom(input.dateIso, now);
  const label = ITEM_8K_LABELS[bestCode] ?? "Material event";
  const lead = input.companyName ? `${input.companyName} — ` : "";
  return {
    ticker,
    catalystType: bestMeta.type,
    date: input.dateIso,
    summary: `${lead}8-K Item ${bestCode}: ${label}`,
    sourceUrl: input.url,
    magnitude: bestMeta.mag,
    strength: eventStrength(bestMeta.mag, daysAway, bestMeta.negative),
    negative: bestMeta.negative,
  };
}

/** Map a batch of 8-K filings to catalyst events, dropping unscorable ones. */
export function eightKsToCatalystEvents(inputs: readonly EightKInput[], now: number = Date.now()): CatalystEvent[] {
  const out: CatalystEvent[] = [];
  for (const input of inputs) {
    const ev = eightKToCatalystEvent(input, now);
    if (ev) out.push(ev);
  }
  return out;
}

// --------------------------------------------------------------------------
// Live fetch (I/O) - keyless EDGAR full-text search, bounded, degrades to [].
// The pure mappers above are unit-tested; this thin wrapper does real network
// work and is therefore not unit-tested (same convention as the other sources).
// --------------------------------------------------------------------------

interface EftsSource {
  adsh?: string;
  ciks?: string[];
  display_names?: string[];
  file_date?: string;
  file_type?: string;
  items?: string[];
}
interface EftsHit {
  _id?: string;
  _source?: EftsSource;
}
interface EftsResponse {
  hits?: { hits?: EftsHit[] };
}

const USER_AGENT = "Catalyzed Alpha research (contact: contact@example.com)";

/** efts.sec.gov full-text search - via the SEC proxy on the cloud scan (SEC blocks
 *  the GitHub IP), absolute on desktop, dev-proxy in the browser. See secEndpoint. */
function eftsSearchUrl(): string {
  return secEndpoint("efts", "/LATEST/search-index");
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Pull "(SYM)" + company name out of an EDGAR display name, stripping "(CIK …)". */
function parseDisplayName(dn: string): { company: string; ticker: string } {
  const cikMatch = dn.match(/\(CIK\s+\d+\)\s*$/i);
  const head = (cikMatch && cikMatch.index != null ? dn.slice(0, cikMatch.index) : dn).trim();
  const tk = head.match(/\(([A-Za-z0-9.\-]{1,10}(?:\s*,\s*[A-Za-z0-9.\-]{1,10})*)\)\s*$/);
  if (tk && tk.index != null) {
    const ticker = tk[1].split(",")[0]?.trim().toUpperCase() ?? "";
    return { company: head.slice(0, tk.index).trim(), ticker };
  }
  return { company: head, ticker: "" };
}

function indexUrl(cikPadded: string | undefined, accession: string): string {
  const cikInt = String(parseInt(cikPadded ?? "0", 10) || 0);
  const folder = accession.replace(/-/g, "");
  return secEndpoint("www", `/Archives/edgar/data/${cikInt}/${folder}/${accession}-index.htm`);
}

/**
 * Fetch recent market-wide 8-K filings and map them to catalyst events. One
 * EFTS call, collapsed per accession, bounded by `limit`. Degrades to [].
 */
export async function fetchEdgar8KCatalystEvents(limit = 200, lookbackDays = 10): Promise<CatalystEvent[]> {
  try {
    const today = new Date();
    const from = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const url =
      `${eftsSearchUrl()}?forms=8-K&dateRange=custom&startdt=${ymd(from)}&enddt=${ymd(today)}`;

    const res = await httpJson<EftsResponse>(url, { headers: { "User-Agent": USER_AGENT }, timeoutMs: 12_000 });
    const hits = res.hits?.hits;
    if (!Array.isArray(hits)) return [];

    const seen = new Set<string>();
    const inputs: EightKInput[] = [];
    for (const hit of hits) {
      const s = hit._source;
      if (!s) continue;
      const accession = s.adsh || hit._id?.split(":")[0] || "";
      if (!accession || seen.has(accession)) continue;
      const form = (s.file_type || "8-K").toUpperCase();
      if (!form.startsWith("8-K")) continue;
      const { company, ticker } = parseDisplayName(s.display_names?.[0] ?? "");
      if (!ticker) continue;
      seen.add(accession);
      inputs.push({
        ticker,
        companyName: company || undefined,
        items: Array.isArray(s.items) ? s.items : [],
        dateIso: s.file_date || ymd(today),
        url: indexUrl(s.ciks?.[0], accession),
      });
      if (inputs.length >= limit) break;
    }
    return eightKsToCatalystEvents(inputs);
  } catch {
    return [];
  }
}
