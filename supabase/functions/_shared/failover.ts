// Shared, provider-agnostic failover decision logic for the Supabase edge
// functions (market-proxy, research-agent).
//
// PURE + DEPENDENCY-FREE on purpose: no Deno globals, no fetch, no env. That
// lets the SAME predicate run inside the Deno functions AND be unit-tested by
// the client's vitest (node env) - see src/data/ai/__tests__/failover.test.ts -
// so the "rotate to backup on quota/rate failure" decision can't silently drift.
//
// The bug this fixes: the backup keys weren't saving us because failover was too
// narrow - it only triggered on a single, exact HTTP 429. Real quota exhaustion
// also surfaces as 403 (Finnhub), or 429/403 with a RESOURCE_EXHAUSTED /
// "quota" / "rate limit" body (Gemini). We now rotate to the backup key on ANY
// of those signals, retry the FULL request on the backup, and only give up after
// the backup is genuinely attempted.

/** Status codes that always mean "rate limited / quota exhausted". */
const QUOTA_STATUSES = new Set([429]);

/**
 * Transient "server busy / model overloaded" statuses. In a ROUND-ROBIN KEY POOL
 * the correct response is to rotate to the NEXT key/account and retry the
 * idempotent GET - a different account is often not overloaded. Gemini surfaces
 * its free-tier overload as 503 UNAVAILABLE ("The model is overloaded"), which
 * the old predicate treated as a generic error and never rotated past (so the
 * Research Desk died instead of trying the backup). 529 is the "overloaded" code
 * some LLM gateways use.
 */
const OVERLOADED_STATUSES = new Set([503, 529]);

/**
 * Status codes that MIGHT be a quota problem depending on the body. Vendors
 * overload 403 for both "bad key" and "free-tier quota used up"; we treat a 403
 * as a quota signal only when the body confirms it (see bodyLooksExhausted).
 */
const MAYBE_QUOTA_STATUSES = new Set([402, 403]);

/** Substrings (case-insensitive) in an error body that signal quota/rate limits. */
const EXHAUSTED_BODY_MARKERS = [
  "resource_exhausted",
  "resource exhausted",
  "quota",
  "rate limit",
  "ratelimit",
  "rate-limit",
  "too many requests",
  "limit reached",
  "limit exceeded",
  "exceeded your current",
  "out of credits",
  "insufficient_quota",
  "insufficient quota",
  // LLM overload phrasing - unambiguous, won't appear in a market-data body.
  // (Transient 503/529 overload is matched by STATUS in OVERLOADED_STATUSES; we
  // deliberately do NOT match a bare "unavailable", which a vendor uses for a
  // legitimate "no data for symbol" and would wrongly burn the whole key pool.)
  "overloaded",
  "model is overloaded",
];

/** True when an upstream error body reads like a quota / rate-limit failure. */
export function bodyLooksExhausted(body: string | null | undefined): boolean {
  if (!body) return false;
  const b = body.toLowerCase();
  return EXHAUSTED_BODY_MARKERS.some((m) => b.includes(m));
}

/**
 * THE decision: should we rotate to the backup key and retry the full request?
 *
 * - Any 429 → yes (canonical rate-limit).
 * - 402 / 403 → yes ONLY if the body confirms it's a quota/rate problem (so a
 *   genuinely bad/missing key isn't mistaken for exhaustion and burned twice).
 * - Any status whose body explicitly says quota/exhausted → yes (covers vendors
 *   that return 200-with-error or odd statuses on soft limits).
 */
export function shouldFailover(status: number, body?: string | null): boolean {
  if (QUOTA_STATUSES.has(status)) return true;
  if (OVERLOADED_STATUSES.has(status)) return true;
  if (MAYBE_QUOTA_STATUSES.has(status)) return bodyLooksExhausted(body);
  return bodyLooksExhausted(body);
}
