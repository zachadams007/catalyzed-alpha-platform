import { describe, expect, it } from "vitest";

import {
  applyEarningsToCompany,
  EARNINGS_BASE_MAGNITUDE,
  EARNINGS_CATALYST_HORIZON_DAYS,
} from "@/data/earnings/enrichCompanyEarnings";
import type { CompanyData, CatalystType } from "@/types";

function company(over: {
  catalystLive?: boolean;
  type?: CatalystType;
  daysAway?: number;
  magnitude?: number;
}): CompanyData {
  return {
    ticker: "XYZ",
    name: "Xyz Corp",
    catalystLive: over.catalystLive,
    catalyst: {
      type: over.type ?? "Product",
      description: "incumbent catalyst",
      daysAway: over.daysAway ?? 999,
      magnitude: over.magnitude ?? 0.3,
    },
  } as unknown as CompanyData;
}

const event = (dateISO: string, eps: number | null = 0.42) => ({ dateISO, epsEstimate: eps });

describe("applyEarningsToCompany", () => {
  it("always attaches nextEarnings, even when it doesn't take the catalyst slot", () => {
    const c = company({ catalystLive: true, daysAway: 2, type: "M&A" }); // strong, sooner incumbent
    const out = applyEarningsToCompany(c, event("2026-08-01"), 60); // beyond horizon
    expect(out.nextEarnings).toEqual({ dateISO: "2026-08-01", daysAway: 60, epsEstimate: 0.42 });
    expect(out.catalyst.type).toBe("M&A"); // incumbent kept
    expect(out.catalyst.daysAway).toBe(2);
  });

  it("adopts the earnings catalyst when there is no live catalyst", () => {
    const c = company({ catalystLive: false });
    const out = applyEarningsToCompany(c, event("2026-06-26"), 12);
    expect(out.catalyst.type).toBe("Earnings");
    expect(out.catalyst.daysAway).toBe(12);
    expect(out.catalystLive).toBe(true);
    expect(out.catalyst.description).toContain("2026-06-26");
    expect(out.catalyst.description).toContain("0.42");
  });

  it("adopts when the earnings is sooner than an existing live catalyst", () => {
    const c = company({ catalystLive: true, type: "Regulatory", daysAway: 40 });
    const out = applyEarningsToCompany(c, event("2026-06-20"), 6);
    expect(out.catalyst.type).toBe("Earnings");
    expect(out.catalyst.daysAway).toBe(6);
  });

  it("keeps a sooner live catalyst rather than overwriting it with a later earnings", () => {
    const c = company({ catalystLive: true, type: "Clinical", daysAway: 3 });
    const out = applyEarningsToCompany(c, event("2026-07-05"), 25);
    expect(out.catalyst.type).toBe("Clinical");
    expect(out.catalyst.daysAway).toBe(3);
    expect(out.nextEarnings!.daysAway).toBe(25); // still recorded
  });

  it("does not adopt an earnings beyond the catalyst horizon", () => {
    const c = company({ catalystLive: false });
    const out = applyEarningsToCompany(c, event("2026-12-01"), EARNINGS_CATALYST_HORIZON_DAYS + 5);
    expect(out.catalyst.type).toBe("Product"); // unchanged
    expect(out.nextEarnings).toBeDefined();
  });

  it("never lowers an existing catalyst magnitude below the earnings baseline", () => {
    const weak = applyEarningsToCompany(company({ catalystLive: false, magnitude: 0.2 }), event("2026-06-20"), 6);
    expect(weak.catalyst.magnitude).toBe(EARNINGS_BASE_MAGNITUDE);
    const strong = applyEarningsToCompany(company({ catalystLive: false, magnitude: 0.9 }), event("2026-06-20"), 6);
    expect(strong.catalyst.magnitude).toBe(0.9); // preserves a higher incumbent magnitude
  });

  it("adopts earnings over a MODELED (not real) catalyst even when the modeled one is 'sooner'", () => {
    // catalystLive: undefined => not a real catalyst per isRealCatalyst, so it
    // must not block earnings adoption even though its daysAway is smaller.
    const c = company({ catalystLive: undefined, type: "Product", daysAway: 3, magnitude: 0.3 });
    const out = applyEarningsToCompany(c, event("2026-08-10"), 40);
    expect(out.catalyst.type).toBe("Earnings");
    expect(out.catalyst.daysAway).toBe(40);
    expect(out.catalystLive).toBe(true);
  });

  it("adopts earnings over an explicitly-false-live catalyst regardless of its daysAway", () => {
    const c = company({ catalystLive: false, type: "Product", daysAway: 1, magnitude: 0.9 });
    const out = applyEarningsToCompany(c, event("2026-07-15"), 13);
    expect(out.catalyst.type).toBe("Earnings");
    expect(out.catalyst.daysAway).toBe(13);
  });

  it("is pure — it does not mutate the input company", () => {
    const c = company({ catalystLive: false });
    const before = JSON.stringify(c);
    applyEarningsToCompany(c, event("2026-06-20"), 6);
    expect(JSON.stringify(c)).toBe(before);
  });
});
