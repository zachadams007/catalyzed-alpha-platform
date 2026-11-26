import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AnalystCoverage, StockSignal } from "@/types";

/**
 * PRIME-DIRECTIVE regression (Lane A): seeded-random "sample" analyst targets are
 * a deterministic hash of the symbol, not a market input. When Sample data mode
 * is OFF, NO dollar price target may render - the strip returns null and the
 * panel shows only the links-only / outlet path. They must NEVER be relabeled as
 * a live "Estimated" target.
 */
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: vi.fn(() => false),
  // The renderers subscribe via useSampleDataMode (useSyncExternalStore). A no-op
  // unsubscribe is fine - the mocked isSampleDataModeEnabled is the source of truth
  // and we re-render by re-invoking the render helper after flipping it.
  subscribeSampleDataMode: () => () => {},
}));
// globalControls is the hook's other subscription source; stub its subscribe.
vi.mock("@/data/globalControls", async () => {
  const actual = await vi.importActual<typeof import("@/data/globalControls")>(
    "@/data/globalControls",
  );
  return { ...actual, subscribeGlobalControls: () => () => {} };
});
// Real ticker so the links_only / lookup copy is exercised (not the demo-universe path).
vi.mock("@/data/http", async () => {
  const actual = await vi.importActual<typeof import("@/data/http")>("@/data/http");
  return { ...actual, isFinnhubConfigured: () => true };
});

import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { AnalystTargetsStrip } from "@/components/signal/AnalystTargetsStrip";
import { PriceTargetsPanel } from "@/components/signal/PriceTargetsPanel";

const sampleMode = isSampleDataModeEnabled as unknown as Mock;

// Distinctive numbers, all far from the spot price (100) so we can assert each
// is absent/present without colliding with the legitimately-rendered spot cell.
const SAMPLE_MEAN = 222.22;
const SAMPLE_MEDIAN = 233.33;
const SAMPLE_HIGH = 244.44;
const SAMPLE_LOW = 211.11;

function sampleCoverage(): AnalystCoverage {
  return {
    status: "sample",
    spotPrice: 100,
    consensus: {
      mean: SAMPLE_MEAN,
      median: SAMPLE_MEDIAN,
      high: SAMPLE_HIGH,
      low: SAMPLE_LOW,
      updatedAt: "2026-06-19",
    },
    recommendations: { strongBuy: 5, buy: 6, hold: 3, sell: 1, strongSell: 0, period: "2026-06-19" },
    rows: [
      { source: "Sample consensus", label: "Illustrative mean target", target: SAMPLE_MEAN, isSample: true, url: "https://x" },
      { source: "Yahoo Finance", label: "EPS/revenue estimates", url: "https://y", origin: "link" },
    ],
    sources: [],
  };
}

function strip(): string {
  const signal = { ticker: "AAPL", price: 100, analyst: sampleCoverage() } as unknown as StockSignal;
  return renderToStaticMarkup(
    <MemoryRouter>
      <AnalystTargetsStrip signal={signal} />
    </MemoryRouter>,
  );
}

function panel(): string {
  return renderToStaticMarkup(
    <PriceTargetsPanel ticker="AAPL" coverage={sampleCoverage()} loading={false} />,
  );
}

const sampleNumbers = [SAMPLE_MEAN, SAMPLE_MEDIAN, SAMPLE_HIGH, SAMPLE_LOW];

describe("sample analyst targets are absent outside Sample data mode", () => {
  beforeEach(() => sampleMode.mockReturnValue(false));

  it("AnalystTargetsStrip renders nothing for sample coverage when sample mode is OFF", () => {
    const html = strip();
    expect(html).toBe("");
    for (const n of sampleNumbers) expect(html).not.toContain(n.toFixed(2));
    expect(html).not.toMatch(/Estimated/i);
    // The seeded "Sample consensus" label must not leak in live mode either.
    expect(html).not.toContain("Sample consensus");
  });

  it("PriceTargetsPanel shows NO sample $ targets when sample mode is OFF", () => {
    const html = panel();
    for (const n of sampleNumbers) {
      expect(html).not.toContain(`$${n.toFixed(2)}`);
    }
    // No implied-move hero, no "Est." relabel pill, no rating breakdown.
    expect(html).not.toContain("Implied move to consensus mean");
    expect(html).not.toContain(">Est.<");
    expect(html).not.toContain("Rating breakdown");
    // The seeded "Sample consensus" source row must be dropped entirely (not just
    // its numbers) - the text itself can't appear under a live badge.
    expect(html).not.toContain("Sample consensus");
    // The honest lookup copy is shown instead.
    expect(html).toMatch(/look up a real symbol/i);
  });

  it("PriceTargetsPanel DOES show sample $ targets when sample mode is ON (unchanged)", () => {
    sampleMode.mockReturnValue(true);
    const html = panel();
    expect(html).toContain(`$${SAMPLE_MEAN.toFixed(2)}`);
    expect(html).toContain("Implied move to consensus mean");
  });

  it("AnalystTargetsStrip DOES render sample targets when sample mode is ON (unchanged)", () => {
    sampleMode.mockReturnValue(true);
    const html = strip();
    expect(html).toContain(`$${SAMPLE_MEAN.toFixed(2)}`);
    expect(html).toMatch(/Sample/);
    expect(html).not.toMatch(/Estimated/);
  });

  it("PriceTargetsPanel keeps 'Sample consensus' rows when sample mode is ON", () => {
    sampleMode.mockReturnValue(true);
    const html = panel();
    expect(html).toContain("Sample consensus");
  });

  it("suppresses a polluted coverage whose rows are sample-tagged even if status is not 'sample'", () => {
    // Defensive path: a legacy/malformed coverage that lost status:"sample" but
    // still carries seeded "Sample consensus" rows must also be suppressed live.
    const polluted: AnalystCoverage = {
      ...sampleCoverage(),
      status: "links_only",
    };
    const signal = { ticker: "AAPL", price: 100, analyst: polluted } as unknown as StockSignal;
    const stripHtml = renderToStaticMarkup(
      <MemoryRouter>
        <AnalystTargetsStrip signal={signal} />
      </MemoryRouter>,
    );
    expect(stripHtml).not.toContain("Sample consensus");
    for (const n of sampleNumbers) expect(stripHtml).not.toContain(n.toFixed(2));

    const panelHtml = renderToStaticMarkup(
      <PriceTargetsPanel ticker="AAPL" coverage={polluted} loading={false} />,
    );
    expect(panelHtml).not.toContain("Sample consensus");
    for (const n of sampleNumbers) expect(panelHtml).not.toContain(`$${n.toFixed(2)}`);
  });
});
