import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRIME DIRECTIVE: fake/sample tickers must NEVER render as real - not even for
 * the loading flash. This locks the render-layer guard that the universe surfaces
 * (Today / Weekly / For You / Market Map) use as their ONLY signal source.
 *
 * Regression for: on boot (and on the heatmap) a mock universe ("ZNVTX / Novatryx
 * AI Systems") flashed before/instead of the real data because surfaces rendered
 * `signals` whenever non-empty, ignoring the pending/mock provenance.
 */

let pending = false;
let sampleOn = false;
vi.mock("@/data/providers", () => ({
  isProviderResolutionPending: () => pending,
  isSampleDataModeEnabled: () => sampleOn,
}));

const { selectLiveSafeSignals } = await import("@/store/liveSafeSelector");

const MOCK = [{ id: "m1", ticker: "ZNVTX" }] as never[];
const REAL = [{ id: "r1", ticker: "AAPL" }] as never[];

beforeEach(() => {
  pending = false;
  sampleOn = false;
});

describe("selectLiveSafeSignals — fake data never paints as real", () => {
  it("returns [] while provider resolution is PENDING, even with signals present", () => {
    pending = true;
    expect(selectLiveSafeSignals({ signals: MOCK, signalsFromMock: true })).toEqual([]);
    // even real-looking signals don't paint until the operator choice resolves
    expect(selectLiveSafeSignals({ signals: REAL, signalsFromMock: false })).toEqual([]);
  });

  it("returns [] when signals are MOCK and sample mode is OFF (live boot / pre-scrub window)", () => {
    expect(selectLiveSafeSignals({ signals: MOCK, signalsFromMock: true })).toEqual([]);
  });

  it("returns the REAL universe when live and not mock-sourced", () => {
    expect(selectLiveSafeSignals({ signals: REAL, signalsFromMock: false })).toBe(REAL);
  });

  it("returns the sample universe ONLY under an explicit, loaded sample-mode choice", () => {
    sampleOn = true;
    expect(selectLiveSafeSignals({ signals: MOCK, signalsFromMock: true })).toBe(MOCK);
  });
});
