import type { RawSocial, SocialPost } from "@/types";
import { httpJson } from "@/data/http";

/**
 * StockTwits public API - real social attention & sentiment, no API key.
 * Endpoint: https://api.stocktwits.com/api/2/streams/symbol/{SYMBOL}.json
 *
 * Discovery/research only. Degrades gracefully (returns null) on any error so
 * the pipeline can keep the modeled baseline.
 */

const STOCKTWITS = "https://api.stocktwits.com/api/2/streams/symbol";

interface StSentiment {
  basic?: "Bullish" | "Bearish" | null;
}
interface StMessage {
  id: number;
  body?: string;
  created_at?: string;
  entities?: { sentiment?: StSentiment | null };
  user?: { username?: string; name?: string };
}
interface StResponse {
  symbol?: { symbol?: string; watchlist_count?: number };
  messages?: StMessage[];
}

export interface LiveSocial {
  social: RawSocial;
  posts: SocialPost[];
  watchlistCount?: number;
}

function hoursSince(iso?: string): number {
  if (!iso) return 999;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 999;
  return (Date.now() - t) / 3_600_000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export async function fetchStockTwitsSocial(ticker: string): Promise<LiveSocial | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  let res: StResponse;
  try {
    res = await httpJson<StResponse>(`${STOCKTWITS}/${encodeURIComponent(symbol)}.json`);
  } catch {
    return null;
  }

  const messages = res.messages ?? [];
  if (messages.length === 0) return null;

  const msgs24h = messages.filter((m) => hoursSince(m.created_at) <= 24);
  const msgs6h = messages.filter((m) => hoursSince(m.created_at) <= 6);

  let bull = 0;
  let bear = 0;
  for (const m of messages) {
    const basic = m.entities?.sentiment?.basic;
    if (basic === "Bullish") bull++;
    else if (basic === "Bearish") bear++;
  }
  const tagged = bull + bear;
  const sentiment = tagged > 0 ? clamp((bull - bear) / tagged, -1, 1) : 0;

  // Day-over-day proxy: are recent 6h messages running hotter than the 24h pace?
  const expected6h = (msgs24h.length || messages.length) / 4;
  const trendDelta = clamp(expected6h > 0 ? (msgs6h.length - expected6h) / expected6h : 0, -1, 2.5);

  const watchlistCount = res.symbol?.watchlist_count;
  const mentions = Math.max(msgs24h.length, messages.length);
  const bullPct = tagged > 0 ? Math.round((bull / tagged) * 100) : null;
  const summary =
    `StockTwits: ${mentions} recent msgs` +
    (bullPct != null ? `, ${bullPct}% bullish` : "") +
    (watchlistCount ? ` · ${watchlistCount.toLocaleString()} watching` : "");

  const social: RawSocial = {
    // StockTwits is our live social proxy; map message volume into the X bucket.
    redditMentions24h: 0,
    xMentions24h: mentions,
    politicalMentions: 0,
    sentiment,
    trendDelta,
    summary,
  };

  const posts: SocialPost[] = messages
    .filter((m) => m.body && m.user?.username)
    .slice(0, 6)
    .map((m) => {
      const basic = m.entities?.sentiment?.basic;
      const sev: SocialPost["severity"] = mentions > 40 ? "high" : mentions > 15 ? "elevated" : "watch";
      return {
        platform: "x" as const,
        author: m.user?.name?.trim() || m.user!.username!,
        handle: `@${m.user!.username}`,
        text: m.body!.slice(0, 280),
        publishedAt: m.created_at ?? new Date().toISOString(),
        url: `https://stocktwits.com/${m.user!.username}/message/${m.id}`,
        sentiment: basic === "Bullish" ? 0.5 : basic === "Bearish" ? -0.5 : 0,
        isPolitical: false,
        severity: sev,
      };
    });

  return { social, posts, watchlistCount };
}
