import type { WatchlistAlert } from "@/types";
import { supabase } from "./client";

/**
 * Typed data-access for the cloud WATCHLIST. Each ticker the user watches is one
 * `watchlist_items` row tied to their account, with an optional per-ticker price
 * reminder. RLS (supabase/migrations/0014_watchlists.sql) restricts rows to their
 * owner - the watchlist is private user content, never public.
 *
 * Locally the watchlist is `watchlist: string[]` + `watchlistAlerts: Record<ticker,
 * WatchlistAlert>`; in the cloud each row carries `updated_at` so the sync layer
 * can do last-writer-wins on a conflict (mirrors terminalNotes.ts).
 */

export interface CloudWatchItem {
  ticker: string;
  /** Optional price-level reminder, or null when watched without one. */
  alert: WatchlistAlert | null;
  updatedAt: string;
}

interface WatchRow {
  ticker: string;
  alert: WatchlistAlert | null;
  updated_at: string;
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

/** All of the signed-in user's cloud watchlist items. */
export async function fetchMyWatchlist(userId: string): Promise<CloudWatchItem[]> {
  const { data, error } = await client()
    .from("watchlist_items")
    .select("ticker, alert, updated_at")
    .eq("owner", userId);
  if (error) throw error;
  return ((data ?? []) as WatchRow[]).map((r) => ({
    ticker: r.ticker,
    alert: r.alert ?? null,
    updatedAt: r.updated_at,
  }));
}

/** The tickers the user currently has in the cloud (to compute deletes). */
export async function fetchMyWatchlistTickers(userId: string): Promise<string[]> {
  const { data, error } = await client().from("watchlist_items").select("ticker").eq("owner", userId);
  if (error) throw error;
  return ((data ?? []) as { ticker: string }[]).map((r) => r.ticker);
}

/** Upsert watchlist items (one row per ticker), keyed on (owner, ticker). */
export async function upsertWatchlist(userId: string, items: CloudWatchItem[]): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map((it) => ({
    owner: userId,
    ticker: it.ticker,
    alert: it.alert,
    updated_at: it.updatedAt,
  }));
  const { error } = await client().from("watchlist_items").upsert(rows, { onConflict: "owner,ticker" });
  if (error) throw error;
}

/** Delete the given tickers from this user's cloud watchlist. */
export async function deleteWatchlistItems(userId: string, tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;
  const { error } = await client()
    .from("watchlist_items")
    .delete()
    .eq("owner", userId)
    .in("ticker", tickers);
  if (error) throw error;
}
