-- Widen the ai_picks rank constraint from 0-2 to 0-3.
--
-- WHY: the AI Pick of the Day now ships a VARIABLE 2-4 picks per day (hero + up to
-- three runners), with a deliberate mix of big-cap and smaller high-potential names.
-- The original table (0021) capped rank at 0-2 (hero + 2 runners), so a 4th pick
-- (rank 3) was rejected and the whole day's batch insert failed - leaving the tile
-- empty. This widens the CHECK so up to four picks can be stored.
--
-- The client fetch (`fetchTodayAiPicks` / `fetchRecentAiPicks`) reads up to 4 rows,
-- and the edge function deletes the day's rows before inserting so a smaller-count
-- run (2 or 3) never leaves a stale rank-3 row behind.

alter table public.ai_picks drop constraint if exists ai_picks_rank_check;
alter table public.ai_picks add constraint ai_picks_rank_check check (rank between 0 and 3);
