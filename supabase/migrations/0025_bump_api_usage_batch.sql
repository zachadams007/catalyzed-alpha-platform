-- Catalyzed Alpha - batch API-usage counter bump.
-- =============================================================================
-- WHY: the scheduled daily universe scan calls Finnhub/FMP/Alpaca directly, not
-- through the browser/edge proxy path that bumps api_usage_daily once per request.
-- The scan already aggregates its own vendor counts in-process, so it reports the
-- total usage here in one RPC call per vendor instead of thousands of single bumps.

create or replace function public.bump_api_usage_batch(
  p_vendor text,
  p_key_label text,
  p_calls bigint,
  p_failures bigint default 0
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'America/New_York')::date;
begin
  if p_vendor is null or btrim(p_vendor) = '' or p_key_label is null or btrim(p_key_label) = '' then
    return;
  end if;

  if coalesce(p_calls, 0) <= 0 and coalesce(p_failures, 0) <= 0 then
    return;
  end if;

  insert into public.api_usage_daily (market_day, vendor, key_label, calls, failures, last_used)
  values (
    v_day,
    btrim(p_vendor),
    btrim(p_key_label),
    greatest(coalesce(p_calls, 0), 0),
    greatest(coalesce(p_failures, 0), 0),
    now()
  )
  on conflict (market_day, vendor, key_label) do update
    set calls = api_usage_daily.calls + greatest(coalesce(p_calls, 0), 0),
        failures = api_usage_daily.failures + greatest(coalesce(p_failures, 0), 0),
        last_used = now();
end;
$$;

revoke all on function public.bump_api_usage_batch(text, text, bigint, bigint) from public;
grant execute on function public.bump_api_usage_batch(text, text, bigint, bigint)
  to service_role, anon, authenticated;
