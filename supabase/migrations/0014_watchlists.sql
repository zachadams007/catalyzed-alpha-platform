-- Catalyzed Alpha - cross-device, account-bound WATCHLIST
-- Run once in your Supabase project's SQL Editor (or via `supabase db push`).
-- Safe to re-run: policies are dropped first.
--
-- The watchlist was device-local only (Zustand persist → localStorage), so it
-- "kept deleting on exit" whenever the single persisted blob hit the storage
-- quota. This table ties the watchlist to the signed-in ACCOUNT so it survives
-- exit/reopen and follows the user across devices (save on desktop → see on
-- phone). One row per (owner, ticker); the optional `alert` jsonb carries that
-- ticker's personal price-level research reminder. Rides the SAME owner-only RLS
-- pattern as cloud notes (0006) and portfolios (0003) - private, never public.

create table if not exists public.watchlist_items (
  owner       uuid not null references public.profiles(id) on delete cascade,
  ticker      text not null,
  -- Optional per-ticker price-level reminder ({ price, direction, createdAt });
  -- null when the ticker is watched without a reminder.
  alert       jsonb,
  updated_at  timestamptz not null default now(),
  primary key (owner, ticker)
);

alter table public.watchlist_items enable row level security;

drop policy if exists "owner reads own watchlist" on public.watchlist_items;
create policy "owner reads own watchlist"
  on public.watchlist_items for select to authenticated
  using (auth.uid() = owner);

drop policy if exists "owner inserts own watchlist" on public.watchlist_items;
create policy "owner inserts own watchlist"
  on public.watchlist_items for insert to authenticated
  with check (auth.uid() = owner);

drop policy if exists "owner updates own watchlist" on public.watchlist_items;
create policy "owner updates own watchlist"
  on public.watchlist_items for update to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);

drop policy if exists "owner deletes own watchlist" on public.watchlist_items;
create policy "owner deletes own watchlist"
  on public.watchlist_items for delete to authenticated
  using (auth.uid() = owner);

create index if not exists watchlist_items_owner_idx on public.watchlist_items (owner, updated_at desc);

-- Realtime so a save on one device pushes to others instantly.
do $$
begin
  alter publication supabase_realtime add table public.watchlist_items;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
