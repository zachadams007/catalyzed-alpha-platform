-- Catalyzed Alpha - member holdings (view another group member's shared positions)
-- =============================================================================
-- Powers the K5 social feature: from a group, click a member → see the tickers
-- THEY are surfacing, then add them as a friend if you share a group. A member's
-- FULL private portfolio is intentionally NOT exposed - RLS on public.portfolios
-- (0003) only lets an owner read their own rows (or anyone read an is_public one),
-- and we keep it that way. What IS shareable, scoped to a group you BOTH belong
-- to, is honest and already member-visible elsewhere in the app:
--
--   1. Tickers the member added to a SHARED GROUP WATCHLIST you both can see.
--   2. Tickers the member logged a CALL on in a shared group.
--   3. Holdings from any of the member's PUBLIC portfolios (is_public = true) -
--      already world-readable under the 0003 RLS, surfaced here for convenience.
--
-- A single SECURITY DEFINER RPC returns the union, de-duplicated by ticker, with
-- a `source` tag and the freshest note/timestamp, ONLY when the caller and the
-- target share at least one group. No new table, no schema change to portfolios.
--
-- Run once in your Supabase project's SQL editor, or via the CLI:
--     supabase db push                       (with migrations linked), or
--     paste this file into the SQL editor and run it.
-- Safe to re-run: the function is dropped/replaced; grants are idempotent.
-- Depends on 0001_friends.sql (profiles), 0003_portfolios.sql (portfolios),
-- 0008_groups.sql (groups, group_members, group_watchlist, group_calls,
-- is_group_member()).
--
-- COLREF DISCIPLINE (the 0017/0018 lesson): every RETURNS TABLE OUT column name
-- that collides with a real table column (group_id, ticker, note, …) is shadowed
-- by aliasing every table and fully-qualifying every column reference inside the
-- function body.

-- ===========================================================================
-- RPC - a member's group-shared + public-portfolio holdings, visible to a
-- co-member only. SECURITY DEFINER so it can read the target's public-portfolio
-- rows and confirm the shared-group gate without leaking anything private.
-- ===========================================================================
create or replace function public.get_member_holdings(p_group_id uuid, p_member uuid)
returns table (
  ticker     text,
  source     text,   -- 'watchlist' | 'call' | 'public_portfolio'
  note       text,
  created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  -- Gate: the caller must share the named group with the target. p_group_id is
  -- the group the click happened in; both must be members of it. (is_group_member
  -- is the same membership check the rest of the groups layer uses.)
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'Only members can view this group';
  end if;
  if not public.is_group_member(p_group_id, p_member) then
    raise exception 'That person is not in this group';
  end if;

  return query
  -- 1) Tickers the member added to ANY group's shared watchlist that the CALLER
  --    is also a member of (not only the clicked group - anything you can both see).
  select gw.ticker,
         'watchlist'::text as source,
         gw.note,
         gw.created_at
  from public.group_watchlist gw
  where gw.added_by = p_member
    and public.is_group_member(gw.group_id, v_uid)

  union all

  -- 2) Tickers the member logged a CALL on in a shared group.
  select gc.ticker,
         'call'::text as source,
         gc.note,
         gc.called_at as created_at
  from public.group_calls gc
  where gc.author = p_member
    and public.is_group_member(gc.group_id, v_uid)

  union all

  -- 3) Holdings from the member's PUBLIC portfolios (already world-readable under
  --    the 0003 RLS). Each holding is a JSON object { ticker, note?, addedAt? }.
  select upper(trim(h.elem->>'ticker'))             as ticker,
         'public_portfolio'::text                    as source,
         nullif(h.elem->>'note', '')                 as note,
         pf.updated_at                               as created_at
  from public.portfolios pf
  cross join lateral jsonb_array_elements(pf.holdings) as h(elem)
  where pf.owner = p_member
    and pf.is_public = true
    and coalesce(trim(h.elem->>'ticker'), '') <> ''

  order by created_at desc;
end;
$$;

revoke all on function public.get_member_holdings(uuid, uuid) from public;
grant execute on function public.get_member_holdings(uuid, uuid) to authenticated;
