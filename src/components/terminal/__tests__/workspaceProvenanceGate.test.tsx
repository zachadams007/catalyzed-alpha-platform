import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { NewsItem, StockSignal } from "@/types";

/**
 * PRIME-DIRECTIVE regression (Lane B - terminal security workspace).
 *
 * The /terminal/:ticker workspace must NOT present a fabricated 0-100 opportunity
 * score, catalyst/risk/confidence pills, a modeled market cap, or a modeled
 * 52-week range for a ticker with no live market data - exactly the guards
 * StockDetail already applies (`isMarketDataUnavailable` / `isSampleProfile`).
 * It must also never swap fabricated sample headlines in for an empty live feed
 * while Sample data mode is OFF.
 */

// Sample mode OFF by default - the live-data integrity posture we ship in.
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: vi.fn(() => false),
}));

// QuoteHeader pulls watchlist actions from the app store, which touches `window`
// at module load (DEV-only debug hook) - stub the selector hook so the header
// renders headlessly in the node test environment.
vi.mock("@/store/useAppStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({
      isWatchlisted: () => false,
      toggleWatchlist: () => {},
      setAnalystCache: () => {},
    }),
}));

import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import { QuoteHeader } from "@/components/terminal/QuoteHeader";
import { ScorePanelCard, resolveLiveNewsOutcome } from "@/components/terminal/workspacePanels";

const sampleMode = isSampleDataModeEnabled as unknown as Mock;

const GEN_AT = "2026-06-19T12:00:00.000Z";

/** A fully-typed, live, scored signal built from the demo universe. */
function liveSignal(): StockSignal {
  const company = MOCK_UNIVERSE[0]!;
  return toStockSignal(company, scoreCompany(company), GEN_AT);
}

/** Same shape, but flagged as carrying no live market data. */
function guardedSignal(kind: "directory" | "sample"): StockSignal {
  return { ...liveSignal(), marketDataUnavailable: kind };
}

function renderHeader(signal: StockSignal): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QuoteHeader signal={signal} quote={null} history={null} quoteLoading={false} />
    </MemoryRouter>,
  );
}

function renderScorePanel(signal: StockSignal): string {
  return renderToStaticMarkup(<ScorePanelCard signal={signal} />);
}

describe("QuoteHeader provenance gate", () => {
  beforeEach(() => sampleMode.mockReturnValue(false));

  it("a normal live signal renders the live score ring, pills, cap, and range", () => {
    const s = liveSignal();
    const html = renderHeader(s);
    // Score ring is the LIVE gauge, not the unavailable state.
    expect(html).not.toContain("score-ring--unavailable");
    expect(html).not.toContain("No live market data");
    expect(html).not.toContain("Live market data unavailable");
    // Real catalyst/risk/confidence pills are present.
    expect(html).toContain("pill--catalyst");
    expect(html).toContain("pill--confidence");
    // A real, positive cap is rendered (not the em-dash placeholder).
    expect(s.marketCap).toBeGreaterThan(0);
    expect(html).toContain("52w");
  });

  it.each(["directory", "sample"] as const)(
    "%s: no fabricated opportunity score (ring shows the unavailable/— state)",
    (kind) => {
      const html = renderHeader(guardedSignal(kind));
      // ScoreRing unavailable state renders " - " and the N/A label, never a numeral.
      expect(html).toContain("score-ring--unavailable");
      expect(html).toContain("No live market data");
    },
  );

  it.each(["directory", "sample"] as const)(
    "%s: suppresses catalyst/horizon/risk/confidence pills",
    (kind) => {
      const html = renderHeader(guardedSignal(kind));
      expect(html).not.toContain("pill--catalyst");
      expect(html).not.toContain("pill--risk");
      expect(html).not.toContain("pill--confidence");
      expect(html).not.toContain("pill--horizon");
    },
  );

  it("directory: cap and 52-week range read as unavailable, not a modeled number", () => {
    const html = renderHeader(guardedSignal("directory"));
    // No live quote + no real history → range is the empty/unavailable variant.
    expect(html).toContain("tw-range--empty");
    expect(html).toContain("52w unavailable");
    // Cap cell shows the em dash, never "$0" or a modeled cap.
    expect(html).not.toContain("$0");
  });

  it("sample: shows the explicit SAMPLE — not live badge", () => {
    const html = renderHeader(guardedSignal("sample"));
    expect(html).toContain("SAMPLE — not live");
  });
});

describe("ScorePanelCard provenance gate", () => {
  it("a live signal renders 'Why it scored N' + the breakdown", () => {
    const s = liveSignal();
    const html = renderScorePanel(s);
    expect(html).toContain(`Why it scored ${s.score.opportunityScore}`);
  });

  it.each(["directory", "sample"] as const)(
    "%s: renders 'no score yet', never the fabricated breakdown",
    (kind) => {
      const html = renderScorePanel(guardedSignal(kind));
      expect(html).toContain("Why there’s no score yet");
      expect(html).toContain("Opportunity score unavailable");
      expect(html).not.toMatch(/Why it scored \d/);
    },
  );
});

describe("resolveLiveNewsOutcome — never fabricate headlines with sample mode OFF", () => {
  const sampleItems: NewsItem[] = [
    {
      url: "https://example.com/sample",
      headline: "Fabricated sample headline",
      source: "Sample wire",
      publishedAt: GEN_AT,
      sentiment: 0,
    } as NewsItem,
  ];
  const liveItems: NewsItem[] = [
    {
      url: "https://finance.yahoo.com/news/real",
      headline: "Real live headline",
      source: "Yahoo Finance",
      publishedAt: GEN_AT,
      sentiment: 0.3,
    } as NewsItem,
  ];

  it("zero live items + sample mode OFF → empty set (honest empty state)", () => {
    const out = resolveLiveNewsOutcome([], sampleItems, false);
    expect(out.items).toEqual([]);
    expect(out.status).toBe("live");
  });

  it("zero live items + sample mode ON → falls back to the sample set", () => {
    const out = resolveLiveNewsOutcome([], sampleItems, true);
    expect(out.items).toEqual(sampleItems);
    expect(out.status).toBe("sample");
  });

  it("live items present → always shows live, regardless of sample mode", () => {
    expect(resolveLiveNewsOutcome(liveItems, sampleItems, false)).toEqual({
      items: liveItems,
      status: "live",
    });
    expect(resolveLiveNewsOutcome(liveItems, sampleItems, true)).toEqual({
      items: liveItems,
      status: "live",
    });
  });
});
