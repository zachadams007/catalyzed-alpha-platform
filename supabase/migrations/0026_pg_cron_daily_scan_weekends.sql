-- 0026 - Run the daily-universe scan EVERY morning, weekends included.
--
-- The pg_cron slots from 0015 were weekday-only ('1-5'); this re-schedules the same four
-- self-guarding jobs daily ('*'). cron.schedule() with an existing jobname REPLACES that job's
-- schedule, so this is idempotent and leaves the trigger function untouched. Weekend runs
-- publish a board keyed to the weekend date from the latest (Friday) market data; the self-guard
-- still makes extra slots no-ops. The GitHub Actions fallback crons were switched to daily in
-- the same change (.github/workflows/daily-universe.yml).
--
-- Like 0015, this documents what was applied via the Supabase Management API.

select cron.schedule('daily-universe-1100', '0 11 * * *',  'select public.trigger_daily_scan_if_needed();');
select cron.schedule('daily-universe-1130', '30 11 * * *', 'select public.trigger_daily_scan_if_needed();');
select cron.schedule('daily-universe-1200', '0 12 * * *',  'select public.trigger_daily_scan_if_needed();');
select cron.schedule('daily-universe-1230', '30 12 * * *', 'select public.trigger_daily_scan_if_needed();');
