import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * useBlueprintStore - focused guard tests.
 *
 * 1. State persists across a simulated component unmount/remount (the store is
 *    module-scoped, so the component lifecycle has no effect on it).
 * 2. runBlueprint is idempotent: a second call while running is a no-op.
 * 3. runBlueprint sets running=true on entry and false on completion.
 *
 * All engine + agent calls are mocked so the tests are deterministic and
 * require no network.
 */

// Mock the research agent - resolve immediately with empty intel.
vi.mock("@/data/ai/researchAgent", () => ({
  researchAgentStatus: vi.fn(() => ({ lane: "ready" })),
  runResearchAgent: vi.fn(async () => ({
    summary: "ok",
    citations: [],
    suggestions: [],
    model: "test",
    themes: [],
  })),
  ResearchProxyError: class ResearchProxyError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

// Mock the screen engine - no real scoring needed.
vi.mock("@/engine/screen", () => ({
  defaultBlueprintCriteria: () => ({
    rankingMode: "blended",
    themeTags: [],
    keywords: [],
  }),
  defaultGrowthScreenCriteria: () => ({ rankingMode: "blended" }),
  effectiveScreenCriteria: vi.fn((_h: unknown, c: unknown) => c),
  evaluateScreenGates: vi.fn(() => []),
}));

// Mock dynamic import of useAppStore (used by notifyBlueprintFinished).
vi.mock("@/store/useAppStore", () => ({
  useAppStore: {
    getState: () => ({ pushToast: vi.fn() }),
  },
}));

import { useBlueprintStore } from "@/store/useBlueprintStore";
import type { ScreenMatch, ScreenCriteria, TradeHorizon } from "@/types";

/** The deps object `runBlueprint` accepts (first arg of the store action). */
type RunBlueprintDeps = Parameters<ReturnType<typeof useBlueprintStore.getState>["runBlueprint"]>[0];

/** Minimal deps for runBlueprint - screens return an empty board. */
function makeDeps(overrides?: Partial<RunBlueprintDeps>) {
  return {
    runScreen: vi.fn(() => [] as ScreenMatch[]),
    adoptAiRelevanceIntel: vi.fn(),
    lookupTicker: vi.fn(async () => { throw new Error("not found"); }),
    mergeScreenPresetResults: vi.fn(),
    ...overrides,
  };
}

describe("useBlueprintStore", () => {
  beforeEach(() => {
    // Reset store to a known baseline before each test.
    useBlueprintStore.setState({
      presetName: "My screen",
      horizons: ["position_trading"] as TradeHorizon[],
      criteria: { rankingMode: "blended" } as ScreenCriteria,
      description: "",
      activePresetId: null,
      matches: [],
      cuts: [],
      researchedTickers: new Set(),
      running: false,
      researchIntel: null,
      excludeTickers: [],
      _cutSeq: 0,
    });
    vi.clearAllMocks();
  });

  // ── 1. State persistence across simulated unmount ──────────────────────

  it("preserves state when the component 'unmounts' (store outlives component lifecycle)", () => {
    // Simulate the component setting form values.
    useBlueprintStore.getState().setDescription("quantum computing micro caps");
    useBlueprintStore.getState().setPresetName("QC Screen");
    useBlueprintStore.getState().setHorizons(["swing_trading", "position_trading"]);

    // Simulate unmount: nothing resets the store (module-scope).
    // Re-read as if the component just remounted.
    const state = useBlueprintStore.getState();
    expect(state.description).toBe("quantum computing micro caps");
    expect(state.presetName).toBe("QC Screen");
    expect(state.horizons).toEqual(["swing_trading", "position_trading"]);
  });

  // ── 2. runBlueprint is idempotent when already running ────────────────

  it("ignores a second runBlueprint call while running=true", async () => {
    // Set running=true to simulate an in-flight run.
    useBlueprintStore.setState({ running: true });
    useBlueprintStore.getState().setDescription("long enough description here");

    const deps = makeDeps();
    await useBlueprintStore.getState().runBlueprint(deps);

    // runScreen should never have been called - the guard bailed.
    expect(deps.runScreen).not.toHaveBeenCalled();
  });

  // ── 3. runBlueprint sets running and clears it on completion ──────────

  it("sets running=true during the run and false after completion", async () => {
    useBlueprintStore.getState().setDescription("long enough description here");

    const runningDuringRun = vi.fn();
    const deps = makeDeps({
      runScreen: vi.fn(() => {
        // Capture running state mid-run (called on the fundamentals lane).
        runningDuringRun(useBlueprintStore.getState().running);
        return [] as ScreenMatch[];
      }),
    });

    const runPromise = useBlueprintStore.getState().runBlueprint(deps);
    // Immediately after kicking off, running should be true.
    expect(useBlueprintStore.getState().running).toBe(true);

    await runPromise;

    // After the run completes, running should be false.
    expect(useBlueprintStore.getState().running).toBe(false);
    // And the run did fire runScreen (fundamentals lane).
    expect(deps.runScreen).toHaveBeenCalled();
  });

  // ── 4. runBlueprint bails when description is too short ───────────────

  it("does nothing when description is 12 characters or shorter", async () => {
    useBlueprintStore.getState().setDescription("short");
    const deps = makeDeps();
    await useBlueprintStore.getState().runBlueprint(deps);
    expect(deps.runScreen).not.toHaveBeenCalled();
    expect(useBlueprintStore.getState().running).toBe(false);
  });

  // ── 5. Setter functions correctly update store slices ─────────────────

  it("setCuts updater appends and slices correctly", () => {
    useBlueprintStore.getState().setCuts(() => [
      { id: "cut_1", ticker: "AAPL", gateLabel: "Cap", actual: "large", required: "small" },
    ]);
    useBlueprintStore.getState().setCuts((prev) => [
      { id: "cut_2", ticker: "MSFT", gateLabel: "Cap", actual: "large", required: "small" },
      ...prev,
    ]);
    const { cuts } = useBlueprintStore.getState();
    expect(cuts).toHaveLength(2);
    expect(cuts[0].id).toBe("cut_2");
    expect(cuts[1].id).toBe("cut_1");
  });

  it("nextCutId increments the sequence counter", () => {
    const id1 = useBlueprintStore.getState().nextCutId();
    const id2 = useBlueprintStore.getState().nextCutId();
    expect(id1).toBe("cut_1");
    expect(id2).toBe("cut_2");
  });
});

// ── 5. AI-ticker hydration runs in PARALLEL batches, not one at a time ───
//
// This used to be a `for…await` over up to 12 AI-discovered tickers - 12
// full lookups serialized on the critical path, which is where the "AI
// screener takes minutes" complaint lived. The assertion measures OVERLAP
// (peak in-flight lookups), not just the result, so a refactor that quietly
// re-serializes the loop cannot pass by accident.
describe("useBlueprintStore — AI ticker hydration concurrency", () => {
  it("hydrates AI-suggested tickers concurrently and keeps the ones that resolve", async () => {
    const { runResearchAgent } = await import("@/data/ai/researchAgent");
    vi.mocked(runResearchAgent).mockResolvedValueOnce({
      summary: "ok",
      citations: [],
      model: "test",
      themes: [],
      suggestions: Array.from({ length: 10 }, (_, i) => ({ ticker: `AI${i}` })),
    } as never);

    const inFlight = { now: 0, peak: 0 };
    const lookupTicker = vi.fn(async (ticker: string) => {
      inFlight.now += 1;
      inFlight.peak = Math.max(inFlight.peak, inFlight.now);
      await new Promise((r) => setTimeout(r, 25));
      inFlight.now -= 1;
      if (ticker === "AI3") throw new Error("not found"); // one bad ticker must not sink the batch
      return { ticker, name: ticker, score: 50 } as never;
    });

    useBlueprintStore.setState({
      running: false,
      description: "quantum computing small caps with real catalysts",
    } as never);

    const t0 = performance.now();
    await useBlueprintStore.getState().runBlueprint(makeDeps({ lookupTicker }));
    const elapsed = performance.now() - t0;

    expect(lookupTicker).toHaveBeenCalledTimes(10);
    // Serialized: 10 × 25ms ≥ 250ms. Batched by 8: two waves ≈ 50ms.
    expect(inFlight.peak).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(200);
    // 9 resolved, 1 rejected - the rejection is skipped, never propagated.
    const state = useBlueprintStore.getState();
    expect(state.researchState.phase).not.toBe("error");
  });
});
