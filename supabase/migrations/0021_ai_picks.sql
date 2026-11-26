-- Catalyzed Alpha - AI Pick of the Day table
-- =============================================================================
-- WHY: The `ai-pick` edge function runs daily (mirroring the daily_signals
-- pg_cron schedule) and writes one "hero" pick + 2 runners-up for every market
-- day. The UI reads these back so every user sees the SAME server-side pick -
-- no client LLM calls, no per-device variance.
--
-- TRUSTED-WRITER CONTRACT (matches daily_signals / discovered_catalysts):
--   • anon + authenticated: SELECT only (public read).
--   • Writes: ONLY via the service-role key inside the `ai-pick` edge function.
--     Because RLS is enabled and no INSERT/UPDATE/DELETE policy exists for
--     anon/authenticated, client writes are denied by RLS. The service-role key
--     bypasses RLS, so only the trusted scheduled function can write. This
--     mirrors the hardening in 0013_daily_signals_trusted_writer.sql.
--
-- Apply via `supabase db push` or paste into the SQL editor. Idempotent:
-- table / index use IF NOT EXISTS; policies are dropped before re-creation.
-- =============================================================================

create table if not exists public.ai_picks (
  -- The US/Eastern calendar date this pick was generated for (same clock as
  -- daily_signals / discovered_catalysts so they align on the same market day).
  market_day        date    not null,

  -- 0 = hero ("Pick of the Day"), 1 = first runner-up, 2 = second runner-up.
  -- Composite PK (market_day, rank) means one row per slot per day; re-running
  -- the edge function on the same day UPSERTs (safe replay).
  rank              int     not null check (rank between 0 and 2),

  -- The recommended ticker.
  ticker            text    not null,

  -- Blended score: 0.6 * engine_score + 0.4 * judge_score (0–100).
  final_score       numeric not null,

  -- The deterministic engine score from daily_signals for this ticker (0–100).
  -- Default 50 if the ticker was absent from the universe that day.
  engine_score      numeric not null default 50,

  -- The AI judge's score for this ticker (0–100).
  judge_score       numeric not null,

  -- Judge's confidence in the pick (0–1). Hero must have confidence > 0.65.
  confidence        numeric not null,

  -- Suggested hold horizon in trading days (1–5).
  horizon_days      int     not null default 1,

  -- One-line catalyst summary (from the Gemini deep-dive, Stage 3).
  catalyst_summary  text    not null default '',

  -- Catalyst category from Stage 3 deep-dive.
  -- e.g. 'earnings', 'fda', 'insider_buy', 'ma', 'political', 'guidance', 'other'.
  catalyst_type     text    not null default 'other',

  -- The primary grounded source URL (Gemini retrieved, ≤72h old at pick time).
  primary_source_url text   not null default '',

  -- The bull advocate's case (from Groq Stage 4, stored verbatim).
  bull_case         text    not null default '',

  -- The bear advocate's case (from Groq Stage 4, stored verbatim).
  bear_case         text    not null default '',

  -- The skeptic's note (Groq Stage 7, winner only - the #1 trust differentiator).
  -- "What must be false for this to work? Which assumptions are unverified?"
  skeptic_note      text    not null default '',

  -- True when the judge penalised this pick as macro-driven (not company-specific).
  -- Shown as a warning badge in the UI so users know the catalyst is broad.
  macro_driven      boolean not null default false,

  created_at        timestamptz not null default now(),

  primary key (market_day, rank)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Fast "give me today's picks in rank order" query the UI runs on load.
create index if not exists ai_picks_market_day_rank_idx
  on public.ai_picks (market_day desc, rank asc);

-- ---------------------------------------------------------------------------
-- Row-level security - public read, service-role write only.
-- ---------------------------------------------------------------------------
alter table public.ai_picks enable row level security;

drop policy if exists "public read ai picks" on public.ai_picks;
create policy "public read ai picks"
  on public.ai_picks for select
  to anon, authenticated
  using (true);

-- No INSERT / UPDATE / DELETE policy for anon or authenticated.
-- With RLS enabled and no write policy, every client write is denied. The
-- ONLY writer is the `ai-pick` edge function via the service-role key, which
-- bypasses RLS (same contract as daily_signals after 0013 hardening).
revoke insert, update, delete on public.ai_picks from anon;
revoke insert, update, delete on public.ai_picks from authenticated;
