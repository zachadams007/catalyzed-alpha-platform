// Supabase Edge Function: terminal-feed
//
// Returns cached TerminalEvent[] from the terminal_events table so phone/web
// clients get the same feed as the desktop build without making keyed
// cross-origin calls to Alpaca / FMP / SEC directly.
//
// The Python miner and the desktop-side writer upsert rows server-side using
// the service-role key. This function reads them back with anon/public access
// (RLS allows public SELECT - the data is research-only, no PII).
//
// Ordering mirrors the client-side rank() in terminalFeed.ts:
//   severity rank (high=3, elevated=2, watch=1) desc, then surfaced_at desc.
//
// Query params (all optional):
//   limit - max rows to return (default 100, max 200)
//   kind - filter to one TerminalEventKind
//   ticker - filter to a primary ticker

// deno-lint-ignore-file no-explicit-any

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Map severity label to numeric rank for client-compatible ordering. */
const SEVERITY_RANK: Record<string, number> = { high: 3, elevated: 2, watch: 1 };

/** Convert a snake_case DB row back to the camelCase TerminalEvent contract. */
function rowToEvent(row: any) {
  return {
    id:             row.id as string,
    kind:           row.kind as string,
    severity:       row.severity as string,
    ticker:         row.ticker as string,
    relatedTickers: (row.related_tickers as string[] | null) ?? undefined,
    companyName:    (row.company_name as string | null) ?? undefined,
    headline:       row.headline as string,
    summary:        (row.summary as string | null) ?? undefined,
    actor:          row.actor ?? undefined,
    trade:          row.trade ?? undefined,
    occurredAt:     row.occurred_at as string,
    surfacedAt:     row.surfaced_at as string,
    source:         row.source as { name: string; url: string },
    reason:         (row.reason as string | null) ?? undefined,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  // --- Supabase client (anon key - RLS permits public SELECT) ----------------
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return json({ error: "Supabase env not configured" }, 500);
  }
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  // --- Parse query params ----------------------------------------------------
  const url = new URL(req.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 200);
  const kind = url.searchParams.get("kind") ?? null;
  const ticker = url.searchParams.get("ticker") ?? null;

  // --- Query -----------------------------------------------------------------
  // Fetch a larger window than `limit` so we can apply the same
  // severity-then-recency sort as the TypeScript client (terminalFeed.ts rank())
  // without relying on a computed column. The DB index on surfaced_at desc keeps
  // this fast for the common case.
  let query = supabase
    .from("terminal_events")
    .select("*")
    .order("surfaced_at", { ascending: false })
    .limit(limit * 3); // over-fetch so the in-process sort is representative

  if (kind) query = query.eq("kind", kind);
  if (ticker) query = query.eq("ticker", ticker.toUpperCase());

  const { data, error } = await query;

  if (error) {
    return json({ error: "Database query failed", detail: error.message }, 502);
  }

  const rows: any[] = Array.isArray(data) ? data : [];

  // --- Dedupe (by id) --------------------------------------------------------
  const seen = new Set<string>();
  const unique: any[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push(row);
  }

  // --- Rank: severity desc, then surfaced_at desc (mirrors terminalFeed.ts) --
  unique.sort((a, b) => {
    const sev =
      (SEVERITY_RANK[b.severity as string] ?? 0) -
      (SEVERITY_RANK[a.severity as string] ?? 0);
    if (sev !== 0) return sev;
    return new Date(b.surfaced_at as string).getTime() - new Date(a.surfaced_at as string).getTime();
  });

  // --- Trim to requested limit and map to TerminalEvent contract -------------
  const events = unique.slice(0, limit).map(rowToEvent);

  return json({ events, generatedAt: new Date().toISOString() });
});
