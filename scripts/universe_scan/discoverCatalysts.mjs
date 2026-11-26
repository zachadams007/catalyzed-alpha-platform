/**
 * Daily catalyst-DISCOVERY step (runs inside the scheduled broad-universe scan).
 *
 * Calls the `research-agent` edge function's `catalyst_scan` task - three
 * targeted GROUNDED Gemini queries (political / insider buys / major corporate
 * catalysts) + a Groq structuring pass, run SERVER-SIDE where the LLM keys live -
 * and upserts the validated result into the public `discovered_catalysts` cache.
 * The Terminal + feed read that cache, so the whole class of market-moving
 * catalysts (presidential callouts/trades, congressional trades, notable insider
 * buys, M&A / FDA / guidance / contracts) surfaces AUTOMATICALLY, with real
 * sources - nothing hand-coded.
 *
 * WHY HERE (daily-automatic + $0): the broad-universe scan already runs once a
 * day in the cloud (GitHub Action / pg_cron). Piggy-backing one extra edge call
 * on it makes discovery daily-automatic with NO new scheduler, and the Gemini
 * grounding + Groq structuring are the existing FREE edge-fn keys - no new paid
 * API, and the quota is hit ONCE per day, not per client load.
 *
 * Non-fatal: any failure logs and returns without throwing, so a discovery blip
 * never costs the (expensive) universe compute. Uses the SERVICE-ROLE key to
 * upsert (bypasses RLS - only the trusted scan writes this table).
 */

import { createClient } from "@supabase/supabase-js";
import { marketDayKey } from "./upload.mjs";

/**
 * Run the discovery scan via the edge function and cache it. Returns a small
 * summary; never throws.
 */
export async function discoverAndCacheCatalysts(log = console.log) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    log("  catalyst discovery skipped: SUPABASE_URL not set.");
    return { ok: false, reason: "no-url" };
  }
  if (!serviceKey) {
    log("  catalyst discovery skipped: SUPABASE_SERVICE_ROLE_KEY not set.");
    return { ok: false, reason: "no-service-key" };
  }

  // 1. Ask the edge function to run the grounded discovery scan. It holds the
  //    Gemini + Groq keys; we pass the anon key for the function's auth gate.
  const fnUrl = `${url.replace(/\/+$/, "")}/functions/v1/research-agent`;
  let scan;
  try {
    const res = await fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(anonKey ? { apikey: anonKey, Authorization: `Bearer ${anonKey}` } : {}),
      },
      body: JSON.stringify({ task: "catalyst_scan" }),
      // The edge function runs 3 grounded queries + structuring (~30-60s).
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log(`  catalyst discovery: edge fn returned ${res.status} — ${detail.slice(0, 200)}`);
      return { ok: false, reason: `edge-${res.status}` };
    }
    scan = await res.json();
  } catch (err) {
    log(`  catalyst discovery: edge call failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return { ok: false, reason: "edge-call-failed" };
  }

  const catalysts = Array.isArray(scan?.catalysts) ? scan.catalysts : [];
  const meta = scan?.meta ?? {};
  log(
    `  catalyst discovery: ${catalysts.length} catalysts ` +
      `(queriesGrounded=${meta.queriesGrounded ?? "?"}, rawSources=${meta.rawSources ?? "?"}).`,
  );

  if (catalysts.length === 0) {
    // Don't overwrite a good prior day's row with an empty scan (a transient
    // Gemini/Groq quota blip shouldn't blank the discovered feed).
    log("  catalyst discovery: empty scan — keeping the prior cached row (no upsert).");
    return { ok: true, count: 0, upserted: false };
  }

  // 2. Upsert today's row (service role - bypasses RLS).
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const day = marketDayKey();
  const row = {
    market_day: day,
    catalysts,
    catalyst_count: catalysts.length,
    generated_at: scan?.generatedAt ?? new Date().toISOString(),
    meta,
  };
  try {
    const { error } = await supabase
      .from("discovered_catalysts")
      .upsert(row, { onConflict: "market_day" });
    if (error) {
      log(`  catalyst discovery: upsert failed (non-fatal): ${error.message} (${error.code ?? "?"})`);
      return { ok: false, reason: "upsert-failed" };
    }
  } catch (err) {
    log(`  catalyst discovery: upsert threw (non-fatal): ${err instanceof Error ? err.message : err}`);
    return { ok: false, reason: "upsert-threw" };
  }

  log(`  catalyst discovery: cached ${catalysts.length} catalysts for ${day}. ✅`);
  return { ok: true, count: catalysts.length, upserted: true, day };
}
