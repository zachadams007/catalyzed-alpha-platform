import { describe, expect, it } from "vitest";

import { computeFunnelSize, FUNNEL_TARGET_MAX } from "@/data/funnel/budget";

describe("computeFunnelSize", () => {
  it("returns the target max when no vendor is constrained", () => {
    const { n, binding } = computeFunnelSize({});
    expect(n).toBe(FUNNEL_TARGET_MAX);
    expect(binding).toBeNull();
  });

  it("treats Infinity as unconstrained", () => {
    const { n, binding } = computeFunnelSize({ yahoo: Infinity, finnhub: Infinity });
    expect(n).toBe(FUNNEL_TARGET_MAX);
    expect(binding).toBeNull();
  });

  it("lets the tightest vendor bind N (with headroom applied)", () => {
    // yahoo: 2 calls/name, 100 remaining, 80% headroom → floor(80/2) = 40.
    const { n, binding } = computeFunnelSize({ yahoo: 100 }, { headroom: 0.8 });
    expect(n).toBe(40);
    expect(binding).toBe("yahoo");
  });

  it("picks the most constraining vendor across several", () => {
    // yahoo: floor(0.8*300/2)=120 ; finnhub: floor(0.8*120/1.2)=80 → binds.
    const { n, binding } = computeFunnelSize({ yahoo: 300, finnhub: 120 }, { headroom: 0.8 });
    expect(n).toBe(80);
    expect(binding).toBe("finnhub");
  });

  it("never exceeds the target max even with huge budgets", () => {
    const { n } = computeFunnelSize({ yahoo: 1_000_000 });
    expect(n).toBe(FUNNEL_TARGET_MAX);
  });

  it("returns 0 (never negative) when a vendor is exhausted", () => {
    const { n, binding } = computeFunnelSize({ yahoo: 0 });
    expect(n).toBe(0);
    expect(binding).toBe("yahoo");
  });

  it("honors a custom target max", () => {
    const { n } = computeFunnelSize({}, { targetMax: 150 });
    expect(n).toBe(150);
  });

  it("ignores vendors with no per-name cost", () => {
    // 'proxy' isn't in the per-name cost table, so it can't bind N.
    const { n, binding } = computeFunnelSize({ proxy: 1 });
    expect(n).toBe(FUNNEL_TARGET_MAX);
    expect(binding).toBeNull();
  });
});
