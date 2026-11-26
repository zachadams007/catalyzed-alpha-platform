// IMPORTANT: bootstrap MUST be the first import - installs Node shims and loads
// scripts/universe_scan/.scan.env before any `@/` module reads env at load time.
import "./universe_scan/bootstrap.mjs";

import { createClient } from "@supabase/supabase-js";

import type { StockSignal } from "@/types";
import {
  fetchRecentSharedSignals,
  type SharedDailySignals,
} from "@/data/dailySignalsCache";
import { postProcessUniverse, type EngineVariantId } from "@/engine/challenger";
import {
  buildArchetypeContext,
  type NormalizationContext,
} from "@/engine/normalizeUniverse";
import { buildMarketRegimeContext } from "@/engine/regime";
import { isAlpacaConfigured } from "@/data/http";
import { fetchAlpacaBarsForSymbols } from "@/data/alpaca/bars";
import { defaultPreferences } from "@/feed/feedAlgorithm";
import { composeForYou, FOR_YOU_FILTERS } from "@/feed/feedFilters";
import { EMERGING_THEMES, matchEmergingTheme } from "@/feed/emergingThemes";

/**
 * scripts/foryou_filter_counts.mts - For-You filter CALIBRATION check.
 *
 * Runs the For-You filter chips (src/feed/feedFilters.ts) against the LIVE
 * published board, re-ranked under the live variant exactly like the app, and
 * prints per-filter match counts + the top names each filter would surface.
 * Read-only; exists so filter thresholds are tuned against reality, not vibes.
 *
 * Run: npx vite-node scripts/foryou_filter_counts.mts
 */

async function fetchBoardDirect(): Promise<SharedDailySignals | null> {
  const url = process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon =
    process.env["VITE_SUPABASE_ANON_KEY"] || process.env["SUPABASE_ANON_KEY"] || "";
  if (!url || !anon) return null;
  try {
    const client = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client
      .from("daily_signals")
      .select("market_day, signals, computed_at")
      .order("market_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { market_day?: string; signals?: unknown; computed_at?: string };
    if (typeof row.market_day !== "string" || !Array.isArray(row.signals)) return null;
    return {
      signals: row.signals as StockSignal[],
      run: {
        id: `shared_${row.market_day}`,
        startedAt: row.computed_at ?? new Date().toISOString(),
        finishedAt: row.computed_at ?? new Date().toISOString(),
        provider: "Direct daily_signals read",
        universeSize: row.signals.length,
        signalsGenerated: row.signals.length,
        trigger: "scheduled",
        status: "complete",
        stages: [],
      } as SharedDailySignals["run"],
      computedAt: row.computed_at ?? new Date().toISOString(),
      marketDay: row.market_day,
    };
  } catch {
    return null;
  }
}

async function fetchActiveVariantDirect(): Promise<EngineVariantId> {
  const url = process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon =
    process.env["VITE_SUPABASE_ANON_KEY"] || process.env["SUPABASE_ANON_KEY"] || "";
  if (!url || !anon) return "challenger";
  try {
    const client = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await client
      .from("app_controls")
      .select("active_variant")
      .eq("id", true)
      .maybeSingle();
    const v = (data as { active_variant?: unknown } | null)?.active_variant;
    return v === "challenger" ? "challenger" : "champion";
  } catch {
    return "challenger";
  }
}

async function buildContext(signals: StockSignal[]): Promise<NormalizationContext> {
  const archetypes = buildArchetypeContext(signals);
  if (!isAlpacaConfigured()) {
    return { archetypes, regime: buildMarketRegimeContext({ spyCloses: [], signals }) };
  }
  try {
    const bars = await fetchAlpacaBarsForSymbols(["SPY"], { limit: 260 });
    const spyCloses = bars["SPY"]?.closes ?? [];
    return { archetypes, regime: buildMarketRegimeContext({ spyCloses, signals }) };
  } catch {
    return { archetypes, regime: buildMarketRegimeContext({ spyCloses: [], signals }) };
  }
}

const board = (await fetchRecentSharedSignals()) ?? (await fetchBoardDirect());
if (!board) {
  console.error("No published board available — cannot calibrate.");
  process.exit(1);
}
const variant = await fetchActiveVariantDirect();
const context = await buildContext(board.signals);
const reranked = postProcessUniverse(board.signals, variant, context);

console.log(
  `Board ${board.marketDay} · ${reranked.length} names · live variant = ${variant}\n`,
);

const prefs = defaultPreferences();
for (const def of FOR_YOU_FILTERS) {
  const res = composeForYou(reranked, { ...prefs, forYouFilters: [def.id] });
  const top = res.ranked
    .slice(0, 10)
    .map((r) => `${r.signal.ticker} ${r.matchScore} (${r.reasons[0] ?? ""})`)
    .join("\n    ");
  console.log(
    `${def.label.padEnd(22)} ${String(res.ranked.length).padStart(3)} / ${reranked.length}` +
      (res.ranked.length ? `\n    ${top}` : ""),
  );
  console.log("");
}

console.log("— Emerging themes, per-theme hit counts —");
for (const theme of EMERGING_THEMES) {
  let count = 0;
  const examples: string[] = [];
  for (const s of reranked) {
    const hit = matchEmergingTheme(s, theme);
    if (hit) {
      count += 1;
      if (examples.length < 8) examples.push(`${s.ticker}[${hit.evidence}]`);
    }
  }
  console.log(`${theme.label.padEnd(24)} ${String(count).padStart(3)}  ${examples.join(" ")}`);
}

const allActive = composeForYou(reranked, {
  ...prefs,
  forYouFilters: FOR_YOU_FILTERS.map((f) => f.id),
});
console.log(`\nAll six filters active (union): ${allActive.ranked.length} / ${reranked.length}`);
