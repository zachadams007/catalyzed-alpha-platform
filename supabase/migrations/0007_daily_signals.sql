-- Catalyzed Alpha - daily_signals shared-compute cache
--
-- Shared daily compute: the day's universe scan runs ONCE (the first tester to
-- open the app that market day computes it), and every other tester READS the
-- finished result here - zero vendor API calls, no per-device 60/min Finnhub
-- burst. The stored `signals` JSONB is the exact published feed (StockSignal[]),
-- so a reader's app is fully functional: same cards, scores, feeds - it just
-- skips the compute.
--
-- RLS: public (anon) read. INSERT is allowed for anon/authenticated but tightly
-- guarded - only TODAY's row (US/Eastern market day), shape-validated, and the
-- date PRIMARY KEY makes it first-writer-wins (clients send the equivalent of
-- ON CONFLICT DO NOTHING). No UPDATE/DELETE for clients, so a published day is
-- immutable from the bundle. This is intentionally write-light: only ~10 trusted
-- friends hold the public anon key, the payload is non-sensitive public stock
-- scores, and a bad day is self-healing (it rolls over at the next market day).
--
-- Run via: supabase db push  (or paste into the Supabase SQL Editor).

create table if not exists public.daily_signals (
  -- US/Eastern calendar date the scan represents (YYYY-MM-DD). One row per day;
  -- the PK is what makes the shared compute first-writer-wins.
  market_day    date primary key,

  -- The published feed: a StockSignal[] exactly as the engine produced it.
  signals       jsonb not null,

  -- The ResearchRun metadata that produced these signals (provider, counts,
  -- finishedAt) so a reader can restore lastRun and the once-daily freshness gate.
  run           jsonb,

  -- Free-form provenance (provider name, universe size, app build).
  meta          jsonb not null default '{}'::jsonb,

  -- Denormalized count, validated against the array length below.
  signal_count  integer not null,

  -- When the first opener finished computing this day's scan.
  computed_at   timestamptz not null default now(),

  -- Row bookkeeping.
  created_at    timestamptz not null default now(),

  -- Shape guards (belt-and-suspenders alongside the RLS WITH CHECK).
  constraint daily_signals_count_range check (signal_count between 1 and 6000),
  constraint daily_signals_is_array check (jsonb_typeof(signals) = 'array'),
  constraint daily_signals_count_matches check (jsonb_array_length(signals) = signal_count)
);

-- Row-level security - enable and lock down.
alter table public.daily_signals enable row level security;

-- Public (anon + authenticated) read: the feed is research-only, no PII.
drop policy if exists "public read daily signals" on public.daily_signals;
create policy "public read daily signals"
  on public.daily_signals for select
  to anon, authenticated
  using (true);

-- Guarded insert: only the current US/Eastern market day, shape-validated. The
-- PK rejects a second write for the same day (first opener wins). No echoing of
-- secrets is possible - this is data only.
drop policy if exists "guarded insert daily signals" on public.daily_signals;
create policy "guarded insert daily signals"
  on public.daily_signals for insert
  to anon, authenticated
  with check (
    market_day = (now() at time zone 'America/New_York')::date
    and signal_count between 1 and 6000
    and jsonb_typeof(signals) = 'array'
    and jsonb_array_length(signals) = signal_count
  );

-- No UPDATE / DELETE policies for anon or authenticated: a published day is
-- immutable from the client bundle. Maintenance (manual purge) uses the
-- service-role key server-side, which bypasses RLS.

-- Lightweight payload sanity: reject empty arrays and arrays whose first element
-- isn't shaped like a StockSignal (must carry a ticker). Cheap O(1) check that
-- raises the bar against a malformed/garbage insert without scanning every row.
create or replace function public.validate_daily_signals()
returns trigger
language plpgsql
as $$
begin
  if jsonb_array_length(new.signals) = 0 then
    raise exception 'daily_signals.signals must be a non-empty array';
  end if;
  if (new.signals -> 0 -> 'ticker') is null then
    raise exception 'daily_signals.signals elements must look like StockSignal (missing ticker)';
  end if;
  return new;
end;
$$;

drop trigger if exists daily_signals_validate on public.daily_signals;
create trigger daily_signals_validate
  before insert on public.daily_signals
  for each row execute function public.validate_daily_signals();
