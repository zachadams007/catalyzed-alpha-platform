-- Catalyzed Alpha - server-side, persistent, cross-user API-usage tracker.
-- =============================================================================
-- WHY: the shared free-tier vendor keys (Finnhub, FMP, Gemini, Groq, Alpaca) are POOLED across
-- everyone using the app via the `market-proxy` (and `research-agent`) edge functions. Until now
-- the Operator board could only show (a) the local DEVICE's localStorage ledger and (b) the edge
-- functions' in-memory per-key counters - and those in-memory counters RESET on every cold
-- start.
--
-- This migration adds a tiny durable counter table the edge functions bump
-- (fire-and-forget) after every vendor request, plus two RPCs:
--   • bump_api_usage(vendor, key_label, ok) - SECURITY DEFINER upsert (+1 call,
--       +1 failure when !ok). Called by the edge functions with the service-role key.
--   • get_api_usage_today() - SECURITY DEFINER read of TODAY's rows
--       (ET market day). Counts are NOT sensitive, so anon+authenticated may read
--       (the dashboard UI is already admin-gated).
--
-- "Today" is the EASTERN (America/New_York) market day so the board's day rolls over
-- with the U.S. market, matching the daily-scan / signals clocks.
--
-- Ambiguous-colref lesson (see 0017): every column reference inside the RPCs is
-- qualified (`api_usage_daily.<col>` in the UPDATE, table aliases in the read) so a
-- column name can never bind to a RETURNS-TABLE OUT parameter or a local.
--
-- Apply via `supabase db push` or by pasting into the SQL editor. Idempotent:
-- table uses IF NOT EXISTS; functions use CREATE OR REPLACE; the policy is dropped
-- first. No direct table grants - all access goes through the two RPCs.

-- =============================================================================
-- Counter table - one row per (market day, vendor, key label).
-- =============================================================================
create table if not exists public.api_usage_daily (
  market_day date        not null,
  vendor     text        not null,
  key_label  text        not null,
  calls      bigint      not null default 0,
  failures   bigint      not null default 0,
  last_used  timestamptz not null default now(),
  primary key (market_day, vendor, key_label)
);

-- RLS on, with NO direct INSERT/UPDATE/DELETE/SELECT policy for anon/authenticated:
-- writes happen only through the SECURITY DEFINER bump RPC (run with the service
-- role from the edge functions), reads only through get_api_usage_today(). With RLS
-- enabled and no policy, direct table access from the client is rejected.
alter table public.api_usage_daily enable row level security;

-- =============================================================================
-- Helper: the current EASTERN market day (so the board rolls over with the market).
-- =============================================================================
create or replace function public.api_usage_market_day()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'America/New_York')::date;
$$;

-- =============================================================================
-- WRITE RPC - increment the counter for one vendor key.
-- SECURITY DEFINER (owner postgres) so it can write the RLS-protected table. It
-- only ever increments counters - it touches no secrets and reads no user data -
-- so granting EXECUTE to anon/authenticated as well as service_role is safe.
-- =============================================================================
create or replace function public.bump_api_usage(
  p_vendor    text,
  p_key_label text,
  p_ok        boolean default true
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'America/New_York')::date;
begin
  -- Guard against junk input - a NULL/blank vendor or label would create a useless
  -- row and is never expected from the edge functions.
  if p_vendor is null or btrim(p_vendor) = '' or p_key_label is null or btrim(p_key_label) = '' then
    return;
  end if;

  insert into public.api_usage_daily (market_day, vendor, key_label, calls, failures, last_used)
  values (v_day, btrim(p_vendor), btrim(p_key_label), 1, case when p_ok then 0 else 1 end, now())
  on conflict (market_day, vendor, key_label) do update
    set calls     = api_usage_daily.calls + 1,
        failures  = api_usage_daily.failures + (case when p_ok then 0 else 1 end),
        last_used = now();
end;
$$;

-- =============================================================================
-- READ RPC - all of TODAY's rows (Eastern market day). Counts only; not sensitive.
-- The dashboard is admin-gated already, but even unauthenticated reads of a call
-- COUNT leak nothing, so grant to anon + authenticated.
-- =============================================================================
create or replace function public.get_api_usage_today()
returns table (
  vendor    text,
  key_label text,
  calls     bigint,
  failures  bigint,
  last_used timestamptz
)
language sql stable security definer set search_path = public as $$
  select u.vendor, u.key_label, u.calls, u.failures, u.last_used
  from public.api_usage_daily u
  where u.market_day = (now() at time zone 'America/New_York')::date
  order by u.vendor, u.key_label;
$$;

-- =============================================================================
-- Grants - execute on the RPCs only; never on the table directly.
-- =============================================================================
revoke all on function public.bump_api_usage(text, text, boolean) from public;
grant execute on function public.bump_api_usage(text, text, boolean)
  to service_role, anon, authenticated;

revoke all on function public.get_api_usage_today() from public;
grant execute on function public.get_api_usage_today() to anon, authenticated;

revoke all on function public.api_usage_market_day() from public;
grant execute on function public.api_usage_market_day() to anon, authenticated;
