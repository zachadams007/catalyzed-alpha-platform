alter table public.portfolios
  add column if not exists value_history jsonb not null default '[]'::jsonb;
