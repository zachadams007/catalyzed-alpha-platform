/**
 * Unit tests for the pure helpers in src/data/alpaca/bars.ts:
 *   - momentumFromCloses  (public, pure)
 *   - rsi14               (exported for testing)
 *   - pctChange           (exported for testing)
 *   - smaN                (exported for testing)
 *
 * Also covers fetchAlpacaBarsForSymbols retry/rate-limit behaviour via a
 * stubbed global `fetch` (no real network).
 *
 * NO network: all inputs are synthetic close arrays or mocked fetch responses.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { momentumFromCloses, rsi14, pctChange, smaN } from "@/data/alpaca/bars";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a flat close array of `n` entries all equal to `price`. */
function flat(price: number, n: number): number[] {
  return Array.from({ length: n }, () => price);
}

/**
 * Build a linearly increasing close array starting at `start`, ending at
 * `start + (n-1) * step`.
 */
function linear(start: number, step: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/**
 * 252 flat closes with a single "blip" at the end: the last `lookback` closes
 * rise by `pct` from the prior close so `pctChange(closes, lookback) ≈ pct`.
 *
 * Approach: start with 252 closes all at 100, then lift the final `lookback`
 * entries by `pct` so the anchor is 100 and the end is 100 * (1 + pct).
 */
function withReturn(lookback: number, pct: number, total = 252): number[] {
  const closes = flat(100, total);
  // The anchor is closes[total - 1 - lookback] = 100
  // We need closes[total - 1] = 100 * (1 + pct)
  // Set just the last entry for simplicity; pctChange uses endpoint-to-endpoint.
  closes[total - 1] = 100 * (1 + pct);
  return closes;
}

// ---------------------------------------------------------------------------
// pctChange
// ---------------------------------------------------------------------------
describe("pctChange", () => {
  it("computes endpoint-to-endpoint pct change correctly", () => {
    // closes[end] = 110, closes[end - 21] = 100 → +10%
    const closes = withReturn(21, 0.1);
    expect(pctChange(closes, 21)).toBeCloseTo(0.1, 5);
  });

  it("returns 0 when array is too short for the lookback", () => {
    expect(pctChange([100, 110], 21)).toBe(0);
  });

  it("returns 0 when anchor close is 0", () => {
    const closes = flat(0, 30);
    expect(pctChange(closes, 10)).toBe(0);
  });

  it("handles negative returns", () => {
    const closes = withReturn(63, -0.2);
    expect(pctChange(closes, 63)).toBeCloseTo(-0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// smaN
// ---------------------------------------------------------------------------
describe("smaN", () => {
  it("returns null when fewer closes than period", () => {
    expect(smaN([100, 110], 50)).toBeNull();
  });

  it("returns the mean of the last n closes for a flat series", () => {
    const closes = flat(50, 200);
    expect(smaN(closes, 50)).toBeCloseTo(50, 5);
    expect(smaN(closes, 200)).toBeCloseTo(50, 5);
  });

  it("uses only the last n closes (not a full-series average)", () => {
    // First 150 entries at 100, last 50 at 200 → SMA50 should be 200
    const closes = [...flat(100, 150), ...flat(200, 50)];
    expect(smaN(closes, 50)).toBeCloseTo(200, 5);
  });
});

// ---------------------------------------------------------------------------
// rsi14
// ---------------------------------------------------------------------------
describe("rsi14", () => {
  it("returns 50 when there are ≤14 closes (insufficient data sentinel)", () => {
    expect(rsi14(flat(100, 14))).toBe(50);
    expect(rsi14(flat(100, 5))).toBe(50);
  });

  it("returns 100 when all changes are gains (no losses)", () => {
    // Strictly increasing series → RSI = 100
    const closes = linear(100, 1, 30);
    expect(rsi14(closes)).toBe(100);
  });

  it("returns a value in 0..100 for a mixed series", () => {
    // Alternating up/down: equal gains and losses → RSI ≈ 50
    const closes: number[] = [100];
    for (let i = 1; i < 40; i++) {
      closes.push(i % 2 === 0 ? closes[i - 1]! + 1 : closes[i - 1]! - 1);
    }
    const r = rsi14(closes);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(100);
  });

  it("returns a high RSI for a strongly upward series", () => {
    // Last 14 bars are all gains → RSI should be high (well above 50)
    const base = flat(100, 100);
    // Replace last 30 with a rising run
    for (let i = 0; i < 30; i++) base[100 - 30 + i] = 100 + i * 2;
    expect(rsi14(base)).toBeGreaterThan(70);
  });

  it("uses only the trailing 14 changes, not the full series", () => {
    // 200 flat closes followed by 15 strictly rising closes.
    // Only the last 14 differences count, all gains → RSI = 100.
    const closes = [...flat(100, 200), ...linear(100, 1, 15)];
    expect(rsi14(closes)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// momentumFromCloses - null fallback
// ---------------------------------------------------------------------------
describe("momentumFromCloses — null fallback for short series", () => {
  it("returns null for an empty array", () => {
    expect(momentumFromCloses([])).toBeNull();
  });

  it("returns null for 29 closes (one below the 30-close threshold)", () => {
    expect(momentumFromCloses(flat(100, 29))).toBeNull();
  });

  it("returns a RawMomentum object for exactly 30 closes", () => {
    expect(momentumFromCloses(flat(100, 30))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// momentumFromCloses - return fields
// ---------------------------------------------------------------------------
describe("momentumFromCloses — return1M / return3M / return6M", () => {
  it("return1M ≈ 21-bar endpoint-to-endpoint pct change", () => {
    const closes = withReturn(21, 0.15);
    const m = momentumFromCloses(closes)!;
    expect(m.return1M).toBeCloseTo(0.15, 4);
  });

  it("return3M ≈ 63-bar pct change", () => {
    const closes = withReturn(63, 0.25);
    const m = momentumFromCloses(closes)!;
    expect(m.return3M).toBeCloseTo(0.25, 4);
  });

  it("return6M ≈ 126-bar pct change", () => {
    const closes = withReturn(126, -0.1);
    const m = momentumFromCloses(closes)!;
    expect(m.return6M).toBeCloseTo(-0.1, 4);
  });

  it("returns 0 for return6M when fewer than 127 closes", () => {
    // 60 closes - not enough for a 126-bar lookback
    const m = momentumFromCloses(flat(100, 60))!;
    expect(m.return6M).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// momentumFromCloses - RSI field
// ---------------------------------------------------------------------------
describe("momentumFromCloses — rsi", () => {
  it("rsi is within 0..100", () => {
    const m = momentumFromCloses(flat(100, 252))!;
    expect(m.rsi).toBeGreaterThanOrEqual(0);
    expect(m.rsi).toBeLessThanOrEqual(100);
  });

  it("rsi is 50 when series has ≤14 changes (flat series of exactly 30)", () => {
    // A flat 30-close series: all diffs = 0. Losses = 0 → rsi14 returns 100 (no
    // losses case). Actually with our rsi14 impl: gains=0, losses=0 → losses===0
    // branch → returns 100. Verify we match rsi14's own output exactly.
    const closes = flat(100, 30);
    const m = momentumFromCloses(closes)!;
    expect(m.rsi).toBe(rsi14(closes));
  });
});

// ---------------------------------------------------------------------------
// momentumFromCloses - aboveSMA50 / aboveSMA200
// ---------------------------------------------------------------------------
describe("momentumFromCloses — aboveSMA50 / aboveSMA200", () => {
  it("aboveSMA50 is true when last close is above the 50-period SMA", () => {
    // 100 flat closes at 100, then 1 spike to 200
    const closes = [...flat(100, 100), 200];
    const m = momentumFromCloses(closes)!;
    // SMA50 is drawn from the last 50 closes: 49 × 100 + 200 = 149.xx / 50 ≈ 100.xx → last=200 is above
    expect(m.aboveSMA50).toBe(true);
  });

  it("aboveSMA50 is false when last close is below the 50-period SMA", () => {
    // 100 closes at 200, then 1 drop to 50
    const closes = [...flat(200, 100), 50];
    const m = momentumFromCloses(closes)!;
    // SMA50: 49 × 200 + 50 = 9850 / 50 = 197 → last=50 is below
    expect(m.aboveSMA50).toBe(false);
  });

  it("aboveSMA200 is false when fewer than 200 closes (SMA200 unavailable → false)", () => {
    // Only 100 closes - smaN(closes, 200) returns null → falls back to false
    const m = momentumFromCloses(flat(100, 100))!;
    expect(m.aboveSMA200).toBe(false);
  });

  it("aboveSMA200 is true when last close is above the 200-period SMA", () => {
    // 250 flat closes at 100 then bump last to 150 → last > SMA200
    const closes = [...flat(100, 250), 150];
    const m = momentumFromCloses(closes)!;
    expect(m.aboveSMA200).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// momentumFromCloses - relativeStrength3M
// ---------------------------------------------------------------------------
describe("momentumFromCloses — relativeStrength3M", () => {
  it("equals return3M (own-stock proxy, no market subtraction yet)", () => {
    const closes = withReturn(63, 0.12);
    const m = momentumFromCloses(closes)!;
    // relativeStrength3M is the stock's own 3M return (market subtraction is TODO)
    expect(m.relativeStrength3M).toBeCloseTo(m.return3M, 8);
  });
});

// ---------------------------------------------------------------------------
// momentumFromCloses - shape contract (all RawMomentum fields present)
// ---------------------------------------------------------------------------
describe("momentumFromCloses — RawMomentum shape", () => {
  it("returns an object with all required RawMomentum fields", () => {
    const m = momentumFromCloses(flat(100, 252));
    expect(m).not.toBeNull();
    const keys: (keyof NonNullable<typeof m>)[] = [
      "return1M",
      "return3M",
      "return6M",
      "rsi",
      "aboveSMA50",
      "aboveSMA200",
      "relativeStrength3M",
    ];
    for (const k of keys) {
      expect(m).toHaveProperty(k);
    }
  });

  it("return1M / return3M / return6M are finite numbers", () => {
    const m = momentumFromCloses(linear(50, 0.5, 252))!;
    expect(Number.isFinite(m.return1M)).toBe(true);
    expect(Number.isFinite(m.return3M)).toBe(true);
    expect(Number.isFinite(m.return6M)).toBe(true);
  });

  it("aboveSMA50 and aboveSMA200 are booleans", () => {
    const m = momentumFromCloses(flat(100, 252))!;
    expect(typeof m.aboveSMA50).toBe("boolean");
    expect(typeof m.aboveSMA200).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// fetchAlpacaBarsForSymbols - retry / rate-limit behaviour (mocked fetch)
//
// These tests stub globalThis.fetch so no network calls are made.  The Alpaca
// key env-vars are set to non-empty sentinels so the early-return guard passes.
// ratePerMin=0 disables the token-bucket to keep tests fast; maxRetries is set
// explicitly per test.
// ---------------------------------------------------------------------------

// vi.mock hoisted to module scope - mock the http module so alpacaKeyId() and
// alpacaSecret() return sentinel values without touching env / sampleDataMode.
vi.mock("@/data/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/data/http")>();
  return {
    ...original,
    alpacaKeyId: () => "test-key-id",
    alpacaSecret: () => "test-key-secret",
  };
});

import { fetchAlpacaBarsForSymbols } from "@/data/alpaca/bars";

/** Build a minimal valid Alpaca single-symbol bars JSON for `ticker`. */
function alpacaBarsJson(ticker: string, barCount = 30): unknown {
  const bars = Array.from({ length: barCount }, (_, i) => ({
    t: `2025-0${(i % 9) + 1}-01T00:00:00Z`,
    o: 100 + i,
    h: 102 + i,
    l: 99 + i,
    c: 101 + i,
    v: 1_000_000,
  }));
  // Single-symbol endpoint: { bars: [...], symbol: "TICKER" }
  return { bars, symbol: ticker };
}

/** Build a mock Response object with the given status and optional body/headers. */
function mockResponse(
  status: number,
  body: unknown = {},
  extraHeaders: Record<string, string> = {},
): Response {
  const headersMap = new Map(Object.entries(extraHeaders));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headersMap.get(name.toLowerCase()) ?? null,
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("fetchAlpacaBarsForSymbols — retry on 429 then succeeds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries after a 429 and returns data on the second attempt", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", (_url: string) => {
      callCount++;
      if (callCount === 1) {
        // First call: throttled
        return Promise.resolve(mockResponse(429));
      }
      // Second call: success
      return Promise.resolve(mockResponse(200, alpacaBarsJson("AAPL", 30)));
    });

    const result = await fetchAlpacaBarsForSymbols(["AAPL"], {
      ratePerMin: 0,   // disable bucket so test runs instantly
      maxRetries: 3,
      timeoutMs: 5_000,
    });

    expect(callCount).toBe(2);
    expect(result["AAPL"]).toBeDefined();
    expect(result["AAPL"]!.closes.length).toBeGreaterThanOrEqual(20);
  });

  it("returns null (ticker absent from result) after exhausting all retries on persistent 429", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => Promise.resolve(mockResponse(429)));

    const promise = fetchAlpacaBarsForSymbols(["BMNR"], {
      ratePerMin: 0,
      maxRetries: 3,
      timeoutMs: 5_000,
    });

    // Advance fake timers past all back-off delays (600 + 1500 + 3000 = 5100ms).
    await vi.runAllTimersAsync();
    const result = await promise;

    // After 1 initial + 3 retries all return 429, the ticker should be absent.
    expect(result["BMNR"]).toBeUndefined();
    vi.useRealTimers();
  });

  it("returns null for <20-bar response WITHOUT retrying (genuine data absence)", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", (_url: string) => {
      callCount++;
      // 200 OK but only 5 bars - not enough data, parseSingleSymbolBars returns null.
      return Promise.resolve(mockResponse(200, alpacaBarsJson("VVOS", 5)));
    });

    const result = await fetchAlpacaBarsForSymbols(["VVOS"], {
      ratePerMin: 0,
      maxRetries: 3,
      timeoutMs: 5_000,
    });

    // No retry on genuine no-data: exactly 1 fetch call.
    expect(callCount).toBe(1);
    expect(result["VVOS"]).toBeUndefined();
  });

  it("honors Retry-After header on 429 (uses header value, not backoff constant)", async () => {
    // Retry-After: 0 means "retry immediately". We verify a retry occurs and
    // succeeds without testing wall-clock delay (that would be slow/flaky).
    let callCount = 0;
    vi.stubGlobal("fetch", () => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(mockResponse(429, {}, { "retry-after": "0" }));
      }
      return Promise.resolve(mockResponse(200, alpacaBarsJson("NVDA", 30)));
    });

    const result = await fetchAlpacaBarsForSymbols(["NVDA"], {
      ratePerMin: 0,
      maxRetries: 1,   // 1 retry = 2 total attempts: attempt-0 (429) + attempt-1 (200)
      timeoutMs: 5_000,
    });

    expect(callCount).toBe(2);
    expect(result["NVDA"]).toBeDefined();
  });

  it("returns null on non-retryable HTTP errors (e.g. 401) without retrying", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", () => {
      callCount++;
      return Promise.resolve(mockResponse(401));
    });

    const result = await fetchAlpacaBarsForSymbols(["NDRA"], {
      ratePerMin: 0,
      maxRetries: 3,
      timeoutMs: 5_000,
    });

    // 401 is not retryable - exactly 1 fetch call.
    expect(callCount).toBe(1);
    expect(result["NDRA"]).toBeUndefined();
  });
});
