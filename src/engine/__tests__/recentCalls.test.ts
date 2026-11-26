import { describe, expect, it } from "vitest";
import { buildRecentCalls } from "../recentCalls";
import type { OutcomeEntry } from "../outcomeLedger";

const NOW = Date.parse("2026-06-24T16:00:00Z");
const entry = (o: Partial<OutcomeEntry>): OutcomeEntry => ({
  ticker: o.ticker ?? "AAA",
  name: o.name ?? "Acme",
  publishedAtISO: o.publishedAtISO ?? "2026-06-23T13:00:00Z",
  opportunityScore: o.opportunityScore ?? 50,
  confidence: o.confidence ?? 50,
  categoryScores: o.categoryScores ?? {},
  priceAtPublish: o.priceAtPublish ?? 100,
  forwardReturns: o.forwardReturns ?? {},
});

describe("buildRecentCalls", () => {
  const entries = [
    entry({ ticker: "HI", opportunityScore: 80, priceAtPublish: 100, publishedAtISO: "2026-06-23T13:00:00Z" }),
    entry({ ticker: "LO", opportunityScore: 60, priceAtPublish: 50, publishedAtISO: "2026-06-23T13:00:00Z", forwardReturns: { d7: 0.1 } }),
    entry({ ticker: "OLD", opportunityScore: 70, priceAtPublish: 20, publishedAtISO: "2026-06-20T13:00:00Z" }),
  ];

  it("groups by day, ranks by score, computes live/settled/tracking returns", () => {
    // HI has a live price (110 vs 100 = +10%); LO has none → falls back to d7 +10%;
    // OLD has neither → tracking.
    const priceOf = (t: string) => (t === "HI" ? 110 : undefined);
    const days = buildRecentCalls(entries, priceOf, NOW);

    expect(days.map((d) => d.day)).toEqual(["2026-06-23", "2026-06-20"]); // recent first
    const d23 = days[0]!;
    expect(d23.calls.map((c) => c.ticker)).toEqual(["HI", "LO"]); // ranked by score desc

    const hi = d23.calls[0]!;
    expect(hi.basis).toBe("live");
    expect(hi.ret).toBeCloseTo(0.1, 5);

    const lo = d23.calls[1]!;
    expect(lo.basis).toBe("settled");
    expect(lo.ret).toBeCloseTo(0.1, 5);

    const old = days[1]!.calls[0]!;
    expect(old.basis).toBe("tracking");
    expect(old.ret).toBeNull();
    expect(old.heldDays).toBe(4);
  });

  it("respects perDay + maxDays caps", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      entry({ ticker: `T${i}`, opportunityScore: i, publishedAtISO: "2026-06-23T13:00:00Z" }),
    );
    const days = buildRecentCalls(many, () => undefined, NOW, { perDay: 3, maxDays: 1 });
    expect(days).toHaveLength(1);
    expect(days[0]!.calls).toHaveLength(3);
    expect(days[0]!.calls[0]!.ticker).toBe("T19"); // highest score first
  });
});
