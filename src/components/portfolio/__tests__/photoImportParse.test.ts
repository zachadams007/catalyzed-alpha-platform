import { describe, it, expect } from "vitest";

// Minimal browser globals: importing PhotoImportModal pulls in the app store,
// which assigns a dev-only `window.__appStore` handle at module load. Provide a
// window shim so the import works under vitest's `node` environment.
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = g;
if (!g.localStorage) {
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

const { parseNumericCell } = await import("@/components/portfolio/PhotoImportModal");

/**
 * Regression for E-3: PhotoImportModal's Shares/Value cells used to do a raw
 * `Number(e.target.value)` with no validation, so letters became `NaN` and
 * negatives were accepted - both flowed into `addHoldingsBulk` /
 * `computePortfolioAnalytics`, producing `$NaN` and broken weighting (a wrong
 * number in a financial field). `parseNumericCell` now classifies every cell:
 *   - empty       → undefined (cleared cell, allowed)
 *   - valid ≥ 0   → the number
 *   - invalid     → null      (NaN / negative / junk → block the commit)
 */
describe("parseNumericCell", () => {
  it("treats an empty / whitespace cell as undefined (cleared, not invalid)", () => {
    expect(parseNumericCell("")).toBeUndefined();
    expect(parseNumericCell("   ")).toBeUndefined();
  });

  it("parses plain non-negative numbers", () => {
    expect(parseNumericCell("0")).toBe(0);
    expect(parseNumericCell("100")).toBe(100);
    expect(parseNumericCell("12.5")).toBe(12.5);
  });

  it("accepts common entry formatting ($ and thousands separators)", () => {
    expect(parseNumericCell("$1,250.75")).toBe(1250.75);
    expect(parseNumericCell("1,000")).toBe(1000);
  });

  it("rejects non-numeric junk as invalid (null), not NaN", () => {
    expect(parseNumericCell("abc")).toBeNull();
    expect(parseNumericCell("12abc")).toBeNull();
    expect(parseNumericCell("--")).toBeNull();
  });

  it("rejects negative numbers (a position can't be negative shares/value)", () => {
    expect(parseNumericCell("-5")).toBeNull();
    expect(parseNumericCell("-0.01")).toBeNull();
  });

  it("rejects Infinity / non-finite input", () => {
    expect(parseNumericCell("Infinity")).toBeNull();
  });
});
