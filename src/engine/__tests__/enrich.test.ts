import { describe, it, expect } from "vitest";

import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import { narrativeBlob, scoreNarrativeMatch } from "@/engine/narrativeIntel";
import type { CompanyData } from "@/types";

const GENERATED_AT = "2026-06-13T16:00:00.000Z";

describe("toStockSignal", () => {
  it("produces a display-ready signal with all derived fields", () => {
    const company = structuredClone(MOCK_UNIVERSE[0]);
    const breakdown = scoreCompany(company);

    const signal = toStockSignal(company, breakdown, GENERATED_AT);

    // Identity + passthrough fields.
    expect(signal.id).toBe(company.ticker);
    expect(signal.ticker).toBe(company.ticker);
    expect(signal.score).toBe(breakdown);
    expect(signal.generatedAt).toBe(GENERATED_AT);
    expect(signal.confidence).toBe(breakdown.confidence);
    expect(signal.catalystType).toBe(company.catalyst.type);

    // Derived display copy.
    expect(typeof signal.thesis).toBe("string");
    expect(signal.thesis.length).toBeGreaterThan(0);
    expect(Array.isArray(signal.keyFundamentals)).toBe(true);
    expect(signal.hype).toBeDefined();
    expect(signal.marketCapBucket).toBeTruthy();
    expect(signal.riskLevel).toBeTruthy();
  });

  it("is deterministic and does not mutate its inputs", () => {
    const company = structuredClone(MOCK_UNIVERSE[0]);
    const original = structuredClone(company);
    const breakdown = scoreCompany(company);

    const first = toStockSignal(company, breakdown, GENERATED_AT);
    const second = toStockSignal(company, breakdown, GENERATED_AT);

    expect(second).toEqual(first);
    expect(company).toEqual(original);
  });

  it("derives a signal for every company in the sample universe without throwing", () => {
    for (const company of MOCK_UNIVERSE) {
      const breakdown = scoreCompany(company);
      expect(() => toStockSignal(company, breakdown, GENERATED_AT)).not.toThrow();
    }
  });

  // Regression: live / shared-cache signal sources omit the sample-only
  // `socialPosts` (and sometimes `news.items`). An unguarded `.map` on those
  // fields inside narrativeBlob used to throw, aborting screenSignals for the
  // WHOLE universe → the Blueprint leaderboard rendered empty. The engine must
  // treat both as optional and never throw.
  describe("missing sample-only fields (live / shared-cache shape)", () => {
    function companyWithoutSocial(): CompanyData {
      const c = structuredClone(MOCK_UNIVERSE[0]!);
      // Mimic a live provider / shared-cache row that never populated these.
      delete (c as Partial<CompanyData>).socialPosts;
      return c as CompanyData;
    }

    it("scoreCompany + toStockSignal tolerate a missing socialPosts", () => {
      const company = companyWithoutSocial();
      const breakdown = scoreCompany(company);
      const signal = toStockSignal(company, breakdown, GENERATED_AT);
      // Normalized to a valid array so downstream readers never see undefined.
      expect(Array.isArray(signal.socialPosts)).toBe(true);
    });

    it("narrativeBlob + scoreNarrativeMatch never throw on undefined socialPosts/news.items", () => {
      const company = companyWithoutSocial();
      const breakdown = scoreCompany(company);
      const signal = toStockSignal(company, breakdown, GENERATED_AT);
      // Simulate the harshest case: even after normalization, force both fields
      // away to prove the consumers themselves are defensive.
      const degraded = {
        ...signal,
        socialPosts: undefined as never,
        news: { ...signal.news, items: undefined as never },
      };
      expect(() => narrativeBlob(degraded)).not.toThrow();
      expect(() => scoreNarrativeMatch(degraded, ["quantum", "robotics"])).not.toThrow();
      // It still produces a usable lowercase blob from the remaining fields.
      expect(narrativeBlob(degraded)).toContain(signal.ticker.toLowerCase());
    });
  });
});
