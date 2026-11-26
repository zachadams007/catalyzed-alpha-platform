import { httpJson } from "@/data/http";

/**
 * ApeWisdom - free, keyless Reddit/WallStreetBets mention tracking.
 *
 * Fills the `social.redditMentions24h` field (hardcoded to 0 until now) with the
 * real retail-attention signal that drives small/micro-cap pops. Discovery/
 * research only.
 *
 * The `all-stocks` filter aggregates the major stock subreddits (WSB, stocks,
 * investing, …). The ranking is paginated (~100/page); we pull the top few pages
 * ONCE per session (module-cached) into a ticker -> mention map, so every
 * per-ticker lookup is a cheap Map.get. Any fetch/parse failure degrades to an
 * empty index so the rest of the pipeline keeps the modeled baseline.
 *
 * Source: https://apewisdom.io/api/ (no signup, CORS *). The Tauri HTTP layer
 * bypasses browser CORS in the desktop app.
 */

const BASE = "https://apewisdom.io/api/v1.0/filter/all-stocks/page";
/** Top ~300 most-mentioned names is plenty - anything past that has ~0 buzz. */
const MAX_PAGES = 3;
const FETCH_TIMEOUT_MS = 15_000;

export interface ApeWisdomMention {
  ticker: string;
  name?: string;
  /** Mentions in the trailing 24h window. */
  mentions: number;
  /** Aggregate upvotes on those mentions (engagement proxy). */
  upvotes?: number;
  /** Current rank in the most-mentioned list (1 = hottest). */
  rank?: number;
  /** Mention count 24h ago - lets us compute a day-over-day delta. */
  mentions24hAgo?: number;
}

interface ApeRow {
  ticker?: string;
  name?: string;
  mentions?: number | string;
  upvotes?: number | string;
  rank?: number | string;
  mentions_24h_ago?: number | string;
}
interface ApeResponse {
  results?: ApeRow[];
  pages?: number;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function cleanTicker(raw?: string): string | null {
  const t = raw?.trim().toUpperCase();
  if (!t || !/^[A-Z][A-Z.\-]{0,6}$/.test(t)) return null;
  return t;
}

let indexPromise: Promise<Map<string, ApeWisdomMention>> | null = null;

async function buildIndex(): Promise<Map<string, ApeWisdomMention>> {
  const map = new Map<string, ApeWisdomMention>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: ApeResponse;
    try {
      res = await httpJson<ApeResponse>(`${BASE}/${page}`, { timeoutMs: FETCH_TIMEOUT_MS });
    } catch {
      break; // keep whatever earlier pages succeeded
    }
    const rows = res.results ?? [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const ticker = cleanTicker(r.ticker);
      const mentions = num(r.mentions);
      if (!ticker || mentions === undefined || map.has(ticker)) continue;
      map.set(ticker, {
        ticker,
        name: r.name?.trim() || undefined,
        mentions,
        upvotes: num(r.upvotes),
        rank: num(r.rank),
        mentions24hAgo: num(r.mentions_24h_ago),
      });
    }

    if (res.pages && page >= res.pages) break;
  }

  return map;
}

/** Load (and memoize) the WSB/stocks mention ranking for this session. */
export function loadApeWisdomIndex(): Promise<Map<string, ApeWisdomMention>> {
  if (!indexPromise) {
    indexPromise = buildIndex().catch(() => new Map<string, ApeWisdomMention>());
  }
  return indexPromise;
}

/** Reddit mention stats for one ticker. Null when the name isn't being discussed. */
export async function fetchApeWisdomMention(ticker: string): Promise<ApeWisdomMention | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;
  const index = await loadApeWisdomIndex();
  return index.get(symbol) ?? null;
}
