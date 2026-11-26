import { describe, expect, it } from "vitest";

import {
  type ThirteenDInput,
  eftsHitToThirteenDInput,
  isIndexFundFiler,
  thirteenDToCatalystEvent,
  thirteenDsToCatalystEvents,
} from "@/data/catalysts/edgar13dCatalysts";

/**
 * Unit tests for the SC 13D/13G → catalyst mapper: activist vs passive
 * materiality, index-fund 13G filtering, amendment/exit negativity, the EFTS
 * hit→input parse (issuer ticker from the FIRST display_name, filer from the
 * second), and Institutional typing. Deterministic (clock injected).
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

function input(over: Partial<ThirteenDInput>): ThirteenDInput {
  return {
    ticker: over.ticker ?? "AAA",
    companyName: over.companyName ?? "Alpha Inc",
    filerName: over.filerName ?? "Activist Capital LLC",
    rootForm: over.rootForm ?? "SC 13D",
    amendment: over.amendment ?? false,
    dateIso: over.dateIso ?? "2026-06-16",
    url: over.url ?? "https://www.sec.gov/x-index.htm",
    changeSign: over.changeSign,
  };
}

describe("thirteenDToCatalystEvent", () => {
  it("maps a fresh 13D to a strong positive Institutional catalyst", () => {
    const e = thirteenDToCatalystEvent(input({ rootForm: "SC 13D" }), NOW)!;
    expect(e.catalystType).toBe("Institutional");
    expect(e.magnitude).toBeGreaterThan(0.7);
    expect(e.negative).toBe(false);
    expect(e.strength).toBeGreaterThan(0);
    expect(e.summary).toContain("activist");
  });

  it("scores a passive 13G lower than an activist 13D", () => {
    const d = thirteenDToCatalystEvent(input({ rootForm: "SC 13D" }), NOW)!;
    const g = thirteenDToCatalystEvent(
      input({ rootForm: "SC 13G", filerName: "Boutique Fund LP" }),
      NOW,
    )!;
    expect(g.magnitude).toBeLessThan(d.magnitude);
  });

  it("filters mega-passive index-fund 13Gs as noise", () => {
    expect(
      thirteenDToCatalystEvent(input({ rootForm: "SC 13G", filerName: "The Vanguard Group" }), NOW),
    ).toBeNull();
    expect(
      thirteenDToCatalystEvent(input({ rootForm: "SC 13G", filerName: "BlackRock, Inc." }), NOW),
    ).toBeNull();
    // ...but an ACTIVIST 13D from a big name is NOT filtered (it's a real stake).
    expect(
      thirteenDToCatalystEvent(input({ rootForm: "SC 13D", filerName: "BlackRock, Inc." }), NOW),
    ).not.toBeNull();
  });

  it("treats a 13D/A reduction (changeSign -1) as a negative catalyst", () => {
    const e = thirteenDToCatalystEvent(
      input({ rootForm: "SC 13D", amendment: true, changeSign: -1 }),
      NOW,
    )!;
    expect(e.negative).toBe(true);
    expect(e.strength).toBeLessThan(0);
    expect(e.summary).toContain("reduced");
  });

  it("de-weights an amendment vs the initial filing", () => {
    const initial = thirteenDToCatalystEvent(input({ amendment: false }), NOW)!;
    const amend = thirteenDToCatalystEvent(input({ amendment: true }), NOW)!;
    expect(amend.magnitude).toBeLessThan(initial.magnitude);
  });

  it("returns null for a missing issuer ticker", () => {
    expect(thirteenDToCatalystEvent(input({ ticker: "" }), NOW)).toBeNull();
  });
});

describe("isIndexFundFiler", () => {
  it("recognizes mega-passive managers and ignores boutiques", () => {
    expect(isIndexFundFiler("State Street Corp")).toBe(true);
    expect(isIndexFundFiler("FMR LLC")).toBe(true);
    expect(isIndexFundFiler("Engine No. 1 LLC")).toBe(false);
    expect(isIndexFundFiler(undefined)).toBe(false);
  });
});

describe("thirteenDsToCatalystEvents", () => {
  it("maps a batch and drops filtered/unscorable filings", () => {
    const out = thirteenDsToCatalystEvents(
      [
        input({ ticker: "AAA", rootForm: "SC 13D" }),
        input({ ticker: "BBB", rootForm: "SC 13G", filerName: "Vanguard" }), // filtered
        input({ ticker: "", rootForm: "SC 13D" }), // no ticker
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ticker).toBe("AAA");
  });
});

describe("eftsHitToThirteenDInput", () => {
  it("parses the issuer ticker from the first display_name and filer from the second", () => {
    const got = eftsHitToThirteenDInput(
      {
        adsh: "0001493152-24-022270",
        display_names: [
          "REVIVA PHARMACEUTICALS HOLDINGS, INC.  (RVPH, RVPHW)  (CIK 0001742927)",
          "VEDANTA PARTNERS, LLC  (CIK 0001502216)",
        ],
        file_type: "SC 13D/A",
        root_forms: ["SC 13D"],
        file_date: "2024-05-31",
        ciks: ["0001742927", "0001502216"],
      },
      undefined,
    )!;
    expect(got.ticker).toBe("RVPH");
    expect(got.companyName).toContain("REVIVA");
    expect(got.filerName).toContain("VEDANTA");
    expect(got.rootForm).toBe("SC 13D");
    expect(got.amendment).toBe(true); // /A
    expect(got.url).toContain("/1742927/");
  });

  it("returns null when the issuer carries no ticker", () => {
    expect(
      eftsHitToThirteenDInput(
        {
          adsh: "x",
          display_names: ["SOME PRIVATE ISSUER (CIK 0000000001)", "Filer LLC (CIK 0000000002)"],
          file_type: "SC 13G",
          root_forms: ["SC 13G"],
          file_date: "2024-05-31",
        },
        undefined,
      ),
    ).toBeNull();
  });
});
