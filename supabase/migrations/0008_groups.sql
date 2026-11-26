-- Catalyzed Alpha - Groups schema
-- Private, invite-only shared spaces: a finance group chat fused with the app's
-- stock intelligence. Distinct from Channels (public broadcast) and Friends (1:1).
--
-- This increment ships: groups + membership (roles), shareable invite links, a
-- shared group watchlist, and a stock-"call" ledger that powers a performance
-- leaderboard. Chat / polls / push-alerts are intentionally OUT OF SCOPE here
-- (see the TODOs at the bottom).
--
-- Run once in your Supabase project's SQL editor, or via the CLI:
--     supabase db push                       (with migrations linked), or
--     paste this file into the SQL editor and run it.
-- Safe to re-run: policies/functions are dropped first; tables use IF NOT EXISTS.
-- Depends on 0001_friends.sql (public.profiles + the auth → profile trigger).

-- ===========================================================================
-- Tables
-- ===========================================================================

-- groups: one row per private space. `leaderboard_enabled` is the per-group
-- toggle from the design (the creator decides whether calls are ranked).
create table if not exists public.groups (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(trim(name)) between 1 and 80),
  description         text not null default '',
  created_by          uuid not null references public.profiles(id) on delete cascade,
  leaderboard_enabled boolean not null default true,
  created_at          timestamptz not null default now()
);

-- group_members: who belongs, and their role. One row per (group, user).
create table if not exists public.group_members (
  id        uuid primary key default gen_random_uuid(),
  group_id  uuid not null references public.groups(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  constraint group_members_unique unique (group_id, user_id)
);

-- group_invites: a shareable link token. One group can have several; the creator
-- mints the first at creation. `revoked` / `expires_at` let a link be turned off.
create table if not exists public.group_invites (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  token      text not null unique,
  created_by uuid not null references public.profiles(id) on delete cascade,
  revoked    boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- group_watchlist: the collective watchlist. Unique per (group, ticker) - the
-- group watches a name once, attributed to whoever added it first.
create table if not exists public.group_watchlist (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  ticker     text not null check (char_length(ticker) between 1 and 12),
  added_by   uuid not null references public.profiles(id) on delete cascade,
  note       text not null default '',
  created_at timestamptz not null default now(),
  constraint group_watchlist_unique unique (group_id, ticker)
);

-- group_calls: the append-only call ledger. A member "calls" a stock buy/watch;
-- we snapshot the price AT call time so the leaderboard can rank honest returns.
-- Immutable by design - there is no UPDATE policy, so a called price can't be
-- rewritten after the fact.
create table if not exists public.group_calls (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups(id) on delete cascade,
  author       uuid not null references public.profiles(id) on delete cascade,
  ticker       text not null check (char_length(ticker) between 1 and 12),
  direction    text not null check (direction in ('buy','watch')),
  called_price numeric(18,4) not null check (called_price > 0),
  note         text not null default '',
  called_at    timestamptz not null default now()
);

-- ===========================================================================
-- Membership helpers (SECURITY DEFINER → run as owner, bypassing RLS so the
-- membership policies don't recurse on group_members).
-- ===========================================================================

create or replace function public.is_group_member(p_group uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = p_group and m.user_id = p_user
  );
$$;

create or replace function public.is_group_admin(p_group uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = p_group and m.user_id = p_user and m.role in ('owner','admin')
  );
$$;

-- ===========================================================================
-- Row-level security
-- ===========================================================================

alter table public.groups          enable row level security;
alter table public.group_members   enable row level security;
alter table public.group_invites   enable row level security;
alter table public.group_watchlist enable row level security;
alter table public.group_calls     enable row level security;

-- ---- groups ---------------------------------------------------------------
drop policy if exists "members read group" on public.groups;
create policy "members read group"
  on public.groups for select to authenticated
  using (public.is_group_member(id, auth.uid()));

-- Creation goes through create_group() (atomic group + owner + invite); no direct
-- INSERT policy. Admins can rename / toggle the leaderboard; the owner can delete.
drop policy if exists "admins update group" on public.groups;
create policy "admins update group"
  on public.groups for update to authenticated
  using (public.is_group_admin(id, auth.uid()))
  with check (public.is_group_admin(id, auth.uid()));

drop policy if exists "owner deletes group" on public.groups;
create policy "owner deletes group"
  on public.groups for delete to authenticated
  using (created_by = auth.uid());

-- ---- group_members --------------------------------------------------------
drop policy if exists "members read roster" on public.group_members;
create policy "members read roster"
  on public.group_members for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

-- Joining goes through join_group(token); no direct INSERT policy (prevents
-- self-adding to an arbitrary group_id without a valid invite).
drop policy if exists "admins manage roles" on public.group_members;
create policy "admins manage roles"
  on public.group_members for update to authenticated
  using (public.is_group_admin(group_id, auth.uid()) and role <> 'owner')
  with check (public.is_group_admin(group_id, auth.uid()));

-- Leave yourself anytime; admins may remove others, but never the owner row.
drop policy if exists "leave or remove member" on public.group_members;
create policy "leave or remove member"
  on public.group_members for delete to authenticated
  using (
    user_id = auth.uid()
    or (public.is_group_admin(group_id, auth.uid()) and role <> 'owner')
  );

-- ---- group_invites --------------------------------------------------------
drop policy if exists "members read invites" on public.group_invites;
create policy "members read invites"
  on public.group_invites for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

drop policy if exists "admins mint invites" on public.group_invites;
create policy "admins mint invites"
  on public.group_invites for insert to authenticated
  with check (public.is_group_admin(group_id, auth.uid()) and created_by = auth.uid());

drop policy if exists "admins revoke invites" on public.group_invites;
create policy "admins revoke invites"
  on public.group_invites for update to authenticated
  using (public.is_group_admin(group_id, auth.uid()))
  with check (public.is_group_admin(group_id, auth.uid()));

drop policy if exists "admins delete invites" on public.group_invites;
create policy "admins delete invites"
  on public.group_invites for delete to authenticated
  using (public.is_group_admin(group_id, auth.uid()));

-- ---- group_watchlist ------------------------------------------------------
drop policy if exists "members read watchlist" on public.group_watchlist;
create policy "members read watchlist"
  on public.group_watchlist for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

drop policy if exists "members add watchlist" on public.group_watchlist;
create policy "members add watchlist"
  on public.group_watchlist for insert to authenticated
  with check (public.is_group_member(group_id, auth.uid()) and added_by = auth.uid());

drop policy if exists "members remove watchlist" on public.group_watchlist;
create policy "members remove watchlist"
  on public.group_watchlist for delete to authenticated
  using (
    public.is_group_member(group_id, auth.uid())
    and (added_by = auth.uid() or public.is_group_admin(group_id, auth.uid()))
  );

-- ---- group_calls ----------------------------------------------------------
drop policy if exists "members read calls" on public.group_calls;
create policy "members read calls"
  on public.group_calls for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

drop policy if exists "members log calls" on public.group_calls;
create policy "members log calls"
  on public.group_calls for insert to authenticated
  with check (public.is_group_member(group_id, auth.uid()) and author = auth.uid());

-- No UPDATE policy: calls are immutable (the called price can't be rewritten).
drop policy if exists "author or admin deletes call" on public.group_calls;
create policy "author or admin deletes call"
  on public.group_calls for delete to authenticated
  using (author = auth.uid() or public.is_group_admin(group_id, auth.uid()));

-- ===========================================================================
-- RPCs - atomic create/join + a pre-join preview. SECURITY DEFINER so they can
-- write membership and read a group's name for an invite the caller can't yet
-- select under RLS. A 32-char hex token (two-UUID source) keeps it URL-safe and
-- free of any extension dependency.
-- ===========================================================================

create or replace function public.create_group(p_name text, p_description text default '')
returns table (group_id uuid, invite_token text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_group uuid;
  v_token text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Group name is required'; end if;

  insert into public.groups (name, description, created_by)
  values (trim(p_name), coalesce(trim(p_description), ''), v_uid)
  returning id into v_group;

  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_uid, 'owner');

  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.group_invites (group_id, token, created_by)
  values (v_group, v_token, v_uid);

  return query select v_group, v_token;
end;
$$;

create or replace function public.join_group(p_token text)
returns table (group_id uuid, group_name text, already_member boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_invite   public.group_invites%rowtype;
  v_group    public.groups%rowtype;
  v_existing boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_invite from public.group_invites where token = p_token;
  if not found then raise exception 'Invite not found'; end if;
  if v_invite.revoked then raise exception 'This invite link has been turned off'; end if;
  if v_invite.expires_at is not null and v_invite.expires_at < now() then
    raise exception 'This invite link has expired';
  end if;

  select * into v_group from public.groups where id = v_invite.group_id;

  select exists (
    select 1 from public.group_members
    where group_id = v_invite.group_id and user_id = v_uid
  ) into v_existing;

  if not v_existing then
    insert into public.group_members (group_id, user_id, role)
    values (v_invite.group_id, v_uid, 'member')
    on conflict (group_id, user_id) do nothing;
  end if;

  return query select v_group.id, v_group.name, v_existing;
end;
$$;

-- Lets an invitee preview the group (name + size) before they commit to joining.
create or replace function public.peek_invite(p_token text)
returns table (group_id uuid, group_name text, member_count bigint, valid boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_invite public.group_invites%rowtype;
  v_group  public.groups%rowtype;
  v_ok     boolean;
begin
  select * into v_invite from public.group_invites where token = p_token;
  if not found then
    return query select null::uuid, null::text, 0::bigint, false;
    return;
  end if;
  select * into v_group from public.groups where id = v_invite.group_id;
  v_ok := not v_invite.revoked
          and (v_invite.expires_at is null or v_invite.expires_at >= now());
  return query
    select v_group.id,
           v_group.name,
           (select count(*) from public.group_members where group_id = v_group.id),
           v_ok;
end;
$$;

revoke all on function public.create_group(text, text) from public;
revoke all on function public.join_group(text)         from public;
revoke all on function public.peek_invite(text)        from public;
grant execute on function public.create_group(text, text) to authenticated;
grant execute on function public.join_group(text)         to authenticated;
grant execute on function public.peek_invite(text)        to authenticated, anon;

-- ===========================================================================
-- Indexes
-- ===========================================================================
create index if not exists group_members_user_idx     on public.group_members (user_id);
create index if not exists group_members_group_idx     on public.group_members (group_id);
create index if not exists group_watchlist_group_idx    on public.group_watchlist (group_id, created_at desc);
create index if not exists group_calls_group_idx        on public.group_calls (group_id, called_at desc);
create index if not exists group_invites_group_idx      on public.group_invites (group_id);

-- ===========================================================================
-- TODO (future increments - intentionally NOT in this build):
--   • group_messages (chat) + Supabase Realtime broadcast/presence.
--   • group_polls + group_poll_votes (buy/hold/sell polls).
--   • group_alerts (notify on new post / big move on a watched name) + push.
--   • Realtime on group_watchlist / group_calls so members see live updates
--     without a manual refresh:
--       alter publication supabase_realtime add table public.group_calls;
--       alter publication supabase_realtime add table public.group_watchlist;
-- ===========================================================================
