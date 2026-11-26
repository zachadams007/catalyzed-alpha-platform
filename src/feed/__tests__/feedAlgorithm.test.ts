import { describe, it, expect } from "vitest";
import { vi } from "vitest";

// Vitest exposes the existing mockSignals -> socialPosts -> links import cycle.
// Stub these link-only helpers so the real sample universe can initialize.
vi.mock("@/lib/links", () => ({
  externalXSearchUrl: (ticker: string, queryExtra?: string) => {
    const query = queryExtra ? `${ticker} ${queryExtra}` : `${ticker} stock`;
    return `https://x.com/search?q=${encodeURIComponent(query)}`;
  },
  isSampleUniverseTicker: () => true,
}));

import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import { applyInteraction, defaultPreferences } from "@/feed/feedAlgorithm";
import {
  selectToday,
  selectWeekly,
  TODAY_LIMIT,
  WEEKLY_LIMIT,
} from "@/feed/feeds";
import type {
  InteractionEvent,
  InteractionKind,
  StockSignal,
  UserPreferences,
} from "@/types";

const INTERACTION_KINDS: InteractionKind[] = [
  "like",
  "more_like_this",
  "less_like_this",
  "higher_market_cap",
  "lower_market_cap",
  "more_sector",
  "less_sector",
  "more_catalyst_driven",
  "more_fundamentals_driven",
  "shorter_horizon",
  "longer_horizon",
  "add_to_portfolio",
  "share",
  "save_watchlist",
  "view_detail",
];

function makePreferences(): UserPreferences {
  return {
    ...defaultPreferences(),
    sectorWeights: { Technology: 0.2 },
    capWeights: { Mid: 0.1 },
    catalystWeights: { Product: -0.1 },
    styleTilt: 0.1,
    likedTickers: [],
    mutedTickers: ["TEST"],
  };
}

function makeEvent(kind: InteractionKind): InteractionEvent {
  return {
    id: `event-${kind}`,
    kind,
    ticker: "TEST",
    sector: "Technology",
    catalystType: "Product",
    marketCapBucket: "Mid",
    at: "2026-06-13T12:00:00.000Z",
  };
}

const SAMPLE_SIGNALS: StockSignal[] = MOCK_UNIVERSE.map((company) =>
  toStockSignal(company, scoreCompany(company), "2026-06-13T12:00:00.000Z"),
);

describe("applyInteraction", () => {
  it.each(INTERACTION_KINDS)("does not mutate preferences for %s", (kind) => {
    const preferences = makePreferences();
    const before = {
      ...preferences,
      sectorWeights: { ...preferences.sectorWeights },
      capWeights: { ...preferences.capWeights },
      catalystWeights: { ...preferences.catalystWeights },
      likedTickers: [...preferences.likedTickers],
      mutedTickers: [...preferences.mutedTickers],
    };

    const result = applyInteraction(preferences, makeEvent(kind));

    expect(preferences).toEqual(before);
    expect(result).not.toBe(preferences);
    expect(result.sectorWeights).not.toBe(preferences.sectorWeights);
    expect(result.capWeights).not.toBe(preferences.capWeights);
    expect(result.catalystWeights).not.toBe(preferences.catalystWeights);
    expect(result.likedTickers).not.toBe(preferences.likedTickers);
    expect(result.mutedTickers).not.toBe(preferences.mutedTickers);
  });

  it("likes a ticker and increases its sector and catalyst weights", () => {
    const result = applyInteraction(makePreferences(), makeEvent("like"));

    expect(result.likedTickers).toContain("TEST");
    expect(result.mutedTickers).not.toContain("TEST");
    expect(result.sectorWeights.Technology).toBeCloseTo(0.8);
    expect(result.catalystWeights.Product).toBeCloseTo(0.3);
  });

  it.each([
    ["more_like_this", 0.8, 0.5, 0.4],
    ["less_like_this", -0.6, -0.3, 0],
  ] satisfies Array<[InteractionKind, number, number, number]>)(
    "%s nudges matching attributes in the current direction",
    (kind, sectorDelta, catalystDelta, capDelta) => {
      const result = applyInteraction(makePreferences(), makeEvent(kind));

      expect(result.sectorWeights.Technology).toBeCloseTo(0.2 + sectorDelta);
      expect(result.catalystWeights.Product).toBeCloseTo(-0.1 + catalystDelta);
      expect(result.capWeights.Mid).toBeCloseTo(0.1 + capDelta);
      if (kind === "less_like_this") {
        expect(result.mutedTickers).toContain("TEST");
      }
    },
  );

  it("shifts cap affinity upward and lowers risk appetite", () => {
    const result = applyInteraction(makePreferences(), makeEvent("higher_market_cap"));

    expect(result.capWeights).toEqual({
      Nano: -0.2,
      Micro: -0.2,
      Small: -0.2,
      Mid: 0.1,
      Large: 0.4,
      Mega: 0.4,
    });
    expect(result.riskAppetite).toBeCloseTo(0.5);
  });

  it("shifts cap affinity downward and raises risk appetite", () => {
    const result = applyInteraction(makePreferences(), makeEvent("lower_market_cap"));

    expect(result.capWeights).toEqual({
      Nano: 0.4,
      Micro: 0.4,
      Small: 0.4,
      Mid: 0.1,
      Large: -0.2,
      Mega: -0.2,
    });
    expect(result.riskAppetite).toBeCloseTo(0.6);
  });

  it.each([
    ["more_sector", 1],
    ["less_sector", -1],
  ] satisfies Array<[InteractionKind, number]>)(
    "%s adjusts the selected sector weight",
    (kind, delta) => {
      const result = applyInteraction(makePreferences(), makeEvent(kind));

      expect(result.sectorWeights.Technology).toBeCloseTo(0.2 + delta);
    },
  );

  it("moves toward catalyst-driven signals and raises the catalyst weight", () => {
    const result = applyInteraction(
      makePreferences(),
      makeEvent("more_catalyst_driven"),
    );

    expect(result.styleTilt).toBeCloseTo(0.35);
    expect(result.catalystWeights.Product).toBeCloseTo(0.2);
  });

  it("moves toward fundamentals-driven signals", () => {
    const result = applyInteraction(
      makePreferences(),
      makeEvent("more_fundamentals_driven"),
    );

    expect(result.styleTilt).toBeCloseTo(-0.15);
  });

  it.each([
    ["shorter_horizon", "day_trading"],
    ["longer_horizon", "position_trading"],
  ] satisfies Array<[InteractionKind, UserPreferences["tradeHorizon"]]>)(
    "%s shifts the trade horizon",
    (kind, expectedHorizon) => {
      const result = applyInteraction(makePreferences(), makeEvent(kind));

      expect(result.tradeHorizon).toBe(expectedHorizon);
    },
  );

  it.each([
    ["add_to_portfolio", 0.3, 0.2],
    ["save_watchlist", 0.3, 0.2],
    ["share", 0.1, 0],
    ["view_detail", 0.1, 0],
  ] satisfies Array<[InteractionKind, number, number]>)(
    "%s applies its current positive feedback weights",
    (kind, sectorDelta, catalystDelta) => {
      const result = applyInteraction(makePreferences(), makeEvent(kind));

      expect(result.sectorWeights.Technology).toBeCloseTo(0.2 + sectorDelta);
      expect(result.catalystWeights.Product).toBeCloseTo(-0.1 + catalystDelta);
    },
  );
});

describe("feed selection", () => {
  it.each([
    ["today", selectToday, TODAY_LIMIT],
    ["weekly", selectWeekly, WEEKLY_LIMIT],
  ] satisfies Array<
    [string, (signals: StockSignal[]) => StockSignal[], number]
  >)("%s returns a non-empty sample feed within its limit", (_, select, limit) => {
    const selected = select(SAMPLE_SIGNALS);

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(limit);
  });

  it.each([
    ["today", selectToday],
    ["weekly", selectWeekly],
  ] satisfies Array<[string, (signals: StockSignal[]) => StockSignal[]]>)(
    "%s is pure and deterministic",
    (_, select) => {
      const input = [...SAMPLE_SIGNALS].reverse();
      const inputOrder = input.map((signal) => signal.id);

      const first = select(input).map((signal) => signal.id);
      const second = select(input).map((signal) => signal.id);

      expect(input.map((signal) => signal.id)).toEqual(inputOrder);
      expect(second).toEqual(first);
    },
  );
});
