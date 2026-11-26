-- Catalyzed Alpha - fix ambiguous column references in the Groups RPCs.
--
-- ROOT CAUSE of the "something went wrong" group-join failure (2026-06-25):
-- `join_group` and `peek_invite` both declare a RETURNS TABLE OUT column named
-- `group_id`. Inside the body, a subquery against public.group_members used an
-- UNQUALIFIED `group_id` in its WHERE clause, which PL/pgSQL could bind to EITHER
-- the OUT parameter or the table column → runtime error:
--     "column reference \"group_id\" is ambiguous"
-- So every real join/preview threw, and the client surfaced the generic
-- "Something went wrong." (create_group was unaffected - it has no such subquery,
-- which is why creating a group worked but joining one never did).
--
-- FIX: alias every table in these functions and fully-qualify the column
-- references. Behavior is otherwise identical to 0008_groups.sql. Idempotent
-- (CREATE OR REPLACE). Apply to the live project.

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

  select * into v_invite from public.group_invites gi where gi.token = p_token;
  if not found then raise exception 'Invite not found'; end if;
  if v_invite.revoked then raise exception 'This invite link has been turned off'; end if;
  if v_invite.expires_at is not null and v_invite.expires_at < now() then
    raise exception 'This invite link has expired';
  end if;

  select * into v_group from public.groups g where g.id = v_invite.group_id;

  select exists (
    select 1 from public.group_members gm
    where gm.group_id = v_invite.group_id and gm.user_id = v_uid
  ) into v_existing;

  if not v_existing then
    -- Reference the unique CONSTRAINT by name (not a column list) so the
    -- ON CONFLICT inference can't bind `group_id` to the OUT parameter - the
    -- last ambiguous reference that kept joins failing.
    insert into public.group_members (group_id, user_id, role)
    values (v_invite.group_id, v_uid, 'member')
    on conflict on constraint group_members_unique do nothing;
  end if;

  return query select v_group.id, v_group.name, v_existing;
end;
$$;

create or replace function public.peek_invite(p_token text)
returns table (group_id uuid, group_name text, member_count bigint, valid boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_invite public.group_invites%rowtype;
  v_group  public.groups%rowtype;
  v_ok     boolean;
begin
  select * into v_invite from public.group_invites gi where gi.token = p_token;
  if not found then
    return query select null::uuid, null::text, 0::bigint, false;
    return;
  end if;
  select * into v_group from public.groups g where g.id = v_invite.group_id;
  v_ok := not v_invite.revoked
          and (v_invite.expires_at is null or v_invite.expires_at >= now());
  return query
    select v_group.id,
           v_group.name,
           (select count(*) from public.group_members gm where gm.group_id = v_group.id),
           v_ok;
end;
$$;

-- Grants are unchanged from 0008 but re-stated so a fresh apply is self-contained.
revoke all on function public.join_group(text)  from public;
revoke all on function public.peek_invite(text) from public;
grant execute on function public.join_group(text)  to authenticated;
grant execute on function public.peek_invite(text) to authenticated, anon;
