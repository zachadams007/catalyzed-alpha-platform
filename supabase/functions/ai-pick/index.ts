// Supabase Edge Function: ai-pick
//
// AI Pick of the Day - analyst-grade pipeline (rebuilt 2026-06-28).
//
// Owner feedback: prior build picked Micron near ATH (catalyst already priced
// in). This rebuild HARD-FILTERS extended/chased names BEFORE any LLM call and
// biases toward early/discounted/reversal setups.
//
// Pipeline:
//   Stage 0  (deterministic, NO LLM) - positive-signal survivor selection from
//             stored daily_signals fields. Keeps a ranked bench so later LLM
//             stages can never collapse the day below the 2-pick floor.
//   Stage 1  (Gemini grounded, top survivors) - live news/revisions last
//             14d → JSON: catalyst_already_moved_price, upcoming_catalyst,
//             fundamentals_improving, source_url, source_date. Drops names
//             where the catalyst already moved the price.
//   Stage 2  (Groq, per finalist) - interpret the technical JSON block →
//             classify EXTENDED | NEUTRAL | BASE-BUILDING | OVERSOLD-REVERSAL
//             + 2-sentence read.
//   Stage 3  (Groq, per finalist) - Bull / Bear / SKEPTIC debate. Skeptic:
//             "is this already priced in? what must be true for the thesis to
//             work?" → verdict BUY | PASS + biggest risk + invalidation level.
//   Stage 4  (Gemini, selected 2-4 picks) - 150-word write-up biased to
//             early/reversal setups. If it already ran on known news, say so.
//   Upsert - 2-4 diverse picks (rank 0..3) into ai_picks.
//
// Accepts POST with optional body:
//   { universe?: Array<{ ticker: string; engineScore: number; pumpRisk: number }> }
// If `universe` is not provided the function fetches the latest daily_signals
// row from Supabase and builds the universe server-side.
//
// Secret env vars (must be set in supabase secrets):
//   GEMINI_API_KEY - primary Gemini 2.5 Flash key (grounded search)
//   GEMINI_API_KEY_BACKUP - failover (optional)
//   GEMINI_API_KEY_3 - third key (optional)
//   GEMINI_API_KEY_4 - fourth key (optional)
//   LLM_API_KEY - Groq key (may be comma-separated pool)
//   LLM_API_KEY_2 - second Groq key (optional)
//   LLM_API_KEY_3 - third (optional)
//   LLM_API_KEY_4 - fourth (optional)
//   LLM_BASE_URL - https://api.groq.com/openai/v1
//   LLM_MODEL - llama-3.3-70b-versatile
//   SUPABASE_URL - auto-injected by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - service-role key for writing ai_picks

// deno-lint-ignore-file no-explicit-any

import { shouldFailover } from "../_shared/failover.ts";

// ---------------------------------------------------------------------------
// Key pools (same pattern as research-agent)
// ---------------------------------------------------------------------------

function envPool(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const v = Deno.env.get(n)?.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

const GEMINI_KEYS = envPool([
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_BACKUP",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
]);

const LLM_KEYS = (() => {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const entry of envPool([
    "LLM_API_KEY",
    "LLM_API_KEY_2",
    "LLM_API_KEY_3",
    "LLM_API_KEY_4",
  ])) {
    for (const k of entry.split(/[,\s]+/).map((s) => s.trim())) {
      if (k && !seen.has(k)) {
        seen.add(k);
        expanded.push(k);
      }
    }
  }
  return expanded;
})();

const LLM_BASE_URL = (Deno.env.get("LLM_BASE_URL") ?? "").replace(/\/+$/, "");
const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "llama-3.3-70b-versatile";
const GEMINI_MODEL = Deno.env.get("RESEARCH_MODEL") ?? "gemini-2.5-flash";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const UPSTREAM_TIMEOUT_MS = Number(Deno.env.get("UPSTREAM_TIMEOUT_MS") ?? "40000");

// Max citation age (72 hours).
const MAX_CITATION_AGE_MS = 72 * 60 * 60 * 1000;

// Stage 0 is a LIGHT gate now (not the structured algorithm). The AI Pick surfaces
// the stocks with the MOST positive signal - buzz, fresh news, catalysts, quality -
// and the LLM stages do the real judging. Only true junk is dropped here.
const JUNK_PRICE_MIN = 2;            // drop sub-$2 true penny stocks (board already floors $3)
// The pick set is ALWAYS 2-4 (never 1). Hero + a contrasting #2 always ship; #3/#4
// are added only if they clear this worthiness bar.
const MIN_PICKS = 2;
const MAX_PICKS = 4;
const TARGET_PICKS = 3;
const RUNNER_WORTHY_MIN = 50;
// The pick set is built to span both.
const CAP_BIG_MIN = 20_000_000_000; // $20B

// How many of the buzziest survivors to deep-scan with grounded news.
const STAGE1_MAX_CANDIDATES = 10;
// How many survivors overall from Stage 0.
const STAGE0_MAX_SURVIVORS = 16;

// Deduplication window for hero picks.
const DEDUP_DAYS = 7;

// Round-robin cursors.
let geminiCursor = 0;
let groqCursor = 0;

// ---------------------------------------------------------------------------
// CORS + helpers
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Try to pull a JSON object out of a string that may have prose around it. */
function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/** Today's US Eastern calendar date (YYYY-MM-DD). Matches the daily_signals clock. */
function marketDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function urlMatchesAny(url: string, allowed: Set<string>): boolean {
  try {
    const u = new URL(url);
    const key = u.host + u.pathname.replace(/\/$/, "");
    for (const a of allowed) {
      try {
        const au = new URL(a);
        if (au.host + au.pathname.replace(/\/$/, "") === key) return true;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* not a URL */
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gemini grounded call (mirrors research-agent approach)
// ---------------------------------------------------------------------------

async function callGeminiWithKey(
  instruction: string,
  query: string,
  key: string,
): Promise<{ text: string; urls: string[] }> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: "user", parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const text: string = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((p: any) => p?.text ?? "").join("\n")
    : "";
  const urls: string[] = [];
  const meta = candidate?.groundingMetadata;
  const chunks: any[] = Array.isArray(meta?.groundingChunks) ? meta.groundingChunks : [];
  for (const chunk of chunks) {
    const u = chunk?.web?.uri ?? chunk?.retrievedContext?.uri;
    if (typeof u === "string" && u.startsWith("http")) urls.push(u);
  }
  const supports: any[] = Array.isArray(meta?.groundingSupports) ? meta.groundingSupports : [];
  for (const s of supports) {
    const u = s?.web?.uri ?? s?.retrievedContext?.uri;
    if (typeof u === "string" && u.startsWith("http") && !urls.includes(u)) urls.push(u);
  }
  return { text, urls };
}

/**
 * Grounded Gemini call with round-robin key rotation + retry on zero grounding.
 * Never throws - returns { text: '', urls: [] } on total failure.
 */
async function groundedGemini(
  instruction: string,
  query: string,
): Promise<{ text: string; urls: string[] }> {
  const n = GEMINI_KEYS.length;
  if (n === 0) return { text: "", urls: [] };

  const attempt = async (): Promise<{ text: string; urls: string[] }> => {
    const start = geminiCursor % n;
    geminiCursor = (start + 1) % n;
    let lastErr: unknown;
    for (let i = 0; i < n; i++) {
      const ki = (start + i) % n;
      try {
        return await callGeminiWithKey(instruction, query, GEMINI_KEYS[ki]);
      } catch (e) {
        lastErr = e;
        const msg = String(e);
        if (/429|quota|rate|503|overload/i.test(msg) && i < n - 1) continue;
        break;
      }
    }
    throw lastErr ?? new Error("Gemini pool exhausted");
  };

  try {
    let r = await attempt();
    if (r.urls.length === 0) {
      try {
        const r2 = await attempt();
        if (r2.urls.length > 0) r = r2;
      } catch {
        /* keep first attempt */
      }
    }
    return r;
  } catch {
    return { text: "", urls: [] };
  }
}

// ---------------------------------------------------------------------------
// Groq call (round-robin, failover on 429)
// ---------------------------------------------------------------------------

async function callGroq(
  system: string,
  user: string,
  jsonMode: boolean,
): Promise<string> {
  const n = LLM_KEYS.length;
  if (n === 0) throw new Error("No LLM key configured");
  const body = JSON.stringify({
    model: LLM_MODEL,
    temperature: 0.4,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
  const start = groqCursor % n;
  groqCursor = (start + 1) % n;
  let lastErr: unknown;
  for (let i = 0; i < n; i++) {
    const ki = (start + i) % n;
    const isLast = i === n - 1;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LLM_KEYS[ki]}`,
        },
        body,
      });
    } catch (e) {
      lastErr = e;
      if (isLast) throw e;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? "";
    }
    const detail = await res.text().catch(() => "");
    if (shouldFailover(res.status, detail) && !isLast) {
      lastErr = new Error(`Groq ${res.status} ${detail.slice(0, 120)}`);
      continue;
    }
    throw new Error(`Groq ${res.status} ${detail.slice(0, 200)}`);
  }
  throw lastErr ?? new Error("Groq pool exhausted");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal universe entry (provided or built from daily_signals). */
interface UniverseEntry {
  ticker: string;
  /** The signal's real opportunityScore (read from s.score.opportunityScore). */
  engineScore: number;
  pumpRisk: number;
  /** Full stored signal blob - used by Stage 0 for technical fields. */
  rawSignal?: any;
}

/** The computed technical snapshot fed to Stage 2 (Groq) and stored in meta. */
interface TechnicalBlock {
  ticker: string;
  rsi14: number;
  rsiTrend: string;            // "rising" | "falling" | "neutral"
  priceVs50dma_pct: number;    // signed %, positive = above
  priceVs200dma_pct: number;
  distFrom52wkHigh_pct: number; // always ≥ 0 (how far BELOW the 52wk high)
  distFrom52wkLow_pct: number;  // always ≥ 0 (how far ABOVE the 52wk low)
  return1M_pct: number;
  return3M_pct: number;
  relStrength3M: number;        // ratio spread vs SPY
  aboveSMA50: boolean;
  aboveSMA200: boolean;
  atrPct: number;
  catalystDaysAway: number | null; // null = no dated catalyst
  catalystType: string;
  valuationScore: number;       // 0-100 engine category score
  opportunityScore: number;     // engine opportunityScore
  riskPenalty: number;
  riskLevel: string;
}

type Stage0Candidate = UniverseEntry & { technical: TechnicalBlock };

/** A candidate that survived Stage 0 and passed Stage 1. */
interface SurvivorCandidate {
  ticker: string;
  engineScore: number;          // s.score.opportunityScore
  technical: TechnicalBlock;
  // Stage 1 outputs
  upcomingCatalyst: string | null;
  fundamentalsImproving: boolean;
  primarySourceUrl: string;
  sourceDate: string;
  catalystAlreadyMovedPrice: boolean; // if true, dropped after Stage 1
}

/** Stage 2 technical classification per finalist. */
interface TechClassification {
  ticker: string;
  setup: "EXTENDED" | "NEUTRAL" | "BASE-BUILDING" | "OVERSOLD-REVERSAL";
  twoSentenceRead: string;
}

/** Stage 3 Bull/Bear/Skeptic debate result per finalist. */
interface DebateResult {
  ticker: string;
  bullCase: string;
  bearCase: string;
  skepticNote: string;
  verdict: "BUY" | "PASS";
  biggestRisk: string;
  invalidationLevel: string;
}

/** Stage 4 final write-up. */
interface WriteUp {
  ticker: string;
  writeUp: string;            // ≤150 words
  horizon: string;            // e.g. "3-5 day swing"
  confidence: number;         // 0-1
  macroDriven: boolean;
}

/** Final scored candidate ready for upsert. */
interface FinalCandidate {
  ticker: string;
  engineScore: number;
  setup: TechClassification["setup"];
  verdict: "BUY" | "PASS";
  confidence: number;
  horizonDays: number;
  catalystSummary: string;
  primarySourceUrl: string;
  bullCase: string;
  bearCase: string;
  skepticNote: string;
  biggestRisk: string;
  invalidationLevel: string;
  writeUp: string;
  macroDriven: boolean;
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

/** Fetch the latest daily_signals row and return full signal blobs. */
async function fetchUniverseFromSupabase(): Promise<UniverseEntry[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/daily_signals?select=signals&order=market_day.desc&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return [];
    const rows = await res.json();
    const signals: any[] = Array.isArray(rows?.[0]?.signals) ? rows[0].signals : [];
    return signals
      .filter((s: any) => typeof s?.ticker === "string")
      .map((s: any) => ({
        ticker: String(s.ticker).toUpperCase().trim(),
        // s.score is a ScoreBreakdown object; opportunityScore is the field we want.
        engineScore:
          typeof s?.score?.opportunityScore === "number" ? s.score.opportunityScore : 50,
        pumpRisk:
          s?.riskLevel === "High" || s?.riskLevel === "Extreme"
            ? 0.7
            : typeof s?.pumpRisk === "number"
            ? s.pumpRisk
            : 0,
        rawSignal: s,
      }));
  } catch {
    return [];
  }
}

/** Fetch the last DEDUP_DAYS of hero picks to avoid re-picking. */
async function fetchRecentPickedTickers(): Promise<Set<string>> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return new Set();
  try {
    const since = new Date(Date.now() - DEDUP_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/ai_picks?select=ticker&market_day=gte.${since}&rank=eq.0`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return new Set();
    const rows = await res.json();
    return new Set(
      Array.isArray(rows) ? rows.map((r: any) => String(r.ticker).toUpperCase()) : [],
    );
  } catch {
    return new Set();
  }
}

interface AiPickRow {
  market_day: string;
  rank: number;
  ticker: string;
  final_score: number;
  engine_score: number;
  judge_score: number;
  confidence: number;
  horizon_days: number;
  catalyst_summary: string;
  catalyst_type: string;
  primary_source_url: string;
  bull_case: string;
  bear_case: string;
  skeptic_note: string;
  macro_driven: boolean;
}

async function upsertPicks(rows: AiPickRow[]): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  // Clear today's rows FIRST so a variable-count run (e.g. 1 pick today after a
  // 3-pick day) can't leave stale rank-1/2 rows behind from a prior generation.
  const day = rows[0]?.market_day;
  if (day) {
    await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/ai_picks?market_day=eq.${day}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }).catch(() => { /* best-effort; the insert below still corrects ranks 0..n */ });
  }
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/ai_picks`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Upsert failed ${res.status}: ${detail.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Stage 0 - Hard "priced-in" filter (deterministic, NO LLM)
// ---------------------------------------------------------------------------

/**
 * Derive a TechnicalBlock from the stored signal fields.
 * All inputs come from the engine's already-computed output - no raw OHLCV needed.
 */
function buildTechnicalBlock(s: any): TechnicalBlock {
  const momentum = s?.momentum ?? {};
  const score = s?.score ?? {};
  const catalyst = s?.catalyst ?? {};

  // priceHistory: number[] oldest→newest, ~30 closes.
  const ph: number[] = Array.isArray(s?.priceHistory) ? s.priceHistory : [];
  const currentPrice: number = typeof s?.price === "number" ? s.price : (ph[ph.length - 1] ?? 0);

  // 52-week approximation from priceHistory (up to 252 closes, we have ~30).
  const high52 = ph.length > 0 ? Math.max(...ph) : currentPrice;
  const low52 = ph.length > 0 ? Math.min(...ph) : currentPrice;

  // SMA approximations from priceHistory.
  // Use last min(50, len) and last min(200, len) closes.
  function sma(arr: number[], n: number): number {
    const slice = arr.slice(Math.max(0, arr.length - n));
    if (slice.length === 0) return currentPrice;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
  const sma50 = sma(ph, 50);
  const sma200 = sma(ph, 200);

  const priceVs50dma_pct = sma50 > 0 ? ((currentPrice - sma50) / sma50) * 100 : 0;
  const priceVs200dma_pct = sma200 > 0 ? ((currentPrice - sma200) / sma200) * 100 : 0;
  const distFrom52wkHigh_pct = high52 > 0 ? ((high52 - currentPrice) / high52) * 100 : 0;
  const distFrom52wkLow_pct = low52 > 0 ? ((currentPrice - low52) / low52) * 100 : 0;

  // RSI trend: compare current RSI to what it was ~10 bars ago (approximate).
  const rsi14: number = typeof momentum.rsi === "number" ? momentum.rsi : 50;
  // We don't have a rsi history array, so we infer trend from price action.
  // If return1M is positive and RSI still < 50, it's "recovering". If return1M
  // is strongly positive AND RSI > 65, it's "elevated/potentially topping".
  let rsiTrend = "neutral";
  const r1m: number = typeof momentum.return1M === "number" ? momentum.return1M : 0;
  if (rsi14 < 50 && r1m > 0) rsiTrend = "rising from oversold";
  else if (rsi14 > 65 && r1m > 0.15) rsiTrend = "elevated — may be extended";
  else if (rsi14 < 40) rsiTrend = "oversold — potential reversal setup";
  else if (rsi14 > 70) rsiTrend = "overbought";

  // Find valuation category score.
  let valuationScore = 50;
  const categories: any[] = Array.isArray(score?.categories) ? score.categories : [];
  for (const cat of categories) {
    if (cat?.key === "valuation" && typeof cat?.score === "number") {
      valuationScore = cat.score;
      break;
    }
  }

  // Catalyst days away: daysAway < 0 = already occurred; null = None type.
  let catalystDaysAway: number | null = null;
  const catalystType: string = catalyst?.type ?? "None";
  if (catalystType !== "None" && typeof catalyst?.daysAway === "number") {
    catalystDaysAway = catalyst.daysAway;
  }

  const atrPct: number = typeof s?.volatility?.atrPct === "number" ? s.volatility.atrPct : 0;
  const relStrength3M: number =
    typeof momentum.relativeStrength3M === "number" ? momentum.relativeStrength3M : 0;

  return {
    ticker: String(s?.ticker ?? "").toUpperCase(),
    rsi14,
    rsiTrend,
    priceVs50dma_pct: Math.round(priceVs50dma_pct * 10) / 10,
    priceVs200dma_pct: Math.round(priceVs200dma_pct * 10) / 10,
    distFrom52wkHigh_pct: Math.round(distFrom52wkHigh_pct * 10) / 10,
    distFrom52wkLow_pct: Math.round(distFrom52wkLow_pct * 10) / 10,
    return1M_pct: Math.round(r1m * 1000) / 10, // convert ratio → %
    return3M_pct: Math.round((momentum.return3M ?? 0) * 1000) / 10,
    relStrength3M: Math.round(relStrength3M * 1000) / 1000,
    aboveSMA50: typeof momentum.aboveSMA50 === "boolean" ? momentum.aboveSMA50 : priceVs50dma_pct > 0,
    aboveSMA200: typeof momentum.aboveSMA200 === "boolean" ? momentum.aboveSMA200 : priceVs200dma_pct > 0,
    atrPct: Math.round(atrPct * 1000) / 10,
    catalystDaysAway,
    catalystType,
    valuationScore,
    opportunityScore: typeof score?.opportunityScore === "number" ? score.opportunityScore : 50,
    riskPenalty: typeof score?.riskPenalty === "number" ? score.riskPenalty : 0,
    riskLevel: typeof s?.riskLevel === "string" ? s.riskLevel : "Moderate",
  };
}

/**
 * POSITIVE-SIGNAL score for Stage-0 ordering. The AI Pick is NOT the structured
 * algorithm - it surfaces the stocks with the MOST going for them right now: buzz
 * (people talking about it), fresh news, catalysts, and the engine's quality read,
 * with some room left to run. ANYTHING positive counts - fundamentals, hype, or
 * speculation. This only ORDERS candidates; the grounded LLM stages judge upside vs
 * priced-in, and the engine still SCORES the final pick 0-100.
 */
function stage0PositiveSignal(s: any, tb: TechnicalBlock): number {
  let pts = 0;
  // Buzz tier is size-NEUTRAL (a small name can run "Hot") - lean here so the biggest
  // household names don't automatically win on sheer article volume.
  const hype = typeof s?.hype?.score === "number" ? s.hype.score : 0;
  pts += hype * 0.8;
  // Raw news volume helps but is DOWN-weighted - it scales with company size, which is
  // exactly the mega-cap bias we're correcting.
  const newsCount = Array.isArray(s?.news?.items) ? s.news.items.length : 0;
  pts += Math.min(newsCount, 10) * 0.9;
  // Social-buzz driver from the hype breakdown.
  const drivers: any[] = Array.isArray(s?.hype?.drivers) ? s.hype.drivers : [];
  const social = drivers.find((d: any) => d?.key === "social");
  if (social && typeof social.points === "number") pts += Math.min(social.points, 18);
  // A dated catalyst (upcoming or very recent) is a strong positive.
  if (tb.catalystDaysAway !== null) pts += 14;
  // The engine's overall quality read - fundamentals/setup/etc.
  pts += tb.opportunityScore * 0.35;
  // Some room left to run (not pinned at the 52-week high).
  if (tb.distFrom52wkHigh_pct > 12) pts += 8;
  // (True penny stocks already dropped.)
  const cap = typeof s?.marketCap === "number" ? s.marketCap : 0;
  if (cap > 0 && cap < CAP_BIG_MIN && (hype >= 30 || tb.catalystDaysAway !== null)) pts += 14;
  return pts;
}

/**
 * Stage 0: rank the universe by POSITIVE SIGNAL (buzz + news + catalyst + quality)
 * and drop ONLY true junk. Deliberately light - the grounded LLM stages do the real
 * judging of upside, sentiment, and whether a move is already priced in.
 */
function stage0Filter(
  universe: UniverseEntry[],
  recentPicks: Set<string>,
): Stage0Candidate[] {
  const results: Array<UniverseEntry & { technical: TechnicalBlock; prefScore: number }> = [];

  for (const entry of universe) {
    const s = entry.rawSignal;
    if (!s) continue;

    // Don't re-pick a recent hero (last DEDUP_DAYS).
    if (recentPicks.has(entry.ticker)) continue;

    const tb = buildTechnicalBlock(s);

    // LIGHT junk gate ONLY: kill the perennial sub-$2 penny stock; KEEP promising-
    // but-speculative names (a name slightly speculative today but likely to turn
    // profitable soon should NOT be cut just because it isn't Amazon-grade). The
    // daily board already floors price ≥ $3 / cap ≥ $50M, so this rarely fires.
    const price: number = typeof s?.price === "number" ? s.price : 0;
    if (price > 0 && price < JUNK_PRICE_MIN) continue;

    results.push({ ...entry, technical: tb, prefScore: stage0PositiveSignal(s, tb) });
  }

  // Most positive signal first.
  results.sort((a, b) => b.prefScore - a.prefScore);

  // VARIETY: interleave the top big-caps and the top smaller high-potential names so
  // the grounded scan - and the final picks - span both, instead of a wall of famous
  // mega-caps. Each bucket stays ranked by positive signal internally.
  const capOf = (r: { rawSignal?: any }) =>
    typeof r.rawSignal?.marketCap === "number" ? r.rawSignal.marketCap : 0;
  const big = results.filter((r) => capOf(r) >= CAP_BIG_MIN);
  const small = results.filter((r) => capOf(r) < CAP_BIG_MIN);
  const survivors: typeof results = [];
  let bi = 0;
  let si = 0;
  while (survivors.length < STAGE0_MAX_SURVIVORS && (bi < big.length || si < small.length)) {
    if (bi < big.length) survivors.push(big[bi++]!);
    if (survivors.length < STAGE0_MAX_SURVIVORS && si < small.length) survivors.push(small[si++]!);
  }

  // Return without prefScore in the public type.
  return survivors.map(({ prefScore: _p, ...rest }) => rest);
}

function mergeDistinctStage0(primary: Stage0Candidate[], backup: Stage0Candidate[]): Stage0Candidate[] {
  const seen = new Set(primary.map((entry) => entry.ticker));
  const merged = [...primary];
  for (const entry of backup) {
    if (seen.has(entry.ticker)) continue;
    seen.add(entry.ticker);
    merged.push(entry);
  }
  return merged.slice(0, STAGE0_MAX_SURVIVORS);
}

function capTierFromSignal(rawSignal: any): string {
  if (typeof rawSignal?.marketCapBucket === "string" && rawSignal.marketCapBucket !== "Unknown") {
    return rawSignal.marketCapBucket;
  }
  const cap = typeof rawSignal?.marketCap === "number" ? rawSignal.marketCap : 0;
  if (cap >= 200_000_000_000) return "Mega";
  if (cap >= 20_000_000_000) return "Large";
  if (cap >= 2_000_000_000) return "Mid";
  if (cap >= 300_000_000) return "Small";
  if (cap > 0) return "Micro";
  return "Unknown";
}

function themeFromSignal(rawSignal: any): string {
  const whyTags: any[] = Array.isArray(rawSignal?.whyInteresting) ? rawSignal.whyInteresting : [];
  for (const tag of whyTags) {
    const label = tag?.label ?? tag?.id ?? tag?.key;
    if (typeof label === "string" && label.trim()) return `why:${label.trim().toLowerCase()}`;
  }

  const catalystType = rawSignal?.catalyst?.type ?? rawSignal?.catalystType;
  if (typeof catalystType === "string" && catalystType && catalystType !== "None") {
    return `catalyst:${catalystType.toLowerCase()}`;
  }

  const drivers: any[] = Array.isArray(rawSignal?.hype?.drivers) ? rawSignal.hype.drivers : [];
  const driver = drivers.find((d: any) => typeof d?.key === "string" && typeof d?.points === "number" && d.points > 0);
  if (driver) return `hype:${driver.key.toLowerCase()}`;

  const industry = rawSignal?.finnhubIndustry ?? rawSignal?.industry;
  if (typeof industry === "string" && industry.trim()) return `industry:${industry.trim().toLowerCase()}`;

  return `sector:${typeof rawSignal?.sector === "string" ? rawSignal.sector.toLowerCase() : "unknown"}`;
}

function diversityProfile(rawSignal: any): { sector: string; capTier: string; theme: string } {
  return {
    sector: typeof rawSignal?.sector === "string" && rawSignal.sector.trim()
      ? rawSignal.sector.trim()
      : "Unknown",
    capTier: capTierFromSignal(rawSignal),
    theme: themeFromSignal(rawSignal),
  };
}

function diversityBonus(
  ticker: string,
  selectedTickers: string[],
  rawByTicker: Map<string, any>,
): number {
  if (selectedTickers.length === 0) return 0;
  const profile = diversityProfile(rawByTicker.get(ticker));
  const selected = selectedTickers.map((t) => diversityProfile(rawByTicker.get(t)));
  let bonus = 0;

  if (!selected.some((p) => p.sector === profile.sector)) bonus += 14;
  else bonus -= 4;

  if (!selected.some((p) => p.capTier === profile.capTier)) bonus += 12;
  else bonus -= 3;

  if (!selected.some((p) => p.theme === profile.theme)) bonus += 10;
  else bonus -= 3;

  if (selected.some((p) =>
    p.sector === profile.sector && p.capTier === profile.capTier && p.theme === profile.theme
  )) {
    bonus -= 14;
  }

  return bonus;
}

function firstNewsSource(rawSignal: any): { url: string; date: string } {
  const items: any[] = Array.isArray(rawSignal?.news?.items) ? rawSignal.news.items : [];
  const item = items.find((n: any) => typeof n?.url === "string" && n.url.startsWith("http")) ?? items[0];
  const url = typeof item?.url === "string" ? item.url : "";
  const publishedAt = typeof item?.publishedAt === "string" ? item.publishedAt : "";
  const date = publishedAt ? publishedAt.slice(0, 10) : "";
  return { url, date };
}

function catalystTextFromSignal(rawSignal: any): string | null {
  const catalyst = rawSignal?.catalyst ?? {};
  const type = catalyst?.type ?? rawSignal?.catalystType;
  const description = catalyst?.description ?? rawSignal?.catalystDescription;
  if (type && type !== "None" && typeof description === "string" && description.trim()) {
    return description.trim().slice(0, 200);
  }
  const earningsDate = rawSignal?.nextEarnings?.dateISO;
  if (typeof earningsDate === "string" && earningsDate) {
    return `Upcoming earnings scheduled for ${earningsDate}`;
  }
  return null;
}

function fundamentalsImprovingFromSignal(rawSignal: any): boolean {
  const fundamentals = rawSignal?.fundamentals ?? {};
  const revenueGrowth = typeof fundamentals?.revenueGrowthYoY === "number" ? fundamentals.revenueGrowthYoY : 0;
  const epsGrowth = typeof fundamentals?.epsGrowthYoY === "number" ? fundamentals.epsGrowthYoY : 0;
  return revenueGrowth > 0.15 || epsGrowth > 0.15;
}

function fallbackSurvivorFromStage0(entry: Stage0Candidate): SurvivorCandidate {
  const source = firstNewsSource(entry.rawSignal);
  return {
    ticker: entry.ticker,
    engineScore: entry.engineScore,
    technical: entry.technical,
    catalystAlreadyMovedPrice: false,
    upcomingCatalyst: catalystTextFromSignal(entry.rawSignal),
    fundamentalsImproving: fundamentalsImprovingFromSignal(entry.rawSignal),
    primarySourceUrl: source.url,
    sourceDate: source.date,
  };
}

function fallbackTechClassification(
  ticker: string,
  tb: TechnicalBlock,
  rawSignal: any,
): TechClassification {
  let setup: TechClassification["setup"] = "NEUTRAL";
  if (tb.rsi14 < 42 && tb.distFrom52wkHigh_pct > 15) {
    setup = "OVERSOLD-REVERSAL";
  } else if (tb.rsi14 <= 62 && tb.return1M_pct < 18 && tb.distFrom52wkHigh_pct > 6) {
    setup = "BASE-BUILDING";
  } else if (tb.rsi14 > 72 && tb.return1M_pct > 28) {
    setup = "EXTENDED";
  }

  const catalyst = catalystTextFromSignal(rawSignal);
  const theme = themeFromSignal(rawSignal).replace(/^[^:]+:/, "");
  const twoSentenceRead =
    `${ticker} stayed on the Stage-0 bench because its stored signal still shows positive online attention` +
    ` (${theme}) and an engine opportunity score of ${Math.round(tb.opportunityScore)}. ` +
    `${catalyst ? `Known catalyst context: ${catalyst}. ` : ""}` +
    `RSI is ${tb.rsi14}, one-month return is ${tb.return1M_pct}%, and it sits ${tb.distFrom52wkHigh_pct}% below its recent high.`;

  return { ticker, setup, twoSentenceRead };
}

function pickDiverseStage0Backfills(
  stage0Survivors: Stage0Candidate[],
  selectedTickers: string[],
  excludedTickers: Set<string>,
  targetCount: number,
  rawByTicker: Map<string, any>,
): Stage0Candidate[] {
  const chosen: Stage0Candidate[] = [];
  const selected = [...selectedTickers];

  while (selected.length < targetCount) {
    const pool = stage0Survivors
      .map((entry, order) => ({ entry, order }))
      .filter(({ entry }) => !excludedTickers.has(entry.ticker) && !selected.includes(entry.ticker));
    if (pool.length === 0) break;

    pool.sort((a, b) => {
      const aScore = (STAGE0_MAX_SURVIVORS - a.order) * 4 + diversityBonus(a.entry.ticker, selected, rawByTicker);
      const bScore = (STAGE0_MAX_SURVIVORS - b.order) * 4 + diversityBonus(b.entry.ticker, selected, rawByTicker);
      return bScore - aScore;
    });

    const next = pool[0]!.entry;
    chosen.push(next);
    selected.push(next.ticker);
  }

  return chosen;
}

// ---------------------------------------------------------------------------
// Stage 1 - Gemini grounded: live news/revisions last 14d (top ~6 survivors)
// ---------------------------------------------------------------------------

const STAGE1_INSTRUCTION =
  "You are a rigorous US equity catalyst analyst. Use Google Search to find the freshest news, analyst revisions, and SEC filings for a specific stock from the LAST 14 DAYS ONLY. Your goal: determine (1) whether the catalyst has ALREADY moved the price (bad — priced in), or (2) whether an UPCOMING / PENDING catalyst still lies ahead (good — early). Return ONLY the JSON object requested. Never invent URLs or dates.";

async function stage1GroundedScan(
  ticker: string,
  technicalSummary: string,
): Promise<{
  catalystAlreadyMovedPrice: boolean;
  upcomingCatalyst: string | null;
  fundamentalsImproving: boolean;
  primarySourceUrl: string;
  sourceDate: string;
}> {
  const query =
    `Catalyst status check for ${ticker} (last 14 days only). ` +
    `Technical context: ${technicalSummary}. ` +
    `Use Google Search to find: (1) Has any known catalyst (earnings, FDA, M&A, contract, guidance) ALREADY occurred AND caused a major price move in the last 14 days? ` +
    `(2) Is there a PENDING / UPCOMING catalyst (earnings date, FDA decision, contract announcement) that has NOT yet happened? ` +
    `(3) Are analyst estimates or guidance trending UP (improving) or DOWN (deteriorating)? ` +
    `Return a strict JSON: {"catalyst_already_moved_price":boolean,"upcoming_catalyst":string|null,"fundamentals_improving":boolean,"primary_source_url":string,"source_date":"YYYY-MM-DD"}. ` +
    `upcoming_catalyst is null if none found. primary_source_url must be a real URL you retrieved. Never invent URLs.`;

  const { text, urls } = await groundedGemini(STAGE1_INSTRUCTION, query);
  const parsed = extractJson(text);

  const catalystAlreadyMovedPrice = Boolean(parsed?.catalyst_already_moved_price);
  const upcomingCatalyst =
    typeof parsed?.upcoming_catalyst === "string" && parsed.upcoming_catalyst.trim()
      ? parsed.upcoming_catalyst.trim().slice(0, 200)
      : null;
  const fundamentalsImproving = Boolean(parsed?.fundamentals_improving);

  // Source URL: prefer model answer if it matches a retrieved URL, else first retrieved.
  let primarySourceUrl =
    typeof parsed?.primary_source_url === "string" ? parsed.primary_source_url.trim() : "";
  const allowedUrls = new Set(urls);
  if (!primarySourceUrl || (!allowedUrls.has(primarySourceUrl) && !urlMatchesAny(primarySourceUrl, allowedUrls))) {
    primarySourceUrl = urls[0] ?? "";
  }

  const sourceDate =
    typeof parsed?.source_date === "string" ? parsed.source_date.trim() : "";

  // Reject stale citations (>72h old).
  if (sourceDate) {
    const t = Date.parse(sourceDate + "T12:00:00Z");
    if (Number.isFinite(t) && Date.now() - t > MAX_CITATION_AGE_MS) {
      // Citation is stale - keep data but clear source (partial-failure mode).
      return { catalystAlreadyMovedPrice, upcomingCatalyst, fundamentalsImproving, primarySourceUrl: urls[0] ?? "", sourceDate: "" };
    }
  }

  return { catalystAlreadyMovedPrice, upcomingCatalyst, fundamentalsImproving, primarySourceUrl, sourceDate };
}

// ---------------------------------------------------------------------------
// Stage 2 - Groq: technical interpretation (per finalist)
// ---------------------------------------------------------------------------

const STAGE2_SYS =
  "You are a technical analyst. You will be given a JSON block of pre-computed technical indicators for a stock. " +
  "Your ONLY job is to classify the setup and provide a 2-sentence read. " +
  "Classify as exactly one of: EXTENDED (RSI high, far above MAs, already ran — avoid), " +
  "NEUTRAL (mid-range, no clear setup), " +
  "BASE-BUILDING (low volatility contraction, tight range, RSI recovering, potential coiling), " +
  "OVERSOLD-REVERSAL (RSI <40, far below 52wk high, off a base — reversal candidate). " +
  "IMPORTANT: Interpret ONLY the numbers given. Do not describe price action you cannot see. " +
  "Do not give buy/sell advice. " +
  "Respond with ONLY strict JSON: {\"setup\":\"EXTENDED\"|\"NEUTRAL\"|\"BASE-BUILDING\"|\"OVERSOLD-REVERSAL\",\"two_sentence_read\":string}";

async function stage2TechnicalClassify(tb: TechnicalBlock): Promise<TechClassification> {
  const technicalJson = JSON.stringify({
    rsi_14: tb.rsi14,
    rsi_trend: tb.rsiTrend,
    price_vs_50dma_pct: tb.priceVs50dma_pct,
    price_vs_200dma_pct: tb.priceVs200dma_pct,
    dist_from_52wk_high_pct: tb.distFrom52wkHigh_pct,
    dist_from_52wk_low_pct: tb.distFrom52wkLow_pct,
    return_1m_pct: tb.return1M_pct,
    return_3m_pct: tb.return3M_pct,
    relative_strength_vs_spy_3m: tb.relStrength3M,
    above_sma50: tb.aboveSMA50,
    above_sma200: tb.aboveSMA200,
    atr_pct: tb.atrPct,
    catalyst_days_away: tb.catalystDaysAway,
    valuation_score_0_to_100: tb.valuationScore,
  });

  const text = await callGroq(STAGE2_SYS, `Technical block for ${tb.ticker}:\n${technicalJson}`, true);
  const parsed = extractJson(text);

  const validSetups = new Set(["EXTENDED", "NEUTRAL", "BASE-BUILDING", "OVERSOLD-REVERSAL"]);
  const setup: TechClassification["setup"] =
    typeof parsed?.setup === "string" && validSetups.has(parsed.setup)
      ? (parsed.setup as TechClassification["setup"])
      : "NEUTRAL";

  return {
    ticker: tb.ticker,
    setup,
    twoSentenceRead:
      typeof parsed?.two_sentence_read === "string"
        ? parsed.two_sentence_read.trim().slice(0, 400)
        : "(Technical read unavailable.)",
  };
}

// ---------------------------------------------------------------------------
// Stage 3 - Groq: Bull / Bear / SKEPTIC debate (per finalist)
// ---------------------------------------------------------------------------

const STAGE3_SYS =
  "You are running a three-voice investment debate. Using ONLY the catalyst and technical context provided (no external knowledge), " +
  "produce three independent voices:\n" +
  "BULL: The strongest evidence-based case FOR this stock as a 3-5 day swing trade. 2-4 sentences.\n" +
  "BEAR: The strongest evidence-based case AGAINST. 2-4 sentences.\n" +
  "SKEPTIC: Your ONLY job is to determine — IS THIS ALREADY PRICED IN? What specific assumptions must be true for the thesis to work, and which is least verifiable? Name one specific price/event invalidation level (e.g. 'thesis breaks if price closes below $X' or 'FDA decision already priced in — stock up 40% post-announcement'). 2-4 sentences.\n" +
  "Then give a VERDICT.\n" +
  "Do not give buy/sell advice to end users. Respond ONLY with strict JSON:\n" +
  "{\"bull_case\":string,\"bear_case\":string,\"skeptic_note\":string,\"verdict\":\"BUY\"|\"PASS\",\"biggest_risk\":string,\"invalidation_level\":string}";

async function stage3Debate(
  survivor: SurvivorCandidate,
  techClass: TechClassification,
): Promise<DebateResult> {
  const context =
    `Ticker: ${survivor.ticker}\n` +
    `Technical setup: ${techClass.setup}\n` +
    `Technical read: ${techClass.twoSentenceRead}\n` +
    `Upcoming catalyst: ${survivor.upcomingCatalyst ?? "None identified"}\n` +
    `Fundamentals improving: ${survivor.fundamentalsImproving}\n` +
    `Primary source: ${survivor.primarySourceUrl}\n` +
    `Source date: ${survivor.sourceDate}\n` +
    `RSI: ${survivor.technical.rsi14} (${survivor.technical.rsiTrend})\n` +
    `Distance from 52wk high: ${survivor.technical.distFrom52wkHigh_pct}%\n` +
    `1-month return: ${survivor.technical.return1M_pct}%\n` +
    `Valuation score (0=expensive/ATH, 100=discounted): ${survivor.technical.valuationScore}\n` +
    `Engine opportunity score: ${survivor.technical.opportunityScore}\n` +
    `Risk level: ${survivor.technical.riskLevel}`;

  const text = await callGroq(STAGE3_SYS, context, true);
  const parsed = extractJson(text);

  const verdict: "BUY" | "PASS" =
    typeof parsed?.verdict === "string" && parsed.verdict.toUpperCase() === "BUY" ? "BUY" : "PASS";

  return {
    ticker: survivor.ticker,
    bullCase:
      typeof parsed?.bull_case === "string" ? parsed.bull_case.trim().slice(0, 600) : "(unavailable)",
    bearCase:
      typeof parsed?.bear_case === "string" ? parsed.bear_case.trim().slice(0, 600) : "(unavailable)",
    skepticNote:
      typeof parsed?.skeptic_note === "string" ? parsed.skeptic_note.trim().slice(0, 600) : "(unavailable)",
    verdict,
    biggestRisk:
      typeof parsed?.biggest_risk === "string" ? parsed.biggest_risk.trim().slice(0, 300) : "",
    invalidationLevel:
      typeof parsed?.invalidation_level === "string" ? parsed.invalidation_level.trim().slice(0, 200) : "",
  };
}

// ---------------------------------------------------------------------------
// Stage 4 - Gemini: 150-word write-up (selected 2-4 picks)
// ---------------------------------------------------------------------------

const STAGE4_INSTRUCTION =
  "You are a sharp markets writer producing a daily AI 'pick of the day' brief for a fintech app. " +
  "This pick was surfaced by scanning the web/news for the stock with the MOST going for it right now — " +
  "buzz, catalysts, momentum, improving fundamentals, or a compelling upside story. " +
  "Lead with WHY this stock is getting attention and what the upside case is (the positive story people are " +
  "talking about), then give the honest counterpoint and main risk. If the move already happened and it's " +
  "now a chase, say so plainly. Never give buy/sell advice. Be specific, concrete, and cite dates.";

async function stage4WriteUp(finalist: {
  ticker: string;
  technical: TechnicalBlock;
  techClass: TechClassification;
  debate: DebateResult;
  upcomingCatalyst: string | null;
  primarySourceUrl: string;
  sourceDate: string;
}): Promise<WriteUp> {
  const query =
    `Write a 150-word analyst brief for ${finalist.ticker}. ` +
    `Technical setup: ${finalist.techClass.setup}. ` +
    `${finalist.techClass.twoSentenceRead} ` +
    `Pending catalyst: ${finalist.upcomingCatalyst ?? "None confirmed"}. ` +
    `RSI ${finalist.technical.rsi14}, ${finalist.technical.distFrom52wkHigh_pct}% below 52wk high, ` +
    `1-month return ${finalist.technical.return1M_pct}%, valuation score ${finalist.technical.valuationScore}/100. ` +
    `Bull: ${finalist.debate.bullCase.slice(0, 300)} ` +
    `Bear: ${finalist.debate.bearCase.slice(0, 300)} ` +
    `Source: ${finalist.primarySourceUrl} (${finalist.sourceDate}). ` +
    `Use Google Search to find the FRESHEST reason ${finalist.ticker} is being talked about right now. ` +
    `Write a tight ~120-word brief: (1) what the company does in one line, (2) WHY IT'S GETTING ATTENTION — ` +
    `the specific recent news, catalyst, momentum, or sentiment driving the buzz and the upside case, ` +
    `(3) the honest main risk / bear counterpoint, (4) a dated source. ` +
    `Ground it in the real setup above — don't invent chart readings. ` +
    `If the move already happened and buying now is chasing, say so plainly. ` +
    `Return ONLY strict JSON: {"write_up":string,"horizon":"e.g. 3-5 day swing","confidence":0.0-1.0,"macro_driven":boolean}`;

  const { text } = await groundedGemini(STAGE4_INSTRUCTION, query);
  const parsed = extractJson(text);

  let writeUp =
    typeof parsed?.write_up === "string"
      ? parsed.write_up.trim().slice(0, 800)
      : "";

  // Fallback: if the grounded Gemini write-up fails (rate limit / no JSON), lead the
  // summary with the Groq BULL CASE - the positive "why it's interesting" story -
  // plus the catalyst and the honest main risk. Reads like a real thesis, not a dry
  // technical dump, so a rate-limited day still looks good.
  if (!writeUp) {
    const bull = finalist.debate.bullCase && finalist.debate.bullCase !== "(unavailable)"
      ? finalist.debate.bullCase.trim()
      : finalist.techClass.twoSentenceRead.trim();
    const risk = finalist.debate.biggestRisk || finalist.debate.bearCase || "See the bear case.";
    writeUp =
      `${bull} ` +
      (finalist.upcomingCatalyst ? `Catalyst ahead: ${finalist.upcomingCatalyst}. ` : "") +
      `Main risk: ${risk}`;
  }

  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0.5));
  const macroDriven = Boolean(parsed?.macro_driven);
  const horizon =
    typeof parsed?.horizon === "string" ? parsed.horizon.trim().slice(0, 50) : "3-5 day swing";

  // NOTE: the URL is deliberately NOT appended to the prose. It ships as
  // `primary_source_url`, and every surface that renders this write-up already
  // shows that as a real labelled link. Inlining it produced a wall of base64 in
  // the Pick-of-the-Day thesis whenever Gemini grounded the claim, because the
  // "URL" is then an opaque `vertexaisearch.../grounding-api-redirect/...` blob
  // rather than the publisher. The client also strips any that slip through -
  // see `stripSourceUrls` in src/lib/format.ts.
  return {
    ticker: finalist.ticker,
    writeUp,
    horizon,
    confidence,
    macroDriven,
  };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function runPipeline(
  providedUniverse: UniverseEntry[] | null,
): Promise<{
  picks: FinalCandidate[];
  marketDay: string;
  meta: Record<string, unknown>;
}> {
  const marketDay = marketDayKey();
  const meta: Record<string, unknown> = { marketDay, startedAt: new Date().toISOString(), pipeline: "analyst-grade-v2" };

  // --- Fetch universe and dedup list in parallel ---
  const [universe, recentPicks] = await Promise.all([
    providedUniverse
      ? Promise.resolve(providedUniverse)
      : fetchUniverseFromSupabase().catch((): UniverseEntry[] => []),
    fetchRecentPickedTickers().catch(() => new Set<string>()),
  ]);
  meta.universeSize = universe.length;
  const rawByTicker = new Map<string, any>(universe.map((u) => [u.ticker, u.rawSignal ?? null]));

  // --- Stage 0: positive-signal survivor selection ---
  let stage0Survivors = stage0Filter(universe, recentPicks);
  if (stage0Survivors.length < MIN_PICKS && recentPicks.size > 0) {
    const withoutDedup = stage0Filter(universe, new Set<string>());
    const before = stage0Survivors.length;
    stage0Survivors = mergeDistinctStage0(stage0Survivors, withoutDedup);
    meta.stage0DedupRelaxed = {
      before,
      after: stage0Survivors.length,
      reason: "Recent hero dedup left fewer than MIN_PICKS Stage-0 survivors; allowed recent names as emergency runners.",
    };
  }
  meta.stage0Survivors = stage0Survivors.map((s) => ({
    ticker: s.ticker,
    rsi: s.technical.rsi14,
    valScore: s.technical.valuationScore,
    ret1m: s.technical.return1M_pct,
    sector: s.rawSignal?.sector ?? "Unknown",
    capTier: capTierFromSignal(s.rawSignal),
    theme: themeFromSignal(s.rawSignal),
    setup: "(pre-classify)",
  }));

  if (stage0Survivors.length === 0) {
    return { picks: [], marketDay, meta: { ...meta, error: "Stage 0 produced no survivors — universe may be empty or all names failed the light junk gate" } };
  }

  // --- Stage 1: Gemini grounded catalyst check (top STAGE1_MAX_CANDIDATES survivors) ---
  const stage1Candidates = stage0Survivors.slice(0, STAGE1_MAX_CANDIDATES);
  const survivorsAfterStage1: SurvivorCandidate[] = [];

  for (const entry of stage1Candidates) {
    const technicalSummary =
      `RSI ${entry.technical.rsi14}, ${entry.technical.distFrom52wkHigh_pct}% below 52wk high, ` +
      `1M return ${entry.technical.return1M_pct}%, valuation score ${entry.technical.valuationScore}/100`;
    try {
      const result = await stage1GroundedScan(entry.ticker, technicalSummary);
      survivorsAfterStage1.push({
        ticker: entry.ticker,
        engineScore: entry.engineScore,
        technical: entry.technical,
        ...result,
      });
    } catch {
      // Stage 1 failure: keep the candidate with defaults (optimistic on catalyst).
      survivorsAfterStage1.push({
        ticker: entry.ticker,
        engineScore: entry.engineScore,
        technical: entry.technical,
        catalystAlreadyMovedPrice: false,
        upcomingCatalyst: null,
        fundamentalsImproving: false,
        primarySourceUrl: "",
        sourceDate: "",
      });
    }
  }

  // Drop names where the catalyst is already fully priced in.
  let finalists = survivorsAfterStage1.filter((s) => !s.catalystAlreadyMovedPrice);

  // Fallback: if Stage 1 drops everyone, use the non-filtered list (best effort).
  if (finalists.length === 0) {
    meta.stage1Warning = "All Stage 1 candidates flagged catalyst-already-moved; using best-effort list";
    finalists = survivorsAfterStage1;
  }

  // Guarantee a 2-3 candidate bench before the debate. Backfill from the best
  // remaining Stage-0 survivors - real, positively discussed names - and bias the
  // pads toward sector / cap-tier / theme contrast.
  const desiredInitialCount = Math.min(TARGET_PICKS, stage0Survivors.length);
  if (finalists.length < desiredInitialCount) {
    const excluded = new Set(finalists.map((f) => f.ticker));
    const selected = finalists.map((f) => f.ticker);
    const backfills = pickDiverseStage0Backfills(
      stage0Survivors,
      selected,
      excluded,
      desiredInitialCount,
      rawByTicker,
    );
    for (const entry of backfills) {
      finalists.push(fallbackSurvivorFromStage0(entry));
      excluded.add(entry.ticker);
    }
    if (backfills.length > 0) {
      meta.stage1Backfilled = backfills.map((entry) => ({
        ticker: entry.ticker,
        sector: entry.rawSignal?.sector ?? "Unknown",
        capTier: capTierFromSignal(entry.rawSignal),
        theme: themeFromSignal(entry.rawSignal),
      }));
    }
  }

  meta.stage1Finalists = finalists.map((f) => ({
    ticker: f.ticker,
    upcomingCatalyst: f.upcomingCatalyst,
    fundamentalsImproving: f.fundamentalsImproving,
    catalystAlreadyMoved: f.catalystAlreadyMovedPrice,
  }));

  if (finalists.length === 0) {
    return { picks: [], marketDay, meta: { ...meta, error: "No finalists after Stage 1" } };
  }

  // --- Stage 2: Groq technical classification (per finalist, serialized to avoid rate limits) ---
  const techClassifications: TechClassification[] = [];
  for (let i = 0; i < finalists.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));
    try {
      techClassifications.push(await stage2TechnicalClassify(finalists[i].technical));
    } catch {
      techClassifications.push({
        ticker: finalists[i].ticker,
        setup: "NEUTRAL",
        twoSentenceRead: "(Technical classification unavailable.)",
      });
    }
  }
  meta.stage2Classifications = techClassifications.map((c) => ({ ticker: c.ticker, setup: c.setup }));

  // Drop EXTENDED picks (already ran), but do not let this stage collapse the
  // day below the 2-pick floor. This was the dangerous path: one non-EXTENDED
  // finalist was previously considered "enough", so only one row could upsert.
  const knownExtended = new Set(
    finalists
      .filter((_, i) => techClassifications[i]?.setup === "EXTENDED")
      .map((f) => f.ticker),
  );
  const nonExtended = finalists.filter((f) => !knownExtended.has(f.ticker));
  let activeFinalists = nonExtended.length > 0 ? [...nonExtended] : [...finalists];
  const desiredActiveCount = Math.min(TARGET_PICKS, stage0Survivors.length);
  if (activeFinalists.length < desiredActiveCount) {
    const excluded = new Set(activeFinalists.map((f) => f.ticker));
    for (const ticker of knownExtended) excluded.add(ticker);
    const backfills = pickDiverseStage0Backfills(
      stage0Survivors,
      activeFinalists.map((f) => f.ticker),
      excluded,
      desiredActiveCount,
      rawByTicker,
    );
    for (const entry of backfills) {
      activeFinalists.push(fallbackSurvivorFromStage0(entry));
      excluded.add(entry.ticker);
    }
    if (backfills.length > 0) {
      meta.stage2Backfilled = backfills.map((entry) => ({
        ticker: entry.ticker,
        sector: entry.rawSignal?.sector ?? "Unknown",
        capTier: capTierFromSignal(entry.rawSignal),
        theme: themeFromSignal(entry.rawSignal),
      }));
    }
  }
  // Last-resort floor: if every diverse non-extended backup is unavailable, allow
  // the least-bad Stage-0 name rather than shipping a single pick. This should be
  // rare on the daily board, but it makes the MIN_PICKS contract explicit.
  if (activeFinalists.length < MIN_PICKS) {
    const excluded = new Set(activeFinalists.map((f) => f.ticker));
    const emergency = pickDiverseStage0Backfills(
      stage0Survivors,
      activeFinalists.map((f) => f.ticker),
      excluded,
      Math.min(MIN_PICKS, stage0Survivors.length),
      rawByTicker,
    );
    for (const entry of emergency) {
      activeFinalists.push(fallbackSurvivorFromStage0(entry));
      excluded.add(entry.ticker);
    }
    if (emergency.length > 0) {
      meta.stage2EmergencyBackfilled = emergency.map((entry) => entry.ticker);
    }
  }
  const activeTechClass = activeFinalists.map((f) =>
    techClassifications.find((tc) => tc.ticker === f.ticker) ??
      fallbackTechClassification(f.ticker, f.technical, rawByTicker.get(f.ticker))
  );
  meta.stage2ExtendedDropped = finalists.length - nonExtended.length;

  // --- Stage 3: Bull/Bear/Skeptic debate (per finalist, serialized) ---
  const debateResults: DebateResult[] = [];
  for (let i = 0; i < activeFinalists.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));
    try {
      debateResults.push(await stage3Debate(activeFinalists[i], activeTechClass[i]));
    } catch {
      debateResults.push({
        ticker: activeFinalists[i].ticker,
        bullCase: "(unavailable)",
        bearCase: "(unavailable)",
        skepticNote: "(unavailable)",
        verdict: "PASS",
        biggestRisk: "",
        invalidationLevel: "",
      });
    }
  }
  meta.stage3Verdicts = debateResults.map((d) => ({ ticker: d.ticker, verdict: d.verdict }));

  // Rank: prefer BUY-verdict + BASE-BUILDING or OVERSOLD-REVERSAL setup + pending catalyst.
  function rankFinalist(i: number): number {
    const f = activeFinalists[i];
    const tc = activeTechClass[i];
    const dr = debateResults[i];
    let pts = f.engineScore * 0.3;
    if (dr.verdict === "BUY") pts += 40;
    if (tc.setup === "BASE-BUILDING") pts += 25;
    else if (tc.setup === "OVERSOLD-REVERSAL") pts += 20;
    else if (tc.setup === "NEUTRAL") pts += 10;
    // EXTENDED: 0 bonus (already filtered, but in fallback)
    if (f.upcomingCatalyst) pts += 20;
    if (f.fundamentalsImproving) pts += 10;
    if (f.technical.valuationScore > 60) pts += 10;
    return pts;
  }

  const ranked = activeFinalists
    .map((_, i) => ({ i, score: rankFinalist(i) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);

  // VARIABLE COUNT 2-4 (never 1) with real variety. The hero is the highest ranked
  // setup; #2/#3 prefer strong names that add a different sector, cap tier, or theme.
  // #4 is optional and still has to clear the worthiness bar.
  const heroIdx = ranked[0]!;
  const heroScore = rankFinalist(heroIdx);
  const selected: number[] = [heroIdx];

  const targetPickCount = Math.min(TARGET_PICKS, activeFinalists.length);
  while (selected.length < MAX_PICKS) {
    const required = selected.length < Math.max(MIN_PICKS, targetPickCount);
    const selectedTickers = selected.map((i) => activeFinalists[i]!.ticker);
    const pool = ranked
      .filter((i) => !selected.includes(i))
      .map((i) => {
        const score = rankFinalist(i);
        const ticker = activeFinalists[i]!.ticker;
        return {
          i,
          score,
          adjusted: score + diversityBonus(ticker, selectedTickers, rawByTicker),
        };
      })
      .filter((item) => required || (item.score >= RUNNER_WORTHY_MIN && item.score >= heroScore * 0.55));

    if (pool.length === 0) break;
    pool.sort((a, b) => b.adjusted - a.adjusted);
    selected.push(pool[0]!.i);
  }
  const pickIndices = selected.slice(0, MAX_PICKS);
  meta.pickCount = pickIndices.length;
  meta.stage3Selected = pickIndices.map((i) => ({
    ticker: activeFinalists[i].ticker,
    rankScore: rankFinalist(i),
    verdict: debateResults[i].verdict,
    setup: activeTechClass[i].setup,
    diversity: diversityProfile(rawByTicker.get(activeFinalists[i].ticker)),
  }));

  // --- Stage 4: Gemini write-up (selected picks, serialized) ---
  const writeUps: WriteUp[] = [];
  for (const idx of pickIndices) {
    try {
      const wu = await stage4WriteUp({
        ticker: activeFinalists[idx].ticker,
        technical: activeFinalists[idx].technical,
        techClass: activeTechClass[idx],
        debate: debateResults[idx],
        upcomingCatalyst: activeFinalists[idx].upcomingCatalyst,
        primarySourceUrl: activeFinalists[idx].primarySourceUrl,
        sourceDate: activeFinalists[idx].sourceDate,
      });
      writeUps.push(wu);
    } catch {
      writeUps.push({
        ticker: activeFinalists[idx].ticker,
        writeUp:
          `${activeFinalists[idx].ticker} — ${activeTechClass[idx].setup} setup. ` +
          `${activeTechClass[idx].twoSentenceRead} ` +
          `Pending catalyst: ${activeFinalists[idx].upcomingCatalyst ?? "None confirmed"}. ` +
          `Source: ${activeFinalists[idx].primarySourceUrl}`,
        horizon: "3-5 day swing",
        confidence: 0.5,
        macroDriven: false,
      });
    }
  }

  // Assemble final candidates.
  const finalCandidates: FinalCandidate[] = pickIndices.map((idx, rank) => {
    const f = activeFinalists[idx];
    const tc = activeTechClass[idx];
    const dr = debateResults[idx];
    const wu = writeUps[rank] ?? {
      ticker: f.ticker,
      writeUp: "",
      horizon: "3-5 day swing",
      confidence: 0.5,
      macroDriven: false,
    };
    return {
      ticker: f.ticker,
      engineScore: f.engineScore,
      setup: tc.setup,
      verdict: dr.verdict,
      confidence: wu.confidence,
      horizonDays: parsHorizonDays(wu.horizon),
      // Show the rich Stage-4 write-up (the "why this is worth looking at" story),
      // not the bare "next earnings date" string. Fall back to the upcoming catalyst
      // then the technical read only if the write-up didn't come back.
      catalystSummary:
        wu.writeUp && wu.writeUp.trim().length > 40
          ? wu.writeUp.trim()
          : (f.upcomingCatalyst ?? activeTechClass[idx].twoSentenceRead),
      primarySourceUrl: f.primarySourceUrl,
      bullCase: dr.bullCase,
      bearCase: dr.bearCase,
      skepticNote: dr.skepticNote,
      biggestRisk: dr.biggestRisk,
      invalidationLevel: dr.invalidationLevel,
      writeUp: wu.writeUp,
      macroDriven: wu.macroDriven,
    };
  });

  meta.finalCandidates = finalCandidates.map((c) => ({
    ticker: c.ticker,
    setup: c.setup,
    verdict: c.verdict,
    engineScore: c.engineScore,
  }));

  return { picks: finalCandidates, marketDay, meta };
}

function parsHorizonDays(horizon: string): number {
  const m = horizon.match(/(\d+)/);
  return m ? Math.min(5, Math.max(1, parseInt(m[1], 10))) : 3;
}

// ---------------------------------------------------------------------------
// Deno.serve entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method === "GET") {
    return json({
      ok: true,
      geminiKeys: GEMINI_KEYS.length,
      groqKeys: LLM_KEYS.length,
      model: LLM_MODEL,
      pipeline: "analyst-grade-v2",
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Parse optional body.
  let providedUniverse: UniverseEntry[] | null = null;
  try {
    const body = await req.json().catch(() => null);
    if (Array.isArray(body?.universe) && body.universe.length > 0) {
      providedUniverse = (body.universe as any[])
        .filter((u: any) => typeof u?.ticker === "string")
        .map((u: any) => ({
          ticker: String(u.ticker).toUpperCase().trim(),
          engineScore: typeof u.engineScore === "number" ? u.engineScore : 50,
          pumpRisk: typeof u.pumpRisk === "number" ? u.pumpRisk : 0,
          rawSignal: u.rawSignal ?? null,
        }));
    }
  } catch {
    /* no body is fine */
  }

  try {
    const { picks, marketDay, meta } = await runPipeline(providedUniverse);

    if (picks.length === 0) {
      return json({ ok: false, marketDay, picks: [], meta }, 200);
    }

    // Map to AiPickRow for upsert.
    // engine_score = the candidate's real opportunityScore (from s.score.opportunityScore).
    // final_score = engine_score (the UI displays this; pipeline RANKS/SELECTS, engine SCORES).
    // judge_score is kept for schema compatibility but mirrors engine_score here.
    const rows: AiPickRow[] = picks.map((p, rank) => ({
      market_day: marketDay,
      rank,
      ticker: p.ticker,
      final_score: Math.round(p.engineScore * 100) / 100,
      engine_score: Math.round(p.engineScore * 100) / 100,
      judge_score: Math.round(p.engineScore * 100) / 100, // schema compat
      confidence: Math.round(p.confidence * 1000) / 1000,
      horizon_days: p.horizonDays,
      catalyst_summary: p.catalystSummary,
      catalyst_type: p.setup,            // store setup class in catalyst_type column
      primary_source_url: p.primarySourceUrl,
      bull_case: p.bullCase,
      bear_case: p.bearCase,
      // Compose skeptic_note with invalidation level for the UI to display.
      skeptic_note:
        p.skepticNote +
        (p.invalidationLevel ? `\n\nInvalidation: ${p.invalidationLevel}` : ""),
      macro_driven: p.macroDriven,
    }));

    let upsertError: string | null = null;
    try {
      await upsertPicks(rows);
    } catch (e) {
      upsertError = String(e);
    }

    return json({
      ok: !upsertError,
      marketDay,
      hero: picks[0]?.ticker ?? null,
      runnersUp: picks.slice(1).map((p) => p.ticker),
      picks: rows,
      meta: { ...meta, upsertError },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai-pick] fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});
