import { describe, expect, it } from "vitest";

import {
  COMPANY_DESCRIPTIONS,
  describeCompany,
  overlayCompanyBlurbs,
} from "@/data/symbols/companyDescriptions";

describe("companyDescriptions — real 'what it does' copy, not the generic sector line", () => {
  it("describeCompany is case-insensitive and returns grounded copy", () => {
    expect(describeCompany("RKLB")).toMatch(/launches small Electron orbital rockets/i);
    expect(describeCompany("rklb")).toBe(describeCompany("RKLB"));
    expect(describeCompany("crsp")).toMatch(/CRISPR\/Cas9 gene-editing/i);
  });

  it("returns undefined for names we have no grounded copy for (caller falls back)", () => {
    expect(describeCompany("ZZZZ_NOT_A_TICKER")).toBeUndefined();
    expect(describeCompany("")).toBeUndefined();
    expect(describeCompany(null)).toBeUndefined();
  });

  it("never ships the useless generic '<name> is a <sector> company' template", () => {
    for (const [ticker, desc] of Object.entries(COMPANY_DESCRIPTIONS)) {
      expect(desc, ticker).not.toMatch(/ is a (technology|financial services|healthcare|consumer|industrials|energy|materials|utilities) company\.$/i);
      expect(desc.length, ticker).toBeGreaterThan(25);
    }
  });

  it("overlay REPLACES a stale generic blurb on the already-scored board (no rescan needed)", () => {
    const board = [
      { ticker: "RKLB", companyBlurb: "Rocket Lab Corp is a technology company." },
      { ticker: "CRSP", companyBlurb: "CRISPR Therapeutics AG is a technology company." },
      { ticker: "OBSCURE", companyBlurb: "Obscure Inc is an industrials company." },
    ];
    const out = overlayCompanyBlurbs(board);
    expect(out[0]!.companyBlurb).toMatch(/Rocket Lab builds and launches/i);
    expect(out[1]!.companyBlurb).toMatch(/gene-editing medicines/i);
    // Off-map names keep their existing fallback blurb untouched.
    expect(out[2]!.companyBlurb).toBe("Obscure Inc is an industrials company.");
  });

  it("overlay is idempotent and preserves object identity when nothing changes", () => {
    const board = [{ ticker: "OBSCURE", companyBlurb: "kept" }];
    const out = overlayCompanyBlurbs(board);
    expect(out[0]).toBe(board[0]); // same reference - no needless re-render churn
  });
});
