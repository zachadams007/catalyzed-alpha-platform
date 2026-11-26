// Supabase Edge Function: research-agent
//
// AI research lane for Catalyzed Alpha. The desktop client posts a
// narrative/ticker/task; this function asks an LLM (server-side, where the key
// is safe) and returns the `ResearchIntel` contract the app expects. The app
// renders the STRUCTURED result (ticker suggestions, themes, catalysts) into its
// card UI - this is AI-*assisted* discovery, never a chat dump.
//
// TWO provider modes (configure whichever free key you have - see README):
//   • Gemini - Google AI Studio FREE tier WITH `google_search` grounding
//               (best for fresh, news-driven discovery). Secret: GEMINI_API_KEY
//               (+ optional GEMINI_API_KEY_BACKUP - auto-failover on quota/error)
//   • OpenAI-compatible - any endpoint that speaks the OpenAI Chat Completions
//               API: Groq, NVIDIA NIM, OpenRouter, Together, etc. (fast, generous
//               free tiers; NOT web-grounded). Secrets: LLM_API_KEY, LLM_BASE_URL,
//               LLM_MODEL.
//
// If both are set, RESEARCH_PROVIDER picks the primary ("gemini" | "openai");
// the other is used as automatic fallback. EVERY upstream call is bounded by a
// hard timeout so this function can NEVER hang - it always returns within
// ~UPSTREAM_TIMEOUT_MS per provider, so the client never freezes on a dead model.
//
// Discovery/research only - the system prompt forbids buy/sell advice.

// deno-lint-ignore-file no-explicit-any

import { shouldFailover } from "../_shared/failover.ts";

// --- Gemini (grounded) ------------------------------------------------------
/** De-duped key pool from env var names (priority order). */
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
// ROUND-ROBIN Gemini key pool. Each request STARTS on the next key (spreads the
// small free-tier daily quota across all accounts so none exhausts), then fails
// over through the rest on a quota/overload (503) signal. Keys 3/4 are the extra
// AI Studio accounts. The OpenAI-compatible lane (LLM_*, e.g. Groq) is the final
// fallback when the whole Gemini pool is spent.
const GEMINI_KEYS = envPool([
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_BACKUP",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
]);
// Round-robin cursor + per-key counters (module-level; reset on cold start;
// surfaced read-only via GET /_status). No secret values stored.
let geminiCursor = 0;
const geminiStats: Array<{
  calls: number;
  ok: number;
  failovers: number;
  lastStatus: number | null;
}> = GEMINI_KEYS.map(() => ({ calls: 0, ok: 0, failovers: 0, lastStatus: null }));
// Default to gemini-2.5-flash: grounded, generous free quota, supports
// google_search. Override with RESEARCH_MODEL env var - e.g. gemini-2.5-pro
// for higher-quality synthesis (lower free quota).
// NOTE: gemini-2.0-flash was shut down June 1, 2026 - do not revert.
const GEMINI_MODEL = Deno.env.get("RESEARCH_MODEL") ?? "gemini-2.5-flash";

const FINNHUB_KEYS = envPool([
  "FINNHUB_API_KEY",
  "FINNHUB_API_KEY_2",
  "FINNHUB_API_KEY_3",
  "FINNHUB_API_KEY_4",
  "FINNHUB_API_KEY_5",
  "FINNHUB_API_KEY_6",
  "FINNHUB_API_KEY_7",
]);

// --- OpenAI-compatible LLM pool (Groq / NVIDIA NIM / OpenRouter / Together / …) -
// ROUND-ROBIN key pool, same pattern as the Gemini pool above: every Groq call
// STARTS on the next key and fails over through the rest on a 429 / rate-limit /
// overload. Groq's free tier is tokens-PER-MINUTE limited, so the desk's bursty
// Bull + Bear + Judge sequence (3 calls back-to-back) used to 429 on a single key;
// pooling 4 keys spreads that burst so the desk stops stalling. Reads LLM_API_KEY
// plus LLM_API_KEY_2/3/4, and also splits a single comma/space-separated
// LLM_API_KEY into multiple keys.
const LLM_KEYS = (() => {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const entry of envPool(["LLM_API_KEY", "LLM_API_KEY_2", "LLM_API_KEY_3", "LLM_API_KEY_4"])) {
    for (const k of entry.split(/[,\s]+/).map((s) => s.trim())) {
      if (k && !seen.has(k)) {
        seen.add(k);
        expanded.push(k);
      }
    }
  }
  return expanded;
})();
// Convenience: the first key + an "is the OpenAI lane configured at all" flag.
// Many readiness checks just need pool-non-empty, which this preserves.
const LLM_API_KEY = LLM_KEYS[0] ?? "";
// e.g. https://api.groq.com/openai/v1 · https://integrate.api.nvidia.com/v1 ·
//      https://openrouter.ai/api/v1
const LLM_BASE_URL = (Deno.env.get("LLM_BASE_URL") ?? "").replace(/\/+$/, "");
// e.g. openai/gpt-oss-120b (Groq) · meta/llama-3.1-70b-instruct (NVIDIA) ·
//      deepseek/deepseek-chat (OpenRouter)
//
// MODEL DECOMMISSIONING (2026-09-03). This was deployed as
// `llama-3.3-70b-versatile`, which Groq has since RETIRED - it answers
// 404 `model_not_found` on every key, so the entire OpenAI-compatible fallback
// lane was dead. Combined with Gemini's small free-tier quota, that is exactly
// what surfaced in the app as Blueprint's "AI web search didn't complete -
// Research service unavailable (server 503)": the primary was out of quota and
// the backup could not run at all.
//
// A model name is therefore treated as PERISHABLE. `LLM_MODEL_CHAIN` below is
// tried in order and a 404/400 `model_not_found` advances permanently to the
// next candidate, so the next retirement degrades instead of going dark.
const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "openai/gpt-oss-120b";

/** Known-good current Groq models, newest-capable first. Only consulted when the
 *  configured model is refused as non-existent. Verified live 2026-09-03. */
const LLM_MODEL_FALLBACKS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"];
const LLM_MODEL_CHAIN = [LLM_MODEL, ...LLM_MODEL_FALLBACKS.filter((m) => m !== LLM_MODEL)];
/** Index into LLM_MODEL_CHAIN. Advances (never resets) when a model is retired. */
let llmModelIdx = 0;
/** The model actually in use right now - reported by /_status. */
function activeLlmModel(): string {
  return LLM_MODEL_CHAIN[llmModelIdx] ?? LLM_MODEL;
}
/** True when an upstream body says the MODEL (not the key) is the problem. */
function isModelRetired(status: number, body: string): boolean {
  if (status !== 404 && status !== 400) return false;
  const b = body.toLowerCase();
  return b.includes("model_not_found") || b.includes("does not exist");
}
// Round-robin cursor + per-key counters for the Groq pool (module-level; reset on
// cold start; surfaced read-only via GET /_status). No secret values stored.
let groqCursor = 0;
const groqStats: Array<{
  calls: number;
  ok: number;
  failovers: number;
  lastStatus: number | null;
}> = LLM_KEYS.map(() => ({ calls: 0, ok: 0, failovers: 0, lastStatus: null }));

// Which provider leads when more than one is configured. "auto" prefers the
// grounded Gemini path (fresher results) and falls back to the OpenAI lane.
const RESEARCH_PROVIDER = (Deno.env.get("RESEARCH_PROVIDER") ?? "auto").toLowerCase();

// Hard per-provider upstream timeout. Keeps total wall time bounded so the
// client's request always settles instead of hanging on a slow/dead model.
//
// RAISED 20s → 45s (2026-09-03). 20s was BELOW the honest cost of the work: a
// grounded `gemini-2.5-flash` call with google_search routinely runs past it, so
// the abort fired mid-answer and the deployed desk returned
// `gemini: The signal has been aborted` - surfacing in Blueprint as
// "AI web search didn't complete - Research service unavailable". We were
// timing out our own primary provider and calling it an outage.
//
// 45s is still comfortably inside BOTH the Supabase edge wall-clock limit and
// the client's 120s budget in researchAgent.ts, so a genuinely dead upstream
// still settles as an error rather than hanging.
const UPSTREAM_TIMEOUT_MS = Number(Deno.env.get("UPSTREAM_TIMEOUT_MS") ?? "45000");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

// ---------------------------------------------------------------------------
// PERSISTENT, CROSS-USER usage tracking (migration 0020_api_usage_daily.sql).
//
// Mirror of market-proxy's recorder: the /_status counters are in-memory and reset
// on cold start, so they can't show the TRUE pooled daily usage across everyone.
// This records each Gemini/Groq key call into the durable `api_usage_daily` table
// via the SECURITY DEFINER `bump_api_usage` RPC, labeled by the key INDEX
// (`key_1`..`key_N`) - never the key value.
//
// HARD SAFETY CONTRACT: fire-and-forget (never awaited in the research path), fully
// try/catch-wrapped with a .catch() on the promise, silently swallows every failure
// (including the RPC not existing yet, before the lead applies 0020). It can never
// slow or break a research call.
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/** Fire-and-forget durable usage increment. Returns immediately; never throws. */
function recordUsage(vendor: string, keyIndex: number, ok: boolean): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return; // not wired → skip silently
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_api_usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_vendor: vendor, p_key_label: `key_${keyIndex + 1}`, p_ok: ok }),
    }).catch(() => {});
  } catch {
    /* never let usage tracking break research */
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface AgentRequest {
  ticker?: string;
  companyName?: string;
  narrative?: string;
  themes?: string[];
  task?: "deep_research" | "theme_expand" | "discover" | "price_targets" | "catalyst_scan";
}

interface Citation {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

interface ProviderResult {
  text: string;
  citations: Citation[];
  model: string;
}

const SYSTEM_PROMPT = `You are a financial RESEARCH assistant for a discovery tool.
Gather up-to-date, factual context about the user's stock/theme query.
Rules:
- Research and synthesis ONLY. Never give buy/sell/hold advice or price predictions.
- Prefer recent, reputable sources (company filings, major outlets, analyst coverage).
- Always include citations with real URLs you actually used.
- When suggesting stocks, ONLY return REAL companies currently listed on a major U.S.
  exchange (NYSE / Nasdaq). Verify each ticker symbol is correct and active.
  Never invent tickers or companies. If unsure a ticker is real, omit it.
Respond with ONLY a single STRICT JSON object (no markdown, no code fences) matching:
{
  "ticker": string|null,
  "summary": string,
  "bullPoints": string[],
  "bearPoints": string[],
  "themes": string[],
  "suggestions": [{"ticker": string, "name": string, "rationale": string}],
  "sentiment": number,            // -1..1
  "citations": [{"title": string, "url": string, "source": string, "publishedAt": string}]
}`;

function buildUserPrompt(req: AgentRequest, factsBlock?: string): string {
  if (req.task === "theme_expand") {
    return `Expand this investing narrative into 8-16 specific, searchable theme keywords (technologies, sub-sectors, catalysts) and a 2-3 sentence factual context with citations. Leave "suggestions" empty.
Narrative: ${req.narrative ?? ""}
Existing themes: ${(req.themes ?? []).join(", ")}`;
  }
  if (req.task === "discover") {
    return `Find 8-12 REAL, currently U.S.-exchange-listed stocks (NYSE/Nasdaq) that best fit this investing narrative. Strongly favor less-obvious, smaller/emerging, high-volatility names with genuine catalyst or hype potential over well-known mega-caps — but every ticker MUST be real and currently listed. For each, return the exact ticker, the company name, and a one-sentence rationale grounded in a recent catalyst, news item, or theme fit. Put them in "suggestions". Also give a 2-3 sentence "summary" of the theme and "citations" for the sources you used.
Narrative: ${req.narrative ?? ""}
Themes: ${(req.themes ?? []).join(", ")}`;
  }
  // deep_research - a full grounded analyst brief (the Research Desk). Ask for
  // CURRENT, cited coverage across news + catalysts + insider/institutional flow,
  // staying inside the strict JSON schema in SYSTEM_PROMPT.
  const subject = `${req.companyName ?? ""} ${req.ticker ? `(${req.ticker})` : ""}`.trim() || (req.ticker ?? "this company");
  return `${factsBlock ? factsBlock + "\n\n" : ""}Act as a sell-side equity research analyst and write a CURRENT, grounded brief on ${subject}.${
    req.narrative ? ` Angle to weigh: ${req.narrative}.` : ""
  }
Use Google Search to gather the FRESHEST facts (today's date matters — prefer the last 2-4 weeks). This goes BEYOND fundamentals: surface the same catalyst signals a market terminal would, for THIS ticker. Cover:
  - "summary": 2-4 sentences. START with ONE plain-English sentence on what the company actually does (its business, main products/services, how it makes money) so a first-time reader instantly knows the stock — THEN the thesis: where the company is right now and what is moving the stock.
  - "bullPoints" (3-5) and "bearPoints" (3-5): each a SPECIFIC, DATED item with its own citation — recent NEWS headlines; EARNINGS results/guidance; product/CLINICAL/FDA/regulatory catalysts; M&A; PARTNERSHIPS; CONTRACT/government awards; INSIDER & CONGRESS buys (bull) or sells (bear); analyst rating/target changes; dilution/offerings (bear); and any clear SENTIMENT SHIFT (social/analyst tone turning). Lead each point with the date.
  - POLITICAL / MACRO CATALYSTS — RUN A DEDICATED SEARCH for this, do NOT skip it: explicitly look up whether the U.S. President, a Cabinet/agency head, the Fed Chair, or any named member of Congress has BOUGHT or SOLD this stock (check the latest OGE Form 278-T / executive-branch and congressional financial disclosures, e.g. "Trump [TICKER] stock disclosure", "[member] [TICKER] trade"), or has NAMED, praised, criticized, or set policy on THIS company or its sector (tariffs/sanctions, executive orders, government contracts/awards, antitrust/probes, subsidies, a public callout). These are HIGH-IMPORTANCE and must be surfaced explicitly with the DATE and, for a trade, the disclosed dollar range or price. Put FAVORABLE actions (a disclosed BUY, praise, contract win, subsidy, friendly policy) in bullPoints and ADVERSE ones (tariff/sanction threat, probe, criticism, unfavorable policy) in bearPoints. Get the DIRECTION right — a tariff threat is bearish even though it is "attention." Disclosed congressional/insider/executive BUYS are bullish; material clustered SELLS are bearish. (Concrete examples of the CLASS to catch: a President's disclosed purchase of a stock, a Congress member's options trade, a Fed policy shift hitting a sector.)
  - "themes" (3-8): the live catalysts / sub-sectors in play.
  - "sentiment": net read in -1..1 reflecting the current tone.
  - QUANTIFY EVERYTHING YOU CAN. A point without its number is not research, it is a
    rumour with a date. If the source states a figure, the point MUST carry it:
      • money — the actual amount and the unit ("$300B", not "billions"; "$38B over 10 years", not "a large deal");
      • contracts/partnerships — counterparty, total value, term length, and start date;
      • balance sheet — debt, cash, remaining performance obligations / backlog, and interest cover, each as a number;
      • capex / spending — the disclosed figure and the period it covers, not "heavy spending";
      • guidance & estimates — old vs new value, and the % change;
      • analyst actions — the firm, the old and new rating or target, and the date.
    Where the company discloses a forward number that contradicts the market's fear
    (a growing order book against a falling price, contracted revenue against a debt
    worry), state BOTH numbers side by side — that contrast is the single most useful
    thing this brief can surface.
    If a figure genuinely is not disclosed anywhere you searched, write the point as
    "not disclosed" rather than reaching for a vague quantifier. Never write "billions",
    "hundreds of millions", "significant", "massive", or "substantial" in place of a
    number you could have looked up.
Keep each point to one tight sentence. Every nontrivial claim must trace to a citation; if you cannot ground a fact in a retrieved source, OMIT it rather than guess. Do not give buy/sell advice. Leave "suggestions" empty.`;
}

/**
 * STEP 2 of the 2-step desk: turn the grounded analyst's free-form research notes
 * into the strict JSON schema. The structurer (Groq, json_object mode) has NO web
 * access, so it must ONLY reorganize what the grounded step already found - never
 * add facts or sources. Citations are forced to the real retrieved URLs by the
 * caller, so the structurer can't fabricate sources. This exists because Gemini's
 * google_search lane can't emit forced JSON (HTTP 400) and its prose-wrapped JSON
 * parses unreliably - so we research with one call and structure with another.
 */
function buildStructurePrompt(researchText: string, subject: string, groundedUrls: string[]): string {
  return `A grounded equity-research analyst just produced the RESEARCH NOTES below about ${subject}, using live web search. Reorganize them into the strict JSON schema. Rules:
- Use ONLY facts present in the notes — do NOT add, infer, or invent anything (no fact not in the notes, no source not listed below).
- PRESERVE every concrete catalyst: dated news, earnings/guidance, FDA/clinical, M&A, contracts, ANALYST rating/target changes, and especially INSIDER / CEO / CONGRESS / PRESIDENTIAL buys or sells — include the SHARE PRICE or dollar amount they transacted at when the notes state it.
- POLITICAL / MACRO items (President, Fed, Cabinet, named member of Congress naming/buying/acting on this company or its sector) are HIGH-IMPORTANCE: put favorable ones in bullPoints, adverse ones (tariff/probe/criticism) in bearPoints — direction matters.
- Capture any SENTIMENT SHIFT (analyst/social tone turning) the notes mention.
- Each bull/bear point: ONE tight sentence, led by its date. "summary": 2-4 sentences that START with one plain sentence on what the company does (so a first-time reader knows the stock), then the thesis.
For "citations", use ONLY these source URLs actually retrieved (keep their order; pick the most relevant):
${groundedUrls.slice(0, 12).map((u) => `- ${u}`).join("\n")}

RESEARCH NOTES:
${researchText.slice(0, 12000)}`;
}

// ---------------------------------------------------------------------------
// BULL / BEAR / JUDGE debate - the Research Desk's "brain".
//
// The single grounded read tells you what's happening; a debate tells you what it
// MEANS. Over the grounded research notes (never the model's stale memory), a Bull
// analyst argues the strongest case FOR, a Bear analyst the strongest case AGAINST
// (both on Groq, in parallel), then an impartial Judge weighs them against the notes
// + the verified facts and renders a structured verdict (stance, confidence, the
// surviving bull/bear points, key catalysts, key risks). This is the structuring
// step for the desk - it replaces the plain structurer with an adversarial one that
// surfaces the catalysts (insider/CEO/political buys, sentiment shifts) the owner cares
// about and weighs both sides. Falls back to the plain structurer if any leg fails.
// ---------------------------------------------------------------------------

/** Generic Groq/OpenAI-compatible call with a CUSTOM system prompt (the debate roles).
 *  Round-robins the LLM key pool and fails over to the next key on a 429 / rate-limit /
 *  overload (or a network/timeout), so the desk's bursty Bull + Bear + Judge calls
 *  don't all pile onto one tokens-per-minute-limited key. A HARD error (e.g. 400) is
 *  thrown immediately - retrying it on every key would just repeat the failure. */
async function callGroq(system: string, user: string, jsonMode: boolean): Promise<string> {
  const n = LLM_KEYS.length;
  if (n === 0) throw new Error("No LLM key configured");
  // Rebuilt per attempt: a retired model advances `llmModelIdx` mid-flight, and
  // the retry must carry the NEW model name.
  const buildBody = () =>
    JSON.stringify({
      model: activeLlmModel(),
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
  let body = buildBody();
  const start = groqCursor % n;
  groqCursor = (start + 1) % n;
  let lastErr: unknown = null;
  for (let i = 0; i < n; i++) {
    const ki = (start + i) % n;
    const isLast = i === n - 1;
    groqStats[ki].calls++;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEYS[ki]}` },
        body,
      });
    } catch (e) {
      groqStats[ki].lastStatus = -1;
      recordUsage("groq", ki, false);
      lastErr = e;
      if (isLast) throw e;
      groqStats[ki].failovers++;
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      groqStats[ki].ok++;
      groqStats[ki].lastStatus = 200;
      recordUsage("groq", ki, true);
      return data?.choices?.[0]?.message?.content ?? "";
    }
    const detail = await res.text().catch(() => "");
    groqStats[ki].lastStatus = res.status;
    recordUsage("groq", ki, false);
    // A RETIRED MODEL is not a key problem - every key would fail identically,
    // and the old code threw immediately, taking the whole fallback lane down
    // for good. Advance to the next candidate model and retry THIS key instead.
    if (isModelRetired(res.status, detail) && llmModelIdx < LLM_MODEL_CHAIN.length - 1) {
      console.warn(
        `[research-agent] model "${activeLlmModel()}" retired upstream (${res.status}); ` +
          `falling forward to "${LLM_MODEL_CHAIN[llmModelIdx + 1]}"`,
      );
      llmModelIdx++;
      body = buildBody();
      i--; // retry the same key with the new model; don't burn a failover slot
      continue;
    }
    if (shouldFailover(res.status, detail) && !isLast) {
      groqStats[ki].failovers++;
      lastErr = new Error(`Groq ${res.status} ${detail.slice(0, 120)}`);
      continue;
    }
    throw new Error(`Groq ${res.status} ${detail.slice(0, 200)}`);
  }
  throw lastErr ?? new Error("Groq pool exhausted");
}

const BULL_SYS =
  `You are the BULL-side analyst in a sell-side investment debate. Using ONLY the research notes provided, argue the STRONGEST evidence-based case FOR the stock. Lead with a one-sentence bull thesis, then 4-6 specific, DATED points (recent catalysts, earnings/guidance beats, product/clinical/contract wins, INSIDER/CEO/CONGRESS/PRESIDENTIAL buys WITH the price or $ amount, favorable policy, positive sentiment shifts). No hedging, no buy/sell advice — make the bull argument. Do not invent anything not in the notes. EVERY point must carry its NUMBER when the notes contain one: dollar amounts with the unit ("$38B over 10 years", never "billions"), contract term and counterparty, debt and backlog/remaining-performance-obligation figures, capex with the period it covers, old-vs-new guidance or price targets with the firm and date. A point that could have carried a figure and does not is a weak point - either find the number in the notes or say "not disclosed". Never substitute "billions", "significant", "massive" or "substantial" for a figure present in the notes.`;
const BEAR_SYS =
  `You are the BEAR-side analyst in a sell-side investment debate. Using ONLY the research notes provided, argue the STRONGEST evidence-based case AGAINST the stock. Lead with a one-sentence bear thesis, then 4-6 specific, DATED points (misses/guidance cuts, dilution/offerings, material insider/cluster SELLS, regulatory/legal/antitrust risk, adverse policy/tariffs, valuation stretch, negative sentiment shifts). No hedging, no buy/sell advice — make the bear argument. Do not invent anything not in the notes. EVERY point must carry its NUMBER when the notes contain one: dollar amounts with the unit ("$38B over 10 years", never "billions"), contract term and counterparty, debt and backlog/remaining-performance-obligation figures, capex with the period it covers, old-vs-new guidance or price targets with the firm and date. A point that could have carried a figure and does not is a weak point - either find the number in the notes or say "not disclosed". Never substitute "billions", "significant", "massive" or "substantial" for a figure present in the notes.`;
const JUDGE_SYS =
  'You are the impartial JUDGE (a portfolio manager) closing an investment debate. Weigh the BULL and BEAR arguments against the research notes and the verified facts; reward the better-EVIDENCED side, not the louder one. Respond with ONLY a strict JSON object: {"ticker":string|null,"summary":string (2-3 sentence synthesis stating where it nets out and WHY),"stance":"bullish"|"bearish"|"mixed","confidence":number (0-100),"bullPoints":string[] (the surviving bull points, dated),"bearPoints":string[] (the surviving bear points, dated),"keyCatalysts":string[] (the specific upcoming/recent catalysts that matter most),"keyRisks":string[],"themes":string[],"sentiment":number (-1..1)}. Never give buy/sell advice or price targets. Do not invent facts not supported by the notes. You MUST commit to a stance. "mixed" is reserved for the case where the bull and bear evidence is genuinely of comparable weight - it is NOT the safe default, and it is NOT what you return when you are merely uncertain. Uncertainty belongs in "confidence" (return a LOW confidence with a real directional stance), never in a refusal to call it. When the disclosed forward evidence (order book, contracted revenue, guidance, estimates) points one way while recent price action and sentiment point the other, say so explicitly in the summary and let the better-EVIDENCED side set the stance. Carry the actual figures from the notes into every surviving point and into the summary - a verdict that says "heavy spending" where the notes say "$35B of capex" has destroyed the only thing that made it useful.';

interface DebateResult {
  parsed: any;
  debate: {
    bull: string;
    bear: string;
    stance?: string;
    confidence?: number;
    keyCatalysts: string[];
    keyRisks: string[];
  };
  model: string;
}

/**
 * Run the Bull/Bear/Judge debate over grounded research notes. Bull + Bear argue in
 * parallel (cheap Groq), then the Judge synthesizes a structured verdict. Returns
 * null if the Judge's JSON can't be parsed (caller falls back to the plain structurer).
 */
async function runDebate(
  notes: string,
  subject: string,
  groundedUrls: string[],
  groundTruth: GroundTruth | null,
): Promise<DebateResult | null> {
  const notesBlock = notes.slice(0, 11000);
  const factsLine = groundTruth
    ? `Verified facts (authoritative — do not contradict): ${subject} is ${groundTruth.profitability}` +
      (groundTruth.price ? `, last price ${groundTruth.price}` : "") +
      // `marketCapB` is BILLIONS USD (there is no `marketCap` on GroundTruth -
      // reading the wrong name silently omitted the cap from the verified-facts
      // line entirely, so the debate never saw the company's size).
      (groundTruth.marketCapB ? `, market cap $${groundTruth.marketCapB}B` : "") +
      "."
    : "";

  const [bull, bear] = await Promise.all([
    callGroq(BULL_SYS, `Subject: ${subject}\n${factsLine}\n\nRESEARCH NOTES:\n${notesBlock}`, false),
    callGroq(BEAR_SYS, `Subject: ${subject}\n${factsLine}\n\nRESEARCH NOTES:\n${notesBlock}`, false),
  ]);

  const judgeUser =
    `Subject: ${subject}\n${factsLine}\n\n` +
    `BULL CASE:\n${bull.slice(0, 4000)}\n\n` +
    `BEAR CASE:\n${bear.slice(0, 4000)}\n\n` +
    `RESEARCH NOTES (the evidence):\n${notes.slice(0, 7000)}\n\n` +
    `Real source URLs (for reference only):\n${groundedUrls.slice(0, 10).join("\n")}`;
  const judgeText = await callGroq(JUDGE_SYS, judgeUser, true);
  const parsed = extractJson(judgeText);
  if (
    !parsed ||
    !(
      Boolean(parsed.summary) ||
      (Array.isArray(parsed.bullPoints) && parsed.bullPoints.length > 0) ||
      (Array.isArray(parsed.bearPoints) && parsed.bearPoints.length > 0)
    )
  ) {
    return null;
  }

  return {
    parsed,
    debate: {
      bull: bull.trim(),
      bear: bear.trim(),
      stance: typeof parsed.stance === "string" ? parsed.stance : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      keyCatalysts: Array.isArray(parsed.keyCatalysts)
        ? parsed.keyCatalysts.filter((x: unknown): x is string => typeof x === "string")
        : [],
      keyRisks: Array.isArray(parsed.keyRisks)
        ? parsed.keyRisks.filter((x: unknown): x is string => typeof x === "string")
        : [],
    },
    model: activeLlmModel(),
  };
}

/** fetch() with a hard timeout so a slow/dead upstream can never hang us. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ===========================================================================
// CATALYST SCAN - autonomous market-wide catalyst discovery (the "engine").
//
// The product rule (the owner): the app must DISCOVER the whole class of
// market-moving catalysts itself - political callouts/trades (President / Fed /
// Cabinet / Congress naming, praising, criticizing, buying, or selling a
// stock), notable CEO/insider open-market buys, and major corporate catalysts
// (M&A, FDA, guidance, big contracts) - so nothing important is missed and no
// example ever has to be hand-coded again. The static `executiveTrades.ts` seed
// becomes a FALLBACK; THIS is the live, self-updating primary.
//
// HOW (and why one broad query is not enough): a single grounded "find today's
// catalysts" call returns real items but is UNRELIABLE - it misses whole
// categories (e.g. a Presidential rally callout) and its grounding is
// inconsistent (0 chunks on some calls). So we run THREE TARGETED grounded
// Gemini queries IN PARALLEL - each with its own google_search - covering
// (1) political, (2) CEO/insider buys, (3) major M&A/FDA/guidance/contracts,
// retry a query once if it grounded 0 chunks, then hand all the grounded notes
// to a single Groq STRUCTURE pass (google_search cannot be combined with forced
// JSON - HTTP 400 - so we ground in one call and structure in another, exactly
// like the desk's 2-step). The structurer emits strict JSON; we then drop any
// item lacking a REAL retrieved source URL or a real US ticker. $0: free Gemini
// grounding + free Groq, both server-side edge secrets.
// ===========================================================================

/** One grounded Gemini search with a CUSTOM instruction (not the per-stock desk
 *  SYSTEM_PROMPT). Returns the prose research + the real retrieved source URLs.
 *  Uses the SAME round-robin key pool + failover as the desk via callGemini-style
 *  rotation, but with its own instruction so the model is free to enumerate the
 *  whole market rather than one ticker. */
async function callGeminiGroundedWithKey(
  instruction: string,
  query: string,
  key: string,
): Promise<{ text: string; urls: string[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
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
    if (shouldFailover(res.status, detail)) {
      throw new QuotaError(res.status, `Gemini ${res.status} ${detail.slice(0, 200)}`);
    }
    throw new Error(`Gemini ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const text: string = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((p: any) => p?.text ?? "").join("\n")
    : "";
  const urls = groundingCitations(candidate).map((c) => c.url);
  return { text, urls };
}

/** Run one grounded query through the key pool (rotate on quota), with a single
 *  retry if it grounded ZERO chunks (the inconsistency the owner flagged). Returns the
 *  notes + real URLs, or empty on total failure (one dead query never kills the scan). */
async function groundedQuery(
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
      geminiStats[ki].calls++;
      try {
        const r = await callGeminiGroundedWithKey(instruction, query, GEMINI_KEYS[ki]);
        geminiStats[ki].ok++;
        geminiStats[ki].lastStatus = 200;
        recordUsage("gemini", ki, true);
        return r;
      } catch (e) {
        lastErr = e;
        const isQuota = e instanceof QuotaError;
        geminiStats[ki].lastStatus = isQuota ? (e as QuotaError).status : -1;
        recordUsage("gemini", ki, false);
        if (isQuota && i < n - 1) {
          geminiStats[ki].failovers++;
          continue;
        }
        // Non-quota (timeout/network) → every key hits the same wall; bail this attempt.
        break;
      }
    }
    if (lastErr) throw lastErr;
    return { text: "", urls: [] };
  };
  try {
    let r = await attempt();
    // Retry ONCE if the query returned content but grounded 0 chunks (no real
    // sources) - grounding is inconsistent and an ungrounded read is unusable here.
    if (r.urls.length === 0) {
      try {
        const r2 = await attempt();
        if (r2.urls.length > 0) r = r2;
        else if (r2.text.length > r.text.length) r = r2;
      } catch {
        /* keep first attempt */
      }
    }
    return r;
  } catch {
    return { text: "", urls: [] };
  }
}

/** The three targeted discovery instructions + queries. Each is grounded with its
 *  own google_search. `todayIso` anchors recency. */
function catalystQueries(todayIso: string): Array<{ label: string; instruction: string; query: string }> {
  const freshness =
    "Use Google Search for the FRESHEST facts (today is " +
    todayIso +
    "; strongly prefer the last 7 days, never older than ~3 weeks). For EVERY item state the exact U.S. exchange TICKER, the company, what happened, WHO acted, the DATE, and include the source.";
  return [
    {
      label: "political",
      instruction:
        "You are a political-markets analyst. Find RECENT, REAL events where a U.S. political actor — the President, the Fed Chair, a Cabinet/agency head, or a named member of Congress — has NAMED, praised, criticized, set policy on (tariffs/sanctions/executive order/contract award/antitrust/probe/subsidy), or personally BOUGHT or SOLD a specific publicly-traded U.S. company. Get the DIRECTION right: a disclosed BUY, praise, contract win, or friendly policy is BULLISH; a tariff/sanction threat, probe, criticism, or unfavorable policy is BEARISH. " +
        freshness,
      query:
        "What stocks has the U.S. President, the Fed, a Cabinet member, or a member of Congress publicly named, praised, criticized, set policy on, or disclosed buying or selling in the last week? Include presidential rally/speech callouts of specific companies, OGE Form 278-T and congressional (PTR) trade disclosures, tariff/sanction threats on named companies, and government contract awards. For each: ticker, company, who, what, bullish or bearish, date, source.",
    },
    {
      label: "insider",
      instruction:
        "You are a smart-money analyst. Find RECENT, REAL notable OPEN-MARKET insider purchases — a CEO, CFO, founder, director, or 10% owner BUYING their own company's stock on the open market (SEC Form 4 transaction code P), especially large or cluster buys, near 52-week lows, or by a prior net seller. These are BULLISH. Routine option exercises/grants (codes M/A) are NOT signals — exclude them. " +
        freshness,
      query:
        "Which company executives, founders, directors, or 10% owners made notable open-market stock purchases (SEC Form 4 code P) in the last week or two? Favor large buys, cluster buys, buys near 52-week lows, and CEOs buying their own stock. For each: ticker, company, the insider's name and role, approximate dollar amount, date, source.",
    },
    {
      label: "corporate",
      instruction:
        "You are an event-driven analyst. Find RECENT, REAL, market-moving CORPORATE catalysts on specific publicly-traded U.S. companies: M&A / acquisition / merger / takeover (acquirer AND target), FDA approvals or clinical-trial results, raised or cut earnings GUIDANCE and big earnings surprises, and major CONTRACT or partnership wins (incl. government/defense awards). Mark each BULLISH or BEARISH for the named company (a guidance cut, failed trial, or being acquired-below-market is bearish; an approval, beat-and-raise, or premium buyout is bullish). " +
        freshness,
      query:
        "What are the biggest market-moving corporate catalysts of the last week — mergers and acquisitions, FDA approvals or trial results, earnings guidance raises/cuts and surprises, and major contract or partnership wins — on specific U.S.-listed companies? For each: ticker, company, the catalyst, bullish or bearish, date, source.",
    },
  ];
}

/** Groq system prompt that turns the merged grounded notes into the strict
 *  catalyst-scan JSON. No web access - it ONLY reorganizes the grounded notes and
 *  may cite ONLY the real URLs it is given. */
const CATALYST_STRUCT_SYS =
  'You are a financial data extractor. You are given grounded research NOTES (gathered via live web search) about recent market catalysts, plus the list of REAL source URLs that were retrieved. Extract every concrete, specific catalyst into a strict JSON array. Respond with ONLY a JSON object (no markdown): {"catalysts":[{"ticker":string (the real U.S. exchange symbol, uppercase),"company":string,"headline":string (one tight sentence, lead with what happened),"actor":string (who acted — e.g. "President Trump", "CEO Jane Doe", "Pfizer"; "" if none),"role":string (e.g. "President","Fed","Congress","CEO","Company","Insider"),"direction":"bullish"|"bearish","date":string (YYYY-MM-DD),"importance":number (0-100; a President naming a stock or a major M&A is ~80-95, a routine insider buy ~40-60),"kind":"political"|"insider_buy"|"ma"|"fda"|"guidance"|"contract"|"other","url":string (MUST be one of the provided source URLs that supports THIS item)}]}. RULES: include an item ONLY if the notes give a real ticker AND you can attach a real supporting URL from the provided list. Get DIRECTION right (a tariff/probe/criticism/guidance-cut is bearish; a disclosed buy/praise/approval/beat is bullish). Do NOT invent tickers, dates, or URLs. Omit anything you cannot ground. Deduplicate.';

interface ScannedCatalyst {
  ticker: string;
  company: string;
  headline: string;
  actor: string;
  role: string;
  direction: "bullish" | "bearish";
  date: string;
  importance: number;
  kind: string;
  url: string;
}

const VALID_KINDS_SCAN = new Set(["political", "insider_buy", "ma", "fda", "guidance", "contract", "other"]);
const TICKER_RE = /^[A-Z][A-Z.\-]{0,5}$/;

/** Validate + normalize one structured item - drop anything without a real ticker
 *  and a real (provided) source URL. This is the no-fabrication backstop. */
function sanitizeScanned(raw: any, allowedUrls: Set<string>, todayMs: number): ScannedCatalyst | null {
  if (!raw || typeof raw !== "object") return null;
  const ticker = typeof raw.ticker === "string" ? raw.ticker.trim().toUpperCase() : "";
  if (!ticker || !TICKER_RE.test(ticker)) return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  // Must be a real retrieved URL (exact, or same origin+path as one we grounded).
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (!allowedUrls.has(url) && !urlMatchesAllowed(url, allowedUrls)) return null;
  const headline = typeof raw.headline === "string" ? raw.headline.trim() : "";
  if (!headline) return null;
  const direction = raw.direction === "bearish" ? "bearish" : "bullish";
  let kind = typeof raw.kind === "string" && VALID_KINDS_SCAN.has(raw.kind) ? raw.kind : "other";
  // DETERMINISTIC kind fix: an UNAMBIGUOUS political actor (the U.S. President,
  // the Fed, Congress, a Cabinet/agency head) is ALWAYS a political catalyst -
  // the structurer often mis-tags a congressional disclosure as "insider_buy".
  // PRECISION GUARD: a corporate officer titled "President" / "President and CEO"
  // is NOT political (that's an insider buy), so we never trigger on a bare
  // "president" - only on clear head-of-state / legislative / agency phrasing, and
  // we explicitly exclude corporate-officer context.
  const roleActor = `${typeof raw.role === "string" ? raw.role : ""} ${typeof raw.actor === "string" ? raw.actor : ""}`.toLowerCase();
  const corporateOfficer = /\b(ceo|cfo|coo|cto|chief|founder|director|officer|chairman|president (and|&) (ceo|chief))\b/.test(roleActor);
  const politicalActor =
    /\b(white house|congress|congressman|congresswoman|senator|\bsen\.|representative|\brep\.|federal reserve|fed chair|cabinet|treasury secretary|secretary of|attorney general|governor [a-z])\b/.test(roleActor) ||
    /\b(president trump|president biden|the president|u\.?s\.? president|us president|potus)\b/.test(roleActor);
  if (politicalActor && !corporateOfficer) {
    kind = "political";
  }
  let date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : "";
  // Drop a date in the future or absurdly old (>60 days) - keep but blank an unparseable one.
  if (date) {
    const t = Date.parse(date + "T00:00:00Z");
    if (!Number.isFinite(t) || t > todayMs + 2 * 86_400_000 || t < todayMs - 60 * 86_400_000) {
      date = new Date(todayMs).toISOString().slice(0, 10);
    }
  } else {
    date = new Date(todayMs).toISOString().slice(0, 10);
  }
  const importance = Math.max(0, Math.min(100, Number(raw.importance) || 50));
  return {
    ticker,
    company: typeof raw.company === "string" ? raw.company.trim() : ticker,
    headline,
    actor: typeof raw.actor === "string" ? raw.actor.trim() : "",
    role: typeof raw.role === "string" ? raw.role.trim() : "",
    direction,
    date,
    importance,
    kind,
    url,
  };
}

/** Tolerate a trailing-slash / query-string difference between a cited URL and a
 *  grounded one (Gemini's grounding URIs are redirect wrappers; the model often
 *  echoes the canonical link). Match on origin+pathname. */
function urlMatchesAllowed(url: string, allowed: Set<string>): boolean {
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

/** Dedupe scanned catalysts by ticker+kind+direction, keeping the highest importance. */
function dedupeScanned(items: ScannedCatalyst[]): ScannedCatalyst[] {
  const best = new Map<string, ScannedCatalyst>();
  for (const it of items) {
    const k = `${it.ticker}|${it.kind}|${it.direction}`;
    const prev = best.get(k);
    if (!prev || it.importance > prev.importance) best.set(k, it);
  }
  return [...best.values()].sort((a, b) => b.importance - a.importance);
}

/**
 * Run the full catalyst scan: 3 grounded queries in parallel → 1 Groq structure
 * pass → validated, deduped JSON. Returns { catalysts, generatedAt, meta }.
 * Never throws (degrades to an empty list) so the daily pipeline step is safe.
 */
async function runCatalystScan(): Promise<{
  catalysts: ScannedCatalyst[];
  generatedAt: string;
  meta: { queriesGrounded: number; rawSources: number; structured: number };
}> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayMs = Date.now();
  const queries = catalystQueries(todayIso);

  const results = await Promise.all(
    queries.map((q) => groundedQuery(q.instruction, q.query).then((r) => ({ ...r, label: q.label }))),
  );

  const allUrls = new Set<string>();
  const sections: string[] = [];
  let queriesGrounded = 0;
  for (const r of results) {
    if (r.urls.length > 0) queriesGrounded++;
    for (const u of r.urls) allUrls.add(u);
    if (r.text.trim()) {
      // Cap each section's prose so ONE structuring call stays well under the
      // Groq free-tier per-minute token limit (the merged notes blow past it).
      sections.push(
        `### ${r.label.toUpperCase()} CATALYSTS\n${r.text.trim().slice(0, 2600)}\n\nSOURCES FOR THIS SECTION:\n${r.urls.map((u) => `- ${u}`).join("\n")}`,
      );
    }
  }

  if (sections.length === 0 || allUrls.size === 0) {
    return { catalysts: [], generatedAt: new Date().toISOString(), meta: { queriesGrounded, rawSources: allUrls.size, structured: 0 } };
  }
  if (!(LLM_API_KEY && LLM_BASE_URL && LLM_MODEL)) {
    // No structurer configured - can't reliably emit JSON from grounded prose.
    return { catalysts: [], generatedAt: new Date().toISOString(), meta: { queriesGrounded, rawSources: allUrls.size, structured: 0 } };
  }

  // STRUCTURE ONE SECTION PER GROQ CALL. A single merged call (~19k chars) exceeds
  // Groq's free-tier tokens-per-minute limit and 413s (measured). Per-section calls
  // stay small; we pace them ~1.2s apart to respect the per-minute window, then
  // merge + validate. Each section only cites the URLs it grounded, so the
  // no-fabrication contract holds. The whole loop adds ~5s.
  const rawItems: any[] = [];
  for (const sec of sections) {
    const structUser =
      `Today is ${todayIso}. Extract the catalysts from these grounded notes.\n\n${sec.slice(0, 4200)}\n\nCite ONLY URLs that appear above.`;
    try {
      const text = await callGroq(CATALYST_STRUCT_SYS, structUser, true);
      const parsed = extractJson(text);
      if (Array.isArray(parsed?.catalysts)) rawItems.push(...parsed.catalysts);
    } catch (e) {
      console.warn(`[research-agent] catalyst_scan structure failed: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  const clean = rawItems
    .map((r) => sanitizeScanned(r, allUrls, todayMs))
    .filter((x): x is ScannedCatalyst => x !== null);
  const deduped = dedupeScanned(clean);

  return {
    catalysts: deduped,
    generatedAt: new Date().toISOString(),
    meta: { queriesGrounded, rawSources: allUrls.size, structured: deduped.length },
  };
}

// ---------------------------------------------------------------------------
// Yahoo Finance analyst price targets - real, free, a second consensus source
// beyond Finnhub. The endpoint needs a cookie + crumb; we fetch them once and
// cache at module scope (the isolate is reused across invocations) so each
// per-ticker call is a single request.
// ---------------------------------------------------------------------------

const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let yahooCrumb = "";
let yahooCookie = "";
let yahooCrumbAt = 0;
const YAHOO_CRUMB_TTL_MS = 30 * 60 * 1000; // 30 min

function cookieHeaderFrom(res: Response): string {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const list = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  const raw = list.length > 0 ? list : [res.headers.get("set-cookie") ?? ""];
  return raw
    .map((c) => c.split(";")[0])
    .filter((c) => c && c.includes("="))
    .join("; ");
}

async function ensureYahooCrumb(): Promise<boolean> {
  if (yahooCrumb && Date.now() - yahooCrumbAt < YAHOO_CRUMB_TTL_MS) return true;
  try {
    const seed = await fetchWithTimeout("https://fc.yahoo.com/", {
      headers: { "User-Agent": YAHOO_UA },
    });
    yahooCookie = cookieHeaderFrom(seed);
    const cr = await fetchWithTimeout("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": YAHOO_UA, ...(yahooCookie ? { Cookie: yahooCookie } : {}) },
    });
    const crumb = (await cr.text()).trim();
    if (!crumb || /\s/.test(crumb) || crumb.includes("<")) return false;
    yahooCrumb = crumb;
    yahooCrumbAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

interface YahooTargets {
  source: string;
  origin: "yahoo";
  mean?: number;
  high?: number;
  low?: number;
  median?: number;
  analystCount?: number;
  currentPrice?: number;
  generatedAt: string;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function yahooPriceTargets(ticker: string): Promise<YahooTargets | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;
  if (!(await ensureYahooCrumb())) return null;

  for (const host of ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]) {
    try {
      const url = `${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData&crumb=${encodeURIComponent(yahooCrumb)}`;
      let r = await fetchWithTimeout(url, {
        headers: { "User-Agent": YAHOO_UA, ...(yahooCookie ? { Cookie: yahooCookie } : {}) },
      });
      if (r.status === 401) {
        // Crumb expired - refresh once and retry this host.
        yahooCrumb = "";
        if (!(await ensureYahooCrumb())) return null;
        const retryUrl = `${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=financialData&crumb=${encodeURIComponent(yahooCrumb)}`;
        r = await fetchWithTimeout(retryUrl, {
          headers: { "User-Agent": YAHOO_UA, ...(yahooCookie ? { Cookie: yahooCookie } : {}) },
        });
      }
      if (!r.ok) continue;
      const j = await r.json();
      const fd = j?.quoteSummary?.result?.[0]?.financialData;
      const mean = num(fd?.targetMeanPrice?.raw);
      if (mean == null || mean <= 0) continue;
      return {
        source: "Yahoo Finance consensus",
        origin: "yahoo",
        mean,
        high: num(fd?.targetHighPrice?.raw),
        low: num(fd?.targetLowPrice?.raw),
        median: num(fd?.targetMedianPrice?.raw),
        analystCount: num(fd?.numberOfAnalystOpinions?.raw),
        currentPrice: num(fd?.currentPrice?.raw),
        generatedAt: new Date().toISOString(),
      };
    } catch {
      /* try next host */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GROUND TRUTH - authoritative current facts for a ticker, fetched live from
// Finnhub (free tier) and used to (a) anchor the LLM prompt and (b) claim-check
// its output. This is the fix for the "SoFi unprofitable" class of bug: the LLM
// is NEVER trusted to recall a fundamental - we hand it the real one and reject
// anything that contradicts it.
// ---------------------------------------------------------------------------

interface InsiderTxn {
  name: string;
  code: string;
  shares: number;
  change: number;
  price: number;
  date: string;
  valueUsd: number;
}

interface NewsItem {
  title: string;
  url: string;
  source: string;
  /** ISO date. */
  date: string;
}

interface GroundTruth {
  ticker: string;
  name?: string;
  price?: number;
  dayChangePct?: number;
  marketCapB?: number; // billions USD
  industry?: string;
  epsTTM?: number;
  peTTM?: number;
  revenueGrowthYoYPct?: number;
  week52High?: number;
  week52Low?: number;
  /** "profitable" | "unprofitable" | "unknown" - the single most-abused fact. */
  profitability: "profitable" | "unprofitable" | "unknown";
  /** Human basis for the profitability call, shown for trust. */
  profitabilityBasis?: string;
  asOf?: string | null;
  insiderBuys: InsiderTxn[];
  insiderSells: InsiderTxn[];
  /** Recent real, dated headlines (Finnhub company-news) - the LIVE narrative
   *  grounding that lets a non-web-search LLM (Groq fallback) write a CURRENT brief
   *  without depending on Gemini's scarce free google_search quota. Also the
   *  citation set for the Groq path (real URLs we fetched). */
  news: NewsItem[];
}

/** GET a Finnhub endpoint, trying each key until one returns 200 JSON. */
async function finnhubJson<T>(path: string): Promise<T | null> {
  for (const key of FINNHUB_KEYS) {
    try {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetchWithTimeout(`https://finnhub.io/api/v1${path}${sep}token=${key}`, {
        headers: { Accept: "application/json" },
      });
      if (res.status === 429 || res.status === 401 || res.status === 403) continue; // try next key
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      /* try next key */
    }
  }
  return null;
}

const fnum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Size-aware sanity bound for a YoY growth percentage. Finnhub's free feed
 * sometimes surfaces a noisy quarterly-YoY figure (e.g. SoFi reading "+205%"
 * when the real number is ~43%). For a large/mega-cap a triple-digit reading is
 * almost always an artifact, so we omit it rather than inject a wrong number.
 */
function saneGrowthPct(value: number | undefined, marketCapB: number | undefined): number | undefined {
  if (value == null) return undefined;
  const largeCap = (marketCapB ?? 0) >= 10;
  const cap = largeCap ? 70 : 500;
  return Math.abs(value) > cap ? undefined : value;
}

/**
 * Fetch the ticker's authoritative current facts. Profitability is decided by
 * the sign of TTM EPS FIRST (the most direct profitability signal), then ROE,
 * then net margin - because Finnhub's `netProfitMarginTTM` is the field that
 * lagged/distorted for SoFi (it read −19.8% while EPS was +$0.44 and the company
 * is GAAP-profitable). Never let the noisy net-margin field alone decide.
 */
async function fetchGroundTruth(ticker: string, companyName?: string): Promise<GroundTruth | null> {
  const sym = ticker.trim().toUpperCase();
  if (!sym || FINNHUB_KEYS.length === 0) return null;

  const toDay = new Date().toISOString().slice(0, 10);
  const fromDay = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [profile, metricResp, quote, insider, newsRaw] = await Promise.all([
    finnhubJson<any>(`/stock/profile2?symbol=${encodeURIComponent(sym)}`),
    finnhubJson<any>(`/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`),
    finnhubJson<any>(`/quote?symbol=${encodeURIComponent(sym)}`),
    finnhubJson<any>(`/stock/insider-transactions?symbol=${encodeURIComponent(sym)}`),
    finnhubJson<any[]>(`/company-news?symbol=${encodeURIComponent(sym)}&from=${fromDay}&to=${toDay}`),
  ]);

  // Recent real, dated headlines - the LIVE narrative grounding (last ~3 weeks,
  // newest first, capped). Real URLs become the citation set for a non-grounded
  // (Groq) fallback so the desk never depends solely on Gemini's scarce free
  // google_search quota - and never fabricates a source.
  const news: NewsItem[] = [];
  if (Array.isArray(newsRaw)) {
    const sorted = [...newsRaw].sort((a, b) => (fnum(b?.datetime) ?? 0) - (fnum(a?.datetime) ?? 0));
    for (const n of sorted) {
      const title = typeof n?.headline === "string" ? n.headline.trim() : "";
      const url = typeof n?.url === "string" ? n.url.trim() : "";
      if (!title || !url) continue;
      const ts = fnum(n?.datetime);
      news.push({
        title,
        url,
        source: typeof n?.source === "string" ? n.source : "news",
        date: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "",
      });
      if (news.length >= 12) break;
    }
  }

  const metric = (metricResp?.metric ?? {}) as Record<string, unknown>;
  const epsTTM = fnum(metric.epsTTM) ?? fnum(metric.epsBasicExclExtraItemsTTM);
  const roeTTM = fnum(metric.roeTTM);
  const netMarginTTM = fnum(metric.netProfitMarginTTM) ?? fnum(metric.netMarginTTM);
  const marketCapB = fnum(profile?.marketCapitalization)
    ? (fnum(profile?.marketCapitalization) as number) / 1000 // Finnhub reports in millions
    : undefined;

  // Profitability by priority: EPS sign → ROE sign → net-margin sign.
  let profitability: GroundTruth["profitability"] = "unknown";
  let profitabilityBasis: string | undefined;
  if (epsTTM != null) {
    profitability = epsTTM > 0 ? "profitable" : "unprofitable";
    profitabilityBasis = `TTM EPS ${epsTTM > 0 ? "$" + epsTTM.toFixed(2) + " (positive)" : "$" + epsTTM.toFixed(2) + " (negative)"}`;
    if (epsTTM > 0 && netMarginTTM != null && netMarginTTM < 0) {
      profitabilityBasis += " — GAAP-profitable on TTM earnings; disregard any stale negative net-margin figure";
    }
  } else if (roeTTM != null) {
    profitability = roeTTM > 0 ? "profitable" : "unprofitable";
    profitabilityBasis = `TTM ROE ${roeTTM.toFixed(1)}%`;
  } else if (netMarginTTM != null) {
    profitability = netMarginTTM > 0 ? "profitable" : "unprofitable";
    profitabilityBasis = `TTM net margin ${netMarginTTM.toFixed(1)}%`;
  }

  // Insider transactions - last ~120 days, classify true open-market buys (P) vs
  // sells (S). Sort by dollar value. Option exercises (M)/grants (A)/tax (F) are
  // not directional signals, so they're excluded.
  const txns = Array.isArray(insider?.data) ? insider.data : [];
  const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const buys: InsiderTxn[] = [];
  const sells: InsiderTxn[] = [];
  for (const t of txns) {
    const date = typeof t?.transactionDate === "string" ? t.transactionDate : "";
    const when = date ? Date.parse(date) : NaN;
    if (!Number.isFinite(when) || when < cutoff) continue;
    const code = typeof t?.transactionCode === "string" ? t.transactionCode : "";
    const change = fnum(t?.change) ?? 0;
    const price = fnum(t?.transactionPrice) ?? 0;
    const name = typeof t?.name === "string" ? t.name : "";
    if (!name) continue;
    const row: InsiderTxn = { name, code, shares: fnum(t?.share) ?? 0, change, price, date, valueUsd: Math.abs(change) * price };
    if (code === "P" && change > 0) buys.push(row);
    else if (code === "S" && change < 0) sells.push(row);
  }
  buys.sort((a, b) => b.valueUsd - a.valueUsd);
  sells.sort((a, b) => b.valueUsd - a.valueUsd);

  const gt: GroundTruth = {
    ticker: sym,
    name: (typeof profile?.name === "string" && profile.name) || companyName,
    price: fnum(quote?.c),
    dayChangePct: fnum(quote?.dp),
    marketCapB,
    industry: typeof profile?.finnhubIndustry === "string" ? profile.finnhubIndustry : undefined,
    epsTTM,
    peTTM: fnum(metric.peTTM),
    revenueGrowthYoYPct: saneGrowthPct(fnum(metric.revenueGrowthTTMYoy), marketCapB),
    week52High: fnum(metric["52WeekHigh"]),
    week52Low: fnum(metric["52WeekLow"]),
    profitability,
    profitabilityBasis,
    asOf: typeof metricResp?.series?.annual === "object" ? null : null,
    insiderBuys: buys.slice(0, 5),
    insiderSells: sells.slice(0, 5),
    news,
  };
  // Only meaningful if we got at least price or profitability.
  if (gt.price == null && gt.profitability === "unknown" && gt.marketCapB == null) return null;
  return gt;
}

const usd = (n: number): string =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;

/** The "VERIFIED CURRENT FACTS" block injected at the top of the desk prompt. */
function verifiedFactsBlock(gt: GroundTruth): string {
  const lines: string[] = [];
  if (gt.profitability !== "unknown") {
    const word = gt.profitability === "profitable" ? "PROFITABLE" : "NOT YET PROFITABLE";
    lines.push(
      `- Profitability: ${word}${gt.profitabilityBasis ? ` (${gt.profitabilityBasis})` : ""}. ` +
        (gt.profitability === "profitable"
          ? "Do NOT state or imply this company is unprofitable, loss-making, or 'yet to turn a profit'."
          : "Frame profitability honestly — it is not yet GAAP-profitable on a TTM basis."),
    );
  }
  if (gt.price != null) lines.push(`- Latest price: $${gt.price.toFixed(2)}${gt.dayChangePct != null ? ` (${gt.dayChangePct >= 0 ? "+" : ""}${gt.dayChangePct.toFixed(1)}% today)` : ""}.`);
  if (gt.marketCapB != null) lines.push(`- Market cap: ~$${gt.marketCapB >= 1 ? gt.marketCapB.toFixed(1) + "B" : (gt.marketCapB * 1000).toFixed(0) + "M"}.`);
  if (gt.revenueGrowthYoYPct != null) lines.push(`- Revenue growth (TTM YoY): ${gt.revenueGrowthYoYPct >= 0 ? "+" : ""}${gt.revenueGrowthYoYPct.toFixed(0)}%.`);
  if (gt.peTTM != null && gt.peTTM > 0 && gt.peTTM < 2000) lines.push(`- P/E (TTM): ${gt.peTTM.toFixed(1)}.`);
  if (gt.week52High != null && gt.week52Low != null) lines.push(`- 52-week range: $${gt.week52Low.toFixed(2)}–$${gt.week52High.toFixed(2)}.`);

  const insider: string[] = [];
  if (gt.insiderBuys.length > 0) {
    insider.push(
      `INSIDER BUYS (open-market, last ~120 days — treat material ones as a DATED bullish catalyst and surface the most notable as a bull point): ` +
        gt.insiderBuys.map((b) => `${b.name} bought ${Math.abs(b.change).toLocaleString()} sh (~${usd(b.valueUsd)}) on ${b.date}`).join("; ") + ".",
    );
  }
  if (gt.insiderSells.length > 0) {
    insider.push(
      `INSIDER SELLS (open-market, last ~120 days — only material clustered selling is bearish; routine sales are noise): ` +
        gt.insiderSells.map((s) => `${s.name} sold ${Math.abs(s.change).toLocaleString()} sh (~${usd(s.valueUsd)}) on ${s.date}`).join("; ") + ".",
    );
  }

  let headlines = "";
  if (gt.news && gt.news.length > 0) {
    headlines =
      "\nRECENT HEADLINES (live, last ~3 weeks — newest first; cite these by their URL and treat them as the current narrative):\n" +
      gt.news.map((n) => `- [${n.date || "recent"}] ${n.title} (${n.source}) — ${n.url}`).join("\n");
  }

  return (
    `VERIFIED CURRENT FACTS for ${gt.name ?? gt.ticker} (${gt.ticker}) — fetched live from market data just now. These are AUTHORITATIVE: do NOT state or imply anything that contradicts them. If your recollection conflicts with a fact below, your recollection is WRONG; defer to the fact.\n` +
    lines.join("\n") +
    (insider.length > 0 ? "\n" + insider.join("\n") : "") +
    headlines
  );
}

/**
 * Deterministic claim-check: drop any model bull/bear point that contradicts the
 * verified profitability fact. This is the backstop behind the prompt injection -
 * even if the model ignores the facts, a wrong "unprofitable" claim never renders.
 * Returns the filtered list + how many were dropped (logged).
 */
function scrubProfitabilityContradictions(
  points: string[],
  profitability: GroundTruth["profitability"],
): { kept: string[]; dropped: number } {
  if (profitability === "unknown") return { kept: points, dropped: 0 };
  const saysUnprofitable =
    /\b(unprofitable|not\s+(yet\s+)?profitable|isn'?t\s+profitable|loss-?making|losing\s+money|(remains|still)\s+(unprofitable|in\s+the\s+red)|negative\s+net\s+(profit\s+)?margin|no\s+profit\b|yet\s+to\s+(turn|reach|achieve|post)\s+(a\s+)?profit|has(n'?t|\s+not)\s+(turned|reached|posted)\s+(a\s+)?profit|lack\s+of\s+profitability|path\s+to\s+profitability)\b/i;
  const saysProfitable = /\b(is\s+profitable|now\s+profitable|GAAP[- ]profitable|consistently\s+profitable|turned\s+(a\s+)?profit|profitable\s+company)\b/i;
  const kept: string[] = [];
  let dropped = 0;
  for (const p of points) {
    if (profitability === "profitable" && saysUnprofitable.test(p) && !saysProfitable.test(p)) {
      dropped++;
      continue;
    }
    if (profitability === "unprofitable" && saysProfitable.test(p) && !saysUnprofitable.test(p)) {
      dropped++;
      continue;
    }
    kept.push(p);
  }
  return { kept, dropped };
}

function extractJson(text: string): any {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* noop */
      }
    }
    return null;
  }
}

/** Pull citation candidates from Gemini's grounding metadata. */
function groundingCitations(candidate: any): Citation[] {
  const chunks = candidate?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  return chunks
    .map((c: any) => c?.web)
    .filter((w: any) => w?.uri)
    .map((w: any) => ({
      title: w.title ?? w.uri,
      url: w.uri,
      source: w.title ?? "web",
      publishedAt: "",
    }));
}

// ---------------------------------------------------------------------------
// Providers - each returns raw model text + any grounding citations, or throws.
// ---------------------------------------------------------------------------

/** Tagged error so callGemini knows a key hit its quota and should fail over. */
class QuotaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

async function callGeminiWithKey(prompt: string, key: string): Promise<ProviderResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.4,
      // Bound the work so the grounded call is FAST + predictable. gemini-2.5-flash runs with
      // "thinking" ON by default, which added 30-90s of variable latency - the Research Desk
      // then blew past the client's 120s under any key failover and showed "Research service
      // unavailable". thinkingBudget:0 disables it (grounding still gives real citations), and
      // the token cap keeps generation tight. ~15-25s. Grounded research is VERBOSE and variable
      // (7k-36k chars measured) - the model writes prose around the schema, and google_search
      // CANNOT be combined with forced-JSON mode (HTTP 400). So we don't depend on this call
      // parsing as JSON: a generous budget captures the FULL research, and a Groq STRUCTURE step
      // (below) turns it into valid JSON when the inline parse fails. 8192 truncated mid-JSON →
      // "empty" → false "busy" (the bug the owner hit); 12288 captures a fuller read while staying
      // within the client budget (~20-35s with thinking off).
      maxOutputTokens: 12288,
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
    // Gemini reports quota exhaustion as 429 (and sometimes 403) with a
    // RESOURCE_EXHAUSTED / quota body. Tag those so the caller fails over to the
    // backup key immediately instead of burning time re-hitting a dead key.
    if (shouldFailover(res.status, detail)) {
      throw new QuotaError(res.status, `Gemini ${res.status} ${detail.slice(0, 300)}`);
    }
    throw new Error(`Gemini ${res.status} ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const text: string = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((p: any) => p?.text ?? "").join("\n")
    : "";
  return { text, citations: groundingCitations(candidate), model: GEMINI_MODEL };
}

/**
 * Gemini with automatic key failover. Try the primary key; on ANY quota/rate
 * failure (429, or 403/quota body) rotate to the backup key (each free-tier key
 * has its own quota) and retry the FULL request. Only when EVERY configured key
 * is exhausted do we throw - the provider chain then falls through to the
 * OpenAI-compatible lane. Logs which key served (or failed) each call.
 *
 * If a key is rate-limited but there is NO backup left, we do one short wait +
 * retry on that same key (the free per-minute window may have rolled over)
 * before giving up - so a single-key deploy still degrades gracefully.
 */
async function callGemini(prompt: string): Promise<ProviderResult> {
  const n = GEMINI_KEYS.length;
  if (n === 0) throw new Error("Gemini: no API key configured");

  // Round-robin: start at the cursor, advance it for the NEXT request (so load
  // spreads across the pool), then fail over through the remaining keys.
  const start = geminiCursor % n;
  geminiCursor = (start + 1) % n;
  const order = Array.from({ length: n }, (_, k) => (start + k) % n);

  let lastErr: unknown;
  for (let i = 0; i < n; i++) {
    const ki = order[i];
    const hasMore = i < n - 1;
    geminiStats[ki].calls++;
    try {
      const result = await callGeminiWithKey(prompt, GEMINI_KEYS[ki]);
      geminiStats[ki].ok++;
      geminiStats[ki].lastStatus = 200;
      recordUsage("gemini", ki, true);
      console.log(`[research-agent] gemini served by key#${ki}`);
      return result;
    } catch (e) {
      lastErr = e;
      const isQuota = e instanceof QuotaError;
      geminiStats[ki].lastStatus = isQuota ? (e as QuotaError).status : -1;
      recordUsage("gemini", ki, false);
      console.warn(
        `[research-agent] gemini key#${ki} failed (${e instanceof Error ? e.message : String(e)})${
          hasMore ? " — rotating" : ""
        }`,
      );
      // Rotate to the NEXT KEY only on a QUOTA/429 - each free key has its own quota, and a 429
      // returns fast, so failing over is cheap. On a non-quota failure, bail immediately to the
      // fast Groq fallback instead of grinding through the rest of the pool.
      if (hasMore && isQuota) {
        geminiStats[ki].failovers++;
        continue;
      }
      if (hasMore && !isQuota) {
        geminiStats[ki].failovers++;
        throw e; // model slow/hung → provider chain falls through to Groq now
      }
      // Last key + quota/overload: give the per-minute window one chance to reset
      // before the provider chain falls through to the OpenAI-compatible lane.
      if (isQuota) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const result = await callGeminiWithKey(prompt, GEMINI_KEYS[ki]);
          geminiStats[ki].ok++;
          geminiStats[ki].lastStatus = 200;
          recordUsage("gemini", ki, true);
          console.log(`[research-agent] gemini served by key#${ki} (after retry)`);
          return result;
        } catch (e2) {
          lastErr = e2;
          recordUsage("gemini", ki, false);
        }
      }
    }
  }
  throw lastErr ?? new Error("Gemini: all keys exhausted");
}

async function callOpenAICompatible(prompt: string): Promise<ProviderResult> {
  // Reuse the pooled, failover-aware Groq caller so this lane also rotates keys.
  const text = await callGroq(SYSTEM_PROMPT, prompt, true);
  return { text, citations: [], model: activeLlmModel() || "openai-compatible" };
}

type Provider = { name: "gemini" | "openai"; run: (p: string) => Promise<ProviderResult> };

/** Ordered provider chain based on configured keys + RESEARCH_PROVIDER. */
function providerChain(): Provider[] {
  // BUGFIX: the round-robin refactor replaced the individual GEMINI_API_KEY /
  // GEMINI_API_KEY_BACKUP constants with the GEMINI_KEYS pool, but this check still
  // referenced the (now-undefined) old constants - a ReferenceError that threw
  // OUTSIDE the request try/catch, so EVERY real diligence call 500'd (while
  // /_status, which never calls providerChain, looked healthy). Gate on the pool.
  const gemini: Provider | null = GEMINI_KEYS.length > 0
    ? { name: "gemini", run: callGemini }
    : null;
  const openai: Provider | null = LLM_API_KEY && LLM_BASE_URL && LLM_MODEL
    ? { name: "openai", run: callOpenAICompatible }
    : null;

  let order: (Provider | null)[];
  if (RESEARCH_PROVIDER === "openai") order = [openai, gemini];
  else if (RESEARCH_PROVIDER === "gemini") order = [gemini, openai];
  else order = [gemini, openai]; // "auto": prefer grounded Gemini, fall back
  return order.filter((p): p is Provider => p !== null);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Read-only rotation/usage status for the in-app dashboard. NO secret values -
  // only key COUNT + per-key call/ok/failover counters (since cold start) so the
  // app can SHOW that the Gemini pool is rotating across all keys.
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/_status")) {
    return json({
      ok: true,
      note: "in-memory counters; reset on function cold start",
      gemini: {
        keys: GEMINI_KEYS.length,
        cursor: geminiCursor,
        model: GEMINI_MODEL,
        openaiFallback: Boolean(LLM_API_KEY && LLM_BASE_URL && LLM_MODEL),
        perKey: geminiStats,
      },
      groq: {
        keys: LLM_KEYS.length,
        cursor: groqCursor,
        model: activeLlmModel() || null,
        configured: Boolean(LLM_API_KEY && LLM_BASE_URL && LLM_MODEL),
        perKey: groqStats,
      },
    });
  }

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: AgentRequest;
  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Deterministic data task - real Yahoo Finance analyst targets (a second
  // consensus source beyond Finnhub). No LLM needed, so handle it before the chain.
  if (body.task === "price_targets") {
    const targets = await yahooPriceTargets(body.ticker ?? "");
    if (!targets) return json({ error: "No Yahoo price targets available" }, 404);
    return json(targets);
  }

  // CATALYST SCAN - autonomous market-wide catalyst discovery (no per-stock input).
  // Three targeted grounded Gemini queries (political / insider buys / corporate)
  // + a Groq structure pass → validated strict JSON. Meant to run SERVER-SIDE on the
  // daily schedule (NOT per client load - that would burn the free Gemini quota); the
  // scan step caches the result for the Terminal + feed to read. Always 200 with a
  // (possibly empty) list so the caller can cache deterministically.
  if (body.task === "catalyst_scan") {
    const scan = await runCatalystScan();
    console.log(
      `[research-agent] catalyst_scan → ${scan.catalysts.length} catalysts (queriesGrounded=${scan.meta.queriesGrounded}, rawSources=${scan.meta.rawSources})`,
    );
    return json(scan);
  }

  // DATA INTEGRITY (the owner's #1 rule): the Research Desk (`deep_research`) must
  // NEVER serve a STALE model-recalled read. The original design used the GROUNDED
  // Gemini lane only and 429'd when Gemini's scarce free google_search quota was
  // exhausted - which it routinely is, so the desk failed at the very end of every
  // run. THE FIX (and the answer to "what AI would it use?"): Gemini's grounded web
  // search FIRST when its quota allows; otherwise fall back to the Groq lane
  // reasoning STRICTLY over the live ground-truth we inject (verified facts + dated
  // Finnhub headlines + insider activity) with those real headline URLs as the
  // citation set. That fallback is NOT a stale recall - it's anchored to data we
  // fetched seconds ago and guarded by the profitability claim-check. We only fall
  // back when we actually HAVE ground-truth; with none (unknown ticker) we still
  // 429 rather than serve an unanchored read.
  const isDesk = body.task === "deep_research" || body.task === undefined;
  const fullChain = providerChain();
  // GROUND TRUTH (desk only): fetch the ticker's authoritative current facts +
  // recent headlines so we can anchor the prompt, claim-check the result, AND give
  // the non-grounded fallback real data + real citations. Best-effort; the 5 calls
  // run in parallel (~1-2s). Fetched up-front so the chain can decide whether the
  // Groq fallback is allowed to answer.
  const groundTruth = isDesk && body.ticker ? await fetchGroundTruth(body.ticker, body.companyName) : null;
  // Desk chain: grounded Gemini first; then the Groq/OpenAI lanes as a fallback that
  // is gated (in the loop) on having ground-truth to anchor it. A single empty/
  // truncated Gemini PARSE gets one fresh-key retry below (NOT a thrown/timeout
  // error - retrying a timeout would double the wait past the client's budget).
  const geminiLane = fullChain.filter((p) => p.name === "gemini");
  const fallbackLanes = fullChain.filter((p) => p.name !== "gemini");
  const chain = isDesk ? [...geminiLane, ...fallbackLanes] : fullChain;
  const deskEmptyRetries = isDesk ? 1 : 0;
  if (chain.length === 0) {
    if (isDesk) {
      // No LLM provider at all - refuse rather than serve a stale read.
      return json(
        {
          error: "Research is not configured — set GEMINI_API_KEY (grounded) or the LLM fallback.",
          detail: "deep_research requires a working GEMINI_API_KEY pool or LLM_API_KEY fallback",
        },
        429,
      );
    }
    return json(
      {
        error:
          "No LLM provider configured. Set GEMINI_API_KEY, or LLM_API_KEY + LLM_BASE_URL + LLM_MODEL.",
      },
      500,
    );
  }
  const prompt = buildUserPrompt(body, groundTruth ? verifiedFactsBlock(groundTruth) : undefined);
  const errors: string[] = [];

  for (const provider of chain) {
    // Desk fallback gate: a non-grounded lane (Groq/OpenAI) may only answer when we
    // have live ground-truth to anchor it. With none (unknown ticker) skip it and
    // let the desk 429 below - never serve an unanchored stale read.
    if (isDesk && provider.name !== "gemini" && !groundTruth) {
      errors.push(`${provider.name}: skipped (no ground-truth to anchor a non-grounded read)`);
      continue;
    }
    // Extra in-place retries for an EMPTY parse only (fresh round-robin key). A
    // thrown/timeout error breaks immediately (no retry) so we never double the wait.
    let emptyRetries = provider.name === "gemini" ? deskEmptyRetries : 0;
    for (;;) {
      try {
        const { text, citations: grounded, model } = await provider.run(prompt);
        let parsed = extractJson(text) ?? {};
        let effModel = model;
        let structured2step = false;
        let debate: DebateResult["debate"] | null = null;

        // 2-STEP STRUCTURE (the real desk fix): the grounded Gemini step did the web
        // research (grounded URLs present) but its inline JSON is verbose/truncated -
        // the exact case that produced the false "busy". Hand its research NOTES to the
        // Groq lane (json_object mode never truncates the schema) to reorganize into
        // valid JSON. Citations stay the REAL grounded URLs, so the desk is BOTH a true
        // grounded agent AND reliable. Only fires when the direct parse failed.
        const rawUsable =
          Boolean(parsed.summary) ||
          (Array.isArray(parsed.bullPoints) && parsed.bullPoints.length > 0) ||
          (Array.isArray(parsed.bearPoints) && parsed.bearPoints.length > 0) ||
          (Array.isArray(parsed.themes) && parsed.themes.length > 0);
        const groqReady = Boolean(LLM_API_KEY && LLM_BASE_URL && LLM_MODEL);
        // Run the debate/structurer whenever Gemini produced a substantial research
        // read AND we can anchor it - EITHER it grounded (real web chunks) OR we have
        // verified ground-truth facts. Gemini's grounding is inconsistent (25 chunks
        // one call, 0 the next), so gating on grounded.length>0 alone skipped the
        // debate half the time; the verified facts keep the no-grounding case honest.
        const canRefine =
          isDesk &&
          provider.name === "gemini" &&
          text.trim().length > 200 &&
          groqReady &&
          (grounded.length > 0 || Boolean(groundTruth));

        // DESK DEBATE (primary structuring): run Bull/Bear/Judge over the grounded
        // research notes → a judged, structured verdict. This is the desk's brain - it
        // structures the JSON reliably AND adds the adversarial bull/bear/judge panes
        // (stance, confidence, key catalysts/risks). Falls through to the plain
        // structurer below if any debate leg fails.
        if (canRefine) {
          try {
            const subj = body.ticker ?? body.companyName ?? "this company";
            const d = await runDebate(text, subj, grounded.map((c) => c.url), groundTruth);
            if (d) {
              parsed = d.parsed;
              debate = d.debate;
              effModel = `${model} → debate (${d.model})`;
              structured2step = true;
              console.log(
                `[research-agent] debate verdict stance=${d.debate.stance} conf=${d.debate.confidence}`,
              );
            }
          } catch (e) {
            errors.push(`debate: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // FALLBACK structurer: only if the debate didn't run/failed AND the direct
        // Gemini parse is unusable - reorganize the grounded notes into JSON the plain
        // way (json_object mode never truncates the schema). Citations stay real.
        if (!structured2step && !rawUsable && canRefine) {
          try {
            const subj = body.ticker ?? body.companyName ?? "this company";
            const s = await callOpenAICompatible(
              buildStructurePrompt(text, subj, grounded.map((c) => c.url)),
            );
            const sp = extractJson(s.text);
            if (
              sp &&
              (Boolean(sp.summary) ||
                (Array.isArray(sp.bullPoints) && sp.bullPoints.length > 0) ||
                (Array.isArray(sp.bearPoints) && sp.bearPoints.length > 0))
            ) {
              parsed = sp;
              effModel = `${model} → ${s.model} (2-step)`;
              structured2step = true;
              console.log(`[research-agent] 2-step structure applied (${grounded.length} grounded sources)`);
            }
          } catch (e) {
            errors.push(`structure: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        const modelCitations: Citation[] = Array.isArray(parsed.citations)
          ? parsed.citations.filter((c: any) => c?.url && c?.title)
          : [];
        // DATA INTEGRITY: only attribute citations we KNOW are real.
        // - Grounded Gemini returns real `grounded` URLs it actually retrieved → trust
        //   its cited JSON (or fall back to the grounded set).
        // - The Groq/OpenAI fallback has NO live web - any "citations" it invents are
        //   model-fabricated and must never show. BUT on the desk we fed it the REAL
        //   dated Finnhub headlines (groundTruth.news); those URLs ARE real sources we
        //   fetched, so we attribute THEM: keep model citations that match a real news
        //   URL, else attach the news list directly. No grounding + no news → no cites.
        let citations: Citation[];
        if (grounded.length > 0) {
          // 2-step: the structurer (no web) may echo URLs - trust ONLY the real
          // grounded set it was given. Direct Gemini parse: prefer its own cited JSON.
          citations = structured2step ? grounded : modelCitations.length > 0 ? modelCitations : grounded;
        } else if (isDesk && groundTruth?.news && groundTruth.news.length > 0) {
          const realUrls = new Set(groundTruth.news.map((n) => n.url));
          const fromModel = modelCitations.filter((c) => realUrls.has(c.url));
          citations =
            fromModel.length > 0
              ? fromModel
              : groundTruth.news.slice(0, 6).map((n) => ({
                  title: n.title,
                  url: n.url,
                  source: n.source,
                  publishedAt: n.date,
                }));
        } else {
          citations = [];
        }

        const suggestions = Array.isArray(parsed.suggestions)
          ? parsed.suggestions
              .map((s: any) => ({
                ticker: typeof s?.ticker === "string" ? s.ticker.trim().toUpperCase() : "",
                name: typeof s?.name === "string" ? s.name.trim() : "",
                rationale: typeof s?.rationale === "string" ? s.rationale.trim() : "",
              }))
              .filter((s: any) => s.ticker)
          : [];

        const hasUsable =
          Boolean(parsed.summary) ||
          (Array.isArray(parsed.bullPoints) && parsed.bullPoints.length > 0) ||
          (Array.isArray(parsed.bearPoints) && parsed.bearPoints.length > 0) ||
          (Array.isArray(parsed.themes) && parsed.themes.length > 0) ||
          suggestions.length > 0;

        // Empty/garbage payload (often a truncated parse). Retry the same lane once
        // with a fresh key before giving up on it.
        if (!hasUsable) {
          if (emptyRetries > 0) {
            emptyRetries--;
            errors.push(`${provider.name}: empty result (retrying)`);
            continue;
          }
          errors.push(`${provider.name}: empty result`);
          break;
        }

        // CLAIM-CHECK (the owner's #1 rule): drop any model bull/bear point that contradicts the
        // verified profitability fact. The "SoFi unprofitable" failure dies here even if the
        // model ignores the injected facts.
        let bullPoints: string[] = Array.isArray(parsed.bullPoints)
          ? parsed.bullPoints.filter((p: unknown): p is string => typeof p === "string")
          : [];
        let bearPoints: string[] = Array.isArray(parsed.bearPoints)
          ? parsed.bearPoints.filter((p: unknown): p is string => typeof p === "string")
          : [];
        if (groundTruth) {
          const b = scrubProfitabilityContradictions(bullPoints, groundTruth.profitability);
          const br = scrubProfitabilityContradictions(bearPoints, groundTruth.profitability);
          bullPoints = b.kept;
          bearPoints = br.kept;
          if (b.dropped + br.dropped > 0) {
            console.warn(
              `[research-agent] claim-check dropped ${b.dropped + br.dropped} point(s) contradicting ${groundTruth.ticker} profitability=${groundTruth.profitability}`,
            );
          }
        }

        const intel = {
          ticker: parsed.ticker ?? body.ticker ?? null,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          bullPoints,
          bearPoints,
          themes: Array.isArray(parsed.themes) ? parsed.themes : [],
          suggestions,
          sentiment: typeof parsed.sentiment === "number" ? parsed.sentiment : 0,
          citations,
          generatedAt: new Date().toISOString(),
          model: effModel,
          provider: provider.name,
          // Honest provenance for the UI: "web" = Gemini live google_search; "market-data"
          // = Groq/OpenAI synthesis anchored to the live ground-truth we injected (not a
          // stale recall); "none" = ungrounded (non-desk tasks only).
          grounding: grounded.length > 0 ? "web" : isDesk && groundTruth ? "market-data" : "none",
          // Authoritative facts the desk renders as a trust strip (price,
          // profitability, market cap, recent insider buys/sells). Present only
          // when we could fetch them; the client shows them verbatim, never guessed.
          verifiedFacts: groundTruth ?? undefined,
          // Bull/Bear/Judge debate output for the desk's three panes (bull case, bear
          // case, judge verdict with stance/confidence/key catalysts/risks). Present
          // only when the debate ran; the client falls back to bull/bearPoints otherwise.
          debate: debate ?? undefined,
        };
        return json(intel);
      } catch (err) {
        errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
        break; // thrown/timeout - do not retry; move to the next provider (or 429/502)
      }
    }
  }

  // Every provider failed. For the grounded desk, surface 429 so the client shows
  // "the research desk is busy - give it a minute and try again" rather than ever
  // serving (or implying) a stale ungrounded read. Other tasks return 502.
  if (isDesk) {
    return json(
      {
        error: "The research desk is busy — give it a minute and try again.",
        detail: errors.join(" | "),
      },
      429,
    );
  }
  return json({ error: "All research providers failed", detail: errors.join(" | ") }, 502);
});
