import { describe, expect, it } from "vitest";

import type { CompanyData } from "@/types";
import {
  type DrugApproval,
  FDA_FORWARD_PDUFA_BLOCKED,
  approvalToCatalystEvent,
  approvalsToCatalystEvents,
  resultToDrugApproval,
} from "@/data/catalysts/fdaCatalysts";
import { buildNameTickerIndex } from "@/data/catalysts/usaSpendingCatalysts";

/**
 * Unit tests for openFDA new-drug-approval → catalyst mapping: novel-NDA/BLA
 * gating (generics excluded), universe-anchored sponsor→ticker resolution,
 * Regulatory typing, the FDA-date + original-submission parse, and the explicit
 * forward-PDUFA data-blocked flag. Deterministic (clock injected).
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

function company(ticker: string, name: string): CompanyData {
  return { ticker, name } as unknown as CompanyData;
}

const INDEX = buildNameTickerIndex([
  company("ABBV", "AbbVie Inc"),
  company("PFE", "Pfizer Inc"),
]);

function approval(over: Partial<DrugApproval>): DrugApproval {
  return {
    sponsorName: over.sponsorName ?? "ABBVIE",
    applicationNumber: over.applicationNumber ?? "NDA218347",
    brandName: over.brandName ?? "RINVOQ",
    dateIso: over.dateIso ?? "2026-06-10",
    url: over.url ?? "https://www.accessdata.fda.gov/x",
    isNovel: over.isNovel ?? true,
  };
}

describe("approvalToCatalystEvent", () => {
  it("maps a novel approval to a Regulatory catalyst on the resolved ticker", () => {
    const e = approvalToCatalystEvent(approval({}), INDEX, NOW)!;
    expect(e.ticker).toBe("ABBV");
    expect(e.catalystType).toBe("Regulatory");
    expect(e.magnitude).toBeGreaterThan(0.5);
    expect(e.summary).toContain("FDA approval");
    expect(e.strength).toBeGreaterThan(0);
  });

  it("drops non-novel (generic/supplement) approvals", () => {
    expect(approvalToCatalystEvent(approval({ isNovel: false }), INDEX, NOW)).toBeNull();
  });

  it("drops sponsors not in the universe", () => {
    expect(
      approvalToCatalystEvent(approval({ sponsorName: "TINY BIOTECH LLC" }), INDEX, NOW),
    ).toBeNull();
  });
});

describe("approvalsToCatalystEvents", () => {
  it("maps a batch, resolving and filtering", () => {
    const out = approvalsToCatalystEvents(
      [
        approval({ sponsorName: "PFIZER", applicationNumber: "BLA125000" }),
        approval({ sponsorName: "PFIZER", applicationNumber: "ANDA200000", isNovel: false }),
      ],
      INDEX,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ticker).toBe("PFE");
  });
});

describe("resultToDrugApproval", () => {
  it("extracts the most recent ORIGINAL approval and parses the FDA date", () => {
    const a = resultToDrugApproval({
      sponsor_name: "ABBVIE",
      application_number: "NDA218347",
      products: [{ brand_name: "RINVOQ LQ" }],
      submissions: [
        { submission_type: "SUPPL", submission_status: "AP", submission_status_date: "20170113" },
        { submission_type: "ORIG", submission_status: "AP", submission_status_date: "20240426" },
      ],
    })!;
    expect(a.sponsorName).toBe("ABBVIE");
    expect(a.dateIso).toBe("2024-04-26");
    expect(a.isNovel).toBe(true);
    expect(a.brandName).toBe("RINVOQ LQ");
  });

  it("flags ANDA (generic) approvals as non-novel", () => {
    const a = resultToDrugApproval({
      sponsor_name: "TARO",
      application_number: "ANDA219052",
      submissions: [
        { submission_type: "ORIG", submission_status: "AP", submission_status_date: "20260615" },
      ],
    })!;
    expect(a.isNovel).toBe(false);
  });

  it("returns null when there is no original approval submission", () => {
    expect(
      resultToDrugApproval({
        sponsor_name: "X",
        application_number: "NDA1",
        submissions: [
          { submission_type: "SUPPL", submission_status: "AP", submission_status_date: "20240101" },
        ],
      }),
    ).toBeNull();
  });
});

describe("forward PDUFA data-blocked flag", () => {
  it("documents the gap explicitly rather than faking forward dates", () => {
    expect(FDA_FORWARD_PDUFA_BLOCKED).toContain("retrospective");
    expect(FDA_FORWARD_PDUFA_BLOCKED).toContain("Not faked");
  });
});
