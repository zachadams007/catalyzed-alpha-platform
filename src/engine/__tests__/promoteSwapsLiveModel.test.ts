import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the global layer unconfigured so this file pins the device-local fallback
// path: variantOverride -> getActiveVariant -> rerank + feed selection.
vi.mock("@/data/globalControls", () => ({
  isGlobalControlsConfigured: () => false,
  getGlobalControls: () => null,
  areGlobalControlsLoaded: () => true,
  subscribeGlobalControls: () => () => {},
  initGlobalControls: async () => {},
  refreshGlobalControls: async () => {},
  saveGlobalControls: async () => false,
  getScoreSpreadWeight: () => 0.3,
  getQualityCapStrength: () => 1.4,
}));

import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import {
  postProcessUniverse,
  getActiveVariant,
  runsCatalystDrivenProfile,
  type EngineVariantId,
} from "@/engine/challenger";
import { getVariantOverride, setVariantOverride } from "@/engine/variantOverride";
import {
  REVERSAL_V5_NORMALIZATION,
  INFLECTION_V2_NORMALIZATION,
  normalizeUniverse,
} from "@/engine/normalizeUniverse";
import {
  currentChampion,
  seedModelRegistry,
  variantForRegistry,
} from "@/engine/modelRegistry";
import { selectToday } from "@/feed/feeds";
import type { StockSignal } from "@/types";

const GENERATED_AT = "2026-06-13T16:00:00.000Z";

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  (globalThis as { localStorage?: Storage }).localStorage = shim;
}

function buildScored(): StockSignal[] {
  return MOCK_UNIVERSE.map((c) => toStockSignal(c, scoreCompany(c), GENERATED_AT));
}

function rerankFor(signals: StockSignal[], variant: EngineVariantId): StockSignal[] {
  return postProcessUniverse(signals, variant).sort(
    (a, b) => b.score.opportunityScore - a.score.opportunityScore,
  );
}

describe("Operator promotion swaps the live model", () => {
  beforeEach(() => {
    installLocalStorage();
    setVariantOverride(null);
  });
  afterEach(() => {
    setVariantOverride(null);
  });

  it("rolling between V5 and V4 flips the active variant and reorders Today's top-8", () => {
    const scored = buildScored();

    expect(getActiveVariant()).toBe("challenger");
    const v5Today = selectToday(rerankFor(scored, getActiveVariant())).map((s) => s.ticker);

    setVariantOverride("champion");
    expect(getActiveVariant()).toBe("champion");
    expect(getVariantOverride()).toBe("champion");
    const v4Today = selectToday(rerankFor(scored, getActiveVariant())).map((s) => s.ticker);

    expect(v4Today.join()).not.toBe(v5Today.join());
    const changed = v5Today.filter((t, i) => v4Today[i] !== t).length;
    expect(changed).toBeGreaterThan(0);

    setVariantOverride("challenger");
    expect(getActiveVariant()).toBe("challenger");
    const restored = selectToday(rerankFor(scored, getActiveVariant())).map((s) => s.ticker);
    expect(restored.join()).toBe(v5Today.join());
  });

  it("both models are fully capable over the identical full universe", () => {
    const scored = buildScored();

    const champion = postProcessUniverse(scored, "champion");
    const challenger = postProcessUniverse(scored, "challenger");

    expect(champion).toHaveLength(scored.length);
    expect(challenger).toHaveLength(scored.length);

    const championTickers = new Set(champion.map((s) => s.ticker));
    const challengerTickers = new Set(challenger.map((s) => s.ticker));
    const inputTickers = new Set(scored.map((s) => s.ticker));
    expect(championTickers).toEqual(inputTickers);
    expect(challengerTickers).toEqual(inputTickers);
    expect([...championTickers].sort()).toEqual([...challengerTickers].sort());

    const champOrder = [...champion]
      .sort((a, b) => b.score.opportunityScore - a.score.opportunityScore)
      .map((s) => s.ticker);
    const challOrder = [...challenger]
      .sort((a, b) => b.score.opportunityScore - a.score.opportunityScore)
      .map((s) => s.ticker);
    expect(champOrder.join()).not.toBe(challOrder.join());
  });
});

describe("Promotion contract: V5 is live by default", () => {
  beforeEach(() => {
    installLocalStorage();
    setVariantOverride(null);
  });
  afterEach(() => {
    setVariantOverride(null);
  });

  it("with no override, the default live variant is V5/challenger", () => {
    expect(getActiveVariant()).toBe("challenger");
    expect(runsCatalystDrivenProfile()).toBe(false);
    expect(runsCatalystDrivenProfile("champion")).toBe(true);
  });

  it("the live model's Today is the V5 reversal-first engine", () => {
    const scored = buildScored();

    const liveToday = selectToday(rerankFor(scored, getActiveVariant())).map((s) => s.ticker);
    const v5Today = selectToday(
      normalizeUniverse(scored, undefined, REVERSAL_V5_NORMALIZATION).sort(
        (a, b) => b.score.opportunityScore - a.score.opportunityScore,
      ),
    ).map((s) => s.ticker);

    expect(liveToday.join()).toBe(v5Today.join());

    const v4Today = selectToday(rerankFor(scored, "champion")).map((s) => s.ticker);
    expect(v4Today.join()).toBe(
      selectToday(
        normalizeUniverse(scored, undefined, INFLECTION_V2_NORMALIZATION).sort(
          (a, b) => b.score.opportunityScore - a.score.opportunityScore,
        ),
      ).map((s) => s.ticker).join(),
    );
  });

  it("the seed registry marks V5 as the live champion and V4 as rollback", () => {
    const reg = seedModelRegistry();
    expect(variantForRegistry(reg)).toBe("challenger");
    const live = currentChampion(reg);
    expect(live?.kind).toBe("challenger");
    expect(live?.label.toLowerCase()).toContain("v5");
    expect(live?.promotedAtISO).toBeDefined();

    const rollback = reg.entries.find((e) => e.kind === "champion");
    expect(rollback?.label.toLowerCase()).toContain("v4");
  });
});
