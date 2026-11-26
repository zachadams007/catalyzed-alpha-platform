import { httpJson, isFmpQueryable, nextFmpKey } from "@/data/http";

/**
 * Day movers for the Terminal home - most-active, biggest-gainers, and
 * biggest-losers from Financial Modeling Prep's current `stable` API.
 *
 *   https://financialmodelingprep.com/stable/most-actives?apikey=KEY
 *   https://financialmodelingprep.com/stable/biggest-gainers?apikey=KEY
 *   https://financialmodelingprep.com/stable/biggest-losers?apikey=KEY
 *
 * Client-side for now (3 FMP calls per refresh); the build plan migrates this to
 * the Python `movers_miner.py` → Supabase cache when parity lands. Discovery /
 * research only. Degrades to empty lists - never throws - so one dead lane (or a
 * missing key) never blanks the Terminal home.
 */

const FMP_STABLE = "https://financialmodelingprep.com/stable";

export type MoverKind = "actives" | "gainers" | "losers";

export interface Mover {
  ticker: string;
  name: string;
  /** Last price in USD. */
  price: number;
  /** Absolute day change in USD. */
  change: number;
  /** Day change as a ratio (0.05 = +5%). */
  changePct: number;
}

export interface MoversResult {
  actives: Mover[];
  gainers: Mover[];
  losers: Mover[];
  /** True when at least one lane returned rows (source health). */
  ok: boolean;
  /** True when no FMP key is configured - distinct from an empty/failed fetch. */
  unconfigured: boolean;
}

interface FmpMoverRow {
  symbol?: string;
  name?: string;
  price?: number | string;
  change?: number | string;
  // FMP `stable` uses `changesPercentage`; some payloads use `changePercentage`.
  changesPercentage?: number | string;
  changePercentage?: number | string;
}

/** Coerce a number from a number or a "5.23%" / "+1,234" style string. */
export function coerceNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[%+,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cleanTicker(raw?: string): string | null {
  const t = raw?.trim().toUpperCase();
  if (!t || !/^[A-Z][A-Z.\-]{0,6}$/.test(t)) return null;
  return t;
}

/** Normalize one FMP mover row, or null when it isn't a usable equity row. */
export function parseMover(raw: FmpMoverRow): Mover | null {
  const ticker = cleanTicker(raw.symbol);
  const price = coerceNum(raw.price);
  if (!ticker || price == null || price <= 0) return null;
  const pct = coerceNum(raw.changesPercentage ?? raw.changePercentage);
  return {
    ticker,
    name: raw.name?.trim() || ticker,
    price,
    change: coerceNum(raw.change) ?? 0,
    changePct: pct == null ? 0 : pct / 100,
  };
}

/** Pure: parse + filter + cap an FMP mover payload. Preserves API ordering. */
export function parseMovers(rows: unknown, limit = 8): Mover[] {
  if (!Array.isArray(rows)) return [];
  const out: Mover[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const mover = parseMover(row as FmpMoverRow);
    if (mover) out.push(mover);
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchLane(path: string, key: string | undefined, limit: number): Promise<Mover[]> {
  try {
    // In proxy mode (web/phone) there's no local key - the hosted proxy injects
    // it server-side, so omit the apikey param and let resolveMarketRequest route.
    const url = key
      ? `${FMP_STABLE}/${path}?apikey=${encodeURIComponent(key)}`
      : `${FMP_STABLE}/${path}`;
    const rows = await httpJson<unknown>(url, { timeoutMs: 12_000 });
    return parseMovers(rows, limit);
  } catch {
    return [];
  }
}

/** Fetch the three mover lanes in parallel. Never throws. */
export async function fetchMovers(limit = 8): Promise<MoversResult> {
  // Queryable = a local key (desktop/dev) OR the hosted proxy (web/phone).
  if (!isFmpQueryable()) {
    return { actives: [], gainers: [], losers: [], ok: false, unconfigured: true };
  }
  // Each lane rotates independently to its own key - 3 calls per refresh spread
  // across the pool instead of hammering one key three times.
  const [actives, gainers, losers] = await Promise.all([
    fetchLane("most-actives", nextFmpKey(), limit),
    fetchLane("biggest-gainers", nextFmpKey(), limit),
    fetchLane("biggest-losers", nextFmpKey(), limit),
  ]);
  return {
    actives,
    gainers,
    losers,
    ok: actives.length > 0 || gainers.length > 0 || losers.length > 0,
    unconfigured: false,
  };
}
