-- Catalyzed Alpha - cross-device Terminal research notes
-- Run once in your Supabase project's SQL Editor (or via `supabase db push`).
-- Safe to re-run: policies are dropped first.
--
-- Mirrors the per-ticker notes the user writes in the Terminal security workspace
-- (NotesPanel → store `terminalNotes: Record<ticker, body>`) so the same account
-- sees the same notes on every signed-in device (write on desktop → read on
-- phone). This is real user content, so it rides the SAME owner-only RLS pattern
-- as cloud portfolios (0003) - never public, never readable by anyone else.

create table if not exists public.terminal_notes (
  owner       uuid not null references public.profiles(id) on delete cascade,
  ticker      text not null,
  body        text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (owner, ticker)
);

alter table public.terminal_notes enable row level security;

drop policy if exists "owner reads own notes" on public.terminal_notes;
create policy "owner reads own notes"
  on public.terminal_notes for select to authenticated
  using (auth.uid() = owner);

drop policy if exists "owner inserts own notes" on public.terminal_notes;
create policy "owner inserts own notes"
  on public.terminal_notes for insert to authenticated
  with check (auth.uid() = owner);

drop policy if exists "owner updates own notes" on public.terminal_notes;
create policy "owner updates own notes"
  on public.terminal_notes for update to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);

drop policy if exists "owner deletes own notes" on public.terminal_notes;
create policy "owner deletes own notes"
  on public.terminal_notes for delete to authenticated
  using (auth.uid() = owner);

create index if not exists terminal_notes_owner_idx on public.terminal_notes (owner, updated_at desc);

-- Optional: Realtime so a note saved on one device pushes to others instantly.
do $$
begin
  alter publication supabase_realtime add table public.terminal_notes;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
