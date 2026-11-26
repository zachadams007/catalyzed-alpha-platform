import type { CompanyData, SecActivity } from "@/types";
import type { TerminalEvent } from "@/types/terminal";
import { clamp, round } from "@/lib/math";
import { fmpKey } from "@/data/http";
import { fetchSecForm4Insider } from "@/data/terminal/secForm4";
import { fetchInsiderTrades } from "@/data/terminal/insiderTrades";
import { type CatalystEvent, daysAwayFrom, eventStrength } from "./catalystEvent";

/**
 * Insider CLUSTER buys + material SELLS → structured catalyst events AND the
 * aggregated `secActivity` fields the engine already reads.
 *
 * WHY THIS (vs. scraping OpenInsider)
 * -----------------------------------
 * OpenInsider's additive value over raw SEC Form 4 is (a) CLUSTER detection -
 * multiple insiders buying the same name in a window - and (b) role/seniority
 * materiality flags. Its $0 access is a ToS-unverified HTML scrape that returned
 * ECONNREFUSED in research. We already parse Form 4 keylessly from EDGAR
 * (`src/data/terminal/secForm4.ts`), so we reproduce the SAME cluster + seniority
 * signal over our own feed - $0, ToS-clean, no new dependency.
 *
 * TWO outputs, both feeding EXISTING scoring (no weight changes):
 *   • `aggregates` - `form4BuyCount90d` / `form4NetBuyValue90d` per ticker. These
 *     are OPTIONAL on `SecActivity` and are ABSENT universe-wide today, so the
 *     bounded smart-money boost (`smartMoney.ts`) and the material-sell signal
 *     (`catalystStrength.ts → materialSellSignal`) are silently dark. Populating
 *     them lights BOTH up with zero new scoring code.
 *   • `events` - a positive "Insider" cluster-buy `CatalystEvent` (folds into
 *     `CompanyData.catalyst`) and a NEGATIVE material-sell event (informational +
 *     dedupe; its score effect flows through the aggregate net value).
 *
 * Materiality is the whole point: only MAJOR insiders (role-weighted) and LARGE
 * or CLUSTER trades count; a small routine sale is noise and is excluded.
 * The pure rollup is unit-tested; the async fetch wrapper does I/O and is not.
 */

/** A buy must clear this notional to count (small open-market buys are noise). */
const MIN_BUY_USD = 100_000;
/** A sell must clear this notional to count (a routine sale is liquidity, not signal). */
const MIN_SELL_USD = 250_000;
/** Distinct senior BUYERS in the window that make it a cluster (magnitude bonus). */
const BUY_CLUSTER = 3;
/** Distinct senior SELLERS that make selling a cluster (stronger negative). */
const SELL_CLUSTER = 2;
/** Minimum role seniority (0..1) a trade's filer must have to count as material. */
const MIN_ROLE = 0.7;
/** Notional that saturates the log size-magnitude (a $10M trade ⇒ magnitude 1.0). */
const MAG_REF_USD = 10_000_000;

/** Seniority weight from a Form-4 / FMP role label. Unknown role ⇒ 0 (excluded). */
export function roleMateriality(role: string | undefined): number {
  const r = (role ?? "").toLowerCase();
  if (!r) return 0;
  if (/(chief|\bceo\b|\bcfo\b|\bcoo\b|\bcto\b|president|chair)/.test(r)) return 1.0;
  if (/(director|officer|\bevp\b|\bsvp\b|\bvp\b)/.test(r)) return 0.7;
  if (/10%/.test(r)) return 0.4;
  return 0.5; // a named insider with an unrecognized title
}

/** Log-scaled trade size, 0..1 - a $100k trade ≈ 0.71, $10M saturates to 1.0. */
function sizeMagnitude(valueUsd: number): number {
  if (!(valueUsd > 0)) return 0;
  return clamp(Math.log(valueUsd) / Math.log(MAG_REF_USD), 0, 1);
}

interface Rollup {
  ticker: string;
  buyValue: number;
  buyCount: number;
  buyers: Set<string>;
  topBuyRole: number;
  latestBuy?: string;
  buyUrl?: string;
  sellValue: number;
  sellCount: number;
  sellers: Set<string>;
  topSellRole: number;
  latestSell?: string;
  sellUrl?: string;
}

/** The aggregated insider fields the engine reads off `secActivity`. */
export interface InsiderAggregate {
  /** Open-market BUY count (Form 4 "P", material) - feeds the smart-money boost. */
  buyCount: number;
  /** Material SELL count - only used for the fallback `form4Count90d`. */
  sellCount: number;
  /** Σ material buys − Σ material sells. Positive = net buying; negative ⇒ sell signal. */
  netValue: number;
}

export interface InsiderCatalystResult {
  events: CatalystEvent[];
  aggregates: Map<string, InsiderAggregate>;
}

function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(value / 1e3)}K`;
  return `$${Math.round(value)}`;
}

function laterIso(a: string | undefined, b: string): string {
  if (!a) return b;
  return a.localeCompare(b) >= 0 ? a : b;
}

/**
 * Roll up insider Form-4 terminal events into per-ticker cluster-buy / material-
 * sell catalyst events + the aggregated `secActivity` fields. Pure - the clock is
 * injected, so the daily cache stays deterministic.
 */
export function rollupInsiderEvents(
  events: readonly TerminalEvent[],
  now: number = Date.now(),
): InsiderCatalystResult {
  const byTicker = new Map<string, Rollup>();

  for (const e of events) {
    if (e.kind !== "insider_buy" && e.kind !== "insider_sell") continue;
    const ticker = (e.ticker || "").trim().toUpperCase();
    if (!ticker) continue;
    const value = e.trade?.valueUsd ?? 0;
    const mat = roleMateriality(e.actor?.role);
    const isBuy = e.kind === "insider_buy";

    // Materiality gate: a senior-enough filer AND a large-enough trade.
    if (mat < MIN_ROLE) continue;
    if (isBuy && value < MIN_BUY_USD) continue;
    if (!isBuy && value < MIN_SELL_USD) continue;

    const r =
      byTicker.get(ticker) ??
      ({
        ticker,
        buyValue: 0,
        buyCount: 0,
        buyers: new Set<string>(),
        topBuyRole: 0,
        sellValue: 0,
        sellCount: 0,
        sellers: new Set<string>(),
        topSellRole: 0,
      } as Rollup);

    const who = (e.actor?.name || "Insider").toLowerCase();
    if (isBuy) {
      r.buyValue += value;
      r.buyCount += 1;
      r.buyers.add(who);
      r.topBuyRole = Math.max(r.topBuyRole, mat);
      r.latestBuy = laterIso(r.latestBuy, e.occurredAt);
      r.buyUrl = r.buyUrl ?? e.source?.url;
    } else {
      r.sellValue += value;
      r.sellCount += 1;
      r.sellers.add(who);
      r.topSellRole = Math.max(r.topSellRole, mat);
      r.latestSell = laterIso(r.latestSell, e.occurredAt);
      r.sellUrl = r.sellUrl ?? e.source?.url;
    }
    byTicker.set(ticker, r);
  }

  const out: CatalystEvent[] = [];
  const aggregates = new Map<string, InsiderAggregate>();

  for (const r of byTicker.values()) {
    aggregates.set(r.ticker, {
      buyCount: r.buyCount,
      sellCount: r.sellCount,
      netValue: round(r.buyValue - r.sellValue, 0),
    });

    if (r.buyCount > 0) {
      const cluster = r.buyers.size >= BUY_CLUSTER;
      const mag = clamp(r.topBuyRole * sizeMagnitude(r.buyValue) * (cluster ? 1.3 : 1), 0, 1);
      const daysAway = daysAwayFrom(r.latestBuy ?? new Date(now).toISOString(), now);
      out.push({
        ticker: r.ticker,
        catalystType: "Insider",
        date: r.latestBuy ?? new Date(now).toISOString().slice(0, 10),
        summary: `${r.buyers.size} insider buy${r.buyers.size === 1 ? "" : "s"} — ${fmtUsd(r.buyValue)}${cluster ? " (cluster)" : ""}`,
        sourceUrl: r.buyUrl ?? "",
        magnitude: mag,
        strength: eventStrength(mag, daysAway, false),
      });
    }

    if (r.sellCount > 0) {
      const cluster = r.sellers.size >= SELL_CLUSTER;
      const mag = clamp(r.topSellRole * sizeMagnitude(r.sellValue) * (cluster ? 1.2 : 1), 0, 1);
      const daysAway = daysAwayFrom(r.latestSell ?? new Date(now).toISOString(), now);
      out.push({
        ticker: r.ticker,
        catalystType: "Insider",
        date: r.latestSell ?? new Date(now).toISOString().slice(0, 10),
        summary: `Material insider selling — ${fmtUsd(r.sellValue)}${cluster ? " (cluster)" : ""}`,
        sourceUrl: r.sellUrl ?? "",
        magnitude: mag,
        strength: eventStrength(mag, daysAway, true),
        negative: true,
      });
    }
  }

  return { events: out, aggregates };
}

/**
 * Merge the aggregated insider buy/net-value fields onto a company's
 * `secActivity` (preserving any existing CIK/filings/counts). Returns the SAME
 * reference when there is no aggregate, so most names are untouched.
 */
export function applyInsiderAggregateToCompany(
  company: CompanyData,
  agg: InsiderAggregate | undefined,
): CompanyData {
  if (!agg || (agg.buyCount === 0 && agg.sellCount === 0)) return company;
  const prev = company.secActivity;
  const secActivity: SecActivity = prev
    ? { ...prev, form4BuyCount90d: agg.buyCount, form4NetBuyValue90d: agg.netValue }
    : {
        cik: "",
        form4Count90d: agg.buyCount + agg.sellCount,
        eightKCount90d: 0,
        filings: [],
        form4BuyCount90d: agg.buyCount,
        form4NetBuyValue90d: agg.netValue,
      };
  return { ...company, secActivity };
}

// --------------------------------------------------------------------------
// Live fetch (I/O). Prefers FMP's insider feed when a key is present (one cheap
// call), else the keyless EDGAR Form 4 source - mirroring the Terminal's
// `fetchInsiderBuys`. Degrades to an empty result on any error.
// --------------------------------------------------------------------------

export async function fetchInsiderCatalystRollup(now: number = Date.now()): Promise<InsiderCatalystResult> {
  try {
    let events: TerminalEvent[] = [];
    if (fmpKey()) {
      events = await fetchInsiderTrades(1).catch(() => [] as TerminalEvent[]);
    }
    if (events.length === 0) {
      events = await fetchSecForm4Insider().catch(() => [] as TerminalEvent[]);
    }
    return rollupInsiderEvents(events, now);
  } catch {
    return { events: [], aggregates: new Map() };
  }
}
