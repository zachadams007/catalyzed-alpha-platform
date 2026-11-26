import { httpJson, nextFmpKey } from "@/data/http";
import { isMarketProxyConfigured } from "@/data/marketProxy";
import type { TerminalEvent } from "@/types/terminal";
import type { CongressTrade } from "@/types";
import { loadCongressIndex } from "@/data/congress/congressTrades";
import { classifyPoliticianSeverity } from "./severity";

/**
 * Congressional (House + Senate) stock trades via Financial Modeling Prep's
 * current `stable` API:
 *   - https://financialmodelingprep.com/stable/senate-latest
 *   - https://financialmodelingprep.com/stable/house-latest
 *
 * These are the public Periodic Transaction Reports members of Congress must
 * file (efdsearch.senate.gov / disclosures-clerk.house.gov), normalized by FMP.
 * They work on the free tier (250 calls/day) and need no extra key - the FMP
 * key is already configured. This replaces the abandoned House/Senate Stock
 * Watcher S3 buckets (now 403) and the paid Quiver path.
 *
 * Discovery/research only. Degrades to [] on any error so one dead source never
 * blanks the feed. The richer bulk history belongs in the Python miner / edge
 * cache later; this is the light, live client path.
 */

const FMP_STABLE = "https://financialmodelingprep.com/stable";

interface FmpCongressRow {
  symbol?: string;
  disclosureDate?: string;
  transactionDate?: string;
  firstName?: string;
  lastName?: string;
  office?: string;
  district?: string; // Senate: state ("RI"); House: state+seat ("NJ05")
  owner?: string;
  assetDescription?: string;
  assetType?: string; // we keep only "Stock"
  type?: string; // "Purchase" | "Sale" | "Sale (Partial)" | "Exchange" | ...
  amount?: string; // disclosed RANGE, e.g. "$15,001 - $50,000"
  link?: string;
}

type Chamber = "senate" | "house";

function safeIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

/** Pull the numeric bounds out of a disclosure range like "$15,001 - $50,000". */
function parseAmountRange(amount?: string): { lower?: number; upper?: number } {
  if (!amount) return {};
  const nums = (amount.match(/[\d,]+/g) ?? [])
    .map((n) => Number(n.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return {};
  return { lower: Math.min(...nums), upper: Math.max(...nums) };
}

/** Map a disclosure transaction type to buy/sell, or null to drop (exchanges, etc.). */
function directionOf(type?: string): "buy" | "sell" | null {
  const t = (type ?? "").toLowerCase();
  if (t.includes("purchase")) return "buy";
  if (t.includes("sale")) return "sell";
  return null; // exchanges, receipts, and anything ambiguous → noise
}

/** Human role label from chamber + district ("RI" → "Senator (RI)", "NJ05" → "Rep. (NJ-05)"). */
function actorRole(chamber: Chamber, district?: string): string {
  const d = (district ?? "").trim().toUpperCase();
  if (chamber === "senate") return d ? `Senator (${d})` : "Senator";
  const m = d.match(/^([A-Z]{2})(\d{1,2})$/);
  const pretty = m ? `${m[1]}-${m[2].padStart(2, "0")}` : d;
  return pretty ? `Rep. (${pretty})` : "Representative";
}

function rangeLabel(lower?: number, upper?: number): string {
  if (lower && upper) return `$${lower.toLocaleString("en-US")}–$${upper.toLocaleString("en-US")}`;
  if (upper) return `up to $${upper.toLocaleString("en-US")}`;
  return "amount undisclosed";
}

function normalize(rows: FmpCongressRow[], chamber: Chamber): TerminalEvent[] {
  const out: TerminalEvent[] = [];
  for (const row of rows) {
    if (!row.symbol) continue;
    if (row.assetType && !row.assetType.toLowerCase().includes("stock")) continue;
    const direction = directionOf(row.type);
    if (!direction) continue;

    const ticker = row.symbol.toUpperCase();
    const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || "Member of Congress";
    const role = actorRole(chamber, row.district);
    const { lower, upper } = parseAmountRange(row.amount);
    const { severity, reason } = classifyPoliticianSeverity(direction, upper);
    const occurredAt = safeIso(row.transactionDate);

    out.push({
      id: `congress-${chamber}-${ticker}-${row.lastName ?? "?"}-${row.transactionDate ?? row.disclosureDate}-${row.type ?? ""}`,
      kind: "politician_trade",
      severity,
      ticker,
      companyName: row.assetDescription || undefined,
      headline: `${name} ${direction === "buy" ? "bought" : "sold"} ${ticker} (${rangeLabel(lower, upper)})`,
      summary: row.assetDescription ? `${role} · ${row.assetDescription}` : role,
      actor: { name, role },
      trade: { direction, valueUsd: upper },
      occurredAt,
      surfacedAt: safeIso(row.disclosureDate),
      source: {
        name: chamber === "senate" ? "Senate disclosure · FMP" : "House disclosure · FMP",
        url: row.link || "https://efdsearch.senate.gov/search/",
      },
      reason,
    });
  }
  return out;
}

export async function fetchPoliticianTrades(): Promise<TerminalEvent[]> {
  const key = nextFmpKey();
  // On a keyless web/PWA build the FMP key isn't embedded, but the hosted market
  // proxy injects it server-side - so run when EITHER a local key OR the proxy is
  // configured. Without this, web fell back to the House Stock Watcher mirror, which
  // is STALE (no 2026 rows) → the Congress lane read empty on the web Terminal and
  // the whole wire looked broken. The proxy serves CURRENT House+Senate disclosures.
  if (!key && !isMarketProxyConfigured()) return [];
  // Proxied path strips `apikey` and re-attaches the real key server-side, so an
  // empty placeholder is fine when no local key is present.
  const apikey = key ? encodeURIComponent(key) : "";

  const [senate, house] = await Promise.all([
    httpJson<FmpCongressRow[]>(`${FMP_STABLE}/senate-latest?page=0&apikey=${apikey}`, {
      timeoutMs: 12_000,
    }).catch(() => [] as FmpCongressRow[]),
    httpJson<FmpCongressRow[]>(`${FMP_STABLE}/house-latest?page=0&apikey=${apikey}`, {
      timeoutMs: 12_000,
    }).catch(() => [] as FmpCongressRow[]),
  ]);

  const senateRows = Array.isArray(senate) ? senate : [];
  const houseRows = Array.isArray(house) ? house : [];
  return [...normalize(senateRows, "senate"), ...normalize(houseRows, "house")];
}

const KEYLESS_WINDOW_DAYS = 120;

/**
 * KEYLESS congress-trade feed - the House Stock Watcher public GitHub mirror (the
 * same source the daily scan already uses). No API key, works on every build
 * (web/phone/desktop), so the Terminal's Congress source is never dead/gray just
 * because an FMP key isn't present. House only (the only free, current public
 * copy); the FMP path above adds the Senate when a key is configured.
 */
export async function fetchPoliticianTradesKeyless(): Promise<TerminalEvent[]> {
  let index: Map<string, CongressTrade[]>;
  try {
    index = await loadCongressIndex();
  } catch {
    return [];
  }
  const cutoff = Date.now() - KEYLESS_WINDOW_DAYS * 86_400_000;
  const out: TerminalEvent[] = [];
  for (const [ticker, trades] of index) {
    for (const t of trades) {
      if (t.transaction === "exchange") continue;
      const occ = Date.parse(t.transactionDate);
      if (!Number.isFinite(occ) || occ < cutoff) continue;
      const direction: "buy" | "sell" = t.transaction;
      const { lower, upper } = parseAmountRange(t.amountRange);
      const { severity, reason } = classifyPoliticianSeverity(direction, upper);
      const role = t.chamber === "Senate" ? "U.S. Senator" : "U.S. Representative";
      out.push({
        id: `congress-house-${ticker}-${t.representative}-${t.transactionDate}-${t.transaction}`,
        kind: "politician_trade",
        severity,
        ticker,
        headline: `${t.representative} ${direction === "buy" ? "bought" : "sold"} ${ticker} (${rangeLabel(lower, upper)})`,
        summary: `${role} · congressional disclosure`,
        actor: { name: t.representative, role },
        trade: { direction, valueUsd: upper },
        occurredAt: safeIso(t.transactionDate),
        surfacedAt: safeIso(t.disclosedDate),
        source: { name: "House disclosure · public mirror", url: "https://housestockwatcher.com/" },
        reason,
      });
    }
  }
  return out;
}

/**
 * Combined congress feed used by the Terminal: the keyless House mirror ALWAYS
 * (so the source is live on any build), plus the FMP House+Senate path when a key
 * is configured - deduped, FMP rows preferred.
 */
export async function fetchPoliticianTradesAny(): Promise<TerminalEvent[]> {
  const [fmp, keyless] = await Promise.all([
    fetchPoliticianTrades().catch(() => [] as TerminalEvent[]),
    fetchPoliticianTradesKeyless().catch(() => [] as TerminalEvent[]),
  ]);
  if (fmp.length === 0) return keyless;
  const seen = new Set(fmp.map((e) => `${e.ticker}|${e.actor?.name ?? ""}|${e.occurredAt}`));
  const extra = keyless.filter((e) => !seen.has(`${e.ticker}|${e.actor?.name ?? ""}|${e.occurredAt}`));
  return [...fmp, ...extra];
}
