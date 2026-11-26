/** Shared HTTP helpers for sanctioned market-data APIs (Finnhub, FMP, Yahoo RSS, …). */

import { checkApiAllowed, hasVisionKey, recordApiCall, type ApiVendorId } from "@/lib/apiUsage";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import {
  finnhubRetryUrl,
  isMarketProxyConfigured,
  isRateLimitStatus,
  resolveMarketRequest,
  secondFinnhubKey,
} from "@/data/marketProxy";

const SAMPLE_MODE_BLOCKED_MESSAGE =
  "Live data request blocked because Sample data mode is enabled.";
const activeRequests = new Set<AbortController>();

/**
 * Sentinel returned by the vendor-key getters on a KEYLESS build - one with no
 * local `VITE_*_API_KEY` but with `VITE_MARKET_PROXY_URL` set (the production
 * web/phone bundle). It only ever rides in a query param (`token`/`apikey`) or
 * an `APCA-API-*` header that {@link resolveMarketRequest} STRIPS before the
 * request leaves the client, so it never reaches a vendor - the hosted proxy
 * re-attaches the real key server-side. It exists purely so the `is*Configured`
 * gates + provider selection treat the proxy as a live source on a bundle that
 * ships zero secrets. In DIRECT mode (no proxy) it is never produced, so the
 * desktop/dev path is byte-for-byte unchanged.
 */
export const PROXY_INJECTED_KEY = "__proxy_injected__";

export function abortLiveDataRequests(): void {
  for (const controller of activeRequests) controller.abort();
  activeRequests.clear();
}

export function isFinnhubKeyPresent(): boolean {
  return Boolean(import.meta.env.VITE_FINNHUB_API_KEY?.trim());
}

// Round-robin pool of local Finnhub keys (VITE_FINNHUB_API_KEY + _2.._7). ONLY
// populated in keyed builds - i.e. the daily universe scan, whose .env carries the
// real keys. The keyless web/desktop bundle inlines all of these as EMPTY (the
// keyless-web guard enforces it), so the pool is empty there and finnhubKey() falls
// through to the proxy placeholder. Rotating matters for the scan: it makes ~3000
// Finnhub calls across 500 names; with ONE key at the free 60/min limit it throttled
// ~2/3 of names into a SYNTHETIC fallback (which leaked fake trillion-dollar caps
// onto the board - the owner's #1 rule). Spreading across all 7 keys (7×60=420/min) keeps
// the scan under the limit so names get REAL caps/fundamentals.
// Read the local Finnhub key pool fresh each call (env is mutated at runtime by
// vite-node's .env load and by tests, so a module-load snapshot would be stale).
function finnhubKeyPool(): string[] {
  const names = [
    "VITE_FINNHUB_API_KEY",
    "VITE_FINNHUB_API_KEY_2",
    "VITE_FINNHUB_API_KEY_3",
    "VITE_FINNHUB_API_KEY_4",
    "VITE_FINNHUB_API_KEY_5",
    "VITE_FINNHUB_API_KEY_6",
    "VITE_FINNHUB_API_KEY_7",
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const v = (import.meta.env[n] as string | undefined)?.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
let finnhubCursor = 0;

export function finnhubKey(): string | undefined {
  if (isSampleDataModeEnabled()) return undefined;
  const pool = finnhubKeyPool();
  if (pool.length > 0) {
    const key = pool[finnhubCursor % pool.length];
    finnhubCursor = (finnhubCursor + 1) % pool.length;
    return key;
  }
  // Keyless build: the hosted proxy injects the real key (placeholder stripped).
  return isMarketProxyConfigured() ? PROXY_INJECTED_KEY : undefined;
}

export function isFinnhubConfigured(): boolean {
  return Boolean(finnhubKey());
}

export function isFmpKeyPresent(): boolean {
  return Boolean(import.meta.env.VITE_FMP_API_KEY?.trim());
}

// Round-robin pool of local FMP keys (VITE_FMP_API_KEY + _2.._4, or a
// comma-separated VITE_FMP_API_KEYS). ONLY populated in keyed builds - i.e. the
// daily universe scan, whose .env carries the real keys. The keyless web/desktop
// bundle inlines these as EMPTY, so the pool is empty there and fmpKey() falls
// through to the proxy placeholder, exactly as before.
// Rotating matters for the scan: hundreds of FMP calls per run all hit ONE key on
// FMP's free tier (~250/day cap), so a single key exhausted almost every call
// (501/502 failures). Spreading across 4 keys (4×250=1000/day) keeps the scan
// under each key's cap. Read fresh each call (env can be mutated at runtime by
// vite-node's .env load and by tests, so a module-load snapshot would be stale).
function fmpKeyPool(): string[] {
  const names = ["VITE_FMP_API_KEY", "VITE_FMP_API_KEY_2", "VITE_FMP_API_KEY_3", "VITE_FMP_API_KEY_4"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const v = (import.meta.env[n] as string | undefined)?.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  const csv = (import.meta.env.VITE_FMP_API_KEYS as string | undefined)?.trim();
  if (csv) {
    for (const raw of csv.split(",")) {
      const v = raw.trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}
let fmpCursor = 0;

/**
 * Next FMP key in the round-robin pool. A pool of 0 or 1 behaves EXACTLY like
 * the historical `fmpKey()` (same single-key / proxy-injected / sample-mode
 * fallback below) - rotation only kicks in once a 2nd+ key is configured.
 */
export function nextFmpKey(): string | undefined {
  if (isSampleDataModeEnabled()) return undefined;
  const pool = fmpKeyPool();
  if (pool.length > 0) {
    const key = pool[fmpCursor % pool.length];
    fmpCursor = (fmpCursor + 1) % pool.length;
    return key;
  }
  // Keyless build: the hosted proxy injects the real key (placeholder stripped).
  return isMarketProxyConfigured() ? PROXY_INJECTED_KEY : undefined;
}

export function fmpKey(): string | undefined {
  if (isSampleDataModeEnabled()) return undefined;
  const local = import.meta.env.VITE_FMP_API_KEY?.trim();
  if (local) return local;
  // Keyless build: the hosted proxy injects the real key (placeholder stripped).
  return isMarketProxyConfigured() ? PROXY_INJECTED_KEY : undefined;
}

export function isFmpConfigured(): boolean {
  return Boolean(fmpKey());
}

export function isAlpacaKeyPresent(): boolean {
  return Boolean(
    import.meta.env.VITE_ALPACA_API_KEY?.trim() &&
      import.meta.env.VITE_ALPACA_API_SECRET?.trim(),
  );
}

/** Alpaca Market Data - news wire (free with a paper account). */
export function alpacaKeyId(): string | undefined {
  if (isSampleDataModeEnabled()) return undefined;
  const local = import.meta.env.VITE_ALPACA_API_KEY?.trim();
  if (local) return local;
  // Keyless build: the proxy re-attaches the real APCA headers (stripped here).
  return isMarketProxyConfigured() ? PROXY_INJECTED_KEY : undefined;
}

export function alpacaSecret(): string | undefined {
  if (isSampleDataModeEnabled()) return undefined;
  const local = import.meta.env.VITE_ALPACA_API_SECRET?.trim();
  if (local) return local;
  // Keyless build: the proxy re-attaches the real APCA headers (stripped here).
  return isMarketProxyConfigured() ? PROXY_INJECTED_KEY : undefined;
}

export function isAlpacaConfigured(): boolean {
  return Boolean(alpacaKeyId() && alpacaSecret());
}

export function isResearchProxyPresent(): boolean {
  return Boolean(import.meta.env.VITE_RESEARCH_PROXY_URL?.trim());
}

/**
 * Research tasks split across TWO server-side endpoints, because they are
 * genuinely different services:
 *
 *  - The DATA / DISCOVERY agent (`VITE_RESEARCH_PROXY_URL`) - the Supabase
 *    `research-agent` edge function. Serves `discover` (Blueprint niche search),
 *    `theme_expand`, `price_targets` (real Yahoo consensus), and
 *    `catalyst_extract`. Gemini-backed, with server-side key failover.
 *  - The deep-research DESK (`VITE_RESEARCH_DESK_URL`, OPTIONAL) - a heavier
 *    per-ticker diligence service (e.g. the hosted HF Space) that ONLY answers
 *    `deep_research`. When unset, `deep_research` falls back to the data agent
 *    (the Supabase function answers `deep_research` too), so a single-endpoint
 *    deploy (the desktop `.env`) keeps working unchanged.
 *
 * Routing by task is what fixes the Blueprint "hit a snag": the desk endpoint
 * 400s on `discover`/`theme_expand`/`price_targets` ("route discovery tasks to
 * the existing function"), so sending those there made the AI lane fail every
 * run. Each task now goes to an endpoint that actually serves it.
 */
export type ResearchTask =
  | "deep_research"
  | "theme_expand"
  | "discover"
  | "price_targets"
  | "catalyst_extract";

/** Tasks the dedicated deep-research desk (`VITE_RESEARCH_DESK_URL`) serves. */
const DESK_TASKS: ReadonlySet<ResearchTask> = new Set(["deep_research"]);

function researchDeskUrlRaw(): string | undefined {
  return import.meta.env.VITE_RESEARCH_DESK_URL?.trim() || undefined;
}

/**
 * URL of the server-side AI research endpoint for a given task. Never a vendor
 * key. With no `task` it returns the data/discovery agent (the historical
 * default), so existing callers and the `is*Configured` gates are unchanged.
 *
 *  - `deep_research` → the desk (`VITE_RESEARCH_DESK_URL`) when configured,
 *    else the data agent (`VITE_RESEARCH_PROXY_URL`).
 *  - every other task → the data agent (`VITE_RESEARCH_PROXY_URL`).
 */
export function researchProxyUrl(task?: ResearchTask): string | undefined {
  if (isSampleDataModeEnabled()) return undefined;
  // The data/discovery agent - VITE_RESEARCH_PROXY_URL, the Supabase research-agent on
  // real builds. Left EXACTLY as-is so provider selection (isResearchProxyConfigured →
  // resolveProviderId) is unchanged: discovery is "configured" only when this env is set.
  const agent = import.meta.env.VITE_RESEARCH_PROXY_URL?.trim() || undefined;
  if (task && DESK_TASKS.has(task)) {
    const desk = researchDeskUrlRaw();
    // THE desktop bug (worked in browser, never on desktop): the Tauri native-HTTP
    // scope allows ONLY *.supabase.co (+ finnhub/yahoo). The build pointed `deep_research`
    // (VITE_RESEARCH_DESK_URL) at a vercel.app service, which the desktop's plugin-http
    // REJECTS before the request leaves ("url not allowed on the configured scope: …").
    // The browser has no such scope - which is why the desk worked on web and NEVER on
    // desktop. So: honor a dedicated desk endpoint ONLY when it's itself a supabase.co
    // host (in scope everywhere). Otherwise route deep_research to the in-scope Supabase
    // research-agent - derived from VITE_SUPABASE_URL so it's correct even if the agent
    // env also points off-supabase (the research-agent answers deep_research too).
    if (desk && /:\/\/[^/]*\.supabase\.co\//.test(desk)) return desk;
    const supa = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim()?.replace(/\/+$/, "");
    return supa ? `${supa}/functions/v1/research-agent` : agent;
  }
  return agent;
}

export function isResearchProxyConfigured(): boolean {
  return Boolean(researchProxyUrl());
}

/** True when any live market-data provider key is configured. */
export function isAnyLiveDataConfigured(): boolean {
  return isFinnhubConfigured() || isFmpConfigured();
}

/**
 * A non-OK HTTP response. Carries the response BODY, because several vendors
 * encode *why* they refused into the body rather than the status: FMP answers
 * 402 both for "this endpoint is not in your plan" (permanent, trip it off) and
 * for "this SYMBOL is premium" (per-ticker, must NOT disable the endpoint).
 * Telling those apart requires the text.
 *
 * `message` deliberately stays `HTTP <status>` so existing callers that parse it
 * (e.g. researchAgent's `/HTTP (\d{3})/`) keep working unchanged.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/* ── Plan-blocked endpoint breaker ─────────────────────────────────────────
 * Some vendor endpoints are simply not in the current key's plan (HTTP 402
 * "Restricted Endpoint") or have been retired for non-grandfathered keys (HTTP
 * 403 "Legacy Endpoint"). Both are PERMANENT for the life of the session - no
 * amount of retrying changes them - yet the scan re-attempts them once per
 * ticker, which is what produced thousands of daily "failed" calls in the
 * Operator board while burning the rate limit for nothing.
 *
 * Callers record the verdict once via `notePlanBlocked()` and skip the call
 * afterwards via `isPlanBlocked()`. Kept deliberately dumb: an in-memory Set,
 * cleared on reload, keyed by `vendor + endpoint path` (never the full URL, so
 * one dead endpoint doesn't trip a whole vendor and per-ticker query strings
 * don't fragment the key).
 */
const planBlocked = new Map<string, { status: number; at: number }>();

function planKey(vendor: string, path: string): string {
  return `${vendor}:${path}`;
}

/**
 * Does this refusal body mean the ENDPOINT is out of plan, or just this SYMBOL?
 *
 * FMP returns 402 for BOTH, and the difference matters enormously:
 *   - endpoint: "Restricted Endpoint: This endpoint is not available under your
 *     current subscription" → permanent, trip the whole endpoint off.
 *   - symbol:   "Premium Query Parameter: ... This value set for 'symbol' is not
 *     available under your current subscription" → MU and COST are premium on
 *     this plan while AAPL and NVDA are not. Tripping `/quote` off for that would
 *     disable every quote in the app.
 */
function refusalScope(body: string): "endpoint" | "symbol" | "unknown" {
  const b = body.toLowerCase();
  if (b.includes("premium query parameter") || b.includes("value set for")) return "symbol";
  if (b.includes("restricted endpoint") || b.includes("legacy endpoint")) return "endpoint";
  if (b.includes("this endpoint is not available")) return "endpoint";
  return "unknown";
}

/**
 * Record that `path` is outside this key's plan (402/403) - but ONLY when the
 * body says the ENDPOINT is the problem. A symbol-scoped refusal is recorded
 * against that symbol instead (see {@link notePlanBlockedSymbol}), and an
 * unrecognised body trips nothing: refusing to guess is what keeps a
 * misclassified 402 from silently disabling a working endpoint.
 */
export function notePlanBlocked(vendor: string, path: string, status: number, body = ""): void {
  if (refusalScope(body) !== "endpoint") return;
  const key = planKey(vendor, path);
  if (planBlocked.has(key)) return;
  planBlocked.set(key, { status, at: Date.now() });
  if (import.meta.env.DEV) {
    console.warn(
      `[api] ${vendor}${path} returned ${status} — endpoint outside this key's plan. ` +
        `Disabling it for this session so it stops re-failing per ticker.`,
    );
  }
}

/* Symbols the plan refuses (FMP marks some tickers premium). Re-requesting one
 * fails identically on every key, so remember it and skip - that is pure
 * failure-count reduction, and the caller degrades exactly as it already does. */
const planBlockedSymbols = new Set<string>();

export function notePlanBlockedSymbol(vendor: string, symbol: string, body = ""): void {
  if (refusalScope(body) !== "symbol") return;
  planBlockedSymbols.add(`${vendor}:${symbol.toUpperCase()}`);
}

export function isPlanBlockedSymbol(vendor: string, symbol: string): boolean {
  return planBlockedSymbols.has(`${vendor}:${symbol.toUpperCase()}`);
}

/** Premium/out-of-plan symbols seen this session (Operator diagnostics). */
export function planBlockedSymbolList(): string[] {
  return [...planBlockedSymbols];
}

/** True once `path` has answered 402/403 - skip the call entirely. */
export function isPlanBlocked(vendor: string, path: string): boolean {
  return planBlocked.has(planKey(vendor, path));
}

/** Snapshot for the Operator board: which endpoints are off, and why. */
export function planBlockedEndpoints(): Array<{ vendor: string; path: string; status: number }> {
  return [...planBlocked.entries()].map(([key, v]) => {
    const [vendor, ...rest] = key.split(":");
    return { vendor, path: rest.join(":"), status: v.status };
  });
}

/**
 * "Queryable" gates - the proxy-aware counterpart of `isFmpConfigured()` /
 * `isFinnhubConfigured()`. A vendor is queryable when we can actually reach it:
 *   - a local key is present (desktop / `npm run dev`), OR
 *   - the hosted market-data proxy is configured (production web/phone - keys
 *     live server-side and the proxy injects them, so no local key is needed).
 * Sample-data mode forces everything off.
 *
 * Terminal Phase-2/3 surfaces (movers, earnings) gate on THESE so a keyless web
 * build with `VITE_MARKET_PROXY_URL` set still fetches (the call routes through
 * `resolveMarketRequest`) instead of falling back to the unconfigured state.
 */
export function isFmpQueryable(): boolean {
  if (isSampleDataModeEnabled()) return false;
  return isFmpConfigured() || isMarketProxyConfigured();
}

export function isFinnhubQueryable(): boolean {
  if (isSampleDataModeEnabled()) return false;
  return isFinnhubConfigured() || isMarketProxyConfigured();
}

/**
 * How a vendor is actually wired in THIS build - the source of truth for the
 * "Data-source health" board, so it stops printing "No key" on the keyless
 * production bundle that reaches every vendor through the hosted market proxy.
 *
 *  - `proxy` - `VITE_MARKET_PROXY_URL` is set, so every recognized vendor URL is
 *               rewritten through the hosted proxy (keys re-attached server-side).
 *               This is checked FIRST because it mirrors the real routing in
 *               {@link resolveMarketRequest}: a proxied build never sends a local
 *               key even if one is present (it's stripped before the request).
 *  - `local` - direct-to-vendor with a local `VITE_*` key (desktop / `npm run dev`).
 *  - `server` - the Research Proxy lane: the operator's own hosted AI agent
 *               (`VITE_RESEARCH_PROXY_URL`), never a market vendor.
 *  - `none` - genuinely no path: no local key AND no proxy. The only state that
 *               should ever read "No key".
 */
export type VendorReachKind = "local" | "proxy" | "server" | "none";

export interface VendorReach {
  kind: VendorReachKind;
  /** True when the vendor can actually be queried (local key, proxy, or server). */
  reachable: boolean;
  /**
   * Backup/rotation descriptor for the vendors that genuinely have one wired,
   * else `null`. Honest about WHERE the failover lives: in proxy mode the backup
   * keys are server-side (the client can't count them - see
   * `EngineOpsSection`), so we describe the proxy's verified behavior rather than
   * asserting a key count we can't see.
   */
  failover: string | null;
}

/** Proxy-first reachability for one vendor, for the data-source health board. */
export function vendorReach(id: ApiVendorId): VendorReach {
  const proxy = isMarketProxyConfigured();
  switch (id) {
    case "finnhub": {
      const kind: VendorReachKind = proxy ? "proxy" : isFinnhubKeyPresent() ? "local" : "none";
      const failover =
        kind === "proxy"
          ? "Rotates to a backup key on a 429 · server-side"
          : kind === "local" && secondFinnhubKey()
            ? "2 keys · rotates on a 429"
            : null;
      return { kind, reachable: kind !== "none", failover };
    }
    case "finnhub_backup": {
      // The 2nd-Finnhub-key failover lane (board row only). In proxy mode the
      // rotation happens server-side, so the client can't count it - reachable,
      // but its per-key usage is honestly "server-side". In direct mode it's
      // live only when a 2nd key is actually configured.
      if (proxy) {
        return { kind: "proxy", reachable: true, failover: "Rotates in on a main-key 429 · server-side" };
      }
      const hasBackupKey = Boolean(secondFinnhubKey());
      return { kind: hasBackupKey ? "local" : "none", reachable: hasBackupKey, failover: null };
    }
    case "fmp": {
      const kind: VendorReachKind = proxy ? "proxy" : isFmpKeyPresent() ? "local" : "none";
      return { kind, reachable: kind !== "none", failover: null };
    }
    case "alpaca": {
      const kind: VendorReachKind = proxy ? "proxy" : isAlpacaKeyPresent() ? "local" : "none";
      return { kind, reachable: kind !== "none", failover: null };
    }
    case "proxy": {
      // The Research Proxy is the operator's own hosted agent, not a market
      // vendor - it routes by VITE_RESEARCH_PROXY_URL, not the market proxy.
      const present = isResearchProxyPresent();
      return {
        kind: present ? "server" : "none",
        reachable: present,
        // Server-side LLM failover (Gemini → backup → OpenAI lane), shipped c412c4f.
        failover: present ? "Backup model on failover · server-side" : null,
      };
    }
    case "vision": {
      // The screenshot-reader vision lane runs DIRECTLY against the operator's
      // own Groq (or OpenAI-compatible) key - it is never routed through the
      // market proxy. Live only when VITE_VISION_API_KEY is set; the board only
      // injects this row when keyed, so "none" is essentially defensive.
      const present = hasVisionKey();
      return { kind: present ? "local" : "none", reachable: present, failover: null };
    }
    default:
      // Keyless public endpoints (Yahoo, SEC, StockTwits, ApeWisdom) - no key
      // concept, always reachable directly.
      return { kind: "local", reachable: true, failover: null };
  }
}

/** Optional per-request controls for the shared GET helpers. */
export interface HttpGetOptions {
  /** Extra request headers (e.g. Alpaca's APCA-API-KEY-ID / -SECRET-KEY). */
  headers?: Record<string, string>;
  /** Abort the request after this many ms. Guards against large/hung feeds. */
  timeoutMs?: number;
}

/**
 * HTTP GET that works in Tauri (no CORS) and in the browser dev server.
 * Supports optional headers (keyed vendors) and a timeout (large public feeds).
 */
export async function httpText(url: string, opts: HttpGetOptions = {}): Promise<string> {
  if (isSampleDataModeEnabled()) throw new Error(SAMPLE_MODE_BLOCKED_MESSAGE);
  const { headers, timeoutMs } = opts;
  // Usage ledger: gate first (admin pause / daily budgets), record exactly once.
  const gate = checkApiAllowed(url);
  if (!gate.allowed) throw new Error(gate.reason);
  // The gate above RESERVED a call slot; it is only released inside
  // `recordApiCall`. Every path out of here after the gate MUST settle exactly
  // one `record()` or the reservation leaks for the page's lifetime (and can
  // wedge a vendor's budget gate into a phantom "busy" state). The finally
  // guarantees a failure record if nothing else recorded - including a throw
  // from the dynamic `import()` before the request is ever made.
  let recorded = false;
  // Ledger attribution for THIS call. Flips to the backup lane if the request
  // rotated to the 2nd Finnhub key below, so the board can show per-key usage.
  let ledgerVendor: ApiVendorId | undefined;
  const record = (ok: boolean) => {
    if (!recorded) {
      recorded = true;
      recordApiCall(url, ok, ledgerVendor);
    }
  };
  const controller = new AbortController();
  activeRequests.add(controller);
  // ALWAYS arm a timeout. A caller that passes no `timeoutMs` still gets a 15s
  // safety ceiling so a TCP stall / slow-loris / proxy-that-never-responds can
  // never hang the live path forever (it would emit no rejection, so the
  // caller's try/catch never fires). The abort routes through record(false) +
  // finally and surfaces as a throw the existing catches handle → honest
  // N/A/null/empty instead of an infinite hang. Per-call overrides win.
  const effectiveTimeout = timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    const tauriHttp = isTauri() ? await import("@tauri-apps/plugin-http") : null;
    // One physical GET. Both transports honor the shared AbortController so the
    // timeout/abort path is identical for direct and proxied requests.
    const fetchOnce = (target: string, h?: Record<string, string>): Promise<Response> =>
      tauriHttp
        ? tauriHttp.fetch(target, { method: "GET", headers: h, signal: controller.signal })
        : fetch(target, { method: "GET", headers: h, signal: controller.signal });

    // Single proxy-able seam: route through the hosted proxy when configured,
    // else direct-to-vendor (unchanged). Gating + recording stay keyed to the
    // ORIGINAL vendor URL above, so per-vendor budgets/ledger are unaffected by
    // proxying (the proxy host would otherwise swallow every vendor's quota).
    const target = resolveMarketRequest(url, headers);
    let res = await fetchOnce(target.url, target.headers);

    // Backup provider chain, hop #1 (client-side): on a Finnhub rate-limit in
    // DIRECT mode, retry once with the second key. In proxy mode the hosted
    // proxy owns the full chain (2nd key → Polygon → Tiingo), so we don't
    // double-try here. See src/data/marketProxy.ts + docs/program/.
    if (!res.ok && isRateLimitStatus(res.status) && !target.proxied) {
      const retryUrl = finnhubRetryUrl(url);
      if (retryUrl) {
        // Credit this call to the backup key in the ledger - the budget slot was
        // still reserved against (and is released against) the primary "finnhub".
        ledgerVendor = "finnhub_backup";
        res = await fetchOnce(retryUrl, headers);
      }
    }

    if (!res.ok) {
      // Read the body BEFORE throwing: vendors encode the reason for a refusal
      // in the text (see HttpError), and it is unrecoverable once discarded.
      const detail = await res.text().catch(() => "");
      throw new HttpError(res.status, detail.slice(0, 400));
    }
    const text = await res.text(); // success only counts once the body lands
    record(true);
    return text;
  } finally {
    // No-op if the success path recorded; otherwise records a failure (HTTP
    // error, abort/timeout, network failure, or a throw before the request).
    record(false);
    if (timer) clearTimeout(timer);
    activeRequests.delete(controller);
  }
}

export async function httpJson<T>(url: string, opts?: HttpGetOptions): Promise<T> {
  const text = await httpText(url, opts);
  return JSON.parse(text) as T;
}

/** POST JSON (used for the optional research proxy). Tauri-aware to avoid CORS. */
export async function postJson<T>(url: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  if (isSampleDataModeEnabled()) throw new Error(SAMPLE_MODE_BLOCKED_MESSAGE);
  const gate = checkApiAllowed(url);
  if (!gate.allowed) throw new Error(gate.reason);
  // The gate above RESERVED a call slot (reservedCalls[vendor] += 1). That slot
  // is only released inside `recordApiCall`, so EVERY path out of this function
  // after the gate - including a throw from the dynamic `import()` or a malformed
  // request - MUST settle exactly one `record()`. We guarantee that with a single
  // try that opens immediately after the gate and a finally that records a failure
  // if nothing else did. Skipping it would leak the reservation for the page's
  // lifetime and eventually wedge the Research Desk into a phantom "busy"/budget
  // lock (peekApiAllowed counts reservedCalls), which it could never recover from.
  let recorded = false;
  const record = (ok: boolean) => {
    if (!recorded) {
      recorded = true;
      recordApiCall(url, ok);
    }
  };
  // Both transports honor `timeoutMs`. The Tauri branch previously ignored it,
  // so a hung proxy could freeze the desktop app indefinitely - an AbortController
  // guarantees the call always settles (and the caller falls back to anchors).
  const controller = new AbortController();
  activeRequests.add(controller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const { isTauri } = await import("@tauri-apps/api/core");
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Supabase Edge Functions (research-agent / market-proxy / terminal-feed) sit
    // behind the project gateway. Even with --no-verify-jwt, an UNAUTHENTICATED POST
    // is treated more harshly (the gateway can 5xx anonymous calls under load) - the
    // exact "Research service unavailable" the desk client kept hitting while a curl
    // WITH the apikey header always returned 200. The anon key is already public in
    // the bundle (RLS-protected), so attach it to every Supabase function call so the
    // client uses the same authenticated path that works.
    const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
    if (anon && /\.supabase\.co\/functions\//.test(url)) {
      headers.apikey = anon;
      headers.Authorization = `Bearer ${anon}`;
    }
    // Same single proxy-able seam as httpText. The research proxy host is not a
    // recognized market vendor, so this is a no-op pass-through for it today; it
    // future-proofs any POST-based vendor call to flow through the hosted proxy.
    const target = resolveMarketRequest(url, headers);

    if (isTauri()) {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const res = await fetch(target.url, {
        method: "POST",
        headers: target.headers,
        body: payload,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = JSON.parse(await res.text()) as T;
      record(true);
      return parsed;
    }

    const res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: payload,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = (await res.json()) as T;
    record(true);
    return parsed;
  } finally {
    // Always release the reserved slot: a no-op if the success path already
    // recorded, a failure record otherwise (HTTP error, abort/timeout, network
    // failure, or a throw before the request - e.g. a chunk-load failure).
    record(false);
    if (timer) clearTimeout(timer);
    activeRequests.delete(controller);
  }
}
