import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A lender's disclosed TOTAL revenue must beat its partial contract-revenue tag.
 *
 * SoFi FY2025 files $0.62B under `RevenueFromContractWithCustomerExcludingAssessedTax`
 * (fee income only) and $3.61B under `RevenuesNetOfInterestExpense` (total net
 * revenue). The fold used to take the standard tag first, compute a 77% "net
 * margin" from a $0.48B profit, trip the >60% implausibility guard and publish
 * NO margin - SoFi was scored as if unprofitable. The total is a superset of its
 * own component, so it overrides whenever it is larger.
 */

const frames = new Map<string, Array<{ cik: number; val: number; end: string }>>();
const frame = (tag: string, period: string, rows: Array<[number, number, string]>) =>
  frames.set(`${tag}/${period}`, rows.map(([cik, val, end]) => ({ cik, val, end })));

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
      ["SOFI", "0001818874"],
      ["ACME", "0000000042"],
      ["NEWB", "0000000077"],
    ]),
  ),
}));

const SOFI = 1818874;
const ACME = 42;
const NEWB = 77;
const B = 1e9;

describe("xbrlPipeline — lender total revenue overrides the partial contract tag", () => {
  beforeEach(() => {
    frames.clear();
    const y = new Date().getUTCFullYear();
    const years = [y - 1, y - 2, y - 3, y - 4];
    // SoFi-like lender: partial contract revenue + explicit total, every year.
    const sofiPartial = [0.62, 0.5, 0.42, 0.38];
    const sofiTotal = [3.61, 2.67, 2.12, 1.57];
    const sofiNi = [0.48, 0.5, -0.3, -0.32];
    // Ordinary filer: standard tag only, a real 20% margin - must be untouched.
    const acmeRev = [10, 9, 8, 7];
    // Lender that only started tagging the total in its newest two years: the
    // older partial-only years must be DROPPED for it, never mixed into growth.
    const newbPartial = [1, 0.9, 0.8, 0.7];
    const newbTotal = [4, 3.5];
    years.forEach((yr, i) => {
      const end = `${yr}-12-31`;
      frame("RevenueFromContractWithCustomerExcludingAssessedTax", `CY${yr}`, [
        [SOFI, sofiPartial[i]! * B, end],
        [ACME, acmeRev[i]! * B, end],
        [NEWB, newbPartial[i]! * B, end],
      ]);
      frame("RevenuesNetOfInterestExpense", `CY${yr}`, [
        [SOFI, sofiTotal[i]! * B, end],
        ...(i < newbTotal.length ? ([[NEWB, newbTotal[i]! * B, end]] as Array<[number, number, string]>) : []),
      ]);
      frame("NetIncomeLoss", `CY${yr}`, [
        [SOFI, sofiNi[i]! * B, end],
        [ACME, acmeRev[i]! * 0.2 * B, end],
        [NEWB, 0.4 * B, end],
      ]);
    });
  });

  it("publishes SoFi's real ~13% margin from the disclosed total, not a 77% artifact", async () => {
    const { fetchXbrlPipelineByTicker } = await import("@/data/sec/xbrlPipeline");
    const facts = await fetchXbrlPipelineByTicker();
    const sofi = facts.get("SOFI");
    expect(sofi).toBeDefined();
    expect(sofi!.netMargin).toBeCloseTo(0.48 / 3.61, 3);
    // Growth is total-vs-total, not partial-vs-partial.
    expect(sofi!.revenueGrowthYoY).toBeCloseTo(3.61 / 2.67 - 1, 3);
    expect(sofi!.revenueByYear?.map((r) => r.revenue)).toEqual([3.61 * B, 2.67 * B, 2.12 * B, 1.57 * B]);
  });

  it("leaves an ordinary filer's standard-tag revenue untouched", async () => {
    const { fetchXbrlPipelineByTicker } = await import("@/data/sec/xbrlPipeline");
    const facts = await fetchXbrlPipelineByTicker();
    const acme = facts.get("ACME");
    expect(acme?.netMargin).toBeCloseTo(0.2, 6);
    expect(acme?.revenueGrowthYoY).toBeCloseTo(10 / 9 - 1, 6);
  });

  it("never mixes a total year with a partial year for the same filer", async () => {
    const { fetchXbrlPipelineByTicker } = await import("@/data/sec/xbrlPipeline");
    const facts = await fetchXbrlPipelineByTicker();
    const newb = facts.get("NEWB");
    expect(newb?.revenueGrowthYoY).toBeCloseTo(4 / 3.5 - 1, 6);
    // Only two comparable years → no multi-year series is published.
    expect(newb?.revenueByYear).toBeUndefined();
    expect(newb?.netMargin).toBeCloseTo(0.4 / 4, 6);
  });
});
