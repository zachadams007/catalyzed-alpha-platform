import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Trailing-twelve-month revenue growth and net margin from discrete quarters.
 *
 * Fiscal-year growth is up to a year stale: on 2026-09-20 Amazon read "rev +12%"
 * (FY2025 / FY2024) while its last two quarters were +16.6% / +19.6% and TTM
 * was +15.8%. The fold now sums the newest four consecutive quarters, deriving
 * the undisclosed Q4 as FY − (Q1 + Q2 + Q3), and falls back to the fiscal-year
 * read when the quarters do not resolve.
 */

const frames = new Map<string, Array<{ cik: number; val: number; end: string }>>();
// Figures below are in $M; the fold drops anything under $1M as a units error.
const M = 1e6;
const frame = (tag: string, period: string, rows: Array<[number, number, string]>) =>
  frames.set(`${tag}/${period}`, rows.map(([cik, val, end]) => ({ cik, val: val * M, end })));

vi.mock("@/data/http", () => ({
  httpJson: vi.fn(async (url: string) => {
    const m = /frames\/us-gaap\/([^/]+)\/USD\/([^/.]+)\.json/.exec(url);
    if (!m) throw new Error(`unexpected url ${url}`);
    return { data: frames.get(`${m[1]}/${m[2]}`) ?? [] };
  }),
}));
vi.mock("@/data/sec/secFilings", () => ({
  loadCikIndex: vi.fn(async () =>
    new Map<string, string>([
      ["TTMCO", "0000000099"],
      ["FYONLY", "0000000098"],
      ["ODDFY", "0000000097"],
    ]),
  ),
}));

const TTMCO = 99; // calendar filer: quarters + annual → TTM resolves
const FYONLY = 98; // annual frames only → fiscal-year fallback
const ODDFY = 97; // quarters that do not reconcile to the annual → fallback
const REV = "RevenueFromContractWithCustomerExcludingAssessedTax";
const NI = "NetIncomeLoss";

describe("xbrlPipeline — trailing-twelve-month growth and margin from discrete quarters", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    frames.clear();
    // Annual frames (CY2025 … CY2020).
    frame(REV, "CY2025", [
      [TTMCO, 1000, "2025-12-31"],
      [FYONLY, 500, "2025-12-31"],
      [ODDFY, 1000, "2025-12-31"],
    ]);
    frame(REV, "CY2024", [
      [TTMCO, 800, "2024-12-31"],
      [FYONLY, 400, "2024-12-31"],
      [ODDFY, 800, "2024-12-31"],
    ]);
    frame(NI, "CY2025", [
      [TTMCO, 100, "2025-12-31"],
      [FYONLY, 50, "2025-12-31"],
      [ODDFY, 100, "2025-12-31"],
    ]);
    frame(NI, "CY2024", [[TTMCO, 70, "2024-12-31"]]);
    // Discrete quarters for TTMCO (no discrete Q4 - the 10-K only has the year).
    const q: Array<[string, number, number]> = [
      ["CY2026Q2", 320, 32],
      ["CY2026Q1", 300, 30],
      ["CY2025Q3", 250, 25],
      ["CY2025Q2", 240, 24],
      ["CY2025Q1", 230, 23],
      ["CY2024Q3", 205, 20],
      ["CY2024Q2", 195, 19],
      ["CY2024Q1", 190, 18],
    ];
    for (const [period, rev, ni] of q) {
      frame(REV, period, [
        [TTMCO, rev, `${period.slice(2, 6)}-06-30`],
        // ODDFY's "quarters" are a different fiscal year's: they do not reconcile.
        [ODDFY, rev * 3, `${period.slice(2, 6)}-06-30`],
      ]);
      frame(NI, period, [[TTMCO, ni, `${period.slice(2, 6)}-06-30`]]);
    }
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes TTM revenue, TTM-over-prior-TTM growth and a same-window margin", async () => {
    const { fetchXbrlPipelineByTicker } = await import("@/data/sec/xbrlPipeline");
    const facts = await fetchXbrlPipelineByTicker();
    const f = facts.get("TTMCO")!;
    expect(f).toBeDefined();
    // Q4'25 derived = 1000 − (230 + 240 + 250) = 280; Q4'24 = 800 − (190 + 195 + 205) = 210.
    const ttm = 320 + 300 + 280 + 250;
    const prior = 240 + 230 + 210 + 205;
    expect(f.revenueTTM).toBeCloseTo(ttm * M, 0);
    expect(f.revenueGrowthYoY).toBeCloseTo(ttm / prior - 1, 6); // ≈ +29.9%, not FY's +25%
    // Q4'25 net income derived = 100 − (23 + 24 + 25) = 28 → TTM NI = 32 + 30 + 28 + 25.
    expect(f.netMargin).toBeCloseTo((32 + 30 + 28 + 25) / ttm, 6);
  });

  it("falls back to the fiscal-year read when no quarters are filed", async () => {
    const { fetchXbrlPipelineByTicker } = await import("@/data/sec/xbrlPipeline");
    const facts = await fetchXbrlPipelineByTicker();
    const f = facts.get("FYONLY")!;
    expect(f.revenueGrowthYoY).toBeCloseTo(500 / 400 - 1, 6);
    expect(f.netMargin).toBeCloseTo(50 / 500, 6);
    expect(f.revenueTTM).toBeUndefined(); // no order book / cash flow to anchor it
  });

  it("rejects quarters that do not reconcile to the annual frame (derived Q4 implausible)", async () => {
    const { fetchXbrlPipelineByTicker } = await import("@/data/sec/xbrlPipeline");
    const facts = await fetchXbrlPipelineByTicker();
    const f = facts.get("ODDFY")!;
    // Q1..Q3 sum to 2160 against a 1000 annual → a negative "Q4" → no TTM.
    expect(f.revenueGrowthYoY).toBeCloseTo(1000 / 800 - 1, 6);
    expect(f.netMargin).toBeCloseTo(100 / 1000, 6);
  });
});
