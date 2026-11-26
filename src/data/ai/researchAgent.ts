import type {
  CallScore,
  CitedClaim,
  FilingRef,
  InsiderTxn,
  ResearchDebate,
  ResearchIntel,
  SpanCitation,
  TickerSuggestion,
  VerifiedFacts,
} from "@/types";
import { isResearchProxyConfigured, postJson, researchProxyUrl } from "@/data/http";
import { peekApiAllowed } from "@/lib/apiUsage";

/**
 * Optional AI research lane.
 *
 * The desktop client must NOT hold LLM or web-search API keys (anything in the
 * bundle is public). Instead the user hosts a small server-side agent behind
 * `VITE_RESEARCH_PROXY_URL` - a Supabase Edge Function, Cloudflare Worker, or a
 * tiny service - that performs the web research with an AI agent and returns the
 * `ResearchIntel` contract below. This keeps secrets server-side and avoids any
 * prohibited scraping. Discovery/research only - the proxy must not return
 * buy/sell advice.
 *
 * Expected request (POST JSON):
 *   { ticker?, companyName?, narrative?, themes?: string[], task: "deep_research" | "theme_expand" }
 * Expected response (JSON): ResearchIntel
 */

export interface ResearchAgentRequest {
  ticker?: string;
  companyName?: string;
  narrative?: string;
  themes?: string[];
  task: "deep_research" | "theme_expand" | "discover";
}

export function isResearchAgentAvailable(): boolean {
  return isResearchProxyConfigured();
}

/**
 * Live availability of the AI research lane, for UI surfaces that must explain
 * themselves instead of failing:
 *  - `off` - no proxy configured (or Sample data mode): the lane doesn't exist.
 *  - `paused` - configured, but the Operator console's daily budget for the
 *               proxy is spent (or live data is paused). Resets at local midnight.
 *  - `ready` - configured and within budget.
 *
 * Peeking never reserves a call slot. Pair with `subscribeApiUsage` to stay live.
 */
export type ResearchAgentLane = "off" | "paused" | "ready";

export interface ResearchAgentStatus {
  lane: ResearchAgentLane;
  /** Operator-facing cause when the lane is paused. */
  reason?: string;
}

export function researchAgentStatus(): ResearchAgentStatus {
  const url = researchProxyUrl();
  if (!url) return { lane: "off" };
  const gate = peekApiAllowed(url);
  if (!gate.allowed) return { lane: "paused", reason: gate.reason };
  return { lane: "ready" };
}

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,6}$/;

/** Drop citations that repeat a URL - the grounded model often cites the same
 *  filing/article twice, which both clutters the list and collided on the React
 *  `key={c.url}` in the desk (a render error that surfaced AS "diligence broke"). */
function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const u = it.url.trim();
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(it);
  }
  return out;
}

function coerceSuggestions(raw: unknown): TickerSuggestion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: TickerSuggestion[] = [];
  for (const item of raw) {
    const obj = item as Partial<TickerSuggestion>;
    const ticker = typeof obj.ticker === "string" ? obj.ticker.trim().toUpperCase() : "";
    if (!ticker || !TICKER_RE.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({
      ticker,
      name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : ticker,
      rationale: typeof obj.rationale === "string" ? obj.rationale.trim() : undefined,
    });
    if (out.length >= 12) break;
  }
  return out.length > 0 ? out : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function strList(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, max);
  return out.length > 0 ? out : undefined;
}

/** 0–100 integer, or `null` for an explicit "unavailable" read. */
function coerceScore0to100(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function coerceFilings(raw: unknown): FilingRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FilingRef[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Partial<FilingRef>;
    const form = str(o.form);
    if (!form) continue;
    out.push({
      form,
      filingDate: str(o.filingDate),
      periodOfReport: str(o.periodOfReport),
      accessionNo: str(o.accessionNo),
      url: str(o.url),
    });
    if (out.length >= 12) break;
  }
  return out.length > 0 ? out : undefined;
}

function coerceCallScore(raw: unknown): CallScore | null | undefined {
  if (raw == null) return raw === null ? null : undefined;
  if (typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const c = (o.components ?? null) as Record<string, unknown> | null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    score: coerceScore0to100(o.score) ?? null,
    label: str(o.label) ?? "unavailable",
    available: o.available === true,
    reason: str(o.reason),
    source: str(o.source),
    callDate: str(o.callDate),
    components: c
      ? {
          preparedRemarksSentiment: num(c.preparedRemarksSentiment),
          qaSentiment: num(c.qaSentiment),
          toneGap: num(c.toneGap),
          guidanceDirection: str(c.guidanceDirection),
          guidanceScore: num(c.guidanceScore),
          preparedChunks: num(c.preparedChunks),
          qaChunks: num(c.qaChunks),
        }
      : undefined,
  };
}

function coerceCitedClaims(raw: unknown, side: "bull" | "bear"): CitedClaim[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CitedClaim[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Partial<CitedClaim>;
    const claim = str(o.claim);
    if (!claim) continue;
    const citations: SpanCitation[] = [];
    if (Array.isArray(o.citations)) {
      for (const cc of o.citations) {
        const c = (cc ?? {}) as Partial<SpanCitation>;
        const source = str(c.source);
        if (!source) continue;
        citations.push({
          spanId: str(c.spanId),
          source,
          date: str(c.date),
          url: str(c.url),
          quote: str(c.quote),
        });
        if (citations.length >= 6) break;
      }
    }
    out.push({
      claim,
      side: str(o.side) ?? side,
      kind: str(o.kind) ?? "primary",
      citations,
      quotedNumbers: strList(o.quotedNumbers, 12),
    });
    if (out.length >= 8) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The Bull/Bear/Judge debate. Defensive: every field is optional and arrays
 * default to []. Returns `undefined` unless at least one of the prose sides is
 * present (an empty debate is no debate - let the desk fall back to cited
 * claims). Confidence is clamped to a 0–100 integer.
 */
function coerceDebate(raw: unknown): ResearchDebate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const bull = str(o.bull) ?? "";
  const bear = str(o.bear) ?? "";
  if (!bull && !bear) return undefined;
  const stance = o.stance;
  const validStance =
    stance === "bullish" || stance === "bearish" || stance === "mixed" ? stance : undefined;
  const confidence = coerceScore0to100(o.confidence);
  return {
    bull,
    bear,
    stance: validStance,
    confidence: typeof confidence === "number" ? confidence : undefined,
    keyCatalysts: strList(o.keyCatalysts, 8) ?? [],
    keyRisks: strList(o.keyRisks, 8) ?? [],
  };
}

/**
 * Authoritative server-fetched facts (price / profitability / valuation /
 * insider flow). Requires a ticker; profitability narrows to the three known
 * values (anything else → "unknown"). Insider lists cap at 5 each.
 */
function coerceVerifiedFacts(raw: unknown): VerifiedFacts | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const ticker = str(o.ticker);
  if (!ticker) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const prof = o.profitability;
  const profitability: VerifiedFacts["profitability"] =
    prof === "profitable" || prof === "unprofitable" ? prof : "unknown";
  const coerceTxns = (v: unknown): InsiderTxn[] => {
    if (!Array.isArray(v)) return [];
    const out: InsiderTxn[] = [];
    for (const item of v) {
      const t = (item ?? {}) as Record<string, unknown>;
      const name = str(t.name);
      if (!name) continue;
      out.push({
        name,
        code: str(t.code) ?? "",
        shares: n(t.shares) ?? 0,
        change: n(t.change) ?? 0,
        price: n(t.price) ?? 0,
        date: str(t.date) ?? "",
        valueUsd: n(t.valueUsd) ?? 0,
      });
      if (out.length >= 5) break;
    }
    return out;
  };
  return {
    ticker: ticker.toUpperCase(),
    name: str(o.name),
    price: n(o.price),
    dayChangePct: n(o.dayChangePct),
    marketCapB: n(o.marketCapB),
    industry: str(o.industry),
    epsTTM: n(o.epsTTM),
    peTTM: n(o.peTTM),
    revenueGrowthYoYPct: n(o.revenueGrowthYoYPct),
    week52High: n(o.week52High),
    week52Low: n(o.week52Low),
    profitability,
    profitabilityBasis: str(o.profitabilityBasis),
    asOf: typeof o.asOf === "string" ? o.asOf : null,
    insiderBuys: coerceTxns(o.insiderBuys),
    insiderSells: coerceTxns(o.insiderSells),
  };
}

function coerceIntel(raw: unknown, fallbackTicker?: string): ResearchIntel {
  const obj = (raw ?? {}) as Partial<ResearchIntel>;
  return {
    ticker: obj.ticker ?? fallbackTicker,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    bullPoints: Array.isArray(obj.bullPoints) ? obj.bullPoints.slice(0, 8) : undefined,
    bearPoints: Array.isArray(obj.bearPoints) ? obj.bearPoints.slice(0, 8) : undefined,
    themes: Array.isArray(obj.themes) ? obj.themes.slice(0, 16) : undefined,
    suggestions: coerceSuggestions(obj.suggestions),
    sentiment: typeof obj.sentiment === "number" ? obj.sentiment : undefined,
    citations: Array.isArray(obj.citations)
      ? dedupeByUrl(
          obj.citations.filter((c): c is ResearchIntel["citations"][number] =>
            Boolean(c && c.url && c.title),
          ),
        ).slice(0, 12)
      : [],
    generatedAt: obj.generatedAt ?? new Date().toISOString(),
    model: obj.model,
    // ---- Research Desk superset (all optional; absent on the thin lane) ----
    thesis: str(obj.thesis),
    confidence: coerceScore0to100(obj.confidence),
    whatWouldFlipIt: strList(obj.whatWouldFlipIt, 8),
    callScore: coerceCallScore(obj.callScore),
    asOfDate: str(obj.asOfDate),
    filingsUsed: coerceFilings(obj.filingsUsed),
    citedBull: coerceCitedClaims(obj.citedBull, "bull"),
    citedBear: coerceCitedClaims(obj.citedBear, "bear"),
    debate: coerceDebate(obj.debate),
    verifiedFacts: coerceVerifiedFacts(obj.verifiedFacts),
    grounding: str(obj.grounding),
  };
}

/**
 * Why the desk lane failed, so UI surfaces can pick honest copy instead of
 * leaking a raw `HTTP 500` / `signal is aborted` string at the user:
 *  - `unconfigured` - no `VITE_RESEARCH_PROXY_URL` (the lane doesn't exist).
 *  - `timeout` - the proxy didn't answer before the deadline (cold runs are slow).
 *  - `rate_limited` - the proxy / usage gate is throttling (429, daily budget, pause).
 *  - `bad_request` - the proxy rejected the request (4xx → likely misconfigured).
 *  - `unreachable` - network failure or a 5xx (service down / DNS / CORS).
 *  - `empty` - a 2xx with no usable intel for this ticker.
 */
export type ResearchProxyErrorKind =
  | "unconfigured"
  | "timeout"
  | "rate_limited"
  | "bad_request"
  | "unreachable"
  | "empty";

export class ResearchProxyError extends Error {
  readonly kind: ResearchProxyErrorKind;
  constructor(message: string, kind: ResearchProxyErrorKind = "unreachable") {
    super(message);
    this.name = "ResearchProxyError";
    this.kind = kind;
  }
}

const UNAVAILABLE_MSG = "Research service unavailable — try again.";
const TIMEOUT_MSG =
  "The research desk timed out before it answered. A cold per-ticker run can take up to two minutes — try again.";
const RATE_LIMITED_MSG =
  "The research desk is busy right now (rate-limited). Give it a minute and try again.";
const BAD_REQUEST_MSG =
  "The research desk couldn’t process that request — its endpoint may be misconfigured.";

/**
 * Map a raw transport error (from {@link postJson}) to an honest, user-facing
 * `ResearchProxyError`. The desk client must NEVER surface a bare `HTTP 500` or
 * an `AbortError` - those are confusing and look like a crash. Usage-gate
 * reasons (pause / budget / sample mode) are already honest, so we pass them
 * through unchanged.
 */
function classifyProxyError(err: unknown): ResearchProxyError {
  const name = err instanceof Error ? err.name : "";
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";

  // AbortController fired (the timeout). DOMException name is "AbortError".
  if (name === "AbortError" || /\babort/i.test(raw)) {
    return new ResearchProxyError(TIMEOUT_MSG, "timeout");
  }

  // Non-OK HTTP - postJson throws `new Error("HTTP <status>")`.
  const http = raw.match(/HTTP (\d{3})/);
  if (http) {
    const status = Number(http[1]);
    if (status === 429) return new ResearchProxyError(RATE_LIMITED_MSG, "rate_limited");
    if (status >= 400 && status < 500) return new ResearchProxyError(BAD_REQUEST_MSG, "bad_request");
    // 5xx - include the code so a screenshot is self-diagnosing (gateway vs fn crash).
    return new ResearchProxyError(`${UNAVAILABLE_MSG} (server ${status})`, "unreachable");
  }

  // Usage-gate short-circuits (already honest, user-facing copy) - keep the text.
  if (/paused|budget|Sample data mode/i.test(raw)) {
    return new ResearchProxyError(raw, "rate_limited");
  }

  // Everything else is a network failure (Failed to fetch / NetworkError / DNS / CORS,
  // or the Tauri plugin-http transport). Surface the raw reason so a screenshot tells
  // us WHICH - a bare "unavailable" hid the cause through ~18 fix attempts.
  const detail = (name || raw || "network").toString().slice(0, 60);
  return new ResearchProxyError(`${UNAVAILABLE_MSG} (${detail})`, "unreachable");
}

/** Run the hosted agent. Throws `ResearchProxyError` when unconfigured or failing. */
export async function runResearchAgent(
  req: ResearchAgentRequest,
  options?: { timeoutMs?: number },
): Promise<ResearchIntel> {
  // Route per task: `deep_research` → the desk, discovery/theme → the data
  // agent. This is the fix for the Blueprint "hit a snag" - the desk endpoint
  // rejects `discover`/`theme_expand` with a 400, so they must go to the agent.
  const url = researchProxyUrl(req.task);
  if (!url) {
    throw new ResearchProxyError(
      "AI research is not connected in this build. Set VITE_RESEARCH_PROXY_URL to your hosted desk endpoint.",
      "unconfigured",
    );
  }
  let raw: unknown;
  // Retry ONCE on a transient transport failure (a gateway 5xx or a network blip - both classify
  // as "unreachable" and fail fast, not after the 120s budget). A 4xx/unconfigured/timeout is
  // NOT retried (a 4xx won't change; a timeout already waited the full budget).
  let lastErr: ResearchProxyError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      // Gemini-backed grounded research is slow; give it a real 120s budget unless
      // a caller overrides. (postJson defaults to 30s, which aborted every run.)
      raw = await postJson<unknown>(url, req, options?.timeoutMs ?? 120_000);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = classifyProxyError(err);
      if (lastErr.kind === "unreachable" && attempt === 0) continue; // one transient retry
      throw lastErr;
    }
  }
  if (lastErr) throw lastErr;

  // The desk's `deep_research` task returns the cited superset (thesis +
  // citedBull/citedBear + whatWouldFlipIt + confidence), often with NO `summary`
  // - the headline lives in `thesis`. The thin `discover`/`theme` lane returns
  // summary/themes/suggestions instead. Accept BOTH: any meaningful field counts
  // as a usable read. (Regression: the old gate only checked summary/themes/
  // suggestions, so a perfectly good desk response was rejected as "no result".)
  const intel = coerceIntel(raw, req.ticker);
  const hasUsable =
    Boolean(intel.summary) ||
    Boolean(intel.thesis) ||
    (intel.bullPoints?.length ?? 0) > 0 ||
    (intel.bearPoints?.length ?? 0) > 0 ||
    (intel.citedBull?.length ?? 0) > 0 ||
    (intel.citedBear?.length ?? 0) > 0 ||
    Boolean(intel.debate?.bull) ||
    Boolean(intel.debate?.bear) ||
    (intel.whatWouldFlipIt?.length ?? 0) > 0 ||
    intel.confidence != null ||
    (intel.callScore?.available ?? false) ||
    (intel.themes?.length ?? 0) > 0 ||
    (intel.suggestions?.length ?? 0) > 0;
  if (!hasUsable) {
    throw new ResearchProxyError(
      `The research desk returned an empty read${req.ticker ? ` for ${req.ticker}` : ""}. Try again, or pick another ticker.`,
      "empty",
    );
  }
  return intel;
}
