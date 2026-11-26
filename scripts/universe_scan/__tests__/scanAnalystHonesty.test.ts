import { describe, expect, it, vi } from "vitest";
import type { CompanyData, ScoreBreakdown } from "@/types";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import { toStockSignal } from "@/engine/enrich";
import {
  isSampleAnalystCoverage,
  sanitizeSignalsAnalyst,
} from "@/data/analyst/sanitizeAnalystCoverage";

/**
 * PRIME-DIRECTIVE regression (scan publish honesty).
 *
 * The daily broad-universe scan (scripts/universe_scan/scan.mts) runs headless in
 * Node, where `isSampleDataModeEnabled()` fails closed to TRUE (no operator
 * controls cache). So `toStockSignal` seeds the illustrative `buildFeedAnalystCoverage`
 * baseline ("Sample consensus" / status:"sample") onto EVERY signal - which is
 * exactly what was leaking into the public `daily_signals` cache and rendering
 * under a live badge. The scan's pre-publish step
 * `sanitizeSignalsAnalyst(scored, false)` must strip it so nothing sample-origin
 * is ever published. This test reproduces that environment + transform.
 */

// Force the Node fail-closed condition deterministically: sample mode ON, the
// state toStockSignal sees during a real scan run.
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: () => true,
}));

import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";

function company(ticker: string): CompanyData {
  return { ...buildSyntheticCompany(ticker), marketCap: 5e10, price: 100 };
}

// Minimal scoring stub - scoring is irrelevant to the analyst-honesty invariant.
function score(): ScoreBreakdown {
  return {
    opportunityScore: 50,
    confidence: 0.5,
    riskPenalty: 0,
    categories: [],
  } as unknown as ScoreBreakdown;
}

describe("daily scan — never publishes sample-origin analyst coverage", () => {
  it("toStockSignal seeds sample analyst in the scan's (sample-ON) environment", () => {
    expect(isSampleDataModeEnabled()).toBe(true);
    const sig = toStockSignal(company("HOOD"), score(), new Date().toISOString());
    // Precondition: without the strip, this is the leaked coverage.
    expect(isSampleAnalystCoverage(sig.analyst)).toBe(true);
  });

  it("the pre-publish strip removes sample analyst from every signal", () => {
    const generatedAt = new Date().toISOString();
    const scored = ["HOOD", "AAPL", "NVDA"].map((t) =>
      toStockSignal(company(t), score(), generatedAt),
    );
    // Mirrors scan.mts: published with sampleMode=false (trusted live publisher).
    const published = sanitizeSignalsAnalyst(scored, false);

    expect(published).toHaveLength(3);
    for (const sig of published) {
      expect(sig.analyst).toBeUndefined();
      expect(isSampleAnalystCoverage(sig.analyst)).toBe(false);
    }
    // No "Sample consensus" row can survive into the published payload.
    const anySampleRow = published.some((s) =>
      (s.analyst?.rows ?? []).some((r) => r.source === "Sample consensus" || r.isSample === true),
    );
    expect(anySampleRow).toBe(false);
  });
});
