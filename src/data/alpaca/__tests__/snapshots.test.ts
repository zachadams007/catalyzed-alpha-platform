import { describe, expect, it } from "vitest";

import {
  fetchSnapshotQuotesAudited,
  snapshotToQuote,
  extractSnapshotMap,
  parseSnapshotQuotes,
} from "@/data/alpaca/snapshots";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnap(overrides: {
  latestTradeP?: number | null;
  dailyBarC?: number | null;
  minuteBarC?: number | null;
  prevBarC?: number | null;
  prevBarV?: number;
  prevBarVw?: number;
  prevBarH?: number;
  prevBarL?: number;
  dailyBarV?: number;
  dailyBarVw?: number;
  latestTradeT?: string;
} = {}) {
  const snap: Record<string, unknown> = {};

  if (
    overrides.latestTradeP !== undefined ||
    overrides.latestTradeT !== undefined
  ) {
    snap.latestTrade = {
      p: overrides.latestTradeP,
      t: overrides.latestTradeT ?? "2024-01-02T15:00:00Z",
    };
  }

  if (overrides.dailyBarC !== undefined || overrides.dailyBarV !== undefined) {
    snap.dailyBar = {
      c: overrides.dailyBarC,
      v: overrides.dailyBarV,
      vw: overrides.dailyBarVw,
      h: 105,
      l: 95,
      t: "2024-01-02T21:00:00Z",
    };
  }

  if (overrides.minuteBarC !== undefined) {
    snap.minuteBar = {
      c: overrides.minuteBarC,
      h: overrides.minuteBarC! * 1.01,
      l: overrides.minuteBarC! * 0.99,
      t: "2024-01-02T15:01:00Z",
    };
  }

  if (
    overrides.prevBarC !== undefined ||
    overrides.prevBarV !== undefined ||
    overrides.prevBarH !== undefined
  ) {
    snap.prevDailyBar = {
      c: overrides.prevBarC,
      v: overrides.prevBarV ?? 1_000_000,
      vw: overrides.prevBarVw,
      h: overrides.prevBarH ?? (overrides.prevBarC ?? 100) * 1.02,
      l: overrides.prevBarL ?? (overrides.prevBarC ?? 100) * 0.98,
      t: "2024-01-01T21:00:00Z",
    };
  }

  return snap;
}

// ---------------------------------------------------------------------------
// snapshotToQuote - price fallback chain
// ---------------------------------------------------------------------------
describe("snapshotToQuote — price fallback chain", () => {
  it("prefers latestTrade.p as price", () => {
    const snap = makeSnap({
      latestTradeP: 110,
      prevBarC: 100,
      dailyBarC: 108,
      minuteBarC: 107,
    });
    const q = snapshotToQuote("AAPL", snap as never);
    expect(q).not.toBeNull();
    expect(q!.price).toBeCloseTo(110, 1);
  });

  it("falls back to dailyBar.c when no latestTrade", () => {
    const snap = makeSnap({ dailyBarC: 108, prevBarC: 100 });
    const q = snapshotToQuote("AAPL", snap as never);
    expect(q).not.toBeNull();
    expect(q!.price).toBeCloseTo(108, 1);
  });

  it("falls back to minuteBar.c when no latestTrade or dailyBar", () => {
    const snap = makeSnap({ minuteBarC: 107, prevBarC: 100 });
    const q = snapshotToQuote("AAPL", snap as never);
    expect(q).not.toBeNull();
    expect(q!.price).toBeCloseTo(107, 1);
  });

  it("falls back to prevDailyBar.c when that is all we have", () => {
    const snap = makeSnap({ prevBarC: 100 });
    const q = snapshotToQuote("AAPL", snap as never);
    expect(q).not.toBeNull();
    expect(q!.price).toBeCloseTo(100, 1);
  });

  it("returns null when price is 0 (none of the bars has a positive price)", () => {
    const q = snapshotToQuote("AAPL", {} as never);
    expect(q).toBeNull();
  });

  it("returns null when latestTrade.p is 0", () => {
    const snap = makeSnap({ latestTradeP: 0 });
    const q = snapshotToQuote("AAPL", snap as never);
    expect(q).toBeNull();
  });

  it("returns null when snap is null", () => {
    expect(snapshotToQuote("AAPL", null)).toBeNull();
  });

  it("returns null when snap is not an object", () => {
    expect(snapshotToQuote("AAPL", "bad" as never)).toBeNull();
  });

  it("uppercases ticker in the returned quote", () => {
    const snap = makeSnap({ latestTradeP: 50, prevBarC: 48 });
    const q = snapshotToQuote("aapl", snap as never);
    expect(q!.ticker).toBe("AAPL");
  });
});

// ---------------------------------------------------------------------------
// snapshotToQuote - dayChange
// ---------------------------------------------------------------------------
describe("snapshotToQuote — dayChange", () => {
  it("dayChange = (price - prevClose) / prevClose", () => {
    const snap = makeSnap({ latestTradeP: 110, prevBarC: 100 });
    const q = snapshotToQuote("T", snap as never);
    expect(q!.dayChange).toBeCloseTo(0.1, 6);
  });

  it("dayChange is 0 when prevClose is missing and price is used as base", () => {
    const snap = makeSnap({ latestTradeP: 110 });
    const q = snapshotToQuote("T", snap as never);
    expect(q).not.toBeNull();
    expect(q!.dayChange).toBe(0);
  });

  it("prevClose falls back to price when prevDailyBar.c is absent", () => {
    const snap = makeSnap({ latestTradeP: 110 });
    const q = snapshotToQuote("T", snap as never);
    expect(q!.prevClose).toBeCloseTo(110, 1);
  });

  it("handles a negative dayChange (price below prevClose)", () => {
    const snap = makeSnap({ latestTradeP: 90, prevBarC: 100 });
    const q = snapshotToQuote("T", snap as never);
    expect(q!.dayChange).toBeCloseTo(-0.1, 6);
  });
});

// ---------------------------------------------------------------------------
// snapshotToQuote - dollarVolume
// ---------------------------------------------------------------------------
describe("snapshotToQuote — dollarVolume", () => {
  it("dollarVolume = prevDailyBar.v * prevDailyBar.vw", () => {
    const snap = makeSnap({
      latestTradeP: 50,
      prevBarC: 48,
      prevBarV: 1_000_000,
      prevBarVw: 49,
    });
    const q = snapshotToQuote("T", snap as never);
    expect(q!.dollarVolume).toBe(49_000_000);
  });

  it("falls back to v * c when vw is absent", () => {
    const snap = {
      latestTrade: { p: 50, t: "t" },
      prevDailyBar: { c: 48, v: 1_000_000, h: 50, l: 46, t: "t" },
    };
    const q = snapshotToQuote("T", snap as never);
    expect(q!.dollarVolume).toBe(48_000_000);
  });

  it("dollarVolume is >= 0 (never negative)", () => {
    const snap = makeSnap({ latestTradeP: 50, prevBarC: 48, prevBarV: 0 });
    const q = snapshotToQuote("T", snap as never);
    expect(q!.dollarVolume).toBeGreaterThanOrEqual(0);
  });

  it("marks a timestamped but incomplete prior bar as imputed provenance", () => {
    const snap = {
      latestTrade: { p: 50, t: "2024-01-02T15:00:00Z" },
      prevDailyBar: { h: 51, l: 47, t: "2024-01-01T21:00:00Z" },
    };
    const q = snapshotToQuote("T", snap as never);
    expect(q).not.toBeNull();
    expect(q!.liquiditySource).toBe("imputed");
    expect(q!.liquidityAsOfISO).toBeNull();
    expect(q!.rangeSource).toBe("imputed");
    expect(q!.rangeAsOfISO).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// snapshotToQuote - rangePct
// ---------------------------------------------------------------------------
describe("snapshotToQuote — rangePct", () => {
  it("rangePct = (h - l) / c from prevDailyBar", () => {
    const snap = {
      latestTrade: { p: 110, t: "t" },
      prevDailyBar: { c: 100, v: 1_000_000, vw: 100, h: 105, l: 95, t: "t" },
    };
    const q = snapshotToQuote("T", snap as never);
    expect(q!.rangePct).toBeCloseTo((105 - 95) / 100, 6);
  });

  it("rangePct is >= 0 (never negative)", () => {
    const snap = makeSnap({ latestTradeP: 50, prevBarC: 48 });
    const q = snapshotToQuote("T", snap as never);
    expect(q!.rangePct).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// extractSnapshotMap - shape tolerance
// ---------------------------------------------------------------------------
describe("extractSnapshotMap — shape tolerance", () => {
  const aapl = {
    latestTrade: { p: 180, t: "t" },
    prevDailyBar: { c: 175, v: 1_000_000, vw: 177, h: 181, l: 174, t: "t" },
  };

  it("handles the top-level { AAPL: {...} } shape", () => {
    const json = { AAPL: aapl };
    const map = extractSnapshotMap(json);
    expect(Object.keys(map)).toContain("AAPL");
    expect(map["AAPL"]).toBeDefined();
  });

  it("handles the wrapped { snapshots: { AAPL: {...} } } shape", () => {
    const json = { snapshots: { AAPL: aapl } };
    const map = extractSnapshotMap(json);
    expect(Object.keys(map)).toContain("AAPL");
  });

  it("uppercases symbol keys in the output", () => {
    const json = { aapl: aapl };
    const map = extractSnapshotMap(json);
    expect(Object.keys(map)).toContain("AAPL");
    expect(Object.keys(map)).not.toContain("aapl");
  });

  it("ignores envelope/non-snapshot keys (next_page_token, message, currency)", () => {
    const json = {
      AAPL: aapl,
      next_page_token: null,
      message: "ok",
      currency: "USD",
    };
    const map = extractSnapshotMap(json);
    expect(Object.keys(map)).toEqual(["AAPL"]);
  });

  it("drops a key whose value has none of latestTrade/dailyBar/prevDailyBar/minuteBar", () => {
    const json = {
      AAPL: aapl,
      NOTASNAP: { foo: "bar", count: 42 },
    };
    const map = extractSnapshotMap(json);
    expect(Object.keys(map)).not.toContain("NOTASNAP");
    expect(Object.keys(map)).toContain("AAPL");
  });

  it("handles non-object / null / empty input gracefully", () => {
    expect(extractSnapshotMap(null)).toEqual({});
    expect(extractSnapshotMap(undefined)).toEqual({});
    expect(extractSnapshotMap("string")).toEqual({});
    expect(extractSnapshotMap(42)).toEqual({});
    expect(extractSnapshotMap({})).toEqual({});
  });

  it("accepts a snap with only a minuteBar field", () => {
    const json = {
      TSLA: { minuteBar: { c: 250, h: 252, l: 248, v: 5000, t: "t" } },
    };
    const map = extractSnapshotMap(json);
    expect(map["TSLA"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// parseSnapshotQuotes
// ---------------------------------------------------------------------------
describe("parseSnapshotQuotes", () => {
  it("returns a map keyed by UPPERCASE ticker of valid SnapshotQuotes", () => {
    const json = {
      AAPL: {
        latestTrade: { p: 180, t: "t" },
        prevDailyBar: {
          c: 175,
          v: 1_000_000,
          vw: 177,
          h: 181,
          l: 174,
          t: "t",
        },
      },
      MSFT: {
        latestTrade: { p: 390, t: "t" },
        prevDailyBar: {
          c: 385,
          v: 2_000_000,
          vw: 387,
          h: 395,
          l: 383,
          t: "t",
        },
      },
    };
    const map = parseSnapshotQuotes(json);
    expect(map["AAPL"]).toBeDefined();
    expect(map["MSFT"]).toBeDefined();
    expect(map["AAPL"]!.ticker).toBe("AAPL");
    expect(map["MSFT"]!.ticker).toBe("MSFT");
  });

  it("omits tickers where the snapshot cannot anchor a price", () => {
    const json = {
      AAPL: {
        latestTrade: { p: 180, t: "t" },
        prevDailyBar: { c: 175, v: 1_000_000, vw: 177, h: 181, l: 174, t: "t" },
      },
      NODATA: { latestTrade: { p: 0, t: "t" } },
    };
    const map = parseSnapshotQuotes(json);
    expect(map["AAPL"]).toBeDefined();
    expect(map["NODATA"]).toBeUndefined();
  });

  it("returns an empty map for invalid input", () => {
    expect(parseSnapshotQuotes(null)).toEqual({});
    expect(parseSnapshotQuotes([])).toEqual({});
    expect(parseSnapshotQuotes("bad")).toEqual({});
  });

  it("handles the wrapped snapshots shape end-to-end", () => {
    const json = {
      snapshots: {
        NVDA: {
          latestTrade: { p: 900, t: "t" },
          prevDailyBar: {
            c: 880,
            v: 3_000_000,
            vw: 890,
            h: 910,
            l: 870,
            t: "t",
          },
        },
      },
    };
    const map = parseSnapshotQuotes(json);
    expect(map["NVDA"]).toBeDefined();
    expect(map["NVDA"]!.price).toBeCloseTo(900, 0);
  });
});

describe("fetchSnapshotQuotesAudited", () => {
  const now = () => new Date("2026-07-21T12:00:00.000Z");
  const fullSnap = () =>
    makeSnap({
      latestTradeP: 101,
      latestTradeT: "2026-07-21T11:59:00.000Z",
      prevBarC: 100,
      prevBarV: 1_000_000,
      prevBarVw: 100,
    });

  it("reports exact complete membership across batches without exposing credentials", async () => {
    const result = await fetchSnapshotQuotesAudited(
      ["AAPL", "MSFT", "NVDA"],
      { batchSize: 2 },
      {
        getKeyId: () => "key-canary",
        getSecret: () => "secret-canary",
        fetchJson: async (url) => {
          const requested = new URL(url).searchParams.get("symbols")!.split(",");
          return Object.fromEntries(requested.map((ticker) => [ticker, fullSnap()]));
        },
        now,
      },
    );
    expect(result.audit.status).toBe("complete");
    expect(result.audit.requestedCount).toBe(3);
    expect(result.audit.returnedCount).toBe(3);
    expect(result.audit.missingTickers).toEqual([]);
    expect(result.audit.unexpectedTickers).toEqual([]);
    expect(result.audit.batches).toHaveLength(2);
    expect(JSON.stringify(result.audit)).not.toContain("canary");
    expect(JSON.stringify(result.audit)).not.toContain("APCA-API");
  });

  it("marks a failed batch partial and records its exact missing membership", async () => {
    let call = 0;
    const result = await fetchSnapshotQuotesAudited(
      ["AAPL", "MSFT", "NVDA"],
      { batchSize: 2 },
      {
        getKeyId: () => "configured",
        getSecret: () => "configured",
        fetchJson: async (url) => {
          call++;
          if (call === 2) throw new Error("provider details must not escape");
          const requested = new URL(url).searchParams.get("symbols")!.split(",");
          return Object.fromEntries(requested.map((ticker) => [ticker, fullSnap()]));
        },
        now,
      },
    );
    expect(result.audit.status).toBe("partial");
    expect(result.audit.missingTickers).toEqual(["NVDA"]);
    expect(result.audit.batches[1]!.status).toBe("request_failed");
    expect(JSON.stringify(result.audit)).not.toContain("provider details");
  });

  it("rejects equal-count wrong-symbol and malformed HTTP-200 membership", async () => {
    const wrong = await fetchSnapshotQuotesAudited(
      ["AAPL", "MSFT"],
      {},
      {
        getKeyId: () => "configured",
        getSecret: () => "configured",
        fetchJson: async () => ({ GOOG: fullSnap(), TSLA: fullSnap() }),
        now,
      },
    );
    const malformed = await fetchSnapshotQuotesAudited(
      ["AAPL"],
      {},
      {
        getKeyId: () => "configured",
        getSecret: () => "configured",
        fetchJson: async () => [],
        now,
      },
    );
    expect(wrong.audit.status).toBe("partial");
    expect(wrong.audit.missingTickers).toEqual(["AAPL", "MSFT"]);
    expect(wrong.audit.unexpectedTickers).toEqual(["GOOG", "TSLA"]);
    expect(wrong.quotes).toEqual({});
    expect(malformed.audit.status).toBe("partial");
    expect(malformed.audit.batches[0]!.status).toBe("invalid_payload");
  });

  it("audits an unexpected snapshot even when it cannot normalize to a quote", async () => {
    const result = await fetchSnapshotQuotesAudited(
      ["AAPL"],
      {},
      {
        getKeyId: () => "configured",
        getSecret: () => "configured",
        fetchJson: async () => ({
          AAPL: fullSnap(),
          GOOG: { latestTrade: { p: 0, t: "2026-07-21T11:59:00.000Z" } },
        }),
        now,
      },
    );
    expect(result.quotes).toHaveProperty("AAPL");
    expect(result.quotes).not.toHaveProperty("GOOG");
    expect(result.audit.status).toBe("partial");
    expect(result.audit.unexpectedTickers).toEqual(["GOOG"]);
  });

  it("reports missing configuration without calling the transport", async () => {
    let called = false;
    const result = await fetchSnapshotQuotesAudited(
      ["AAPL"],
      {},
      {
        getKeyId: () => undefined,
        getSecret: () => undefined,
        fetchJson: async () => {
          called = true;
          return {};
        },
        now,
      },
    );
    expect(called).toBe(false);
    expect(result.audit.status).toBe("not_configured");
    expect(result.audit.missingTickers).toEqual(["AAPL"]);
  });
});

describe("SnapshotQuote field provenance", () => {
  it("keeps composite field sources distinct without changing numeric fallbacks", () => {
    const quote = snapshotToQuote(
      "AAPL",
      {
        latestTrade: { p: 110, t: "2026-07-21T13:00:00.000Z" },
        dailyBar: { c: 108, v: 50, h: 111, l: 105, t: "2026-07-21T12:59:00.000Z" },
        prevDailyBar: { c: 100, v: 1_000, vw: 101, h: 104, l: 98, t: "2026-07-20T20:00:00.000Z" },
      } as never,
    )!;
    expect(quote.price).toBe(110);
    expect(quote.dollarVolume).toBe(101_000);
    expect(quote.priceSource).toBe("latest_trade");
    expect(quote.priceAsOfISO).toBe("2026-07-21T13:00:00.000Z");
    expect(quote.prevCloseSource).toBe("previous_daily_bar");
    expect(quote.liquiditySource).toBe("previous_daily_bar");
    expect(quote.liquidityAsOfISO).toBe("2026-07-20T20:00:00.000Z");
  });

  it("marks prior-close and bar provenance as imputed/missing", () => {
    const quote = snapshotToQuote(
      "AAPL",
      { latestTrade: { p: 110, t: "2026-07-21T13:00:00.000Z" } } as never,
    )!;
    expect(quote.prevClose).toBe(110);
    expect(quote.prevCloseSource).toBe("price_fallback");
    expect(quote.liquiditySource).toBe("imputed");
    expect(quote.rangeSource).toBe("imputed");
  });
});
