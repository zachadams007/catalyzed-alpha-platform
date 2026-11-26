import { describe, expect, it } from "vitest";
import type { AnalystCoverage, StockSignal } from "@/types";
import {
  isSampleAnalystCoverage,
  sanitizeSignalsAnalyst,
  stripSampleAnalyst,
} from "@/data/analyst/sanitizeAnalystCoverage";

/**
 * PRIME-DIRECTIVE regression: the cache-ingest / scan sanitizer must drop
 * sample-origin analyst coverage in LIVE mode and keep it in SAMPLE mode. This is
 * what neutralizes an already-published daily_signals cache that baked in
 * "Sample consensus" coverage, and what keeps the scan from publishing it.
 */

function sampleCoverage(): AnalystCoverage {
  return {
    status: "sample",
    spotPrice: 100,
    consensus: { mean: 117.9, median: 123.21, high: 125.19, low: 103.51 },
    rows: [
      { source: "Sample consensus", label: "Illustrative mean target", target: 117.9, isSample: true, url: "https://x" },
      { source: "Yahoo Finance", label: "estimates", url: "https://y", origin: "link" },
    ],
    sources: [],
  };
}

function realCoverage(): AnalystCoverage {
  return {
    status: "live",
    spotPrice: 100,
    consensus: { mean: 120 },
    rows: [{ source: "Finnhub", label: "Street consensus", target: 120, url: "https://f" }],
    sources: [],
  };
}

function signal(ticker: string, analyst: AnalystCoverage | undefined): StockSignal {
  return { ticker, price: 100, analyst } as unknown as StockSignal;
}

describe("isSampleAnalystCoverage", () => {
  it("flags status:'sample' coverage", () => {
    expect(isSampleAnalystCoverage(sampleCoverage())).toBe(true);
  });

  it("flags coverage whose rows are sample-tagged even if status differs", () => {
    expect(isSampleAnalystCoverage({ ...sampleCoverage(), status: "links_only" })).toBe(true);
  });

  it("does not flag real coverage", () => {
    expect(isSampleAnalystCoverage(realCoverage())).toBe(false);
  });

  it("does not flag null/undefined", () => {
    expect(isSampleAnalystCoverage(null)).toBe(false);
    expect(isSampleAnalystCoverage(undefined)).toBe(false);
  });
});

describe("stripSampleAnalyst", () => {
  it("returns undefined for sample coverage", () => {
    expect(stripSampleAnalyst(sampleCoverage())).toBeUndefined();
  });
  it("passes real coverage through untouched", () => {
    const real = realCoverage();
    expect(stripSampleAnalyst(real)).toBe(real);
  });
});

describe("sanitizeSignalsAnalyst", () => {
  it("drops sample analyst from every signal when sample mode is OFF", () => {
    const signals = [signal("HOOD", sampleCoverage()), signal("AAPL", realCoverage())];
    const out = sanitizeSignalsAnalyst(signals, false);
    expect(out[0]!.analyst).toBeUndefined(); // sample stripped
    expect(out[1]!.analyst).toBe(signals[1]!.analyst); // real preserved
    // No sample-origin coverage survives.
    expect(out.some((s) => isSampleAnalystCoverage(s.analyst))).toBe(false);
  });

  it("keeps sample analyst when sample mode is ON", () => {
    const signals = [signal("HOOD", sampleCoverage())];
    const out = sanitizeSignalsAnalyst(signals, true);
    expect(out).toBe(signals); // same reference - no work done
    expect(out[0]!.analyst?.status).toBe("sample");
  });

  it("returns the same array reference when nothing is sample-origin (live mode)", () => {
    const signals = [signal("AAPL", realCoverage()), signal("MSFT", undefined)];
    expect(sanitizeSignalsAnalyst(signals, false)).toBe(signals);
  });
});
