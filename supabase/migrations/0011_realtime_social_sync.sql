-- Catalyzed Alpha - Realtime for the remaining cross-user social tables
-- =============================================================================
-- WHY: Several shared-state surfaces wrote correctly to Supabase (RLS verified)
-- but only ever REFETCHED on sign-in or after the viewer's OWN mutation, so a
-- second user never saw the change live:
--   • friendships / shares - a friend request or a posted ticker stayed invisible
--                             to the other person until a full reload (C-1).
--   • group_watchlist / group_calls - a teammate adding a name or logging a call
--                             left every other member's Watchlist tab, call ledger,
--                             and leaderboard stale until they reselected the group
--                             (C-2). The 0008 TODO to publish these was never run.
--   • groups - flipping the leaderboard toggle never reached other
--                             members (C-3/C-4: the group row was not published).
--
-- This migration adds exactly those tables to the `supabase_realtime` publication
-- so the client can open `postgres_changes` channels on them. RLS is unchanged and
-- already correct - realtime delivery is still filtered through each row's SELECT
-- policy, so a user only receives changes they are already allowed to read.
--
-- Idempotent: each add is guarded on pg_publication_tables (mirrors 0009), so
-- re-running the migration (or applying it after a partial earlier run) is a no-op.
-- =============================================================================

do $$
begin
  -- C-1: friends graph + shares feed update live for the other user.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then alter publication supabase_realtime add table public.friendships; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shares'
  ) then alter publication supabase_realtime add table public.shares; end if;

  -- C-2: shared watchlist + call ledger / leaderboard update live for members.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_watchlist'
  ) then alter publication supabase_realtime add table public.group_watchlist; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_calls'
  ) then alter publication supabase_realtime add table public.group_calls; end if;

  -- C-4: the leaderboard-enabled toggle broadcasts to other members.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'groups'
  ) then alter publication supabase_realtime add table public.groups; end if;
end $$;
