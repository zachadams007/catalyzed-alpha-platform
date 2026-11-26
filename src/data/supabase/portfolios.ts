import type { Portfolio, PortfolioDiscovery, PortfolioHolding, PortfolioMode } from "@/types";
import { supabase } from "./client";

/**
 * Typed data-access for cloud portfolios. The user's OWN portfolios are mirrored
 * to a Supabase row per portfolio so the same account sees them on every device.
 * RLS (supabase/migrations/0003_portfolios.sql) restricts rows to their owner.
 *
 * Locally a user's portfolios carry `owner: "me"`; in the cloud `owner` is the
 * auth user id. We translate at the boundary so the rest of the app is unchanged.
 */

interface PortfolioRow {
  id: string;
  owner: string;
  name: string;
  mode: string;
  description: string;
  is_public: boolean;
  accent: string | null;
  holdings: PortfolioHolding[] | null;
  discovery: PortfolioDiscovery | null;
  value_history: Portfolio["valueHistory"] | null;
  created_at: string;
  updated_at: string;
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

const COLS =
  "id, owner, name, mode, description, is_public, accent, holdings, discovery, value_history, created_at, updated_at";

function toPortfolio(r: PortfolioRow): Portfolio {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode as PortfolioMode,
    description: r.description ?? "",
    owner: "me",
    isPublic: r.is_public,
    holdings: Array.isArray(r.holdings) ? r.holdings : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    accent: r.accent ?? undefined,
    discovery: r.discovery ?? undefined,
    valueHistory: r.value_history ?? undefined,
  };
}

function toRow(userId: string, p: Portfolio): Record<string, unknown> {
  return {
    id: p.id,
    owner: userId,
    name: p.name,
    mode: p.mode,
    description: p.description ?? "",
    is_public: p.isPublic,
    accent: p.accent ?? null,
    holdings: p.holdings ?? [],
    discovery: p.discovery ?? null,
    value_history: p.valueHistory ?? [],
    updated_at: p.updatedAt ?? new Date().toISOString(),
  };
}

/** All of the signed-in user's cloud portfolios. */
export async function fetchMyPortfolios(userId: string): Promise<Portfolio[]> {
  const { data, error } = await client()
    .from("portfolios")
    .select(COLS)
    .eq("owner", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as PortfolioRow[]).map(toPortfolio);
}

/** Ids of the user's cloud portfolios (cheap; used to compute deletes). */
export async function fetchMyPortfolioIds(userId: string): Promise<string[]> {
  const { data, error } = await client().from("portfolios").select("id").eq("owner", userId);
  if (error) throw error;
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

export async function upsertPortfolios(userId: string, portfolios: Portfolio[]): Promise<void> {
  if (portfolios.length === 0) return;
  const { error } = await client()
    .from("portfolios")
    .upsert(portfolios.map((p) => toRow(userId, p)), { onConflict: "id" });
  if (error) throw error;
}

export async function deletePortfolios(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client()
    .from("portfolios")
    .delete()
    .eq("owner", userId)
    .in("id", ids);
  if (error) throw error;
}
