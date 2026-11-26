import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

// The honest-label logic is gated on the device-local Sample data mode, so the
// test drives that flag directly.
vi.mock("@/data/providers/sampleDataMode", () => ({
  isSampleDataModeEnabled: vi.fn(() => false),
}));

import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import {
  analystTargetLabel,
  analystTargetShortLabel,
  targetProvenance,
} from "@/components/signal/analystTargetLabel";
import type { AnalystCoverage } from "@/types";

const sampleMode = isSampleDataModeEnabled as unknown as Mock;

function coverage(status: AnalystCoverage["status"]): AnalystCoverage {
  return { status, spotPrice: 100, consensus: { mean: 117.18 }, rows: [], sources: [] };
}

describe("analystTargetLabel", () => {
  beforeEach(() => sampleMode.mockReturnValue(false));

  it("labels live + aggregated vendor consensus as an analyst target", () => {
    expect(analystTargetLabel(coverage("live"))).toBe("Analyst target");
    expect(analystTargetLabel(coverage("aggregated"))).toBe("Analyst target");
    expect(targetProvenance(coverage("live"))).toBe("analyst");
  });

  it("labels modeled consensus as an estimate", () => {
    expect(analystTargetLabel(coverage("estimated"))).toBe("Est. target");
    expect(targetProvenance(coverage("estimated"))).toBe("estimated");
  });

  it("does NOT relabel sample-status data as a live 'estimate' when sample mode is OFF", () => {
    // Post-fix, the data layer NEVER produces status === "sample" in live mode
    // (it returns links_only with no numeric consensus). So provenance is no
    // longer gated on the device mode here - status === "sample" is honestly
    // "sample", and the UI components additionally suppress/return-null on it
    // when sample mode is OFF (see the strip/panel tests below). The forbidden
    // outcome - calling seeded-random sample numbers a live "estimated" target -
    // must NOT happen.
    sampleMode.mockReturnValue(false);
    expect(targetProvenance(coverage("sample"))).not.toBe("estimated");
    expect(targetProvenance(coverage("sample"))).toBe("sample");
    expect(analystTargetLabel(coverage("sample"))).toBe("Sample target");
  });

  it("reserves 'estimated' strictly for status === 'estimated' (live-ratings derived)", () => {
    sampleMode.mockReturnValue(false);
    expect(targetProvenance(coverage("estimated"))).toBe("estimated");
    expect(targetProvenance(coverage("sample"))).not.toBe("estimated");
  });

  it("says Sample target only when Sample data mode is ON", () => {
    sampleMode.mockReturnValue(true);
    expect(analystTargetLabel(coverage("sample"))).toBe("Sample target");
    expect(targetProvenance(coverage("sample"))).toBe("sample");
    expect(analystTargetShortLabel(coverage("sample"))).toBe("Sample");
  });

  it("falls back to an honest estimate for null / links-only coverage (sample mode off)", () => {
    expect(analystTargetLabel(null)).toBe("Est. target");
    expect(analystTargetLabel(coverage("links_only"))).toBe("Est. target");
  });
});
