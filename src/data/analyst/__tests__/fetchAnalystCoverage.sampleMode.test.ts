import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

/**
 * PRIME-DIRECTIVE regression (Lane A - analyst price-target honesty).
 *
 * `sampleCoverage()` builds price targets from `seededRandom(`${ticker}-pt`)` -
 * a deterministic hash of the SYMBOL, not a market input. Those dollar figures
 * must NEVER reach the UI when Sample data mode is OFF. The honest empty state is
 * `status: "links_only"` (outbound research links only, no numeric consensus).
 *
 * Sample data mode is mocked so the test does not depend on env/global-controls.
 */
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: vi.fn(() => false),
}));

// No live vendor key in the test env → the no-live-key branch is exercised.
vi.mock("@/data/http", () => ({
  finnhubKey: () => "",
  fmpKey: () => "",
  httpJson: vi.fn(),
}));

// Deterministic sample-universe membership so the test doesn't depend on the
// mock-feed contents: only "DEMO" is treated as a fictional demo ticker.
vi.mock("@/lib/links", () => ({
  isSampleUniverseTicker: (t: string) => t.trim().toUpperCase() === "DEMO",
}));

import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { fetchAnalystCoverage, linksOnlyCoverage } from "@/data/analyst/fetchAnalystCoverage";

const sampleMode = isSampleDataModeEnabled as unknown as Mock;

describe("fetchAnalystCoverage — no fabricated targets outside Sample data mode", () => {
  beforeEach(() => sampleMode.mockReturnValue(false));

  it("returns links_only (NO numeric consensus) for a real ticker with sample mode OFF", async () => {
    const cov = await fetchAnalystCoverage("AAPL", 195.12);
    expect(cov.status).toBe("links_only");
    expect(cov.consensus).toBeUndefined();
    // Not a single row carries a seeded-random dollar target.
    expect(cov.rows.every((r) => r.target == null)).toBe(true);
    expect(cov.rows.length).toBeGreaterThan(0); // outbound research links still present
    expect(cov.rows.every((r) => r.origin === "link")).toBe(true);
  });

  it("returns links_only even for a SAMPLE-universe ticker when sample mode is OFF", async () => {
    // The fictional demo universe must also withhold seeded numbers in live mode.
    const cov = await fetchAnalystCoverage("DEMO", 42);
    expect(cov.status).toBe("links_only");
    expect(cov.consensus).toBeUndefined();
    expect(cov.rows.every((r) => r.target == null)).toBe(true);
  });

  it("DOES surface sample numbers for the demo universe ONLY when sample mode is ON", async () => {
    sampleMode.mockReturnValue(true);
    const cov = await fetchAnalystCoverage("DEMO", 42);
    expect(cov.status).toBe("sample");
    expect(cov.consensus?.mean).toBeGreaterThan(0);
  });

  it("linksOnlyCoverage helper carries links but no numeric targets", () => {
    const cov = linksOnlyCoverage("MSFT", 410);
    expect(cov.status).toBe("links_only");
    expect(cov.consensus).toBeUndefined();
    expect(cov.rows.every((r) => r.target == null)).toBe(true);
    expect(cov.spotPrice).toBe(410);
  });
});
