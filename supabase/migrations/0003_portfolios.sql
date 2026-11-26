-- Catalyzed Alpha - cloud portfolios (cross-device sync)
-- Run once in your Supabase project's SQL Editor (or via the CLI).
-- Safe to re-run: policies are dropped first.
--
-- Stores each of a user's OWN portfolios as a row so the same account sees the
-- same portfolios on every signed-in device (e.g. import on mobile → appears on
-- desktop). Holdings (ticker + shares + costBasis + value) ride along as JSON;
-- scores are always recomputed locally from the current research run.

create table if not exists public.portfolios (
  id          text primary key,                       -- client-generated (pf_*)
  owner       uuid not null references public.profiles(id) on delete cascade,
  name        text not null default 'Untitled',
  mode        text not null default 'Custom',
  description text not null default '',
  is_public   boolean not null default false,
  accent      text,
  holdings    jsonb not null default '[]'::jsonb,
  discovery   jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.portfolios enable row level security;

drop policy if exists "owner reads own portfolios" on public.portfolios;
create policy "owner reads own portfolios"
  on public.portfolios for select to authenticated
  using (auth.uid() = owner or is_public = true);

drop policy if exists "owner inserts own portfolios" on public.portfolios;
create policy "owner inserts own portfolios"
  on public.portfolios for insert to authenticated
  with check (auth.uid() = owner);

drop policy if exists "owner updates own portfolios" on public.portfolios;
create policy "owner updates own portfolios"
  on public.portfolios for update to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);

drop policy if exists "owner deletes own portfolios" on public.portfolios;
create policy "owner deletes own portfolios"
  on public.portfolios for delete to authenticated
  using (auth.uid() = owner);

create index if not exists portfolios_owner_idx on public.portfolios (owner, updated_at desc);

-- Optional: enable Supabase Realtime so a change on one device pushes to others
-- instantly. Harmless if the publication already includes the table.
do $$
begin
  alter publication supabase_realtime add table public.portfolios;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
