-- =============================================================================
-- ONE-TIME FIX - run this in Supabase SQL Editor if 0001_friends.sql failed
-- =============================================================================
-- What went wrong (common):
--   • An OLD "friendships" table already existed (from another script) without
--     a "requester" column. "CREATE TABLE IF NOT EXISTS" skipped the fix.
--   • Or you ran a different Supabase tutorial (create_profile_for_new_user)
--     mixed with our file.
--
-- This script removes the broken social tables and rebuilds them correctly.
-- It does NOT delete auth users. Profile rows are kept when possible.
-- =============================================================================

-- Remove policies that reference broken tables (ignore errors if missing).
drop policy if exists "read visible shares" on public.shares;
drop policy if exists "write own shares" on public.shares;
drop policy if exists "delete own shares" on public.shares;
drop policy if exists "see own friendships" on public.friendships;
drop policy if exists "send friend request" on public.friendships;
drop policy if exists "update own friendships" on public.friendships;
drop policy if exists "delete own friendships" on public.friendships;

-- Drop broken / partial social tables (friend requests + shares data only).
drop table if exists public.shares cascade;
drop table if exists public.friendships cascade;

-- Remove helper functions (ours + common tutorial names).
drop function if exists public.are_friends(uuid, uuid);
drop function if exists public.handle_new_user() cascade;
drop function if exists public.create_profile_for_new_user() cascade;

-- Ensure profiles matches what the app expects (add missing columns).
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text unique,
  display_name  text,
  avatar_accent text default '#3f5fc9',
  created_at    timestamptz not null default now()
);

alter table public.profiles add column if not exists handle text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_accent text default '#3f5fc9';
alter table public.profiles add column if not exists created_at timestamptz not null default now();

alter table public.profiles enable row level security;

drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated"
  on public.profiles for select to authenticated using (true);

drop policy if exists "users manage own profile" on public.profiles;
create policy "users manage own profile"
  on public.profiles for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(coalesce(new.email, 'trader'), '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Recreate friendships + shares (correct columns).
create table public.friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null,
  addressee  uuid not null,
  status     text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_requester_fkey foreign key (requester) references public.profiles(id) on delete cascade,
  constraint friendships_addressee_fkey foreign key (addressee) references public.profiles(id) on delete cascade,
  constraint friendships_unique_pair unique (requester, addressee),
  constraint friendships_no_self check (requester <> addressee)
);

alter table public.friendships enable row level security;

create policy "see own friendships"
  on public.friendships for select to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

create policy "send friend request"
  on public.friendships for insert to authenticated
  with check (auth.uid() = requester);

create policy "update own friendships"
  on public.friendships for update to authenticated
  using (auth.uid() = requester or auth.uid() = addressee)
  with check (auth.uid() = requester or auth.uid() = addressee);

create policy "delete own friendships"
  on public.friendships for delete to authenticated
  using (auth.uid() = requester or auth.uid() = addressee);

create table public.shares (
  id         uuid primary key default gen_random_uuid(),
  author     uuid not null references public.profiles(id) on delete cascade,
  ticker     text not null,
  note       text not null default '',
  visibility text not null default 'friends' check (visibility in ('friends','public')),
  created_at timestamptz not null default now()
);

alter table public.shares enable row level security;

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b)
        or (f.requester = b and f.addressee = a))
  );
$$;

create policy "read visible shares"
  on public.shares for select to authenticated
  using (
    author = auth.uid()
    or visibility = 'public'
    or public.are_friends(auth.uid(), author)
  );

create policy "write own shares"
  on public.shares for insert to authenticated
  with check (author = auth.uid());

create policy "delete own shares"
  on public.shares for delete to authenticated
  using (author = auth.uid());

create index if not exists friendships_addressee_idx on public.friendships (addressee, status);
create index if not exists friendships_requester_idx on public.friendships (requester, status);
create index if not exists shares_author_idx on public.shares (author, created_at desc);
