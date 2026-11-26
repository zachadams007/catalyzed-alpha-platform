-- Catalyzed Alpha - direct friend → group invites
-- =============================================================================
-- Adds a "invite a friend to this group" flow ALONGSIDE the existing
-- join-by-link / join-by-code path (0008_groups.sql, fixed in 0017). A member
-- picks one of their FRIENDS, the friend gets an in-app notification + a pending
-- invite in their Groups tab, and one tap to Accept drops them into the group
-- with the SAME membership shape join_group() produces ('member').
--
-- Distinct from `public.group_invites` (a shareable LINK token table from 0008):
-- this is a per-PERSON, addressed invite - table `public.group_member_invites`.
--
-- Run once in your Supabase project's SQL editor, or via the CLI:
--     supabase db push                       (with migrations linked), or
--     paste this file into the SQL editor and run it.
-- Safe to re-run: policies/functions are dropped/replaced first; table uses
-- IF NOT EXISTS. Depends on 0001_friends.sql (profiles + friendships) and
-- 0008_groups.sql (groups, group_members, is_group_member()).
--
-- COLREF DISCIPLINE (the 0017 lesson): every RETURNS TABLE OUT column name that
-- collides with a real table column (group_id, invitee, status, …) is shadowed
-- by aliasing every table and fully-qualifying every column reference inside the
-- function bodies, and ON CONFLICT targets the unique CONSTRAINT by name.

-- ===========================================================================
-- Table
-- ===========================================================================

-- group_member_invites: one addressed invite per (group, invitee). `status`
-- moves pending → accepted | declined. `inviter` is who sent it (a member).
create table if not exists public.group_member_invites (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id)   on delete cascade,
  inviter    uuid not null references public.profiles(id) on delete cascade,
  invitee    uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint group_member_invites_unique unique (group_id, invitee)
);

-- ===========================================================================
-- Row-level security
-- ===========================================================================

alter table public.group_member_invites enable row level security;

-- A user can read invites they SENT or RECEIVED. (Writes go only through the
-- SECURITY DEFINER RPCs below; no direct INSERT/UPDATE/DELETE policies - this
-- prevents forging an invite for a group you can't post to, or accepting one
-- that isn't yours.)
drop policy if exists "see my group invites" on public.group_member_invites;
create policy "see my group invites"
  on public.group_member_invites for select to authenticated
  using (invitee = auth.uid() or inviter = auth.uid());

-- ===========================================================================
-- RPCs - SECURITY DEFINER so they can write membership and read a group's name
-- for an invitee who can't yet SELECT the group under RLS. Every table aliased,
-- every column qualified (0017 discipline) so a body reference never binds to a
-- RETURNS TABLE OUT parameter of the same name.
-- ===========================================================================

-- Invite one of YOUR FRIENDS to a group you belong to. Idempotent: re-inviting
-- the same friend refreshes a pending/declined invite back to pending (so a
-- second nudge works), but never downgrades an already-accepted one.
create or replace function public.invite_friend_to_group(p_group_id uuid, p_invitee uuid)
returns table (invite_id uuid, group_name text, already_member boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_group   public.groups%rowtype;
  v_is_friend boolean;
  v_existing  boolean;
  v_invite_id uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_invitee = v_uid then raise exception 'You can''t invite yourself'; end if;

  -- Caller must be a member of the group (any role) to invite into it.
  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'Only members can invite to this group';
  end if;

  select * into v_group from public.groups g where g.id = p_group_id;
  if not found then raise exception 'Group not found'; end if;

  -- Invitee must be the caller's accepted friend (either direction).
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ( (f.requester = v_uid and f.addressee = p_invitee)
         or (f.addressee = v_uid and f.requester = p_invitee) )
  ) into v_is_friend;
  if not v_is_friend then raise exception 'You can only invite your friends'; end if;

  -- If the friend is already in the group, surface that rather than an invite.
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = p_invitee
  ) into v_existing;
  if v_existing then
    return query select null::uuid, v_group.name, true;
    return;
  end if;

  -- Upsert a PENDING invite. Re-inviting a still-pending or previously-declined
  -- friend bumps it back to pending + refreshes inviter/created_at.
  insert into public.group_member_invites (group_id, inviter, invitee, status)
  values (p_group_id, v_uid, p_invitee, 'pending')
  on conflict on constraint group_member_invites_unique do update
    set status     = 'pending',
        inviter    = excluded.inviter,
        created_at = now(),
        responded_at = null
  returning id into v_invite_id;

  return query select v_invite_id, v_group.name, false;
end;
$$;

-- Every PENDING invite addressed to the caller, with the group name + inviter
-- handle/name for display. Newest first.
create or replace function public.list_my_group_invites()
returns table (
  invite_id      uuid,
  group_id       uuid,
  group_name     text,
  inviter_id     uuid,
  inviter_handle text,
  inviter_name   text,
  created_at     timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  return query
    select gmi.id,
           gmi.group_id,
           g.name,
           gmi.inviter,
           p.handle,
           p.display_name,
           gmi.created_at
    from public.group_member_invites gmi
    join public.groups   g on g.id = gmi.group_id
    join public.profiles p on p.id = gmi.inviter
    where gmi.invitee = v_uid
      and gmi.status = 'pending'
      -- Hide invites for a group the user is already in (e.g. they joined via link).
      and not exists (
        select 1 from public.group_members gm
        where gm.group_id = gmi.group_id and gm.user_id = v_uid
      )
    order by gmi.created_at desc;
end;
$$;

-- Accept a pending invite addressed to the caller. Inserts them as a 'member'
-- (the SAME shape join_group() uses) and marks the invite accepted. Idempotent
-- on the membership via the unique constraint.
create or replace function public.accept_group_invite(p_invite_id uuid)
returns table (group_id uuid, group_name text, already_member boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_invite   public.group_member_invites%rowtype;
  v_group    public.groups%rowtype;
  v_existing boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_invite from public.group_member_invites gmi where gmi.id = p_invite_id;
  if not found then raise exception 'Invite not found'; end if;
  if v_invite.invitee <> v_uid then raise exception 'This invite isn''t yours'; end if;

  select * into v_group from public.groups g where g.id = v_invite.group_id;
  if not found then raise exception 'Group no longer exists'; end if;

  select exists (
    select 1 from public.group_members gm
    where gm.group_id = v_invite.group_id and gm.user_id = v_uid
  ) into v_existing;

  if not v_existing then
    -- Same membership shape as join_group(); constraint-name ON CONFLICT so the
    -- inference can't bind `group_id` to the OUT parameter (0017 discipline).
    insert into public.group_members (group_id, user_id, role)
    values (v_invite.group_id, v_uid, 'member')
    on conflict on constraint group_members_unique do nothing;
  end if;

  update public.group_member_invites gmi
     set status = 'accepted', responded_at = now()
   where gmi.id = p_invite_id;

  return query select v_group.id, v_group.name, v_existing;
end;
$$;

-- Decline a pending invite addressed to the caller.
create or replace function public.decline_group_invite(p_invite_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_invite public.group_member_invites%rowtype;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_invite from public.group_member_invites gmi where gmi.id = p_invite_id;
  if not found then raise exception 'Invite not found'; end if;
  if v_invite.invitee <> v_uid then raise exception 'This invite isn''t yours'; end if;

  update public.group_member_invites gmi
     set status = 'declined', responded_at = now()
   where gmi.id = p_invite_id;
end;
$$;

revoke all on function public.invite_friend_to_group(uuid, uuid) from public;
revoke all on function public.list_my_group_invites()           from public;
revoke all on function public.accept_group_invite(uuid)         from public;
revoke all on function public.decline_group_invite(uuid)        from public;
grant execute on function public.invite_friend_to_group(uuid, uuid) to authenticated;
grant execute on function public.list_my_group_invites()           to authenticated;
grant execute on function public.accept_group_invite(uuid)         to authenticated;
grant execute on function public.decline_group_invite(uuid)        to authenticated;

-- ===========================================================================
-- Indexes
-- ===========================================================================
create index if not exists group_member_invites_invitee_idx
  on public.group_member_invites (invitee, status);
create index if not exists group_member_invites_group_idx
  on public.group_member_invites (group_id);

-- ===========================================================================
-- Realtime - publish so the invitee gets a LIVE INSERT (drives the toast + the
-- pending-invites section without a reload). RLS still filters delivery: a user
-- only receives invite rows where they are the invitee or inviter (the SELECT
-- policy above). Idempotent guard mirrors 0011/0012.
-- ===========================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'group_member_invites'
  ) then
    alter publication supabase_realtime add table public.group_member_invites;
  end if;
end $$;
