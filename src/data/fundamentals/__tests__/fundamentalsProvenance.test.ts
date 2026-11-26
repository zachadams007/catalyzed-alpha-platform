import { describe, it, expect } from "vitest";
import {
  allFalseFundamentalsAvailability,
  asOfQualifier,
  FUNDAMENTAL_KEYS,
  hasAnyAvailableFundamental,
  isFundamentalsFresh,
  parseAsOfMs,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";

describe("fundamentalsProvenance helpers", () => {
  it("unknownFundamentals + allFalseFundamentalsAvailability cover every key", () => {
    const f = unknownFundamentals();
    const av = allFalseFundamentalsAvailability();
    for (const k of FUNDAMENTAL_KEYS) {
      expect(k in f).toBe(true);
      expect(av[k]).toBe(false);
    }
    expect(f.peRatio).toBeNull();
    expect(f.netMargin).toBe(0);
  });

  it("hasAnyAvailableFundamental is false for empty/all-false, true when one is set", () => {
    expect(hasAnyAvailableFundamental(undefined)).toBe(false);
    expect(hasAnyAvailableFundamental(allFalseFundamentalsAvailability())).toBe(false);
    expect(hasAnyAvailableFundamental({ netMargin: true })).toBe(true);
  });

  it("parseAsOfMs handles ISO date, YYYY-MM, and fiscal-quarter labels", () => {
    expect(parseAsOfMs("2025-09-30")).toBe(Date.UTC(2025, 8, 30));
    expect(parseAsOfMs("2025-09")).toBe(Date.UTC(2025, 8, 1));
    // Q3 2025 → quarter-end Sep 30.
    expect(parseAsOfMs("TTM 2025-Q3")).toBe(Date.UTC(2025, 9, 0));
    expect(parseAsOfMs(undefined)).toBeNull();
    expect(parseAsOfMs("not-a-date")).toBeNull();
  });

  it("isFundamentalsFresh: present+in-window = true; stale/undated/future = false", () => {
    const now = Date.UTC(2026, 5, 19);
    expect(isFundamentalsFresh("2026-05-01", now)).toBe(true); // ~49 days
    expect(isFundamentalsFresh("2025-01-01", now)).toBe(false); // >200 days stale
    expect(isFundamentalsFresh(undefined, now)).toBe(false); // undated → not fresh
    expect(isFundamentalsFresh("2027-01-01", now)).toBe(false); // future-dated → not fresh
  });

  it("asOfQualifier appends an honest 'as of' suffix, empty when undated", () => {
    expect(asOfQualifier(undefined)).toBe("");
    expect(asOfQualifier("2025-09-30")).toBe(" (TTM as of 2025-09)");
    expect(asOfQualifier("TTM 2025-Q3")).toBe(" (as of TTM 2025-Q3)");
  });
});
