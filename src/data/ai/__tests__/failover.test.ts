import { describe, it, expect } from "vitest";
import {
  shouldFailover,
  bodyLooksExhausted,
} from "../../../../supabase/functions/_shared/failover.ts";

// These guard the SHARED failover-decision logic used by BOTH edge functions
// (market-proxy: Finnhub key rotation; research-agent: Gemini key rotation).
// The bug being fixed: failover was too narrow (exact HTTP 429 only), so the
// backup keys never got attempted on real quota exhaustion.

describe("shouldFailover — rotate to backup key on quota/rate failure", () => {
  it("ALWAYS fails over on a canonical 429", () => {
    expect(shouldFailover(429)).toBe(true);
    expect(shouldFailover(429, "")).toBe(true);
    expect(shouldFailover(429, "anything")).toBe(true);
  });

  it("fails over on Gemini RESOURCE_EXHAUSTED (429 + body)", () => {
    const body = JSON.stringify({
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" },
    });
    expect(shouldFailover(429, body)).toBe(true);
  });

  it("fails over on a Gemini 403 quota body", () => {
    const body = JSON.stringify({
      error: { code: 403, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric" },
    });
    expect(shouldFailover(403, body)).toBe(true);
  });

  it("fails over on a Finnhub 'API limit reached' body, whatever the status", () => {
    expect(shouldFailover(429, "API limit reached. Please try again later.")).toBe(true);
    // Some vendors return 200/odd status with a soft-limit body - still rotate.
    expect(shouldFailover(200, "You have exceeded your current quota")).toBe(true);
  });

  it("fails over on common rate-limit phrasings", () => {
    expect(shouldFailover(429, "Too Many Requests")).toBe(true);
    expect(shouldFailover(503, "rate limit exceeded")).toBe(true);
    expect(shouldFailover(402, "out of credits")).toBe(true);
    expect(shouldFailover(403, "insufficient_quota")).toBe(true);
  });

  it("does NOT fail over on a genuine bad-key 403 (no quota body)", () => {
    expect(shouldFailover(403, "API key not valid. Please pass a valid API key.")).toBe(false);
    expect(shouldFailover(401, "Invalid authentication credentials")).toBe(false);
  });

  it("does NOT fail over on ordinary success or non-quota errors", () => {
    expect(shouldFailover(200, '{"data":1}')).toBe(false);
    expect(shouldFailover(404, "Not Found")).toBe(false);
    expect(shouldFailover(500, "Internal Server Error")).toBe(false);
    expect(shouldFailover(400, "Bad Request")).toBe(false);
  });
});

describe("bodyLooksExhausted", () => {
  it("is case-insensitive and tolerant of null/empty", () => {
    expect(bodyLooksExhausted(null)).toBe(false);
    expect(bodyLooksExhausted(undefined)).toBe(false);
    expect(bodyLooksExhausted("")).toBe(false);
    expect(bodyLooksExhausted("QUOTA EXCEEDED")).toBe(true);
    expect(bodyLooksExhausted("Resource_Exhausted")).toBe(true);
  });
});
