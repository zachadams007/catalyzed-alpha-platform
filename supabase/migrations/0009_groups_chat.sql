-- Catalyzed Alpha - Groups: chat, polls, and an in-group activity feed
-- The second Groups increment. 0008 shipped spaces + roster + invite links +
-- shared watchlist + the call ledger/leaderboard. This adds the social layer:
--
--   • group_messages - a members-only chat, streamed over Supabase Realtime.
--   • group_polls - "which name next?"-style polls a member opens.
--   • group_poll_options - the choices on a poll (2..8).
--   • group_poll_votes - one vote per (poll, voter); switchable, via an RPC.
--   • group_activity - a lightweight feed row for noteworthy events
--                            (new call, watchlist add, new poll, poll closed),
--                            written by SECURITY DEFINER triggers so the feed is
--                            always consistent with the source rows.
--   • group_reads - per-(member, group) "last seen" marks that power the
--                            unread badge on a group without a server round-trip.
--
-- Run once in your Supabase project's SQL editor, or via the CLI:
--     supabase db push                       (with migrations linked), or
--     paste this file into the SQL editor and run it.
-- Safe to re-run: policies/functions/triggers are dropped first; tables use
-- IF NOT EXISTS; the realtime publication adds are guarded.
-- Depends on 0001_friends.sql (profiles) and 0008_groups.sql (groups +
-- is_group_member / is_group_admin helpers + the group_* tables).

-- ===========================================================================
-- Tables
-- ===========================================================================

-- group_messages: the chat. Append-mostly; an author may delete their own line
-- (admins may delete any). No edit by design - keeps the transcript honest, same
-- spirit as the immutable call ledger.
create table if not exists public.group_messages (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  author     uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- group_polls: a question opened by a member. `closes_at` is an optional soft
-- deadline; `closed` is the hard flag (set by the opener/admin or by close_poll).
create table if not exists public.group_polls (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  author     uuid not null references public.profiles(id) on delete cascade,
  question   text not null check (char_length(btrim(question)) between 1 and 200),
  closed     boolean not null default false,
  closes_at  timestamptz,
  created_at timestamptz not null default now()
);

-- group_poll_options: the choices. `ticker` is set when an option is a security
-- (so the UI can deep-link to /signal/<ticker>); free-text options leave it null.
create table if not exists public.group_poll_options (
  id        uuid primary key default gen_random_uuid(),
  poll_id   uuid not null references public.group_polls(id) on delete cascade,
  label     text not null check (char_length(btrim(label)) between 1 and 80),
  ticker    text check (ticker is null or char_length(ticker) between 1 and 12),
  position  int  not null default 0
);

-- group_poll_votes: one row per (poll, voter). The unique constraint enforces a
-- single vote; switching a vote is an UPDATE (handled by the cast_poll_vote RPC).
create table if not exists public.group_poll_votes (
  id        uuid primary key default gen_random_uuid(),
  poll_id   uuid not null references public.group_polls(id) on delete cascade,
  option_id uuid not null references public.group_poll_options(id) on delete cascade,
  voter     uuid not null references public.profiles(id) on delete cascade,
  voted_at  timestamptz not null default now(),
  constraint group_poll_votes_unique unique (poll_id, voter)
);

-- group_activity: the alerts/notifications feed. One row per noteworthy event.
-- `kind` drives the icon/copy; `ref_id` points at the source row; `meta` carries
-- a small denormalized payload (ticker, question, …) so the feed renders without
-- extra joins even after the source row is gone.
create table if not exists public.group_activity (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups(id) on delete cascade,
  actor      uuid references public.profiles(id) on delete set null,
  kind       text not null check (kind in (
               'message','call','watchlist','poll_opened','poll_closed'
             )),
  ref_id     uuid,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- group_reads: per-member "I've seen up to here" mark for a group. One row per
-- (group, user). Drives the unread badge; updated when a member opens the group
-- or its activity tab.
create table if not exists public.group_reads (
  group_id     uuid not null references public.groups(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- ===========================================================================
-- Row-level security - members-only, mirroring 0008's is_group_member pattern.
-- ===========================================================================

alter table public.group_messages     enable row level security;
alter table public.group_polls         enable row level security;
alter table public.group_poll_options  enable row level security;
alter table public.group_poll_votes    enable row level security;
alter table public.group_activity      enable row level security;
alter table public.group_reads         enable row level security;

-- ---- group_messages -------------------------------------------------------
drop policy if exists "members read messages" on public.group_messages;
create policy "members read messages"
  on public.group_messages for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

drop policy if exists "members send messages" on public.group_messages;
create policy "members send messages"
  on public.group_messages for insert to authenticated
  with check (public.is_group_member(group_id, auth.uid()) and author = auth.uid());

-- No UPDATE policy: messages aren't editable. Delete your own, or admins any.
drop policy if exists "author or admin deletes message" on public.group_messages;
create policy "author or admin deletes message"
  on public.group_messages for delete to authenticated
  using (author = auth.uid() or public.is_group_admin(group_id, auth.uid()));

-- ---- group_polls ----------------------------------------------------------
drop policy if exists "members read polls" on public.group_polls;
create policy "members read polls"
  on public.group_polls for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

-- Polls are created via create_poll() (atomic poll + options); no direct INSERT.
drop policy if exists "author or admin updates poll" on public.group_polls;
create policy "author or admin updates poll"
  on public.group_polls for update to authenticated
  using (author = auth.uid() or public.is_group_admin(group_id, auth.uid()))
  with check (author = auth.uid() or public.is_group_admin(group_id, auth.uid()));

drop policy if exists "author or admin deletes poll" on public.group_polls;
create policy "author or admin deletes poll"
  on public.group_polls for delete to authenticated
  using (author = auth.uid() or public.is_group_admin(group_id, auth.uid()));

-- ---- group_poll_options (read-only to clients; written by create_poll) -----
drop policy if exists "members read poll options" on public.group_poll_options;
create policy "members read poll options"
  on public.group_poll_options for select to authenticated
  using (exists (
    select 1 from public.group_polls p
    where p.id = poll_id and public.is_group_member(p.group_id, auth.uid())
  ));

-- ---- group_poll_votes -----------------------------------------------------
drop policy if exists "members read votes" on public.group_poll_votes;
create policy "members read votes"
  on public.group_poll_votes for select to authenticated
  using (exists (
    select 1 from public.group_polls p
    where p.id = poll_id and public.is_group_member(p.group_id, auth.uid())
  ));

-- Voting goes through cast_poll_vote() (insert-or-switch, with a closed check);
-- no direct INSERT/UPDATE policy. A voter may retract their own vote.
drop policy if exists "voter retracts vote" on public.group_poll_votes;
create policy "voter retracts vote"
  on public.group_poll_votes for delete to authenticated
  using (voter = auth.uid());

-- ---- group_activity (read-only to clients; written by triggers) ------------
drop policy if exists "members read activity" on public.group_activity;
create policy "members read activity"
  on public.group_activity for select to authenticated
  using (public.is_group_member(group_id, auth.uid()));

-- ---- group_reads (each member manages only their own mark) ------------------
drop policy if exists "read own reads" on public.group_reads;
create policy "read own reads"
  on public.group_reads for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "upsert own reads" on public.group_reads;
create policy "upsert own reads"
  on public.group_reads for insert to authenticated
  with check (user_id = auth.uid() and public.is_group_member(group_id, auth.uid()));

drop policy if exists "update own reads" on public.group_reads;
create policy "update own reads"
  on public.group_reads for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ===========================================================================
-- Activity feed - SECURITY DEFINER trigger fns log events as the table owner,
-- so the feed is written even though clients can't INSERT into group_activity.
-- One helper keeps the insert in a single place.
-- ===========================================================================

create or replace function public.log_group_activity(
  p_group uuid, p_actor uuid, p_kind text, p_ref uuid, p_meta jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.group_activity (group_id, actor, kind, ref_id, meta)
  values (p_group, p_actor, p_kind, p_ref, coalesce(p_meta, '{}'::jsonb));
$$;

-- New chat message → activity (with a short preview so the feed reads on its own).
create or replace function public.tg_activity_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_group_activity(
    new.group_id, new.author, 'message', new.id,
    jsonb_build_object('preview', left(btrim(new.body), 120))
  );
  return new;
end;
$$;

-- New logged call → activity.
create or replace function public.tg_activity_call()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_group_activity(
    new.group_id, new.author, 'call', new.id,
    jsonb_build_object('ticker', new.ticker, 'direction', new.direction)
  );
  return new;
end;
$$;

-- New watchlist add → activity.
create or replace function public.tg_activity_watchlist()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_group_activity(
    new.group_id, new.added_by, 'watchlist', new.id,
    jsonb_build_object('ticker', new.ticker)
  );
  return new;
end;
$$;

-- Poll opened, and poll closed (closed fires only on the false→true transition).
create or replace function public.tg_activity_poll()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_group_activity(
      new.group_id, new.author, 'poll_opened', new.id,
      jsonb_build_object('question', new.question)
    );
  elsif tg_op = 'UPDATE' and new.closed and not old.closed then
    perform public.log_group_activity(
      new.group_id, new.author, 'poll_closed', new.id,
      jsonb_build_object('question', new.question)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activity_message   on public.group_messages;
drop trigger if exists trg_activity_call      on public.group_calls;
drop trigger if exists trg_activity_watchlist on public.group_watchlist;
drop trigger if exists trg_activity_poll_ins  on public.group_polls;
drop trigger if exists trg_activity_poll_upd  on public.group_polls;

create trigger trg_activity_message   after insert on public.group_messages
  for each row execute function public.tg_activity_message();
create trigger trg_activity_call      after insert on public.group_calls
  for each row execute function public.tg_activity_call();
create trigger trg_activity_watchlist after insert on public.group_watchlist
  for each row execute function public.tg_activity_watchlist();
create trigger trg_activity_poll_ins  after insert on public.group_polls
  for each row execute function public.tg_activity_poll();
create trigger trg_activity_poll_upd  after update on public.group_polls
  for each row execute function public.tg_activity_poll();

-- ===========================================================================
-- RPCs - atomic poll create, vote (insert-or-switch), close, and a read mark.
-- SECURITY DEFINER so they can write rows clients can't INSERT directly, while
-- re-checking membership/closed-state inside the function body.
-- ===========================================================================

-- create_poll: opens a poll with 2..8 options atomically.
-- p_options is a jsonb array of { "label": text, "ticker": text|null }.
create or replace function public.create_poll(
  p_group uuid, p_question text, p_options jsonb, p_closes_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_poll   uuid;
  v_opt    jsonb;
  v_count  int := 0;
  v_pos    int := 0;
  v_label  text;
  v_ticker text;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_group_member(p_group, v_uid) then
    raise exception 'Only members can open a poll';
  end if;
  if coalesce(btrim(p_question), '') = '' then raise exception 'A poll needs a question'; end if;
  if jsonb_typeof(p_options) <> 'array' then raise exception 'Options must be a list'; end if;

  v_count := jsonb_array_length(p_options);
  if v_count < 2 or v_count > 8 then raise exception 'A poll needs between 2 and 8 options'; end if;

  insert into public.group_polls (group_id, author, question, closes_at)
  values (p_group, v_uid, btrim(p_question), p_closes_at)
  returning id into v_poll;

  for v_opt in select * from jsonb_array_elements(p_options) loop
    v_label  := btrim(coalesce(v_opt->>'label', ''));
    v_ticker := nullif(btrim(upper(coalesce(v_opt->>'ticker', ''))), '');
    if v_label = '' and v_ticker is not null then v_label := v_ticker; end if;
    if v_label = '' then raise exception 'Every option needs a label'; end if;
    insert into public.group_poll_options (poll_id, label, ticker, position)
    values (v_poll, left(v_label, 80), v_ticker, v_pos);
    v_pos := v_pos + 1;
  end loop;

  return v_poll;
end;
$$;

-- cast_poll_vote: insert the vote, or switch it to another option. Rejects votes
-- on a closed poll (or one past its soft deadline). Re-voting the same option is
-- idempotent. Returns the option the member now holds.
create or replace function public.cast_poll_vote(p_poll uuid, p_option uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_poll public.group_polls%rowtype;
  v_ok   boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_poll from public.group_polls where id = p_poll;
  if not found then raise exception 'Poll not found'; end if;
  if not public.is_group_member(v_poll.group_id, v_uid) then
    raise exception 'Only members can vote';
  end if;
  if v_poll.closed or (v_poll.closes_at is not null and v_poll.closes_at < now()) then
    raise exception 'This poll is closed';
  end if;

  select exists (
    select 1 from public.group_poll_options where id = p_option and poll_id = p_poll
  ) into v_ok;
  if not v_ok then raise exception 'That option is not on this poll'; end if;

  insert into public.group_poll_votes (poll_id, option_id, voter)
  values (p_poll, p_option, v_uid)
  on conflict (poll_id, voter)
  do update set option_id = excluded.option_id, voted_at = now();

  return p_option;
end;
$$;

-- close_poll: opener or admin ends voting (flips `closed`, firing the trigger).
create or replace function public.close_poll(p_poll uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_poll public.group_polls%rowtype;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_poll from public.group_polls where id = p_poll;
  if not found then raise exception 'Poll not found'; end if;
  if not (v_poll.author = v_uid or public.is_group_admin(v_poll.group_id, v_uid)) then
    raise exception 'Only the poll opener or an admin can close it';
  end if;
  update public.group_polls set closed = true where id = p_poll and not closed;
end;
$$;

-- mark_group_read: stamp the viewer's last-seen for a group (powers unread).
create or replace function public.mark_group_read(p_group uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if not public.is_group_member(p_group, v_uid) then return; end if;
  insert into public.group_reads (group_id, user_id, last_read_at)
  values (p_group, v_uid, now())
  on conflict (group_id, user_id) do update set last_read_at = now();
end;
$$;

revoke all on function public.create_poll(uuid, text, jsonb, timestamptz) from public;
revoke all on function public.cast_poll_vote(uuid, uuid)                  from public;
revoke all on function public.close_poll(uuid)                            from public;
revoke all on function public.mark_group_read(uuid)                       from public;
grant execute on function public.create_poll(uuid, text, jsonb, timestamptz) to authenticated;
grant execute on function public.cast_poll_vote(uuid, uuid)                  to authenticated;
grant execute on function public.close_poll(uuid)                            to authenticated;
grant execute on function public.mark_group_read(uuid)                       to authenticated;

-- ===========================================================================
-- Indexes
-- ===========================================================================
create index if not exists group_messages_group_idx  on public.group_messages (group_id, created_at desc);
create index if not exists group_polls_group_idx      on public.group_polls (group_id, created_at desc);
create index if not exists group_poll_options_poll_idx on public.group_poll_options (poll_id, position);
create index if not exists group_poll_votes_poll_idx   on public.group_poll_votes (poll_id);
create index if not exists group_activity_group_idx    on public.group_activity (group_id, created_at desc);

-- ===========================================================================
-- Realtime - let members see new chat lines, votes, and activity live without
-- polling. Guarded so re-running the migration doesn't error on an already-
-- published table.
-- ===========================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_messages'
  ) then alter publication supabase_realtime add table public.group_messages; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_poll_votes'
  ) then alter publication supabase_realtime add table public.group_poll_votes; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_polls'
  ) then alter publication supabase_realtime add table public.group_polls; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_activity'
  ) then alter publication supabase_realtime add table public.group_activity; end if;
end $$;
