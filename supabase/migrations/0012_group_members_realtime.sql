-- Catalyzed Alpha - Realtime for group_members (membership lifecycle)
-- =============================================================================
-- WHY: `group_members` was the one cross-user social table still missing from the
-- realtime publication (0011 added friendships / shares / group_watchlist /
-- group_calls / groups, but NOT group_members). Without it:
--   • the active group's roster + member COUNT never updated live - accepting an
--     invite left the inviter's "N members" / member list stale until a reselect;
--   • there was no live signal that the VIEWER had been added to (or removed
--     from) a group, so a brand-new group never appeared in their rail until a
--     full reload.
--
-- Adding `public.group_members` to `supabase_realtime` lets the client open
-- `postgres_changes` channels on it:
--   • a per-active-group channel (filter group_id=eq.<id>) to re-pull the roster
--     + patch the member count when anyone joins/leaves the open group, and
--   • an app-level channel (filter user_id=eq.<viewerId>) so being added to a new
--     group is live for the viewer.
--
-- RLS is unchanged and already correct - realtime delivery is still filtered
-- through the table's SELECT policy, so a user only receives membership changes
-- for groups they are already allowed to read.
--
-- Idempotent: the add is guarded on pg_publication_tables (mirrors 0011), so
-- re-running the migration (or applying it after a partial earlier run) is a no-op.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_members'
  ) then alter publication supabase_realtime add table public.group_members; end if;
end $$;
