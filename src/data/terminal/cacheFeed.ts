import type { TerminalEvent } from "@/types/terminal";
import { httpJson } from "@/data/http";

/**
 * Cache-feed client - fetches TerminalEvent[] from the `terminal-feed` Supabase
 * edge function. Used on web/phone builds where direct keyed API calls are blocked
 * by CORS. On desktop (Tauri), the direct sources in sourceRegistry() are used
 * instead; this source is only registered when NOT running under Tauri.
 *
 * Degrades to [] on any error so one dead source never blanks the feed.
 * Error handling mirrors insiderTrades.ts (try/catch → []).
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** True when the Supabase env vars needed to hit the edge function are present. */
export function isCacheFeedConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

interface EdgeFeedResponse {
  events?: TerminalEvent[];
  error?: string;
}

/**
 * Fetch up to `limit` TerminalEvents from the terminal-feed edge function.
 * Returns [] on any network, auth, or parse error.
 */
export async function fetchCacheFeed(limit = 100): Promise<TerminalEvent[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];

  const url =
    `${SUPABASE_URL}/functions/v1/terminal-feed?limit=${encodeURIComponent(String(limit))}`;

  try {
    const body = await httpJson<EdgeFeedResponse>(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!Array.isArray(body.events)) return [];
    return body.events;
  } catch {
    return [];
  }
}
