import { describe, expect, it } from "vitest";
import { hasPositiveEarningsEvidence, looksUnprofitable } from "../profitability";

describe("profitability truth helpers (the SoFi −19.8% guard)", () => {
  describe("hasPositiveEarningsEvidence", () => {
    it("true for a positive P/E (positive trailing earnings)", () => {
      expect(hasPositiveEarningsEvidence(38)).toBe(true);
    });
    it("false for a non-positive / missing P/E", () => {
      expect(hasPositiveEarningsEvidence(0)).toBe(false);
      expect(hasPositiveEarningsEvidence(-5)).toBe(false);
      expect(hasPositiveEarningsEvidence(null)).toBe(false);
      expect(hasPositiveEarningsEvidence(undefined)).toBe(false);
      expect(hasPositiveEarningsEvidence(NaN)).toBe(false);
    });
  });

  describe("looksUnprofitable", () => {
    it("SoFi case: negative net margin vetoed by a positive P/E → NOT unprofitable", () => {
      expect(looksUnprofitable(-0.198, 38)).toBe(false);
    });
    it("genuinely unprofitable: negative net margin AND no positive P/E → unprofitable", () => {
      expect(looksUnprofitable(-0.45, null)).toBe(true);
      expect(looksUnprofitable(-0.45, 0)).toBe(true);
    });
    it("positive net margin is never unprofitable", () => {
      expect(looksUnprofitable(0.15, 40)).toBe(false);
      expect(looksUnprofitable(0.15, null)).toBe(false);
    });
    it("missing net margin → not flagged", () => {
      expect(looksUnprofitable(null, null)).toBe(false);
      expect(looksUnprofitable(undefined, 38)).toBe(false);
    });
  });
});
