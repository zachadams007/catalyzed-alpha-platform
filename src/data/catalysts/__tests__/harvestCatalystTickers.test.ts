import { describe, expect, it } from "vitest";

import {
  containsCodeP,
  extractIssuerSymbol,
  isValidTicker,
  keepableItems,
  parseDisplayNameTicker,
} from "@/data/catalysts/harvestCatalystTickers";

/**
 * Unit tests for the pure harvest helpers in harvestCatalystTickers.ts.
 * No network calls - all parsers are tested against inline fixtures that
 * mirror real EFTS JSON shapes and real Form 4 XML fragments.
 */

// ── parseDisplayNameTicker ───────────────────────────────────────────────────

describe("parseDisplayNameTicker", () => {
  it("extracts ticker from a full EDGAR display_name with CIK suffix", () => {
    // Exact shape from EFTS _source.display_names[0].
    expect(
      parseDisplayNameTicker("American Outdoor Brands, Inc.  (AOUT)  (CIK 0001808997)"),
    ).toBe("AOUT");
  });

  it("extracts ticker when there is no CIK group", () => {
    expect(parseDisplayNameTicker("Acme Corp (ACME)")).toBe("ACME");
  });

  it("handles a dot in the ticker (e.g. BRK.B)", () => {
    expect(parseDisplayNameTicker("Berkshire Hathaway Inc  (BRK.B)  (CIK 0000093088)")).toBe(
      "BRK.B",
    );
  });

  it("returns empty string when there is no parenthesised ticker", () => {
    expect(parseDisplayNameTicker("No Ticker Corp")).toBe("");
    expect(parseDisplayNameTicker("")).toBe("");
  });

  it("does not confuse the CIK group for a ticker", () => {
    // CIK groups are "(CIK <digits>)" - should be stripped first.
    expect(parseDisplayNameTicker("Widget Inc (CIK 0001234567)")).toBe("");
  });

  it("is case-sensitive on the extraction but accepts lowercase display_name text", () => {
    // The company prose is lowercase/mixed; the ticker parens should be uppercase.
    expect(parseDisplayNameTicker("Foo bar inc (FOO) (CIK 0000012345)")).toBe("FOO");
  });
});

// ── keepableItems ────────────────────────────────────────────────────────────

describe("keepableItems", () => {
  it("returns true when at least one keep-listed item is present", () => {
    expect(keepableItems(["1.01", "9.01"])).toBe(true); // material agreement + exhibit
    expect(keepableItems(["2.01"])).toBe(true); // acquisition
    expect(keepableItems(["2.02", "9.01"])).toBe(true); // earnings + exhibit
    expect(keepableItems(["5.01"])).toBe(true); // change of control
    expect(keepableItems(["5.02"])).toBe(true); // exec change
  });

  it("returns false for exhibits-only filings (9.01)", () => {
    expect(keepableItems(["9.01"])).toBe(false);
  });

  it("returns false when no item codes are present", () => {
    expect(keepableItems([])).toBe(false);
    // @ts-expect-error intentional runtime guard test
    expect(keepableItems(null)).toBe(false);
    // @ts-expect-error intentional runtime guard test
    expect(keepableItems(undefined)).toBe(false);
  });

  it("returns false for unmapped item codes (e.g. 6.01 ABS-only)", () => {
    expect(keepableItems(["6.01", "9.01"])).toBe(false);
  });

  it("normalises 'Item X.XX' prefix variants", () => {
    expect(keepableItems(["Item 1.01", "9.01"])).toBe(true);
    expect(keepableItems(["item 2.01"])).toBe(true);
  });

  it("returns false when the only items are 3.01/3.02/4.01/4.02 (not in keep set)", () => {
    // These are SCORABLE in edgar8kCatalysts but not in the harvest keep set
    // (the harvest only seeds for trading-oriented material events).
    expect(keepableItems(["3.01"])).toBe(false);
    expect(keepableItems(["4.02"])).toBe(false);
  });
});

// ── containsCodeP ─────────────────────────────────────────────────────────

describe("containsCodeP", () => {
  // Minimal but realistic Form 4 XML fragment - one non-derivative transaction block.
  const SAMPLE_FORM4_P = `<?xml version="1.0"?>
<ownershipDocument>
  <issuerTradingSymbol>NVDA</issuerTradingSymbol>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionAmounts>
        <transactionCode>P</transactionCode>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>128.50</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

  const SAMPLE_FORM4_S = `<?xml version="1.0"?>
<ownershipDocument>
  <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionAmounts>
        <transactionCode>S</transactionCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

  const SAMPLE_FORM4_AWARD = `<?xml version="1.0"?>
<ownershipDocument>
  <issuerTradingSymbol>MSFT</issuerTradingSymbol>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionAmounts>
        <transactionCode>A</transactionCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

  it("detects code P (open-market purchase)", () => {
    expect(containsCodeP(SAMPLE_FORM4_P)).toBe(true);
  });

  it("returns false for code S (sale)", () => {
    expect(containsCodeP(SAMPLE_FORM4_S)).toBe(false);
  });

  it("returns false for code A (award)", () => {
    expect(containsCodeP(SAMPLE_FORM4_AWARD)).toBe(false);
  });

  it("is case-insensitive on the tag name and the value P (SEC always sends uppercase but guard is lenient)", () => {
    // Tag name uppercased - still a match.
    const upperTag = `<TRANSACTIONCODE>P</TRANSACTIONCODE>`;
    expect(containsCodeP(upperTag)).toBe(true);
    // Lowercase 'p' - the /gi flag treats it as a match too (SEC XML always
    // sends uppercase, but accepting lowercase is an acceptable leniency).
    const lowerP = `<transactionCode>p</transactionCode>`;
    expect(containsCodeP(lowerP)).toBe(true);
  });

  it("finds code P even when multiple transactions exist (mixed P + S)", () => {
    const mixed = `
      <transactionCode>S</transactionCode>
      <transactionCode>P</transactionCode>
    `;
    expect(containsCodeP(mixed)).toBe(true);
  });

  it("returns false for empty or non-XML input", () => {
    expect(containsCodeP("")).toBe(false);
    expect(containsCodeP("no xml here")).toBe(false);
  });
});

// ── extractIssuerSymbol ──────────────────────────────────────────────────────

describe("extractIssuerSymbol", () => {
  it("extracts the issuer trading symbol from a Form 4 XML string", () => {
    const xml = `<ownershipDocument>
      <issuerTradingSymbol>NVDA</issuerTradingSymbol>
    </ownershipDocument>`;
    expect(extractIssuerSymbol(xml)).toBe("NVDA");
  });

  it("uppercases the extracted symbol", () => {
    const xml = `<issuerTradingSymbol>aapl</issuerTradingSymbol>`;
    expect(extractIssuerSymbol(xml)).toBe("AAPL");
  });

  it("trims whitespace around the symbol", () => {
    const xml = `<issuerTradingSymbol>  TSLA  </issuerTradingSymbol>`;
    expect(extractIssuerSymbol(xml)).toBe("TSLA");
  });

  it("returns empty string when the tag is absent", () => {
    expect(extractIssuerSymbol("<ownershipDocument></ownershipDocument>")).toBe("");
    expect(extractIssuerSymbol("")).toBe("");
  });
});

// ── isValidTicker ────────────────────────────────────────────────────────────

describe("isValidTicker", () => {
  it("accepts standard 1–5 letter tickers", () => {
    expect(isValidTicker("A")).toBe(true);
    expect(isValidTicker("AAPL")).toBe(true);
    expect(isValidTicker("GOOGL")).toBe(true);
  });

  it("accepts tickers with a dot (BRK.B)", () => {
    expect(isValidTicker("BRK.B")).toBe(true);
  });

  it("rejects lowercase", () => {
    expect(isValidTicker("aapl")).toBe(false);
    expect(isValidTicker("Aapl")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidTicker("")).toBe(false);
  });

  it("rejects tickers longer than 5 characters", () => {
    expect(isValidTicker("TOOLONG")).toBe(false);
  });

  it("rejects tickers starting with a digit", () => {
    expect(isValidTicker("1ABC")).toBe(false);
  });

  it("rejects strings with special characters", () => {
    expect(isValidTicker("AA-B")).toBe(false);
    expect(isValidTicker("AA BB")).toBe(false);
  });
});
