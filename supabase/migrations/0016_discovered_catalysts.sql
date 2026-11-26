-- Catalyzed Alpha - discovered_catalysts cache table
--
-- The autonomous catalyst-DISCOVERY engine (research-agent `catalyst_scan` task)
-- runs SERVER-SIDE on the daily schedule and writes its result here. The Terminal
-- + feed read it back so political callouts/trades, notable insider buys, and
-- major catalysts (M&A/FDA/guidance/contracts) surface automatically - no example
-- ever has to be hand-coded in executiveTrades.ts again (that becomes the seed).
--
-- Shape: ONE row per US/Eastern market_day holding the full scan blob, mirroring
-- daily_signals (cheapest path; the client reads the latest row). The `catalysts`
-- JSON is ScannedCatalyst[]: { ticker, company, headline, actor, role, direction,
-- date, importance, kind, url } - every item has a REAL ticker + REAL source URL
-- (the edge function drops anything unsourced; no fabrication).
--
-- RLS: public (anon) read-only - same contract as daily_signals / terminal_events.
-- Writes ONLY via the service-role key (the scheduled scan), which bypasses RLS.
--
-- Run via: supabase db push  (or the Management API, or paste into the SQL Editor).

create table if not exists public.discovered_catalysts (
  -- US/Eastern calendar date the scan ran for (YYYY-MM-DD). One row per day,
  -- upserted (re-run replaces the day), first-class key like daily_signals.
  market_day   text primary key,

  -- ScannedCatalyst[] - the validated, deduped discovered catalysts.
  catalysts    jsonb not null default '[]'::jsonb,

  -- How many catalysts in the blob (cheap count for telemetry / empty checks).
  catalyst_count integer not null default 0,

  -- When the scan finished (ISO).
  generated_at timestamptz not null default now(),

  -- Scan provenance: { queriesGrounded, rawSources, structured }.
  meta         jsonb,

  created_at   timestamptz not null default now()
);

-- Latest-row lookup.
create index if not exists discovered_catalysts_generated_at_idx
  on public.discovered_catalysts (generated_at desc);

-- Row-level security - public read, service-role write only.
alter table public.discovered_catalysts enable row level security;

drop policy if exists "public read discovered catalysts" on public.discovered_catalysts;
create policy "public read discovered catalysts"
  on public.discovered_catalysts for select
  to anon, authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policy for anon/authenticated - writes require the
-- service-role key (the scheduled scan), which bypasses RLS. Intentional, and
-- matches daily_signals (0013) + terminal_events (0005).
revoke insert, update, delete on public.discovered_catalysts from anon;
revoke insert, update, delete on public.discovered_catalysts from authenticated;
