-- 0022 - Daily "AI Pick of the Day" trigger via pg_cron + pg_net.
--
-- WHY: The `ai-pick` edge function generates the hero + 2 runner-up picks for the
-- day (Gemini grounded news scan → Bull/Bear/Judge debate → score reconciliation).
-- Unlike the daily-universe scan (a GitHub Action), the AI pick IS a Supabase edge
-- function, so pg_cron can invoke it DIRECTLY via pg_net - no GitHub dispatch hop.
--
-- It runs AFTER the daily scan publishes (the scan fires 11:00–12:30 UTC = 7–8:30am
-- EDT) so the engine-score reconciliation (0.6*engine + 0.4*judge) reads the FRESH
-- daily_signals board. The trigger SELF-GUARDS on ai_picks (today's picks already
-- written → no-op), so the two morning slots never double-run.
--
-- This migration DOCUMENTS what was applied to the project via the Supabase
-- Management API so it is version-controlled + reproducible. The anon key is NOT in
-- this file - it is stored once in Supabase Vault under 'ai_pick_anon_key' (the anon
-- key is public/RLS-safe; the edge fn writes via its own service-role internally).
-- To (re)store it:
--   select vault.create_secret('<anon key>', 'ai_pick_anon_key', 'anon key for pg_cron ai-pick invoke');

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.trigger_ai_pick_if_needed()
returns text
language plpgsql
security definer
set search_path = public, net, vault, extensions
as $func$
declare
  today date := (now() at time zone 'America/New_York')::date;
  already int;
  key text;
  req_id bigint;
begin
  -- Self-guard: skip if today's picks are already written.
  select count(*) into already from public.ai_picks where market_day = today;
  if already > 0 then
    return 'ai_picks present for ' || today::text || ' - no-op';
  end if;

  select decrypted_secret into key from vault.decrypted_secrets where name = 'ai_pick_anon_key' limit 1;
  if key is null then
    return 'ERROR: no ai_pick_anon_key in vault';
  end if;

  -- Invoke the edge function (async; pg_net returns a request id immediately).
  select net.http_post(
    url := 'https://your-project-ref.supabase.co/functions/v1/ai-pick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || key,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 200000
  ) into req_id;

  return 'dispatched ai-pick (net req ' || req_id || ') for ' || today::text;
end;
$func$;

revoke all on function public.trigger_ai_pick_if_needed() from public, anon, authenticated;

-- Two self-guarding morning slots (9:30 + 10:00 EDT = 13:30 + 14:00 UTC), AFTER the
-- daily scan publishes so engine-score reconciliation reads the fresh board.
select cron.schedule('ai-pick-1330', '30 13 * * 1-5', 'select public.trigger_ai_pick_if_needed();');
select cron.schedule('ai-pick-1400', '0 14 * * 1-5',  'select public.trigger_ai_pick_if_needed();');
