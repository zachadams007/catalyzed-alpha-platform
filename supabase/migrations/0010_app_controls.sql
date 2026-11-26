-- Catalyzed Alpha - Global operator controls (app_controls)
-- =============================================================================
-- WHY: Sample-data mode, the live-data pause, budget enforcement, and per-vendor
-- budgets used to be DEVICE-LOCAL (localStorage), so a signed-out browser could
-- ignore the operator and still pull real data, and the operator's toggle never
-- reached anyone else. These controls are GLOBAL, SERVER-SIDE state that governs
-- the ENTIRE app for ALL users (signed-in or anonymous). The OPERATOR account is
-- the only writer.
--
-- This migration ships:
--   • app_operators - the server-side allowlist of operator emails (writers).
--   • app_controls - a SINGLETON row holding the global controls (sample-data
--                      mode, the live-data pause, budget enforcement, per-vendor
--                      budgets, AND the globally-active engine variant - the model
--                      every client runs as, set by the operator's "Promote").
--   • set_app_controls(...) - operator-only SECURITY DEFINER RPC to write them.
--
-- READ access is open to BOTH `authenticated` AND `anon` so a signed-out client
-- still honors the operator's sample/pause choice (the core fix). WRITE access is
-- locked to the operator allowlist, enforced server-side in the RPC - never from
-- the client.
--
-- Run once in your Supabase project's SQL editor, or via the CLI:
--     supabase db push                       (with migrations linked), or
--     paste this file into the SQL editor and run it.
-- Safe to re-run: policies/functions are dropped first; tables use IF NOT EXISTS;
-- the singleton + operator seed use ON CONFLICT DO NOTHING.
--
-- ⚠️  AFTER RUNNING: replace the seeded operator email below with YOUR operator
--     sign-in email (the same one in VITE_ADMIN_EMAILS), or run:
--       insert into public.app_operators (email) values ('you@example.com')
--       on conflict (email) do nothing;

-- =============================================================================
-- Operator allowlist (server-side source of truth for "who may write controls")
-- =============================================================================
create table if not exists public.app_operators (
  email      text primary key check (char_length(trim(email)) between 3 and 254),
  created_at timestamptz not null default now()
);

-- Seed the operator. EDIT this address to your real operator sign-in email.
insert into public.app_operators (email) values ('operator@example.com')
  on conflict (email) do nothing;

-- =============================================================================
-- Singleton controls table
-- =============================================================================
-- One row only, pinned to id = true via a one-row CHECK. Mirrors the client
-- ApiControls + sample-mode shape so the app can read it directly.
create table if not exists public.app_controls (
  id              boolean primary key default true check (id),
  sample_mode     boolean     not null default true,
  live_paused     boolean     not null default true,
  enforce_budgets boolean     not null default true,
  budgets         jsonb       not null default '{}'::jsonb,
  -- The globally-active engine variant - the model EVERY client runs as. The
  -- operator's "Promote → Champion" writes this (via set_app_controls), so the
  -- promoted model goes live for all users, not just one device. Defaults to the
  -- safe shipped champion; the value is constrained by a NAMED check added below
  -- (so the fresh-create and re-run-upgrade paths converge on one constraint).
  active_variant  text        not null default 'champion',
  updated_by      text,
  updated_at      timestamptz not null default now()
);

-- Re-run safety: a project created before active_variant existed already has the
-- table (so the CREATE above is a no-op) - add the column idempotently so
-- re-applying this 0009 file upgrades that older row in place.
alter table public.app_controls
  add column if not exists active_variant text not null default 'champion';

-- Single NAMED check constraint (idempotent for both the fresh-create and the
-- in-place-upgrade paths - neither defines it inline, so it's added exactly once).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_controls_active_variant_check'
  ) then
    alter table public.app_controls
      add constraint app_controls_active_variant_check
      check (active_variant in ('champion', 'challenger'));
  end if;
end $$;

-- Seed the singleton row (fail-closed defaults: sample ON, live paused, the
-- shipped champion live).
insert into public.app_controls (id) values (true)
  on conflict (id) do nothing;

-- =============================================================================
-- Operator check helper (SECURITY DEFINER so it can read app_operators under
-- RLS; matches the caller's verified JWT email against the allowlist).
-- =============================================================================
create or replace function public.is_app_operator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_operators o
    where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- =============================================================================
-- Row-level security
-- =============================================================================
alter table public.app_operators enable row level security;
alter table public.app_controls  enable row level security;

-- Anyone (signed-in OR anonymous) may READ the global controls so every client
-- honors the operator's setting. This is the core of the fix.
drop policy if exists "everyone reads controls" on public.app_controls;
create policy "everyone reads controls"
  on public.app_controls for select to anon, authenticated
  using (true);

-- No direct INSERT/UPDATE/DELETE policy on app_controls: writes go through the
-- SECURITY DEFINER RPC below, which enforces the operator allowlist. With RLS on
-- and no write policy, direct table writes from anon/authenticated are rejected.

-- The operator allowlist itself: operators may read it (to confirm their status);
-- nobody may write it from the client (managed in the SQL editor by the owner).
drop policy if exists "operators read allowlist" on public.app_operators;
create policy "operators read allowlist"
  on public.app_operators for select to authenticated
  using (public.is_app_operator());

-- =============================================================================
-- Operator-only writer RPC. NULL args leave that field unchanged (partial patch),
-- so the client can flip one toggle without clobbering the others. Returns the
-- full updated row so the caller can echo it locally.
-- =============================================================================
-- Drop the prior 4-arg signature first: adding the p_active_variant parameter
-- changes the function's identity, so without this an older 4-arg version would
-- linger as a separate overload. Dropping it keeps exactly one canonical RPC.
drop function if exists public.set_app_controls(boolean, boolean, boolean, jsonb);

create or replace function public.set_app_controls(
  p_sample_mode     boolean default null,
  p_live_paused     boolean default null,
  p_enforce_budgets boolean default null,
  p_budgets         jsonb   default null,
  p_active_variant  text    default null
)
returns public.app_controls
language plpgsql security definer set search_path = public as $$
declare
  v_email text := coalesce(auth.jwt() ->> 'email', '');
  v_row   public.app_controls;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_app_operator() then
    raise exception 'Operator privileges required';
  end if;
  -- Reject an unknown variant before touching the row (NULL = leave unchanged).
  if p_active_variant is not null and p_active_variant not in ('champion', 'challenger') then
    raise exception 'Invalid active_variant: %', p_active_variant;
  end if;

  update public.app_controls
     set sample_mode     = coalesce(p_sample_mode, sample_mode),
         -- Sample mode forces live OFF (matches the client invariant): if the
         -- caller turns sample ON, live is pinned paused regardless of p_live_paused.
         live_paused     = case
                             when coalesce(p_sample_mode, sample_mode) then true
                             else coalesce(p_live_paused, live_paused)
                           end,
         enforce_budgets = coalesce(p_enforce_budgets, enforce_budgets),
         budgets         = coalesce(p_budgets, budgets),
         -- The globally-active model. NULL leaves it unchanged so a sample/pause
         -- toggle never clobbers the promoted variant, and vice-versa.
         active_variant  = coalesce(p_active_variant, active_variant),
         updated_by      = lower(v_email),
         updated_at      = now()
   where id = true
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.set_app_controls(boolean, boolean, boolean, jsonb, text) from public;
grant execute on function public.set_app_controls(boolean, boolean, boolean, jsonb, text) to authenticated;
grant execute on function public.is_app_operator() to anon, authenticated;

-- =============================================================================
-- Realtime: let every client live-update when the operator flips a control.
-- =============================================================================
do $$
begin
  -- add_table is idempotent-unfriendly; guard against a duplicate add on re-run.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_controls'
  ) then
    alter publication supabase_realtime add table public.app_controls;
  end if;
end $$;
