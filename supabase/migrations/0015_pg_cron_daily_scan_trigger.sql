-- 0015 - Reliable daily-scan trigger via pg_cron + pg_net.
--
-- WHY: GitHub Actions' free scheduled crons are best-effort and routinely fire
-- LATE or skip entirely (measured 2026-06-23: none of the 09:00–11:00 UTC slots
-- fired on time; the first scheduled run landed 12:21 UTC, ~1h20m past the 7am-EDT
-- target - which is exactly why the board often wasn't fresh and someone had to
-- manually re-trigger). pg_cron is a REAL Postgres scheduler (fires on time), so we
-- use it as the primary trigger that calls GitHub's workflow_dispatch for the
-- daily-universe scan. The GitHub schedule slots remain as a secondary fallback.
--
-- The trigger function SELF-GUARDS on daily_signals (today's board already
-- published → no-op), so we can run several morning slots without ever causing a
-- redundant scan: the first slot that fires while unpublished dispatches; the rest
-- no-op. This is strictly more reliable than the workflow's own guard because
-- pg_cron actually fires on schedule.
--
-- NOTE: this migration documents what was applied to the project (via the Supabase
-- Management API) so it is version-controlled and reproducible. The GitHub PAT is
-- NOT in this file - it is stored once in Supabase Vault under the name
-- 'github_pat_dispatch' (out-of-band; a fine-grained PAT with actions:write on
-- OWNER/REPO; both are placeholders in this copy, as is the deployment branch). To (re)store it:
--   select vault.create_secret('<PAT>', 'github_pat_dispatch', 'GitHub PAT for pg_cron workflow_dispatch');

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.trigger_daily_scan_if_needed()
returns text
language plpgsql
security definer
set search_path = public, net, vault, extensions
as $func$
declare
  today date := (now() at time zone 'America/New_York')::date;
  already int;
  pat text;
  req_id bigint;
begin
  -- Self-guard: skip if today's shared board is already published.
  select count(*) into already from public.daily_signals where market_day = today;
  if already > 0 then
    return 'already published for ' || today::text || ' - no-op';
  end if;

  select decrypted_secret into pat from vault.decrypted_secrets where name = 'github_pat_dispatch' limit 1;
  if pat is null then
    return 'ERROR: no github_pat_dispatch secret in vault';
  end if;

  -- Fire GitHub workflow_dispatch for the daily-universe scan on the live branch.
  select net.http_post(
    url := 'https://api.github.com/repos/OWNER/REPO/actions/workflows/daily-universe.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || pat,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'catalyzed-pg-cron',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('ref', 'main')
  ) into req_id;

  return 'dispatched workflow (net req ' || req_id || ') for ' || today::text;
end;
$func$;

revoke all on function public.trigger_daily_scan_if_needed() from public, anon, authenticated;

-- Four self-guarding morning slots (7:00–8:30 EDT). pg_cron fires reliably, so the
-- 11:00 UTC slot is the real 7am trigger; the later slots only act if it somehow
-- didn't publish.
select cron.schedule('daily-universe-1100', '0 11 * * 1-5',  'select public.trigger_daily_scan_if_needed();');
select cron.schedule('daily-universe-1130', '30 11 * * 1-5', 'select public.trigger_daily_scan_if_needed();');
select cron.schedule('daily-universe-1200', '0 12 * * 1-5',  'select public.trigger_daily_scan_if_needed();');
select cron.schedule('daily-universe-1230', '30 12 * * 1-5', 'select public.trigger_daily_scan_if_needed();');
