import { supabase } from "./client";

/**
 * Typed data-access for cloud Terminal notes. Each per-ticker note the user
 * writes in the security workspace is mirrored to a `terminal_notes` row so the
 * same account sees the same notes on every device. RLS
 * (supabase/migrations/0006_terminal_notes.sql) restricts rows to their owner -
 * notes are private user content, never public.
 *
 * Locally notes live in `terminalNotes: Record<ticker, body>` (no per-note
 * timestamp); in the cloud each row carries `updated_at` so the sync layer can
 * do last-writer-wins on a conflict.
 */

export interface CloudNote {
  ticker: string;
  body: string;
  updatedAt: string;
}

interface NoteRow {
  ticker: string;
  body: string;
  updated_at: string;
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

/** All of the signed-in user's cloud notes. */
export async function fetchMyNotes(userId: string): Promise<CloudNote[]> {
  const { data, error } = await client()
    .from("terminal_notes")
    .select("ticker, body, updated_at")
    .eq("owner", userId);
  if (error) throw error;
  return ((data ?? []) as NoteRow[]).map((r) => ({
    ticker: r.ticker,
    body: r.body,
    updatedAt: r.updated_at,
  }));
}

/** The tickers the user currently has notes for in the cloud (to compute deletes). */
export async function fetchMyNoteTickers(userId: string): Promise<string[]> {
  const { data, error } = await client().from("terminal_notes").select("ticker").eq("owner", userId);
  if (error) throw error;
  return ((data ?? []) as { ticker: string }[]).map((r) => r.ticker);
}

/** Upsert notes (one row per ticker), keyed on (owner, ticker). */
export async function upsertNotes(userId: string, notes: CloudNote[]): Promise<void> {
  if (notes.length === 0) return;
  const rows = notes.map((n) => ({
    owner: userId,
    ticker: n.ticker,
    body: n.body,
    updated_at: n.updatedAt,
  }));
  const { error } = await client().from("terminal_notes").upsert(rows, { onConflict: "owner,ticker" });
  if (error) throw error;
}

/** Delete the given tickers' notes for this user. */
export async function deleteNotes(userId: string, tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;
  const { error } = await client()
    .from("terminal_notes")
    .delete()
    .eq("owner", userId)
    .in("ticker", tickers);
  if (error) throw error;
}
