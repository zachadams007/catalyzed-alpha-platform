import { describe, it, expect } from "vitest";
import { BROAD_SCAN, SOURCE_LANES, SMART_MONEY } from "@/viz/pipelineModel";
import { SMART_MONEY as SMART_MONEY_CONFIG } from "@/engine/scoringConfig";

/**
 * Reality-fidelity guards for the Algorithm tab's source-of-truth model.
 *
 * The deployed engine scans the whole US market once a day and computes momentum
 * from REAL Alpaca daily bars (relative strength vs SPY) - not Yahoo, not a fixed
 * proxy. These assertions fail loudly if the explainer copy regresses to the old
 * "Yahoo price history" framing or drops the SPY benchmark, per the binding
 * explainer-must-match-reality rule (CLAUDE.md / algorithm-tab-runtime-fidelity).
 */
describe("pipelineModel fidelity — broad-scan momentum", () => {
  it("sources momentum from Alpaca daily bars, not Yahoo", () => {
    const prices = SOURCE_LANES.find((l) => l.id === "prices");
    expect(prices).toBeDefined();
    expect(prices!.source).toMatch(/alpaca/i);
    expect(prices!.source).not.toMatch(/yahoo/i);
    // Yahoo survives only as the explicitly-labeled device-local fallback.
    expect(prices!.note ?? "").toMatch(/falls? back|fallback/i);
    expect(prices!.note ?? "").toMatch(/yahoo/i);
  });

  it("surfaces the real SPY benchmark for relative strength", () => {
    const prices = SOURCE_LANES.find((l) => l.id === "prices");
    expect(prices!.fills).toMatch(/SPY/);
    expect(BROAD_SCAN.momentumSource).toMatch(/alpaca/i);
    expect(BROAD_SCAN.momentumSource).toMatch(/SPY/);
  });

  it("targets a broad ~500-name universe, not a 75-name curated cap", () => {
    expect(BROAD_SCAN.targetN).toBeGreaterThanOrEqual(400);
  });

  it("now wires congressional buys into the broad scan's smart-money tilt", () => {
    // The broad scan used to leave c.congressTrades empty, so the boost was a
    // permanent 0 in production; the explainer must reflect that it now maps
    // congressional buys across the board (scanCongressBuys.ts).
    expect(BROAD_SCAN.smartMoneySource).toMatch(/congress/i);
    expect(BROAD_SCAN.smartMoneySource).toMatch(/smart-money|catalyst/i);
    // Honesty guard: still no per-ticker Form 4 XML on the broad path.
    expect(BROAD_SCAN.smartMoneySource).toMatch(/xml/i);
  });
});

/**
 * Smart-money catalyst boost fidelity. The Algorithm tab now tells the user that
 * congressional / insider BUYING feeds the Catalyst score. These guards fail
 * loudly if the explainer's source-of-truth model stops reflecting that real
 * scoring behavior (smartMoney.ts + scoringConfig.SMART_MONEY).
 */
describe("pipelineModel fidelity — smart-money catalyst boost", () => {
  it("re-exports the real SMART_MONEY config (numbers can't drift)", () => {
    expect(SMART_MONEY).toBe(SMART_MONEY_CONFIG);
    expect(SMART_MONEY.maxBoost).toBeGreaterThan(0);
  });

  it("says the congress lane now feeds the Catalyst score, not just display", () => {
    const congress = SOURCE_LANES.find((l) => l.id === "congress");
    expect(congress).toBeDefined();
    expect(`${congress!.fills} ${congress!.note ?? ""}`).toMatch(/catalyst/i);
  });

  it("keeps the SEC lane honest: counts universe-wide, no per-filing XML fetch", () => {
    const sec = SOURCE_LANES.find((l) => l.id === "sec");
    expect(sec).toBeDefined();
    const blurb = `${sec!.fills} ${sec!.note ?? ""}`;
    expect(blurb).toMatch(/insider/i);
    expect(blurb).toMatch(/xml/i);
  });
});
