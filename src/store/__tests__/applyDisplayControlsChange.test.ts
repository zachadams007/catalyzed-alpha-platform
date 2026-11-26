import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operator score-spread / quality-cap sliders must re-score TODAY's already
 * -loaded names LIVE the moment they're moved - not only on the next full
 * load. `saveGlobalControls` (globalControls.ts) writes the new dial values
 * and notifies `subscribeGlobalControls` listeners; App.tsx's realtime effect
 * calls `applyDisplayControlsChange()` on every notify. This test drives that
 * store action directly against the real `postProcessUniverse` re-rank path
 * (the same one `syncActiveVariantFromGlobal` / promote / rollback use), with
 * a mutable mock of the two global-control getters so we can move the "dial"
 * between calls.
 */
let mockSpreadWeight = 0.3;
let mockCapStrength = 1.4;

vi.mock("@/data/globalControls", () => ({
  isGlobalControlsConfigured: () => false,
  getGlobalControls: () => null,
  areGlobalControlsLoaded: () => true,
  subscribeGlobalControls: () => () => {},
  initGlobalControls: async () => {},
  refreshGlobalControls: async () => {},
  saveGlobalControls: async () => false,
  getScoreSpreadWeight: () => mockSpreadWeight,
  getQualityCapStrength: () => mockCapStrength,
}));

// The store module touches `window` at import time (a DEV-only debug hook).
// Node has no window - install a minimal stand-in BEFORE importing the store.
const originalWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  setTimeout: ((fn: () => void, ms?: number) =>
    globalThis.setTimeout(fn, ms)) as typeof window.setTimeout,
  clearTimeout: ((id: number) => globalThis.clearTimeout(id)) as typeof window.clearTimeout,
  addEventListener: () => undefined,
  location: { reload: () => undefined },
} as unknown as Window & typeof globalThis;

const { useAppStore } = await import("@/store/useAppStore");
const { MOCK_UNIVERSE } = await import("@/data/mockSignals");
const { toStockSignal } = await import("@/engine/enrich");
const { scoreCompany } = await import("@/engine/scoring");

const GENERATED_AT = "2026-07-01T16:00:00.000Z";

function buildScored() {
  return MOCK_UNIVERSE.map((c) => toStockSignal(c, scoreCompany(c), GENERATED_AT));
}

describe("applyDisplayControlsChange — live re-rank on operator dial move", () => {
  beforeEach(() => {
    mockSpreadWeight = 0.3;
    mockCapStrength = 1.4;
    useAppStore.setState({ signals: buildScored() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-ranks the in-memory signals when the score-spread weight changes", () => {
    // Rank once at the baseline dial value so the "last applied" tracker is
    // seeded (mirrors ingest / bootstrap ranking the board on load).
    useAppStore.getState().applyDisplayControlsChange();
    const before = useAppStore.getState().signals.map((s) => s.score.opportunityScore);

    // Operator drags the score-spread slider hard toward full percentile
    // decompression - a materially different DISPLAY curve.
    mockSpreadWeight = 1.0;
    useAppStore.getState().applyDisplayControlsChange();
    const after = useAppStore.getState().signals.map((s) => s.score.opportunityScore);

    expect(after).not.toEqual(before);
  });

  it("re-ranks the in-memory signals when the quality-cap strength changes", () => {
    useAppStore.getState().applyDisplayControlsChange();
    const before = useAppStore.getState().signals.map((s) => s.score.opportunityScore);

    // Operator cranks the quality-cap strength - risky/low-conviction names get
    // capped harder below the top.
    mockCapStrength = 4;
    useAppStore.getState().applyDisplayControlsChange();
    const after = useAppStore.getState().signals.map((s) => s.score.opportunityScore);

    expect(after).not.toEqual(before);
  });

  it("is a no-op when neither dial changed (dedup guard)", () => {
    useAppStore.getState().applyDisplayControlsChange();
    const first = useAppStore.getState().signals;

    // Same dial values - calling again must not produce a new array reference
    // (proves the "did anything actually change" guard short-circuits before
    // touching `signals`, avoiding redundant re-ranks / render churn).
    useAppStore.getState().applyDisplayControlsChange();
    const second = useAppStore.getState().signals;

    expect(second).toBe(first);
  });

  it("no-ops when there are no signals loaded yet", () => {
    useAppStore.setState({ signals: [] });
    expect(() => useAppStore.getState().applyDisplayControlsChange()).not.toThrow();
    expect(useAppStore.getState().signals).toEqual([]);
  });

  afterAll(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });
});
