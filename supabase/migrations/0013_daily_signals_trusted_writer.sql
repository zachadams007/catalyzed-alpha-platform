-- Catalyzed Alpha - daily_signals trusted-writer hardening (security, P2)
--
-- WHY: 0007_daily_signals.sql granted INSERT on public.daily_signals to the
-- anon + authenticated roles behind only shape checks (market_day = today/ET,
-- signal_count 1..6000, non-empty signals array). Because the shipped web bundle
-- carries the public VITE_SUPABASE_ANON_KEY, ANY holder of that key could insert
-- a shape-valid-but-fabricated StockSignal[] for the current market day. The
-- market_day PRIMARY KEY is first-writer-wins with no client UPDATE/DELETE, so a
-- single poisoned row is then read by every other tester under a "Live" badge
-- and is IMMUTABLE for the whole market day - a direct violation of the
-- no-fabricated-data rule.
--
-- FIX: make daily_signals match terminal_events - anon/authenticated READ-ONLY,
-- writes ONLY via the service-role key (which bypasses RLS). The sole writer is
-- the trusted broad-universe scan (scripts/universe_scan/upload.mjs, run from the
-- scheduled GitHub job / an edge function with the service-role key). This
-- migration REVOKES the anon/authenticated INSERT policy added in 0007. No new
-- write policy is created, so with RLS enabled the only path left to write is the
-- service role. The shape-validation trigger stays as defense-in-depth for that
-- trusted writer.
--
-- Idempotent: safe to re-run. Run via the Supabase Management API query endpoint
-- or `supabase db push` (or paste into the SQL Editor).

-- Revoke the client-writable INSERT policy. After this, anon + authenticated can
-- only SELECT (via "public read daily signals"); there is no INSERT/UPDATE/DELETE
-- policy for them, so RLS denies every client write. The day's feed can only be
-- published by the service-role key, exactly like terminal_events.
drop policy if exists "guarded insert daily signals" on public.daily_signals;

-- Belt-and-suspenders: strip any table-level INSERT grant from the API roles so
-- the lockdown does not depend on the policy alone. SELECT stays (read path).
revoke insert, update, delete on public.daily_signals from anon;
revoke insert, update, delete on public.daily_signals from authenticated;

-- The shape-validation trigger (public.validate_daily_signals) from 0007 is left
-- in place: it now guards the trusted service-role writer against a malformed
-- payload (empty array / missing ticker) rather than gating untrusted clients.
