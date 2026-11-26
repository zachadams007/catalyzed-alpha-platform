-- Catalyzed Alpha - terminal_events cache table
-- Stores normalized TerminalEvent rows (catalyst news, insider trades,
-- congressional trades, gov contracts) so phone/web clients get parity with
-- desktop and the Python miner has a write target.
--
-- RLS: public (anon) read-only. Writes require the service-role key so only
-- trusted writers (edge functions, Python miner) can insert/update.
--
-- Run via: supabase db push  (or paste into the Supabase SQL Editor).

create table if not exists public.terminal_events (
  -- Stable client-generated id used for de-duplication (same format as the
  -- TypeScript sources: "news-<id>", "insider-<ticker>-...", "congress-...").
  id              text primary key,

  -- TerminalEventKind: catalyst_news | insider_buy | insider_sell |
  --                    politician_trade | gov_contract
  kind            text not null,

  -- TerminalSeverity: high | elevated | watch
  severity        text not null,

  -- Primary ticker (may be empty string for macro/multi-ticker news).
  ticker          text not null default '',

  -- Additional tickers touched by this event (Alpaca tags several per article).
  related_tickers text[] not null default '{}',

  company_name    text,
  headline        text not null,
  summary         text,

  -- Actor (insider / politician) - stored as JSON to keep the schema flat.
  -- Shape: { name: string, role?: string }
  actor           jsonb,

  -- Trade economics - stored as JSON.
  -- Shape: { direction: "buy"|"sell", valueUsd?: number, shares?: number,
  --          pricePerShare?: number, code?: string }
  trade           jsonb,

  -- When the underlying event happened (trade / publish time).
  occurred_at     timestamptz not null,

  -- When it was filed / disclosed / first seen.
  surfaced_at     timestamptz not null,

  -- Source attribution - stored as JSON.
  -- Shape: { name: string, url: string }
  source          jsonb not null,

  -- Short transparent reason this was flagged at its severity.
  reason          text,

  -- Row bookkeeping.
  created_at      timestamptz not null default now()
);

-- Primary query pattern: feed ordered by severity-then-recency.
create index if not exists terminal_events_surfaced_at_idx
  on public.terminal_events (surfaced_at desc);

-- Filter by kind (tab strip).
create index if not exists terminal_events_kind_idx
  on public.terminal_events (kind);

-- Combined index for the default feed query (kind filter + recency sort).
create index if not exists terminal_events_kind_surfaced_idx
  on public.terminal_events (kind, surfaced_at desc);

-- Ticker-based lookup for watchlist alerts.
create index if not exists terminal_events_ticker_idx
  on public.terminal_events (ticker);

-- Row-level security - enable and lock down.
alter table public.terminal_events enable row level security;

-- Public (anon + authenticated) read access: terminal data is research-only,
-- no PII, safe to read without login. Matches the intent in bloomberg-terminal.md.
drop policy if exists "public read terminal events" on public.terminal_events;
create policy "public read terminal events"
  on public.terminal_events for select
  to anon, authenticated
  using (true);

-- No INSERT / UPDATE / DELETE policies for anon or authenticated roles.
-- Writes must use the service-role key (bypasses RLS), which is only available
-- server-side (edge functions, Python miner). This is intentional.
