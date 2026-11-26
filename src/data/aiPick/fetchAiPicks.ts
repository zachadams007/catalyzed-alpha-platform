import { supabase } from "@/data/supabase/client";
import type { AiPick } from "./types";

/**
 * Client read seam for the `ai_picks` table.
 *
 * Mirrors the pattern from `dailySignalsCache.ts`:
 *   • Uses the shared anon Supabase client (public SELECT only - the table
 *     is hardened so clients can never write, per migration 0021).
 *   • Guards freshness by `market_day` (Eastern-time date) so a prior day's
 *     picks are never shown under a "today" label.
 *   • Returns [] on any error - the UI should treat an empty array as
 *     "today's pick hasn't landed yet" and render a skeleton, not an error.
 *
 * Security: the client carries only the public anon key. The `ai_picks` table
 * has `REVOKE INSERT, UPDATE, DELETE ... FROM anon, authenticated` (0021), so
 * this function can only read. Writes are service-role only (edge function).
 */

const TABLE = "ai_picks";

/**
 * The canonical US/Eastern market-day key (YYYY-MM-DD).
 * Matches the clock used by daily_signals and the ai-pick edge function.
 */
function marketDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Fetch today's AI picks (hero + runners-up), ordered by rank (0, 1, 2).
 *
 * Returns an empty array when:
 *   - Supabase is not configured
 *   - Today's picks haven't been generated yet
 *   - Any network/database error occurs
 *
 * Never throws.
 */
export async function fetchTodayAiPicks(
  now: Date = new Date(),
): Promise<AiPick[]> {
  if (!supabase) return [];
  const day = marketDayKey(now);
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(
        "market_day, rank, ticker, final_score, engine_score, judge_score, " +
        "confidence, horizon_days, catalyst_summary, catalyst_type, " +
        "primary_source_url, bull_case, bear_case, skeptic_note, macro_driven, created_at",
      )
      .eq("market_day", day)
      .order("rank", { ascending: true })
      .limit(4);

    if (error || !data || data.length === 0) return [];

    // Freshness defense-in-depth: the query already filters on today's
    // market_day, but double-check the stored value matches in case of a
    // cached/stale response. A mismatch is treated as a miss.
    const fresh = (data as unknown as AiPick[]).filter((row) => row.market_day === day);
    return fresh;
  } catch {
    return [];
  }
}

/**
 * Fetch the most recent AI picks regardless of day, up to `maxAgeDays` old.
 *
 * Use this when you want to show picks even before today's run has landed
 * (the same "show the last known board" pattern as `fetchRecentSharedSignals`).
 * The returned `market_day` tells you which day the picks are from so the UI
 * can label them "as of <date>" rather than claiming they're today's.
 *
 * Returns [] on any error. Never throws.
 */
export async function fetchRecentAiPicks(
  now: Date = new Date(),
  maxAgeDays = 5,
): Promise<AiPick[]> {
  if (!supabase) return [];
  try {
    // ONE round trip, not two. This used to (1) query for the latest
    // `market_day`, then (2) query that day's rows - two sequential ~230ms
    // trips on the cold-load path. Instead: ask for the newest rows inside the
    // staleness window in one go, ordered newest-day-first then by rank, and
    // keep only the rows belonging to the newest day that came back. The
    // `gte` bound does the staleness check server-side; the over-fetch (2 days
    // × 4 picks) guarantees a full set even if the newest day is short.
    const todayMs = Date.parse(`${marketDayKey(now)}T00:00:00Z`);
    const cutoffISO = new Date(todayMs - maxAgeDays * 86_400_000).toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from(TABLE)
      .select(
        "market_day, rank, ticker, final_score, engine_score, judge_score, " +
        "confidence, horizon_days, catalyst_summary, catalyst_type, " +
        "primary_source_url, bull_case, bear_case, skeptic_note, macro_driven, created_at",
      )
      .gte("market_day", cutoffISO)
      .order("market_day", { ascending: false })
      .order("rank", { ascending: true })
      .limit(8);

    if (error || !data || data.length === 0) return [];
    const rows = data as unknown as AiPick[];
    const latestDay = rows[0]?.market_day;
    if (typeof latestDay !== "string") return [];
    // A future-dated row (clock skew / bad publish) is not "recent" - reject it,
    // exactly as the old two-step version did.
    const rowMs = Date.parse(`${latestDay}T00:00:00Z`);
    if (!Number.isFinite(rowMs) || rowMs > todayMs) return [];
    return rows.filter((r) => r.market_day === latestDay).slice(0, 4);
  } catch {
    return [];
  }
}
