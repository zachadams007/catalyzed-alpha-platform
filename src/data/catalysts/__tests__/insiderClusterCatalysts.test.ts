import { describe, expect, it } from "vitest";

import type { CompanyData } from "@/types";
import type { TerminalEvent } from "@/types/terminal";
import {
  applyInsiderAggregateToCompany,
  rollupInsiderEvents,
  roleMateriality,
} from "@/data/catalysts/insiderClusterCatalysts";

/**
 * Unit tests for the insider cluster/sell rollup: materiality filter (small or
 * junior trades excluded), cluster magnitude bonus, sells-as-negative, and the
 * aggregated secActivity fields that re-activate the smart-money + material-sell
 * signals. Deterministic (clock injected).
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

let seq = 0;
function buy(over: Partial<TerminalEvent> & { value?: number; role?: string; who?: string }): TerminalEvent {
  return mk("insider_buy", over);
}
function sell(over: Partial<TerminalEvent> & { value?: number; role?: string; who?: string }): TerminalEvent {
  return mk("insider_sell", over);
}
function mk(
  kind: "insider_buy" | "insider_sell",
  over: Partial<TerminalEvent> & { value?: number; role?: string; who?: string },
): TerminalEvent {
  seq += 1;
  return {
    id: over.id ?? `e${seq}`,
    kind,
    severity: "watch",
    ticker: over.ticker ?? "AAA",
    headline: over.headline ?? "trade",
    actor: { name: over.who ?? `Person${seq}`, role: over.role ?? "CEO" },
    trade: { direction: kind === "insider_buy" ? "buy" : "sell", valueUsd: over.value ?? 500_000 },
    occurredAt: over.occurredAt ?? "2026-06-16T00:00:00.000Z",
    surfacedAt: over.occurredAt ?? "2026-06-16T00:00:00.000Z",
    source: { name: "SEC Form 4", url: over.source?.url ?? "https://sec.gov/f4" },
  };
}

describe("roleMateriality", () => {
  it("weights C-suite highest, officers/directors mid, 10% owners low, unknown zero", () => {
    expect(roleMateriality("Officer: CEO")).toBe(1);
    expect(roleMateriality("Director")).toBe(0.7);
    expect(roleMateriality("10% owner")).toBe(0.4);
    expect(roleMateriality(undefined)).toBe(0);
  });
});

describe("rollupInsiderEvents — materiality filter", () => {
  it("excludes small buys and junior/unknown-role filers as noise", () => {
    const r = rollupInsiderEvents(
      [
        buy({ ticker: "AAA", value: 40_000, role: "CEO" }), // too small
        buy({ ticker: "AAA", value: 500_000, role: "10% owner" }), // role below floor
        buy({ ticker: "AAA", value: 500_000, role: "" }), // unknown role ⇒ materiality 0
      ],
      NOW,
    );
    expect(r.events).toHaveLength(0);
    expect(r.aggregates.size).toBe(0);
  });

  it("a material senior buy produces a positive Insider catalyst + aggregate", () => {
    const r = rollupInsiderEvents([buy({ ticker: "AAA", value: 800_000, role: "CEO" })], NOW);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.catalystType).toBe("Insider");
    expect(r.events[0]!.strength).toBeGreaterThan(0);
    expect(r.aggregates.get("AAA")).toEqual({ buyCount: 1, sellCount: 0, netValue: 800_000 });
  });
});

describe("rollupInsiderEvents — cluster bonus", () => {
  it("a 3-distinct-buyer cluster scores higher than a single equal-dollar buy", () => {
    const single = rollupInsiderEvents([buy({ ticker: "AAA", value: 900_000, role: "Director", who: "X" })], NOW);
    const cluster = rollupInsiderEvents(
      [
        buy({ ticker: "BBB", value: 300_000, role: "Director", who: "X" }),
        buy({ ticker: "BBB", value: 300_000, role: "Director", who: "Y" }),
        buy({ ticker: "BBB", value: 300_000, role: "Director", who: "Z" }),
      ],
      NOW,
    );
    const sEv = single.events[0]!;
    const cEv = cluster.events[0]!;
    expect(cEv.summary).toContain("cluster");
    expect(cEv.magnitude).toBeGreaterThan(sEv.magnitude);
  });

  it("dedupes distinct buyers by name (same person twice is not a cluster)", () => {
    const r = rollupInsiderEvents(
      [
        buy({ ticker: "AAA", value: 300_000, role: "Director", who: "X", id: "a" }),
        buy({ ticker: "AAA", value: 300_000, role: "Director", who: "X", id: "b" }),
      ],
      NOW,
    );
    expect(r.events[0]!.summary).not.toContain("cluster");
    expect(r.aggregates.get("AAA")!.buyCount).toBe(2); // both count toward the aggregate
  });
});

describe("rollupInsiderEvents — sells as negative", () => {
  it("a material senior sell is a NEGATIVE event and a negative net value", () => {
    const r = rollupInsiderEvents([sell({ ticker: "AAA", value: 3_000_000, role: "CEO" })], NOW);
    const e = r.events[0]!;
    expect(e.negative).toBe(true);
    expect(e.strength).toBeLessThan(0);
    expect(r.aggregates.get("AAA")!.netValue).toBe(-3_000_000);
  });

  it("a small routine sale below the floor is noise (excluded)", () => {
    const r = rollupInsiderEvents([sell({ ticker: "AAA", value: 80_000, role: "CEO" })], NOW);
    expect(r.events).toHaveLength(0);
  });

  it("nets buys against sells in the aggregate", () => {
    const r = rollupInsiderEvents(
      [
        buy({ ticker: "AAA", value: 1_000_000, role: "CEO", who: "X" }),
        sell({ ticker: "AAA", value: 400_000, role: "CFO", who: "Y" }),
      ],
      NOW,
    );
    expect(r.aggregates.get("AAA")).toEqual({ buyCount: 1, sellCount: 1, netValue: 600_000 });
  });
});

describe("applyInsiderAggregateToCompany", () => {
  function company(over: Partial<CompanyData>): CompanyData {
    return { ticker: "AAA", name: "Alpha", secActivity: over.secActivity } as unknown as CompanyData;
  }

  it("writes the buy/net fields, preserving an existing secActivity", () => {
    const c = company({
      secActivity: { cik: "0000123", form4Count90d: 5, eightKCount90d: 2, filings: [] },
    });
    const next = applyInsiderAggregateToCompany(c, { buyCount: 3, sellCount: 0, netValue: 1_500_000 });
    expect(next).not.toBe(c);
    expect(next.secActivity!.cik).toBe("0000123"); // preserved
    expect(next.secActivity!.form4BuyCount90d).toBe(3);
    expect(next.secActivity!.form4NetBuyValue90d).toBe(1_500_000);
  });

  it("synthesizes a minimal secActivity when none exists, and no-ops on empty", () => {
    const c = company({});
    const next = applyInsiderAggregateToCompany(c, { buyCount: 2, sellCount: 1, netValue: 900_000 });
    expect(next.secActivity!.form4BuyCount90d).toBe(2);
    expect(next.secActivity!.form4Count90d).toBe(3);
    expect(applyInsiderAggregateToCompany(c, { buyCount: 0, sellCount: 0, netValue: 0 })).toBe(c);
    expect(applyInsiderAggregateToCompany(c, undefined)).toBe(c);
  });
});
