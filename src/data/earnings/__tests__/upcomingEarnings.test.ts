import { describe, it, expect } from "vitest";
import { daysUntil, rankUpcoming, type EarningsCandidate } from "@/data/earnings/upcomingEarnings";

const TODAY = "2026-06-15";

function cand(ticker: string, dateISO: string, epsEstimate: number | null = null): EarningsCandidate {
  return { ticker, name: `${ticker} Corp`, event: { dateISO, epsEstimate } };
}

describe("daysUntil", () => {
  it("counts whole days forward", () => {
    expect(daysUntil("2026-06-15", TODAY)).toBe(0);
    expect(daysUntil("2026-06-16", TODAY)).toBe(1);
    expect(daysUntil("2026-06-25", TODAY)).toBe(10);
  });

  it("floors past dates at 0 and tolerates full ISO timestamps", () => {
    expect(daysUntil("2026-06-10", TODAY)).toBe(0);
    expect(daysUntil("2026-06-18T13:30:00.000Z", TODAY)).toBe(3);
  });

  it("returns 0 for unparseable input", () => {
    expect(daysUntil("nope", TODAY)).toBe(0);
  });
});

describe("rankUpcoming", () => {
  it("drops past events and sorts soonest-first", () => {
    const out = rankUpcoming(
      [cand("AAA", "2026-06-20"), cand("BBB", "2026-06-10"), cand("CCC", "2026-06-16")],
      TODAY,
    );
    expect(out.map((r) => r.ticker)).toEqual(["CCC", "AAA"]);
    expect(out[0]!.daysUntil).toBe(1);
  });

  it("keeps today's events (inclusive lower bound)", () => {
    const out = rankUpcoming([cand("AAA", "2026-06-15")], TODAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.daysUntil).toBe(0);
  });

  it("breaks date ties by ticker", () => {
    const out = rankUpcoming([cand("ZZZ", "2026-06-18"), cand("AAA", "2026-06-18")], TODAY);
    expect(out.map((r) => r.ticker)).toEqual(["AAA", "ZZZ"]);
  });

  it("caps to the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      cand(`T${String(i).padStart(2, "0")}`, "2026-07-01"),
    );
    expect(rankUpcoming(many, TODAY, 12)).toHaveLength(12);
  });

  it("carries the EPS estimate through (including null)", () => {
    const out = rankUpcoming([cand("AAA", "2026-06-20", 1.42), cand("BBB", "2026-06-21")], TODAY);
    expect(out[0]!.epsEstimate).toBe(1.42);
    expect(out[1]!.epsEstimate).toBeNull();
  });

  it("returns [] for an empty candidate set", () => {
    expect(rankUpcoming([], TODAY)).toEqual([]);
  });
});
