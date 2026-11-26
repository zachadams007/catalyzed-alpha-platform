// Supabase Edge Function: market-proxy
//
// The production replacement for "keys in the client bundle". A web/phone build
// sets VITE_MARKET_PROXY_URL=<this function URL>; the client's resolveMarketRequest
// (src/data/marketProxy.ts) then rewrites every recognized vendor call to
//   <proxy>/<vendorId>/<original-path>?<original-query-without-secrets>
// and strips its own secrets. THIS function re-attaches the real key server-side,
// forwards the GET, and streams the response back - so the per-ticker workspace,
// movers, and earnings surfaces work on a keyless web/phone bundle.
//
// It is also the production replacement for the dev-only `/__sec` Vite proxy:
// the `sec` vendor relays EDGAR (which drops CORS for browsers) and adds the
// required fair-access User-Agent.
//
// Contract + responsibilities: docs/program/hosted-proxy-readiness.md.
// Keep UPSTREAM in sync with VENDOR_UPSTREAM in src/data/marketProxy.ts.
//
// Secrets (set via `supabase secrets set` - never in the client bundle):
//   FMP_API_KEY · FINNHUB_API_KEY · FINNHUB_API_KEY_2 (backup, rotated-to on ANY
//     Finnhub quota/rate failure: 429, or 403/quota body) ·
//   ALPACA_API_KEY · ALPACA_API_SECRET · SEC_CONTACT
//
// Deploy WITHOUT JWT verification (the seam sends no Supabase auth header):
//   supabase functions deploy market-proxy --no-verify-jwt
//
// Read-only by construction: GET (+ OPTIONS) only, so an injected key can never
// ride a write. Allowlisted vendors only - never an open relay.

// deno-lint-ignore-file no-explicit-any

import { shouldFailover } from "../_shared/failover.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, apca-api-key-id, apca-api-secret-key",
};

/** vendorId → upstream origin. Mirrors VENDOR_UPSTREAM in src/data/marketProxy.ts. */
const UPSTREAM: Record<string, string> = {
  finnhub: "https://finnhub.io",
  fmp: "https://financialmodelingprep.com",
  alpaca: "https://data.alpaca.markets",
  yahoo: "https://query1.finance.yahoo.com",
  stocktwits: "https://api.stocktwits.com",
  apewisdom: "https://apewisdom.io",
  // `sec` is special-cased: the subdomain depends on the path (see secOrigin).
  sec: "https://data.sec.gov",
};

/** Build a de-duped key pool from env var names (priority order). */
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

// ROUND-ROBIN key POOLS. Spreading each request across all keys keeps every
// free-tier key well under its per-minute/day cap (proactive load-balance), and
// on a quota/overload signal we fail over through the rest of the pool (reactive
// safety net). Finnhub free is 60/min PER KEY → 4 keys ≈ 240/min pooled.
const FINNHUB_KEYS = envPool([
  "FINNHUB_API_KEY",
  "FINNHUB_API_KEY_2",
  "FINNHUB_API_KEY_3",
  "FINNHUB_API_KEY_4",
  "FINNHUB_API_KEY_5",
  "FINNHUB_API_KEY_6",
  "FINNHUB_API_KEY_7",
]);
const FMP_KEYS = envPool(["FMP_API_KEY", "FMP_API_KEY_2", "FMP_API_KEY_3", "FMP_API_KEY_4"]);
const ALPACA_API_KEY = Deno.env.get("ALPACA_API_KEY") ?? "";
const ALPACA_API_SECRET = Deno.env.get("ALPACA_API_SECRET") ?? "";
const SEC_CONTACT =
  Deno.env.get("SEC_CONTACT") ?? "Catalyzed Alpha research contact@example.com";

// Round-robin cursor + per-key counters. Module-level: persists across WARM
// invocations, resets on cold start. Exposed read-only via /_status so the app
// can SHOW calls hitting each key + every rotation. No secret values are stored.
const rrCursor: Record<string, number> = {};
interface KeyStat {
  calls: number;
  ok: number;
  failovers: number;
  lastStatus: number | null;
}
const keyStats: Record<string, KeyStat[]> = {};

function statsFor(vendor: string, n: number): KeyStat[] {
  const cur = keyStats[vendor];
  if (!cur || cur.length !== n) {
    keyStats[vendor] = Array.from({ length: n }, () => ({
      calls: 0,
      ok: 0,
      failovers: 0,
      lastStatus: null,
    }));
  }
  return keyStats[vendor];
}

/**
 * Order to try keys this request: START at the round-robin cursor, then fail over
 * through the rest. Advances the cursor so the NEXT request starts on the next
 * key - that's the load-balancing that keeps any single key under its cap.
 */
function tryOrder(vendor: string, n: number): number[] {
  if (n <= 0) return [];
  const start = (rrCursor[vendor] ?? 0) % n;
  rrCursor[vendor] = (start + 1) % n;
  return Array.from({ length: n }, (_, k) => (start + k) % n);
}

/** Pooled GET for query-param-key vendors (finnhub `token`, fmp `apikey`). */
async function fetchWithKeyPool(
  vendor: string,
  keys: string[],
  param: string,
  target: URL,
  headers: Record<string, string>,
): Promise<Response> {
  if (keys.length === 0) return fail(500, `${vendor}: no API key configured`);
  const order = tryOrder(vendor, keys.length);
  const st = statsFor(vendor, keys.length);
  let lastNetworkError = false;
  for (let i = 0; i < order.length; i++) {
    const ki = order[i];
    target.searchParams.set(param, keys[ki]);
    st[ki].calls++;
    const hasMore = i < order.length - 1;
    let res: Response;
    try {
      res = await fetch(target.toString(), { method: "GET", headers });
      lastNetworkError = false;
    } catch (e) {
      st[ki].lastStatus = 0;
      // Network/transport failure on this key - count it as a failed call.
      recordUsage(vendor, keyLabel(ki), false);
      if (hasMore) st[ki].failovers++;
      lastNetworkError = true;
      console.error(
        `[market-proxy] ${vendor} fetch error on key#${ki}: ${e instanceof Error ? e.message : "error"}${hasMore ? " — rotating" : ""}`,
      );
      continue;
    }
    const body = await res.text();
    const ct = res.headers.get("content-type");
    st[ki].lastStatus = res.status;
    if (res.ok || !shouldFailover(res.status, body)) {
      if (res.ok) st[ki].ok++;
      // Durable cross-user tally: this key served the request (ok = HTTP 2xx).
      recordUsage(vendor, keyLabel(ki), res.ok);
      const h = new Headers(CORS);
      if (ct) h.set("Content-Type", ct);
      return new Response(body, { status: res.status, headers: h });
    }
    // Quota/overload on this key → record it as a failure, then rotate.
    recordUsage(vendor, keyLabel(ki), false);
    if (hasMore) st[ki].failovers++;
    console.warn(
      `[market-proxy] ${vendor} key#${ki} quota/overload (status ${res.status})${hasMore ? " — rotating" : " — pool exhausted"}`,
    );
  }
  return lastNetworkError
    ? fail(502, `${vendor} upstream unreachable on all ${keys.length} key(s)`)
    : fail(429, `${vendor} rate limited on all ${keys.length} key(s)`);
}

/**
 * EDGAR spreads across three subdomains; the client collapses them all to the
 * `sec` vendor, so reconstruct the right origin from the residual path:
 *   /LATEST/search-index…   → efts.sec.gov   (full-text search)
 *   /Archives/… , /files/… , /cgi-bin/…, *.json tickers → www.sec.gov
 *   everything else (/submissions, /api/xbrl, company-facts) → data.sec.gov
 */
function secOrigin(path: string): string {
  const p = path.toLowerCase();
  if (p.startsWith("latest/") || p.includes("search-index")) return "https://efts.sec.gov";
  if (
    p.startsWith("archives/") ||
    p.startsWith("files/") ||
    p.startsWith("cgi-bin/") ||
    p.includes("company_tickers")
  ) {
    return "https://www.sec.gov";
  }
  return "https://data.sec.gov";
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// PERSISTENT, CROSS-USER usage tracking (migration 0020_api_usage_daily.sql).
//
// The /_status counters above are in-memory and reset on every cold start, so the
// Operator board could never show the TRUE pooled daily usage across everyone using
// the app. This records each vendor request into the durable `api_usage_daily` table
// via the SECURITY DEFINER `bump_api_usage` RPC, keyed by a STABLE human label
// (`key_1`..`key_N`, derived from the key INDEX - never the key value) so the board
// can aggregate "calls today, all users, all keys" vs each vendor's pooled limit.
//
// HARD SAFETY CONTRACT - this must NEVER affect the live data path that friends
// depend on: it is fire-and-forget (never awaited in the response path), fully
// wrapped in try/catch with a .catch() on the promise, and silently swallows every
// failure (including the table/RPC not existing yet, before the lead applies 0020).
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/** Fire-and-forget durable usage increment. Returns immediately; never throws. */
function recordUsage(vendor: string, label: string, ok: boolean): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return; // not wired → skip silently
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_api_usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_vendor: vendor, p_key_label: label, p_ok: ok }),
    }).catch(() => {});
  } catch {
    /* never let usage tracking break the proxy */
  }
}

/** Stable, secret-free key label from a 0-based pool index: 0 → "key_1". */
function keyLabel(index: number): string {
  return `key_${index + 1}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return fail(405, "GET only");

  const url = new URL(req.url);
  // Path shape: /functions/v1/market-proxy/<vendor>/<rest...>  OR  /<vendor>/<rest...>
  const segments = url.pathname.split("/").filter(Boolean);
  const fnIdx = segments.indexOf("market-proxy");
  const after = fnIdx >= 0 ? segments.slice(fnIdx + 1) : segments;
  const vendor = after[0];
  const restPath = after.slice(1).join("/");

  // Read-only rotation/usage status for the in-app dashboard. NO secret values -
  // only key COUNTS + per-key call/ok/failover counters (since cold start). This
  // is what makes "is rotation actually working?" visibly answerable on-device.
  if (vendor === "_status") {
    const snapshot = (name: string, keys: string[]) => ({
      keys: keys.length,
      cursor: rrCursor[name] ?? 0,
      perKey: statsFor(name, keys.length),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        note: "in-memory counters; reset on function cold start",
        vendors: {
          finnhub: snapshot("finnhub", FINNHUB_KEYS),
          fmp: snapshot("fmp", FMP_KEYS),
        },
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  if (!vendor || !(vendor in UPSTREAM)) {
    return fail(404, `Unknown vendor "${vendor ?? ""}"`);
  }

  // Build the upstream URL (sec picks its subdomain from the path).
  const origin = vendor === "sec" ? secOrigin(restPath) : UPSTREAM[vendor];
  const target = new URL(`${origin}/${restPath}`);
  target.search = url.search; // forward query verbatim (client already stripped secrets)

  // Re-attach the secret for this vendor (key or header) - never echoed back.
  const headers: Record<string, string> = { Accept: "application/json" };
  switch (vendor) {
    case "alpaca":
      if (ALPACA_API_KEY) headers["APCA-API-KEY-ID"] = ALPACA_API_KEY;
      if (ALPACA_API_SECRET) headers["APCA-API-SECRET-KEY"] = ALPACA_API_SECRET;
      break;
    case "sec":
      headers["User-Agent"] = SEC_CONTACT; // EDGAR fair-access requirement
      break;
    case "yahoo":
      // Yahoo's chart/quote endpoints 429 / block server-side requests that arrive
      // WITHOUT a browser-like User-Agent - the keyless Supabase edge IP sending only
      // `Accept` got rate-limited, which is what broke .TO/.V (TSX) quotes AND live
      // chart timeframes on the WEB build (desktop fetches direct from the user IP, so
      // it worked there). A standard desktop UA makes Yahoo return data normally.
      headers["User-Agent"] =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
      break;
    default:
      break; // stocktwits / apewisdom are keyless
  }

  // TODO(hardening): per-(vendor,day) rate ceiling in a KV store → 429 with
  // Retry-After when exceeded (the client ledger renders that as "degraded").
  // For 10-friend traffic the vendor allowlist + GET-only posture is sufficient.

  // ---- Pooled, round-robin key vendors (Finnhub + FMP) ----------------------
  // Each request STARTS on the next key in the pool (load-balancing so no single
  // free-tier key approaches its cap), then fails over through the rest on a
  // quota/overload signal. Per-key counters are exposed read-only via /_status.
  if (vendor === "finnhub") {
    return fetchWithKeyPool("finnhub", FINNHUB_KEYS, "token", target, headers);
  }
  if (vendor === "fmp") {
    return fetchWithKeyPool("fmp", FMP_KEYS, "apikey", target, headers);
  }

  // ---- Single-key / keyless vendors -----------------------------------------
  // One key (or none) per vendor, so the durable label is always "key_1". Alpaca
  // uses one key pair; Yahoo/SEC/StockTwits/ApeWisdom are keyless but still counted
  // so the board shows their pooled daily total.
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { method: "GET", headers });
  } catch (e) {
    recordUsage(vendor, "key_1", false);
    return fail(502, `Upstream fetch failed: ${e instanceof Error ? e.message : "error"}`);
  }
  recordUsage(vendor, "key_1", upstream.ok);

  // Stream the upstream body back with permissive CORS. Preserve content-type
  // and status so the client parses + records (per its ledger) exactly as if it
  // had called the vendor directly.
  const respHeaders = new Headers(CORS);
  const ct = upstream.headers.get("content-type");
  if (ct) respHeaders.set("Content-Type", ct);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
});
