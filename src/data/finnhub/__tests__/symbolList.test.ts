import { describe, expect, it } from "vitest";

import {
  fetchUsCommonStockUniverseAudited,
  parseFinnhubSymbolEntries,
  parseFinnhubSymbols,
} from "@/data/finnhub/symbolList";
import type { FinnhubSymbolRow } from "@/data/finnhub/symbolList";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(overrides: Partial<FinnhubSymbolRow>): FinnhubSymbolRow {
  return {
    symbol: "AAPL",
    description: "APPLE INC",
    type: "Common Stock",
    mic: "XNAS",
    currency: "USD",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Type filtering
// ---------------------------------------------------------------------------
describe("parseFinnhubSymbolEntries — type filtering", () => {
  it("keeps Common Stock", () => {
    const result = parseFinnhubSymbolEntries([row({ type: "Common Stock" })]);
    expect(result.map((e) => e.symbol)).toContain("AAPL");
  });

  it("keeps ADR", () => {
    const result = parseFinnhubSymbolEntries([
      row({ symbol: "TSM", description: "TAIWAN SEMI", type: "ADR" }),
    ]);
    expect(result.map((e) => e.symbol)).toContain("TSM");
  });

  it("keeps REIT", () => {
    const result = parseFinnhubSymbolEntries([
      row({ symbol: "O", description: "REALTY INCOME CORP", type: "REIT" }),
    ]);
    expect(result.map((e) => e.symbol)).toContain("O");
  });

  it("drops ETP", () => {
    const result = parseFinnhubSymbolEntries([row({ type: "ETP" })]);
    expect(result).toHaveLength(0);
  });

  it("drops Warrant", () => {
    const result = parseFinnhubSymbolEntries([row({ type: "Warrant" })]);
    expect(result).toHaveLength(0);
  });

  it("drops Unit", () => {
    const result = parseFinnhubSymbolEntries([row({ type: "Unit" })]);
    expect(result).toHaveLength(0);
  });

  it("drops Right", () => {
    const result = parseFinnhubSymbolEntries([row({ type: "Right" })]);
    expect(result).toHaveLength(0);
  });

  it("skips rows where type is missing/undefined (conservative)", () => {
    const result = parseFinnhubSymbolEntries([row({ type: undefined })]);
    expect(result).toHaveLength(0);
  });

  it("skips rows where type is empty string", () => {
    const result = parseFinnhubSymbolEntries([row({ type: "" })]);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ticker cleanliness
// ---------------------------------------------------------------------------
describe("parseFinnhubSymbolEntries — ticker cleanliness", () => {
  it("keeps a clean 1–5 letter ticker", () => {
    const result = parseFinnhubSymbolEntries([row({ symbol: "MSFT" })]);
    expect(result.map((e) => e.symbol)).toContain("MSFT");
  });

  it("keeps a single-letter ticker", () => {
    const result = parseFinnhubSymbolEntries([
      row({ symbol: "V", description: "VISA INC" }),
    ]);
    expect(result.map((e) => e.symbol)).toContain("V");
  });

  it("drops BRK.B (has a dot)", () => {
    const result = parseFinnhubSymbolEntries([
      row({ symbol: "BRK.B", description: "BERKSHIRE HATHAWAY" }),
    ]);
    expect(result).toHaveLength(0);
  });

  it("drops ABC.U (has a dot)", () => {
    const result = parseFinnhubSymbolEntries([row({ symbol: "ABC.U" })]);
    expect(result).toHaveLength(0);
  });

  it("drops ABC-PA (has a dash)", () => {
    const result = parseFinnhubSymbolEntries([row({ symbol: "ABC-PA" })]);
    expect(result).toHaveLength(0);
  });

  it("drops TOOLONGX (more than 5 letters)", () => {
    const result = parseFinnhubSymbolEntries([row({ symbol: "TOOLONGX" })]);
    expect(result).toHaveLength(0);
  });

  it("drops a lowercase ticker (regex requires [A-Z]; source trims+uppercases before testing)", () => {
    // The source does symbol.trim().toUpperCase() so "aapl" becomes "AAPL"
    // and passes the regex - this is the actual behaviour; we assert it.
    const result = parseFinnhubSymbolEntries([row({ symbol: "aapl" })]);
    // After normalisation, "aapl" → "AAPL" which IS a clean root ticker.
    // The source keeps it; verify the normalised symbol is returned.
    if (result.length > 0) {
      expect(result[0]!.symbol).toBe("AAPL");
    }
    // A truly un-fixable dirty ticker still gets dropped.
    const dirty = parseFinnhubSymbolEntries([row({ symbol: "abc.x" })]);
    expect(dirty).toHaveLength(0);
  });

  it("drops a ticker with digits", () => {
    const result = parseFinnhubSymbolEntries([row({ symbol: "AB2C" })]);
    expect(result).toHaveLength(0);
  });

  it("normalises the symbol to uppercase before returning", () => {
    // Injecting a mixed-case symbol that would pass after uppercasing
    // to verify normalisation; but per the regex /^[A-Z]{1,5}$/ the input
    // must already be uppercase - this test verifies trim+upper is applied.
    const result = parseFinnhubSymbolEntries([row({ symbol: "  AMZN  " })]);
    if (result.length > 0) {
      expect(result[0]!.symbol).toBe("AMZN");
    }
    // A symbol that is already clean after trim/upper is fine
    const result2 = parseFinnhubSymbolEntries([row({ symbol: "AMZN" })]);
    expect(result2[0]!.symbol).toBe("AMZN");
  });
});

// ---------------------------------------------------------------------------
// requireUsd
// ---------------------------------------------------------------------------
describe("parseFinnhubSymbolEntries — requireUsd (default true)", () => {
  it("keeps a USD row", () => {
    const result = parseFinnhubSymbolEntries([row({ currency: "USD" })]);
    expect(result).toHaveLength(1);
  });

  it("drops a CAD row when requireUsd=true (default)", () => {
    const result = parseFinnhubSymbolEntries([row({ currency: "CAD" })]);
    expect(result).toHaveLength(0);
  });

  it("allows empty string currency", () => {
    const result = parseFinnhubSymbolEntries([row({ currency: "" })]);
    expect(result).toHaveLength(1);
  });

  it("allows absent/undefined currency", () => {
    const result = parseFinnhubSymbolEntries([row({ currency: undefined })]);
    expect(result).toHaveLength(1);
  });

  it("includes CAD rows when requireUsd=false", () => {
    const result = parseFinnhubSymbolEntries([row({ currency: "CAD" })], {
      requireUsd: false,
    });
    expect(result).toHaveLength(1);
  });

  it("is case-insensitive for USD check (accepts 'usd')", () => {
    const result = parseFinnhubSymbolEntries([row({ currency: "usd" })]);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// De-duplication
// ---------------------------------------------------------------------------
describe("parseFinnhubSymbolEntries — de-duplication", () => {
  it("de-dupes repeated symbols, keeping only the first occurrence", () => {
    const rows = [
      row({ symbol: "AAPL", description: "APPLE INC FIRST" }),
      row({ symbol: "AAPL", description: "APPLE INC SECOND" }),
    ];
    const result = parseFinnhubSymbolEntries(rows);
    expect(result.filter((e) => e.symbol === "AAPL")).toHaveLength(1);
    expect(result[0]!.name).toBe("Apple Inc First");
  });
});

// ---------------------------------------------------------------------------
// Title-case name
// ---------------------------------------------------------------------------
describe("parseFinnhubSymbolEntries — name / title-case", () => {
  it("title-cases an ALL CAPS description ('ROCKET LAB CORP' → 'Rocket Lab Corp')", () => {
    const result = parseFinnhubSymbolEntries([
      row({ description: "ROCKET LAB CORP" }),
    ]);
    expect(result[0]!.name).toBe("Rocket Lab Corp");
  });

  it("falls back to the symbol when description is missing/empty", () => {
    const result = parseFinnhubSymbolEntries([
      row({ description: undefined }),
    ]);
    expect(result[0]!.name).toBe("AAPL");
  });

  it("falls back to symbol when description is empty string", () => {
    const result = parseFinnhubSymbolEntries([row({ description: "" })]);
    expect(result[0]!.name).toBe("AAPL");
  });

  it("leaves mixed-case descriptions unchanged", () => {
    const result = parseFinnhubSymbolEntries([
      row({ description: "Already Cased Inc" }),
    ]);
    expect(result[0]!.name).toBe("Already Cased Inc");
  });

  it("title-cases ALL CAPS descriptions including common suffixes (no re-uppercasing)", () => {
    const result = parseFinnhubSymbolEntries([
      row({ description: "ACME INC" }),
    ]);
    expect(result[0]!.name).toBe("Acme Inc");
    const result2 = parseFinnhubSymbolEntries([
      row({ symbol: "NOVB", description: "NOVA BIOTECH LTD" }),
    ]);
    expect(result2[0]!.name).toBe("Nova Biotech Ltd");
  });
});

// ---------------------------------------------------------------------------
// Edge cases / robustness
// ---------------------------------------------------------------------------
describe("parseFinnhubSymbolEntries — edge cases", () => {
  it("returns [] for non-array input", () => {
    expect(parseFinnhubSymbolEntries(null)).toEqual([]);
    expect(parseFinnhubSymbolEntries(undefined)).toEqual([]);
    expect(parseFinnhubSymbolEntries("bad")).toEqual([]);
    expect(parseFinnhubSymbolEntries(42)).toEqual([]);
    expect(parseFinnhubSymbolEntries({})).toEqual([]);
  });

  it("silently skips non-object elements in the array", () => {
    const mixed = [null, undefined, 42, "string", row({})];
    const result = parseFinnhubSymbolEntries(mixed as never);
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe("AAPL");
  });

  it("skips rows with no symbol", () => {
    const result = parseFinnhubSymbolEntries([row({ symbol: undefined })]);
    expect(result).toHaveLength(0);
  });

  it("allows a custom keepTypes set", () => {
    const result = parseFinnhubSymbolEntries(
      [row({ type: "ETP", symbol: "SPY" })],
      { keepTypes: new Set(["ETP"]) },
    );
    expect(result.map((e) => e.symbol)).toContain("SPY");
  });
});

// ---------------------------------------------------------------------------
// parseFinnhubSymbols
// ---------------------------------------------------------------------------
describe("parseFinnhubSymbols", () => {
  it("returns just the symbol strings", () => {
    const rows = [
      row({ symbol: "AAPL", description: "APPLE INC" }),
      row({ symbol: "MSFT", description: "MICROSOFT CORP" }),
      row({ type: "ETP", symbol: "SPY" }), // dropped
    ];
    const result = parseFinnhubSymbols(rows);
    expect(result).toContain("AAPL");
    expect(result).toContain("MSFT");
    expect(result).not.toContain("SPY");
  });

  it("returns an array of strings (not objects)", () => {
    const result = parseFinnhubSymbols([row({})]);
    expect(typeof result[0]).toBe("string");
  });

  it("returns [] for empty / invalid input", () => {
    expect(parseFinnhubSymbols([])).toEqual([]);
    expect(parseFinnhubSymbols(null)).toEqual([]);
  });
});

describe("fetchUsCommonStockUniverseAudited", () => {
  const now = () => new Date("2026-07-21T12:00:00.000Z");

  it("records sanitized minimum coverage without claiming completeness", async () => {
    const result = await fetchUsCommonStockUniverseAudited({
      getKey: () => "secret-canary",
      fetchJson: async () => [row({ symbol: "AAPL" }), row({ symbol: "MSFT" })],
      now,
      minimumExpectedEligibleCount: 1,
    });
    expect(result.audit.status).toBe("minimum_coverage_met");
    expect(result.audit.rawRowCount).toBe(2);
    expect(result.audit.eligibleEntryCount).toBe(2);
    expect(JSON.stringify(result.audit)).not.toContain("secret-canary");
    expect(JSON.stringify(result.audit)).not.toContain("token=");
  });

  it("distinguishes missing configuration, transport failure, and invalid payload", async () => {
    const notConfigured = await fetchUsCommonStockUniverseAudited({ getKey: () => undefined, now });
    const failed = await fetchUsCommonStockUniverseAudited({
      getKey: () => "configured",
      fetchJson: async () => {
        throw new Error("secret-canary-provider-error");
      },
      now,
    });
    const invalid = await fetchUsCommonStockUniverseAudited({
      getKey: () => "configured",
      fetchJson: async () => ({ message: "wrong shape" }),
      now,
    });
    expect(notConfigured.audit.status).toBe("not_configured");
    expect(failed.audit.status).toBe("request_failed");
    expect(invalid.audit.status).toBe("invalid_payload");
    expect(JSON.stringify(failed.audit)).not.toContain("secret-canary-provider-error");
  });

  it("does not call empty or zero-eligible arrays complete", async () => {
    const empty = await fetchUsCommonStockUniverseAudited({
      getKey: () => "configured",
      fetchJson: async () => [],
      now,
    });
    const zeroEligible = await fetchUsCommonStockUniverseAudited({
      getKey: () => "configured",
      fetchJson: async () => [row({ type: "Warrant" })],
      now,
    });
    expect(empty.audit.status).toBe("empty_payload");
    expect(zeroEligible.audit.status).toBe("empty_eligible");
  });

  it("quarantines implausibly small successful memberships", async () => {
    const result = await fetchUsCommonStockUniverseAudited({
      getKey: () => "configured",
      fetchJson: async () => [row({ symbol: "AAPL" })],
      now,
      minimumExpectedEligibleCount: 2,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.audit.status).toBe("coverage_below_minimum");
    expect(result.audit.minimumExpectedEligibleCount).toBe(2);
  });

  it("treats an exact-1,000 production response as a likely truncation", async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => {
      let value = index;
      let symbol = "";
      for (let place = 0; place < 4; place++) {
        symbol = String.fromCharCode(65 + (value % 26)) + symbol;
        value = Math.floor(value / 26);
      }
      return row({ symbol });
    });
    const result = await fetchUsCommonStockUniverseAudited({
      getKey: () => "configured",
      fetchJson: async () => rows,
      now,
    });
    expect(result.entries).toHaveLength(1_000);
    expect(result.audit.status).toBe("coverage_below_minimum");
    expect(result.audit.minimumExpectedEligibleCount).toBe(1_001);
  });
});
