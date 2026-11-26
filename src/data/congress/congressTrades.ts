import type { CongressTrade } from "@/types";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { resolveMarketRequest } from "@/data/marketProxy";

/**
 * Free, keyless congressional-trade disclosures (U.S. House financial
 * disclosures / Periodic Transaction Reports). Discovery/research only.
 *
 * The full transaction dump is a few MB, so we fetch + index it ONCE per session
 * (module-cached) into a ticker -> trades map. Every per-ticker lookup is then a
 * cheap Map.get. Any fetch/parse failure degrades to an empty index so the rest
 * of the pipeline keeps running on the modeled baseline.
 *
 * Source: the actively-maintained House Stock Watcher JSON mirror on GitHub
 * (the original S3 buckets started returning 403 in early 2026). The Senate
 * mirror is intentionally omitted - its only public copy is stale (through
 * 2021), which would pollute this recency-driven attention signal.
 *
 * Fetch path: this is a FREE public GitHub dataset, not a metered vendor, so it
 * does NOT funnel through the per-vendor pause/budget gate in `src/data/http.ts`
 * (`checkApiAllowed`). Gating it there meant a paused-by-default device - the safe
 * default for any build without a reachable vendor key - silently returned an
 * empty index, so the Terminal's Congress source read as dead/gray even though the
 * mirror was reachable and free. We still honor the one hard product rule -
 * sample-data mode makes ZERO live calls - and we route through the hosted market
 * proxy when configured (the production web bundle's path), so the bypass only
 * skips the spend kill-switch, nothing else.
 */

const HOUSE_URL =
  "https://raw.githubusercontent.com/TattooedHead/house-stock-watcher-data/main/data/all_transactions.json";

const FETCH_TIMEOUT_MS = 25_000;

/**
 * Keyless public-dataset GET. Tauri-aware (desktop uses the HTTP plugin to dodge
 * browser CORS; GitHub raw also serves permissive `*` CORS so the browser path
 * works directly) and proxy-aware (routes through the hosted market proxy when
 * `VITE_MARKET_PROXY_URL` is set). Deliberately NOT gated by the vendor budget /
 * pause ledger - this is a free public file, not a metered vendor. Sample-data
 * mode is still respected: it returns no data so no live request leaves the app.
 */
async function fetchKeylessJson<T>(url: string): Promise<T | null> {
  if (isSampleDataModeEnabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    const target = resolveMarketRequest(url);
    const res = isTauri()
      ? await (await import("@tauri-apps/plugin-http")).fetch(target.url, {
          method: "GET",
          headers: target.headers,
          signal: controller.signal,
        })
      : await fetch(target.url, {
          method: "GET",
          headers: target.headers,
          signal: controller.signal,
        });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
/** Most recent trades kept per ticker (newest first). */
const MAX_PER_TICKER = 12;

interface HouseRow {
  transaction_date?: string;
  disclosure_date?: string;
  ticker?: string;
  type?: string;
  amount?: string;
  representative?: string;
  /** Link to the original PTR PDF. The live mirror calls this `source_url`; older
   *  snapshots used `ptr_link` - accept either so the "Source" link is never dead. */
  source_url?: string;
  ptr_link?: string;
}

/** Parse "YYYY-MM-DD" or "MM/DD/YYYY" into an ISO date (YYYY-MM-DD), else undefined. */
function parseDate(raw?: string): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const mm = us[1]!.padStart(2, "0");
    const dd = us[2]!.padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

function normalizeType(raw?: string): CongressTrade["transaction"] | null {
  const t = raw?.toLowerCase() ?? "";
  if (t.includes("purchase") || t === "buy") return "buy";
  if (t.includes("sale") || t.includes("sell")) return "sell";
  if (t.includes("exchange")) return "exchange";
  return null;
}

function cleanTicker(raw?: string): string | null {
  const t = raw?.trim().toUpperCase();
  if (!t || t === "--" || t === "N/A" || t === "NONE") return null;
  // Real symbols are short and alpha (allow BRK.B / BF-B style dots/hyphens).
  if (!/^[A-Z][A-Z.\-]{0,6}$/.test(t)) return null;
  return t;
}

function add(map: Map<string, CongressTrade[]>, ticker: string, trade: CongressTrade): void {
  const list = map.get(ticker) ?? [];
  list.push(trade);
  map.set(ticker, list);
}

function indexHouse(rows: HouseRow[], map: Map<string, CongressTrade[]>): void {
  for (const r of rows) {
    const ticker = cleanTicker(r.ticker);
    const transaction = normalizeType(r.type);
    const transactionDate = parseDate(r.transaction_date);
    if (!ticker || !transaction || !transactionDate) continue;
    add(map, ticker, {
      representative: r.representative?.trim() || "House filer",
      chamber: "House",
      transaction,
      amountRange: r.amount?.trim() || "Undisclosed",
      transactionDate,
      disclosedDate: parseDate(r.disclosure_date),
      url: r.source_url?.trim() || r.ptr_link?.trim() || undefined,
    });
  }
}

/** Sort each ticker's trades newest-first and cap the list. */
function finalize(map: Map<string, CongressTrade[]>): Map<string, CongressTrade[]> {
  for (const [ticker, trades] of map) {
    trades.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
    if (trades.length > MAX_PER_TICKER) map.set(ticker, trades.slice(0, MAX_PER_TICKER));
  }
  return map;
}

let indexPromise: Promise<Map<string, CongressTrade[]>> | null = null;

async function buildIndex(): Promise<Map<string, CongressTrade[]>> {
  const map = new Map<string, CongressTrade[]>();

  const rows = await fetchKeylessJson<HouseRow[]>(HOUSE_URL);
  if (Array.isArray(rows)) indexHouse(rows, map);

  return finalize(map);
}

/** Load (and memoize) the full congressional-trade index for this session. */
export function loadCongressIndex(): Promise<Map<string, CongressTrade[]>> {
  if (!indexPromise) {
    indexPromise = buildIndex().catch(() => new Map<string, CongressTrade[]>());
  }
  return indexPromise;
}

/** Recent disclosed trades for one ticker (newest first). Empty when none/unavailable. */
export async function fetchCongressTrades(ticker: string): Promise<CongressTrade[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];
  const index = await loadCongressIndex();
  return index.get(symbol) ?? [];
}

/** Count of trades within the last `days` (used for political-attention scoring). */
export function recentTradeCount(trades: CongressTrade[], days = 120): number {
  const cutoff = Date.now() - days * 86_400_000;
  return trades.filter((t) => {
    const ms = new Date(t.transactionDate).getTime();
    return Number.isFinite(ms) && ms >= cutoff;
  }).length;
}
