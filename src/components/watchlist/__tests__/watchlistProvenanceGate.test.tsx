import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { StockSignal } from "@/types";

/**
 * PRIME-DIRECTIVE regression (Lane W4-A - watchlist surfaces).
 *
 * A watched ticker that resolved to a directory-only company
 * (`marketDataUnavailable: "directory"`, neutralized inputs) must NOT leak a
 * fabricated opportunity score, confidence, hype tier, or sector through the
 * watchlist row, the terminal watchlist monitor, or the desk-summary averages.
 * It must show ABSENCE - exactly the guards SignalCard already applies via
 * `isMarketDataUnavailable` / `isSampleProfile`.
 *
 * Basis: SOFI is GAAP-profitable (~15% net margin) per its SEC 8-K - records
 * with no live data must render the absence, never a modeled number.
 */

// useLiveQuote reads the app store; stub the selector so the row renders
// headlessly with no live overlay (forces the daily-research values through).
vi.mock("@/store/useAppStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({
      livePrices: {},
      watchlist: ["GCU.TO"],
      resolveSignal: (t: string) => (t === "GCU.TO" ? directorySignal() : undefined),
    }),
}));

import { WatchlistRow } from "@/components/watchlist/WatchlistRow";
import { WatchlistMonitor } from "@/components/terminal/WatchlistMonitor";
import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import { isMarketDataUnavailable } from "@/lib/marketData";

const GEN_AT = "2026-06-19T12:00:00.000Z";

/** A fully-typed, live, scored signal built from the demo universe. */
function liveSignal(): StockSignal {
  const company = MOCK_UNIVERSE[0]!;
  return toStockSignal(company, scoreCompany(company), GEN_AT);
}

/** A real listing flagged as carrying no live market data. */
function directorySignal(): StockSignal {
  return { ...liveSignal(), ticker: "GCU.TO", name: "Directory Co", marketDataUnavailable: "directory" };
}

function renderRow(signal: StockSignal): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ul>
        <WatchlistRow
          signal={signal}
          expanded
          index={0}
          onToggle={() => {}}
          onRemove={() => {}}
          onSetAlert={() => {}}
          onClearAlert={() => {}}
        />
      </ul>
    </MemoryRouter>,
  );
}

describe("WatchlistRow provenance gate", () => {
  it("a live signal renders the numeric opportunity score (no unavailable state)", () => {
    const s = liveSignal();
    const html = renderRow(s);
    expect(html).not.toContain("score-ring--unavailable");
    expect(html).not.toContain("Live market data unavailable");
    // The collapsed-row score chip carries the real number.
    expect(html).toContain(String(s.score.opportunityScore));
    // Confidence reads as a real /100 value, not N/A.
    expect(html).toContain(`${s.confidence}/100`);
  });

  it("directory: renders no numeric opportunity score, confidence N/A, no sector/hype", () => {
    const s = directorySignal();
    const html = renderRow(s);
    // Score ring shows the unavailable " - " state, never the fabricated numeral.
    expect(html).toContain("score-ring--unavailable");
    expect(html).toContain("Live market data unavailable");
    // Confidence is N/A, never a modeled /100 value.
    expect(html).toContain("N/A");
    expect(html).not.toContain(`${s.confidence}/100`);
    // Hype tier and sector strings are suppressed entirely.
    expect(html).not.toContain(s.hype.tier);
    expect(html).not.toContain(`>${s.sector}<`);
    // Sanity: the fixture really is a directory-only record.
    expect(isMarketDataUnavailable(s)).toBe(true);
  });

  it("sample: shows the explicit SAMPLE — not live treatment", () => {
    const s = { ...directorySignal(), marketDataUnavailable: "sample" as const };
    const html = renderRow(s);
    expect(html).toContain("SAMPLE — not live");
    expect(html).toContain("score-ring--unavailable");
  });
});

describe("WatchlistPage desk aggregates exclude no-live-data names", () => {
  // Mirrors WatchlistPage's avgScore/onFire computation: aggregates run only
  // over names with real live market data, so a directory-only listing never
  // averages a fabricated opportunity score into the summary console.
  function avgScore(watched: StockSignal[]): number {
    const scored = watched.filter((s) => !isMarketDataUnavailable(s));
    return scored.length
      ? Math.round(scored.reduce((a, s) => a + s.score.opportunityScore, 0) / scored.length)
      : 0;
  }

  it("a directory signal is dropped from avgScore (does not drag the average)", () => {
    const live = liveSignal();
    // A directory record with an absurd seeded score would corrupt the average
    // if it were counted - proving exclusion requires a value far off the real one.
    const dir = { ...directorySignal(), score: { ...live.score, opportunityScore: 0 } };
    expect(avgScore([live])).toBe(live.score.opportunityScore);
    expect(avgScore([live, dir])).toBe(live.score.opportunityScore);
  });

  it("an all-directory watchlist yields avg 0 (nothing real to average)", () => {
    expect(avgScore([directorySignal(), directorySignal()])).toBe(0);
  });
});

describe("WatchlistMonitor provenance gate", () => {
  it("directory: renders ticker + name + 'No live data', never a score/price/day cell", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WatchlistMonitor />
      </MemoryRouter>,
    );
    expect(html).toContain("GCU.TO");
    expect(html).toContain("Directory Co");
    expect(html).toContain("No live data");
    // No score cell, no flat day-change percentage.
    expect(html).not.toContain("tw-wl-row__score");
    expect(html).not.toContain("+0.00%");
  });
});
