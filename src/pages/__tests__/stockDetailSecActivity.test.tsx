import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { SecActivity, StockSignal } from "@/types";

// Minimal browser globals so the store (dev-only window.__appStore handle) and
// ScoreRing (requestAnimationFrame) load under vitest's `node` environment.
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = g;
if (!g.requestAnimationFrame)
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
if (!g.cancelAnimationFrame) g.cancelAnimationFrame = (id: number) => clearTimeout(id);
if (!g.localStorage) {
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

const { MockDataProvider } = await import("@/data/providers/MockDataProvider");
const { scoreCompany } = await import("@/engine/scoring");
const { toStockSignal } = await import("@/engine/enrich");
const { StockDetail } = await import("@/pages/StockDetail");
const { useAppStore } = await import("@/store/useAppStore");

function renderDetail(ticker: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[`/signal/${ticker}`]}>
      <Routes>
        <Route path="/signal/:ticker" element={<StockDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Regression: clicking a feed ticker opened StockDetail, which renders
 * <SecFilingsPanel> for any signal with a truthy `secActivity`. When that
 * `secActivity` lacked a `filings` array, the panel threw and the whole page
 * fell to the error boundary (the "gray screen"). The page must render every
 * stock - including one whose SEC activity is counts-only.
 */
describe("StockDetail — feed signal with counts-only secActivity", () => {
  it("renders the full page (no throw) when secActivity has no filings array", async () => {
    const universe = await new MockDataProvider().fetchUniverse();
    const generatedAt = new Date().toISOString();
    const base = toStockSignal(universe[0]!, scoreCompany(universe[0]!), generatedAt);

    // The exact crashing shape produced upstream by an aggregate-only insider
    // rollup: real counts, but no per-filing list serialized onto the signal.
    const countsOnlySec = {
      cik: "0000000000",
      form4Count90d: 6,
      eightKCount90d: 2,
      form4BuyCount90d: 3,
      form4NetBuyValue90d: 1_500_000,
    } as unknown as SecActivity;

    const signal: StockSignal = { ...base, secActivity: countsOnlySec };
    useAppStore.setState({ signals: [signal], researchStatus: "complete", signalsFromShared: true });

    expect(() => renderDetail(signal.ticker)).not.toThrow();
    const html = renderDetail(signal.ticker);
    // The detail header (ticker) must be present - proof the page rendered, not
    // the error boundary.
    expect(html).toContain(signal.ticker);
  });
});
